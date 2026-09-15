/**
 * The session-start hook's self-maintenance pass, end to end: it must refresh
 * wiring an older graft wrote and — critically — never touch the network,
 * because it runs inside Claude Code's hook timeout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/claude/hooks.js';
import { readStamp, runningVersion } from '../src/upkeep.js';
import { tmpRepo } from './helpers.js';

/** A repo that looks like a previous `inarch init` ran here, with no stamp — i.e.
 * wired by a graft old enough not to have written one. */
function wiredRepo(tag: string): string {
  const repo = tmpRepo(tag);
  mkdirSync(join(repo, '.claude', 'helpers'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'helpers', 'graft-hooks.cjs'), '// wired by an old graft\n');
  return repo;
}

/** A fake home for the hook to resolve machine-global paths against. */
function fakeHome(tag: string): string {
  return tmpRepo(tag);
}

/** Runs the hook in-process with stdin/home/project-dir stubbed, returns stdout. */
async function runHook(event: string, repo: string, home: string): Promise<string> {
  const saved = {
    write: process.stdout.write,
    stdin: process.env.GRAFT_TEST_STDIN,
    home: process.env.HOME,
    profile: process.env.USERPROFILE,
    dir: process.env.CLAUDE_PROJECT_DIR,
  };
  let out = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.env.GRAFT_TEST_STDIN = JSON.stringify({ cwd: repo, session_id: 'test' });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_PROJECT_DIR = repo;
  try {
    await main(event);
  } finally {
    process.stdout.write = saved.write;
    if (saved.stdin === undefined) delete process.env.GRAFT_TEST_STDIN; else process.env.GRAFT_TEST_STDIN = saved.stdin;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
    if (saved.dir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.dir;
  }
  return out;
}

function contextOf(stdout: string): string {
  if (!stdout) return '';
  return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
}

test('session-start refreshes stale wiring and stamps it', async () => {
  const repo = wiredRepo('hook-refresh');
  const ctx = contextOf(await runHook('session-start', repo, fakeHome('hook-refresh-home')));

  assert.match(ctx, /refreshed this repo's agent wiring/);
  assert.match(ctx, /written by unwired, now /);
  // The wiring was actually re-written, not just announced.
  assert.ok(existsSync(join(repo, '.claude', 'settings.json')));
  assert.ok(existsSync(join(repo, '.claude', 'skills', 'inarch', 'SKILL.md')));
  assert.equal(readStamp(repo)?.version, runningVersion());
  assert.deepEqual(readStamp(repo)?.hosts, ['claude']);
});

test('session-start says nothing on a second run — the stamp now matches', async () => {
  const repo = wiredRepo('hook-idempotent');
  const home = fakeHome('hook-idempotent-home');
  await runHook('session-start', repo, home);
  const ctx = contextOf(await runHook('session-start', repo, home));
  assert.doesNotMatch(ctx, /refreshed this repo's agent wiring/);
});

test('the hook never reaches the network', async () => {
  // There is no registry check left to make, and no cache to read one from.
  // The assertion is the hook's whole budget: Claude Code kills it on a timeout,
  // so anything that shelled out to `npm view` would spend the session's first
  // turn on it.
  const repo = wiredRepo('hook-offline');
  const before = Date.now();
  await runHook('session-start', repo, fakeHome('hook-offline-home'));
  assert.ok(Date.now() - before < 2000, 'no network round trip');
});

test('an unwired repo is left completely alone', async () => {
  const repo = tmpRepo('hook-unwired');
  const out = await runHook('session-start', repo, fakeHome('hook-unwired-home'));
  assert.equal(out, '', 'no INDEX.md, no wiring, nothing to say');
  assert.equal(existsSync(join(repo, '.claude')), false, 'never wires a repo that was not wired');
});

test('upkeep still lands in a wired repo with no graph built yet', async () => {
  const repo = wiredRepo('hook-nograph');
  const ctx = contextOf(await runHook('session-start', repo, fakeHome('hook-nograph-home')));
  assert.match(ctx, /refreshed this repo's agent wiring/, 'the no-INDEX.md path still reports upkeep');
});
