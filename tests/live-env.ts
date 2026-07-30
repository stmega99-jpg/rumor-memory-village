import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load .env.local for integration tests.
 *
 * Vitest does not read dotenv files into process.env, and the alternative --
 * requiring every contributor to export four variables before running the
 * suite -- is the kind of friction that ends with integration tests nobody
 * runs. Values already present in the environment win, so CI stays in control.
 */
export function loadLocalEnv(): void {
  const path = join(import.meta.dirname, "..", ".env.local");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** Integration tests are skipped, not failed, when no cluster is configured. */
export function liveDatabaseUrl(): string | undefined {
  loadLocalEnv();
  return process.env.RMV_COCKROACH_SQL_URL;
}
