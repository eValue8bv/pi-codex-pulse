import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/app-server.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  });
}

function createClient(timeoutMs = 1000, signal?: AbortSignal) {
  const child = new FakeChild();
  const client = new CodexAppServerClient(
    timeoutMs,
    signal,
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  return { child, client };
}

async function startClient(
  child: FakeChild,
  client: CodexAppServerClient,
): Promise<void> {
  const started = client.start();
  child.emit("spawn");
  await started;
}

function captureInput(child: FakeChild): { read: () => string } {
  let input = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  return { read: () => input };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexAppServerClient", () => {
  it("ignores malformed response lines without crashing", async () => {
    const { child, client } = createClient();
    await startClient(child, client);
    for (const line of ["null", "[]", "not-json", "42"]) {
      expect(() => child.stdout.write(`${line}\n`)).not.toThrow();
    }
    client.dispose();
  });

  it("handles stdin errors as request failures", async () => {
    const { child, client } = createClient();
    await startClient(child, client);
    const pending = client.request("account/read", {});
    const expectation = expect(pending).rejects.toThrow("input failed");
    child.stdin.emit("error", new Error("EPIPE"));
    await expectation;
    client.dispose();
  });

  it("matches JSON-RPC responses to requests and sends notifications", async () => {
    const { child, client } = createClient();
    const input = captureInput(child);
    await startClient(child, client);

    const pending = client.request("initialize", { capabilities: {} });
    await vi.waitFor(() =>
      expect(input.read()).toContain('"method":"initialize"'),
    );
    const request = JSON.parse(input.read().trim().split("\n")[0] ?? "{}") as {
      id: number;
    };
    child.stdout.write(
      `${JSON.stringify({ id: request.id, result: { ready: true } })}\n`,
    );

    await expect(pending).resolves.toEqual({ ready: true });
    client.notify("initialized");
    expect(input.read()).toContain('"method":"initialized"');
    client.dispose();
    expect(child.stdin.writableEnded).toBe(true);
    if (process.platform !== "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("redacts RPC errors", async () => {
    const { child, client } = createClient();
    const input = captureInput(child);
    await startClient(child, client);

    const pending = client.request("account/rateLimits/read", undefined);
    await vi.waitFor(() =>
      expect(input.read()).toContain("account/rateLimits/read"),
    );
    const request = JSON.parse(input.read().trim()) as { id: number };
    child.stdout.write(
      `${JSON.stringify({
        id: request.id,
        error: { code: -32603, message: "Bearer rpc-secret-token" },
      })}\n`,
    );

    await expect(pending).rejects.toThrow(/Bearer <redacted>/);
    client.dispose();
  });

  it("times out pending requests and removes them", async () => {
    vi.useFakeTimers();
    const { child, client } = createClient(500);
    await startClient(child, client);

    const pending = client.request("account/rateLimits/read", undefined);
    const expectation = expect(pending).rejects.toThrow(
      "Timed out after 0.5s waiting for account/rateLimits/read",
    );
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    client.dispose();
  });

  it("times out startup", async () => {
    vi.useFakeTimers();
    const { client } = createClient(250);

    const pending = client.start();
    const expectation = expect(pending).rejects.toThrow(
      "Timed out after 0.3s starting codex app-server",
    );
    await vi.advanceTimersByTimeAsync(250);
    await expectation;
    client.dispose();
  });

  it("rejects pending work and terminates the child on disposal", async () => {
    const { child, client } = createClient();
    await startClient(child, client);
    const pending = client.request("account/rateLimits/read", undefined);

    client.dispose();

    await expect(pending).rejects.toThrow("cancelled");
    expect(child.stdin.writableEnded).toBe(true);
    if (process.platform !== "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  it("includes truncated, redacted stderr when the child exits", async () => {
    const { child, client } = createClient();
    await startClient(child, client);
    const pending = client.request("account/rateLimits/read", undefined);
    child.stderr.write(`Bearer stderr-secret ${"x".repeat(1000)}`);
    child.emit("exit", 1, null);

    let message = "";
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Bearer <redacted>");
    expect(message).not.toContain("stderr-secret");
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(800);
    client.dispose();
  });

  it("aborts startup and pending work from the caller signal", async () => {
    const controller = new AbortController();
    const { child, client } = createClient(1000, controller.signal);
    await startClient(child, client);
    const pending = client.request("account/rateLimits/read", undefined);

    controller.abort();

    await expect(pending).rejects.toThrow(/aborted|cancel/i);
    expect(child.stdin.writableEnded).toBe(true);
  });
});
