import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

import { normalizeAppServerResponse } from "./normalize.ts";
import type { AppServerRateLimitResponse, CodexUsageReport } from "./types.ts";
import {
  abortError,
  assertObject,
  formatTimeoutSeconds,
  redactErrorBody,
  redactSensitiveText,
  throwIfAborted,
  truncateEnd,
} from "./utils.ts";

const MAX_STDERR_CHARS = 600;
const FORCE_KILL_DELAY_MS = 250;

type SpawnCodex = () => ChildProcessWithoutNullStreams;

interface RpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export async function queryViaCodexAppServer(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CodexUsageReport> {
  const client = new CodexAppServerClient(timeoutMs, signal);
  try {
    await initializeClient(client);
    const account = assertObject(
      await client.request("account/read", { refreshToken: false }),
      "account/read result",
    );
    const identity = assertObject(account.account, "Codex CLI account");
    if (identity.type !== "chatgpt") {
      throw new Error(
        "Codex CLI needs a ChatGPT login for subscription usage. Run codex login.",
      );
    }
    const result = await client.request("account/rateLimits/read", undefined);
    return normalizeAppServerResponse(
      assertObject(
        result,
        "account/rateLimits/read result",
      ) as AppServerRateLimitResponse,
      Date.now(),
    );
  } finally {
    client.dispose();
  }
}

async function initializeClient(client: CodexAppServerClient): Promise<void> {
  await client.start();
  await client.request("initialize", {
    clientInfo: {
      name: "pi_codex_pulse",
      title: "Pi Codex Pulse",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: [],
    },
  });
  client.notify("initialized");
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private startupReject: ((error: Error) => void) | undefined;
  private exitError?: Error;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly spawnCodex: SpawnCodex;
  private readonly handleAbort = (): void => {
    const error = abortError(this.signal?.reason);
    this.startupReject?.(error);
    this.rejectAll(error);
    this.dispose();
  };

  constructor(
    timeoutMs: number,
    signal?: AbortSignal,
    spawnCodex?: SpawnCodex,
  ) {
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.spawnCodex =
      spawnCodex ??
      (() =>
        spawn("codex", ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }) as ChildProcessWithoutNullStreams);
    signal?.addEventListener("abort", this.handleAbort, { once: true });
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    throwIfAborted(this.signal);
    if (this.disposed)
      return Promise.reject(new Error("codex app-server client is disposed."));

    this.startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnCodex();
      } catch (error) {
        reject(
          new Error(
            `Failed to start codex app-server: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          ),
        );
        return;
      }
      this.child = child;
      child.stdin.on("error", (error: Error) => {
        const failure = new Error(
          `Codex app-server input failed: ${redactSensitiveText(error.message)}`,
        );
        this.exitError = failure;
        this.startupReject?.(failure);
        this.rejectAll(failure);
      });

      let settled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimeout);
        this.startupReject = undefined;
        resolve();
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimeout);
        this.startupReject = undefined;
        reject(error);
      };

      const startupTimeout = setTimeout(() => {
        settleReject(
          new Error(
            `Timed out after ${formatTimeoutSeconds(this.timeoutMs)} starting codex app-server.`,
          ),
        );
      }, this.timeoutMs);
      startupTimeout.unref?.();
      this.startupReject = settleReject;

      child.once("spawn", settleResolve);
      child.once("error", (error) => {
        const wrapped = new Error(
          `Failed to start codex app-server: ${redactSensitiveText(error.message)}`,
        );
        settleReject(wrapped);
        this.exitError = wrapped;
        this.rejectAll(wrapped);
      });
      child.once("exit", (code, exitSignal) => {
        clearTimeout(startupTimeout);
        if (this.disposed) return;
        const suffix = this.stderr
          ? ` stderr: ${redactErrorBody(this.stderr)}`
          : "";
        const error = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${exitSignal ?? "none"}).${suffix}`,
        );
        this.exitError = error;
        settleReject(error);
        this.rejectAll(error);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string | Buffer) => {
        this.stderr = truncateEnd(
          this.stderr + String(chunk),
          MAX_STDERR_CHARS,
        );
      });

      this.lines = createInterface({ input: child.stdout });
      this.lines.on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    throwIfAborted(this.signal);
    const child = this.child;
    if (this.disposed || !child?.stdin.writable) {
      return Promise.reject(new Error("codex app-server is not running."));
    }
    if (this.exitError) return Promise.reject(this.exitError);

    const id = this.nextId++;
    const payload =
      params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${formatTimeoutSeconds(this.timeoutMs)} waiting for ${method}.`,
          ),
        );
      }, this.timeoutMs);
      timeout.unref?.();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(
        new Error(
          `Failed to write ${method} request: ${redactSensitiveText(error.message)}`,
        ),
      );
    });
    return response;
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (this.disposed || !child?.stdin.writable) return;
    const payload = params === undefined ? { method } : { method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.handleAbort);
    this.startupReject = undefined;

    this.rejectAll(new Error("codex app-server request cancelled."));
    this.lines?.close();
    this.lines = undefined;

    const child = this.child;
    this.child = undefined;
    if (!child) return;

    if (child.stdin.writable) {
      child.stdin.end();
    }
    // A Windows npm shim owns a process tree. Let EOF stop it before force-killing
    // the tree; killing cmd.exe alone can orphan the actual app-server.
    if (process.platform !== "win32" && !child.killed) {
      child.kill("SIGTERM");
    }
    const forceKill = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.on("error", () => {
          child.kill("SIGKILL");
        });
        killer.on("exit", (code) => {
          if (code !== 0) {
            child.kill("SIGKILL");
          }
        });
      } else {
        child.kill("SIGKILL");
      }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
    child.once("exit", () => clearTimeout(forceKill));
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof parsed.id !== "number"
    ) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message =
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "unknown error";
      const code =
        typeof parsed.error.code === "number" ||
        typeof parsed.error.code === "string"
          ? ` (${parsed.error.code})`
          : "";
      pending.reject(
        new Error(
          `codex app-server request failed${code}: ${redactSensitiveText(message)}`,
        ),
      );
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
