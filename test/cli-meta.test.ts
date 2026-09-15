import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { formatVersionReport, resolvePackageJsonPath, readCurrentVersion } from '../src/cli-meta.js';

// --- formatVersionReport: pure formatting, no network ---
//
// There is nothing to compare against. Inarch installs from a git tag, so npm
// cannot answer "is there a newer one", and the inherited implementation asked
// npm about a different package entirely.

test('formatVersionReport names the package and the installed version', () => {
  assert.equal(formatVersionReport('0.4.4'), 'inarch 0.4.4');
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  assert.equal(resolvePackageJsonPath(fakeDistCli), resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  assert.equal(resolvePackageJsonPath(fakeSrcCli), resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});
