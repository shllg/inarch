/**
 * Self-maintenance: keeping the wiring an installed graft wrote current.
 *
 * `inarch init` copies hooks, shims, skill text and rule files INTO the repo.
 * Replacing the binary touches none of them, so a repo wired by 0.7 keeps 0.7's
 * prompts and 0.7's hook timeouts forever (see the comment on
 * `promptAskTimeout`, which exists only to work around exactly this). A version
 * stamp written next to the graph lets any entry point notice the skew and
 * re-run the writes.
 *
 * Everything here is fail-soft by construction: it runs inside hooks and inside
 * the MCP server's boot path, where a throw is a broken session. It touches no
 * network at all — the registry check that used to live here is gone with the
 * rest of the upgrade nag.
 *
 * Called from all three hosts' entry points so no editor is left out:
 *   • Claude Code   — `session-start` hook (src/claude/hooks.ts)
 *   • Cursor/Codex  — MCP server boot (src/mcp/server.ts), and any CLI command
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, cacheDir } from './util/state.js';
import { HOSTS } from './hosts/registry.js';
import { START } from './hosts/sections.js';
import { readCurrentVersion } from './cli-meta.js';

/**
 * The version of the graft package this code was loaded from.
 *
 * Resolved from *this* module rather than the caller's: `readCurrentVersion`
 * looks one level up from the module URL it's given, which lands on the package
 * root for `dist/upkeep.js` but misses entirely for `dist/claude/hooks.js` and
 * `dist/mcp/server.js`. Every caller asking here instead of passing its own
 * `import.meta.url` is what keeps the hook and the MCP server from reading
 * `0.0.0` and re-initing on every single session.
 */
export function runningVersion(): string {
  try { return readCurrentVersion(import.meta.url); } catch { return '0.0.0'; }
}

/* -------------------------------------------------------------------------- */
/* the wiring stamp                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `inarch init`'s flags a refresh has to replay.
 *
 * Without these, an auto-refresh would install things the user explicitly
 * declined: someone who ran `inarch init --no-global` (or `--no-hooks`, or
 * `--no-statusline`) said "keep out of `~/.codex`" / "leave my statusline
 * alone", and a later session silently writing there would be graft overriding a
 * decision rather than maintaining one. Absent from an older stamp → all true,
 * which is what plain `inarch init` does.
 */
export interface WiringOpts {
  /** false → never write outside the repo (`--no-global`). */
  global: boolean;
  /** false → skip MCP server registration (`--no-mcp`). */
  mcp: boolean;
  /** false → skip hook installation (`--no-hooks`). */
  hooks: boolean;
  /** false → skip Claude Code statusLine (`--no-statusline` / GRAFT_NO_STATUSLINE). */
  statusline: boolean;
}

export const DEFAULT_WIRING_OPTS: WiringOpts = { global: true, mcp: true, hooks: true, statusline: true };

/** An older stamp has no `opts`; a plain `inarch init` wired everything. */
export function wiringOpts(stamp: WiringStamp | null): WiringOpts {
  return { ...DEFAULT_WIRING_OPTS, ...(stamp?.opts ?? {}) };
}

export interface WiringStamp {
  /** The inarch version whose `init` wrote this repo's agent files. */
  version: string;
  /** Host ids that were wired, so a refresh re-writes exactly those and never
   * silently adopts an agent the user declined in the picker. */
  hosts: string[];
  /** The init flags to replay — see {@link WiringOpts}. */
  opts?: Partial<WiringOpts>;
  at: string;
}

/** Under `graft/.cache/`, beside the other derived state: git-ignored, per-clone,
 * and cheap to lose — a missing stamp just means one idempotent refresh. */
export function stampPath(repo: string): string {
  return join(cacheDir(repo), 'wiring-stamp.json');
}

export function readStamp(repo: string): WiringStamp | null {
  return readJson<WiringStamp>(stampPath(repo));
}

export function writeStamp(
  repo: string,
  version: string,
  hosts: string[],
  opts: Partial<WiringOpts> = {},
  at = new Date().toISOString(),
): void {
  try {
    writeJsonAtomic(stampPath(repo), {
      version,
      hosts: [...hosts].sort(),
      opts: { ...DEFAULT_WIRING_OPTS, ...opts },
      at,
    } satisfies WiringStamp);
  } catch { /* unwritable graft/ — a refresh will just be retried next session */ }
}

/**
 * Which agents this repo is *already* wired for, read off disk rather than
 * re-detected. Detection answers "which editors does this machine have"; for a
 * refresh we need "which files did a previous init actually write" — otherwise
 * installing Windsurf once would silently add graft rules to every repo.
 */
export function wiredHostIds(repo: string): string[] {
  const ids: string[] = [];
  if (existsSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'))) ids.push('claude');
  for (const host of HOSTS) {
    const path = join(repo, host.relPath);
    if (!existsSync(path)) continue;
    // A shared file (AGENTS.md, GEMINI.md) counts only if graft's fenced section
    // is in it — the user may own the file for entirely unrelated reasons.
    if (host.kind === 'section') {
      try { if (!readFileSync(path, 'utf8').includes(START)) continue; } catch { continue; }
    }
    ids.push(host.id);
  }
  return ids;
}

export interface WiringRefresh {
  from: string;
  to: string;
  hosts: string[];
  /** True when the refresh included writes outside the repo (`~/.codex/`), so the
   * caller can say so — a session changing machine-wide config should be visible. */
  global: boolean;
}

/**
 * Re-run init's writes when the stamp and the running binary disagree.
 *
 * Deliberately narrow: it refreshes the hosts already wired, replays the flags
 * that init was given, never builds the graph (this runs at session start — a
 * rebuild there would stall the agent's first turn), and no-ops when the repo has
 * no graft wiring at all.
 */
export function reconcileWiring(
  repo: string,
  current: string,
  deps: {
    wired?: (repo: string) => string[];
    rewrite: (repo: string, hosts: string[], opts: WiringOpts) => void;
  },
): WiringRefresh | null {
  try {
    const stamp = readStamp(repo);
    if (stamp && stamp.version === current) return null;
    // The stamp is the record of *intent* (what the picker chose); disk is the
    // fallback for repos wired before stamps existed. Union, not just disk:
    // otherwise a host whose rule file went missing — deleted by hand, lost to a
    // merge, or clobbered by another tool — is silently dropped from every future
    // refresh, and that file is precisely what a refresh exists to restore.
    const onDisk = (deps.wired ?? wiredHostIds)(repo);
    const hosts = [...new Set([...(stamp?.hosts ?? []), ...onDisk])].sort();
    if (hosts.length === 0) return null; // never wired here — not our business
    const opts = wiringOpts(stamp);
    deps.rewrite(repo, hosts, opts);
    writeStamp(repo, current, hosts, opts);
    return { from: stamp?.version ?? 'unwired', to: current, hosts, global: opts.global };
  } catch {
    return null; // a refresh is an optimization; never fail the caller over it
  }
}

export function formatWiringRefresh(r: WiringRefresh | null): string | null {
  if (!r) return null;
  // Name the out-of-repo writes explicitly: those are machine-wide and shared by
  // every repo, so a user seeing this line should not have to guess what moved.
  const scope = r.global && r.hosts.includes('agents') ? " (including this machine's ~/.codex config)" : '';
  return `· graft refreshed this repo's agent wiring${scope} (written by ${r.from}, now ${r.to}): ${r.hosts.join(', ')}.`;
}
