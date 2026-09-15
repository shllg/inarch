/**
 * The cheap "has the working tree moved?" probe that gates the pre-query rebuild.
 *
 * Every graft retrieval call runs this, so it has to be ~free on the common
 * unchanged path: a walk + one `stat` per source file, no reads, no parsing.
 * Measured at ~3ms for 280 files. Only files whose `(size, mtimeMs)` disagree
 * with the last build's record get read and hashed, which is what keeps a `touch`
 * or a `git checkout` of identical bytes from triggering a pointless rebuild.
 *
 * Approved extension snapshots are the exception: their readable data inputs
 * are byte-hashed separately, including files outside the parsed source set.
 *
 * Git supplies the visible file set (`tracked + untracked - ignored`) when
 * available, but drift is still measured against bytes in the working tree:
 * an uncommitted, staged, or committed edit to an indexed file looks the same.
 *
 * `<outDir>/.cache/fingerprint.json` is a projection of the extraction cache
 * (`extract-cache.ts`) minus the parse results, written by the same build. Keeping
 * it separate means the probe reads ~10KB instead of the multi-MB parse cache. The
 * two can only ever disagree by one sidecar going missing, and both directions
 * degrade safely: no fingerprint → "unknown, rebuild"; no parse cache → the
 * rebuild is just cold.
 */
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { CACHE_DIR } from "../context/node-file.js";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
import { extractorStamp, pruneSidecars, type ExtractEntry } from "./extract-cache.js";
import { listSourceStats } from "./source-files.js";
import { RAILS_WITNESS_FILES } from "./zeitwerk.js";

const RESOLVER_WITNESS_FILES = [...RAILS_WITNESS_FILES, "Gemfile.lock", "gems.locked"] as const;
import { extensionExecutionStamp, extensionFingerprint, RUN_REASON_CODES, type ExtensionRun } from "./extensions.js";
import { extensionInputFingerprint, extensionOutputExclusions } from "./extension-runtime.js";
import { loadGraphCached } from "./load.js";

export const FINGERPRINT_PREFIX = "fingerprint";
const FINGERPRINT_VERSION = 1;

/** The identity this graft's prints are filed under. Unlike the extract memo, a
 * missing extractor identity is *not* disqualifying here: freshness is a claim about
 * source bytes, and a build with no memo is merely cold, never wrong. So stamp what
 * we can and fall back to a shared bucket. */
function stamp(): string {
  return extractorStamp() ?? "nostamp";
}

/** `[size, mtimeMs, hash]` — positional to keep the file small. */
type Print = [number, number, string];

export interface Fingerprint {
  version: number;
  /** The extractor that produced the graph these prints describe — the same stamp
   * `extract.json` carries. Without it the two sidecars can disagree about whether
   * the graph is current: an extractor change correctly drops every memo entry,
   * yet the prints still match the tree byte-for-byte, so the probe would report
   * clean and queries would keep answering from nodes the old extractor built. */
  extractor: string;
  files: Record<string, Print>;
  /** Repo-relative directory prefixes this build was limited to (`--only-dir`).
   * Absent = full tree. Recorded here — not in the source repo's `.graft/config.json`
   * — so the query-path freshness probe (which never sees a CLI flag) enumerates the
   * identical whitelisted set and excluded files are never phantom "added" drift. */
  onlyDirs?: string[];
  /** Local grants and package integrity also determine the graph's edge set. */
  extensions?: string;
  /** Every complete host-captured source view, including failed executions.
   * Incomplete captures have no contributed edges and are tracked in extensionBuild. */
  extensionInputs?: string[];
  extensionInputExclusions?: string[];
  /** Source freshness does not certify execution: unavailable isolation still
   * produces a current core graph, with no extension contribution. */
  extensionBuild?: {
    stamp: string;
    attemptedAt: number;
    runs: Array<Pick<ExtensionRun, "id" | "digest" | "status" | "reasonCode" | "inputFingerprint">>;
  };
}

export interface ExtensionHealth {
  ok: boolean;
  issues: Array<{ id: string; reasonCode: string }>;
  /** Earliest automatic retry; absent means a build/input/approval change is needed. */
  retryAt?: number;
}

const EXTENSION_RETRY_MS = 60_000;
const RETRYABLE_EXTENSION_REASONS = new Set(["isolation-unavailable", "timeout", "runtime-error", "source-limit", "context-too-large", "audit-error", "registry-error", "build-budget-exhausted", "validation-budget-exhausted"]);

/** An empty input-stamp list used to make a skipped extension permanently look
 * current. Keep execution health separate from source drift, with a disk-backed
 * cooldown so separate CLI processes cannot rebuild on every failed query. */
export function extensionHealth(fingerprint: Fingerprint | null): ExtensionHealth {
  if (!fingerprint?.extensions && !fingerprint?.extensionBuild) return { ok: true, issues: [] };
  const unknown = (): ExtensionHealth => ({ ok: false, issues: [{ id: "registry", reasonCode: "build-status-unknown" }], retryAt: 0 });
  const build = fingerprint.extensionBuild;
  if (!build || !Number.isSafeInteger(build.attemptedAt) || build.attemptedAt < 0
    || !Array.isArray(build.runs) || build.runs.length > 8 || (!build.runs.length && fingerprint.extensions)) return unknown();
  const ids = new Set<string>();
  const issues: ExtensionHealth["issues"] = [];
  for (const run of build.runs) {
    if (!run || typeof run !== "object" || typeof run.id !== "string" || ids.has(run.id)
      || !(run.id === "registry" ? run.digest === "" : /^[a-f0-9]{64}$/.test(run.id) && typeof run.digest === "string" && /^[a-f0-9]{64}$/.test(run.digest))
      || !["ok", "failed", "skipped"].includes(run.status)
      || (run.reasonCode !== undefined && !RUN_REASON_CODES.includes(run.reasonCode))
      || (run.inputFingerprint !== undefined && (typeof run.inputFingerprint !== "string"
        || !(run.inputFingerprint === "unavailable" || /^[a-f0-9]{64}$/.test(run.inputFingerprint))))) return unknown();
    ids.add(run.id);
    if (run.status !== "ok" || run.reasonCode) issues.push({ id: run.id, reasonCode: run.reasonCode ?? "legacy-failure" });
  }
  if (typeof build.stamp !== "string" || build.stamp !== extensionExecutionStamp(fingerprint.extensions ?? "", build.runs)) return unknown();
  const retry = issues.some(issue => RETRYABLE_EXTENSION_REASONS.has(issue.reasonCode));
  return { ok: issues.length === 0, issues, ...(retry ? { retryAt: build.attemptedAt + EXTENSION_RETRY_MS } : {}) };
}

export function extensionHealthNote(health: ExtensionHealth): string | undefined {
  if (health.ok) return undefined;
  return `extension coverage incomplete: ${health.issues.map(issue => `${issue.id.slice(0, 12)}: ${issue.reasonCode}`).join(", ")}; verify missing relationships in source${health.retryAt === undefined ? "; run inarch build after correcting the extension failure" : "; automatic retry is subject to a cooldown"}`;
}

/** What moved since the last build. Empty in all three arrays = nothing to do. */
export interface Drift {
  /** Recorded files whose bytes differ now. */
  changed: string[];
  /** Source files with no record — new, or never indexed. */
  added: string[];
  /** Recorded files that are gone from disk. */
  removed: string[];
}

/** `<outDir>/.cache/fingerprint.<stamp>.json` — keyed by extractor identity for the
 * same reason the memo is (see {@link extractCachePath}): two grafts on one repo,
 * typically an `npx` MCP server and a locally installed hook binary, must not keep
 * invalidating each other's prints and forcing a cold rebuild on every call. */
export function fingerprintPath(outDir: string): string {
  return join(outDir, CACHE_DIR, `${FINGERPRINT_PREFIX}.${stamp()}.json`);
}

export function readFingerprint(outDir: string): Fingerprint | null {
  const f = readJson<Fingerprint>(fingerprintPath(outDir));
  if (!f || f.version !== FINGERPRINT_VERSION || typeof f.files !== "object" || !f.files) return null;
  if (f.extractor !== stamp()) return null; // different extractor — re-extract, don't trust these prints
  // wiring.json and its optional cache are separate atomic writes. A read-only
  // cache may retain an old success after the graph drops extension edges.
  // Compare deterministic execution identities, reusing the query's graph cache.
  if ((f.extensions || f.extensionBuild) && f.extensionBuild?.stamp !== loadGraphCached(outDir)?.meta?.extensionState) {
    return { ...f, extensionBuild: undefined, extensionInputs: undefined };
  }
  return f;
}

/** Project the extraction cache's entries into the probe sidecar. Best-effort:
 * the graph is already on disk when this runs, so a failed write costs the next
 * probe its fast path and nothing more. */
export function writeFingerprint(
  outDir: string,
  entries: Record<string, ExtractEntry>,
  onlyDirs?: string[],
  root?: string,
  extensionStamp?: string,
  extensionInputs?: string[],
  extensionInputExclusions?: string[],
  extensionRuns?: ExtensionRun[],
): boolean {
  const files: Record<string, Print> = {};
  for (const [rel, e] of Object.entries(entries)) files[rel] = [e.size, e.mtimeMs, e.hash];
  // Non-source files the RESOLVER's configuration depends on. Without them, turning a
  // repo from a Rails app into a plain Ruby one — a one-line Gemfile edit — left the
  // probe reporting clean while every constant edge in the graph was now resolved by
  // rules that no longer apply. See RAILS_WITNESS_FILES.
  if (root) for (const rel of RESOLVER_WITNESS_FILES) {
    const print = witnessPrint(root, rel);
    if (print) files[rel] = print;
  }
  try {
    const record: Fingerprint = { version: FINGERPRINT_VERSION, extractor: stamp(), files };
    const extensions = extensionStamp ?? (root ? extensionFingerprint(root) : "");
    if (extensions) record.extensions = extensions;
    if (extensionInputs !== undefined) record.extensionInputs = [...new Set(extensionInputs)].sort();
    if (extensionInputExclusions !== undefined) record.extensionInputExclusions = [...extensionInputExclusions];
    if (extensionRuns && (extensions || extensionRuns.length)) record.extensionBuild = {
      stamp: extensionExecutionStamp(extensions, extensionRuns),
      attemptedAt: Date.now(),
      runs: extensionRuns.map(({ id, digest, status, reasonCode, inputFingerprint }) => ({ id, digest, status,
        ...(reasonCode ? { reasonCode } : {}), ...(inputFingerprint ? { inputFingerprint } : {}) })),
    };
    if (onlyDirs && onlyDirs.length > 0) record.onlyDirs = onlyDirs;
    writeJsonAtomic(fingerprintPath(outDir), record, true);
    pruneSidecars(join(outDir, CACHE_DIR), FINGERPRINT_PREFIX);
    return true;
  } catch {
    return false;
  }
}

/** `GRAFT_REFRESH=hash` — never trust a stat, confirm every file by its bytes. */
export function alwaysHash(): boolean {
  return process.env.GRAFT_REFRESH === "hash";
}

/**
 * May a recorded `(size, mtimeMs, hash)` be trusted for the file `f` as it is on
 * disk now, without reading it?
 *
 * **The probe's rule only.** `buildGraph` deliberately does not use this: it reads
 * and hashes every file, every time. A stat may decide whether a query bothers
 * rebuilding; it may not decide what the rebuild itself looks at — otherwise
 * `inarch check` (which always re-hashes) can report drift that the `inarch build` it
 * recommends then refuses to repair. `GRAFT_REFRESH=hash` is the escape hatch for
 * the probe's blind spot: a same-length edit inside one mtime tick.
 *
 * An empty `hash` means the last build never got the bytes — always re-read.
 * A *parse* failure keeps its real hash, so it stays on the fast path: re-reading
 * bytes that failed to parse yesterday just fails to parse again.
 */
export function statUnchanged(
  rec: { size: number; mtimeMs: number; hash: string },
  f: { size: number; mtimeMs: number },
): boolean {
  if (alwaysHash()) return false;
  if (!rec.hash) return false;
  return rec.size === f.size && rec.mtimeMs === f.mtimeMs;
}

export function isClean(d: Drift): boolean {
  return d.changed.length === 0 && d.added.length === 0 && d.removed.length === 0;
}

export function driftCount(d: Drift): number {
  return d.changed.length + d.added.length + d.removed.length;
}

/**
 * Diff the working tree against the last build's fingerprint. Returns null when
 * there is no fingerprint to compare against (never built, or built by a version
 * that didn't write one) — callers should treat that as "unknown", not "clean".
 *
 * `GRAFT_REFRESH=hash` skips the stat fast path and hashes every file, for the
 * rare tooling that rewrites content while preserving size and mtime.
 */
export function probeDrift(root: string, outDir: string): Drift | null {
  const fp = readFingerprint(outDir);
  if (!fp) return null;

  const drift: Drift = { changed: [], added: [], removed: [] };
  if ((fp.extensions ?? "") !== extensionFingerprint(root)) drift.changed.push("[extensions]");
  if (extensionInputsChanged(root, fp, outDir)) drift.changed.push("[extension inputs]");
  const seen = new Set<string>();

  const onlyDirs = fp.onlyDirs && fp.onlyDirs.length > 0 ? new Set(fp.onlyDirs) : undefined;
  for (const f of listSourceStats(root, outDir, undefined, onlyDirs)) {
    seen.add(f.rel);
    const print = fp.files[f.rel];
    if (!print) {
      drift.added.push(f.rel);
      continue;
    }
    const [size, mtimeMs, hash] = print;
    if (statUnchanged({ size, mtimeMs, hash }, f)) continue;
    // Suspect: confirm by bytes, so a touch (or a checkout that restores the
    // same content) doesn't cost a rebuild. An entry with an empty hash lands
    // here every time by design — that's a file the last build couldn't read, and
    // the only way to learn it's readable again is to try.
    let now: string;
    try {
      const source = readSourceFile(f.abs);
      if (source === null) {
        // A previously indexed file becoming undecodable is real drift: rebuild
        // once to remove its stale nodes. Empty-hash entries were already skipped
        // by the last build, so they remain clean and avoid rebuild churn.
        if (hash) drift.changed.push(f.rel);
        continue;
      }
      now = contentHash(source);
    } catch {
      continue; // unreadable right now — leave it to the next probe
    }
    if (now !== hash) drift.changed.push(f.rel);
  }

  // The witness files are not enumerated by `listSourceStats`, so they are stated
  // explicitly — in all three directions, since a Gemfile can appear as well as
  // change or vanish.
  for (const rel of RESOLVER_WITNESS_FILES) {
    seen.add(rel);
    const print = witnessPrint(root, rel);
    const recorded = fp.files[rel];
    if (print && !recorded) drift.added.push(rel);
    else if (!print && recorded) drift.removed.push(rel);
    else if (print && recorded && print[2] !== recorded[2]) drift.changed.push(rel);
  }

  for (const rel of Object.keys(fp.files)) {
    if (!seen.has(rel)) drift.removed.push(rel);
  }

  drift.changed.sort();
  drift.added.sort();
  drift.removed.sort();
  return drift;
}

/** A build using two different source views cannot be fresh against just one.
 * Unknown/malformed stamps fail closed; explicit skipped executions need no
 * repository read and do not cause a rebuild loop when isolation is unavailable. */
export function extensionInputsChanged(root: string, fingerprint: Fingerprint | null, outDir?: string): boolean {
  if (!fingerprint) return false; // The caller handles a wholly missing fingerprint.
  const stamps = fingerprint.extensionInputs;
  if (stamps === undefined) return Boolean(fingerprint.extensions);
  if (!Array.isArray(stamps) || stamps.length > 8 || stamps.some(stamp => typeof stamp !== "string" || !/^[a-f0-9]{64}$/.test(stamp))) return true;
  if (stamps.length === 0) return false;
  if (outDir && JSON.stringify(extensionOutputExclusions(root, outDir)) !== JSON.stringify(fingerprint.extensionInputExclusions ?? [])) return true;
  const current = extensionInputFingerprint(root, fingerprint.extensionInputExclusions ?? []);
  return current === null || stamps.some(stamp => stamp !== current);
}

/** `[size, mtimeMs, hash]` for a tracked non-source file, or null when it is absent.
 * Always hashed: these are small, read once per build or probe, and a stat fast path
 * would reintroduce the same-size-same-mtime blind spot for the one input whose
 * change invalidates the entire graph. */
function witnessPrint(root: string, rel: string): Print | null {
  try {
    const abs = join(root, rel);
    const st = statSync(abs);
    if (!st.isFile()) return null;
    return [st.size, st.mtimeMs, contentHash(readFileSync(abs, "utf8"))];
  } catch {
    return null;
  }
}
