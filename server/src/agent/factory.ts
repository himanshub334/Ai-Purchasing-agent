import { config } from "../config.ts";
import { PolicyPlanner } from "./policyPlanner.ts";
import type { Planner } from "./types.ts";

export async function createPlanner(provider: "policy" | "anthropic" = config.provider): Promise<Planner> {
  if (provider === "anthropic") {
    if (!config.anthropicApiKey) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    const { ClaudePlanner } = await import("./claudePlanner.ts");
    return new ClaudePlanner({ apiKey: config.anthropicApiKey, model: config.anthropicModel, maxSteps: config.maxAgentSteps });
  }
  return new PolicyPlanner();
}
