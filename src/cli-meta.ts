/**
 * `inarch version` / `inarch --version` support.
 *
 * Split out of cli.ts so the formatting helper can be unit-tested without
 * spawning the CLI.
 *
 * There is no `upgrade` command and no registry lookup. Inarch installs from a
 * git tag, so "the latest version" is a question npm cannot answer about it —
 * and the inherited implementation asked npm about `@nanonets/graft`, which
 * would have upgraded a user onto a different program.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_NAME = "inarch";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** Reads the version of the package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Pure formatter for `inarch version` — no I/O, easy to unit-test. */
export function formatVersionReport(current: string): string {
  return `${PKG_NAME} ${current}`;
}
