export type GateDecision = "pass" | "blocked" | "fail";

/**
 * Diagnostic gate runs may report blocked external dependencies without
 * failing the command. Release gate runs require an explicit pass and fail
 * closed for both blocked and failed decisions.
 */
export function gateExitCode(decision: GateDecision, requirePass: boolean): 0 | 1 {
  return decision === "fail" || (requirePass && decision !== "pass") ? 1 : 0;
}
