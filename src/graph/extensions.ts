/**
 * Local extension grants and additions-only graph enrichment. Project files are
 * inputs, never approval authority: a committed or symlinked .graft/config.json
 * cannot cause code to run. Grants live in user state and cover the package's
 * bytes and configuration; execution receives the same bytes we just checked.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { checkGraphInvariants } from "./invariants.js";
import { EXECUTION_REASON_CODES, EXTENSION_MAX_DURATION_MS, extensionDisplayText, extensionSourcePath } from "./extension-runtime.js";
import type { EdgeV1, GraphV1, Kind, NodeV1, Relation } from "./types.js";

export interface ExtensionOptions { stateDir?: string }
export interface ExtensionGrant {
  version: 1;
  id: string;
  repo: string;
  path: string;
  digest: string;
  config: unknown;
  approvedAt: string;
}
export interface ExtensionStatus extends ExtensionGrant {
  status: "ready" | "changed" | "missing" | "invalid";
  reason?: string;
}
export const RUN_REASON_CODES = [...EXECUTION_REASON_CODES, "unapproved-changed", "package-unavailable", "build-budget-exhausted", "validation-budget-exhausted", "merge-rejected", "audit-error", "registry-error", "core-invalid", "legacy-failure"] as const;
type RunReasonCode = typeof RUN_REASON_CODES[number];
export interface ExtensionRun {
  id: string;
  digest: string;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  reasonCode?: RunReasonCode;
  inputFingerprint?: string;
  durationMs: number;
  nodes: number;
  edges: number;
  log: string[];
}
interface PackageFile { path: string; content: string }
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_EXTENSIONS = 8;
const BUILD_BUDGET_MS = 30_000;
const VALIDATION_SOURCE_BYTES = 16 * 1024 * 1024;
const CONTRIBUTION_BYTES = 32 * 1024 * 1024;
const KINDS = new Set<Kind>(["file", "class", "function", "method", "interface", "type", "enum", "struct", "module", "constant", "variable"]);
const RELATIONS = new Set<Relation>(["contains", "calls", "imports", "references", "implements", "extends", "renders", "serves", "dispatches", "enqueues"]);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const errorText = (e: unknown): string => extensionDisplayText(e instanceof Error ? e.message : e);

interface ValidationBudget {
  sourceBytes: number;
  contributionBytes: number;
  sources: Map<string, { text: string; hashes: Map<string, string> }>;
}
const validationBudget = (): ValidationBudget => ({ sourceBytes: 0, contributionBytes: 0, sources: new Map() });
class ValidationFailure extends Error {
  constructor(readonly reasonCode: "validation-budget-exhausted" | "core-invalid", message: string) { super(message); }
}

function validateTime(deadline: number): void {
  if (Date.now() >= deadline) throw new ValidationFailure("validation-budget-exhausted", "extension validation time budget exhausted");
}

function reserveAddition(budget: ValidationBudget, value: unknown): void {
  budget.contributionBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
  if (budget.contributionBytes > CONTRIBUTION_BYTES) throw new ValidationFailure("validation-budget-exhausted", "extension contribution byte budget exhausted");
}

// Splitting millions of short source lines into a retained array amplified a
// bounded source file into hundreds of MB. Keep one source string per build and
// hash requested slices, retaining only hashes when many nodes share a span.
function spanHash(source: { text: string; hashes: Map<string, string> }, span: string, start: number, end: number, deadline: number): string {
  const cached = source.hashes.get(span);
  if (cached) return cached;
  let offset = 0, line = 1;
  const advance = () => {
    if ((line & 1023) === 0) validateTime(deadline);
    const next = source.text.indexOf("\n", offset);
    if (next < 0) throw new Error("extension span exceeds source file");
    offset = next + 1; line++;
  };
  while (line < start) advance();
  const begin = offset;
  while (line < end) advance();
  const last = source.text.indexOf("\n", offset);
  const digest = hash(source.text.slice(begin, last < 0 ? source.text.length : last));
  source.hashes.set(span, digest);
  return digest;
}

/** Canonical JSON also breaks shared nested references supplied by a CLI caller. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  throw new Error("extension configuration must contain only JSON values");
}

function destination(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(destination(parent), basename(path));
}

function stateDirectory(repo: string, options: ExtensionOptions): string {
  const base = resolve(options.stateDir ?? process.env.GRAFT_EXTENSION_STATE_DIR ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "inarch", "extensions"));
  if (inside(repo, base)) throw new Error("extension approval state must be outside the repository");
  const state = destination(base);
  if (inside(repo, state)) throw new Error("extension approval state must be outside the repository");
  return join(state, hash(repo));
}

function readRegular(path: string, limit: number, overLimit = () => new Error(`file exceeds ${limit} bytes: ${path}`)): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a bounded regular file: ${path}`);
    if (stat.size > limit) throw overLimit();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - length + 1));
      const n = readSync(fd, buffer);
      if (!n) break;
      length += n;
      if (length > limit) throw overLimit();
      chunks.push(buffer.subarray(0, n));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { closeSync(fd); }
}

function sourceFile(repo: string, path: string, limit: number): string {
  if (!extensionSourcePath(path)) throw new Error("extension node source is excluded");
  // A realpath check followed by an ordinary open races a directory replaced by
  // a symlink. Anchor each component to an open directory, as the worker snapshot
  // does, so a contribution cannot ask the parent to read outside that snapshot.
  if (process.platform !== "linux") throw new Error("extension source validation requires Linux");
  const parts = path.split("/"), handles: number[] = [];
  if (parts.length > 65) throw new Error("extension source depth limit exceeded");
  try {
    handles.push(openSync(repo, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts.slice(0, -1)) handles.push(openSync(`/proc/self/fd/${handles.at(-1)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    return readRegular(`/proc/self/fd/${handles.at(-1)}/${parts.at(-1)}`, Math.min(8 * 1024 * 1024, limit),
      () => new ValidationFailure("validation-budget-exhausted", "extension source byte budget exhausted"));
  } finally { for (const fd of handles.reverse()) closeSync(fd); }
}

/** Recheck host-hashed extension spans without executing registered code. */
export function extensionNodeHashes(root: string, nodes: readonly NodeV1[]): Map<string, string> {
  const repo = realpathSync(root), budget = validationBudget(), deadline = Date.now() + 5000;
  const hashes = new Map<string, string>();
  for (const node of nodes) {
    if (node.origin !== "extension") continue;
    try {
      validateTime(deadline);
      const match = /^L([1-9]\d*)-L([1-9]\d*)$/.exec(node.span);
      if (!match) continue;
      const start = Number(match[1]), end = Number(match[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) continue;
      let source = budget.sources.get(node.path);
      if (!source) {
        const text = sourceFile(repo, node.path, VALIDATION_SOURCE_BYTES - budget.sourceBytes);
        budget.sourceBytes += Buffer.byteLength(text);
        source = { text, hashes: new Map() };
        budget.sources.set(node.path, source);
      }
      hashes.set(node.id, spanHash(source, node.span, start, end, deadline));
    } catch {
      // Missing, unreadable, excluded or over-budget sources cannot certify a
      // current node. In particular, never follow a newly substituted symlink.
    }
  }
  return hashes;
}

function packageSnapshot(entryPath: string): { entry: string; files: PackageFile[] } {
  if (lstatSync(entryPath).isSymbolicLink()) throw new Error("extension entry must not be a symlink");
  if (!/\.(?:mjs|js)$/.test(entryPath)) throw new Error("extension entry must be an ES module (.mjs or .js)");
  const root = realpathSync(dirname(entryPath));
  const files: PackageFile[] = [];
  let bytes = 0, entries = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 32) throw new Error("extension package exceeds directory depth limit");
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const anchor = process.platform === "linux" ? `/proc/self/fd/${fd}` : dir;
    const listing = opendirSync(anchor);
    try { for (let item; (item = listing.readSync());) {
      if (++entries > 4096) throw new Error("extension package exceeds directory entry limit");
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      const path = join(anchor, item.name), name = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`extension package contains a symlink: ${name}`);
      if (item.isDirectory()) { walk(path, name, depth + 1); continue; }
      if (!item.isFile()) throw new Error(`extension package contains a special file: ${name}`);
      if (!/\.(?:mjs|cjs|js|json)$/.test(item.name)) continue;
      if (files.length >= MAX_PACKAGE_FILES) throw new Error("extension package exceeds 256 files; use a dedicated directory");
      const content = readRegular(path, MAX_PACKAGE_BYTES - bytes);
      bytes += Buffer.byteLength(content);
      files.push({ path: name, content });
    } } finally { listing.closeSync(); closeSync(fd); }
  };
  walk(root, "", 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = basename(entryPath);
  if (!files.some((f) => f.path === entry)) throw new Error("extension entry was excluded from its package");
  return { entry, files };
}

function packageDigest(snapshot: { entry: string; files: PackageFile[] }, config: unknown): string {
  return hash(canonical({ entry: snapshot.entry, files: snapshot.files, config }));
}

function grants(repo: string, options: ExtensionOptions): ExtensionGrant[] {
  const dir = stateDirectory(repo, options);
  if (!existsSync(dir)) return [];
  if (lstatSync(dir).isSymbolicLink()) throw new Error("extension state directory must not be a symlink");
  const paths = readdirSync(dir).filter((p) => /^[a-f0-9]{64}\.json$/.test(p)).sort();
  if (paths.length > MAX_EXTENSIONS) throw new Error("too many extension registrations");
  return paths.map((p) => {
    const g: unknown = JSON.parse(readRegular(join(dir, p), 128 * 1024));
    if (!object(g) || g.version !== 1 || g.repo !== repo || g.id !== p.slice(0, -5) || typeof g.path !== "string" || !isAbsolute(g.path) || g.id !== hash(g.path) || typeof g.digest !== "string" || !/^[a-f0-9]{64}$/.test(g.digest) || typeof g.approvedAt !== "string" || !object(g.config)) throw new Error(`invalid extension grant: ${p}`);
    return g as unknown as ExtensionGrant;
  });
}

export function approveExtension(root: string, path: string, config: unknown = {}, options: ExtensionOptions = {}): ExtensionGrant {
  const repo = realpathSync(root);
  if (!object(config)) throw new Error("extension configuration must be a JSON object");
  const copy = JSON.parse(canonical(config));
  if (Buffer.byteLength(canonical(copy)) > 64 * 1024) throw new Error("extension configuration exceeds 64 KiB");
  const entryPath = resolve(path);
  if (lstatSync(entryPath).isSymbolicLink()) throw new Error("extension entry must not be a symlink");
  const entry = realpathSync(entryPath);
  const snapshot = packageSnapshot(entry);
  const id = hash(entry);
  const existing = grants(repo, options);
  if (existing.length >= MAX_EXTENSIONS && !existing.some((g) => g.id === id)) throw new Error("at most eight extensions can be registered per repository");
  const grant: ExtensionGrant = { version: 1, id, repo, path: entry, config: copy, digest: packageDigest(snapshot, copy), approvedAt: new Date().toISOString() };
  const dir = stateDirectory(repo, options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${id}.json`), temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(grant) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
  return grant;
}

export function revokeExtension(root: string, id: string, options: ExtensionOptions = {}): boolean {
  const repo = realpathSync(root);
  const g = grants(repo, options).find((g) => g.id === id || g.path === resolve(id));
  if (!g) return false;
  rmSync(join(stateDirectory(repo, options), `${g.id}.json`));
  return true;
}

export function listExtensions(root: string, options: ExtensionOptions = {}): ExtensionStatus[] {
  const repo = realpathSync(root);
  return grants(repo, options).map((g) => {
    try {
      const digest = packageDigest(packageSnapshot(g.path), g.config);
      return { ...g, status: digest === g.digest ? "ready" : "changed", ...(digest === g.digest ? {} : { reason: "package changed; run inarch ext allow again" }) };
    } catch (e) {
      return { ...g, status: existsSync(g.path) ? "invalid" : "missing", reason: errorText(e) };
    }
  });
}

/** Byte-based even on the query path: a same-mtime helper edit must revoke code. */
export function extensionFingerprint(root: string, options: ExtensionOptions = {}): string {
  try {
    const records = listExtensions(root, options);
    return records.length ? hash(canonical(records.map(({ id, digest, status }) => ({ id, digest, status })))) : "";
  } catch { return "invalid-extension-state"; }
}

/** Bind safe execution outcomes to the graph that was actually published. A
 * failed sidecar write must not leave an older success certifying a new graph. */
export function extensionExecutionStamp(extensions: string, runs: Array<Pick<ExtensionRun, "id" | "digest" | "status" | "reasonCode" | "inputFingerprint">>): string {
  if (!extensions && !runs.length) return "";
  return hash(canonical({ extensions, runs: runs.map(({ id, digest, status, reasonCode, inputFingerprint }) => ({ id, digest, status,
    ...(reasonCode ? { reasonCode } : {}), ...(inputFingerprint ? { inputFingerprint } : {}) })).sort((a, b) => a.id.localeCompare(b.id)) }));
}

function string(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || extensionDisplayText(value, max) !== value) throw new Error(`invalid extension ${field}`);
  return value;
}

/** Validate a complete contribution before touching either core array. */
export function mergeExtensionContribution(graph: GraphV1, result: unknown, grant: Pick<ExtensionGrant, "id" | "digest">, root: string, deadline = Date.now() + 5000, budget = validationBudget()): { nodes: number; edges: number } {
  validateTime(deadline);
  const coreProblems = checkGraphInvariants(graph).problems;
  if (coreProblems.length) throw new ValidationFailure("core-invalid", `core graph is invalid before extension validation: ${extensionDisplayText(coreProblems[0])}`);
  if (!object(result) || Object.keys(result).some((k) => k !== "nodes" && k !== "edges")) throw new Error("extension must return nodes/edges additions only");
  const rawNodes = result.nodes === undefined ? [] : result.nodes;
  const rawEdges = result.edges === undefined ? [] : result.edges;
  if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges) || rawNodes.length > 10_000 || rawEdges.length > 100_000) throw new Error("invalid or oversized extension contribution");
  const repo = realpathSync(root);
  const ids = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: NodeV1[] = [], edges: EdgeV1[] = [];
  reserveAddition(budget, { nodes: [], edges: [] });
  for (const raw of rawNodes) {
    validateTime(deadline);
    if (!object(raw)) throw new Error("invalid extension node");
    const id = string(raw.id, "node id"), path = string(raw.path, "path");
    if (ids.has(id)) throw new Error(`extension node collides with an existing id: ${id}`);
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || !id.startsWith(`${path}#`)) throw new Error("extension node path must be repository-relative");
    const sourceKey = `${repo}\0${path}`;
    if (!budget.sources.has(sourceKey)) {
      const source = sourceFile(repo, path, VALIDATION_SOURCE_BYTES - budget.sourceBytes);
      budget.sourceBytes += Buffer.byteLength(source);
      budget.sources.set(sourceKey, { text: source, hashes: new Map() });
    }
    const match = /^L([1-9]\d*)-L([1-9]\d*)$/.exec(string(raw.span, "span"));
    if (!match) throw new Error("invalid extension span");
    const start = Number(match[1]), end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error("extension span exceeds source file");
    if (!KINDS.has(raw.kind as Kind)) throw new Error("invalid extension node kind");
    const node: NodeV1 = { id, path, span: raw.span as string, name: string(raw.name, "name", 512), kind: raw.kind as Kind, signature: null, exported: false, origin: "extension", extension: grant.id, extensionDigest: grant.digest, body_hash: spanHash(budget.sources.get(sourceKey)!, raw.span as string, start, end, deadline), summary_state: "pending", summary: null, crux: null };
    reserveAddition(budget, node);
    nodes.push(node); ids.set(id, node);
  }
  const edgeKey = (e: Pick<EdgeV1, "source" | "relation" | "target">): string => JSON.stringify([e.source, e.relation, e.target]);
  const seen = new Set(graph.edges.map(edgeKey));
  for (const raw of rawEdges) {
    validateTime(deadline);
    if (!object(raw)) throw new Error("invalid extension edge");
    const source = string(raw.source, "source"), target = string(raw.target, "target");
    if (!ids.has(source) || !ids.has(target)) throw new Error("extension edge endpoint is not a node");
    if (!RELATIONS.has(raw.relation as Relation)) throw new Error("invalid extension relation");
    const relation = raw.relation as Relation;
    if (relation === "calls") {
      const family = (path: string): string => /\.(?:[cm]?[jt]sx?|vue)$/.test(path) ? "javascript" : /\.(?:rb|erb)$/.test(path) ? "ruby" : path.split(".").pop() ?? "";
      if (family(ids.get(source)!.path) !== family(ids.get(target)!.path)) throw new Error("extension calls must not cross a language boundary; use a distinct relation");
    }
    const edge: EdgeV1 = { source, target, relation, confidence: "extension", origin: "extension", extension: grant.id, extensionDigest: grant.digest };
    if (raw.via !== undefined) edge.via = string(raw.via, "evidence", 1024);
    const key = edgeKey(edge);
    if (!seen.has(key)) { reserveAddition(budget, edge); edges.push(edge); seen.add(key); }
  }
  const problems = checkGraphInvariants({ ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] }).problems;
  if (problems.length) throw new Error(`extension contribution violates graph invariants: ${problems[0]}`);
  validateTime(deadline);
  // A large spread exceeds V8's argument limit after the first array was already
  // mutated. Iteration keeps the original build arrays and has no argument stack.
  for (const node of nodes) graph.nodes.push(node);
  for (const edge of edges) graph.edges.push(edge);
  graph.meta.nodeCount = graph.nodes.length; graph.meta.edgeCount = graph.edges.length;
  return { nodes: nodes.length, edges: edges.length };
}

function appendRecord(root: string, record: unknown, options: ExtensionOptions): void {
  const dir = stateDirectory(realpathSync(root), options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "runs.jsonl");
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("extension audit must be a regular file");
    const last = Buffer.alloc(1);
    const separator = stat.size && readSync(fd, last, 0, 1, stat.size - 1) && last[0] !== 10 ? "\n" : "";
    appendFileSync(fd, separator + JSON.stringify(record) + "\n");
  } finally { closeSync(fd); }
}

export function extensionRuns(root: string, options: ExtensionOptions = {}): unknown[] {
  const file = join(stateDirectory(realpathSync(root), options), "runs.jsonl");
  if (!existsSync(file)) return [];
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("extension audit must be a regular file");
    // Read a bounded tail even after a long trial. A concurrent append can leave
    // an incomplete final event; only complete JSON lines are visible to readers.
    const start = Math.max(0, stat.size - 128 * 1024), buffer = Buffer.alloc(stat.size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const tail = buffer.subarray(0, length).toString("utf8");
    const aligned = start ? tail.slice(tail.indexOf("\n") + 1) : tail;
    const lines = aligned.split("\n");
    const incomplete = lines.pop();
    const records: unknown[] = [];
    for (const line of lines.filter(Boolean).slice(-100)) {
      try {
        const record: unknown = JSON.parse(line);
        if (!object(record) || !["started", "ok", "failed", "skipped"].includes(String(record.status))) throw new Error("invalid audit event");
        const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
        if (!hex(record.id) || !hex(record.digest) || typeof record.runId !== "string" || !/^[a-f0-9-]{36}$/.test(record.runId)
          || typeof record.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at)) throw new Error("invalid audit fields");
        const event: Record<string, unknown> = { runId: record.runId, at: record.at, id: record.id, digest: record.digest, status: record.status };
        if (record.status !== "started") {
          for (const field of ["nodes", "edges", "durationMs"]) {
            if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) throw new Error("invalid audit counts");
            event[field] = record[field];
          }
          if (record.reasonCode !== undefined) {
            if (!RUN_REASON_CODES.includes(record.reasonCode as RunReasonCode)) throw new Error("invalid audit reason code");
            event.reasonCode = record.reasonCode;
          } else if (record.reason !== undefined) event.reasonCode = "legacy-failure";
        }
        records.push(event);
      } catch { records.push({ status: "corrupt", reasonCode: "audit-corrupt", kind: "invalid-record" }); }
    }
    if (incomplete) records.push({ status: "corrupt", reasonCode: "audit-corrupt", kind: "incomplete-record" });
    return records.slice(-100);
  } finally { closeSync(fd); }
}

export async function enrichWithExtensions(graph: GraphV1, root: string, options: ExtensionOptions = {}, excludePaths: string[] = []): Promise<ExtensionRun[]> {
  let registrations: ExtensionStatus[];
  try { registrations = listExtensions(root, options); }
  catch (e) { return [{ id: "registry", digest: "", status: "skipped", reason: errorText(e), reasonCode: "registry-error", nodes: 0, edges: 0, durationMs: 0, log: [] }]; }
  if (registrations.length === 0) return [];
  const coreProblems = checkGraphInvariants(graph).problems;
  const byPath: Record<string, Array<{ id: string; name: string; kind: string; startLine: number; endLine: number }>> = Object.create(null);
  for (const n of graph.nodes) {
    const match = /^L(\d+)-L(\d+)$/.exec(n.span);
    (byPath[n.path] ??= []).push({ id: n.id, name: n.name, kind: n.kind, startLine: Number(match?.[1] ?? 0), endLine: Number(match?.[2] ?? 0) });
  }
  const deadline = Date.now() + BUILD_BUDGET_MS, runs: ExtensionRun[] = [], budget = validationBudget();
  for (const grant of registrations) {
    const started = Date.now(), runId = randomUUID();
    const record: ExtensionRun = { id: grant.id, digest: grant.digest, status: "skipped", durationMs: 0, nodes: 0, edges: 0, log: [] };
    let stage: RunReasonCode = "audit-error";
    try {
      // If we cannot record execution, do not run unattended code invisibly.
      appendRecord(root, { runId, at: new Date().toISOString(), id: grant.id, digest: grant.digest, status: "started" }, options);
      if (coreProblems.length) { record.reason = "core graph is invalid before extension execution"; record.reasonCode = "core-invalid"; }
      else if (grant.status !== "ready") { record.reason = grant.reason ?? grant.status; record.reasonCode = grant.status === "changed" ? "unapproved-changed" : "package-unavailable"; }
      else if (Date.now() >= deadline) { record.reason = "extension build time budget exhausted"; record.reasonCode = "build-budget-exhausted"; }
      else {
        stage = "package-unavailable";
        const snapshot = packageSnapshot(grant.path);
        stage = "unapproved-changed";
        if (packageDigest(snapshot, grant.config) !== grant.digest) throw new Error("extension package changed after verification");
        stage = "runtime-error";
        const { executeExtension } = await import("./extension-runtime.js");
        const result = await executeExtension({ repoRoot: root, ...snapshot, index: byPath, config: grant.config, excludePaths }, { timeoutMs: Math.min(EXTENSION_MAX_DURATION_MS, deadline - Date.now()) });
        record.status = result.status; record.reason = result.reason; record.reasonCode = result.reasonCode; record.inputFingerprint = result.inputFingerprint; record.log = result.log;
        stage = "merge-rejected";
        if (result.status === "ok") Object.assign(record, mergeExtensionContribution(graph, { nodes: result.nodes, edges: result.edges }, grant, root, deadline, budget));
      }
    } catch (e) { record.status = "failed"; record.reason = errorText(e); record.reasonCode = e instanceof ValidationFailure ? e.reasonCode : stage; }
    record.durationMs = Date.now() - started;
    try {
      // Logs returned by a package can contain source text; retain only bounded
      // operational fields in the durable audit, never the package's free text.
      appendRecord(root, { runId, at: new Date().toISOString(), ...record, log: undefined, reason: undefined }, options);
    } catch (e) { record.reason = extensionDisplayText(`${record.reason ? record.reason + "; " : ""}audit record failed: ${errorText(e)}`); record.reasonCode = "audit-error"; }
    runs.push(record);
  }
  return runs;
}
