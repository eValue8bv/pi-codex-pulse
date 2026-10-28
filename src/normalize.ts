import type {
  AppServerCreditsSnapshot,
  AppServerRateLimitResetCredits,
  AppServerRateLimitResponse,
  AppServerRateLimitSnapshot,
  AppServerWindowSnapshot,
  BackendAdditionalRateLimit,
  BackendCreditsSnapshot,
  BackendRateLimitResetCredits,
  BackendRateLimitDetails,
  BackendUsagePayload,
  BackendWindowSnapshot,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
  ResetCredit,
  UsageSource,
} from "./types.ts";
import { asBoolean, asNumber, asString } from "./utils.ts";

export function normalizeBackendPayload(
  payload: BackendUsagePayload,
  capturedAt: number,
  source: UsageSource,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  addOrMergeSnapshot(
    snapshots,
    normalizeBackendSnapshot(
      "codex",
      undefined,
      payload.rate_limit,
      payload.credits,
    ),
  );

  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const raw of additional) {
    const item = asRecord(raw) as BackendAdditionalRateLimit | undefined;
    if (!item) continue;
    const limitId =
      cleanString(item.metered_feature) ?? cleanString(item.limit_name);
    if (!limitId) continue;
    addOrMergeSnapshot(
      snapshots,
      normalizeBackendSnapshot(
        limitId,
        cleanString(item.limit_name),
        item.rate_limit,
        undefined,
      ),
    );
  }

  const resetCreditsAvailable = normalizeBackendResetCredits(
    payload.rate_limit_reset_credits,
  );
  assertDisplayableUsage(
    snapshots,
    resetCreditsAvailable,
    "Codex usage endpoint",
  );
  const planType = cleanString(payload.plan_type);
  const resetCredits = normalizeResetCredits(
    asRecord(payload.rate_limit_reset_credits)?.credits,
    "backend",
  );
  return {
    source,
    capturedAt,
    ...(planType ? { planType } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    snapshots,
  };
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
  const details = asRecord(rateLimit) as BackendRateLimitDetails | undefined;
  const primary = normalizeBackendWindow(details?.primary_window);
  const secondary = normalizeBackendWindow(details?.secondary_window);
  const normalizedCredits = normalizeBackendCredits(credits);
  if (!primary && !secondary && !normalizedCredits) return undefined;

  return {
    limitId,
    ...(limitName ? { limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(normalizedCredits ? { credits: normalizedCredits } : {}),
  };
}

export function normalizeBackendWindow(
  value: unknown,
): NormalizedRateLimitWindow | undefined {
  const window = asRecord(value) as BackendWindowSnapshot | undefined;
  if (!window) return undefined;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  const resetsAt = positiveNumber(asNumber(window.reset_at));
  const windowMinutes =
    limitSeconds !== undefined && limitSeconds > 0
      ? Math.ceil(limitSeconds / 60)
      : undefined;
  return {
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function normalizeBackendCredits(
  value: unknown,
): NormalizedCredits | undefined {
  const credits = asRecord(value) as BackendCreditsSnapshot | undefined;
  if (!credits) return undefined;
  const hasCredits = asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  const balance = cleanString(credits.balance);
  return {
    hasCredits,
    unlimited,
    ...(balance ? { balance } : {}),
  };
}

export function normalizeAppServerResponse(
  response: AppServerRateLimitResponse,
  capturedAt: number,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  let planType = extractAppServerPlanType(response.rateLimits);

  addOrMergeSnapshot(
    snapshots,
    normalizeAppServerSnapshot(response.rateLimits, "codex"),
  );
  const byLimitId = asRecord(response.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, raw] of Object.entries(byLimitId)) {
      planType ??= extractAppServerPlanType(raw);
      addOrMergeSnapshot(snapshots, normalizeAppServerSnapshot(raw, limitId));
    }
  }

  const resetCreditsAvailable = normalizeAppServerResetCredits(
    response.rateLimitResetCredits,
  );
  assertDisplayableUsage(snapshots, resetCreditsAvailable, "codex app-server");
  const resetCredits = normalizeResetCredits(
    asRecord(response.rateLimitResetCredits)?.credits,
    "app-server",
  );
  return {
    source: "codex-app-server",
    capturedAt,
    ...(planType ? { planType } : {}),
    ...(resetCreditsAvailable !== undefined ? { resetCreditsAvailable } : {}),
    ...(resetCredits ? { resetCredits } : {}),
    snapshots,
  };
}

function extractAppServerPlanType(raw: unknown): string | undefined {
  const snapshot = asRecord(raw) as AppServerRateLimitSnapshot | undefined;
  return cleanString(snapshot?.planType);
}

function normalizeAppServerSnapshot(
  raw: unknown,
  fallbackId: string,
): NormalizedRateLimitSnapshot | undefined {
  const snapshot = asRecord(raw) as AppServerRateLimitSnapshot | undefined;
  if (!snapshot) return undefined;
  const limitId = cleanString(snapshot.limitId) ?? fallbackId;
  const limitName = cleanString(snapshot.limitName);
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  const credits = normalizeAppServerCredits(snapshot.credits);
  if (!primary && !secondary && !credits) return undefined;

  return {
    limitId,
    ...(limitName ? { limitName } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
  };
}

export function normalizeAppServerWindow(
  value: unknown,
): NormalizedRateLimitWindow | undefined {
  const window = asRecord(value) as AppServerWindowSnapshot | undefined;
  if (!window) return undefined;
  const usedPercent = asNumber(window.usedPercent);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = positiveNumber(asNumber(window.windowDurationMins));
  const resetsAt = positiveNumber(asNumber(window.resetsAt));
  return {
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function normalizeAppServerCredits(
  value: unknown,
): NormalizedCredits | undefined {
  const credits = asRecord(value) as AppServerCreditsSnapshot | undefined;
  if (!credits) return undefined;
  const hasCredits = asBoolean(credits.hasCredits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  const balance = cleanString(credits.balance);
  return {
    hasCredits,
    unlimited,
    ...(balance ? { balance } : {}),
  };
}

export function mergeSnapshots(
  left: NormalizedRateLimitSnapshot,
  right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    ...((right.limitName ?? left.limitName)
      ? { limitName: right.limitName ?? left.limitName }
      : {}),
    ...((right.primary ?? left.primary)
      ? { primary: right.primary ?? left.primary }
      : {}),
    ...((right.secondary ?? left.secondary)
      ? { secondary: right.secondary ?? left.secondary }
      : {}),
    ...((right.credits ?? left.credits)
      ? { credits: right.credits ?? left.credits }
      : {}),
  };
}

function addOrMergeSnapshot(
  snapshots: NormalizedRateLimitSnapshot[],
  snapshot: NormalizedRateLimitSnapshot | undefined,
): void {
  if (!snapshot) return;
  const key = normalizedLimitKey(snapshot.limitId);
  const index = snapshots.findIndex(
    (candidate) => normalizedLimitKey(candidate.limitId) === key,
  );
  if (index < 0) {
    snapshots.push(snapshot);
    return;
  }
  const existing = snapshots[index];
  if (existing) snapshots[index] = mergeSnapshots(existing, snapshot);
}

function normalizedLimitKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

export function normalizeBackendResetCredits(
  value: unknown,
): number | undefined {
  const resetCredits = asRecord(value) as
    BackendRateLimitResetCredits | undefined;
  return nonNegativeInteger(asNumber(resetCredits?.available_count));
}

export function normalizeAppServerResetCredits(
  value: unknown,
): number | undefined {
  const resetCredits = asRecord(value) as
    AppServerRateLimitResetCredits | undefined;
  return nonNegativeInteger(asNumber(resetCredits?.availableCount));
}

export function normalizeResetCredits(
  value: unknown,
  source: "backend" | "app-server",
): ResetCredit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const credits: ResetCredit[] = [];
  for (const raw of value) {
    const credit = asRecord(raw);
    if (!credit || credit.status !== "available") continue;
    const id = cleanString(credit.id);
    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    const expiration =
      source === "backend" ? credit.expires_at : credit.expiresAt;
    if (expiration === null) {
      credits.push({ id, expiresAt: null });
      continue;
    }
    const epoch =
      source === "backend"
        ? typeof expiration === "string"
          ? Date.parse(expiration) / 1000
          : asNumber(expiration)
        : asNumber(expiration);
    if (
      epoch !== undefined &&
      epoch > 0 &&
      Number.isFinite(new Date(epoch * 1000).getTime())
    ) {
      credits.push({ id, expiresAt: epoch });
    }
  }
  return credits;
}

function assertDisplayableUsage(
  snapshots: NormalizedRateLimitSnapshot[],
  resetCreditsAvailable: number | undefined,
  source: string,
): void {
  if (snapshots.length === 0 && resetCreditsAvailable === undefined) {
    throw new Error(
      `${source} returned no displayable rate-limit windows, credits, or reset credits.`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanString(value: unknown): string | undefined {
  return asString(value)?.trim();
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
