/**
 * A TypeScript type annotation is a use of the type it names, and must produce a
 * `references` edge to it.
 *
 * Every TypeScript type position produces a `type_identifier`, never an `identifier`,
 * and the reference walk keyed on `identifier` alone — so before this a file's type
 * dependencies were invisible. Not a resolution failure: nothing was extracted to
 * resolve.
 *
 * The declines are the other half and have their own tests: a local type, a generic
 * parameter, a qualified `NS.Type`, and a heritage clause that already carries its
 * own relation. Each is a position where a plausible-looking edge would be the wrong
 * one, which is the failure mode this resolver exists to refuse.
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

/** The same source in both dialects, so every case is asserted for `typescript` and
 * for `tsx`. `use.ts` and `use.tsx` are byte-identical apart from the extension. */
const USE = `import type { TaskRecord, TaskInput } from './types'
import type * as NS from './ns'
import { type MixedType, mixedHelper } from './mixed'
import { BaseErr } from './types'

interface LocalOnly { n: number }

export async function t1ReturnType(): Promise<TaskRecord> { return null as any }

export function t2ParamType(input: TaskInput): string { return String(input) }

export function t3LocalAnnot(): string {
  const r: TaskRecord = null as any
  return String(r)
}

export function t4Local(v: LocalOnly): string { return String(v) }

export function t5Generic<T>(x: T): T { return x }

export function t6Qualified(x: NS.TaskRecord): string { return String(x) }

export function t7InlineTypeModifier(m: MixedType): string { return mixedHelper(m) }

export class Sub extends BaseErr implements TaskInput { name = 'x' }
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-ts-types-"));
  put(
    dir,
    "types.ts",
    `export interface TaskRecord { id: string }
export interface TaskInput { name: string }
export class BaseErr extends Error {}
`,
  );
  // The collision: a second module exporting the very same type name. If resolution
  // ever fell back to a repo-wide unique name, this is what would make it wrong.
  put(dir, "other.ts", "export interface TaskRecord { somethingElse: number }\n");
  put(dir, "ns.ts", "export interface TaskRecord { viaNamespace: boolean }\n");
  put(
    dir,
    "mixed.ts",
    `export interface MixedType { k: string }
export function mixedHelper(m: MixedType): string { return m.k }
`,
  );
  put(dir, "use.ts", USE);
  put(dir, "use.tsx", USE);
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
  test(`${file}: a return type annotation references the type`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      const edges = refsFrom(graph, `${file}#t1ReturnType`);
      assert.deepEqual(
        edges.map((e) => e.target),
        ["types.ts#TaskRecord"],
        "Promise<TaskRecord> should reference TaskRecord and nothing else — Promise is not imported",
      );
      assert.equal(edges[0].confidence, "extracted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a parameter type annotation references the type`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.deepEqual(
        refsFrom(graph, `${file}#t2ParamType`).map((e) => e.target),
        ["types.ts#TaskInput"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a local variable's type annotation references the type`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.deepEqual(
        refsFrom(graph, `${file}#t3LocalAnnot`).map((e) => e.target),
        ["types.ts#TaskRecord"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: the edge honours the import specifier, not a unique name`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      // `TaskRecord` is defined in three files. The importing file named one.
      const defs = graph.nodes.filter((n) => n.id.endsWith("#TaskRecord"));
      assert.equal(defs.length, 3, "the fixture must keep three same-named types");
      for (const source of [`${file}#t1ReturnType`, `${file}#t3LocalAnnot`]) {
        const targets = refsFrom(graph, source).map((e) => e.target);
        assert.deepEqual(targets, ["types.ts#TaskRecord"]);
        assert.ok(!targets.includes("other.ts#TaskRecord"));
        assert.ok(!targets.includes("ns.ts#TaskRecord"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Was a decline when T1 landed, and is deliberately inverted by T4. T1 had no way
  // to resolve a name that reaches the walk without an import, so emitting an edge
  // here would have been a guess; T4 resolves it against this file's own unique
  // declaration, which is evidence rather than a guess. The decline it was guarding —
  // a name this file neither imports nor declares — is still a decline, and now has
  // its own test in graph-ts-same-file-type-references.test.ts.
  test(`${file}: a type declared in this file references its local declaration`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.deepEqual(
        refsFrom(graph, `${file}#t4Local`).map((e) => e.target),
        [`${file}#LocalOnly`],
        "LocalOnly is declared in this file, uniquely — T4 binds it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a generic type parameter produces no edge`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      assert.deepEqual(
        refsFrom(graph, `${file}#t5Generic`).map((e) => e.target),
        [],
        "T is declared by the signature, never imported",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a qualified NS.Type produces no edge for its tail`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      // `TaskRecord` IS in this file's import map, from './types'. In `NS.TaskRecord`
      // it names a member of NS instead, so emitting an edge would bind the wrong
      // module's type — right name, wrong owner.
      assert.deepEqual(
        refsFrom(graph, `${file}#t6Qualified`).map((e) => e.target),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: an inline 'type' modifier in a named import still binds`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      // `import { type MixedType, mixedHelper }` — the import_specifier's text is
      // "type MixedType", and only its `name` field is the binding. If the keyword
      // leaked into the key the type would be recorded under "type MixedType" and
      // never match a use.
      assert.deepEqual(
        refsFrom(graph, `${file}#t7InlineTypeModifier`).map((e) => e.target),
        ["mixed.ts#MixedType"],
      );
      const call = graph.edges.find(
        (e) =>
          e.relation === "calls" &&
          e.source === `${file}#t7InlineTypeModifier` &&
          e.target === "mixed.ts#mixedHelper",
      );
      assert.ok(call, "the value imported beside it must still resolve as a call");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a heritage clause gains no second edge`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const graph = graphOf(dir);
      const fromSub = graph.edges.filter((e) => e.source === `${file}#Sub`);

      assert.ok(
        fromSub.some((e) => e.relation === "extends" && e.target === "types.ts#BaseErr"),
        "extends BaseErr",
      );
      assert.ok(
        fromSub.some((e) => e.relation === "implements" && e.target === "types.ts#TaskInput"),
        "implements TaskInput",
      );

      // `implements Iface` names its type with a `type_identifier`. It must NOT also
      // become a reference, or every implemented interface would carry two edges.
      assert.ok(
        !fromSub.some((e) => e.relation === "references" && e.target === "types.ts#TaskInput"),
        "implements must not also emit a references edge",
      );

      // `extends Base` names its class with an `identifier`, so it has carried a
      // references edge beside the extends edge since long before this change. That
      // is pre-existing behaviour and this test pins it rather than altering it.
      assert.ok(
        fromSub.some((e) => e.relation === "references" && e.target === "types.ts#BaseErr"),
        "the pre-existing extends/references pair is unchanged",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
