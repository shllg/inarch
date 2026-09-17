/**
 * `checkGraph` — is the committed `graph.json` still in sync with the code?
 *
 * Deterministic and fast (tree-sitter only, no LLM, no network): it re-runs
 * Tier-1 extraction and diffs the fresh node set against the committed graph by
 * `id` and `body_hash`. Meant for CI — exit non-zero when a PR changed code but
 * didn't rebuild the graph.
 *
 * Drift categories:
 *   added    a definition exists in code but not in graph.json (run `graph`)
 *   removed  a node in graph.json no longer exists in code       (run `graph`)
 *   changed  a node's body_hash differs from the committed one   (run `graph`)
 *   stale    a committed node's summary is flagged stale — its body changed
 *            since it was last summarized                         (run `inarch build --deep`)
 *
 * `added`/`removed`/`changed` are structural: the graph no longer describes the
 * code. `stale` is a meaning-layer signal the last build already recorded.
 * `pending` (never summarized) is not drift — it's a deliberate Tier-1-only build.
 */
import { resolve } from "node:path";
import { relPosix } from "../util/paths.js";
import { contextDirFor } from "../context/node-file.js";
import { extractFile, grammarFailures, languageOf } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { filterByOnlyDirs, listSourceFiles } from "./source-files.js";
import { walkDir } from "../ingest/fs.js";
import { readFollowNestedRepos, readFollowSubmodules, readIncludeDirs } from "../util/state.js";
import { discoverZeitwerk } from "./zeitwerk.js";
import { readGraph, wiringPath } from "./write.js";
import { extensionHealth, extensionHealthNote, extensionInputsChanged, readFingerprint, type ExtensionHealth } from "./fingerprint.js";
import { extensionFingerprint, extensionNodeHashes } from "./extensions.js";
import { readSourceFile } from "../util/source.js";

export interface GraphCheckResult {
  ok: boolean;
  /** True when there is no graph.json (a graph has never been built). */
  missing: boolean;
  /** Approval, package integrity or registration changed since the build. */
  extensionsChanged?: boolean;
  extensionHealth?: ExtensionHealth;
  added: string[];
  removed: string[];
  changed: string[];
  stale: string[];
  /** Nodes never summarized (reported for context; not counted as drift). */
  pending: number;
  /** Ids of pending nodes (capped when formatting) — so a stuck meaning pass
   * names the files instead of only saying "run --deep" (#172). */
  pendingIds: string[];
  /** Committed nodes in total — the denominator that turns `pending` into a
   * coverage figure. A deep build that lost most of its LLM calls (#127) is only
   * distinguishable from a deliberate Tier-1 build by the SHARE that is missing. */
  nodes: number;
  /**
   * Native grammars that would not load this run, one line each (T2).
   *
   * Reported, never counted toward `ok`. A `.kt` file extracted through the breadth
   * tier is genuinely in sync with its source — it is simply carrying less than a
   * healthy install would. Failing the check for it would make `inarch check` red on
   * a machine where nothing is wrong with the repository, and a check that is red for
   * something you cannot fix from the repository is a check people stop reading.
   */
  grammarWarnings: string[];
}

export interface GraphCheckOptions {
  contextDir?: string;
}

// async: the breadth tier's WASM grammars load asynchronously and must be warmed
// before the (synchronous) re-extraction below, exactly as buildGraph does — else
// breadth-tier files (.rs, …) would re-extract as empty here and read as `removed`
// against a graph that built them, so `inarch check` would never report OK.
export async function checkGraph(
  dir: string,
  opts: GraphCheckOptions = {},
): Promise<GraphCheckResult> {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);

  const result: GraphCheckResult = {
    ok: false,
    missing: false,
    added: [],
    removed: [],
    changed: [],
    stale: [],
    pending: 0,
    pendingIds: [],
    grammarWarnings: [],
    nodes: 0,
  };

  const committed = readGraph(wiringPath(outDir));
  if (!committed) {
    result.missing = true;
    return result;
  }

  // Freshly extract Tier-1 nodes from the code on disk (same file set as build).
  // A `--only-dir` build records its whitelist in the fingerprint; read it back
  // so `check` diffs the same limited set instead of flagging every excluded
  // file as "added".
  const fingerprint = readFingerprint(outDir);
  if (fingerprint?.extensions || fingerprint?.extensionBuild) result.extensionHealth = extensionHealth(fingerprint);
  const fpOnlyDirs = fingerprint?.onlyDirs;
  result.extensionsChanged = (fingerprint?.extensions ?? "") !== extensionFingerprint(root) || extensionInputsChanged(root, fingerprint, outDir) ||
    (!fingerprint && (committed.nodes.some(n => n.origin === "extension") ||
      committed.edges.some(e => e.origin === "extension")));
  const onlyDirs = fpOnlyDirs && fpOnlyDirs.length > 0 ? new Set(fpOnlyDirs) : undefined;
  const repoFiles = filterByOnlyDirs(walkDir(root, readIncludeDirs(root), {
    followSubmodules: readFollowSubmodules(root),
    followNestedRepos: readFollowNestedRepos(root),
  }), root, onlyDirs);
  const sourceFiles = listSourceFiles(root, outDir, repoFiles);
  // Rails macros and concern methods have different node sets/scopes from plain
  // Ruby. Omitting build's repo-level context reported thousands of removed nodes
  // immediately after a clean Rails build. Discovery needs the same filtered walk,
  // including the non-source Gemfile witness, and both extraction tiers need it.
  const zeitwerk = discoverZeitwerk(root, repoFiles);
  const rails = zeitwerk ? { acronyms: zeitwerk.acronyms } : null;
  // Warmed from the files the depth and container tiers do not claim — the same
  // three-way branch the loop below takes. See buildGraph for why the extension list
  // alone is the wrong input.
  await warmGenericGrammars(
    new Set(
      sourceFiles
        .filter((f) => !languageOf(f) && !containerLangOf(f))
        .map((f) => genericLangOf(f)?.name)
        .filter((n): n is string => !!n),
    ),
  );
  // Container-tier grammars need the same warmup as the generic ones, for the same
  // reason: extraction below is synchronous. Missing this is what made `graft
  // check` report every `.vue` node as `removed` right after a clean build (#236)
  // — the tier extracted fine, and then the check had no branch that could see it.
  await warmContainerGrammars(
    new Set(sourceFiles.map((f) => containerLangOf(f)?.name).filter((n): n is string => !!n)),
  );
  // Extension nodes have no parser definition to rediscover. Revalidate their
  // host-hashed source spans instead; check must never execute extension code.
  const current = extensionNodeHashes(root, committed.nodes); // id → body_hash
  for (const file of sourceFiles) {
    // The same three-way branch `buildGraph` uses, in the same order. The two must
    // stay in step: a tier the build extracts and the check cannot see reports as
    // `removed` forever, and the `inarch build` the check tells you to run can never
    // repair it.
    const lang = languageOf(file);
    const container = lang ? null : containerLangOf(file);
    const generic = lang || container ? null : genericLangOf(file);
    let source: string | null;
    try {
      source = readSourceFile(file);
    } catch {
      continue; // unreadable now → its nodes show up as `removed` below
    }
    if (source === null) continue; // unsupported encoding (e.g. UTF-16BE)
    const rel = relPosix(root, file);
    try {
      const extracted = lang
        ? extractFile(rel, source, lang, { rails })
        : container
          ? extractContainer(rel, source, container, { rails })
          : generic
            ? extractGeneric(rel, source, generic.name)
            : null;
      // No tier claims this file. Spelled out rather than asserted away: the
      // `generic!` that used to stand in this position threw a TypeError on a
      // container-tier file, the catch below swallowed it as a parse failure, and
      // a missing branch became a silent permanent `removed` (#236). Returning
      // null here means the next tier graft gains fails loudly in the type
      // checker instead.
      if (extracted === null) continue;
      for (const n of extracted.nodes) current.set(n.id, n.body_hash);
    } catch {
      // parse failure → skip; the committed nodes for this file become `removed`.
    }
  }

  const committedById = new Map(committed.nodes.map((n) => [n.id, n]));
  result.nodes = committedById.size;
  for (const [id, node] of committedById) {
    const now = current.get(id);
    if (now === undefined) result.removed.push(id);
    else if (now !== node.body_hash) result.changed.push(id);
    if (node.summary_state === "stale") result.stale.push(id);
    if (node.summary_state === "pending") {
      result.pending++;
      result.pendingIds.push(id);
    }
  }
  for (const id of current.keys()) {
    if (!committedById.has(id)) result.added.push(id);
  }

  for (const arr of [result.added, result.removed, result.changed, result.stale, result.pendingIds]) {
    arr.sort();
  }

  // After the extraction loop, so only grammars this repo actually needed appear.
  result.grammarWarnings = grammarFailures().map(
    (f) => `${f.lang}: ${f.module} could not be loaded — ${f.error}`,
  );
  result.ok =
    !result.extensionsChanged &&
    result.extensionHealth?.ok !== false &&
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.changed.length === 0 &&
    result.stale.length === 0;
  return result;
}

/** Render a graph-check result as a human-readable report. */
export function formatGraphCheckReport(r: GraphCheckResult): string {
  if (r.missing) {
    return "graph check: NO GRAPH\n\nNo graft/.graph/wiring.json found. Run `inarch build` first.";
  }
  if (r.ok) {
    // A share, not a bare count: "1203 not yet summarized" reads the same whether
    // the repo was never deep-built or a deep build failed most of its calls.
    const pct = r.nodes > 0 ? Math.round(((r.nodes - r.pending) / r.nodes) * 100) : 0;
    const note = r.pending ? ` (${formatPendingNote(r, pct)})` : "";
    // OK, and still say what was missing. The graph matches the source; it was built
    // with fewer parsers than a healthy install has, and the person reading this is
    // the only one who can do anything about that.
    const degradedNote = (r.grammarWarnings ?? []).length
      ? "\n\n" +
        (r.grammarWarnings ?? []).map((w) => `! ${w}`).join("\n") +
        "\nThose files were indexed without a depth-tier parser. Reinstall to restore " +
        "them; the next build will re-parse them automatically."
      : "";
    return `graph check: OK — the wiring graph is in sync with the code.${note}${degradedNote}`;
  }

  const structural = r.added.length + r.removed.length + r.changed.length;
  const degraded = r.extensionHealth?.ok === false;
  const lines: string[] = [`graph check: ${degraded && !r.extensionsChanged && !structural && !r.stale.length ? "DEGRADED" : "STALE"}`, ""];
  if (r.extensionsChanged) lines.push("extensions changed: rebuild to apply the current approvals and package integrity state.");
  if (degraded) lines.push(extensionHealthNote(r.extensionHealth!)!);
  if (r.changed.length) {
    lines.push(`changed (${r.changed.length}):`);
    for (const id of r.changed) lines.push(`  ~ ${id}`);
  }
  if (r.added.length) {
    lines.push(`added (${r.added.length}):`);
    for (const id of r.added) lines.push(`  + ${id}`);
  }
  if (r.removed.length) {
    lines.push(`removed (${r.removed.length}):`);
    for (const id of r.removed) lines.push(`  - ${id}`);
  }
  if (r.stale.length) {
    lines.push(`stale summaries (${r.stale.length}):`);
    for (const id of r.stale) lines.push(`  ! ${id}`);
  }
  lines.push("");
  if (structural) lines.push("Run `inarch build` to rebuild the structure, then commit graft/.");
  if (r.stale.length) lines.push("Run `inarch build --deep` to refresh stale summaries.");
  for (const w of r.grammarWarnings ?? []) lines.push(`! ${w}`);
  return lines.join("\n");
}

/** Cap how many pending ids the OK-note lists so a large Tier-1 graph stays readable. */
const PENDING_SAMPLE = 8;

function formatPendingNote(r: GraphCheckResult, pct: number): string {
  const ids = r.pendingIds ?? [];
  const sample = ids.slice(0, PENDING_SAMPLE);
  const more = ids.length > PENDING_SAMPLE ? `, … +${ids.length - PENDING_SAMPLE} more` : "";
  const named = sample.length ? `: ${sample.join(", ")}${more}` : "";
  // Tier-1-only builds are supposed to leave everything pending — "run --deep"
  // is the right next step. A deep build that still left them pending used to
  // dead-end here (#172): re-running the same command never cleared empty/failed
  // meaning replies, so name the nodes and point at the last build's errors.
  return (
    `meaning tier ${pct}% complete — ${r.pending} of ${r.nodes} node(s) pending${named}. ` +
    `Run \`inarch build --deep\` to summarize them; if a deep build already left these pending, ` +
    `that meaning pass failed — see that build's errors (re-running alone will not clear them)`
  );
}
