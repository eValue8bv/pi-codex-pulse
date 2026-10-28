import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { redeemReset, RedemptionUncertainError } from "../src/redeem.ts";
import type { PiCodexAuth } from "../src/query.ts";
import type { CodexUsageReport } from "../src/types.ts";
import type { UsageSourcePreference } from "../src/settings.ts";

function harness() {
  const controller = new AbortController();
  const auth: PiCodexAuth = {
    accountKey: "account-a",
    headers: {
      Authorization: "Bearer secret-token",
      "ChatGPT-Account-Id": "workspace-a",
    },
  };
  const report: CodexUsageReport = {
    source: "pi-auth",
    capturedAt: 1000,
    snapshots: [],
    resetCreditsAvailable: 2,
    resetCredits: [
      { id: "later", expiresAt: 200 },
      { id: "first", expiresAt: 100 },
    ],
  };
  const input = vi
    .fn<ExtensionContext["ui"]["input"]>()
    .mockResolvedValueOnce("y")
    .mockResolvedValueOnce("0042");
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: { input },
  } as unknown as ExtensionContext;
  const dependencies = {
    resolveAuth: vi.fn(async (): Promise<PiCodexAuth | undefined> => auth),
    query: vi.fn(async () => report),
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ code: "reset" }))),
    now: vi.fn(() => 1000),
    challenge: vi.fn(() => "0042"),
    requestId: vi.fn(() => "request-1"),
  };
  const options = {
    signal: controller.signal,
    readSource: vi.fn(async (): Promise<UsageSourcePreference> => "auto"),
    onSubmit: vi.fn(),
  };
  return {
    ctx,
    auth,
    report,
    input,
    dependencies,
    options,
    controller,
    run: () => redeemReset(ctx, options, dependencies),
  };
}

describe("Pi reset redemption", () => {
  it("confirms the account twice and sends one bound request for the earliest credit", async () => {
    const h = harness();
    expect(await h.run()).toBe("reset");
    expect(h.dependencies.query).toHaveBeenCalledTimes(2);
    expect(h.dependencies.resolveAuth).toHaveBeenCalledTimes(5);
    expect(h.input).toHaveBeenCalledTimes(2);
    for (const [title, , options] of h.input.mock.calls) {
      expect(title).toContain("workspace-a");
      expect(title).not.toContain("secret-token");
      expect(options?.signal).toBe(h.controller.signal);
    }
    expect(h.options.onSubmit).toHaveBeenCalledOnce();
    expect(h.dependencies.requestId).toHaveBeenCalledOnce();
    expect(h.dependencies.fetch).toHaveBeenCalledExactlyOnceWith(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { ...h.auth.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          redeem_request_id: "request-1",
          credit_id: "first",
        }),
      }),
    );
    expect(h.report.resetCredits?.map((credit) => credit.id)).toEqual([
      "later",
      "first",
    ]);
  });

  it.each([undefined, "n", "Y", "yes"])(
    "cancels on first answer %s",
    async (answer) => {
      const h = harness();
      h.input.mockReset().mockResolvedValue(answer);
      expect(await h.run()).toBeUndefined();
      expect(h.input).toHaveBeenCalledOnce();
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "42", "0000"])(
    "cancels on second answer %s",
    async (answer) => {
      const h = harness();
      h.input
        .mockReset()
        .mockResolvedValueOnce("y")
        .mockResolvedValueOnce(answer);
      expect(await h.run()).toBeUndefined();
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["rpc", "json", "print"])("rejects %s mode", async (mode) => {
    const h = harness();
    Object.assign(h.ctx, { mode });
    await expect(h.run()).rejects.toThrow("interactive terminal");
    expect(h.dependencies.resolveAuth).not.toHaveBeenCalled();
  });

  it("rejects a missing UI and CLI selection without resolving credentials", async () => {
    const h = harness();
    Object.assign(h.ctx, { hasUI: false });
    await expect(h.run()).rejects.toThrow("interactive terminal");
    Object.assign(h.ctx, { hasUI: true });
    h.options.readSource.mockResolvedValue("codex-cli");
    await expect(h.run()).rejects.toThrow("CLI redemption is not supported");
    expect(h.dependencies.resolveAuth).not.toHaveBeenCalled();
  });

  it.each([undefined, { headers: {} }, { accountKey: "a", headers: {} }])(
    "rejects missing or unknown identity %j",
    async (auth) => {
      const h = harness();
      h.dependencies.resolveAuth.mockResolvedValue(auth);
      await expect(h.run()).rejects.toThrow("known Pi Codex account");
      expect(h.dependencies.query).not.toHaveBeenCalled();
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, -1, NaN, Infinity, 0.5])(
    "rejects unavailable balance %s",
    async (count) => {
      const h = harness();
      if (count === undefined) {
        delete h.report.resetCreditsAvailable;
      } else {
        h.report.resetCreditsAvailable = count;
      }
      await expect(h.run()).rejects.toThrow("No available reset credits");
      expect(h.input).not.toHaveBeenCalled();
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects missing IDs and expired credits", async () => {
    const h = harness();
    h.report.resetCredits = [
      { id: " ", expiresAt: null },
      { id: "expired", expiresAt: 1 },
    ];
    await expect(h.run()).rejects.toThrow("No usable reset credit ID");
    expect(h.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("permits a credit with unknown expiry when no dated credit exists", async () => {
    const h = harness();
    h.report.resetCredits = [{ id: "unknown", expiresAt: null }];
    await h.run();
    expect(h.input.mock.calls[0]![0]).toContain("expires: unknown");
    expect(h.dependencies.fetch.mock.calls[0]![1]?.body).toContain("unknown");
  });

  it("prefers dated credits over credits with unknown expiry", async () => {
    const h = harness();
    h.report.resetCredits!.unshift({ id: "unknown", expiresAt: null });
    await h.run();
    expect(h.dependencies.fetch.mock.calls[0]![1]?.body).toContain(
      '"credit_id":"first"',
    );
  });

  it("times out while reading the write response body without retrying", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.dependencies.fetch.mockImplementation(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(stream) {
                init?.signal?.addEventListener(
                  "abort",
                  () => stream.error(new Error("aborted")),
                  { once: true },
                );
              },
            }),
          ),
      );
      const result = expect(h.run()).rejects.toBeInstanceOf(
        RedemptionUncertainError,
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await result;
      expect(h.dependencies.fetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([2, 3, 4, 5])(
    "rejects an account switch at authentication check %s",
    async (check) => {
      const h = harness();
      let calls = 0;
      h.dependencies.resolveAuth.mockImplementation(async () =>
        ++calls < check
          ? h.auth
          : {
              accountKey: "b",
              headers: {
                ...h.auth.headers,
                "ChatGPT-Account-Id": "workspace-b",
              },
            },
      );
      await expect(h.run()).rejects.toThrow("Pi account changed");
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it("uses refreshed credentials only for the same account", async () => {
    const h = harness();
    let calls = 0;
    h.dependencies.resolveAuth.mockImplementation(async () => ({
      ...h.auth,
      headers: {
        ...h.auth.headers,
        Authorization: `Bearer refreshed-${++calls}`,
      },
    }));
    await h.run();
    expect(h.dependencies.fetch.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: "Bearer refreshed-5",
    });
  });

  it.each(["source", "expiry", "removed", "changed", "empty"])(
    "rejects %s changes during confirmation",
    async (change) => {
      const h = harness();
      h.input
        .mockReset()
        .mockResolvedValueOnce("y")
        .mockImplementationOnce(async () => {
          if (change === "source") {
            h.options.readSource.mockResolvedValue("pi");
          } else if (change === "expiry") {
            h.dependencies.now.mockReturnValue(100_000);
          } else if (change === "removed") {
            h.report.resetCredits = [];
          } else if (change === "changed") {
            h.report.resetCredits![1]!.expiresAt = 300;
          } else {
            h.report.resetCreditsAvailable = 0;
          }
          return "0042";
        });
      await expect(h.run()).rejects.toThrow();
      expect(h.dependencies.fetch).not.toHaveBeenCalled();
    },
  );

  it("rechecks identity after the fresh credit query", async () => {
    const h = harness();
    h.dependencies.query
      .mockResolvedValueOnce(h.report)
      .mockImplementationOnce(async () => {
        h.dependencies.resolveAuth.mockResolvedValue(undefined);
        return h.report;
      });
    await expect(h.run()).rejects.toThrow("known Pi Codex account");
    expect(h.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("aborts during confirmation without submitting", async () => {
    const h = harness();
    h.input.mockReset().mockImplementationOnce(async () => {
      h.controller.abort();
      return "y";
    });
    await expect(h.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(h.dependencies.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["reset", "reset"],
    ["nothing_to_reset", "nothingToReset"],
    ["no_credit", "noCredit"],
    ["already_redeemed", "alreadyRedeemed"],
  ])("maps server outcome %s", async (code, outcome) => {
    const h = harness();
    h.dependencies.fetch.mockResolvedValue(
      new Response(JSON.stringify({ code })),
    );
    expect(await h.run()).toBe(outcome);
  });

  it.each(["transport", "body", "http", "unknown", "abort"])(
    "reports an uncertain %s failure without retry or secrets",
    async (failure) => {
      const h = harness();
      if (failure === "transport") {
        h.dependencies.fetch.mockRejectedValue(new Error("secret-token"));
      } else if (failure === "body") {
        h.dependencies.fetch.mockResolvedValue(new Response("secret-token"));
      } else if (failure === "http") {
        h.dependencies.fetch.mockResolvedValue(
          new Response("secret-token", { status: 500 }),
        );
      } else if (failure === "abort") {
        h.dependencies.fetch.mockImplementation(async () => {
          h.controller.abort();
          throw new Error("aborted");
        });
      } else {
        h.dependencies.fetch.mockResolvedValue(
          new Response('{"code":"surprise"}'),
        );
      }
      await expect(h.run()).rejects.toBeInstanceOf(RedemptionUncertainError);
      expect(h.dependencies.fetch).toHaveBeenCalledOnce();
      expect(h.options.onSubmit).toHaveBeenCalledOnce();
    },
  );
});
