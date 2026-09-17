/**
 * A barrel re-export is a path, and resolution can walk it.
 *
 * `export { Select } from './select'` produced NOTHING: not the file-level dependency
 * on `./select`, and no record that the barrel exposes the name at all. So an importer
 * of `./index` reached a module that does not define what it asked for, the
 * specifier-confined branch found zero candidates, and the edge was dropped — or, in
 * the `calls` arm, fell through to the repo-wide unique-name match that once bound a
 * production component to a different application's.
 *
 * The walk is specifier-confined at every hop: each step is an explicit
 * `export … from '…'` read out of source, never a name match. A name the barrel does
 * not re-export still resolves to nothing, and two star re-exports that both offer the
 * name are ambiguous and drop, exactly as two definitions in one file do.
 *
 * Every fixture carries a decoy definition of the same name in a module nobody
 * imports. With two reachable candidates a repo-wide name match has no unique answer,
 * so an edge that arrives anyway arrived by following the re-export.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { EdgeV1, GraphV1 } from "../src/graph/types.js";

function put(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-barrel-"));

  put(dir, "ui/select.ts", "export function Select(): number { return 1 }\n");
  put(dir, "ui/inner.ts", "export function Inner(): number { return 2 }\n");
  put(dir, "ui/starred.ts", "export function Starred(): number { return 3 }\n");
  put(dir, "ui/deep.ts", "export function Deep(): number { return 4 }\n");
  // The barrel. Named, aliased and star re-exports, plus a purely local export that
  // has no `from` clause and must not be mistaken for one.
  put(
    dir,
    "ui/index.ts",
    `export { Select } from './select'
export { Inner as Outer } from './inner'
export * from './starred'
export { Deep } from './deep-barrel'
const localThing = 5
export { localThing }
`,
  );
  // A second barrel in front of the first, so resolution has to take two hops.
  put(dir, "ui/deep-barrel.ts", "export { Deep } from './deep'\n");

  // Never imported by anyone. Makes every name non-unique repo-wide, so a name-based
  // answer cannot be right by accident.
  put(
    dir,
    "decoys/mocks.ts",
    `export function Select(): number { return 91 }
export function Inner(): number { return 92 }
export function Starred(): number { return 93 }
export function Deep(): number { return 94 }
export function Ghost(): number { return 95 }
`,
  );

  // Two stars offering the same name — ambiguous, and must drop.
  put(dir, "amb/one.ts", "export function Twin(): number { return 1 }\n");
  put(dir, "amb/two.ts", "export function Twin(): number { return 2 }\n");
  put(dir, "amb/index.ts", "export * from './one'\nexport * from './two'\n");

  // A re-export cycle. Must terminate.
  put(dir, "cyc/a.ts", "export { Loop } from './b'\n");
  put(dir, "cyc/b.ts", "export { Loop } from './a'\n");

  // Value references, not type positions: this branch is cut from upstream/main,
  // where the reference walk accepts `identifier` only.
  put(
    dir,
    "use.ts",
    `import { Select, Outer, Starred, Deep, Ghost } from './ui/index'
import { Twin } from './amb/index'
import { Loop } from './cyc/a'

export function usesSelect(): unknown { const v = Select; return v }
export function usesAliased(): unknown { const v = Outer; return v }
export function usesStarred(): unknown { const v = Starred; return v }
export function usesDeep(): unknown { const v = Deep; return v }
export function usesGhost(): unknown { const v = Ghost; return v }
export function usesTwin(): unknown { const v = Twin; return v }
export function usesLoop(): unknown { const v = Loop; return v }
`,
  );
  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

function refsFrom(graph: GraphV1, source: string): EdgeV1[] {
  return graph.edges.filter((e) => e.relation === "references" && e.source === source);
}

test("a named re-export resolves to the module that defines the name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = refsFrom(graphOf(dir), "use.ts#usesSelect");
    assert.deepEqual(edges.map((e) => e.target), ["ui/select.ts#Select"]);
    assert.equal(edges[0].confidence, "extracted", "each hop is read from source, not guessed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an aliased re-export resolves to the inner name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "use.ts#usesAliased").map((e) => e.target),
      ["ui/inner.ts#Inner"],
      "`export { Inner as Outer }` — the importer writes Outer, the module defines Inner",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a star re-export resolves", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "use.ts#usesStarred").map((e) => e.target),
      ["ui/starred.ts#Starred"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-export chain resolves through both hops", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "use.ts#usesDeep").map((e) => e.target),
      ["ui/deep.ts#Deep"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the barrel's own dependency on the module is recorded", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const imports = graphOf(dir)
      .edges.filter((e) => e.relation === "imports" && e.source === "ui/index.ts")
      .map((e) => e.target)
      .sort();
    assert.deepEqual(imports, [
      "ui/deep-barrel.ts",
      "ui/inner.ts",
      "ui/select.ts",
      "ui/starred.ts",
    ], "a re-export is a dependency, and produced no edge at all before this");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- declines ----

test("a name the barrel does not re-export resolves to nothing", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "use.ts#usesGhost").map((e) => e.target),
      [],
      "Ghost exists only in the unimported decoy; the barrel never offers it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two star re-exports offering one name are ambiguous and drop", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "use.ts#usesTwin").map((e) => e.target),
      [],
      "picking either is a guess, exactly as with two definitions in one file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-export cycle terminates and resolves to nothing", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(refsFrom(graphOf(dir), "use.ts#usesLoop").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local export with no `from` clause is not a re-export", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const imports = graphOf(dir)
      .edges.filter((e) => e.relation === "imports" && e.source === "ui/index.ts")
      .map((e) => e.target);
    assert.ok(
      !imports.some((t) => t.includes("localThing")),
      "`export { localThing }` names no module and must add no dependency",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing binds to the unimported decoy", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    // Its own `contains` edges are structural and expected; what must not exist is an
    // edge from anywhere else INTO it.
    assert.deepEqual(
      graphOf(dir)
        .edges.filter((e) => e.target.startsWith("decoys/") && !e.source.startsWith("decoys/"))
        .map((e) => `${e.relation} ${e.source} -> ${e.target}`),
      [],
      "every assertion above must be a module answer, never a name one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
