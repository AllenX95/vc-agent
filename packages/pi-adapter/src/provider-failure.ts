import type { ProviderFailure } from "@vc-agent/contracts";

function field(source: unknown, names: string[]): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  for (const name of names) {
    if (typeof record[name] === "string" && record[name].length > 0) return record[name];
  }
  return undefined;
}

function redact(text: string, secret: string): string {
  let result = text;
  if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/authorization\s*[:=]\s*[^,}\s]+/gi, "authorization=[REDACTED]")
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .slice(0, 1200);
}

export function sanitizeProviderFailure(
  error: unknown,
  profile: { provider: string; model: string; apiKey: string }
): ProviderFailure {
  const rawMessage = error instanceof Error ? error.message : field(error, ["message", "error_description"]) ?? String(error);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    parsed = undefined;
  }
  const nested = typeof parsed === "object" && parsed !== null && "error" in parsed ? (parsed as { error: unknown }).error : parsed;
  const message = field(nested, ["message", "error_description"]) ?? rawMessage;
  const code = field(nested, ["code", "type", "error"]) ?? field(error, ["code", "type"]) ?? "PROVIDER_FAILURE";
  const requestId = field(nested, ["request_id", "requestId"]) ?? field(error, ["request_id", "requestId"]);
  return {
    kind: "provider",
    code: redact(code, profile.apiKey),
    message: redact(message, profile.apiKey),
    provider: profile.provider,
    model: profile.model,
    ...(requestId === undefined ? {} : { requestId: redact(requestId, profile.apiKey) })
  };
}
