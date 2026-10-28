import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryViaCodexAppServer } from "./app-server.ts";
import { normalizeBackendPayload, normalizeResetCredits } from "./normalize.ts";
import type { UsageSourcePreference } from "./settings.ts";
import type {
  BackendUsagePayload,
  CodexUsageReport,
  UsageSource,
} from "./types.ts";
import {
  abortError,
  errorMessage,
  formatTimeoutSeconds,
  hasHeader,
  isAbortError,
  isStaleContextError,
  parseJsonObject,
  redactErrorBody,
  redactSensitiveText,
  throwIfAborted,
} from "./utils.ts";

export const CODEX_PROVIDER_ID = "openai-codex";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;

export interface QueryUsageOptions {
  timeoutMs: number;
  source?: UsageSourcePreference;
  signal?: AbortSignal;
}
export interface UsageQueryError {
  source: UsageSource;
  message: string;
}
export type QueryUsageResult =
  | { ok: true; report: CodexUsageReport; accountKey?: string }
  | { ok: false; errors: UsageQueryError[]; accountKey?: string };

export interface PiCodexAuth {
  headers: Record<string, string>;
  /** Opaque cache binding, never an email or access token. */
  accountKey?: string;
}
export interface QueryUsageDependencies {
  resolveAuth?: (ctx: ExtensionContext) => Promise<PiCodexAuth | undefined>;
  direct?: (
    auth: PiCodexAuth,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CodexUsageReport>;
  appServer?: (
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<CodexUsageReport>;
}
type PiModel = NonNullable<ExtensionContext["model"]>;

/**
 * Select a source without silently switching away from configured Pi credentials.
 * @throws {Error} If cancelled or the Pi context is stale. Other failures become source errors.
 */
export async function queryUsage(
  ctx: ExtensionContext,
  options: QueryUsageOptions,
  dependencies: QueryUsageDependencies = {},
): Promise<QueryUsageResult> {
  const source = options.source ?? "auto";
  const resolveAuth = dependencies.resolveAuth ?? resolvePiCodexAuth;
  const direct = dependencies.direct ?? queryWithPiAuth;
  const appServer = dependencies.appServer ?? queryViaCodexAppServer;
  let selectedSource: UsageSource =
    source === "codex-cli" ? "codex-app-server" : "pi-auth";
  let auth: PiCodexAuth | undefined;

  throwIfAborted(options.signal);
  try {
    if (source !== "codex-cli") {
      auth = await resolveAuth(ctx);
      throwIfAborted(options.signal);
      if (auth) {
        const report = await direct(auth, options.timeoutMs, options.signal);
        const current = await resolveAuth(ctx);
        throwIfAborted(options.signal);
        if (!sameAuthentication(auth, current)) {
          throw new Error(
            "Pi account changed during the query. Run /codex-usage again.",
          );
        }
        return {
          ok: true,
          report,
          ...(auth.accountKey ? { accountKey: auth.accountKey } : {}),
        };
      }
      if (source === "pi") {
        throw new Error("No Pi Codex login is available. Run /login.");
      }
    }

    // account/read exposes no stable workspace ID. Email/plan equality cannot prove
    // equivalence, so CLI fallback is permitted only when Pi auth is absent or explicitly bypassed.
    selectedSource = "codex-app-server";
    const report = await appServer(options.timeoutMs, options.signal);
    throwIfAborted(options.signal);
    if (source === "auto" && (await resolveAuth(ctx))) {
      throw new Error(
        "Pi authentication changed during the CLI query. Run /codex-usage again.",
      );
    }
    throwIfAborted(options.signal);
    return { ok: true, report };
  } catch (error) {
    if (
      isAbortError(error) ||
      isStaleContextError(error) ||
      options.signal?.aborted
    ) {
      throw error;
    }
    // Retain stale data only if the failing request still belongs to the same known account.
    let accountKey: string | undefined;
    if (auth?.accountKey) {
      try {
        const current = await resolveAuth(ctx);
        if (current?.accountKey === auth.accountKey) {
          accountKey = auth.accountKey;
        }
      } catch (identityError) {
        if (isStaleContextError(identityError) || isAbortError(identityError)) {
          throw identityError;
        }
      }
    }
    throwIfAborted(options.signal);
    const hint =
      auth && source === "auto"
        ? " CLI fallback was not used because account equivalence cannot be verified. To choose CLI explicitly, run /codex-usage source codex-cli."
        : "";
    return {
      ok: false,
      errors: [
        {
          source: selectedSource,
          message: `${redactSensitiveText(errorMessage(error))}${hint}`,
        },
      ],
      ...(accountKey ? { accountKey } : {}),
    };
  }
}

function sameAuthentication(
  previous: PiCodexAuth,
  current: PiCodexAuth | undefined,
): boolean {
  if (!current) {
    return false;
  }
  if (previous.accountKey) {
    return previous.accountKey === current.accountKey;
  }
  // Unknown identities may be displayed fresh, but are never used for cache retention.
  return JSON.stringify(previous.headers) === JSON.stringify(current.headers);
}

/** @throws {Error} If Pi authentication is missing, fails, or the usage request fails. */
export async function queryViaPiAuth(
  ctx: ExtensionContext,
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexUsageReport> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) {
    throw new Error("No Pi Codex login is available. Run /login.");
  }
  return queryWithPiAuth(auth, timeoutMs, signal, fetchImplementation);
}

/** @throws {Error} For cancellation, HTTP failure, malformed usage data, or a request timeout. */
async function queryWithPiAuth(
  auth: PiCodexAuth,
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<CodexUsageReport> {
  const response = await fetchWithTimeout(
    CODEX_USAGE_URL,
    { headers: auth.headers },
    timeoutMs,
    signal,
    fetchImplementation,
  );
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status}: ${redactErrorBody(response.bodyText) || "empty response"}`,
    );
  }
  const payload = parseJsonObject(
    response.bodyText,
    "Codex usage endpoint response",
  );
  const report = normalizeBackendPayload(
    payload as BackendUsagePayload,
    Date.now(),
    "pi-auth",
  );
  if (!report.resetCreditsAvailable || report.resetCredits) {
    return report;
  }

  // Older backends may lack credit details; keep the count when this optional read fails.
  try {
    const detailsResponse = await fetchWithTimeout(
      CODEX_RESET_CREDITS_URL,
      { headers: auth.headers },
      timeoutMs,
      signal,
      fetchImplementation,
    );
    if (!detailsResponse.ok) {
      return report;
    }
    const details = parseJsonObject(
      detailsResponse.bodyText,
      "Codex reset-credit details response",
    );
    const credits = normalizeResetCredits(details.credits, "backend");
    if (credits) {
      report.resetCredits = credits;
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }
  }
  return report;
}

/** @throws {Error} If configured Pi credentials cannot be resolved. No other account is tried. */
export async function resolvePiCodexAuth(
  ctx: ExtensionContext,
): Promise<PiCodexAuth | undefined> {
  const model = codexAuthCandidateModels(ctx)[0];
  if (!model) {
    if (ctx.modelRegistry.getProviderAuthStatus(CODEX_PROVIDER_ID).configured) {
      throw new Error(
        "Pi Codex credentials are configured, but no Codex model is available.",
      );
    }
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(redactSensitiveText(auth.error));
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  if (!hasHeader(headers, "Authorization") && auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  const authorization = headerValue(headers, "authorization");
  if (!authorization) {
    if (ctx.modelRegistry.getProviderAuthStatus(CODEX_PROVIDER_ID).configured) {
      throw new Error(
        "Pi Codex credentials are configured but unavailable. Run /login.",
      );
    }
    return undefined;
  }
  if (!hasHeader(headers, "User-Agent")) {
    headers["User-Agent"] = "pi-codex-pulse";
  }
  const accountId =
    headerValue(headers, "chatgpt-account-id") ??
    accountIdFromToken(authorization);
  if (!accountId) {
    return { headers };
  }
  if (!hasHeader(headers, "chatgpt-account-id")) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  const accountKey = createHash("sha256")
    .update(`chatgpt:${accountId}`)
    .digest("hex");
  return { headers, accountKey };
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return (
    Object.entries(headers)
      .find(([key]) => key.toLowerCase() === name)?.[1]
      ?.trim() || undefined
  );
}

function accountIdFromToken(authorization: string): string | undefined {
  const token = authorization.replace(/^Bearer\s+/i, "");
  const encoded = token.split(".")[1];
  if (!encoded) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const claim = (payload as Record<string, unknown>)[
      "https://api.openai.com/auth"
    ];
    if (!claim || typeof claim !== "object") {
      return undefined;
    }
    const id = (claim as Record<string, unknown>).chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

export function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates = [
    ctx.model,
    ...ctx.modelRegistry.getAvailable(),
    ...ctx.modelRegistry.getAll(),
  ];
  const seen = new Set<string>();
  return candidates.filter((model): model is PiModel => {
    if (!model || model.provider !== CODEX_PROVIDER_ID || seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

interface UsageHttpResponse {
  ok: boolean;
  status: number;
  bodyText: string;
}

/**
 * Read headers and body within one timeout; refuse redirects with account headers.
 * @throws {Error} If the deadline expires, transport/body read fails, or the caller cancels.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<UsageHttpResponse> {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetchImplementation(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { ok: response.ok, status: response.status, bodyText };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Timed out after ${formatTimeoutSeconds(timeoutMs)} while fetching Codex usage.`,
      );
    }
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
