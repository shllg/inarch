/**
 * `await f<T>(x)` produced no `calls` edge at all.
 *
 * tree-sitter-typescript binds `await` tighter than a type-argument list, so
 * `await target<string>(x)` parses as if it were `(await target)<string>(x)`:
 * the call's `function` field is an `await_expression` wrapping the real callee,
 * not the callee itself. `calleeName()` dispatches on that field's node type and
 * had no case for `await_expression`, so it returned null and the edge was never
 * emitted. Nothing announced the loss — the callee still surfaced as the weaker
 * `references` edge from the identifier walk, so the graph looked populated.
 *
 * Each ingredient alone is fine. `target<string>(x)`, `await target(x)` and
 * `return target<string>(x)` all produce their edge; only awaited-AND-generic
 * fails, and it fails for `await obj.m<T>(x)` and `await this.m<T>(x)` too, so
 * it costs intra-class method edges as well as free-function ones. The two
 * spellings are interchangeable to the author and were not chosen for any
 * reason — in a typed API client, which is where awaited generic calls live,
 * `const r = await api<T>(…)` is the dominant one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import type { RawEdge } from "../src/graph/extract.js";

type TsLang = "typescript" | "tsx";
const LANGS: TsLang[] = ["typescript", "tsx"];

const fileFor = (lang: TsLang) => (lang === "tsx" ? "x.tsx" : "x.ts");

function edgesOf(src: string, lang: TsLang): RawEdge[] {
  return extractFile(fileFor(lang), src, lang).rawEdges;
}

function callsTo(src: string, lang: TsLang, name: string): RawEdge[] {
  return edgesOf(src, lang).filter((e) => e.relation === "calls" && e.name === name);
}

/** The six spellings from the defect report: three that always worked, three that
 * did not. Only the awaited-generic combination was ever broken, which is why the
 * working three are asserted here too — they are the control. */
const SPELLINGS: Array<[label: string, body: string]> = [
  ["generic, returned", "return target<string>(x);"],
  ["generic, assigned", "const r = target<string>(x); return r;"],
  ["awaited, no type argument", "const r = await target(x); return r;"],
  ["awaited generic, assigned", "const r = await target<string>(x); return r;"],
  ["awaited generic, statement", "await target<void>(x);"],
  ["awaited generic, returned", "return await target<string>(x);"],
];

for (const lang of LANGS) {
  for (const [label, body] of SPELLINGS) {
    test(`${lang}: ${label} — calls edge to target`, () => {
      const src = `async function caller(x: string) {\n  ${body}\n}\n`;
      const calls = callsTo(src, lang, "target");
      assert.equal(calls.length, 1, `expected exactly one calls edge for: ${body}`);
      assert.equal(calls[0].source, `${fileFor(lang)}#caller`);
      assert.equal(calls[0].viaMember, false);
    });
  }

  // Two type arguments exercise a different `type_arguments` shape; the grammar
  // treats it the same way and so must the unwrap.
  test(`${lang}: two type arguments are still one call`, () => {
    const src = 'async function caller(x: string) {\n  await target<A, B>(x);\n}\n';
    assert.equal(callsTo(src, lang, "target").length, 1);
  });

  test(`${lang}: awaited generic member call keeps the receiver typing it already had`, () => {
    // `svc` is bound to Svc by the constructor assignment; the awaited generic form
    // must reach the same binding table the non-generic form reaches.
    const src = [
      "class Store {",
      "  svc: Svc = new Svc();",
      "  async load(): Promise<void> {",
      "    await this.svc.fetch<Payload>('/a');",
      "    await this.reload<Payload>();",
      "  }",
      "  async reload<T>(): Promise<void> {}",
      "}",
      "",
    ].join("\n");
    const fetchCall = callsTo(src, lang, "fetch")[0];
    assert.ok(fetchCall, "no calls edge for the awaited generic member call");
    assert.equal(fetchCall.viaMember, true);
    assert.equal(fetchCall.recvType, "Svc");

    const reloadCall = callsTo(src, lang, "reload")[0];
    assert.ok(reloadCall, "no calls edge for the awaited generic `this` call");
    assert.equal(reloadCall.viaMember, true);
    assert.equal(reloadCall.recvType, "Store");
  });

  test(`${lang}: type arguments change nothing about the edge`, () => {
    // The strongest form of the contract: the awaited generic call and its
    // non-generic twin must produce byte-identical edges. Anything the unwrap
    // changed about resolution — receiver, member flag, attribution — shows up
    // here rather than needing its own assertion.
    const body = (call: string) =>
      [
        "class Store {",
        "  svc: Svc = new Svc();",
        "  async load(): Promise<void> {",
        `    await ${call};`,
        "  }",
        "}",
        "",
      ].join("\n");
    const generic = callsTo(body("this.svc.fetch<Payload>('/a')"), lang, "fetch");
    const plain = callsTo(body("this.svc.fetch('/a')"), lang, "fetch");
    assert.deepEqual(generic, plain);
  });

  test(`${lang}: a shadowed callee behaves the same awaited or not`, () => {
    // T0 must change which calls are REACHED, never how a reached call resolves.
    // A local binding shadowing an import is where those two could come apart —
    // it is the case #330 turned on — so the awaited generic spelling is pinned
    // against its non-generic twin rather than against a literal expectation.
    const src = (call: string) =>
      [
        'import { target } from "./api.js";',
        "async function caller(x: string) {",
        "  const target = (v: string) => v;",
        `  return ${call};`,
        "}",
        "",
      ].join("\n");
    assert.deepEqual(
      callsTo(src("await target<string>(x)"), lang, "target"),
      callsTo(src("await target(x)"), lang, "target"),
    );
  });

  test(`${lang}: an unknowable receiver stays unknowable`, () => {
    // `a.b.c<T>()` is a chain with no local clue. The edge must exist — that is the
    // fix — but recvType must stay unset rather than being guessed at, so resolve
    // drops it instead of binding it wrongly.
    const src = "async function caller() {\n  await a.b.c<T>(1);\n}\n";
    const call = callsTo(src, lang, "c")[0];
    assert.ok(call, "no calls edge for the chained awaited generic call");
    assert.equal(call.viaMember, true);
    assert.equal(call.recvType, undefined);
  });

  test(`${lang}: the awaited generic callee is not also a reference`, () => {
    // Before the fix the identifier walk was the only witness, so `target` came
    // back as a `references` edge. Now the call edge carries it and the reference
    // must not be emitted beside it — exactly as for the non-awaited spelling,
    // where the identifier IS the call's `function` field.
    const src = [
      'import { target } from "./api.js";',
      "async function caller(x: string) {",
      "  await target<string>(x);",
      "}",
      "",
    ].join("\n");
    const edges = edgesOf(src, lang);
    assert.equal(edges.filter((e) => e.relation === "calls" && e.name === "target").length, 1);
    assert.equal(edges.filter((e) => e.relation === "references" && e.name === "target").length, 0);
  });

  test(`${lang}: an awaited value that is never called is still a reference`, () => {
    // The guard on the line above: seeing through `await` must not swallow the
    // references edge for an awaited identifier that is not a callee at all.
    const src = [
      'import { pending } from "./api.js";',
      "async function caller() {",
      "  const v = await pending;",
      "  return v;",
      "}",
      "",
    ].join("\n");
    const edges = edgesOf(src, lang);
    assert.equal(edges.filter((e) => e.relation === "calls" && e.name === "pending").length, 0);
    assert.equal(edges.filter((e) => e.relation === "references" && e.name === "pending").length, 1);
  });

  test(`${lang}: await new F<T>(x) is unchanged — TS tracks no constructor calls`, () => {
    // Documented, not fixed. `new F<T>(x)` is a `new_expression` with a null
    // `function` field, and `new_expression` is not in TypeScript's CALL_TYPES at
    // all, so no spelling of it has ever produced a call edge. Pinned here so a
    // future reader knows the omission was measured rather than missed.
    const src = "async function caller(x: string) {\n  await new F<string>(x);\n}\n";
    assert.equal(callsTo(src, lang, "F").length, 0);
  });
}
