/**
 * A name bound by a parameter or a local declaration is not a repository symbol.
 *
 * `await onSubmit?.(values)` inside a React component is a call to a PROP — declared
 * in the component's own props type and destructured out of its parameter. There is
 * no definition of it anywhere in the repository, and the only correct answer is no
 * edge. Resolution used to answer it anyway: a bare name with no specifier goes
 * around #335's module gate straight into `resolveName`'s repo-wide unique-name tier,
 * which bound production code to a Storybook story's `onSubmit` method and reported
 * it at `inferred` (corpus entry dw-h11-032).
 *
 * The fix is not a better guess, it is refusing to reach the guess: if the callee's
 * name is lexically bound between the call site and the module's top level, the call
 * is to that binding, and extraction emits nothing. Top-level bindings are excluded
 * deliberately — those DO produce nodes, and suppressing them would throw away the
 * same-file `extracted` answers T4 was built to get.
 *
 * Every fixture puts a decoy definition of the same name in a module nobody imports,
 * so any edge that arrives at all arrived through the repo-wide fallback this
 * milestone closes.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-localbind-"));

  // Nobody imports this. Every name a fixture calls has exactly one definition here,
  // so the repo-wide unique-name tier has an answer to give for all of them.
  put(
    dir,
    "decoys/mocks.ts",
    `export function onSubmit(): number { return 1 }
export function submit(): number { return 2 }
export function cb(): number { return 3 }
export function notify(): number { return 4 }
export function save(): number { return 5 }
export function onSave(): number { return 6 }
export function handle(): number { return 7 }
export function each(): number { return 8 }
export function rest(): number { return 9 }
export function later(): number { return 10 }
`,
  );

  // The measured shape: a prop, declared in the props type and destructured out of
  // the component's parameter, then called with an optional call.
  put(
    dir,
    "props.tsx",
    `interface FormProps { onSubmit?: (v: number) => void; onSave?: () => void }

export function Form({ onSubmit, onSave = () => {} }: FormProps): number {
  void onSubmit?.(1)
  void onSave()
  return 0
}
`,
  );

  // Renamed destructuring, and a nested pattern.
  put(
    dir,
    "patterns.ts",
    `export function renamed({ onSubmit: submit }: { onSubmit: () => void }): void {
  submit()
}

export function nested({ handlers: { save } }: { handlers: { save: () => void } }): void {
  save()
}

export function rested({ ...rest }: { rest?: unknown }): void {
  void rest
}
`,
  );

  // A plain parameter, an arrow parameter, and a catch binding.
  put(
    dir,
    "params.ts",
    `export function run(cb: () => void): void {
  cb()
}

export const runArrow = (each: () => void): void => {
  each()
}

export function guarded(): void {
  try {
    throw new Error("x")
  } catch (handle) {
    handle()
  }
}
`,
  );

  // Nested declarations DO mint nodes — `locals.ts#withLocal.notify` is a real node,
  // so these calls resolve same-file at `extracted` and must survive untouched. This
  // is why the rule is parameters only: a parameter is the binding form that provably
  // never mints one.
  put(
    dir,
    "locals.ts",
    `export function withLocal(): void {
  const notify = (): void => {}
  notify()
}

export function withLater(): void {
  later()
  function later(): void {}
}
`,
  );

  // ---- decline guards: every one of these must keep its edge ----

  // A same-file top-level definition. T4's `extracted` answer lives here.
  put(
    dir,
    "samefile.ts",
    `export function validate(): number { return 1 }

const helper = (): number => 2

export function usesBoth(): number {
  return validate() + helper()
}
`,
  );

  // A binding in a SIBLING function must not suppress anything, and a binding in a
  // NESTED function must not suppress the enclosing scope's own call.
  put(
    dir,
    "scoping.ts",
    `export function bindsIt(save: () => void): void {
  save()
}

export function callsTheRealOne(): void {
  save()
}

export function outer(): void {
  save()
  const inner = (save: () => void): void => {
    save()
  }
  void inner
}
`,
  );

  // Imported and member calls are a different path entirely and must be untouched.
  put(dir, "api.ts", "export function fetchIt(): number { return 1 }\n");
  put(
    dir,
    "untouched.ts",
    `import { fetchIt } from './api'

export function viaImport(): number { return fetchIt() }

export function viaMember(o: { onSubmit: () => number }): number { return o.onSubmit() }
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

test("a destructured prop called with an optional call produces no edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = callsFrom(graphOf(dir), "props.tsx#Form");
    assert.deepEqual(
      edges.map((e) => e.target),
      [],
      "onSubmit and onSave are props; the repository defines neither",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a destructured prop with a default value produces no edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.ok(
      !callsFrom(graphOf(dir), "props.tsx#Form").some((e) => e.target.endsWith("#onSave")),
      "`onSave = () => {}` is still a binding, not a reference to a repo symbol",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a renamed destructuring binds the local name, not the property name", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "patterns.ts#renamed").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested destructuring pattern binds too", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "patterns.ts#nested").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain parameter call produces no edge", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "params.ts#run").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an arrow function's parameter binds as well as a declaration's", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "params.ts#runArrow").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a catch clause binding is a parameter too", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "params.ts#guarded").map((e) => e.target), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested const holding a function keeps its edge — it mints a node", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const edges = callsFrom(graphOf(dir), "locals.ts#withLocal");
    assert.deepEqual(edges.map((e) => e.target), ["locals.ts#withLocal.notify"]);
    assert.equal(edges[0].confidence, "extracted", "same-file, and the node is right there");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nested function declaration keeps its edge, including when called above it", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      callsFrom(graphOf(dir), "locals.ts#withLater").map((e) => e.target),
      ["locals.ts#withLater.later"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- decline guards ----

test("a same-file top-level definition still resolves", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    const targets = callsFrom(graphOf(dir), "samefile.ts#usesBoth").map((e) => e.target).sort();
    assert.deepEqual(targets, ["samefile.ts#helper", "samefile.ts#validate"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a top-level definition is not suppressed by a binding in another function", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      callsFrom(graphOf(dir), "scoping.ts#callsTheRealOne").map((e) => e.target),
      ["decoys/mocks.ts#save"],
      "bindsIt's parameter is not in scope here; the repo-wide answer is unchanged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a binding in a nested function does not suppress the enclosing scope's call", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(
      callsFrom(graphOf(dir), "scoping.ts#outer").map((e) => e.target),
      ["decoys/mocks.ts#save"],
      "only the inner arrow's own `save()` is bound",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported call is untouched", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.deepEqual(callsFrom(graphOf(dir), "untouched.ts#viaImport").map((e) => e.target), [
      "api.ts#fetchIt",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a member call is untouched", async () => {
  const dir = makeFixture();
  try {
    await buildGraph(dir);
    assert.ok(
      callsFrom(graphOf(dir), "untouched.ts#viaMember").length >= 0,
      "o.onSubmit() is a member call and never took the bare-name path",
    );
    assert.ok(
      !callsFrom(graphOf(dir), "untouched.ts#viaMember").some((e) =>
        e.target.startsWith("decoys/"),
      ),
      "and it must not pick up a decoy either",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
