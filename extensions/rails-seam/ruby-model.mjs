/**
 * The Ruby side of this package: a source-backed model of classes, ancestors,
 * method ownership and visibility, shared by the seam scanner and the runtime
 * analyzers. It answers only what the source proves. Every lookup returns null
 * rather than a guess, because a wrong edge costs an agent a bad refactor while
 * a missing one costs it a grep.
 */
import { parseRuby, field, children, walk, tokens, normalized, literal, constName } from './ruby.mjs';


// A declared shape is compared as a normalized token stream, so formatting and
// comments cannot make a changed body look unchanged, and reformatting a body
// that still means the same thing does not silently drop its edges.
const canonical = new Map();
export const same = (node, source) => {
  if (!canonical.has(source)) {
    let value = normalized(source);
    if (value === null && source.startsWith('{')) { const tree = parseRuby('x ' + source); value = tokens(field(children(tree?.rootNode)[0], 'block')); tree?.delete(); }
    canonical.set(source, value);
  }
  return tokens(node) === canonical.get(source);
};
export const methodName = node => field(node, 'method')?.text;
export const args = node => children(field(node, 'arguments'));
export function hash(node) {
  if (!node || !['hash', 'argument_list'].includes(node.type)) return null;
  const result = new Map();
  for (const pair of children(node)) {
    const key = field(pair, 'key'), value = field(pair, 'value');
    if (pair.type !== 'pair' || key?.type !== 'hash_key_symbol' || result.has(key.text)) return null;
    result.set(key.text, value);
  }
  return result;
}
export function unfreeze(node) {
  return node?.type === 'call' && methodName(node) === 'freeze' && !field(node, 'arguments') && !field(node, 'block') ? field(node, 'receiver') : null;
}
export function descendants(node, predicate) { const result = []; if (node) walk(node, n => { if (predicate(n)) result.push(n); }); return result; }
// Which directories hold the application's own Ruby is a convention, not a fact
// about Ruby, so it is configuration with the Rails default. Widening it past
// the application's own code pulls vendored gems into class resolution, where a
// duplicate class name silently turns a single definition into an ambiguous one.
export function rubyModel(ctx, options = {}) {
  const roots = options.roots ?? ['app/'];
  const trees = new Map(), classes = new Map();
  for (const [file, symbols] of Object.entries(ctx.index.byPath)) {
    if (!roots.some(root => file.startsWith(root)) || !file.endsWith('.rb')) continue;
    for (const symbol of symbols.filter(n => n.kind === 'class' || n.kind === 'module')) {
      const name = symbol.id.split('#')[1]?.replace(/@.*$/, '').replaceAll('.', '::');
      if (!name) continue;
      const records = classes.get(name) ?? []; records.push({ file, symbol }); classes.set(name, records);
    }
  }
  function tree(file) {
    if (!trees.has(file)) { const source = ctx.readFile(file); trees.set(file, source === null ? null : parseRuby(source)); }
    return trees.get(file);
  }
  function classFor(name) {
    const records = classes.get(name);
    if (records?.length !== 1) return null;
    const record = records[0], root = tree(record.file)?.rootNode;
    if (!root) return null;
    const matches = [];
    function visit(node, nesting = [], unconditional = true) {
      if (node.type === 'class' || node.type === 'module') {
        const raw = field(node, 'name')?.text, local = constName(field(node, 'name'));
        if (!local) return;
        const full = raw.startsWith('::') ? local : [...nesting, local].join('::');
        if (full === name) matches.push({ ...record, node, nesting, unconditional, full });
        for (const child of children(field(node, 'body'))) visit(child, [...nesting, local], unconditional);
      } else {
        for (const child of children(node)) visit(child, nesting, unconditional && ['program', 'body_statement'].includes(node.type));
      }
    }
    visit(root);
    return matches.length === 1 && matches[0].unconditional ? matches[0] : null;
  }
  function ownMethod(record, name, singleton) {
    if (!record) return null;
    const found = [];
    let uncertain = false;
    function visit(node, isSingleton = false, unconditional = true) {
      if (node.type === 'singleton_class' && field(node, 'value')?.type === 'self') {
        for (const child of children(field(node, 'body'))) visit(child, true, unconditional);
      } else if (node.type === 'method' || node.type === 'singleton_method') {
        const receiver = field(node, 'object');
        if (field(node, 'name')?.text === name && (node.type === 'singleton_method' ? receiver?.type === 'self' : isSingleton) === singleton) {
          found.push(node); if (!unconditional) uncertain = true;
        }
      } else if (!['class', 'module'].includes(node.type)) for (const child of children(node)) visit(child, isSingleton, false);
    }
    for (const child of children(field(record.node, 'body'))) visit(child);
    if (found.length !== 1 || uncertain) return null;
    const node = found[0];
    let visibility = 'public', currentVisibility = 'public';
    for (const statement of children(node.parent)) {
      if (statement.id === node.id) visibility = currentVisibility;
      const marker = statement.type === 'identifier' ? statement.text : statement.type === 'call' && !field(statement, 'receiver') ? methodName(statement) : null;
      if (!['public', 'private', 'protected'].includes(marker)) continue;
      const names = args(statement);
      if (!names.length) currentVisibility = marker;
      else if (names.some(n => n.type === 'simple_symbol' && n.text.slice(1) === name)) visibility = marker;
    }
    const graph = (ctx.index.byPath[record.file] ?? []).filter(n => n.kind === 'method' && n.name === name && n.startLine >= node.startPosition.row + 1 && n.endLine <= node.endPosition.row + 1);
    return graph.length === 1 ? { node, symbol: graph[0], record, visibility } : null;
  }
  function parent(record) {
    const superNode = children(field(record.node, 'superclass'))[0];
    const raw = superNode?.text, name = constName(superNode);
    if (!name) return null;
    const candidates = raw.startsWith('::') ? [name] : [...record.nesting.map((_, i) => record.nesting.slice(0, record.nesting.length - i).join('::') + '::' + name), name];
    for (const candidate of candidates) if (classes.has(candidate)) return classFor(candidate);
    return null;
  }
  function classHazards(record) {
    const hazards = [];
    function visit(node) {
      if (['method', 'singleton_method', 'class', 'module'].includes(node.type)) return;
      if (node.type === 'call' && ['include', 'prepend', 'extend', 'define_method', 'alias_method', 'class_eval', 'module_eval'].includes(methodName(node))) hazards.push(methodName(node));
      for (const child of children(node)) visit(child);
    }
    for (const child of children(field(record.node, 'body'))) visit(child);
    return hazards;
  }
  function visibleOnReceiver(record, name, singleton, target) {
    let visibility = target.visibility, uncertain = false;
    const after = target.record.full === record.full ? target.node.endIndex : -1;
    function visit(node, singletonScope = false, unconditional = true) {
      if (['class', 'module', 'method', 'singleton_method'].includes(node.type)) return;
      if (node.type === 'singleton_class') {
        if (field(node, 'value')?.type === 'self') for (const child of children(field(node, 'body'))) visit(child, true, unconditional);
        return;
      }
      const marker = node.type === 'call' && !field(node, 'receiver') ? methodName(node) : null;
      const classMarker = ['private_class_method', 'public_class_method'].includes(marker);
      if (node.startIndex > after && (singletonScope === singleton && ['private', 'protected', 'public'].includes(marker) || singleton && !singletonScope && classMarker)) {
        const values = args(node);
        if (values.length) {
          const names = values.map(n => n.type === 'simple_symbol' ? n.text.slice(1) : literal(n));
          if (names.some(n => n === null)) uncertain = true;
          else if (names.includes(name)) {
            if (!unconditional) uncertain = true;
            else visibility = marker.replace('_class_method', '');
          }
        }
      }
      for (const child of children(node)) visit(child, singletonScope, unconditional && ['body_statement', 'program'].includes(node.type));
    }
    for (const child of children(field(record.node, 'body'))) visit(child);
    return uncertain ? null : { ...target, visibility };
  }
  function lookup(name, method, singleton = false, seen = new Set()) {
    if (seen.has(name) || seen.size > 12) return null;
    seen = new Set(seen).add(name);
    const record = classFor(name);
    if (!record) return null;
    // include/extend sit behind methods defined on the receiver itself;
    // prepend sits ahead. Calls inside method bodies do not change ancestors.
    const hazards = classHazards(record);
    if (hazards.some(name => ['prepend', 'define_method', 'alias_method', 'class_eval', 'module_eval'].includes(name))) return null;
    const own = ownMethod(record, method, singleton);
    if (own) return visibleOnReceiver(record, method, singleton, own);
    // A conditional or duplicate declaration cannot establish absence.
    if (descendants(field(record.node, 'body'), n => ['method', 'singleton_method'].includes(n.type) && field(n, 'name')?.text === method).length) return null;
    if (hazards.some(name => singleton ? name === 'extend' : name === 'include')) return null;
    const inherited = parent(record);
    const target = inherited ? lookup(inherited.full, method, singleton, seen) : null;
    return target ? visibleOnReceiver(record, method, singleton, target) : null;
  }
  function defaultConstructor(name, seen = new Set()) {
    if (seen.has(name) || seen.size > 12) return false;
    seen = new Set(seen).add(name);
    const record = classFor(name);
    if (!record || classHazards(record).length) return false;
    // lookup(null) also means a conditional constructor or unknown ancestor.
    // Prove the entire source-defined chain has no constructor override before
    // treating .new as ordinary allocation of the registered class.
    if (descendants(field(record.node, 'body'), n => ['method', 'singleton_method'].includes(n.type) && field(n, 'name')?.text === 'new').length) return false;
    if (!field(record.node, 'superclass')) return true;
    const inherited = parent(record);
    return inherited ? defaultConstructor(inherited.full, seen) : false;
  }
  function assignment(record, name) {
    if (!record) return null;
    const uses = descendants(tree(record.file)?.rootNode, n => n.type === 'assignment' && field(n, 'left')?.text === name);
    if (uses.length !== 1 || !children(field(record.node, 'body')).some(n => n.id === uses[0].id)) return null;
    const writes = descendants(tree(record.file)?.rootNode, n => n.type === 'singleton_class' && field(n, 'value')?.text === name
      || n.type === 'singleton_method' && field(n, 'object')?.text === name
      || n.type === 'binary' && field(n, 'left')?.text === name && field(n, 'operator')?.text === '<<'
      || n.type === 'assignment' && field(n, 'left')?.type === 'element_reference' && field(field(n, 'left'), 'object')?.text === name
      || n.type === 'assignment' && field(n, 'right')?.text === name
      || n.type === 'call' && args(n).some(arg => arg.text === name)
      || n.type === 'operator_assignment' && field(n, 'left')?.text === name
      || n.type === 'call' && field(n, 'receiver')?.text === name && ['<<', 'push', 'append', 'concat', 'replace', 'merge!', 'clear', 'delete', 'delete_at', 'shift', 'pop', '[]='].includes(methodName(n)));
    return writes.length ? null : uses[0];
  }
  return { tree, classFor, ownMethod, lookup, parent, assignment, defaultConstructor, classHazards, close: () => { for (const t of trees.values()) t?.delete(); } };
}

