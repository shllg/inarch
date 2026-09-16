/**
 * A bare import specifier that names an in-repo workspace package must resolve to the
 * file it imports, not be filed as third-party.
 *
 * The monorepo shape these cover is the common one: several `package.json` files under
 * `packages/`, each declaring a name and an `exports` map whose subpaths bear no
 * relation to the paths they point at (`./api` → `./src/services/api.ts`). Before this,
 * `resolveImport` returned any non-relative specifier unchanged, so every `imports` edge
 * through such a specifier pointed at a phantom string and every `references` edge
 * through one was dropped as external.
 *
 * The declines matter as much as the resolutions, and have their own tests below: a
 * genuinely third-party package, a subpath the `exports` map does not offer, and a
 * Python import that happens to share a package's name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

/** Write a file and every directory above it. */
function put(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/**
 * A monorepo with four in-repo packages, each covering one resolution rule:
 * `@acme/runtime` an explicit `exports` map, `@acme/ui` the classic `main` layout,
 * `@acme/ui-icons` a wildcard subpath (and the name-prefix collision with `@acme/ui`),
 * and `analytics` an unscoped name a Python import can collide with.
 */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-workspace-"));

  put(dir, "package.json", JSON.stringify({ name: "acme-monorepo", private: true }));

  put(
    dir,
    "packages/runtime/package.json",
    JSON.stringify({
      name: "@acme/runtime",
      exports: { ".": "./src/index.ts", "./api": "./src/services/api.ts" },
    }),
  );
  put(
    dir,
    "packages/runtime/src/services/api.ts",
    `export class ApiError extends Error {}

export function apiRequest(path: string): Promise<string> {
  return Promise.resolve(path)
}
`,
  );
  put(dir, "packages/runtime/src/index.ts", "export const RUNTIME_VERSION = '1'\n");
  // Reachable on disk, deliberately absent from the exports map.
  put(dir, "packages/runtime/src/secret.ts", "export function internalOnly(): void {}\n");

  put(
    dir,
    "packages/ui/package.json",
    JSON.stringify({ name: "@acme/ui", main: "src/main.ts" }),
  );
  put(dir, "packages/ui/src/main.ts", "export function mount(): void {}\n");
  put(dir, "packages/ui/src/button.tsx", "export function Button() { return null }\n");

  put(
    dir,
    "packages/ui-icons/package.json",
    JSON.stringify({ name: "@acme/ui-icons", exports: { "./*": "./src/*.ts" } }),
  );
  put(dir, "packages/ui-icons/src/star.ts", "export function Star(): string { return '*' }\n");

  put(dir, "analytics/package.json", JSON.stringify({ name: "analytics", main: "index.js" }));
  put(dir, "analytics/index.js", "export function track() {}\n");

  put(
    dir,
    "app/src/tasks.ts",
    `import { apiRequest, ApiError } from '@acme/runtime/api'
import { RUNTIME_VERSION } from '@acme/runtime'
import { mount } from '@acme/ui'
import { Button } from '@acme/ui/src/button'
import { Star } from '@acme/ui-icons/star'
import { internalOnly } from '@acme/runtime/secret'
import { useEffect } from 'react'

export function loadTasks(): Promise<string> {
  return apiRequest('/tasks')
}

export function isApiError(e: unknown): boolean {
  return e instanceof ApiError
}

export function boot(): string {
  mount()
  useEffect()
  internalOnly()
  return RUNTIME_VERSION + Button + Star
}
`,
  );

  put(dir, "tools/report.py", "import analytics\n\ndef run():\n    return analytics\n");

  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

function importTarget(graph: GraphV1, source: string, target: string): boolean {
  return graph.edges.some(
    (e) => e.relation === "imports" && e.source === source && e.target === target,
  );
}

test("workspace package: an exports subpath resolves to the file it names", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    // `./api` → `./src/services/api.ts`, a mapping no path arithmetic could guess.
    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "packages/runtime/src/services/api.ts"),
      "@acme/runtime/api should resolve through the exports map",
    );
    // The root subpath.
    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "packages/runtime/src/index.ts"),
      "@acme/runtime should resolve to the '.' export",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: the classic main/path layout resolves without exports", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "packages/ui/src/main.ts"),
      "@acme/ui should resolve to its `main`",
    );
    // No exports map, so a subpath is a path under the package — and the extension
    // ladder supplies the `.tsx` the specifier omits.
    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "packages/ui/src/button.tsx"),
      "@acme/ui/src/button should resolve by path join",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: a wildcard subpath resolves, and the longer name wins", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    // `@acme/ui-icons` also starts with `@acme/ui`; the longest name must claim it,
    // or `star` would be looked for under packages/ui as `-icons/star`.
    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "packages/ui-icons/src/star.ts"),
      "@acme/ui-icons/star should resolve through the './*' pattern",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: a named import resolves its references edge inside the package", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    const ref = graph.edges.find(
      (e) =>
        e.relation === "references" &&
        e.target === "packages/runtime/src/services/api.ts#ApiError",
    );
    assert.ok(ref, "ApiError should be referenced in the package file that defines it");
    assert.equal(ref?.confidence, "extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: a subpath the exports map does not offer stays external", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    // packages/runtime/src/secret.ts exists and is indexed, so this is not a
    // file-not-found decline: `exports` simply does not offer `./secret`, and Node
    // would refuse the import too. Resolving it would invent an edge the importing
    // code cannot actually traverse.
    assert.ok(
      graph.nodes.some((n) => n.id === "packages/runtime/src/secret.ts"),
      "the unexported file should still be indexed",
    );
    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "@acme/runtime/secret"),
      "an unexported subpath should stay the raw specifier",
    );
    assert.ok(
      !graph.edges.some((e) => e.target === "packages/runtime/src/secret.ts"),
      "nothing should resolve into a file the exports map hides",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: a third-party package is still third-party", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    assert.ok(
      importTarget(graph, "app/src/tasks.ts", "react"),
      "react should remain an external package string",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace package: a Python import is not resolved by a same-named package", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const graph = graphOf(dir);

    // `analytics/package.json` names a real in-repo package, but a Python `import
    // analytics` means a Python module and has nothing to do with it. The workspace
    // map is JavaScript/TypeScript-only for exactly this reason.
    assert.ok(
      importTarget(graph, "tools/report.py", "analytics"),
      "the Python import should stay an unresolved module string",
    );
    assert.ok(
      !importTarget(graph, "tools/report.py", "analytics/index.js"),
      "a Python import must not reach a JavaScript package by name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
