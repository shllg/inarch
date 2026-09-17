/**
 * Where an imported call's MODULE decides its target — the seam between #335 and the
 * two fixes that feed it.
 *
 * #335 gave the `calls` arm a module-aware branch: a call through a named import
 * resolves inside the module it names, or is dropped when that module is not in the
 * repo, instead of falling through to a repo-wide name match that once bound a
 * production call to a test mock. That branch only ever sees a call that reached it
 * with a specifier, and only ever resolves a module `resolveImport` can place.
 *
 * T0 supplies the first — `await f<T>(x)` parses as `(await f)<T>(x)` and produced no
 * `calls` edge at all, so #335 never saw it. T3 supplies the second — a bare specifier
 * naming an in-repo workspace package read as third-party, so #335's own guard
 * (`if (!byId.has(targetFile)) continue`) DROPPED the call.
 *
 * Neither branch can test this: #335 is not on either of them, and they are not on
 * each other. The composition exists only here, which is why these tests do.
 *
 * Every case carries a decoy — a same-named function in a file nobody imported. It is
 * what makes each assertion about the module rather than about the name: with two
 * reachable candidates, `resolveName` finds no unique match and answers nothing, so an
 * edge that arrives anyway arrived through the module.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-import-call-"));
  put(dir, "package.json", JSON.stringify({ name: "acme-monorepo", private: true }));

  // The workspace package T3 taught `resolveImport` to place.
  put(
    dir,
    "packages/runtime/package.json",
    JSON.stringify({ name: "@acme/runtime", exports: { ".": "./src/index.ts" } }),
  );
  put(
    dir,
    "packages/runtime/src/index.ts",
    `export async function apiRequest<T>(path: string): Promise<T> {
  return path as unknown as T
}
`,
  );

  // An ordinary relative module, for the T0 half.
  put(
    dir,
    "src/client.ts",
    `export async function fetchThing<T>(path: string): Promise<T> {
  return path as unknown as T
}
export async function plainFetch(path: string): Promise<string> {
  return path
}
`,
  );

  // The decoy. Same names, never imported by the caller. Its only job is to make a
  // name-based answer impossible, so that any edge we see came from the module.
  put(
    dir,
    "test-support/mocks.ts",
    `export async function apiRequest<T>(path: string): Promise<T> {
  return path as unknown as T
}
export async function fetchThing<T>(path: string): Promise<T> {
  return path as unknown as T
}
export async function plainFetch(path: string): Promise<string> {
  return path
}
`,
  );

  put(
    dir,
    "src/use.ts",
    `import { fetchThing, plainFetch } from './client'
import { apiRequest } from '@acme/runtime'

export async function viaRelativeAwaitGeneric(): Promise<string> {
  return await fetchThing<string>('/a')
}

export async function viaRelativePlain(): Promise<string> {
  return await plainFetch('/b')
}

export async function viaWorkspaceAwaitGeneric(): Promise<string> {
  return await apiRequest<string>('/c')
}
`,
  );
  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

function callsFrom(graph: GraphV1, source: string): EdgeV1[] {
  return graph.edges.filter((e) => e.relation === "calls" && e.source === source);
}

test("T0 x #335: an awaited generic call resolves inside the module it was imported from", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = callsFrom(graphOf(dir), "src/use.ts#viaRelativeAwaitGeneric");
    assert.deepEqual(
      edges.map((e) => e.target),
      ["src/client.ts#fetchThing"],
      "the decoy in test-support/ must not be reachable — this is a module answer, not a name one",
    );
    assert.equal(edges[0].confidence, "extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T0 x #335: the non-generic form was never broken and still resolves the same way", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = callsFrom(graphOf(dir), "src/use.ts#viaRelativePlain");
    assert.deepEqual(edges.map((e) => e.target), ["src/client.ts#plainFetch"]);
    assert.equal(
      edges[0].confidence,
      "extracted",
      "the control: T0's shape must land on the same confidence as the shape that always worked",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3 x #335: a call through a workspace package survives the in-repo guard", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = callsFrom(graphOf(dir), "src/use.ts#viaWorkspaceAwaitGeneric");
    assert.deepEqual(
      edges.map((e) => e.target),
      ["packages/runtime/src/index.ts#apiRequest"],
      "without T3 the bare specifier reads as third-party and #335 drops the edge outright",
    );
    assert.equal(edges[0].confidence, "extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#335's guard still holds: nothing binds to the unimported decoy", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const intoDecoy = graphOf(dir).edges.filter(
      (e) => e.relation === "calls" && e.target.startsWith("test-support/"),
    );
    assert.deepEqual(
      intoDecoy,
      [],
      "a production call binding to a test mock is the regression #335 exists to prevent",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
