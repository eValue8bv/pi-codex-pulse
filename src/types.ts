export type UsageSource = "pi-auth" | "codex-app-server";

export interface CodexUsageModel {
  id: string;
  name: string;
  provider: string;
}

export interface CodexUsageReport {
  source: UsageSource;
  capturedAt: number;
  planType?: string;
  resetCreditsAvailable?: number;
  resetCredits?: ResetCredit[];
  snapshots: NormalizedRateLimitSnapshot[];
}

export interface ResetCredit {
  id: string;
  expiresAt: number | null;
  title?: string;
}

export interface NormalizedRateLimitSnapshot {
  limitId: string;
  limitName?: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
  credits?: NormalizedCredits;
}

export interface NormalizedRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface NormalizedCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

/** External payload fields intentionally remain unknown so schema drift is non-fatal. */
export interface BackendUsagePayload {
  [key: string]: unknown;
  plan_type?: unknown;
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
}

export interface BackendRateLimitDetails {
  [key: string]: unknown;
  primary_window?: unknown;
  secondary_window?: unknown;
}

export interface BackendWindowSnapshot {
  [key: string]: unknown;
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

export interface BackendAdditionalRateLimit {
  [key: string]: unknown;
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: unknown;
}

export interface BackendCreditsSnapshot {
  [key: string]: unknown;
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

export interface BackendRateLimitResetCredits {
  [key: string]: unknown;
  available_count?: unknown;
  credits?: unknown;
}

export interface AppServerRateLimitResponse {
  [key: string]: unknown;
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
  rateLimitResetCredits?: unknown;
}

export interface AppServerRateLimitResetCredits {
  [key: string]: unknown;
  availableCount?: unknown;
  credits?: unknown;
}

export interface AppServerRateLimitSnapshot {
  [key: string]: unknown;
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  planType?: unknown;
}

export interface AppServerWindowSnapshot {
  [key: string]: unknown;
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface AppServerCreditsSnapshot {
  [key: string]: unknown;
  hasCredits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}
