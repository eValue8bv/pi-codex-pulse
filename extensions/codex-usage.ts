import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatCodexUsageReport,
  formatCodexUsageStatusline,
  type UsageFormatStyles,
} from "../src/format.ts";
import {
  CODEX_PROVIDER_ID,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  queryUsage,
  type QueryUsageOptions,
  type QueryUsageResult,
} from "../src/query.ts";
import { redeemReset, RedemptionUncertainError } from "../src/redeem.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  settingsPath,
  type PulseSettings,
} from "../src/settings.ts";
import type { CodexUsageModel, CodexUsageReport } from "../src/types.ts";
import {
  errorMessage,
  isAbortError,
  isStaleContextError,
  redactSensitiveText,
} from "../src/utils.ts";

export const COMMAND_NAME = "codex-usage";
export const REDEEM_COMMAND_NAME = "codex-redeem-reset";
export const STATUS_KEY = "codex-pulse";
export const STATUS_REFRESH_INTERVAL_MS = 60_000;
export type UsageCommandOptions = Pick<QueryUsageOptions, "timeoutMs">;
export type UsageQuery = (
  ctx: ExtensionContext,
  options: QueryUsageOptions,
) => Promise<QueryUsageResult>;
export interface SettingsStore {
  load: () => Promise<PulseSettings>;
  save: (settings: PulseSettings) => Promise<void>;
}
export interface ExtensionDependencies {
  query?: UsageQuery;
  redeem?: typeof redeemReset;
  settings?: SettingsStore;
}
interface Snapshot {
  report: CodexUsageReport;
  accountKey: string;
}

export default function codexPulse(pi: ExtensionAPI): void {
  registerCodexPulse(pi);
}

export function registerCodexPulse(
  pi: ExtensionAPI,
  dependencies: ExtensionDependencies = {},
): void {
  const runQuery = dependencies.query ?? queryUsage;
  const runRedeem = dependencies.redeem ?? redeemReset;
  const path = settingsPath(getAgentDir());
  const store = dependencies.settings ?? {
    load: () => loadSettings(path),
    save: (value: PulseSettings) => saveSettings(path, value),
  };
  let settings: PulseSettings = { ...DEFAULT_SETTINGS };
  let snapshot: Snapshot | undefined;
  let generation = 0;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessionActive = false;
  let stopped = false;
  let savingSettings = false;
  let redemption: AbortController | undefined;
  let liveContext: ExtensionContext | undefined;

  const invalidate = (clearSnapshot = false): void => {
    generation += 1;
    redemption?.abort();
    active?.abort();
    active = undefined;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (clearSnapshot) {
      snapshot = undefined;
    }
  };

  const setStatus = (
    ctx: ExtensionContext,
    value: string | undefined,
  ): void => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch (error) {
      if (!isStaleContextError(error)) {
        throw error;
      }
      stopped = true;
      sessionActive = false;
      invalidate(true);
    }
  };

  const canPoll = (ctx: ExtensionContext): boolean =>
    sessionActive &&
    !stopped &&
    !redemption &&
    settings.polling &&
    ctx.hasUI &&
    ctx.mode === "tui" &&
    isOpenAICodexModel(ctx.model);
  const schedule = (ctx: ExtensionContext): void => {
    if (!canPoll(ctx)) {
      return;
    }
    const scheduledGeneration = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (scheduledGeneration === generation && canPoll(ctx)) {
        backgroundRefresh(ctx);
      }
    }, STATUS_REFRESH_INTERVAL_MS);
    timer.unref?.();
  };

  const render = (ctx: ExtensionContext, report: CodexUsageReport): string => {
    const model = ctx.model
      ? { id: ctx.model.id, name: ctx.model.name, provider: ctx.model.provider }
      : undefined;
    return formatCodexUsageStatusline(
      report,
      model,
      new Date(),
      usageStyles(ctx),
    );
  };

  const refresh = async (
    ctx: ExtensionContext,
    timeoutMs: number,
    manual: boolean,
  ): Promise<void> => {
    invalidate();
    const requestGeneration = generation;
    const controller = new AbortController();
    active = controller;
    const current = (): boolean =>
      !stopped &&
      generation === requestGeneration &&
      !controller.signal.aborted;
    const showStatus = ctx.hasUI && isOpenAICodexModel(ctx.model);
    let settingsLoaded = false;
    if (showStatus) {
      setStatus(ctx, "codex checking…");
    }
    try {
      const loaded = await store.load();
      if (!current()) {
        return;
      }
      if (
        loaded.source !== settings.source ||
        loaded.polling !== settings.polling
      ) {
        snapshot = undefined;
      }
      settings = loaded;
      settingsLoaded = true;
      if (!manual && !canPoll(ctx)) {
        setStatus(ctx, undefined);
        return;
      }

      const result = await runQuery(ctx, {
        timeoutMs,
        source: settings.source,
        signal: controller.signal,
      });
      if (!current()) {
        return;
      }
      if (result.ok) {
        snapshot = result.accountKey
          ? { report: result.report, accountKey: result.accountKey }
          : undefined;
        if (showStatus) {
          const suffix = !settings.polling
            ? ` · snapshot ${new Date(result.report.capturedAt).toLocaleTimeString()}`
            : "";
          setStatus(ctx, `${render(ctx, result.report)}${suffix}`);
        }
        if (manual && current()) {
          ctx.ui.notify(
            formatCodexUsageReport(result.report, usageStyles(ctx)),
            "info",
          );
        }
      } else {
        const retained =
          result.accountKey && snapshot?.accountKey === result.accountKey
            ? snapshot
            : undefined;
        snapshot = retained;
        if (showStatus) {
          const age = retained
            ? formatSnapshotAge(retained.report.capturedAt)
            : "";
          setStatus(
            ctx,
            retained
              ? `${render(ctx, retained.report)} · ${ctx.ui.theme.fg("warning", `stale (${age} old)`)}`
              : "codex usage error",
          );
        }
        if (manual && current()) {
          ctx.ui.notify(
            `Unable to read Codex usage.\n${result.errors.map((error) => `${error.source === "pi-auth" ? "Pi" : "Codex CLI"}: ${error.message}`).join("\n")}`,
            "error",
          );
        }
      }
    } catch (error) {
      if (isStaleContextError(error)) {
        stopped = true;
        sessionActive = false;
        invalidate(true);
        return;
      }
      if (!current() || isAbortError(error)) {
        return;
      }
      snapshot = undefined;
      if (showStatus) {
        setStatus(
          ctx,
          settingsLoaded ? "codex usage error" : "codex settings error",
        );
      }
      if (manual && current()) {
        ctx.ui.notify(redactSensitiveText(errorMessage(error)), "error");
      }
    } finally {
      if (current()) {
        active = undefined;
        if (settingsLoaded) {
          schedule(ctx);
        }
      }
    }
  };

  const backgroundRefresh = (ctx: ExtensionContext): void => {
    if (savingSettings || redemption) {
      return;
    }
    void refresh(ctx, DEFAULT_TIMEOUT_MS, false).catch(() => {
      // Rendering may fail after Pi replaces a session. Stop rather than leak a rejection or poll the old context.
      invalidate(true);
    });
  };

  const updateSettings = async (
    args: string[],
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    if (!ctx.hasUI) {
      throw new Error(
        "Changing Codex Pulse preferences requires an interactive UI.",
      );
    }
    if (savingSettings) {
      ctx.ui.notify(
        "Codex Pulse preferences are already being saved.",
        "warning",
      );
      return;
    }
    savingSettings = true;
    invalidate(true);
    setStatus(ctx, undefined);
    const settingGeneration = generation;
    try {
      const loaded = await store.load();
      const updated = { ...loaded };
      if (args[0] === "source") {
        updated.source = args[1] as PulseSettings["source"];
      } else {
        updated.polling = args[1] === "on";
      }
      await store.save(updated);
      if (stopped || settingGeneration !== generation) {
        return;
      }
      settings = updated;
      ctx.ui.notify(
        `Codex Pulse: source=${settings.source}, polling=${settings.polling ? "on" : "off"}. Saved to user settings.`,
        "info",
      );
      savingSettings = false;
      if (canPoll(ctx)) {
        backgroundRefresh(ctx);
      }
    } catch (error) {
      if (
        !stopped &&
        settingGeneration === generation &&
        !isStaleContextError(error)
      ) {
        ctx.ui.notify(redactSensitiveText(errorMessage(error)), "error");
      }
    } finally {
      savingSettings = false;
    }
  };

  pi.registerCommand(COMMAND_NAME, {
    description:
      "Show Codex subscription usage or configure its source and polling",
    getArgumentCompletions: completeUsageArguments,
    handler: async (args, ctx) => {
      if (savingSettings) {
        ctx.ui.notify(
          "Codex Pulse preferences are already being saved.",
          "warning",
        );
        return;
      }
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens[0] === "source" || tokens[0] === "polling") {
        const choices =
          tokens[0] === "source" ? ["auto", "pi", "codex-cli"] : ["on", "off"];
        if (tokens.length !== 2 || !choices.includes(tokens[1] ?? "")) {
          ctx.ui.notify(
            `Usage: /codex-usage ${tokens[0]} ${choices.join("|")}`,
            "warning",
          );
          return;
        }
        await updateSettings(tokens, ctx);
        return;
      }
      if (redemption) {
        ctx.ui.notify(
          "A reset redemption is in progress. Finish or cancel its confirmation first.",
          "warning",
        );
        return;
      }
      const parsed = parseUsageArgs(args);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      await refresh(ctx, parsed.value.timeoutMs, true);
    },
  });

  pi.registerCommand(REDEEM_COMMAND_NAME, {
    description:
      "Redeem one Codex reset credit through Pi authentication after confirmation",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /codex-redeem-reset", "warning");
        return;
      }
      if (!ctx.hasUI || ctx.mode !== "tui") {
        throw new Error(
          "/codex-redeem-reset requires an interactive terminal UI.",
        );
      }
      if (stopped) {
        return;
      }
      if (redemption || savingSettings) {
        ctx.ui.notify(
          "A redemption or preferences update is already in progress.",
          "warning",
        );
        return;
      }
      liveContext = ctx;
      invalidate(true);
      setStatus(ctx, undefined);
      const controller = new AbortController();
      redemption = controller;
      const operationGeneration = generation;
      let submitted = false;
      try {
        const outcome = await runRedeem(ctx, {
          signal: controller.signal,
          readSource: async () => (await store.load()).source,
          onSubmit: () => {
            submitted = true;
          },
        });
        if (outcome && !stopped && liveContext) {
          const messages = {
            reset: "Codex reset redeemed successfully.",
            nothingToReset: "Codex reported nothing to reset.",
            noCredit: "Codex reported no available credit for this redemption.",
            alreadyRedeemed:
              "Codex reported this redemption was already processed; no second reset is claimed.",
          };
          liveContext.ui.notify(
            messages[outcome],
            outcome === "reset" || outcome === "alreadyRedeemed"
              ? "info"
              : "warning",
          );
        }
      } catch (error) {
        if (
          !stopped &&
          liveContext &&
          !isStaleContextError(error) &&
          (!controller.signal.aborted ||
            error instanceof RedemptionUncertainError)
        ) {
          liveContext.ui.notify(
            redactSensitiveText(errorMessage(error)),
            "error",
          );
        }
      } finally {
        redemption = undefined;
        if (!stopped && operationGeneration === generation) {
          if (submitted) {
            // A failed read must not overwrite the already reported write outcome.
            await refresh(ctx, DEFAULT_TIMEOUT_MS, true);
          } else if (canPoll(ctx)) {
            backgroundRefresh(ctx);
          }
        } else if (liveContext && canPoll(liveContext)) {
          backgroundRefresh(liveContext);
        }
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    liveContext = ctx;
    invalidate(true);
    sessionActive = true;
    stopped = false;
    if (ctx.hasUI && ctx.mode === "tui" && isOpenAICodexModel(ctx.model)) {
      backgroundRefresh(ctx);
    }
  });
  pi.on("model_select", (_event, ctx) => {
    liveContext = ctx;
    invalidate(true);
    setStatus(ctx, undefined);
    if (ctx.hasUI && ctx.mode === "tui" && isOpenAICodexModel(ctx.model)) {
      // Resolve authentication again; model changes may select a different account.
      backgroundRefresh(ctx);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    stopped = true;
    invalidate(true);
    setStatus(ctx, undefined);
  });
}

export function parseUsageArgs(
  args: string,
): { ok: true; value: UsageCommandOptions } | { ok: false; error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: true, value: { timeoutMs: DEFAULT_TIMEOUT_MS } };
  }
  if (tokens.length !== 2 || tokens[0] !== "--timeout") {
    return {
      ok: false,
      error:
        "Usage: /codex-usage [--timeout seconds] | source auto|pi|codex-cli | polling on|off",
    };
  }
  const seconds = Number(tokens[1]);
  if (
    !Number.isFinite(seconds) ||
    seconds < 1 ||
    seconds > MAX_TIMEOUT_MS / 1000
  ) {
    return { ok: false, error: "--timeout must be between 1 and 120 seconds." };
  }
  return { ok: true, value: { timeoutMs: Math.round(seconds * 1000) } };
}

export function completeUsageArguments(
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const choices = [
    "--timeout ",
    "source auto",
    "source pi",
    "source codex-cli",
    "polling on",
    "polling off",
  ];
  const matches = choices.filter((choice) =>
    choice.startsWith(prefix.trimStart()),
  );
  return matches.length
    ? matches.map((value) => ({ value, label: value.trim() }))
    : null;
}

export function isOpenAICodexModel(
  model: Pick<CodexUsageModel, "provider"> | undefined,
): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

export function formatSnapshotAge(
  capturedAt: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - capturedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.floor(seconds / 3600)}h`;
}

function usageStyles(ctx: ExtensionContext): UsageFormatStyles {
  const { theme } = ctx.ui;
  return {
    heading: (text) => theme.fg("accent", theme.bold(text)),
    primary: (text) => theme.fg("accent", text),
    secondary: (text) => theme.fg("syntaxType", text),
    dim: (text) => theme.fg("dim", text),
    number: (text) => theme.fg("syntaxNumber", text),
    variant: (text) => theme.fg("muted", text),
    warning: (text) => theme.fg("error", theme.bold(text)),
  };
}
