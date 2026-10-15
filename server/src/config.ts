import type { PlanParams } from "./domain/types.ts";

try {
  // Node >= 20.12 — silently ignore a missing .env
  process.loadEnvFile?.(new URL("../../.env", import.meta.url).pathname);
} catch {
  /* no .env file: defaults apply */
}

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${key} must be a number, got "${raw}"`);
  return n;
};

export const config = {
  port: num("PORT", 8787),
  provider: (process.env.LLM_PROVIDER ?? "policy") as "policy" | "anthropic",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  simDate: process.env.SIM_DATE ?? "2026-10-14",
  maxAgentSteps: num("MAX_AGENT_STEPS", 30),
  params: {
    reviewPeriodDays: num("REVIEW_PERIOD_DAYS", 7),
    serviceLevelZ: num("SERVICE_LEVEL_Z", 1.65),
    excessCoverFactor: num("EXCESS_COVER_FACTOR", 1.5),
    autoApproveLimitUsd: num("AUTO_APPROVE_LIMIT_USD", 5000),
    runValueCapUsd: num("MAX_RUN_VALUE_USD", 50_000),
  } satisfies PlanParams,
};
