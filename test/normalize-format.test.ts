import { describe, expect, it, vi } from "vitest";

import {
  formatCodexUsageReport,
  formatCodexUsageStatusline,
  formatCompactReset,
  formatPlanType,
  formatResetCredits,
  PLAIN_USAGE_STYLES,
  formatWindowDuration,
  type UsageFormatStyles,
} from "../src/format.ts";
import {
  normalizeAppServerResponse,
  normalizeBackendPayload,
} from "../src/normalize.ts";
import type { CodexUsageReport } from "../src/types.ts";

describe("usage normalization", () => {
  it("normalizes all direct backend windows, credits, plan, and additional limits", () => {
    const report = normalizeBackendPayload(
      {
        plan_type: "pro_lite",
        ignored_future_field: true,
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 18_000,
            reset_at: 1_900_000_000,
          },
          secondary_window: {
            used_percent: "60",
            limit_window_seconds: 604_800,
            reset_at: "1900001000",
          },
        },
        credits: { has_credits: true, unlimited: false, balance: "12.50" },
        rate_limit_reset_credits: { available_count: 2 },
        additional_rate_limits: [
          {
            limit_name: "GPT 5.3 Codex Spark",
            metered_feature: "codex_spark",
            rate_limit: {
              primary_window: {
                used_percent: 80,
                limit_window_seconds: 3_600,
                reset_at: 1_900_002_000,
              },
            },
          },
          "future malformed entry",
        ],
      },
      1_800_000_000_000,
      "pi-auth",
    );

    expect(report).toMatchObject({
      source: "pi-auth",
      capturedAt: 1_800_000_000_000,
      planType: "pro_lite",
      resetCreditsAvailable: 2,
    });
    expect(report.snapshots).toHaveLength(2);
    expect(report.snapshots[0]).toEqual({
      limitId: "codex",
      primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: {
        usedPercent: 60,
        windowMinutes: 10_080,
        resetsAt: 1_900_001_000,
      },
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    });
    expect(report.snapshots[1]?.limitId).toBe("codex_spark");
  });

  it("merges duplicate app-server snapshots without discarding fields", () => {
    const report = normalizeAppServerResponse(
      {
        rateLimits: {
          limitId: "codex",
          planType: "business",
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: 1_900_000_000,
          },
        },
        rateLimitResetCredits: { availableCount: 1 },
        rateLimitsByLimitId: {
          codex: {
            limitId: "CODEX",
            secondary: {
              usedPercent: 40,
              windowDurationMins: 10_080,
              resetsAt: 1_900_100_000,
            },
            credits: { hasCredits: true, unlimited: true, balance: null },
          },
          codex_spark: {
            limitId: "codex_spark",
            limitName: "gpt-5.3-codex-spark",
            primary: {
              usedPercent: 75,
              windowDurationMins: 300,
              resetsAt: null,
            },
            future: { anything: true },
          },
        },
      },
      123,
    );

    expect(report.planType).toBe("business");
    expect(report.resetCreditsAvailable).toBe(1);
    expect(report.snapshots).toHaveLength(2);
    expect(report.snapshots[0]).toEqual({
      limitId: "CODEX",
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1_900_000_000 },
      secondary: {
        usedPercent: 40,
        windowMinutes: 10_080,
        resetsAt: 1_900_100_000,
      },
      credits: { hasCredits: true, unlimited: true },
    });
  });

  it("normalizes available reset-credit expiry without treating malformed dates as permanent", () => {
    const report = normalizeBackendPayload(
      {
        rate_limit_reset_credits: {
          available_count: 4,
          credits: [
            {
              id: "early",
              status: "available",
              expires_at: "2030-01-10T00:00:00Z",
            },
            { id: "never", status: "available", expires_at: null },
            { id: "bad", status: "available", expires_at: "invalid" },
            {
              id: "used",
              status: "redeemed",
              expires_at: "2030-01-11T00:00:00Z",
            },
          ],
        },
      },
      1,
      "pi-auth",
    );
    expect(report.resetCredits).toEqual([
      { id: "early", expiresAt: Date.parse("2030-01-10T00:00:00Z") / 1000 },
      { id: "never", expiresAt: null },
    ]);
    expect(
      normalizeAppServerResponse(
        {
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: "server-1", status: "available", expiresAt: 1_900_000_000 },
            ],
          },
        },
        1,
      ).resetCredits,
    ).toEqual([{ id: "server-1", expiresAt: 1_900_000_000 }]);
  });

  it("preserves zero and rejects malformed reset-credit counts", () => {
    expect(
      normalizeBackendPayload(
        { rate_limit_reset_credits: { available_count: 0 } },
        1,
        "pi-auth",
      ).resetCreditsAvailable,
    ).toBe(0);
    expect(
      normalizeAppServerResponse(
        { rateLimitResetCredits: { availableCount: "2" } },
        1,
      ).resetCreditsAvailable,
    ).toBe(2);

    for (const availableCount of [-1, 1.5, "invalid", null]) {
      expect(() =>
        normalizeAppServerResponse(
          { rateLimitResetCredits: { availableCount } },
          1,
        ),
      ).toThrow(/no displayable/i);
    }
  });

  it("rejects payloads with no displayable usage information", () => {
    expect(() =>
      normalizeBackendPayload(
        { plan_type: "pro", rate_limit: { allowed: true } },
        1,
        "pi-auth",
      ),
    ).toThrow(/no displayable/i);
    expect(() =>
      normalizeAppServerResponse({ rateLimits: { planType: "pro" } }, 1),
    ).toThrow(/no displayable/i);
  });
});

describe("usage formatting", () => {
  it("labels CLI output in both report and footer", () => {
    const report: CodexUsageReport = {
      source: "codex-app-server",
      capturedAt: 0,
      snapshots: [],
      resetCreditsAvailable: 0,
    };
    expect(formatCodexUsageReport(report)).toContain("Source: Codex CLI");
    expect(formatCodexUsageStatusline(report)).toContain("codex (CLI)");
  });

  const report: CodexUsageReport = {
    source: "pi-auth",
    capturedAt: 1_800_000_000_000,
    planType: "pro_lite",
    resetCreditsAvailable: 2,
    snapshots: [
      {
        limitId: "codex",
        primary: {
          usedPercent: 25,
          windowMinutes: 300,
          resetsAt: 1_900_000_000,
        },
        secondary: {
          usedPercent: 60,
          windowMinutes: 10_080,
          resetsAt: 1_900_100_000,
        },
        credits: { hasCredits: true, unlimited: false, balance: "12.5" },
      },
      {
        limitId: "codex_spark",
        limitName: "gpt-5.3-codex-spark",
        primary: { usedPercent: 80, windowMinutes: 300 },
        credits: { hasCredits: false, unlimited: false },
      },
    ],
  };

  it("prints every requested report field", () => {
    const text = formatCodexUsageReport(report);

    expect(text).toContain("OpenAI Codex Usage");
    expect(text).toContain("Checked:");
    expect(text).toContain("Source: Pi auth (direct)");
    expect(text).toContain("Plan: Pro Lite");
    expect(text).toContain("Reset credits: 2");
    expect(text).toContain("5h limit:");
    expect(text).toContain("1w limit:");
    expect(text).toContain("75% left, 25% used");
    expect(text).toContain("40% left, 60% used");
    expect(text).toContain("resets at");
    expect(text).toContain("Usage credits: 12.5");
    expect(text).toContain("gpt 5.3 codex spark:");
    expect(text).toContain("Usage credits: none");
    expect(text).toContain("chatgpt.com/codex/settings/usage");
    expect(text).toMatch(/\[[█░]{20}\]/u);
  });

  it("assigns semantic styles to distinct usage categories", () => {
    const wrap =
      (name: string) =>
      (text: string): string =>
        `<${name}>${text}</${name}>`;
    const styles: UsageFormatStyles = {
      heading: wrap("heading"),
      primary: wrap("primary"),
      secondary: wrap("secondary"),
      dim: wrap("dim"),
      number: wrap("number"),
      variant: wrap("variant"),
      warning: wrap("warning"),
    };

    const detailed = formatCodexUsageReport(report, styles);
    expect(detailed).toContain("<heading>>_ OpenAI Codex Usage</heading>");
    expect(detailed).toContain("<primary>5h limit:</primary>");
    expect(detailed).toContain("<secondary>1w limit:</secondary>");
    expect(detailed).toContain("<primary>███████████████</primary>");
    expect(detailed).toContain("<dim>░░░░░</dim>");
    expect(detailed).toContain("Usage credits: <number>12.5</number>");
    expect(detailed).toContain("Reset credits: <number>2</number>");

    const status = formatCodexUsageStatusline(
      report,
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
      },
      new Date(1_800_000_000_000),
      styles,
    );
    expect(status).toContain("<heading>codex</heading>");
    expect(status).toContain("<variant>spark</variant>");
    expect(status).toContain("<primary>20% 5h</primary>");
    expect(status).toContain("<number>usage credits: none</number>");
    expect(status).toContain("<number>2 reset credits</number>");
    expect(status).toContain("<dim> · </dim>");
  });

  it("selects the additional limit matching the active Codex model", () => {
    const status = formatCodexUsageStatusline(report, {
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      name: "GPT-5.3 Codex Spark",
    });

    expect(status).toContain("codex spark");
    expect(status).toContain("20% 5h");
    expect(status).toContain("none");
    expect(status).toContain("2 reset credits");
  });

  it("formats compact same-day and later resets relative to an injected clock", () => {
    const now = new Date(2030, 0, 2, 10, 0);
    const sameDayReset = new Date(2030, 0, 2, 12, 14);
    const laterReset = new Date(2030, 0, 5, 14, 0);
    const clockOptions: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
    };

    expect(formatCompactReset(sameDayReset.getTime() / 1_000, now)).toBe(
      `↻2h14m (${sameDayReset.toLocaleTimeString(undefined, clockOptions)})`,
    );
    expect(formatCompactReset(laterReset.getTime() / 1_000, now)).toBe(
      `↻3d4h (${laterReset.toLocaleDateString(undefined, { weekday: "short" })} ${laterReset.toLocaleTimeString(undefined, clockOptions)})`,
    );

    const status = formatCodexUsageStatusline(
      {
        source: "pi-auth",
        capturedAt: now.getTime(),
        snapshots: [
          {
            limitId: "codex",
            primary: {
              usedPercent: 30,
              windowMinutes: 300,
              resetsAt: sameDayReset.getTime() / 1_000,
            },
          },
        ],
      },
      undefined,
      now,
    );
    expect(status).toContain("70% 5h ↻2h14m");
  });

  it("handles elapsed, missing, and invalid compact reset timestamps", () => {
    const now = new Date(2030, 0, 2, 10, 0);
    const elapsedReset = new Date(2030, 0, 2, 9, 59);

    expect(formatCompactReset(elapsedReset.getTime() / 1_000, now)).toContain(
      "↻now (",
    );
    expect(formatCompactReset(undefined, now)).toBeUndefined();
    expect(formatCompactReset(Number.NaN, now)).toBeUndefined();
    expect(formatCompactReset(Number.POSITIVE_INFINITY, now)).toBeUndefined();
  });

  it("omits an indeterminate credit balance only from the footer", () => {
    const indeterminateReport: CodexUsageReport = {
      source: "pi-auth",
      capturedAt: 1,
      snapshots: [
        {
          limitId: "codex",
          primary: { usedPercent: 25, windowMinutes: 300 },
          credits: { hasCredits: true, unlimited: false },
        },
      ],
    };

    expect(formatCodexUsageStatusline(indeterminateReport)).toBe(
      "codex · 75% 5h",
    );
    expect(formatCodexUsageReport(indeterminateReport)).toContain(
      "Usage credits: balance unavailable",
    );
  });

  it("preserves known credit states in the footer", () => {
    const statusForCredits = (
      credits: NonNullable<CodexUsageReport["snapshots"][number]["credits"]>,
    ): string =>
      formatCodexUsageStatusline({
        source: "pi-auth",
        capturedAt: 1,
        snapshots: [{ limitId: "codex", credits }],
      });

    expect(statusForCredits({ hasCredits: false, unlimited: false })).toContain(
      "none",
    );
    expect(statusForCredits({ hasCredits: true, unlimited: true })).toContain(
      "unlimited",
    );
    expect(
      statusForCredits({
        hasCredits: true,
        unlimited: false,
        balance: "12.5",
      }),
    ).toContain("12.5 usage credits");
  });

  it("warns only for available credits expiring within eight days", () => {
    const now = new Date("2030-01-02T10:00:00Z");
    const expiry = (days: number): number =>
      now.getTime() / 1000 + days * 86400;
    const warningReport: CodexUsageReport = {
      source: "pi-auth",
      capturedAt: now.getTime(),
      resetCreditsAvailable: 4,
      resetCredits: [
        { id: "one", expiresAt: expiry(2) },
        { id: "two", expiresAt: expiry(8) },
        { id: "three", expiresAt: expiry(9) },
        { id: "four", expiresAt: null },
      ],
      snapshots: [],
    };
    const status = formatCodexUsageStatusline(warningReport, undefined, now);
    expect(status).toContain("⚠ 2 resets expiring within 8d (next in 2d)");
    expect(status).not.toContain("9d");
    expect(
      formatCodexUsageStatusline(
        {
          ...warningReport,
          resetCredits: [{ id: "two", expiresAt: expiry(8) }],
        },
        undefined,
        now,
      ),
    ).toContain("⚠ 1 reset expires in 8d");
    const colored = formatCodexUsageStatusline(warningReport, undefined, now, {
      ...PLAIN_USAGE_STYLES,
      warning: (text) => `<red>${text}</red>`,
    });
    expect(colored).toContain(
      "<red>⚠ 2 resets expiring within 8d (next in 2d)</red>",
    );
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const details = formatCodexUsageReport(warningReport);
      expect(details).toContain("Reset credit one: expires at");
      expect(details).toContain("(in 2d)");
      expect(details).toContain("Reset credit four: does not expire");
      expect(details).not.toContain("⚠");
    } finally {
      vi.useRealTimers();
    }
    expect(
      formatCodexUsageStatusline(
        warningReport,
        undefined,
        new Date(now.getTime() + 3 * 86400000),
      ),
    ).toContain("⚠ 2 resets expiring within 8d (next in 5d)");
    expect(
      formatCodexUsageStatusline(
        warningReport,
        undefined,
        new Date(now.getTime() + 10 * 86400000),
      ),
    ).not.toContain("⚠");
    expect(
      formatCodexUsageStatusline(
        { ...warningReport, resetCredits: [] },
        undefined,
        now,
      ),
    ).not.toContain("⚠");
  });

  it("pluralizes reset-credit counts, including count-only reports", () => {
    expect(formatResetCredits(0)).toBe("0 reset credits");
    expect(formatResetCredits(1)).toBe("1 reset credit");
    expect(formatResetCredits(2)).toBe("2 reset credits");
    expect(formatResetCredits(100)).toBe("100 reset credits");
    expect(
      formatCodexUsageStatusline({
        source: "pi-auth",
        capturedAt: 1,
        resetCreditsAvailable: 0,
        snapshots: [],
      }),
    ).toBe("codex · 0 reset credits");
  });

  it("formats plan names and dynamic durations", () => {
    expect(formatPlanType("self_serve_business_usage_based")).toBe("Business");
    expect(formatWindowDuration(30)).toBe("30m");
    expect(formatWindowDuration(300)).toBe("5h");
    expect(formatWindowDuration(1_440)).toBe("1d");
    expect(formatWindowDuration(10_080)).toBe("1w");
  });
});
