/** Standalone measurement uses the same scanner and graph identities as the extension. */
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSeam } from './extension.mjs';

export function standaloneContext(repo, graph, config) {
  const root = realpathSync(repo), files = [];
  const pruned = new Set(['node_modules', 'graft', 'vendor', 'tmp', 'log', 'coverage', 'dist', 'build']);
  const secret = /(?:\.(?:pem|key|p12|pfx)$|^(?:credentials|secrets)(?:\.|$))/i;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || pruned.has(entry.name) || secret.test(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
    }
  }
  walk(root);
  const allowed = new Set(files), byPath = {}, ids = new Set();
  for (const node of graph.nodes) {
    const span = /^L(\d+)-L(\d+)$/.exec(node.span);
    if (!span) continue;
    (byPath[node.path] ??= []).push({ id: node.id, name: node.name, kind: node.kind, startLine: Number(span[1]), endLine: Number(span[2]) });
    ids.add(node.id);
  }
  return {
    repoRoot: root, config, log: () => {},
    readFile(file) {
      if (!allowed.has(file)) return null;
      const absolute = join(root, file), canonical = realpathSync(absolute);
      if (!canonical.startsWith(root + '/') || lstatSync(absolute).isSymbolicLink()) return null;
      return readFileSync(absolute, 'utf8');
    },
    listFiles: (dir = '.') => files.filter(file => dir === '.' || file.startsWith(dir + '/')).sort(),
    index: { byPath, has: id => ids.has(id), enclosing(file, line) {
      return (byPath[file] ?? []).filter(node => node.kind !== 'file' && node.startLine <= line && node.endLine >= line)
        .sort((a, b) => a.endLine - a.startLine - b.endLine + b.startLine)[0] ?? null;
    } },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, graphPath, configPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  // The configuration names the application's own client module and roots, so
  // there is no default that could be right. A bundled placeholder would only
  // produce an empty scan that reads like the repository has no call sites.
  if (!repo || !graphPath || !configPath) throw Error('usage: node seam.mjs REPO WIRING_JSON CONFIG_JSON [--json]');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const result = scanSeam(standaloneContext(repo, graph, config));
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(JSON.stringify(result.stats));
    for (const miss of result.misses) console.log(`${miss.reason}: ${miss.file}:${miss.line} ${miss.verb} ${miss.rawPath}`);
  }
}
