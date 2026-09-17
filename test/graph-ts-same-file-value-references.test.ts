/**
 * A file can see its own functions in value position, not only in type position.
 *
 * T4 taught the reference walk that `const x: Config = …` uses a `Config` the file
 * declares. It stopped at type positions, deliberately: widening to value identifiers
 * without a scope rule adds an edge per local-variable mention, and on dailywerk that
 * is 31,693 candidates.
 *
 * T7 supplied the missing half — a name bound in a local scope is not a repository
 * symbol — so the widening is now expressible. What survives the scope rule is the
 * case that was always worth having: `items.map(vaultFileFromItem)` and
 * `new ApiError(401)`, a function or class passed or constructed as a VALUE, where
 * `callers` returned nothing at all.
 *
 * `new Foo()` matters more than it looks. `new_expression` is not in TypeScript's
 * call-type set, so a constructor call emits no `calls` edge; without this milestone
 * a same-file constructor use produced no edge of any kind.
 *
 * The scope rule here is one notch WIDER than T7's, and the difference is measured,
 * not stylistic. T7 excludes parameters only, because a nested
 * `const fn = () => {}` mints a node and its CALL resolves to it correctly. A
 * reference sits in arbitrary value position, where a plain `const total = 0`
 * shadowing a top-level `function total` reaches past the binding to the top-level
 * definition. On dailywerk: parameters-only would emit 269 edges of which 10 are
 * that mistake; excluding local declarations too emits 145 with none. Precision
 * beats recall, so the wider rule wins and the 114 correct-but-dropped references to
 * locally-declared functions are the recorded cost.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-valueref-"));

  // Never imported. Every name below also exists here, so a repo-wide name match has
  // an answer available for all of them — and must never be the one that is used.
  put(
    dir,
    "decoys/mocks.ts",
    `export function fromApi(): number { return 1 }
export function helper(): number { return 2 }
export class LocalError extends Error {}
export function total(): number { return 3 }
export function elsewhere(): number { return 4 }
export function shadowed(): number { return 5 }
export function Widget(): number { return 6 }
`,
  );

  put(
    dir,
    "values.ts",
    `export function fromApi(raw: number): number { return raw + 1 }

export class LocalError extends Error {}

export function mapAll(rows: number[]): number[] {
  return rows.map(fromApi)
}

export function boom(): never {
  throw new LocalError()
}

export function aliased(): unknown {
  const fn = fromApi
  return fn
}
`,
  );

  // The scope rule, from both sides.
  put(
    dir,
    "scoped.ts",
    `export function helper(): number { return 1 }

export function takesOne(helper: () => number): unknown {
  return helper
}

export function total(): number { return 1 }

export function shadowsWithPlainConst(): unknown {
  const total = 0
  return total
}

export function shadowsWithFunction(): unknown {
  const helper = (): number => 2
  return helper
}

export function usesNestedDeclaration(): unknown {
  function inner(): number { return 3 }
  return inner
}
`,
  );

  // Two declarations of one name in one file: ambiguous, and must drop.
  put(
    dir,
    "ambiguous.ts",
    `function shadowed(): number { return 1 }
function shadowed(): number { return 2 }

export function picks(): unknown { return shadowed }
`,
  );

  // A name this file neither declares nor imports must NOT reach the repo-wide tier.
  put(
    dir,
    "reaches.ts",
    `export function grabs(): unknown {
  return elsewhere
}
`,
  );

  // The React idiom. `Widget.displayName = 'Widget'` sits at the file's top level, so
  // its source would be the file node — which already `contains` the target.
  put(
    dir,
    "displayname.tsx",
    `export function Widget(): number { return 1 }

Widget.displayName = 'Widget'
`,
  );

  // A type position must still refuse a function of the same name.
  put(
    dir,
    "typepos.ts",
    `export function Shape(): number { return 1 }

export function annotated(v: Shape): unknown { return v }
`,
  );

  // Imports and direct calls are other paths and must be unchanged.
  put(dir, "lib.ts", "export function libFn(): number { return 1 }\n");
  put(
    dir,
    "untouched.ts",
    `import { libFn } from './lib'

export function usesImport(): unknown { return libFn }

export function localDef(): number { return 1 }

export function callsIt(): number { return localDef() }

export function reads(o: { helper: number }): number { return o.helper }
`,
  );

  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

function edgesFrom(graph: GraphV1, source: string, relation: string): EdgeV1[] {
  return graph.edges.filter((e) => e.relation === relation && e.source === source);
}

test("a same-file function passed as a value resolves", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = edgesFrom(graphOf(dir), "values.ts#mapAll", "references");
    assert.deepEqual(edges.map((e) => e.target), ["values.ts#fromApi"]);
    assert.equal(edges[0].confidence, "extracted", "the declaration is in this very file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-file class constructed with `new` resolves", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "values.ts#boom", "references").map((e) => e.target),
      ["values.ts#LocalError"],
      "new_expression is not a TS call type, so nothing else would emit this",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-file function assigned to a local resolves", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "values.ts#aliased", "references").map((e) => e.target),
      ["values.ts#fromApi"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the scope rule ----

test("a parameter shadowing a same-file function produces no edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(edgesFrom(graphOf(dir), "scoped.ts#takesOne", "references").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain local const shadowing a same-file function produces no edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "scoped.ts#shadowsWithPlainConst", "references").map((e) => e.target),
      [],
      "`const total = 0` mints no node, and reaching past it to the top-level `total` is the mistake",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local const holding a function also suppresses — the recorded recall cost", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "scoped.ts#shadowsWithFunction", "references").map((e) => e.target),
      [],
      "this one WOULD have been correct — the arrow mints a node — but a `const` " +
        "binding cannot be told from the plain-value case without duplicating the " +
        "node-minting rules, so it goes with them",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested function declaration keeps its reference", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = edgesFrom(graphOf(dir), "scoped.ts#usesNestedDeclaration", "references");
    assert.deepEqual(edges.map((e) => e.target), ["scoped.ts#usesNestedDeclaration.inner"]);
    assert.equal(edges[0].confidence, "extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- decline guards ----

test("two declarations of one name in one file are ambiguous and drop", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(edgesFrom(graphOf(dir), "ambiguous.ts#picks", "references").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name the file neither declares nor imports never reaches the repo-wide tier", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "reaches.ts#grabs", "references").map((e) => e.target),
      [],
      "decoys/mocks.ts#elsewhere is the unique repo-wide match, and is not this file's to find",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a top-level mention does not become a file-to-own-member edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "displayname.tsx", "references").map((e) => e.target),
      [],
      "`contains` already says the file holds Widget",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a type position still refuses a function of the same name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "typepos.ts#annotated", "references").map((e) => e.target),
      [],
      "`v: Shape` names a type; `function Shape` is not one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported reference is untouched", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "untouched.ts#usesImport", "references").map((e) => e.target),
      ["lib.ts#libFn"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a direct call still emits only the call, not a second reference", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);
    assert.deepEqual(
      edgesFrom(graph, "untouched.ts#callsIt", "calls").map((e) => e.target),
      ["untouched.ts#localDef"],
    );
    assert.deepEqual(
      edgesFrom(graph, "untouched.ts#callsIt", "references").map((e) => e.target),
      [],
      "one call site, one edge",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a member property position is not a reference to a same-named function", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      edgesFrom(graphOf(dir), "untouched.ts#reads", "references").map((e) => e.target),
      [],
      "`o.helper` names a property of o",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
