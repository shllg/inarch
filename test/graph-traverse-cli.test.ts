/**
 * CLI tests for `inarch callers` and its `--direction`/`--depth` flags — the one
 * command that wires src/graph/traverse.ts's pure resolver + edge-walkers into
 * the `graft` binary (`--direction out` is the old `callees`; `--depth N` is the
 * old `impact`). Runs the real CLI via execFileSync (same pattern as
 * test/mcp-tools.test.ts's `builtRepo` helper) against a built fixture repo,
 * so these tests exercise the actual process boundary: exit codes, stdout vs
 * stderr, and --json shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { callTool } from '../src/mcp/tools.js';

function builtRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-traversecli-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(
    join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
      'export function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n' +
      'export function compute(a: number, b: number): number {\n  return sub(a, b);\n}\n',
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

test('inarch callers: happy path shows header and the caller hit', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /add · function · src\/math\.ts:/);
  assert.match(r.stdout, /calls ← sub \(src\/math\.ts:/);
});

test('inarch callers --json: shape matches {query, matches:[{symbol,hits}]}', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.query, 'add');
  assert.equal(parsed.matches.length, 1);
  const m = parsed.matches[0];
  assert.equal(m.symbol.name, 'add');
  assert.equal(m.symbol.kind, 'function');
  assert.ok(m.symbol.path.endsWith('math.ts'));
  assert.ok(m.symbol.id);
  assert.ok(m.symbol.span);
  assert.equal(m.hits.length, 1);
  assert.equal(m.hits[0].name, 'sub');
  assert.equal(m.hits[0].relation, 'calls');
  assert.equal(m.hits[0].depth, 1);
});

test('inarch callers exposes extension evidence in human and JSON output', () => {
  const d = builtRepo(), file = join(d, 'graft/.graph/wiring.json');
  const graph = JSON.parse(readFileSync(file, 'utf8'));
  const proof = { origin: 'extension', confidence: 'extension', extension: 'a'.repeat(64), extensionDigest: 'b'.repeat(64), via: 'GET /calendars' };
  graph.edges.push({ source: 'src/math.ts#sub', target: 'src/math.ts#add', relation: 'serves', ...proof });
  graph.meta.edgeCount = graph.edges.length;
  writeFileSync(file, JSON.stringify(graph));
  const result = runCli(['callers', 'add', d, '--json', '--no-refresh']);
  assert.equal(result.status, 0);
  const hit = JSON.parse(result.stdout).matches[0].hits.find((h: {relation: string}) => h.relation === 'serves');
  for (const [key, value] of Object.entries(proof)) assert.equal(hit[key], value);
  assert.match(runCli(['callers', 'add', d, '--no-refresh']).stdout, /extension aaaaaaaaaaaa; GET \/calendars/);
});

test('inarch callers: unknown symbol exits 1 with a stderr message', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'noSuchSymbolAnywhere', d]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no symbol "noSuchSymbolAnywhere" in the graph/);
  assert.match(r.stderr, /inarch build/);
  assert.equal(r.stdout, '');
});

test('inarch callers --direction out: happy path shows the outgoing (callee) hit', () => {
  const d = builtRepo();
  // `sub` calls `add`, so its outgoing edge points at add with a `→` arrow.
  const r = runCli(['callers', 'sub', d, '--direction', 'out']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sub · function · src\/math\.ts:/);
  assert.match(r.stdout, /calls → add \(src\/math\.ts:/);
});

test('inarch callers --direction out: zero-edge symbol prints a loud callees note and still exits 0', () => {
  const d = builtRepo();
  // `add` calls nothing, so its callees are empty — must not be a silent list.
  const r = runCli(['callers', 'add', d, '--direction', 'out']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /add · function · src\/math\.ts:/);
  assert.match(r.stdout, /no indexed callees/);
  assert.match(r.stdout, /inarch grep "add"/);
});

test('inarch callers --direction out --json: zero-edge symbol includes a note field', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--direction', 'out', '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.query, 'add');
  assert.equal(parsed.matches.length, 1);
  const m = parsed.matches[0];
  assert.equal(m.symbol.name, 'add');
  assert.equal(m.hits.length, 0);
  assert.ok(m.note, 'zero-edge match must have a note field');
  assert.match(m.note, /inarch grep "add"/);
});

function ambiguousRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'graft-traversecli-ambiguous-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export function shared(): number {\n  return 1;\n}\n');
  writeFileSync(join(d, 'src', 'b.ts'), 'export function shared(): number {\n  return 2;\n}\n');
  // A cross-file call to the ambiguous name through a barrel that re-exports
  // both. The barrel defines no `shared` itself, so resolve.ts falls back to
  // the name index, finds two candidates and drops the edge rather than
  // guessing which `shared` it means — NEITHER definition gets a caller edge.
  // (An import straight from "./a.js" would now resolve to a.ts's `shared`,
  // see graph-resolve-imported-calls.test.ts.)
  writeFileSync(join(d, 'src', 'index.ts'), 'export * from "./a.js";\nexport * from "./b.js";\n');
  writeFileSync(join(d, 'src', 'user.ts'), 'import { shared } from "./index.js";\nexport function use(): number {\n  return shared();\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

test('A6: an ambiguous name (2 definitions) states the candidate count in the zero-hit note', () => {
  const d = ambiguousRepo();
  const r = runCli(['callers', 'shared', d]);
  assert.equal(r.status, 0);
  // Both candidates are reported (resolveSymbol returns every match).
  assert.equal((r.stdout.match(/shared · function · src\//g) ?? []).length, 2);
  // Each zero-hit block states 2 definitions share the name.
  assert.equal((r.stdout.match(/2 definitions share the name/g) ?? []).length, 2);
  assert.match(r.stdout, /dropped rather than guessed/);
});

test('A6 --json: the ambiguous-name note includes the candidate count', () => {
  const d = ambiguousRepo();
  const r = runCli(['callers', 'shared', d, '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.matches.length, 2);
  for (const m of parsed.matches) {
    assert.equal(m.hits.length, 0, 'the ambiguity drop leaves no caller edges for either candidate');
    assert.match(m.note, /2 definitions share the name/);
    assert.match(m.note, /dropped rather than guessed/);
  }
});

test('inarch callers --depth: depth flag walks the BFS transitively (blast radius)', () => {
  const d = builtRepo();
  // compute -> sub -> add: callers of `add` at depth 1 is just `sub`;
  // depth 2 also reaches `compute` and tags each hit with its depth.
  const shallow = runCli(['callers', 'add', d, '--depth', '1']);
  assert.equal(shallow.status, 0);
  assert.match(shallow.stdout, /← sub \(/);
  assert.doesNotMatch(shallow.stdout, /compute/);
  assert.doesNotMatch(shallow.stdout, /\[depth/); // depth 1 → no depth tags

  const deeper = runCli(['callers', 'add', d, '--depth', '2']);
  assert.equal(deeper.status, 0);
  assert.match(deeper.stdout, /← sub \(/);
  assert.match(deeper.stdout, /\[depth 1\]/);
  assert.match(deeper.stdout, /← compute \(/);
  assert.match(deeper.stdout, /\[depth 2\]/);
});

test('inarch callers --depth all: walks the entire connected closure', () => {
  const d = builtRepo();
  // compute -> sub -> add. `all` must reach BOTH hops (the full closure),
  // like an unbounded depth, terminating when no new node is found.
  const all = runCli(['callers', 'add', d, '--depth', 'all']);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /← sub \(/);
  assert.match(all.stdout, /\[depth 1\]/);
  assert.match(all.stdout, /← compute \(/);
  assert.match(all.stdout, /\[depth 2\]/);
});

test('inarch callers --depth: rejects a non-numeric, non-"all" value with exit 1', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--depth', 'banana']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--depth must be a positive number or "all"/);
});

test('inarch callers --direction: rejects a bad value with exit 1', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d, '--direction', 'sideways']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--direction must be "in" or "out"/);
});

test('inarch callers: no graph at all is a stderr error, exit 1', () => {
  const bare = mkdtempSync(join(tmpdir(), 'graft-traversecli-bare-'));
  const r = runCli(['callers', 'add', bare]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inarch build/);
});

test('inarch callers: quotes the call site, and only where it is the right line', () => {
  const d = builtRepo();
  const r = runCli(['callers', 'add', d]);
  assert.equal(r.status, 0);
  // `sub` calls `add` on line 5 of the fixture. The edge is a claim; this is the
  // evidence, and it saves opening the file to check.
  assert.match(r.stdout, /calls ← sub \(src\/math\.ts:[^)]*\)\n\s+5: return add\(a, -b\);/);

  // A second-hop hit references what is BETWEEN it and the symbol, not the symbol
  // itself, so quoting it would point at the wrong line.
  const deep = runCli(['callers', 'add', d, '--depth', '2']);
  assert.match(deep.stdout, /calls ← compute \(src\/math\.ts:[^)]*\) \[depth 2\]\n/);
  assert.ok(!/\[depth 2\]\n\s+\d+:/.test(deep.stdout), 'no quote on a second-hop hit');

  // --json is a data contract: the quote is a text-output nicety and must stay out.
  const json = JSON.parse(runCli(['callers', 'add', d, '--json']).stdout);
  assert.ok(!JSON.stringify(json).includes('return add(a, -b)'));
});

test('CLI and MCP workflow traces retain guards and receiver evidence while plain calls stay plain', async () => {
  const d = builtRepo(), file = join(d, 'graft/.graph/wiring.json');
  const graph = JSON.parse(readFileSync(file, 'utf8'));
  const enqueue = graph.edges.find((edge: { source: string; relation: string }) => edge.source === 'src/math.ts#compute' && edge.relation === 'calls');
  enqueue.relation = 'enqueues';
  enqueue.confidence = 'convention';
  enqueue.via = 'GoodJob 4.19.2 concurrency/labels guards may abort or retry';
  graph.edges.push({ source: 'src/math.ts#compute', target: 'src/math.ts#add', relation: 'dispatches', confidence: 'ruby_dispatch', via: 'Ruby self.run_guards: possible receiver EmailRouteService (known receivers only)' });
  graph.meta.edgeCount = graph.edges.length;
  writeFileSync(file, JSON.stringify(graph));

  for (const depth of [1, 'all'] as const) {
    const cli = runCli(['callers', 'compute', d, '--direction', 'out', '--depth', String(depth), '--no-refresh']);
    const mcp = await callTool(d, 'graft_trace_calls', { symbol: 'compute', direction: 'out', depth });
    assert.equal(cli.status, 0);
    assert.equal(mcp.isError, false);
    for (const text of [cli.stdout, mcp.text]) {
      assert.match(text, /enqueues → sub .*\[convention; GoodJob 4\.19\.2 concurrency\/labels guards may abort or retry\]/);
      assert.match(text, /dispatches → add .*\[ruby_dispatch; Ruby self\.run_guards: possible receiver EmailRouteService \(known receivers only\)\]/);
    }
  }
  const plainCli = runCli(['callers', 'sub', d, '--direction', 'out', '--no-refresh']);
  const plainMcp = await callTool(d, 'graft_trace_calls', { symbol: 'sub', direction: 'out' });
  for (const text of [plainCli.stdout, plainMcp.text]) {
    const line = text.split('\n').find(line => line.includes('calls → add'));
    assert.match(line!, /^  calls → add \(src\/math\.ts:L\d+-L\d+\)$/);
  }
});

for (const jobPath of ['jobs.rb', "jobs 'quoted' $GRAFT_HINT_QUOTE_TEST `printf expanded`.rb"]) {
test(`ActiveJob class navigation follows the exact inherited perform locator in ${jobPath}`, async () => {
  const d = mkdtempSync(join(tmpdir(), 'graft-job-navigation-'));
  writeFileSync(join(d, 'Gemfile'), 'gem "rails"');
  mkdirSync(join(d, 'config'));
  writeFileSync(join(d, 'config/application.rb'), 'require "rails/all"');
  writeFileSync(join(d, jobPath), `class ApplicationJob < ActiveJob::Base; end
module Mail
 class BaseJob < ApplicationJob; def perform; end; end
 class DeliveryJob < BaseJob; end
end
module Other
 class DeliveryJob; def perform; end; end
end
class Runner
 def queue; Mail::DeliveryJob.perform_later; end
end`);
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  const cli = runCli(['callers', 'Mail.DeliveryJob', d, '--no-refresh']);
  const mcp = await callTool(d, 'graft_trace_calls', { symbol: 'Mail.DeliveryJob' });
  const json = JSON.parse(runCli(['callers', 'Mail.DeliveryJob', d, '--json', '--no-refresh']).stdout);
  for (const text of [cli.stdout, mcp.text, json.matches[0].hint]) {
    const command = text.match(/ActiveJob entrypoint: (.+) — inspect perform and its enqueuers/)?.[1];
    assert.ok(command, text);
    // Let a real shell decode the emitted command, but capture its arguments
    // instead of invoking an installed binary. The filename's substitutions
    // are harmless witnesses that quoting preserves literal source paths.
    const args = execFileSync('/bin/sh', ['-c', String.raw`inarch() { printf '%s\0' "$@"; }; ` + command], {
      encoding: 'utf8', env: { ...process.env, GRAFT_HINT_QUOTE_TEST: 'expanded' },
    }).split('\0').slice(0, -1);
    const followed = runCli([...args, d, '--json', '--no-refresh']);
    assert.equal(followed.status, 0, followed.stderr);
    const targets = JSON.parse(followed.stdout).matches;
    assert.deepEqual(targets.map((match: { symbol: { id: string } }) => match.symbol.id), [`${jobPath}#Mail.BaseJob.perform`]);
    assert.deepEqual(args, ['callers', 'Mail.BaseJob.perform', '--in', jobPath]);
    assert.ok(targets[0].hits.some((hit: { relation: string; name: string }) => hit.relation === 'enqueues' && hit.name === 'queue'));
  }
  for (const text of [cli.stdout, mcp.text]) {
    assert.match(text, /DeliveryJob · class/);
  }
  const plain = runCli(['callers', 'Other.DeliveryJob', d, '--no-refresh']);
  assert.doesNotMatch(plain.stdout, /ActiveJob entrypoint/);
  const ambiguous = runCli(['callers', 'DeliveryJob', d, '--no-refresh']);
  assert.equal((ambiguous.stdout.match(/ActiveJob entrypoint/g) ?? []).length, 1);
  assert.ok(json.matches[0].hits.some((hit: { relation: string }) => hit.relation === 'references'));
});
}

for (const fixture of [
  {
    name: 'class and instance perform methods', query: 'DeliveryJob',
    target: 'jobs.rb#DeliveryJob.perform~2', reason: /exact callers selection unsupported/,
    source: `class ApplicationJob < ActiveJob::Base; end
class DeliveryJob < ApplicationJob
 def self.perform; end
 def perform; end
end
class Runner; def queue; DeliveryJob.perform_later; end; end`,
  },
  {
    name: 'same-file nested namespace suffix', query: 'Mail.DeliveryJob',
    target: 'jobs.rb#Mail.BaseJob.perform', reason: /ambiguous callers selection \(2 matches\)/,
    source: `class ApplicationJob < ActiveJob::Base; end
module Mail; class BaseJob < ApplicationJob; def perform; end; end; class DeliveryJob < BaseJob; end; end
module Other; module Mail; class BaseJob; def perform; end; end; end; end
class Runner; def queue; Mail::DeliveryJob.perform_later; end; end`,
  },
]) {
  test(`ActiveJob navigation retains a source locator when selection cannot distinguish ${fixture.name}`, async () => {
    const d = mkdtempSync(join(tmpdir(), 'graft-job-navigation-fallback-'));
    writeFileSync(join(d, 'Gemfile'), 'gem "rails"');
    mkdirSync(join(d, 'config'));
    writeFileSync(join(d, 'config/application.rb'), 'require "rails/all"');
    writeFileSync(join(d, 'jobs.rb'), fixture.source);
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
    const graph = JSON.parse(readFileSync(join(d, 'graft/.graph/wiring.json'), 'utf8'));
    assert.deepEqual(graph.edges.filter((edge: { relation: string }) => edge.relation === 'enqueues')
      .map((edge: { target: string }) => edge.target), [fixture.target]);
    const target = graph.nodes.find((node: { id: string }) => node.id === fixture.target);
    assert.ok(target);
    const cli = runCli(['callers', fixture.query, d, '--no-refresh']);
    assert.equal(cli.status, 0, cli.stderr);
    const mcp = await callTool(d, 'graft_trace_calls', { symbol: fixture.query });
    const json = JSON.parse(runCli(['callers', fixture.query, d, '--json', '--no-refresh']).stdout);
    assert.equal(json.matches.length, 1);
    for (const text of [cli.stdout, mcp.text, json.matches[0].hint]) {
      const hint = text.split('\n').find((line: string) => line.includes('ActiveJob entrypoint:'));
      assert.ok(hint, text);
      assert.doesNotMatch(hint, /inarch callers/);
      assert.ok(hint.includes(target.id), hint);
      assert.ok(hint.includes(`${target.path}:${target.span}`), hint);
      assert.match(hint, fixture.reason);
    }
  });
}
