import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  codexAuthCandidateModels,
  fetchWithTimeout,
  queryUsage,
  queryViaPiAuth,
  resolvePiCodexAuth,
} from "../src/query.ts";
import type { CodexUsageReport } from "../src/types.ts";
import { redactSensitiveText } from "../src/utils.ts";

const report: CodexUsageReport = {
  source: "pi-auth",
  capturedAt: 1,
  snapshots: [{ limitId: "codex", primary: { usedPercent: 20 } }],
};

function model(provider: string, id: string) {
  return { provider, id, name: id };
}

function contextWithRegistry(options: {
  current?: ReturnType<typeof model>;
  available?: ReturnType<typeof model>[];
  all?: ReturnType<typeof model>[];
  auth?: (candidate: ReturnType<typeof model>) => Promise<unknown>;
}): ExtensionContext {
  return {
    model: options.current,
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: false }),
      getAvailable: () => options.available ?? [],
      getAll: () => options.all ?? [],
      getApiKeyAndHeaders:
        options.auth ??
        (async () => ({ ok: false, error: "not authenticated" })),
    },
  } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.useRealTimers();
});

const resolveAuth = async () => ({ headers: { Authorization: "Bearer test" } });

describe("query fallback policy", () => {
  it("returns direct auth without starting the fallback", async () => {
    const direct = vi.fn(async () => report);
    const appServer = vi.fn(async () => ({
      ...report,
      source: "codex-app-server" as const,
    }));

    const result = await queryUsage(
      {} as ExtensionContext,
      { timeoutMs: 1000 },
      { direct, appServer, resolveAuth },
    );

    expect(result).toEqual({ ok: true, report });
    expect(direct).toHaveBeenCalledOnce();
    expect(appServer).not.toHaveBeenCalled();
  });

  it("uses CLI only when Pi authentication is absent", async () => {
    const fallbackReport: CodexUsageReport = {
      ...report,
      source: "codex-app-server",
    };
    const direct = vi.fn(async () => {
      throw new Error("direct failed");
    });
    const appServer = vi.fn(async () => fallbackReport);

    const result = await queryUsage(
      {} as ExtensionContext,
      { timeoutMs: 1000 },
      { direct, appServer, resolveAuth: async () => undefined },
    );

    expect(result).toEqual({ ok: true, report: fallbackReport });
    expect(direct).not.toHaveBeenCalled();
    expect(appServer).toHaveBeenCalledOnce();
  });

  it("redacts direct failures and refuses unverified CLI fallback", async () => {
    const direct = vi.fn(async () => {
      throw new Error("Bearer direct-secret-token");
    });
    const appServer = vi.fn(async () => {
      throw new Error('{"access_token":"fallback-secret"}');
    });

    const result = await queryUsage(
      {} as ExtensionContext,
      { timeoutMs: 1000 },
      { direct, appServer, resolveAuth },
    );

    expect(appServer).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(JSON.stringify(result.errors)).not.toContain(
        "direct-secret-token",
      );
      expect(JSON.stringify(result.errors)).not.toContain("fallback-secret");
      expect(JSON.stringify(result.errors)).toContain("<redacted>");
    }
  });
});

describe("Pi auth resolution", () => {
  it("deduplicates candidates and prioritizes the selected Codex model", () => {
    const selected = model("openai-codex", "gpt-5.3-codex");
    const fallback = model("openai-codex", "gpt-5.2-codex");
    const ctx = contextWithRegistry({
      current: selected,
      available: [selected, model("openai", "gpt-5"), fallback],
      all: [fallback, selected],
    });

    expect(
      codexAuthCandidateModels(ctx).map((candidate) => candidate.id),
    ).toEqual(["gpt-5.3-codex", "gpt-5.2-codex"]);
  });

  it("preserves account headers and creates a bearer header from apiKey", async () => {
    const selected = model("openai-codex", "codex");
    const ctx = contextWithRegistry({
      current: selected,
      auth: async () => ({
        ok: true,
        apiKey: "secret-key",
        headers: { "ChatGPT-Account-Id": "account-1" },
      }),
    });

    const auth = await resolvePiCodexAuth(ctx);

    expect(auth?.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "ChatGPT-Account-Id": "account-1",
      "User-Agent": "pi-codex-pulse",
    });
  });
});

describe("direct HTTP query", () => {
  it("keeps the deadline active while the response body is stalled", async () => {
    vi.useFakeTimers();
    const fakeFetch: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        }),
      );
    const pending = fetchWithTimeout(
      "https://example.test",
      {},
      1000,
      undefined,
      fakeFetch,
    );
    const expectation = expect(pending).rejects.toThrow("Timed out after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });

  it("cancels body reads when the caller aborts", async () => {
    const controller = new AbortController();
    const fakeFetch: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                stream.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        }),
      );
    const pending = fetchWithTimeout(
      "https://example.test",
      {},
      1000,
      controller.signal,
      fakeFetch,
    );
    const expectation = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    controller.abort();
    await expectation;
  });

  it("normalizes a successful response and passes resolved auth headers", async () => {
    const selected = model("openai-codex", "codex");
    const ctx = contextWithRegistry({
      current: selected,
      auth: async () => ({
        ok: true,
        headers: { Authorization: "Bearer private" },
      }),
    });
    const fakeFetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method ?? "GET").toBe("GET");
        expect(init?.body).toBeUndefined();
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer private",
        );
        if (String(url).endsWith("/rate-limit-reset-credits")) {
          return new Response(
            JSON.stringify({
              credits: [
                {
                  id: "reset-early",
                  status: "available",
                  expires_at: "2030-01-10T00:00:00Z",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 33,
                limit_window_seconds: 18_000,
              },
            },
            rate_limit_reset_credits: { available_count: 2 },
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const result = await queryViaPiAuth(ctx, 1000, undefined, fakeFetch);

    expect(result.planType).toBe("plus");
    expect(result.resetCreditsAvailable).toBe(2);
    expect(result.resetCredits).toEqual([
      {
        id: "reset-early",
        expiresAt: Date.parse("2030-01-10T00:00:00Z") / 1000,
      },
    ]);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.snapshots[0]?.primary?.usedPercent).toBe(33);
  });

  it("keeps usage when optional reset-credit details are unavailable", async () => {
    const ctx = contextWithRegistry({
      current: model("openai-codex", "codex"),
      auth: async () => ({
        ok: true,
        headers: { Authorization: "Bearer private" },
      }),
    });
    const fakeFetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          String(url).endsWith("/usage")
            ? JSON.stringify({
                rate_limit_reset_credits: { available_count: 1 },
              })
            : "unavailable",
          { status: String(url).endsWith("/usage") ? 200 : 403 },
        ),
    ) as unknown as typeof fetch;
    const result = await queryViaPiAuth(ctx, 1000, undefined, fakeFetch);
    expect(result.resetCreditsAvailable).toBe(1);
    expect(result.resetCredits).toBeUndefined();
  });

  it("redacts secrets from HTTP error bodies", async () => {
    const ctx = contextWithRegistry({
      current: model("openai-codex", "codex"),
      auth: async () => ({
        ok: true,
        headers: { Authorization: "Bearer private" },
      }),
    });
    const fakeFetch = vi.fn(
      async () =>
        new Response('Bearer leaked-token {"access_token":"also-leaked"}', {
          status: 401,
          statusText: "Unauthorized",
        }),
    ) as unknown as typeof fetch;

    await expect(
      queryViaPiAuth(ctx, 1000, undefined, fakeFetch),
    ).rejects.toThrow(/Bearer <redacted>/);
    await expect(
      queryViaPiAuth(ctx, 1000, undefined, fakeFetch),
    ).rejects.not.toThrow(/also-leaked|leaked-token/);
  });

  it("aborts a fetch after its timeout", async () => {
    vi.useFakeTimers();
    const hangingFetch = vi.fn(
      async (
        _url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;

    const pending = fetchWithTimeout(
      "https://example.test",
      {},
      1000,
      undefined,
      hangingFetch,
    );
    const expectation = expect(pending).rejects.toThrow("Timed out after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
  });
});

describe("secret redaction", () => {
  it("redacts bearer, token JSON, and OpenAI API-key patterns", () => {
    const redacted = redactSensitiveText(
      'Bearer abc.def {"refresh_token":"refresh-secret"} api_key=plain-secret sk-supersecret123',
    );
    expect(redacted).not.toMatch(
      /abc\.def|refresh-secret|plain-secret|sk-supersecret123/,
    );
    expect(redacted.match(/<redacted>/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
