import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { queryViaCodexAppServer } from "../src/app-server.ts";

describe("Codex CLI process transport", () => {
  it("resolves a PATH executable including Windows cmd shims and sends read-only RPCs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pulse cli space "));
    const log = join(directory, "calls.jsonl");
    const script = `
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' } };
  if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
lines.on('close', () => process.exit(0));
`;
    try {
      await writeFile(join(directory, "server.cjs"), script);
      if (process.platform === "win32") {
        await writeFile(
          join(directory, "codex.cmd"),
          `@"${process.execPath}" "%~dp0server.cjs" %*\r\n`,
        );
      } else {
        await writeFile(
          join(directory, "codex"),
          `#!${process.execPath}\n${script}`,
        );
        await chmod(join(directory, "codex"), 0o755);
      }
      vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`);
      const report = await queryViaCodexAppServer(5000);
      expect(report.source).toBe("codex-app-server");
      expect(report.snapshots[0]?.primary?.usedPercent).toBe(25);
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string });
      expect(calls.map((call) => call.method)).toEqual([
        "initialize",
        "initialized",
        "account/read",
        "account/rateLimits/read",
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }, 15000);
});
