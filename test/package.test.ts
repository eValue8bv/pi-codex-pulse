import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const cli = join(dirname(hostEntry), "cli.js");

describe("Pi package", () => {
  it("installs, loads the manifest, and removes in an isolated agent directory", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pulse-install-"));
    const agentDir = join(temporary, "agent");
    const cwd = join(temporary, "project");
    await mkdir(cwd);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    const run = (args: string[]) => {
      const result = spawn.sync(process.execPath, [cli, ...args], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30000,
      });
      expect(result.error ?? undefined).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
    };
    try {
      run(["install", root]);
      run(["install", root]);
      const configured = JSON.parse(
        await readFile(join(agentDir, "settings.json"), "utf8"),
      ) as { packages: string[] };
      expect(configured.packages).toHaveLength(1);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(1);
      expect([...loaded.extensions[0]!.commands.keys()]).toEqual([
        "codex-usage",
      ]);
      expect(loaded.extensions[0]!.tools.size).toBe(0);
      run(["remove", root]);
      const removed = JSON.parse(
        await readFile(join(agentDir, "settings.json"), "utf8"),
      ) as { packages?: string[] };
      expect(removed.packages ?? []).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 90000);

  it("packages only runtime source, metadata, README and license", () => {
    const result = spawn.sync(
      "npm",
      ["pack", "--dry-run", "--ignore-scripts", "--json"],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const packages = JSON.parse(result.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const files = packages[0]!.files.map((file) => file.path);
    expect(files).toContain("extensions/codex-usage.ts");
    expect(files).toContain("src/settings.ts");
    expect(files).toContain("LICENSE");
    expect(
      files.every((file) =>
        /^(extensions\/|src\/|package\.json$|README\.md$|LICENSE$)/.test(file),
      ),
    ).toBe(true);
  }, 30000);
});
