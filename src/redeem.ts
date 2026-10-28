import { randomInt, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_RESET_CREDITS_URL,
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  queryWithPiAuth,
  resolvePiCodexAuth,
  type PiCodexAuth,
} from "./query.ts";
import type { UsageSourcePreference } from "./settings.ts";
import type { CodexUsageReport, ResetCredit } from "./types.ts";
import { parseJsonObject, throwIfAborted } from "./utils.ts";

export type RedeemOutcome =
  "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
export interface RedeemOptions {
  signal: AbortSignal;
  readSource: () => Promise<UsageSourcePreference>;
  onSubmit: () => void;
}
export interface RedeemDependencies {
  resolveAuth?: typeof resolvePiCodexAuth;
  query?: typeof queryWithPiAuth;
  fetch?: typeof fetch;
  now?: () => number;
  challenge?: () => string;
  requestId?: () => string;
}

/** The write may have reached the server. Never automatically retry it. */
export class RedemptionUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      "Reset outcome unknown: a credit may have been consumed. Check /codex-usage before attempting another redemption. No automatic retry was made.",
      { cause },
    );
    this.name = "RedemptionUncertainError";
  }
}

/**
 * Confirm and consume one credit using a fixed Pi account, with no fallback or retry.
 * @throws {Error} If the UI, source, credentials, credit, or account cannot be validated,
 * a read fails, the context becomes stale, or the operation is cancelled.
 * @throws {RedemptionUncertainError} If submission fails or returns an unrecognised result.
 */
export async function redeemReset(
  ctx: ExtensionContext,
  options: RedeemOptions,
  dependencies: RedeemDependencies = {},
): Promise<RedeemOutcome | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    throw new Error("/codex-redeem-reset requires an interactive terminal UI.");
  }
  const resolveAuth = dependencies.resolveAuth ?? resolvePiCodexAuth;
  const query = dependencies.query ?? queryWithPiAuth;
  const now = dependencies.now ?? Date.now;
  const source = await options.readSource();
  if (source === "codex-cli") {
    throw new Error(
      "Redemption requires Pi authentication. Use /login and /codex-usage source pi. CLI redemption is not supported.",
    );
  }

  const checkSource = async (): Promise<void> => {
    const current = await options.readSource();
    throwIfAborted(options.signal);
    if (current !== source) {
      throw new Error("Usage source changed. Nothing redeemed; start again.");
    }
  };
  throwIfAborted(options.signal);
  const original = requireAccount(await resolveAuth(ctx));
  throwIfAborted(options.signal);
  const report = await query(original, DEFAULT_TIMEOUT_MS, options.signal);
  await checkSource();
  assertAccount(original, requireAccount(await resolveAuth(ctx)));
  throwIfAborted(options.signal);
  const credit = selectCredit(report, now());
  const summary = `Pi account: ${accountId(original)}\nConsume one reset credit (${report.resetCreditsAvailable} available).\nCredit expires: ${credit.expiresAt === null ? "unknown" : new Date(credit.expiresAt * 1000).toISOString()}`;
  const intent = await ctx.ui.input(
    `${summary}\nStep 1/2: Type y to continue [y/N]`,
    undefined,
    { signal: options.signal },
  );
  throwIfAborted(options.signal);
  if (intent !== "y") {
    return undefined;
  }

  await checkSource();
  assertAccount(original, requireAccount(await resolveAuth(ctx)));
  throwIfAborted(options.signal);
  const challenge = (
    dependencies.challenge ??
    (() => String(randomInt(0, 10_000)).padStart(4, "0"))
  )();
  const answer = await ctx.ui.input(
    `${summary}\nStep 2/2: Type ${challenge} to redeem`,
    undefined,
    { signal: options.signal },
  );
  throwIfAborted(options.signal);
  if (answer !== challenge) {
    return undefined;
  }

  await checkSource();
  const recheck = requireAccount(await resolveAuth(ctx));
  assertAccount(original, recheck);
  throwIfAborted(options.signal);
  const fresh = await query(recheck, DEFAULT_TIMEOUT_MS, options.signal);
  const available = fresh.resetCreditsAvailable;
  const selected = fresh.resetCredits?.find(
    (candidate) => candidate.id === credit.id,
  );
  if (
    available === undefined ||
    !Number.isInteger(available) ||
    available <= 0 ||
    !selected ||
    selected.expiresAt !== credit.expiresAt
  ) {
    throw new Error(
      "Selected reset credit is no longer available or changed. Nothing redeemed; start again.",
    );
  }

  await checkSource();
  const auth = requireAccount(await resolveAuth(ctx));
  assertAccount(original, auth);
  throwIfAborted(options.signal);
  if (!usableCredit(selected, now())) {
    throw new Error("Selected reset credit expired. Nothing redeemed.");
  }
  const requestId = (dependencies.requestId ?? randomUUID)();
  options.onSubmit();
  try {
    const response = await fetchWithTimeout(
      `${CODEX_RESET_CREDITS_URL}/consume`,
      {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          redeem_request_id: requestId,
          credit_id: credit.id,
        }),
      },
      DEFAULT_TIMEOUT_MS,
      options.signal,
      dependencies.fetch,
    );
    if (!response.ok) {
      throw new Error(`Reset endpoint returned HTTP ${response.status}.`);
    }
    const payload = parseJsonObject(response.bodyText, "Codex reset response");
    switch (payload.code) {
      case "reset":
        return "reset";
      case "nothing_to_reset":
        return "nothingToReset";
      case "no_credit":
        return "noCredit";
      case "already_redeemed":
        return "alreadyRedeemed";
      default:
        throw new Error("Unknown reset response.");
    }
  } catch (error) {
    throw new RedemptionUncertainError(error);
  }
}

function accountId(auth: PiCodexAuth): string | undefined {
  return Object.entries(auth.headers)
    .find(([name]) => name.toLowerCase() === "chatgpt-account-id")?.[1]
    ?.trim();
}

/** @throws {Error} If Pi cannot bind requests to a known account. */
function requireAccount(auth: PiCodexAuth | undefined): PiCodexAuth {
  const id = auth && accountId(auth);
  if (!auth?.accountKey || !id || /[\u0000-\u0020\u007f-\u009f]/.test(id)) {
    throw new Error(
      "A known Pi Codex account is required. Check /login; nothing redeemed.",
    );
  }
  return { ...auth, headers: { ...auth.headers } };
}

/** @throws {Error} If the current account differs from the confirmed account. */
function assertAccount(original: PiCodexAuth, current: PiCodexAuth): void {
  if (
    original.accountKey !== current.accountKey ||
    accountId(original) !== accountId(current)
  ) {
    throw new Error("Pi account changed. Nothing redeemed; start again.");
  }
}

function usableCredit(credit: ResetCredit, now: number): boolean {
  return (
    Boolean(credit.id.trim()) &&
    (credit.expiresAt === null ||
      (Number.isFinite(credit.expiresAt) && credit.expiresAt * 1000 > now))
  );
}

/** @throws {Error} If no available, usable reset credit is reported. */
function selectCredit(report: CodexUsageReport, now: number): ResetCredit {
  const available = report.resetCreditsAvailable;
  if (
    available === undefined ||
    !Number.isInteger(available) ||
    available <= 0
  ) {
    throw new Error(
      "No available reset credits were reported. Nothing redeemed.",
    );
  }
  const credits = report.resetCredits?.filter((credit) =>
    usableCredit(credit, now),
  );
  const credit = credits?.sort(
    (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
  )[0];
  if (!credit) {
    throw new Error(
      "No usable reset credit ID was reported. Nothing redeemed.",
    );
  }
  return { ...credit };
}
