import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  queryUsage,
  resolvePiCodexAuth,
  type PiCodexAuth,
} from "../src/query.ts";
import type { CodexUsageReport } from "../src/types.ts";

const ctx = {} as ExtensionContext;
const report: CodexUsageReport = {
  source: "pi-auth",
  capturedAt: 1,
  snapshots: [],
};
const auth: PiCodexAuth = {
  headers: { Authorization: "Bearer private" },
  accountKey: "account-a",
};
const failedDirect = async (): Promise<CodexUsageReport> => {
  throw new Error("offline");
};

function registry(credentials: unknown, configured = true): ExtensionContext {
  return {
    model: { provider: "openai-codex", id: "test" },
    modelRegistry: {
      getAvailable: () => [],
      getAll: () => [],
      getProviderAuthStatus: () => ({ configured }),
      getApiKeyAndHeaders: async () => credentials,
    },
  } as unknown as ExtensionContext;
}

describe("account-bound queries", () => {
  it("returns a binding only for the same account before and after the request", async () => {
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000 },
      { resolveAuth: async () => auth, direct: async () => report },
    );
    expect(result).toEqual({ ok: true, report, accountKey: "account-a" });
  });

  it("rejects an account change during a successful request", async () => {
    const resolveAuth = vi
      .fn()
      .mockResolvedValueOnce(auth)
      .mockResolvedValue({ ...auth, accountKey: "account-b" });
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000 },
      { resolveAuth, direct: async () => report },
    );
    expect(result.ok).toBe(false);
    expect(result.accountKey).toBeUndefined();
  });

  it("allows stale retention only after confirming the same account on failure", async () => {
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000 },
      { resolveAuth: async () => auth, direct: failedDirect },
    );
    expect(result).toMatchObject({ ok: false, accountKey: "account-a" });
  });

  it.each([undefined, { ...auth, accountKey: "account-b" }])(
    "clears the binding if authentication changes: %s",
    async (current) => {
      const resolveAuth = vi
        .fn()
        .mockResolvedValueOnce(auth)
        .mockResolvedValue(current);
      const result = await queryUsage(
        ctx,
        { timeoutMs: 1000 },
        { resolveAuth, direct: failedDirect },
      );
      expect(result.accountKey).toBeUndefined();
    },
  );

  it("does not switch to CLI when Pi credentials cannot be resolved", async () => {
    const appServer = vi.fn(async () => report);
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000 },
      {
        resolveAuth: async () => {
          throw new Error("refresh failed");
        },
        appServer,
      },
    );
    expect(result.ok).toBe(false);
    expect(appServer).not.toHaveBeenCalled();
  });

  it("honours explicit CLI selection without reading Pi credentials", async () => {
    const resolveAuth = vi.fn(async () => auth);
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000, source: "codex-cli" },
      {
        resolveAuth,
        appServer: async () => ({ ...report, source: "codex-app-server" }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.accountKey).toBeUndefined();
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("does not fall back when Pi-only mode has no credentials", async () => {
    const appServer = vi.fn(async () => report);
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000, source: "pi" },
      { resolveAuth: async () => undefined, appServer },
    );
    expect(result.ok).toBe(false);
    expect(appServer).not.toHaveBeenCalled();
  });

  it("rejects automatic CLI output when a Pi login appears during the request", async () => {
    const resolveAuth = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(auth);
    const result = await queryUsage(
      ctx,
      { timeoutMs: 1000 },
      { resolveAuth, appServer: async () => report },
    );
    expect(result.ok).toBe(false);
    expect(result.accountKey).toBeUndefined();
  });

  it("propagates caller cancellation without fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    const appServer = vi.fn(async () => report);
    await expect(
      queryUsage(
        ctx,
        { timeoutMs: 1000, signal: controller.signal },
        { appServer },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(appServer).not.toHaveBeenCalled();
  });
});

describe("Pi identity", () => {
  it("derives a cache binding from the request account header, excluding null headers", async () => {
    const result = await resolvePiCodexAuth(
      registry({
        ok: true,
        apiKey: "token",
        headers: { "chatgpt-account-id": "workspace-a", ignored: null },
      }),
    );
    expect(result?.accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.headers.ignored).toBeUndefined();
    expect(result?.accountKey).not.toContain("workspace-a");
  });

  it("uses the Codex JWT account claim when no account header is supplied", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "workspace-a" },
      }),
    ).toString("base64url");
    const result = await resolvePiCodexAuth(
      registry({ ok: true, apiKey: `header.${payload}.signature` }),
    );
    expect(result?.headers["ChatGPT-Account-Id"]).toBe("workspace-a");
    expect(result?.accountKey).toBeDefined();
  });

  it("does not guess an identity from opaque tokens", async () => {
    const result = await resolvePiCodexAuth(
      registry({ ok: true, apiKey: "opaque" }),
    );
    expect(result?.accountKey).toBeUndefined();
  });

  it("does not treat configured but unavailable credentials as absent", async () => {
    await expect(resolvePiCodexAuth(registry({ ok: true }))).rejects.toThrow(
      "configured but unavailable",
    );
    await expect(
      resolvePiCodexAuth(registry({ ok: true }, false)),
    ).resolves.toBeUndefined();
  });

  it("does not try another model after the selected model fails authentication", async () => {
    const context = registry({ ok: false, error: "refresh failed" });
    const method = vi.spyOn(context.modelRegistry, "getApiKeyAndHeaders");
    await expect(resolvePiCodexAuth(context)).rejects.toThrow("refresh failed");
    expect(method).toHaveBeenCalledOnce();
  });
});
