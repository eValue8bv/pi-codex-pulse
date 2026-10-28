export const MAX_ERROR_BODY_CHARS = 600;

export function parseJsonObject(
  text: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${description} was not valid JSON: ${errorMessage(error)}`,
    );
  }
  return assertObject(parsed, description);
}

export function assertObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function hasHeader(
  headers: Record<string, string>,
  name: string,
): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

export function redactErrorBody(body: string): string {
  return truncateEnd(redactSensitiveText(body).trim(), MAX_ERROR_BODY_CHARS);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(
      /(["']?(?:access_token|refresh_token|id_token|api_key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      "$1<redacted>",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted>");
}

export function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatTimeoutSeconds(timeoutMs: number): string {
  return `${Math.round(timeoutMs / 100) / 10}s`;
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error("Codex usage query was cancelled.");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "This extension ctx is stale after session replacement or reload",
    )
  );
}
