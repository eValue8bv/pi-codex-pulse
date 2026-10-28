import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUsageArgs,
  registerCodexPulse,
  STATUS_REFRESH_INTERVAL_MS,
  type UsageQuery,
} from "../extensions/codex-usage.ts";
import type { QueryUsageResult } from "../src/query.ts";
import type { CodexUsageReport } from "../src/types.ts";
import { DEFAULT_SETTINGS, type PulseSettings } from "../src/settings.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Command = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function model(id = "codex-test", provider = "openai-codex") {
  return { id, name: id, provider };
}

function success(usedPercent = 20, accountKey = "account-a"): QueryUsageResult {
  const report: CodexUsageReport = {
    source: "pi-auth",
    capturedAt: Date.now(),
    planType: "pro",
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent, windowMinutes: 300 },
        secondary: { usedPercent: 50, windowMinutes: 10080 },
      },
    ],
  };
  return { ok: true, report, accountKey };
}

function harness(
  query: UsageQuery,
  preferences: PulseSettings = { ...DEFAULT_SETTINGS },
) {
  const commands = new Map<string, Command>();
  const events = new Map<string, Handler>();
  const pi = {
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    on: (name: string, handler: Handler) => {
      events.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const store = {
    load: vi.fn(async () => ({ ...preferences })),
    save: vi.fn(async (value: PulseSettings) => {
      Object.assign(preferences, value);
    }),
  };
  registerCodexPulse(pi, { query, settings: store });
  const statusValues: Array<string | undefined> = [];
  const rawContext = {
    model: model(),
    hasUI: true,
    mode: "tui",
    ui: {
      setStatus: vi.fn((_key: string, value: string | undefined) => {
        statusValues.push(value);
      }),
      notify: vi.fn(),
      theme: {
        fg: vi.fn(
          (color: string, text: string) => `<${color}>${text}</${color}>`,
        ),
        bold: (text: string) => `<bold>${text}</bold>`,
      },
    },
  };
  const ctx = rawContext as unknown as ExtensionCommandContext;
  return {
    store,
    commands,
    events,
    ctx,
    rawContext,
    statusValues,
    command: commands.get("codex-usage")!,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("read-only command", () => {
  it("registers only /codex-usage, not /usage or redemption", () => {
    expect([...harness(vi.fn(async () => success())).commands.keys()]).toEqual([
      "codex-usage",
    ]);
  });

  it("validates timeout arguments", () => {
    expect(parseUsageArgs("")).toEqual({
      ok: true,
      value: { timeoutMs: 15000 },
    });
    expect(parseUsageArgs("--timeout 2.5")).toEqual({
      ok: true,
      value: { timeoutMs: 2500 },
    });
    for (const args of [
      "--timeout",
      "--timeout 0",
      "--timeout 121",
      "--refresh",
    ]) {
      expect(parseUsageArgs(args).ok).toBe(false);
    }
  });

  it("queries every invocation and uses theme styles", async () => {
    const query = vi.fn(async () => success());
    const { command, ctx, rawContext, statusValues } = harness(query);
    await command.handler("", ctx);
    await command.handler("", ctx);
    expect(query).toHaveBeenCalledTimes(2);
    expect(rawContext.ui.notify).toHaveBeenCalledTimes(2);
    expect(statusValues.at(-1)).toContain("<accent>80% 5h</accent>");
    expect(statusValues.at(-1)).toContain("<syntaxType>50% 1w</syntaxType>");
  });

  it("reports usage for non-Codex models without a footer", async () => {
    const { command, ctx, rawContext, statusValues } = harness(
      vi.fn(async () => success()),
    );
    rawContext.model = model("other", "openai");
    await command.handler("", ctx);
    expect(statusValues).toEqual([]);
    expect(rawContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("OpenAI Codex Usage"),
      "info",
    );
  });

  it("reports source failures", async () => {
    const { command, ctx, rawContext, statusValues } = harness(async () => ({
      ok: false,
      errors: [{ source: "pi-auth", message: "not logged in" }],
    }));
    await command.handler("", ctx);
    expect(statusValues.at(-1)).toBe("codex usage error");
    expect(rawContext.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not logged in"),
      "error",
    );
  });
});

describe("settings and stale snapshots", () => {
  it("does not query on startup or model changes in manual-only mode", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => success());
    const { command, ctx, events, rawContext, statusValues } = harness(query, {
      source: "pi",
      polling: false,
    });
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    events.get("model_select")?.({ model: rawContext.model } as never, ctx);
    await vi.advanceTimersByTimeAsync(180000);
    expect(query).not.toHaveBeenCalled();
    await command.handler("", ctx);
    expect(query).toHaveBeenCalledOnce();
    expect(statusValues.at(-1)).toContain("snapshot");
    await vi.advanceTimersByTimeAsync(180000);
    expect(query).toHaveBeenCalledOnce();
  });

  it("does not poll in headless or RPC sessions", async () => {
    const query = vi.fn(async () => success());
    const { events, ctx, rawContext } = harness(query);
    rawContext.mode = "rpc";
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    expect(query).not.toHaveBeenCalled();
  });

  it("persists source preferences without making a request in manual-only mode", async () => {
    const query = vi.fn(async () => success());
    const { command, ctx, store } = harness(query, {
      source: "auto",
      polling: false,
    });
    await command.handler("source codex-cli", ctx);
    expect(store.save).toHaveBeenCalledWith({
      source: "codex-cli",
      polling: false,
    });
    expect(query).not.toHaveBeenCalled();
    await command.handler("", ctx);
    expect(query).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ source: "codex-cli" }),
    );
  });

  it("rejects invalid preference commands without persisting", async () => {
    const { command, ctx, store } = harness(async () => success());
    await command.handler("source wrong", ctx);
    await command.handler("polling off extra", ctx);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("stops active queries and polling when disabled", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => success());
    const { command, ctx, events } = harness(query);
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    await command.handler("polling off", ctx);
    await vi.advanceTimersByTimeAsync(180000);
    expect(query).toHaveBeenCalledOnce();
  });

  it("shows stale values with age only for a confirmed matching account", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn<UsageQuery>()
      .mockResolvedValueOnce(success())
      .mockResolvedValue({
        ok: false,
        accountKey: "account-a",
        errors: [{ source: "pi-auth", message: "offline" }],
      });
    const { command, ctx, statusValues } = harness(query);
    await command.handler("", ctx);
    await vi.advanceTimersByTimeAsync(120000);
    await command.handler("", ctx);
    expect(statusValues.at(-1)).toContain("80% 5h");
    expect(statusValues.at(-1)).toContain("stale (2m old)");
  });

  it.each([undefined, "account-b"])(
    "clears stale data when account identity is %s",
    async (accountKey) => {
      const query = vi
        .fn<UsageQuery>()
        .mockResolvedValueOnce(success())
        .mockResolvedValue({
          ok: false,
          ...(accountKey ? { accountKey } : {}),
          errors: [],
        });
      const { command, ctx, statusValues } = harness(query);
      await command.handler("", ctx);
      await command.handler("", ctx);
      expect(statusValues.at(-1)).toBe("codex usage error");
    },
  );

  it("clears snapshots when externally edited source settings change", async () => {
    const preferences: PulseSettings = { source: "auto", polling: false };
    const query = vi
      .fn<UsageQuery>()
      .mockResolvedValueOnce(success())
      .mockResolvedValue({ ok: false, accountKey: "account-a", errors: [] });
    const { command, ctx, statusValues } = harness(query, preferences);
    await command.handler("", ctx);
    preferences.source = "codex-cli";
    await command.handler("", ctx);
    expect(statusValues.at(-1)).toBe("codex usage error");
  });

  it("fails closed on invalid settings without background requests", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => success());
    const { events, ctx, store, statusValues } = harness(query);
    store.load.mockRejectedValue(new Error("invalid settings"));
    events.get("session_start")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(180000);
    expect(query).not.toHaveBeenCalled();
    expect(statusValues.at(-1)).toBe("codex settings error");
  });
});

describe("footer lifecycle", () => {
  it("stops polling when the extension context becomes stale", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => {
      throw new Error(
        "This extension ctx is stale after session replacement or reload",
      );
    });
    const { events, ctx } = harness(query);
    events.get("session_start")?.({} as never, ctx);
    await vi.advanceTimersByTimeAsync(180000);
    expect(query).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes on model changes and each minute, then stops on provider switch", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => success(10));
    const { events, ctx, rawContext, statusValues } = harness(query);
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    expect(statusValues.at(-1)).toContain("90% 5h");
    events.get("model_select")?.({ model: rawContext.model } as never, ctx);
    await flushPromises();
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS);
    expect(query).toHaveBeenCalledTimes(3);
    rawContext.model = model("other", "openai");
    events.get("model_select")?.({ model: rawContext.model } as never, ctx);
    expect(statusValues.at(-1)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS * 2);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("uses the current theme for a refreshed snapshot", async () => {
    const query = vi.fn(async () => success());
    const { events, ctx, rawContext, statusValues } = harness(query);
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    rawContext.ui.theme.fg.mockImplementation(
      (color, text) => `{${color}}${text}`,
    );
    events.get("model_select")?.({ model: rawContext.model } as never, ctx);
    await flushPromises();
    expect(query).toHaveBeenCalledTimes(2);
    expect(statusValues.at(-1)).toContain("{accent}80% 5h");
    events.get("session_shutdown")?.({} as never, ctx);
  });

  it("ignores superseded responses and aborts on shutdown", async () => {
    const pending: Array<{
      resolve: (result: QueryUsageResult) => void;
      signal: AbortSignal | undefined;
    }> = [];
    const { events, ctx, rawContext, statusValues } = harness(
      async (_ctx, options) =>
        await new Promise<QueryUsageResult>((resolve) => {
          pending.push({ resolve, signal: options.signal });
        }),
    );
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    events.get("model_select")?.({ model: rawContext.model } as never, ctx);
    await flushPromises();
    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[1]?.resolve(success(80));
    await flushPromises();
    pending[0]?.resolve(success(5));
    await flushPromises();
    expect(statusValues.at(-1)).toContain("20% 5h");
    events.get("session_shutdown")?.({} as never, ctx);
    expect(statusValues.at(-1)).toBeUndefined();
  });

  it("aborts an active query on shutdown", async () => {
    let signal: AbortSignal | undefined;
    const { events, ctx } = harness(async (_ctx, options) => {
      signal = options.signal;
      return await new Promise<QueryUsageResult>(() => undefined);
    });
    events.get("session_start")?.({} as never, ctx);
    await flushPromises();
    events.get("session_shutdown")?.({} as never, ctx);
    expect(signal?.aborted).toBe(true);
  });
});
