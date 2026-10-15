import { z } from "zod";
import { ErpError } from "../erp/erp.ts";
import { buildSituation } from "../domain/situation.ts";
import { validatePo, verifyOutcome } from "../domain/validator.ts";
import { incomingFromPos } from "../domain/replenishment.ts";
import type { RunContext } from "../agent/types.ts";
import type { Decision } from "../domain/types.ts";

/**
 * The agent's only interface to the outside world. Every tool:
 *  - validates its input (zod),
 *  - never throws: failures come back as { ok:false, error } so the agent can react,
 *  - is traced,
 * and every *write* tool additionally enforces guardrails and reads the result back from the
 * ERP to verify it (see verifyWrite).
 */

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  write: boolean;
  schema: S;
  handler: (ctx: RunContext, input: z.infer<S>) => ToolResult;
}

const sku = z.string().describe("SKU id, e.g. RICE-5KG");
const node = z.string().describe("Fulfilment node id, e.g. FC-BLR-01");

/** A run may never commit more than this multiple of the auto-approve limit, even with approvals. */
const RUN_VALUE_CAP_MULTIPLE = 10;

const defs: ToolDef<any>[] = [
  {
    name: "get_inventory",
    description: "Current on-hand stock for a SKU at a node, and when it was last counted.",
    write: false,
    schema: z.object({ sku, node }),
    handler: (ctx, i) => {
      const r = ctx.erp.getInventory(i.sku, i.node);
      return { ok: true, data: r };
    },
  },
  {
    name: "get_demand_and_sales",
    description:
      "Planning forecast, baseline demand, 14 days of actual daily sales (oldest first) and an assessment: sustained increase vs isolated spike, forecast staleness, promo flag.",
    write: false,
    schema: z.object({ sku, node }),
    handler: (ctx, i) => {
      const d = ctx.erp.getDemand(i.sku, i.node);
      const sit = buildSituation(ctx.erp, i.sku, i.node, ctx.params);
      return { ok: true, data: { raw: d, assessment: sit.demand } };
    },
  },
  {
    name: "get_open_purchase_orders",
    description: "Open and pending-approval purchase orders for a SKU at a node, with the quantity that will actually arrive (supplier-confirmed qty) and ETA.",
    write: false,
    schema: z.object({ sku, node }),
    handler: (ctx, i) => {
      const pos = ctx.erp.listPos({ sku: i.sku, node: i.node }).filter((p) => p.status === "open" || p.status === "pending_approval");
      return { ok: true, data: { purchaseOrders: pos, incoming: incomingFromPos(pos, ctx.erp.today()) } };
    },
  },
  {
    name: "get_purchase_order",
    description: "One purchase order by id.",
    write: false,
    schema: z.object({ poId: z.string() }),
    handler: (ctx, i) => ({ ok: true, data: ctx.erp.getPo(i.poId) }),
  },
  {
    name: "get_supplier_options",
    description: "All suppliers that can supply a SKU: unit cost, lead time, MOQ, case pack, max order qty, reliability, active flag.",
    write: false,
    schema: z.object({ sku }),
    handler: (ctx, i) => {
      const options = ctx.erp.listTerms(i.sku).map((t) => {
        const s = ctx.erp.getSupplier(t.supplierId);
        const cap = ctx.learnedCaps[t.supplierId];
        return { ...t, maxQtyPerOrder: cap === undefined ? t.maxQtyPerOrder : Math.min(t.maxQtyPerOrder ?? Infinity, cap), supplierName: s.name, reliability: s.reliability, active: s.active };
      });
      return { ok: true, data: options };
    },
  },
  {
    name: "get_budget",
    description: "Remaining purchasing budget (USD) for the category of a SKU.",
    write: false,
    schema: z.object({ sku }),
    handler: (ctx, i) => {
      const p = ctx.erp.getProduct(i.sku);
      return { ok: true, data: { ...ctx.erp.getBudget(p.category), autoApproveLimitUsd: ctx.params.autoApproveLimitUsd } };
    },
  },
  {
    name: "get_storage_capacity",
    description: "Storage capacity of a node in m3: capacity, used, space reserved by inbound POs, and free space. Also the m3 per unit of each SKU.",
    write: false,
    schema: z.object({ node, sku: sku.optional() }),
    handler: (ctx, i) => ({ ok: true, data: { ...ctx.erp.getStorage(i.node), unitVolumeM3: i.sku ? ctx.erp.getProduct(i.sku).unitVolumeM3 : undefined } }),
  },
  {
    name: "analyze_replenishment",
    description:
      "Deterministic replenishment maths for a SKU at a node: effective demand, safety stock, target position, inventory position, net requirement, stock-out day, and for each supplier the legal order qty, the max qty that fits budget/storage/supplier cap, and whether it would arrive before a stock-out. Use this instead of doing arithmetic yourself.",
    write: false,
    schema: z.object({ sku, node }),
    handler: (ctx, i) => ({ ok: true, data: summarize(buildSituation(ctx.erp, i.sku, i.node, ctx.params, { exclude: ctx.excludedSuppliers, capOverrides: ctx.learnedCaps })) }),
  },
  {
    name: "create_purchase_order",
    description:
      "Create a purchase order. Orders above the auto-approve limit are NOT committed: they are placed in the human approval queue. The result includes an independent read-back verification (did the ERP store what you asked for, and is the PO acceptable?). If verification fails you must correct the situation.",
    write: true,
    schema: z.object({ sku, node, supplierId: z.string(), qty: z.number().int().positive(), reason: z.string().min(5) }),
    handler: (ctx, i) => createPo(ctx, i),
  },
  {
    name: "cancel_purchase_order",
    description: "Cancel a purchase order that this agent created in the current run (e.g. a wrong one). Cannot cancel buyer/system POs.",
    write: true,
    schema: z.object({ poId: z.string(), reason: z.string().min(5) }),
    handler: (ctx, i) => {
      const po = ctx.erp.getPo(i.poId);
      if (po.createdBy !== "agent") return fail("GUARDRAIL", "agent may only cancel POs it created");
      try {
        ctx.erp.cancelPo(i.poId);
      } catch (e) {
        return erpFail(ctx, "cancel_purchase_order", e);
      }
      const after = ctx.erp.getPo(i.poId);
      const ok = after.status === "cancelled";
      ctx.trace.push({ kind: "verification", step: ctx.step, poId: i.poId, ok, findings: ok ? [] : [{ code: "NOT_CANCELLED", severity: "violation", message: `status is ${after.status}` }] });
      return { ok: true, data: { po: after } };
    },
  },
  {
    name: "create_escalation",
    description: "Hand the situation to a human buyer with a severity and a recommended next step. Use when constraints block the purchase, data cannot be trusted, or a stock-out cannot be prevented.",
    write: true,
    schema: z.object({
      sku,
      node,
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string().min(10),
      recommendedNextStep: z.string().min(5),
    }),
    handler: (ctx, i) => {
      const e = ctx.erp.createEscalation(i);
      ctx.writes.push({ tool: "create_escalation", verified: true, findings: [] });
      return { ok: true, data: e };
    },
  },
  {
    name: "submit_decision",
    description: "Finish the run. Provide the final decision (accept | modify | reject | investigate | escalate | no_action), the important factors, what you did and the residual risks. Call exactly once, after all actions are verified.",
    write: false,
    schema: z.object({
      action: z.enum(["accept", "modify", "reject", "investigate", "escalate", "no_action"]),
      summary: z.string().min(10),
      rationale: z.array(z.string()).min(1),
      actionsTaken: z.array(z.string()),
      risks: z.array(z.string()),
      needsHuman: z.boolean(),
    }),
    handler: (ctx, i) => {
      ctx.decision = i as Decision;
      return { ok: true, data: { recorded: true } };
    },
  },
];

function summarize(s: ReturnType<typeof buildSituation>) {
  return {
    sku: s.sku,
    node: s.node,
    onHand: s.onHand,
    demand: s.demand,
    incoming: s.incoming,
    budgetRemainingUsd: s.budgetRemainingUsd,
    storageFreeM3: s.storageFreeM3,
    primarySupplierId: s.primarySupplierId,
    options: s.options.map((o) => ({
      supplierId: o.terms.supplierId,
      supplierName: o.supplierName,
      active: o.active,
      reliability: o.reliability,
      unitCost: o.cost,
      leadTimeDays: o.terms.leadTimeDays,
      moq: o.terms.moq,
      casePack: o.terms.casePack,
      maxQtyPerOrder: o.terms.maxQtyPerOrder ?? null,
      horizonDays: o.position.horizonDays,
      safetyStock: o.position.safetyStock,
      targetPosition: o.position.targetPosition,
      inventoryPosition: o.position.inventoryPosition,
      netRequirement: o.position.netRequirement,
      stockoutDay: o.position.stockoutDay,
      legalNeedQty: o.legalNeedQty,
      maxFeasibleQty: o.maxFeasibleQty,
      bindingConstraints: o.bindingConstraints,
      arrivesAfterStockout: o.arrivesAfterStockout,
    })),
  };
}

function fail(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return { ok: false, error: { code, message, details } };
}

function erpFail(ctx: RunContext, tool: string, e: unknown): ToolResult {
  if (e instanceof ErpError) {
    ctx.writeErrors.push({ tool, code: e.code, message: e.message });
    return fail(e.code, e.message, e.details);
  }
  throw e;
}

function createPo(ctx: RunContext, i: { sku: string; node: string; supplierId: string; qty: number; reason: string }): ToolResult {
  // ---- guardrails (before touching the ERP) ----
  const dup = ctx.writes.find((w) => w.intended && w.intended.sku === i.sku && w.intended.node === i.node && w.intended.supplierId === i.supplierId && w.intended.qty === i.qty);
  if (dup) return fail("DUPLICATE_ORDER", "an identical PO was already created in this run; re-check the situation instead of ordering again");

  let terms;
  try {
    terms = ctx.erp.getTerms(i.sku, i.supplierId);
  } catch (e) {
    return erpFail(ctx, "create_purchase_order", e);
  }
  const value = i.qty * terms.unitCost;
  const committed = ctx.erp
    .listPos()
    .filter((p) => p.createdBy === "agent" && p.status !== "cancelled")
    .reduce((a, p) => a + p.qty * p.unitCost, 0);
  const runCap = ctx.params.autoApproveLimitUsd * RUN_VALUE_CAP_MULTIPLE;
  if (committed + value > runCap) return fail("GUARDRAIL", `run value cap of $${runCap} would be exceeded`, { committedUsd: committed, valueUsd: value });

  const requiresApproval = value > ctx.params.autoApproveLimitUsd;
  let po;
  try {
    po = ctx.erp.createPo({
      sku: i.sku,
      node: i.node,
      supplierId: i.supplierId,
      qty: i.qty,
      createdBy: "agent",
      note: i.reason,
      requiresApproval,
      approvalReason: requiresApproval ? `PO value $${value.toFixed(2)} exceeds auto-approve limit $${ctx.params.autoApproveLimitUsd}` : undefined,
    });
  } catch (e) {
    if (e instanceof ErpError && e.code === "SUPPLIER_CAPACITY" && typeof e.details.maxQty === "number") {
      ctx.learnedCaps[i.supplierId] = e.details.maxQty;
      ctx.trace.push({ kind: "recovery", step: ctx.step, text: `ERP rejected order of ${i.qty}: ${e.message}. Learned cap ${e.details.maxQty} for ${i.supplierId}.` });
    }
    return erpFail(ctx, "create_purchase_order", e);
  }

  // ---- verification: read back from the ERP and validate; never trust the write's return ----
  const intended = { sku: i.sku, node: i.node, supplierId: i.supplierId, qty: i.qty };
  const stored = ctx.erp.getPo(po.id);
  const mismatch = verifyOutcome(stored, intended);
  const validation = validatePo(ctx.erp, po.id, ctx.params);
  const findings = [...mismatch, ...validation.findings];
  const ok = !findings.some((f) => f.severity === "violation");
  ctx.trace.push({ kind: "verification", step: ctx.step, poId: po.id, expected: intended, ok, findings });
  ctx.writes.push({ tool: "create_purchase_order", poId: po.id, intended, verified: ok, findings });
  if (!ok) ctx.trace.push({ kind: "recovery", step: ctx.step, text: `PO ${po.id} failed verification: ${findings.filter((f) => f.severity === "violation").map((f) => f.code).join(", ")}. Re-planning from fresh ERP state.` });

  return {
    ok: true,
    data: {
      po: stored,
      status: stored.status,
      requiresApproval,
      verification: { ok, findings },
    },
  };
}

export class ToolRegistry {
  list() {
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      write: d.write,
      input_schema: z.toJSONSchema(d.schema, { target: "draft-7" }) as Record<string, unknown>,
    }));
  }

  has(name: string) {
    return defs.some((d) => d.name === name);
  }

  call(ctx: RunContext, name: string, rawInput: unknown): ToolResult {
    const def = defs.find((d) => d.name === name);
    const started = performance.now();
    ctx.step += 1;
    const traceIdx = ctx.trace.length; // tool event goes before the verification events its handler emits
    let result: ToolResult;
    if (!def) {
      result = fail("UNKNOWN_TOOL", `no such tool: ${name}`);
    } else {
      const parsed = def.schema.safeParse(rawInput);
      if (!parsed.success) {
        result = fail("INVALID_INPUT", parsed.error.issues.map((x: { path: PropertyKey[]; message: string }) => `${x.path.map(String).join(".")}: ${x.message}`).join("; "));
      } else {
        try {
          result = def.handler(ctx, parsed.data);
        } catch (e) {
          result = e instanceof ErpError ? fail(e.code, e.message, e.details) : fail("INTERNAL", e instanceof Error ? e.message : String(e));
        }
      }
    }
    ctx.trace.splice(traceIdx, 0, { kind: "tool", step: ctx.step, tool: name, write: def?.write ?? false, input: rawInput, ok: result.ok, output: result.ok ? result.data : result.error, ms: Math.round(performance.now() - started) });
    return result;
  }
}
