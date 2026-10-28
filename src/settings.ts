import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type UsageSourcePreference = "auto" | "pi" | "codex-cli";
export interface PulseSettings {
  source: UsageSourcePreference;
  polling: boolean;
}
export const DEFAULT_SETTINGS: Readonly<PulseSettings> = Object.freeze({
  source: "auto",
  polling: true,
});

export function settingsPath(agentDir: string): string {
  return join(agentDir, "codex-pulse.json");
}

/** @throws {Error} If settings contain unknown keys or invalid values. */
export function parseSettings(value: unknown): PulseSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex Pulse settings must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "source" && key !== "polling")) {
    throw new Error("Codex Pulse settings accept only source and polling.");
  }
  const source = input.source ?? DEFAULT_SETTINGS.source;
  if (source !== "auto" && source !== "pi" && source !== "codex-cli") {
    throw new Error("Codex Pulse source must be auto, pi, or codex-cli.");
  }
  const polling = input.polling ?? DEFAULT_SETTINGS.polling;
  if (
    typeof polling !== "boolean" ||
    input.source === null ||
    input.polling === null
  ) {
    throw new Error(
      "Codex Pulse polling must be a boolean; settings cannot be null.",
    );
  }
  return { source, polling };
}

/** @throws {Error} If the file cannot be read, parsed, or validated. A missing file uses defaults. */
export async function loadSettings(path: string): Promise<PulseSettings> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_SETTINGS };
    }
    throw new Error("Cannot read Codex Pulse user settings.", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Codex Pulse user settings contain invalid JSON.");
  }
  return parseSettings(value);
}

/** @throws {Error} If validation, directory creation, writing, or atomic replacement fails. */
export async function saveSettings(
  path: string,
  settings: PulseSettings,
): Promise<void> {
  const validated = parseSettings(settings);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
