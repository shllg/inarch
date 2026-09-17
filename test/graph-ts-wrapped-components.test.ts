/**
 * A component built by a call is still a definition.
 *
 * The extractor records `const Arrow = () => null` as a definition and records nothing
 * at all for `const Fwd = forwardRef((props, ref) => …)`. The two declare the same
 * thing; only the second hands its body to a wrapper first. That is how a React design
 * system declares almost everything, so almost all of one goes missing: in DailyWerk,
 * 68 of the 71 `export const X = forwardRef|memo|styled(…)` components had no node
 * anywhere in the graph — Button, Alert, Badge, ChatComposer, the whole Card family.
 * 54 files render `<Alert>` and not one could be reported, because there was nothing
 * to report them against.
 *
 * The rule is narrow on purpose: the call must receive a **function literal as a
 * direct argument**. That is the evidence that a body is being declared here rather
 * than a value computed. Measured against DailyWerk, it is also the line that separates
 * the components from everything else that happens to be a call:
 *
 *   accepted   forwardRef<A, B>((props, ref) => …)      73 occurrences
 *              memo(function Inner() {…})
 *   declined   meta.story({ render: () => … })         207 — the argument is an object
 *              createContext<T>(null)                    7 — a value, not a body
 *              memo(MarkdownViewInner)                   2 — an alias; the inner
 *                                                            function is already a node
 *              createFileRoute('/path')                  9 — a string
 *              Object.assign(a, b)                       8
 *
 * A nested function inside an object argument is NOT enough. `meta.story({ render: () =>
 * … })` would otherwise make 207 Storybook stories into definitions, and the object is
 * configuration that happens to contain a callback, not a declaration of `FullPage`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

function put(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

const UI = `import { forwardRef, memo, createContext } from 'react'

export const Button = forwardRef<HTMLButtonElement, { label: string }>((props, ref) => {
  return null
})

export const Boxed = memo(function Boxed(props: { n: number }) {
  return null
})

export const Plain = () => null

export function Declared() { return null }

// Declines below. Each is a const initialised with a call, and none of them
// declares a body here.
export const ThemeContext = createContext<string | null>(null)
export const Inner = () => null
export const Aliased = memo(Inner)
export const Config = Object.assign({}, { a: 1 })
export const Route = createFileRoute('/dash')
export const Story = meta.story({ render: () => null })

// Both of these were found by MEASURING the first version of this rule, not by
// reading it. Accepting any direct function literal took dailywerk from 71 expected
// new definitions to 782.
export const authState = useMemo(() => ({ ok: true }), [])
export const { result } = renderHook(() => useThing())
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-wrapped-"));
  put(dir, "ui.tsx", UI);
  put(dir, "ui.ts", UI.replace(/return null/g, "return undefined as never"));
  put(
    dir,
    "use.tsx",
    `import { Button, Boxed, Plain, Declared } from './ui'

export function Page() {
  return <div><Button label="x" /><Boxed n={1} /><Plain /><Declared /></div>
}
`,
  );
  return dir;
}

function graphOf(dir: string): GraphV1 {
  return readGraph(wiringPath(join(dir, "graft")))!;
}

const ids = (g: GraphV1, file: string): string[] =>
  g.nodes.filter((n) => n.path === file && n.id.includes("#")).map((n) => n.id.split("#")[1]).sort();

for (const file of ["ui.tsx", "ui.ts"] as const) {
  test(`${file}: a forwardRef component is a definition`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.ok(ids(graphOf(dir), file).includes("Button"), "forwardRef declares a body here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a memo() wrapping a function literal is a definition`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.ok(ids(graphOf(dir), file).includes("Boxed"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: it is extracted as a function, like every other component form`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const button = graphOf(dir).nodes.find((n) => n.id === `${file}#Button`);
      assert.equal(button?.kind, "function");
      assert.ok((button?.signature ?? "").includes("forwardRef"), "the wrapper belongs in the header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- declines: green before this change and after ----

  test(`${file}: the forms that were already definitions are unchanged`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const got = ids(graphOf(dir), file);
      assert.ok(got.includes("Plain"), "arrow const");
      assert.ok(got.includes("Declared"), "function declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a call given a value, not a body, is not a definition`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const got = ids(graphOf(dir), file);
      for (const name of ["ThemeContext", "Config", "Route"])
        assert.ok(!got.includes(name), `${name} computes a value; it declares nothing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a wrapper around an existing name is an alias, not a definition`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const got = ids(graphOf(dir), file);
      assert.ok(!got.includes("Aliased"), "memo(Inner) has no body — Inner is the definition");
      assert.ok(got.includes("Inner"), "and Inner is still there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a lowercase name is a value or a hook, not a component`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.ok(
        !ids(graphOf(dir), file).includes("authState"),
        "useMemo(() => …) returns a VALUE; only the capital tells it apart from forwardRef",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a destructuring pattern is not a name`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      const got = ids(graphOf(dir), file);
      assert.ok(
        !got.some((n) => n.includes("{") || n.includes("result")),
        `const { result } = renderHook(…) must not become a node called "{ result }" — got ${JSON.stringify(got)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${file}: a function nested in an object argument is not enough`, async () => {
    const dir = makeFixture();
    try {
      await buildGraph(dir);
      assert.ok(
        !ids(graphOf(dir), file).includes("Story"),
        "meta.story({ render: () => … }) is configuration; accepting it makes 207 Storybook stories definitions",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// What a wrapped component is FOR — being the target of `<Button />` — cannot be
// asserted here. JSX element resolution is #389's, which is on `main` and not on
// `upstream/main` that this branch is cut from, so on this branch a JSX element
// produces no edge whatever the extractor did. The composition is pinned where it
// exists, in test/graph-ts-import-call-composition.test.ts on `main`.
