/**
 * A type declared in the file that uses it must produce a `references` edge to it.
 *
 * T1 made type positions visible, but the reference walk emits an edge only for a
 * name in `ctx.importedSymbols` — so a type the file declares itself, which is never
 * imported, produced nothing. A *call* to a same-file symbol has always resolved.
 * Reference and call disagreed about what a file can see of itself.
 *
 * The resolution is same-file and unique, and deliberately nothing more. It does NOT
 * fall through to `resolveName`'s second tier, which answers with a repo-wide unique
 * name: a type this file neither imports nor declares is not this file's to resolve,
 * and reaching for a same-named type elsewhere is the unique-name failure that once
 * bound 1,040 Go callers into one TypeScript file.
 *
 * Seven declines carry that argument, and every one of them is green before this
 * change as well as after — they are guards, not coverage of the fix:
 *
 *   - a built-in (`Promise`) that no file declares
 *   - a type declared only in ANOTHER file and not imported, though repo-unique
 *   - two same-file declarations of one name (interface merging really does emit
 *     `Merged` and `Merged~2`), which is ambiguous and must drop
 *   - a recursive type naming itself, which would be a self-loop
 *   - a type parameter `<Shadow>` shadowing a same-file `interface Shadow`
 *   - a same-file VALUE identifier, which this change must not start resolving
 *   - a heritage clause, which already carries `extends` and must not gain a second edge
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

/** One source, written to both `use.ts` and `use.tsx`, so every case is asserted for
 * `typescript` and for `tsx`. */
const USE = `import type { Imported } from './other'

interface LocalRecord { id: string }
type LocalAlias = { n: number }
class LocalClass { k = 1 }
enum LocalEnum { A }

export function s1Interface(): LocalRecord { return null as any }
export function s2Alias(a: LocalAlias): string { return String(a.n) }
export function s3Class(c: LocalClass): number { return c.k }
export function s4Enum(e: LocalEnum): number { return Number(e) }
export function s5StillImported(i: Imported): string { return i.viaImport }

export function d1Builtin(p: Promise<string>): string { return String(p) }
export function d2ForeignUnique(o: ForeignOnly): string { return String(o) }

interface Merged { a: string }
interface Merged { b: number }
export function d3Ambiguous(m: Merged): string { return m.a }

interface Tree { kids: Tree[] }

interface Shadow { real: string }
export function d5TypeParam<Shadow>(x: Shadow): Shadow { return x }

const localConst = 1
export function d6Value(): number { return localConst }

class LocalBase { b = 0 }
export class Sub extends LocalBase { s = 1 }
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ts-samefile-"));
  // `ForeignOnly` is declared here and NOWHERE else, and `use.ts` does not import it.
  // Repo-wide unique is exactly the condition under which a name-matching resolver
  // would answer; this fixture exists so that answering is a test failure.
  put(
    dir,
    "other.ts",
    `export interface Imported { viaImport: string }
export interface ForeignOnly { far: boolean }
`,
  );
  put(dir, "use.ts", USE);
  put(dir, "use.tsx", USE);
  // Python annotates with plain identifiers, not `type_identifier`. This file proves
  // the change did not widen past the TypeScript type positions T1 introduced.
  put(
    dir,
    "same_file.py",
    `class PyRecord:
    pass


def uses(x: PyRecord) -> PyRecord:
    return x
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

const FILES = ["use.ts", "use.tsx"] as const;

for (const file of FILES) {
  test(`${file}: a same-file interface in a return type is referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const edges = refsFrom(graphOf(dir), `${file}#s1Interface`);
      assert.deepEqual(
        edges.map((e) => e.target),
        [`${file}#LocalRecord`],
      );
      assert.equal(edges[0].confidence, "extracted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a same-file type alias in a parameter is referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#s2Alias`).map((e) => e.target),
        [`${file}#LocalAlias`],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a same-file class used as a type is referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#s3Class`).map((e) => e.target),
        [`${file}#LocalClass`],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a same-file enum used as a type is referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#s4Enum`).map((e) => e.target),
        [`${file}#LocalEnum`],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: an imported type still resolves through its specifier`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#s5StillImported`).map((e) => e.target),
        ["other.ts#Imported"],
        "T1's specifier path must be untouched",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- declines: green before this change and after ----

  test(`${file}: a built-in no file declares is not referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(refsFrom(graphOf(dir), `${file}#d1Builtin`).map((e) => e.target), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a repo-unique type from another file is not referenced without an import`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#d2ForeignUnique`).map((e) => e.target),
        [],
        "ForeignOnly is unique in the repo — answering here is the unique-name failure",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: two same-file declarations of one name are ambiguous and drop`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.equal(
        graph.nodes.filter((n) => n.path === file && n.id.includes("Merged")).length,
        2,
        "fixture precondition: interface merging emits two nodes",
      );
      assert.deepEqual(refsFrom(graph, `${file}#d3Ambiguous`).map((e) => e.target), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a recursive type does not reference itself`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const selfLoops = graphOf(dir).edges.filter((e) => e.source === e.target);
      assert.deepEqual(selfLoops, [], "a type naming itself must not become a self-loop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a type parameter shadowing a same-file type is not referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#d5TypeParam`).map((e) => e.target),
        [],
        "<Shadow> is the type parameter, not the file's `interface Shadow`",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a same-file value identifier is still not referenced`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.deepEqual(
        refsFrom(graphOf(dir), `${file}#d6Value`).map((e) => e.target),
        [],
        "this change is scoped to type positions; widening to values is a separate decision",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a same-file base class gains no second edge beside extends`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.equal(
        graph.edges.filter((e) => e.source === `${file}#Sub` && e.relation === "extends").length,
        1,
      );
      assert.deepEqual(refsFrom(graph, `${file}#Sub`).map((e) => e.target), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("python: a same-file class in an annotation is not referenced", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      refsFrom(graphOf(dir), "same_file.py#uses").map((e) => e.target),
      [],
      "the change is gated to TypeScript type positions",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
