import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveExtension, enrichWithExtensions, extensionFingerprint, extensionRuns, listExtensions, mergeExtensionContribution, revokeExtension } from "../src/graph/extensions.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraph, formatGraphCheckReport } from "../src/graph/check.js";
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from "../src/graph/refresh.js";
import { extensionInputsChanged, fingerprintPath, isClean, probeDrift, readFingerprint } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import { callTool } from "../src/mcp/tools.js";
import { chmodDenialUnavailable } from "./helpers.js";
import { federateCheck, writeWorkspace } from "../src/graph/workspace.js";

function fixture(t: { after(fn: () => void): void }) {
  const base = mkdtempSync(join(tmpdir(), "graft-extensions-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo"), pkg = join(base, "package"), stateDir = join(base, "state");
  mkdirSync(repo); mkdirSync(pkg);
  writeFileSync(join(repo, "a.ts"), "export function a() {}\n");
  writeFileSync(join(repo, "b.ts"), "export function b() {}\n");
  writeFileSync(join(pkg, "entry.mjs"), "import './helper.mjs'; export default () => ({});\n");
  writeFileSync(join(pkg, "helper.mjs"), "export const value = 1;\n");
  return { repo, pkg, stateDir, entry: join(pkg, "entry.mjs") };
}

function graph(): GraphV1 {
  const node = (name: string): NodeV1 => ({ id: `${name}.ts#${name}`, name, kind: "function", path: `${name}.ts`, span: "L1-L1", signature: null, exported: true, origin: "ast", body_hash: "original", summary_state: "ready", summary: "keep this", crux: { code: "original", span: "L1-L1" } });
  return { meta: { version: 1, nodeCount: 2, edgeCount: 1, languages: ["typescript"] }, nodes: [node("a"), node("b")], edges: [{ source: "a.ts#a", target: "b.ts#b", relation: "calls", confidence: "extracted" }] };
}
const provenance = { id: "a".repeat(64), digest: "b".repeat(64) };

test("project configuration cannot register executable code", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, ".inarch"));
  writeFileSync(join(f.repo, ".inarch/config.json"), JSON.stringify({ extensions: [f.entry] }));
  assert.deepEqual(listExtensions(f.repo, { stateDir: f.stateDir }), []);
  assert.throws(() => approveExtension(f.repo, f.entry, {}, { stateDir: join(f.repo, ".inarch") }), /outside|repository/);
});

test("approval covers imported helpers and configuration, with canonical repository identity", (t) => {
  const f = fixture(t), options = { stateDir: f.stateDir };
  const before = extensionFingerprint(f.repo, options);
  const grant = approveExtension(f.repo, f.entry, { roots: ["src"], client: { name: "request" } }, options);
  const approved = extensionFingerprint(f.repo, options);
  assert.notEqual(approved, before);
  assert.equal(listExtensions(f.repo, options)[0].status, "ready");
  const entryBytes = readFileSync(f.entry, "utf8");
  writeFileSync(join(f.pkg, "helper.mjs"), "export const value = 2;\n");
  assert.equal(readFileSync(f.entry, "utf8"), entryBytes);
  assert.equal(listExtensions(f.repo, options)[0].status, "changed");
  assert.notEqual(extensionFingerprint(f.repo, options), approved);
  const alias = join(f.repo, "..", "alias");
  symlinkSync(f.repo, alias);
  assert.equal(listExtensions(alias, options)[0].id, grant.id);
  revokeExtension(alias, grant.id, options);
  assert.deepEqual(listExtensions(f.repo, options), []);
});

test("registration rejects symlinked package dependencies", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.repo, "a.ts"), join(f.pkg, "unsafe.mjs"));
  assert.throws(() => approveExtension(f.repo, f.entry, {}, { stateDir: f.stateDir }), /symlink/);
});

test("a valid contribution is added with host provenance and preserves nested core data", (t) => {
  const f = fixture(t), g = graph(), before = structuredClone(g);
  const result = mergeExtensionContribution(g, { edges: [{ source: "b.ts#b", target: "a.ts#a", relation: "serves", confidence: "lsp_resolved", origin: "ast", extension: "forged", via: "GET /a" }] }, provenance, f.repo);
  assert.deepEqual(result, { nodes: 0, edges: 1 });
  assert.deepEqual(g.nodes, before.nodes);
  assert.deepEqual(g.edges[0], before.edges[0]);
  assert.deepEqual(g.edges[1], { source: "b.ts#b", target: "a.ts#a", relation: "serves", confidence: "extension", origin: "extension", extension: provenance.id, extensionDigest: provenance.digest, via: "GET /a" });
});

test("conditional dispatch and asynchronous extension relations preserve provenance", (t) => {
  const f = fixture(t), g = graph();
  const result = mergeExtensionContribution(g, { edges: [
    { source: "a.ts#a", target: "b.ts#b", relation: "dispatches", via: "possible registry key" },
    { source: "b.ts#b", target: "a.ts#a", relation: "enqueues", via: "literal schedule" },
  ] }, provenance, f.repo);
  assert.equal(result.edges, 2);
  assert.deepEqual(g.edges.slice(1).map(e => e.relation), ["dispatches", "enqueues"]);
  assert.ok(g.edges.slice(1).every(e => e.origin === "extension" && e.confidence === "extension" && e.extensionDigest === provenance.digest));
});

test("one dangling edge rejects the entire contribution without changing the core graph", (t) => {
  const f = fixture(t), g = graph(), before = structuredClone(g);
  assert.throws(() => mergeExtensionContribution(g, { edges: [{ source: "b.ts#b", target: "a.ts#a", relation: "serves" }, { source: "a.ts#a", target: "missing", relation: "references" }] }, provenance, f.repo), /endpoint/);
  assert.deepEqual(g, before);
});

test("node collisions, deletion requests and false spans are rejected atomically", (t) => {
  const f = fixture(t);
  for (const payload of [
    { nodes: [graph().nodes[0]] },
    { deleteNodes: ["a.ts#a"] },
    { nodes: [{ id: "a.ts#extra", name: "extra", kind: "method", path: "a.ts", span: "L1-L50" }] },
    { nodes: [{ id: "../outside#extra", name: "extra", kind: "method", path: "../outside", span: "L1-L1" }] },
  ]) {
    const g = graph(), before = structuredClone(g);
    assert.throws(() => mergeExtensionContribution(g, payload, provenance, f.repo));
    assert.deepEqual(g, before);
  }
});

test("new nodes may be targeted within the same contribution but cannot smuggle a meaning layer", (t) => {
  const f = fixture(t), g = graph();
  const counts = mergeExtensionContribution(g, { nodes: [{ id: "a.ts#extra", name: "extra", kind: "function", path: "a.ts", span: "L1-L1", summary: "injected", summary_state: "ready", crux: { code: "injected" } }], edges: [{ source: "b.ts#b", target: "a.ts#extra", relation: "serves" }] }, provenance, f.repo);
  assert.deepEqual(counts, { nodes: 1, edges: 1 });
  assert.equal(g.nodes[2].origin, "extension");
  assert.equal(g.nodes[2].summary, null);
  assert.equal(g.nodes[2].summary_state, "pending");
  assert.equal(g.nodes[2].crux, null);
  assert.notEqual(g.nodes[2].body_hash, "original");
});

test("duplicate core edges preserve original confidence and do not inflate counts", (t) => {
  const f = fixture(t), g = graph(), before = structuredClone(g);
  assert.deepEqual(mergeExtensionContribution(g, { edges: [g.edges[0], g.edges[0]] }, provenance, f.repo), { nodes: 0, edges: 0 });
  assert.deepEqual(g, before);
});

test("extension nodes cannot make the host read excluded source or symlinks", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".env"), "SYNTHETIC_SECRET=fixture-only\n");
  symlinkSync(join(f.repo, "a.ts"), join(f.repo, "alias.ts"));
  for (const path of [".env", "alias.ts"]) {
    const g = graph(), before = structuredClone(g);
    assert.throws(() => mergeExtensionContribution(g, { nodes: [{ id: `${path}#extra`, name: "extra", kind: "variable", path, span: "L1-L1" }] }, provenance, f.repo));
    assert.deepEqual(g, before);
  }
});

test("normal builds and query refresh honor approval, helper changes and revocation", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  const current = () => readGraph(wiringPath(out)) as GraphV1;
  await buildGraph(f.repo, { contextDir: out });
  const core = structuredClone(current());
  writeFileSync(f.entry, "import { target } from './helper.mjs'; export default ctx => ({edges:[{source:'a.ts#a',target,relation:'serves'}]});\n");
  writeFileSync(join(f.pkg, "helper.mjs"), "export const target = 'b.ts#b';\n");
  const grant = approveExtension(f.repo, f.entry);
  assert.deepEqual(probeDrift(f.repo, out)?.changed, ["[extensions]"]);
  const first = await buildGraph(f.repo, { contextDir: out });
  if (first.extensionRuns?.[0]?.status === "skipped") { t.skip(first.extensionRuns[0].reason); return; }
  assert.equal(first.extensionRuns?.[0]?.status, "ok", JSON.stringify(first.extensionRuns));
  assert.equal(current().edges.filter(e => e.relation === "serves").length, 1);
  assert.deepEqual(current().nodes, core.nodes);
  const enriched = readFileSync(wiringPath(out), "utf8");
  await buildGraph(f.repo, { contextDir: out });
  assert.equal(readFileSync(wiringPath(out), "utf8"), enriched);
  assert.ok(isClean(probeDrift(f.repo, out)!));
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);

  writeFileSync(join(f.pkg, "helper.mjs"), "export const target = 'a.ts#a';\n");
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, false, "check must report extension package drift even if core nodes are unchanged");
  const changed = await ensureFreshGraph(f.repo, { contextDir: out });
  assert.equal(changed.refreshed, true);
  assert.deepEqual(current().edges, core.edges, "changed package removes old edges without executing new bytes");
  approveExtension(f.repo, f.entry);
  await ensureFreshGraph(f.repo, { contextDir: out });
  assert.ok(current().edges.some(e => e.relation === "serves" && e.target === "a.ts#a"));
  revokeExtension(f.repo, grant.id);
  await ensureFreshGraph(f.repo, { contextDir: out });
  assert.deepEqual(current(), core);
});

test("check validates extension node source spans without rerunning the extension", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(join(f.repo, "routes.json"), '{"route":"first"}\n');
  writeFileSync(f.entry, "export default () => ({nodes:[{id:'routes.json#route',path:'routes.json',span:'L1-L1',name:'route',kind:'constant'}]});\n");
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") { t.skip(built.extensionRuns[0].reason); return; }
  assert.equal(built.extensionRuns?.[0]?.status, "ok", JSON.stringify(built.extensionRuns));
  const runs = extensionRuns(f.repo).length;
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
  writeFileSync(join(f.repo, "routes.json"), '{"route":"second"}\n');
  const changed = await checkGraph(f.repo, { contextDir: out });
  assert.deepEqual(changed.changed, ["routes.json#route"]);
  assert.equal(changed.ok, false);
  rmSync(join(f.repo, "routes.json"));
  assert.deepEqual((await checkGraph(f.repo, { contextDir: out })).removed, ["routes.json#route"]);
  assert.equal(extensionRuns(f.repo).length, runs, "check must not execute approved code");
});

test("a throwing extension leaves a usable core graph and a source-free durable failure record", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default ctx => { ctx.log('SYNTHETIC_PRIVATE_LOG'); throw new Error('SYNTHETIC_PRIVATE_ERROR'); };\n");
  approveExtension(f.repo, f.entry);
  const result = await buildGraph(f.repo, { contextDir: out });
  if (result.extensionRuns?.[0]?.status === "skipped") { t.skip(result.extensionRuns[0].reason); return; }
  assert.equal(result.extensionRuns?.[0]?.status, "failed");
  assert.ok((readGraph(wiringPath(out)) as GraphV1).nodes.some(n => n.id === "a.ts#a"));
  const records = extensionRuns(f.repo);
  assert.equal((records.at(-1) as {status: string}).status, "failed");
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_PRIVATE/);
});

test("extension refresh reports isolation loss, avoids a rebuild loop and recovers without source changes", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default () => ({edges:[{source:'a.ts#a',target:'b.ts#b',relation:'serves'}]});\n");
  const grant = approveExtension(f.repo, f.entry);
  const first = await buildGraph(f.repo, { contextDir: out });
  if (first.extensionRuns?.[0]?.status === "skipped") return t.skip(first.extensionRuns[0].reason);
  assert.equal(first.extensionRuns?.[0]?.status, "ok");
  const current = () => readGraph(wiringPath(out)) as GraphV1;
  assert.equal(current().edges.filter(e => e.origin === "extension").length, 1);

  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    writeFileSync(join(f.repo, "a.ts"), "export function a() { return 1; }\n");
    const failed = await ensureFreshGraph(f.repo, { contextDir: out });
    assert.equal(failed.refreshed, true);
    assert.equal(current().edges.filter(e => e.origin === "extension").length, 0, "stale extension edges must be removed");
    assert.match(refreshNote(failed) ?? "", /extension coverage incomplete.*isolation-unavailable/);
    const checked = await checkGraph(f.repo, { contextDir: out });
    assert.equal(checked.ok, false, "source freshness cannot certify failed extension execution");
    assert.equal(checked.extensionsChanged, false, "approval and package identity did not change");
    assert.match(formatGraphCheckReport(checked), /isolation-unavailable/);
    const freshness = await callTool(f.repo, "graft_check_freshness", {}, out);
    assert.equal(freshness.isError, true);
    assert.match(freshness.text, /extension coverage incomplete.*isolation-unavailable/);

    const before = extensionRuns(f.repo).length;
    for (let i = 0; i < 3; i++) {
      const again = await ensureFreshGraph(f.repo, { contextDir: out });
      assert.equal(again.refreshed, false);
      assert.match(refreshNote(again) ?? "", /extension coverage incomplete/);
    }
    assert.equal(extensionRuns(f.repo).length, before, "cooldown must persist across calls");
    assert.match(refreshNote(await ensureFreshGraph(f.repo, { contextDir: out, disabled: true })) ?? "", /extension coverage incomplete/);
  } finally { Object.defineProperty(process, "platform", platform); }

  const fingerprint = JSON.parse(readFileSync(fingerprintPath(out), "utf8"));
  fingerprint.extensionBuild.attemptedAt -= 61_000;
  writeFileSync(fingerprintPath(out), JSON.stringify(fingerprint));
  const before = extensionRuns(f.repo).length;
  const recovered = await Promise.all([ensureFreshGraph(f.repo, { contextDir: out }), ensureFreshGraph(f.repo, { contextDir: out })]);
  assert.equal(recovered.filter(r => r.refreshed).length, 1, "concurrent recovery attempts share the graph lock");
  assert.equal(extensionRuns(f.repo).length, before + 2, "one extension execution has one start and one finish event");
  assert.ok(current().edges.some(e => e.origin === "extension" && e.extension === grant.id && e.extensionDigest === grant.digest));
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
  assert.equal(refreshNote(await ensureFreshGraph(f.repo, { contextDir: out })), null);
});

test("a legacy fingerprint cannot certify skipped extensions and a successful empty extension is healthy", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  assert.equal(built.extensionRuns?.[0]?.status, "ok");
  assert.equal(built.extensionRuns?.[0]?.edges, 0);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
  const fingerprint = JSON.parse(readFileSync(fingerprintPath(out), "utf8"));
  delete fingerprint.extensionBuild;
  fingerprint.extensionInputs = [];
  writeFileSync(fingerprintPath(out), JSON.stringify(fingerprint));
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, false);
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, false);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
});

test("workspace queries retain extension degradation even when no child rebuilds", async (t) => {
  const f = fixture(t);
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default () => { throw Error('SYNTHETIC_PRIVATE_FAILURE'); };\n");
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo);
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  assert.equal(built.extensionRuns?.[0]?.status, "failed");
  const before = extensionRuns(f.repo).length;
  for (const disabled of [false, true]) {
    const result = await ensureFreshChildren(join(f.repo, ".."), ["repo"], { disabled });
    assert.equal(result.refreshed, false);
    assert.match(refreshNote(result) ?? "", /repo: extension coverage incomplete.*extension-error/);
    assert.doesNotMatch(refreshNote(result) ?? "", /SYNTHETIC_PRIVATE/);
  }
  assert.equal(extensionRuns(f.repo).length, before);
  writeWorkspace(join(f.repo, ".."), { version: 1, children: ["repo"] });
  const checked = await federateCheck(join(f.repo, ".."));
  assert.equal(checked.ok, false);
  assert.match(checked.text, /extension coverage incomplete.*extension-error/);
  const tool = await callTool(join(f.repo, ".."), "graft_check_freshness", {});
  assert.equal(tool.isError, true);
  assert.match(tool.text, /extension coverage incomplete.*extension-error/);
});

test("an incomplete source snapshot observes the retry cooldown without certifying extension coverage", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default () => ({edges:[{source:'a.ts#a',target:'b.ts#b',relation:'serves'}]});\n");
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  const denied = t.mock.method(fsPromises, "opendir", async () => { throw Object.assign(Error("SYNTHETIC_PRIVATE_READ_FAILURE"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try {
    writeFileSync(join(f.repo, "a.ts"), "export function a() { return 2; }\n");
    const failed = await buildGraph(f.repo, { contextDir: out });
    assert.equal(failed.extensionRuns?.[0]?.reasonCode, "runtime-error");
    assert.equal(failed.extensionRuns?.[0]?.inputFingerprint, "unavailable");
    const before = extensionRuns(f.repo).length;
    const repeated = await ensureFreshGraph(f.repo, { contextDir: out });
    assert.equal(repeated.refreshed, false, "incomplete capture must not bypass the execution cooldown");
    assert.equal(extensionRuns(f.repo).length, before);
    assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, false);
    assert.doesNotMatch(refreshNote(repeated) ?? "", /SYNTHETIC_PRIVATE/);
    assert.equal((readGraph(wiringPath(out)) as GraphV1).edges.filter(e => e.origin === "extension").length, 0);
  } finally { denied.mock.restore(); syncBuiltinESMExports(); }
  const fingerprint = JSON.parse(readFileSync(fingerprintPath(out), "utf8"));
  fingerprint.extensionBuild.attemptedAt -= 61_000;
  writeFileSync(fingerprintPath(out), JSON.stringify(fingerprint));
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
});

test("extension health cannot survive from a previous graph when its cache write fails", async (t) => {
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default () => ({edges:[{source:'a.ts#a',target:'b.ts#b',relation:'serves'}]});\n");
  approveExtension(f.repo, f.entry);
  const first = await buildGraph(f.repo, { contextDir: out });
  if (first.extensionRuns?.[0]?.status === "skipped") return t.skip(first.extensionRuns[0].reason);
  const before = readFileSync(fingerprintPath(out), "utf8");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    chmodSync(join(out, ".cache"), 0o500);
    Object.defineProperty(process, "platform", { value: "win32" });
    const reduced = await buildGraph(f.repo, { contextDir: out });
    assert.equal(reduced.extensionRuns?.[0]?.reasonCode, "isolation-unavailable");
  } finally {
    Object.defineProperty(process, "platform", platform);
    chmodSync(join(out, ".cache"), 0o700);
  }
  assert.equal(readFileSync(fingerprintPath(out), "utf8"), before, "the cache write really failed");
  assert.equal((readGraph(wiringPath(out)) as GraphV1).edges.filter(e => e.origin === "extension").length, 0);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, false, "an older successful fingerprint cannot certify the replacement graph");
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
});

test("a failed sidecar write cannot certify edges from a different successful input snapshot", async (t) => {
  const why = chmodDenialUnavailable();
  if (why) return t.skip(why);
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(join(f.repo, "routes.json"), '{"target":"a"}');
  writeFileSync(f.entry, `export default ctx => { const {target} = JSON.parse(ctx.readFile('routes.json')); return {edges:[{source:'b.ts#b',target:target+'.ts#'+target,relation:'serves'}]}; };`);
  approveExtension(f.repo, f.entry);
  const first = await buildGraph(f.repo, { contextDir: out });
  if (first.extensionRuns?.[0]?.status === "skipped") return t.skip(first.extensionRuns[0].reason);
  const before = readFileSync(fingerprintPath(out), "utf8");
  try {
    chmodSync(join(out, ".cache"), 0o500);
    writeFileSync(join(f.repo, "routes.json"), '{"target":"b"}');
    const second = await buildGraph(f.repo, { contextDir: out });
    assert.equal(second.extensionRuns?.[0]?.status, "ok");
    assert.equal((readGraph(wiringPath(out)) as GraphV1).edges.find(e => e.origin === "extension")?.target, "b.ts#b");
  } finally {
    writeFileSync(join(f.repo, "routes.json"), '{"target":"a"}');
    chmodSync(join(out, ".cache"), 0o700);
  }
  assert.equal(readFileSync(fingerprintPath(out), "utf8"), before, "the successful build left the old sidecar intact");
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, false);
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((readGraph(wiringPath(out)) as GraphV1).edges.find(e => e.origin === "extension")?.target, "a.ts#a");
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
});

test("removing an oversized non-source input permits bounded extension recovery", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  approveExtension(f.repo, f.entry);
  const first = await buildGraph(f.repo, { contextDir: out });
  if (first.extensionRuns?.[0]?.status === "skipped") return t.skip(first.extensionRuns[0].reason);
  const large = join(f.repo, "oversized.dat");
  writeFileSync(large, ""); truncateSync(large, 300 * 1024 * 1024);
  const failed = await buildGraph(f.repo, { contextDir: out });
  assert.equal(failed.extensionRuns?.[0]?.reasonCode, "source-limit");
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, false);
  rmSync(large);
  const fingerprint = JSON.parse(readFileSync(fingerprintPath(out), "utf8"));
  fingerprint.extensionBuild.attemptedAt -= 61_000;
  writeFileSync(fingerprintPath(out), JSON.stringify(fingerprint));
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
});

test("build dry-run lists approval without executing code or creating graph, audit or project config", (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph"), options = { stateDir: f.stateDir };
  approveExtension(f.repo, f.entry, {}, options);
  const result = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--dir", out, "build", f.repo, "--dry-run"], {
    encoding: "utf8", env: { ...process.env, CI: "1", DO_NOT_TRACK: "1", GRAFT_NO_GITIGNORE: "1", GRAFT_NO_IGNORE: "1", GRAFT_EXTENSION_STATE_DIR: f.stateDir },
  });
  assert.equal(JSON.parse(result).extensions[0].status, "ready");
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(join(f.repo, ".inarch")), false);
  assert.deepEqual(extensionRuns(f.repo, options), []);
});

test("extension state cannot be selected by a repository symlink to an external directory", (t) => {
  const f = fixture(t);
  mkdirSync(f.stateDir);
  symlinkSync(f.stateDir, join(f.repo, "state-link"));
  assert.throws(() => approveExtension(f.repo, f.entry, {}, { stateDir: join(f.repo, "state-link") }), /outside|repository/);
  assert.deepEqual(readdirSync(f.stateDir), []);
});

test("contributed text rejects C1 controls and Unicode line separators atomically", (t) => {
  const f = fixture(t);
  for (const control of ["\u0085", "\u009b", "\u2028", "\u2029"]) {
    for (const payload of [
      { nodes: [{ id: "a.ts#extra", name: `a${control}b`, kind: "function", path: "a.ts", span: "L1-L1" }] },
      { edges: [{ source: "b.ts#b", target: "a.ts#a", relation: "serves", via: `GET /a${control}b` }] },
    ]) {
      const g = graph(), before = structuredClone(g);
      assert.throws(() => mergeExtensionContribution(g, payload, provenance, f.repo), /invalid extension/);
      assert.deepEqual(g, before);
    }
  }
});

test("human extension CLI output sanitizes hostile package paths", (t) => {
  const f = fixture(t), entry = join(f.pkg, "terminal-\u001b[2K\u009b1A\u2028.mjs");
  writeFileSync(entry, "export default () => ({});");
  for (const args of [["allow", entry, f.repo], ["list", f.repo]]) {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ext", ...args], {
      encoding: "utf8", env: { ...process.env, CI: "1", FORCE_COLOR: "0", DO_NOT_TRACK: "1", GRAFT_EXTENSION_STATE_DIR: f.stateDir },
    });
    assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u);
  }
});

test("audit corruption preserves readable neighboring events and never exposes malformed content", async (t) => {
  const f = fixture(t), options = { stateDir: f.stateDir };
  approveExtension(f.repo, f.entry, {}, options);
  await enrichWithExtensions(graph(), f.repo, options);
  const events = extensionRuns(f.repo, options), dir = join(f.stateDir, readdirSync(f.stateDir)[0]), file = join(dir, "runs.jsonl");
  assert.ok(events.length >= 2);
  writeFileSync(file, JSON.stringify(events[0]) + "\nBROKEN_SYNTHETIC_PRIVATE_LINE\n" + JSON.stringify(events.at(-1)) + '\n{"torn":"SYNTHETIC_PRIVATE');
  const recovered = extensionRuns(f.repo, options) as Array<{ status: string }>;
  assert.ok(recovered.some(event => event.status === "started"));
  assert.ok(recovered.some(event => event.status === (events.at(-1) as { status: string }).status));
  assert.equal(recovered.filter(event => event.status === "corrupt").length, 2);
  assert.doesNotMatch(JSON.stringify(recovered), /SYNTHETIC_PRIVATE/);
  await enrichWithExtensions(graph(), f.repo, options);
  const after = extensionRuns(f.repo, options) as Array<{ status: string }>;
  assert.notEqual(after.at(-1)?.status, "corrupt");
  assert.equal(after.filter(event => event.status === "started").length, 2);
});

test("extension nodes hash their source span without copying source bodies into the graph", (t) => {
  const f = fixture(t), g = graph();
  writeFileSync(join(f.repo, "a.ts"), "SYNTHETIC_SOURCE_BODY\n".repeat(500));
  mergeExtensionContribution(g, { nodes: [{ id: "a.ts#extra", name: "extra", kind: "function", path: "a.ts", span: "L1-L500" }] }, provenance, f.repo);
  assert.equal(Object.hasOwn(g.nodes[2], "body_text"), false);
  assert.match(g.nodes[2].body_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(g), /SYNTHETIC_SOURCE_BODY/);
});

test("source validation bytes are shared across all extensions in one build", async (t) => {
  const f = fixture(t), g = graph(), options = { stateDir: f.stateDir };
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(f.repo, `large${i}.ts`), "x".repeat(6 * 1024 * 1024));
    const pkg = join(f.pkg, `p${i}`); mkdirSync(pkg);
    const entry = join(pkg, "entry.mjs");
    writeFileSync(entry, `export default () => ({nodes:[{id:'large${i}.ts#extra',path:'large${i}.ts',name:'extra',kind:'function',span:'L1-L1'}]});`);
    approveExtension(f.repo, entry, {}, options);
  }
  const runs = await enrichWithExtensions(g, f.repo, options);
  if (runs.every(run => run.status === "skipped")) return t.skip(runs[0].reason);
  assert.equal(runs.filter(run => run.status === "ok").length, 2);
  assert.equal(runs.filter(run => run.status === "failed").length, 1);
  assert.match(runs.find(run => run.status === "failed")!.reason!, /source.*budget|source.*bytes/i);
  assert.equal(g.nodes.length, 4);
});

test("serialized additions share a byte budget across a build without partially merging a rejection", async (t) => {
  const f = fixture(t), g = graph(), options = { stateDir: f.stateDir };
  for (let i = 0; i < 500; i++) g.nodes.push({ ...g.nodes[0], id: `a.ts#n${i}`, name: `n${i}` });
  g.meta.nodeCount = g.nodes.length;
  for (let group = 0; group < 2; group++) {
    const pkg = join(f.pkg, `p${group}`); mkdirSync(pkg);
    const entry = join(pkg, "entry.mjs");
    writeFileSync(entry, `export default () => ({edges:Array.from({length:50000},(_,i)=>({source:'a.ts#n'+(i%500),target:'a.ts#n'+(Math.floor(i/500)+${group * 100}),relation:'serves',via:'x'.repeat(128)}))});`);
    approveExtension(f.repo, entry, {}, options);
  }
  const runs = await enrichWithExtensions(g, f.repo, options);
  if (runs.every(run => run.status === "skipped")) return t.skip(runs[0].reason);
  assert.equal(runs.filter(run => run.status === "ok").length, 1, JSON.stringify(runs));
  assert.equal(runs.filter(run => run.status === "failed").length, 1);
  assert.match(runs.find(run => run.status === "failed")!.reason!, /contribution.*byte.*budget/i);
  assert.equal(g.edges.length, 50_001);
  assert.equal(g.meta.edgeCount, g.edges.length);
});

test("large valid edge additions preserve build array aliases at a small V8 stack limit", (t) => {
  const f = fixture(t);
  const script = `
    import assert from 'node:assert/strict';
    import {mergeExtensionContribution} from './src/graph/extensions.ts';
    const graph = ${JSON.stringify(graph())};
    for(let i=0;i<10000;i++) graph.nodes.push({...graph.nodes[0],id:'a.ts#n'+i,name:'n'+i});
    graph.meta.nodeCount=graph.nodes.length;
    const nodes=graph.nodes, edges=graph.edges;
    const result=mergeExtensionContribution(graph,{nodes:[{id:'a.ts#extra',path:'a.ts',name:'extra',kind:'function',span:'L1-L1'}],
      edges:Array.from({length:100000},(_,i)=>({source:'a.ts#n'+(i%10000),target:'a.ts#n'+Math.floor(i/10000),relation:'references'}))},${JSON.stringify(provenance)},process.argv[1]);
    assert.deepEqual(result,{nodes:1,edges:100000});
    assert.equal(graph.nodes,nodes); assert.equal(graph.edges,edges);
    assert.equal(graph.meta.nodeCount,10003); assert.equal(graph.meta.edgeCount,100001);
  `;
  execFileSync(process.execPath, ["--stack_size=512", "--import", "tsx", "--input-type=module", "-e", script, f.repo], { timeout: 15000 });
});

test("audit reason codes distinguish package changes, execution errors and merge rejection", async (t) => {
  const f = fixture(t), options = { stateDir: f.stateDir };
  for (const [source, expected] of [
    ["export default () => { throw Error('timeout SYNTHETIC_PRIVATE_ERROR') };", "extension-error"],
    ["process.stdout.write('bad JSON'); export default () => ({});", "output-rejected"],
    ["export default () => ({edges:[{source:'a.ts#a',target:'missing',relation:'serves'}]});", "merge-rejected"],
  ]) {
    writeFileSync(f.entry, source);
    approveExtension(f.repo, f.entry, {}, options);
    const [run] = await enrichWithExtensions(graph(), f.repo, options);
    if (run.status === "skipped") return t.skip(run.reason);
    const event = extensionRuns(f.repo, options).at(-1) as Record<string, unknown>;
    assert.equal(event.reasonCode, expected);
    assert.equal(event.reason, undefined);
    assert.equal(event.log, undefined);
    assert.doesNotMatch(JSON.stringify(event), /SYNTHETIC_PRIVATE_ERROR/);
  }
  writeFileSync(join(f.pkg, "helper.mjs"), "export const changed = true;");
  await enrichWithExtensions(graph(), f.repo, options);
  assert.equal((extensionRuns(f.repo, options).at(-1) as Record<string, unknown>).reasonCode, "unapproved-changed");
});

test("core invariant failures are identified before blaming or applying an extension", (t) => {
  const f = fixture(t), g = graph();
  g.nodes.push(structuredClone(g.nodes[0])); g.meta.nodeCount++;
  const before = structuredClone(g);
  assert.throws(() => mergeExtensionContribution(g, {edges:[]}, provenance, f.repo), /core graph.*invalid/i);
  assert.deepEqual(g, before);
});

test("approval snapshots include CommonJS helpers and invalidate changed helper bytes", async (t) => {
  const f = fixture(t), options = { stateDir: f.stateDir };
  writeFileSync(f.entry, "import helper from './helper.cjs'; export default () => ({edges:helper});");
  writeFileSync(join(f.pkg, "helper.cjs"), "module.exports = [{source:'b.ts#b',target:'a.ts#a',relation:'serves'}];");
  approveExtension(f.repo, f.entry, {}, options);
  const [run] = await enrichWithExtensions(graph(), f.repo, options);
  if (run.status === "skipped") return t.skip(run.reason);
  assert.equal(run.status, "ok", run.reason);
  assert.equal(run.edges, 1);
  writeFileSync(join(f.pkg, "helper.cjs"), "module.exports = [];\n");
  assert.equal(listExtensions(f.repo, options)[0].status, "changed");
});


test("audit reader projects operational fields and rejects forged reason codes", async (t) => {
  const f = fixture(t), options = { stateDir: f.stateDir };
  approveExtension(f.repo, f.entry, {}, options);
  await enrichWithExtensions(graph(), f.repo, options);
  const event = extensionRuns(f.repo, options).at(-1) as Record<string, unknown>;
  const file = join(f.stateDir, readdirSync(f.stateDir)[0], "runs.jsonl");
  writeFileSync(file, JSON.stringify({...event, log:["SYNTHETIC_PRIVATE"], extra:"SYNTHETIC_PRIVATE"}) + "\n" +
    JSON.stringify({...event, reasonCode:"SYNTHETIC_PRIVATE"}) + "\n");
  const records = extensionRuns(f.repo, options) as Array<Record<string, unknown>>;
  assert.equal(records[0].status, event.status);
  assert.equal(records[1].status, "corrupt");
  assert.doesNotMatch(JSON.stringify(records), /SYNTHETIC_PRIVATE/);
});

test("source span hashing handles middle lines and a final empty line exactly", async (t) => {
  const {createHash} = await import("node:crypto");
  const f = fixture(t), g = graph();
  writeFileSync(join(f.repo,"a.ts"), "first\nmiddle\nlast\n");
  mergeExtensionContribution(g, { nodes: [
    {id:"a.ts#middle",path:"a.ts",name:"middle",kind:"function",span:"L2-L3"},
    {id:"a.ts#empty",path:"a.ts",name:"empty",kind:"function",span:"L4-L4"},
  ] }, provenance, f.repo);
  for(const [offset, text] of [[2,"middle\nlast"],[3,""]] as const)
    assert.equal(g.nodes[offset].body_hash,createHash("sha256").update(text).digest("hex"));
  const before = structuredClone(g);
  assert.throws(() => mergeExtensionContribution(g,{nodes:[{id:"a.ts#beyond",path:"a.ts",name:"beyond",kind:"function",span:"L5-L5"}]},provenance,f.repo),/span exceeds/);
  assert.deepEqual(g,before);
});


test("an exhausted validation deadline preserves both arrays and metadata", (t) => {
  const f = fixture(t), g = graph(), before = structuredClone(g);
  assert.throws(() => mergeExtensionContribution(g, {edges:[{source:"b.ts#b",target:"a.ts#a",relation:"serves"}]},provenance,f.repo,Date.now()-1),/time budget exhausted/);
  assert.deepEqual(g,before);
});

test("invalid core graph skips execution and records a distinct operational reason", async (t) => {
  const f = fixture(t), options = {stateDir:f.stateDir}, g = graph();
  writeFileSync(f.entry,"export default ctx => {ctx.log('must not run'); return {}};");
  approveExtension(f.repo,f.entry,{},options);
  g.nodes.push(structuredClone(g.nodes[0])); g.meta.nodeCount++;
  const before = structuredClone(g), [run] = await enrichWithExtensions(g,f.repo,options);
  assert.equal(run.status,"skipped"); assert.equal(run.reasonCode,"core-invalid");
  assert.deepEqual(run.log,[]); assert.deepEqual(g,before);
  assert.equal((extensionRuns(f.repo,options).at(-1) as Record<string,unknown>).reasonCode,"core-invalid");
});

test("extension input freshness covers edge-only JSON and only-dir-excluded files", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  mkdirSync(join(f.repo, "src")); mkdirSync(join(f.repo, "data")); mkdirSync(join(f.repo, "outside"));
  writeFileSync(join(f.repo, "src/a.ts"), "export function a() {}\n");
  writeFileSync(join(f.repo, "src/b.ts"), "export function b() {}\n");
  writeFileSync(join(f.repo, "package.json"), '{"enabled":1}');
  writeFileSync(join(f.repo, "data/routes.json"), '{"enabled":1}');
  writeFileSync(join(f.repo, "outside/flag.ts"), "export const enabled = true;\n");
  writeFileSync(f.entry, `export default ctx => {
    const pkg = JSON.parse(ctx.readFile('package.json') ?? '{}');
    const routes = JSON.parse(ctx.readFile('data/routes.json') ?? '{}');
    const enabled = pkg.enabled && routes.enabled && ctx.readFile('outside/flag.ts')?.includes('true') && !ctx.listFiles('data').includes('data/extra.json');
    return {edges:enabled ? [{source:'src/b.ts#b',target:'src/a.ts#a',relation:'serves'}] : []};
  };`);
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out, onlyDirs: ["src"] });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  const edges = () => (readGraph(wiringPath(out)) as GraphV1).edges.filter(edge => edge.origin === "extension");
  assert.equal(edges().length, 1);
  assert.ok(isClean(probeDrift(f.repo, out)!));
  for (const [path, content, count] of [
    ["package.json", '{"enabled":0}', 0], ["package.json", '{"enabled":1}', 1],
    ["data/routes.json", null, 0], ["data/routes.json", '{"enabled":1}', 1],
    ["data/extra.json", '{}', 0], ["data/extra.json", null, 1],
    ["outside/flag.ts", "export const enabled = false;\n", 0],
  ] as const) {
    if (content === null) rmSync(join(f.repo, path)); else writeFileSync(join(f.repo, path), content);
    assert.ok(!isClean(probeDrift(f.repo, out)!), path);
    const check = await checkGraph(f.repo, { contextDir: out });
    assert.equal(check.extensionsChanged, true, path); assert.equal(check.ok, false, path);
    assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true, path);
    assert.equal(edges().length, count, path);
    assert.ok(isClean(probeDrift(f.repo, out)!), path);
  }
});

test("failed executions retain input freshness so a data edit retries them", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(join(f.repo, "routes.json"), '{"ready":false}');
  writeFileSync(f.entry, `export default ctx => { if (!JSON.parse(ctx.readFile('routes.json')).ready) throw Error('not ready'); return {edges:[{source:'b.ts#b',target:'a.ts#a',relation:'serves'}]}; };`);
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  assert.equal(built.extensionRuns?.[0]?.status, "failed");
  assert.ok(isClean(probeDrift(f.repo, out)!));
  writeFileSync(join(f.repo, "routes.json"), '{"ready":true}');
  assert.ok(!isClean(probeDrift(f.repo, out)!));
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, true);
  assert.equal((readGraph(wiringPath(out)) as GraphV1).edges.filter(edge => edge.origin === "extension").length, 1);
});

test("extension input freshness excludes a custom in-repository graph directory", async (t) => {
  const f = fixture(t), out = join(f.repo, "local-context");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  writeFileSync(f.entry, "export default ctx => { if (ctx.listFiles().some(path => path.startsWith('local-context/'))) throw Error('graph output leaked'); return {}; };");
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  assert.equal(built.extensionRuns?.[0]?.status, "ok");
  assert.ok(isClean(probeDrift(f.repo, out)!));
  assert.equal(extensionInputsChanged(f.repo, readFingerprint(out), join(f.repo, "another-output")), true, "moving output changes the readable input view");
  writeFileSync(join(out, "generated.json"), '{"generated":true}');
  assert.ok(isClean(probeDrift(f.repo, out)!));
  assert.equal((await checkGraph(f.repo, { contextDir: out })).ok, true);
  assert.equal((await ensureFreshGraph(f.repo, { contextDir: out })).refreshed, false);
});


test("missing or differing execution input stamps never certify a registered extension fresh", async (t) => {
  const f = fixture(t), out = join(f.repo, "..", "graph");
  const previous = process.env.GRAFT_EXTENSION_STATE_DIR;
  process.env.GRAFT_EXTENSION_STATE_DIR = f.stateDir;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_EXTENSION_STATE_DIR; else process.env.GRAFT_EXTENSION_STATE_DIR = previous; });
  approveExtension(f.repo, f.entry);
  const built = await buildGraph(f.repo, { contextDir: out });
  if (built.extensionRuns?.[0]?.status === "skipped") return t.skip(built.extensionRuns[0].reason);
  const fingerprint = readFingerprint(out)!;
  assert.equal(fingerprint.extensionInputs?.length, 1);
  assert.equal(extensionInputsChanged(f.repo, fingerprint), false);
  fingerprint.extensionInputs!.push("0".repeat(64));
  assert.equal(extensionInputsChanged(f.repo, fingerprint), true, "all executions must agree with the current source view");
  delete fingerprint.extensionInputs;
  writeFileSync(fingerprintPath(out), JSON.stringify(fingerprint));
  assert.ok(!isClean(probeDrift(f.repo, out)!));
  assert.equal((await checkGraph(f.repo, { contextDir: out })).extensionsChanged, true);
  fingerprint.extensionInputs = [];
  assert.equal(extensionInputsChanged("/synthetic-missing-repository", fingerprint), false, "a recorded skip does not read source or churn");
});
