/**
 * Provider registry composition: every adapter factory wired to the shared
 * runtime dependencies. The registry `satisfies ProviderRegistry`, so a
 * missing provider is a compile error and each adapter receives the exact
 * dependency object the runtime built (store, fetch, clock, browser,
 * subprocess, callback server).
 */

import type { RuntimeDependencies } from "../runtime.js";
import { createAntigravityProvider } from "./antigravity.js";
import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { createCursorProvider } from "./cursor.js";
import { createFuelGaugeProvider } from "./fuel-gauge.js";
import { createGitHubCopilotProvider } from "./github-copilot.js";
import { createKiroProvider } from "./kiro.js";
import { createOmpProvider } from "./omp.js";
import { createOpenCodeProvider } from "./opencode.js";
import type { ProviderRegistry } from "./provider.js";

export function createProviderRegistry(
  deps: RuntimeDependencies,
): ProviderRegistry {
  return {
    githubCopilot: createGitHubCopilotProvider(deps),
    codex: createCodexProvider(deps),
    antigravity: createAntigravityProvider(deps),
    claude: createClaudeProvider(deps),
    kiro: createKiroProvider(deps),
    cursor: createCursorProvider(deps),
    omp: createOmpProvider(deps),
    opencode: createOpenCodeProvider(deps),
    fuelGauge: createFuelGaugeProvider(deps),
  } satisfies ProviderRegistry;
}
