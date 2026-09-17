/**
 * One language that cannot load must cost exactly that language.
 *
 * `tree-sitter-kotlin` ships no prebuild for any platform, and on a machine whose npm
 * has `ignore-scripts=true` it never compiles either. Before this, that meant EVERY
 * command — in a repository with no Kotlin in it — died with
 * `No native build was found … abi=147` and a node-gyp-build stack trace that never
 * said "inarch", before argv was read.
 *
 * Three failures hide behind that symptom and they are not the same failure:
 *
 *   1. one grammar cannot load, and the other ten are fine;
 *   2. `tree-sitter` itself cannot load, so every depth language goes at once;
 *   3. install cannot complete, so the package never landed.
 *
 * (3) is answered in package.json — `tree-sitter-kotlin` and `tree-sitter-python` are
 * `optionalDependencies` because their prebuild matrices are incomplete: zero
 * platforms and no-arm64 respectively, against six for every other grammar. (1) and
 * (2) are answered here.
 *
 * The test this file exists for is the LAST one: the cache stamp. None of the four
 * upstream PRs on this subject has it, and without it the whole feature is a trap —
 * a degraded parse gets cached, the user repairs the install exactly as the warning
 * asked, the stamp computes identical, the cache hits, and the degraded parse replays
 * forever with no output at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph, formatGraphCheckReport } from "../src/graph/check.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import {
  extractFile,
  grammarFailures,
  grammarHealth,
  languageOf,
  loadedGrammarsStamp,
  resetDemandForTest,
  setGrammarForTest,
  setRuntimeForTest,
} from "../src/graph/extract.js";
import { extractorStamp, resetStampForTest } from "../src/graph/extract-cache.js";
import type { GraphV1 } from "../src/graph/types.js";

const run = promisify(execFile);
const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = join(HERE, "..");

function put(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/** A repo with no Kotlin anywhere. */
function plainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-resil-plain-"));
  put(dir, "a.ts", "export function alpha(): number { return 1 }\nexport function beta(): number { return alpha() }\n");
  put(dir, "b.rb", "class Widget\n  def spin\n    2\n  end\nend\n");
  return dir;
}

/** The same repo, plus Kotlin. */
function kotlinRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-resil-kt-"));
  put(dir, "a.ts", "export function alpha(): number { return 1 }\nexport function beta(): number { return alpha() }\n");
  put(dir, "Main.kt", "package app\n\nfun helper(): Int = 1\n\nfun main() {\n    helper()\n}\n");
  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

/** Everything about a graph that a degraded parse could move. */
function shape(g: GraphV1) {
  return {
    nodes: g.nodes.map((n) => `${n.id}|${n.kind}|${n.span}`).sort(),
    edges: g.edges.map((e) => `${e.source}|${e.relation}|${e.target}|${e.confidence}`).sort(),
  };
}

async function withBrokenKotlin<T>(fn: () => Promise<T>): Promise<T> {
  const previous = setGrammarForTest("kotlin", {
    ok: false,
    error: "No native build was found for platform=linux arch=x64 runtime=node abi=147",
  });
  resetDemandForTest();
  resetStampForTest();
  try {
    return await fn();
  } finally {
    setGrammarForTest("kotlin", previous);
    resetStampForTest();
  }
}

// ---- 1. the reported symptom, in a real child process ----

test("--version survives a grammar that cannot load", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", join(REPO, "src", "cli.ts"), "--version"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        CI: "1",
        DO_NOT_TRACK: "1",
        GRAFT_BREAK_MODULE: "tree-sitter-kotlin",
        NODE_OPTIONS: `--require ${join(REPO, "test", "break-grammar-preload.cjs")}`,
      },
    },
  );
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, "argv is read before any grammar is");
});

test("--version survives the tree-sitter runtime itself failing", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", join(REPO, "src", "cli.ts"), "--version"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        CI: "1",
        DO_NOT_TRACK: "1",
        GRAFT_BREAK_MODULE: "tree-sitter",
        NODE_OPTIONS: `--require ${join(REPO, "test", "break-grammar-preload.cjs")}`,
      },
    },
  );
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, "failure mode 2: every depth language gone, still runs");
});

// ---- 2. a repo without the broken language pays nothing and hears nothing ----

test("a repo with no Kotlin builds identically, and says nothing at all", async () => {
  const healthyDir = plainRepo();
  const brokenDir = plainRepo();
  try {
    const healthy = await buildGraph(healthyDir);
    const broken = await withBrokenKotlin(() => buildGraph(brokenDir));
    assert.deepEqual(shape(graphOf(brokenDir)), shape(graphOf(healthyDir)), "field by field");
    assert.deepEqual(broken.warnings, [], "nothing asked for Kotlin, so nothing reports it missing");
    assert.deepEqual(healthy.warnings, []);
  } finally {
    rmSync(healthyDir, { recursive: true, force: true });
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

// ---- 3. a repo with it degrades to the breadth tier, loudly and exactly once ----

test("a broken grammar stops claiming its extension", async () => {
  await withBrokenKotlin(async () => {
    assert.equal(languageOf("Main.kt"), null, "so build.ts falls through to genericLangOf");
    assert.equal(languageOf("a.ts"), "typescript", "and nothing else moves");
  });
  assert.equal(languageOf("Main.kt"), "kotlin", "restored");
});

test("Kotlin files are still indexed, every other language is untouched, one warning", async () => {
  const healthyDir = kotlinRepo();
  const brokenDir = kotlinRepo();
  try {
    await buildGraph(healthyDir);
    const broken = await withBrokenKotlin(() => buildGraph(brokenDir));
    const g = graphOf(brokenDir);

    assert.ok(
      g.nodes.some((n) => n.path === "Main.kt"),
      "the file is still in the graph",
    );
    const ts = (x: GraphV1) => x.nodes.filter((n) => n.path === "a.ts").map((n) => n.id).sort();
    assert.deepEqual(ts(g), ts(graphOf(healthyDir)), "TypeScript is unaffected");

    assert.equal(broken.warnings.length, 1, "exactly one, not one per file");
    assert.match(broken.warnings[0], /kotlin/);
    assert.match(broken.warnings[0], /tree-sitter-kotlin/, "names the module to reinstall");
    assert.match(broken.warnings[0], /abi=147/, "and quotes the loader verbatim");
  } finally {
    rmSync(healthyDir, { recursive: true, force: true });
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

test("a healthy build reaches the native grammar, never the fallback row", async () => {
  const dir = kotlinRepo();
  try {
    const result = await buildGraph(dir);
    assert.deepEqual(result.warnings, []);
    assert.equal(languageOf("Main.kt"), "kotlin", "the breadth row stays dormant");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 4. the runtime going means everything degrades together, and check stays OK ----

test("check reports a degraded grammar without failing", async () => {
  const dir = kotlinRepo();
  try {
    await withBrokenKotlin(async () => {
      await buildGraph(dir);
      const c = await checkGraph(dir);
      assert.equal(c.ok, true, "the graph matches the source; it was built with fewer parsers");
      assert.equal(c.grammarWarnings.length, 1);
      assert.match(c.grammarWarnings[0], /tree-sitter-kotlin/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the runtime gone, extractFile degrades instead of throwing", () => {
  setRuntimeForTest(true);
  try {
    const r = extractFile("a.ts", "export function alpha(): number { return 1 }\n", "typescript");
    assert.equal(r.nodes.length, 1, "the file node, and nothing it could not parse");
    assert.equal(r.nodes[0].kind, "file");
    assert.deepEqual(r.rawEdges, []);
    assert.equal(languageOf("a.ts"), null, "every depth language goes at once");
  } finally {
    setRuntimeForTest(false);
  }
});

// ---- 5. the cache stamp: the test the upstream PRs do not have ----

test("the stamp moves when a grammar stops loading, and moves back", () => {
  resetStampForTest();
  const healthy = extractorStamp();
  const broken = withStamp(() => extractorStamp());
  resetStampForTest();
  const restored = extractorStamp();

  assert.notEqual(broken, healthy, "a degraded run must not reuse a healthy run's entries");
  assert.equal(restored, healthy, "and repairing the install must not reuse the degraded ones");

  function withStamp<T>(fn: () => T): T {
    const previous = setGrammarForTest("kotlin", { ok: false, error: "gone" });
    resetStampForTest();
    try {
      return fn();
    } finally {
      setGrammarForTest("kotlin", previous);
      resetStampForTest();
    }
  }
});

test("the stamp names the grammars it was built with", () => {
  resetStampForTest();
  const stamp = extractorStamp();
  assert.ok(stamp, "an identity exists in this layout");
  assert.ok(stamp!.includes(loadedGrammarsStamp()), "legible without reproducing the environment");
});

test("repairing a broken install re-parses: broken then healthy equals never-broken", async () => {
  const neverBroken = kotlinRepo();
  const repaired = kotlinRepo();
  try {
    await buildGraph(neverBroken);
    // Build once degraded — this is what writes the poisoned cache entries.
    await withBrokenKotlin(() => buildGraph(repaired));
    const degraded = shape(graphOf(repaired));
    // …then build again, healthy, in the same directory, over that cache.
    resetStampForTest();
    const second = await buildGraph(repaired);

    assert.notDeepEqual(degraded, shape(graphOf(repaired)), "the repair actually changed something");
    assert.deepEqual(
      shape(graphOf(repaired)),
      shape(graphOf(neverBroken)),
      "and landed exactly where a never-broken build lands",
    );
    assert.deepEqual(second.warnings, []);
  } finally {
    rmSync(neverBroken, { recursive: true, force: true });
    rmSync(repaired, { recursive: true, force: true });
  }
});

test("regressing re-parses too: healthy then broken leaves no stale depth-tier nodes", async () => {
  const dir = kotlinRepo();
  try {
    await buildGraph(dir);
    const healthy = shape(graphOf(dir));
    const broken = await withBrokenKotlin(async () => {
      await buildGraph(dir);
      return shape(graphOf(dir));
    });
    // The node COUNT happens to match, which is exactly why this compares shapes: a
    // count would have passed while the cache replayed the depth-tier parse verbatim.
    assert.notDeepEqual(broken, healthy, "the degraded parse is not the healthy one replayed from cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 6. install completeness: the question a demand-gated warning cannot answer ----

test("check reports every grammar, not only the ones this repo needed", async () => {
  const dir = plainRepo(); // TypeScript and Ruby; no Kotlin anywhere
  try {
    await withBrokenKotlin(async () => {
      await buildGraph(dir);
      const c = await checkGraph(dir);
      assert.deepEqual(c.grammarWarnings, [], "nothing here needed Kotlin, so nothing warns");
      assert.ok(
        c.grammars.unavailable.some((g) => g.lang === "kotlin"),
        "but asking whether the install is complete still gets a straight answer",
      );
      assert.ok(c.grammars.loaded.includes("typescript"));
      assert.ok(!c.grammars.loaded.includes("kotlin"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the human report names the missing grammar and what it costs", async () => {
  const dir = plainRepo();
  try {
    await withBrokenKotlin(async () => {
      await buildGraph(dir);
      const text = formatGraphCheckReport(await checkGraph(dir));
      assert.match(text, /install incomplete/);
      assert.match(text, /tree-sitter-kotlin/, "names the module to reinstall");
      assert.match(text, /\.kt\/\.kts/, "and the extensions it costs");
      assert.match(text, /abi=147/, "quoting the loader rather than paraphrasing it");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a healthy install says nothing about grammars at all", async () => {
  const dir = plainRepo();
  try {
    await buildGraph(dir);
    const c = await checkGraph(dir);
    assert.deepEqual(c.grammars.unavailable, [], "this machine is complete");
    assert.equal(c.grammars.loaded.length, 11, "and says so in --json, for a script to assert");
    const text = formatGraphCheckReport(c);
    assert.doesNotMatch(text, /install incomplete/, "silence is the healthy answer");
    assert.doesNotMatch(text, /grammar/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asking about health does not change what a build reports", async () => {
  const dir = plainRepo();
  try {
    await withBrokenKotlin(async () => {
      grammarHealth(); // probes all eleven, which must not count as demand
      const result = await buildGraph(dir);
      assert.deepEqual(result.warnings, [], "probing is not using");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout with no graph yet still answers whether the install is complete", async () => {
  // The case the first version missed: `graph` is null until something is built, so a
  // fresh clone asking "is my install OK?" got silence — from the command whose entire
  // job is to answer that.
  const dir = mkdtempSync(join(tmpdir(), "graft-resil-nograph-"));
  put(dir, "a.ts", "export function alpha(): number { return 1 }\n");
  try {
    // `check` exits 1 for NO GRAPH, which is correct and predates this — so read the
    // output off the rejection rather than asserting a zero exit that was never there.
    const stdout = await run(
      process.execPath,
      ["--import", "tsx", join(REPO, "src", "cli.ts"), "check", dir],
      {
        cwd: REPO,
        env: {
          ...process.env,
          CI: "1",
          DO_NOT_TRACK: "1",
          GRAFT_BREAK_MODULE: "tree-sitter-kotlin",
          NODE_OPTIONS: `--require ${join(REPO, "test", "break-grammar-preload.cjs")}`,
        },
      },
    ).then(
      (r) => r.stdout,
      (e: { stdout?: string }) => e.stdout ?? "",
    );
    assert.match(stdout, /NO GRAPH/);
    assert.match(stdout, /install incomplete/, "and says what is missing anyway");
    assert.match(stdout, /tree-sitter-kotlin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 7. the reporting surface ----

test("grammarFailures stays empty until something asks for the grammar", async () => {
  const dir = plainRepo();
  try {
    await withBrokenKotlin(async () => {
      await buildGraph(dir);
      assert.deepEqual(
        grammarFailures().filter((f) => f.lang !== "kotlin"),
        [],
        "no other language reports a failure it never had",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
