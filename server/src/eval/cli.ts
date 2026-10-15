import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { createPlanner } from "../agent/factory.ts";
import { DIMENSIONS, runEvals } from "./runner.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const provider = (flag("provider") ?? config.provider) as "policy" | "anthropic";
const only = flag("only")?.split(",");
const verbose = args.includes("--verbose");

const planner = await createPlanner(provider);
const reports = await runEvals({ planner, params: config.params, only });

const mark = (b: boolean) => (b ? "PASS" : "FAIL");
console.log(`\nAI Purchasing Agent: evaluation (planner=${planner.name}, sim date ${config.simDate})\n`);
for (const r of reports) {
  console.log(`${mark(r.pass)}  ${r.id}  [${r.decision}]`);
  console.log(`      ${r.title}`);
  if (verbose || !r.pass) for (const d of DIMENSIONS) console.log(`      ${r.dimensions[d].pass ? "ok  " : "FAIL"} ${d.padEnd(11)} ${r.dimensions[d].detail}`);
  if (verbose) console.log(`      -> ${r.summary}`);
}

console.log("\nDimension pass rates");
for (const d of DIMENSIONS) {
  const n = reports.filter((r) => r.dimensions[d].pass).length;
  console.log(`  ${d.padEnd(12)} ${n}/${reports.length}`);
}
const passed = reports.filter((r) => r.pass).length;
console.log(`\n${passed}/${reports.length} scenarios passed\n`);

mkdirSync(new URL("../../eval-reports/", import.meta.url), { recursive: true });
const file = new URL(`../../eval-reports/latest-${planner.name}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(reports.map(({ result, ...rest }) => ({ ...rest, trace: result.trace, audit: result.audit })), null, 2));
console.log(`Report written to server/eval-reports/latest-${planner.name}.json`);
process.exit(passed === reports.length ? 0 : 1);
