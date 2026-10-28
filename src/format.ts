import type {
  CodexUsageModel,
  CodexUsageReport,
  NormalizedCredits,
  NormalizedRateLimitSnapshot,
  NormalizedRateLimitWindow,
} from "./types.ts";

export const USAGE_SETTINGS_URL = "https://chatgpt.com/codex/settings/usage";
const BAR_SEGMENTS = 20;

type TextStyle = (text: string) => string;

export interface UsageFormatStyles {
  heading: TextStyle;
  primary: TextStyle;
  secondary: TextStyle;
  dim: TextStyle;
  number: TextStyle;
  variant: TextStyle;
  warning: TextStyle;
}

const plainText: TextStyle = (text) => text;
export const PLAIN_USAGE_STYLES: UsageFormatStyles = {
  heading: plainText,
  primary: plainText,
  secondary: plainText,
  dim: plainText,
  number: plainText,
  variant: plainText,
  warning: plainText,
};

export function formatCodexUsageReport(
  report: CodexUsageReport,
  styles: UsageFormatStyles = PLAIN_USAGE_STYLES,
): string {
  const lines = [
    styles.heading(">_ OpenAI Codex Usage"),
    `Checked: ${formatCapturedAt(report.capturedAt)}`,
    `Source: ${report.source === "pi-auth" ? "Pi auth (direct)" : "Codex CLI"}`,
  ];
  if (report.planType) lines.push(`Plan: ${formatPlanType(report.planType)}`);
  if (report.resetCreditsAvailable !== undefined) {
    lines.push(
      `Reset credits: ${styles.number(String(report.resetCreditsAvailable))}`,
    );
  }
  if (report.resetCredits) {
    const now = new Date();
    for (const credit of report.resetCredits) {
      const expiration =
        credit.expiresAt === null
          ? "does not expire"
          : `expires ${formatReset(credit.expiresAt)} (${formatExpirationRemaining(credit.expiresAt, now)})`;
      lines.push(`  Reset credit ${credit.id}: ${expiration}`);
    }
    if (report.resetCredits.length < (report.resetCreditsAvailable ?? 0)) {
      lines.push("  Expiration unavailable for remaining reset credits");
    }
  }
  lines.push("");

  for (const [index, snapshot] of report.snapshots.entries()) {
    if (index > 0) lines.push("");
    const snapshotLabel = formatSnapshotLabel(snapshot);
    lines.push(
      `${isPrimaryCodexSnapshot(snapshot) ? styles.primary(snapshotLabel) : styles.variant(snapshotLabel)}:`,
    );
    if (snapshot.primary) {
      lines.push(
        `  ${styles.primary(formatWindowLabel(snapshot.primary, "Primary"))} ${formatWindow(snapshot.primary, styles.primary, styles)}`,
      );
    }
    if (snapshot.secondary) {
      lines.push(
        `  ${styles.secondary(formatWindowLabel(snapshot.secondary, "Secondary"))} ${formatWindow(snapshot.secondary, styles.secondary, styles)}`,
      );
    }
    if (!snapshot.primary && !snapshot.secondary)
      lines.push("  Rate-limit windows unavailable");
    if (snapshot.credits)
      lines.push(
        `  Usage credits: ${styles.number(formatCredits(snapshot.credits))}`,
      );
  }

  lines.push("", `Details: ${USAGE_SETTINGS_URL}`);
  return lines.join("\n");
}

export function formatCodexUsageStatusline(
  report: CodexUsageReport,
  model?: CodexUsageModel,
  now = new Date(),
  styles: UsageFormatStyles = PLAIN_USAGE_STYLES,
): string {
  const snapshot = selectSnapshotForModel(report, model);
  const sourceLabel = report.source === "codex-app-server" ? " (CLI)" : "";
  if (!snapshot) {
    if (!report.resetCreditsAvailable) {
      return `codex${sourceLabel} usage unavailable`;
    }
    const parts = [
      styles.heading(`codex${sourceLabel}`),
      styles.number(formatResetCredits(report.resetCreditsAvailable)),
    ];
    const warning = formatExpiringResetWarning(report, now, styles);
    if (warning) parts.push(warning);
    return parts.join(styles.dim(" · "));
  }

  const parts = [
    formatStatuslinePrefix(snapshot, styles) + styles.dim(sourceLabel),
  ];
  if (snapshot.primary)
    parts.push(
      formatCompactWindow(
        snapshot.primary,
        "primary",
        now,
        styles.primary,
        styles,
      ),
    );
  if (snapshot.secondary)
    parts.push(
      formatCompactWindow(
        snapshot.secondary,
        "secondary",
        now,
        styles.secondary,
        styles,
      ),
    );
  const credits = snapshot.credits
    ? formatFooterCredits(snapshot.credits)
    : undefined;
  if (credits) parts.push(styles.number(credits));
  if (report.resetCreditsAvailable) {
    parts.push(styles.number(formatResetCredits(report.resetCreditsAvailable)));
  }
  const warning = formatExpiringResetWarning(report, now, styles);
  if (warning) parts.push(warning);
  return parts.join(styles.dim(" · "));
}

export function selectSnapshotForModel(
  report: CodexUsageReport,
  model: CodexUsageModel | undefined,
): NormalizedRateLimitSnapshot | undefined {
  const codexSnapshot = report.snapshots.find(isPrimaryCodexSnapshot);
  if (!model || model.provider !== "openai-codex")
    return codexSnapshot ?? report.snapshots[0];

  const modelKeys = normalizedModelUsageKeys(model);
  const exactMatch = report.snapshots.find((snapshot) =>
    normalizedSnapshotUsageKeys(snapshot).some((key) => modelKeys.has(key)),
  );
  if (exactMatch) return exactMatch;

  for (const variant of codexModelVariantKeys(modelKeys)) {
    const matches = report.snapshots.filter(
      (snapshot) =>
        !isPrimaryCodexSnapshot(snapshot) &&
        normalizedSnapshotUsageKeys(snapshot).some((key) =>
          normalizedKeyHasToken(key, variant),
        ),
    );
    if (matches.length === 1) return matches[0];
  }

  return codexSnapshot ?? report.snapshots[0];
}

export function formatWindow(
  window: NormalizedRateLimitWindow,
  windowStyle: TextStyle = plainText,
  styles: UsageFormatStyles = PLAIN_USAGE_STYLES,
): string {
  const used = clampPercent(window.usedPercent);
  const remaining = 100 - used;
  const reset = window.resetsAt
    ? styles.dim(`; resets ${formatReset(window.resetsAt)}`)
    : "";
  return `${progressBar(remaining, windowStyle, styles.dim)} ${windowStyle(formatPercent(remaining))} left, ${styles.dim(`${formatPercent(used)} used`)}${reset}`;
}

export function progressBar(
  percentRemaining: number,
  filledStyle: TextStyle = plainText,
  emptyStyle: TextStyle = plainText,
): string {
  const filled = Math.round(
    (clampPercent(percentRemaining) / 100) * BAR_SEGMENTS,
  );
  return `[${filledStyle("█".repeat(filled))}${emptyStyle("░".repeat(BAR_SEGMENTS - filled))}]`;
}

export function formatCredits(credits: NormalizedCredits): string {
  if (!credits.hasCredits) return "none";
  if (credits.unlimited) return "unlimited";
  const balance = credits.balance?.trim();
  if (!balance) return "balance unavailable";
  const numeric = Number(balance);
  const formatted = Number.isFinite(numeric)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
        numeric,
      )
    : balance;
  return formatted;
}

export function formatResetCredits(count: number): string {
  return `${count} ${count === 1 ? "reset credit" : "reset credits"}`;
}

export function formatPlanType(planType: string): string {
  const key = planType
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const special: Record<string, string> = {
    prolite: "Pro Lite",
    pro_lite: "Pro Lite",
    self_serve_business_usage_based: "Business",
    enterprise_cbp_usage_based: "Enterprise",
    free_workspace: "Free Workspace",
    edu: "Education",
  };
  if (special[key]) return special[key];

  const normalized = planType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return normalized
    ? normalized
        .split(/\s+/)
        .map(
          (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join(" ")
    : planType;
}

export function formatWindowDuration(
  minutes: number | undefined,
): string | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0)
    return undefined;
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

export function formatReset(epochSeconds: number): string {
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return "at an unknown time";

  const now = new Date();
  const time = formatClockTime(reset);
  if (reset.toDateString() === now.toDateString()) return `at ${time}`;
  const date = reset.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return `at ${time} on ${date}`;
}

export function formatCompactReset(
  epochSeconds: number | undefined,
  now = new Date(),
): string | undefined {
  if (epochSeconds === undefined || !Number.isFinite(epochSeconds))
    return undefined;

  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime()) || Number.isNaN(now.getTime()))
    return undefined;

  const remainingMilliseconds = reset.getTime() - now.getTime();
  const relative =
    remainingMilliseconds <= 0
      ? "now"
      : formatCompactRemainingTime(remainingMilliseconds);
  const absolute =
    reset.toDateString() === now.toDateString()
      ? formatClockTime(reset)
      : `${reset.toLocaleDateString(undefined, { weekday: "short" })} ${formatClockTime(reset)}`;
  return `↻${relative} (${absolute})`;
}

const RESET_WARNING_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

function formatExpiringResetWarning(
  report: CodexUsageReport,
  now: Date,
  styles: UsageFormatStyles,
): string | undefined {
  const expiring = report.resetCredits
    ?.map((credit) => credit.expiresAt)
    .filter(
      (expiry): expiry is number =>
        expiry !== null &&
        expiry * 1000 > now.getTime() &&
        expiry * 1000 - now.getTime() <= RESET_WARNING_WINDOW_MS,
    );
  if (!expiring?.length) return undefined;
  const soonest = Math.min(...expiring);
  const remaining = formatCompactRemainingTime(soonest * 1000 - now.getTime());
  return styles.warning(
    expiring.length === 1
      ? `⚠ 1 reset expires in ${remaining}`
      : `⚠ ${expiring.length} resets expiring within 8d (next in ${remaining})`,
  );
}

function formatExpirationRemaining(epochSeconds: number, now: Date): string {
  const remaining = epochSeconds * 1000 - now.getTime();
  return remaining <= 0
    ? "expired"
    : `in ${formatCompactRemainingTime(remaining)}`;
}

function formatCapturedAt(epochMilliseconds: number): string {
  const captured = new Date(epochMilliseconds);
  return Number.isNaN(captured.getTime())
    ? "unknown"
    : captured.toLocaleString();
}

function formatWindowLabel(
  window: NormalizedRateLimitWindow,
  fallback: string,
): string {
  return `${formatWindowDuration(window.windowMinutes) ?? fallback} limit:`;
}

function formatCompactWindow(
  window: NormalizedRateLimitWindow,
  fallback: string,
  now: Date,
  windowStyle: TextStyle,
  styles: UsageFormatStyles,
): string {
  const duration = formatWindowDuration(window.windowMinutes) ?? fallback;
  const reset = formatCompactReset(window.resetsAt, now);
  const value = windowStyle(
    `${formatPercent(100 - clampPercent(window.usedPercent))} ${duration}`,
  );
  return `${value}${reset ? ` ${styles.dim(reset)}` : ""}`;
}

function formatCompactRemainingTime(milliseconds: number): string {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFooterCredits(credits: NormalizedCredits): string | undefined {
  if (!credits.hasCredits || (!credits.unlimited && !credits.balance?.trim())) {
    return undefined;
  }
  const value = formatCredits(credits);
  if (credits.unlimited) {
    return `usage credits: ${value}`;
  }
  return `${value} usage credits`;
}

function formatSnapshotLabel(snapshot: NormalizedRateLimitSnapshot): string {
  return isPrimaryCodexSnapshot(snapshot)
    ? "Codex"
    : (snapshot.limitName ?? snapshot.limitId).replace(/[_-]+/g, " ");
}

function formatStatuslinePrefix(
  snapshot: NormalizedRateLimitSnapshot,
  styles: UsageFormatStyles,
): string {
  const prefix = styles.heading("codex");
  if (isPrimaryCodexSnapshot(snapshot)) return prefix;
  const label = snapshot.limitName ?? snapshot.limitId;
  const normalized = label.replace(/[_-]+/g, " ").trim();
  const variant = (normalized.match(/\bcodex\s+(.+)$/i)?.[1] || normalized)
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `${prefix} ${styles.variant(variant)}`;
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function isPrimaryCodexSnapshot(
  snapshot: NormalizedRateLimitSnapshot,
): boolean {
  return (
    normalizedUsageKey(snapshot.limitId) === "codex" ||
    normalizedUsageKey(snapshot.limitName) === "codex"
  );
}

function normalizedModelUsageKeys(model: CodexUsageModel): Set<string> {
  const keys = new Set<string>();
  addNormalizedUsageKey(keys, model.id);
  addNormalizedUsageKey(keys, model.name);
  for (const key of [...keys]) {
    const codexIndex = key.indexOf("codex");
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }
  return keys;
}

function normalizedSnapshotUsageKeys(
  snapshot: NormalizedRateLimitSnapshot,
): string[] {
  return [
    normalizedUsageKey(snapshot.limitId),
    normalizedUsageKey(snapshot.limitName),
  ].filter((key): key is string => key !== undefined);
}

function addNormalizedUsageKey(
  keys: Set<string>,
  value: string | undefined,
): void {
  const key = normalizedUsageKey(value);
  if (key) keys.add(key);
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function codexModelVariantKeys(modelKeys: Set<string>): string[] {
  const variants = new Set<string>();
  for (const key of modelKeys) {
    const match = key.match(/(?:^|-)codex-(.+)$/);
    const variant = match?.[1];
    if (variant) variants.add(variant);
  }
  return [...variants];
}

function normalizedKeyHasToken(key: string, token: string): boolean {
  return (
    key === token ||
    key.startsWith(`${token}-`) ||
    key.endsWith(`-${token}`) ||
    key.includes(`-${token}-`)
  );
}
