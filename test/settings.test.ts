import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
  settingsPath,
} from "../src/settings.ts";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-pulse-settings-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-scoped settings", () => {
  it("resolves only within the supplied Pi agent directory", () => {
    expect(settingsPath(join("home", "agent"))).toBe(
      join("home", "agent", "codex-pulse.json"),
    );
  });
  it("uses defaults for a missing file", async () => {
    expect(
      await loadSettings(settingsPath(await temporaryDirectory())),
    ).toEqual(DEFAULT_SETTINGS);
  });
  it.each([
    null,
    [],
    { source: "other" },
    { polling: "false" },
    { polling: null },
    { source: null },
    { poling: false },
  ])("rejects invalid settings %j", (value) => {
    expect(() => parseSettings(value)).toThrow();
  });
  it("persists preferences without tokens or usage and leaves no temporary file", async () => {
    const directory = await temporaryDirectory();
    const path = settingsPath(directory);
    await saveSettings(path, { source: "codex-cli", polling: false });
    expect(await loadSettings(path)).toEqual({
      source: "codex-cli",
      polling: false,
    });
    await saveSettings(path, { source: "pi", polling: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      source: "pi",
      polling: true,
    });
    expect(await readdir(directory)).toEqual(["codex-pulse.json"]);
  });
  it("does not echo malformed configuration contents", async () => {
    const path = settingsPath(await temporaryDirectory());
    await writeFile(path, "private-token malformed JSON");
    await expect(loadSettings(path)).rejects.toThrow("invalid JSON");
    await expect(loadSettings(path)).rejects.not.toThrow("private-token");
  });
});
