/**
 * Rails runtime dispatch, verified against declared source shapes.
 *
 * A tool registry, an ordered classifier chain and a cron table are all forms of
 * indirection: the call target is chosen at runtime out of data, so an extractor
 * that reads only the call site sees nothing at all. This analyzer reads the data
 * instead — but it emits an edge only while the surrounding source still matches
 * the shape its configuration declares, token for token.
 *
 * The shapes are configuration rather than literals in this file because the
 * application they describe is not this package's to know. What stays here is
 * the proof procedure. When an application is refactored the declared shape
 * stops matching and its edges disappear, and that is the correct failure: an
 * agent given no edge runs a grep, while an agent given a stale edge rewrites
 * the wrong method.
 */
import { field, children, literal, constName } from './ruby.mjs';
import { rubyModel, same, methodName, args, hash, unfreeze, descendants } from './ruby-model.mjs';

// Ruby spellings this configuration is allowed to name. A pattern that is too
// permissive here would let a malformed value reach a tree-sitter comparison and
// silently match nothing, which reads as "the application changed" rather than
// "the configuration is wrong".
const CONST = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;
const SCOPED_CONST = /^[A-Z]\w*$/;
const METHOD = /^[a-zA-Z_]\w*[?!]?$/;
const LOCAL = /^[a-z_]\w*$/;
const FIELD = /^[a-z_]\w*$/;
const RECEIVER = /^[A-Z]\w*(?:\.[a-z_]\w*)*$/;
const SYMBOL = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
// include/extend sit behind methods defined on the receiver itself; prepend sits
// ahead. These five can put a different method in front of a verified one, so a
// class that uses any of them cannot have its dispatch proved from source.
const RESHAPERS = ['prepend', 'define_method', 'alias_method', 'class_eval', 'module_eval'];

const cleanPath = value => typeof value === 'string' && value.length && !value.startsWith('/')
  && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const source = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw Error(message); };

function methodShape(value, label) {
  if (!value || typeof value !== 'object' || !METHOD.test(value.name ?? '') || !source(value.body)) {
    fail(`${label} requires a method name and the source body it must match`);
  }
  return { name: value.name, body: value.body };
}

function registryConfig(r) {
  if (!r || typeof r !== 'object' || !cleanPath(r.file) || !CONST.test(r.class ?? '')) {
    fail('railsRuntime.registry requires a repository-relative file and a Ruby class name');
  }
  const entry = r.entry ?? {};
  if (!SCOPED_CONST.test(entry.const ?? '') || !source(entry.shape)) {
    fail('railsRuntime.registry.entry requires const and the shape its assignment must match');
  }
  const table = r.table ?? {};
  if (!SCOPED_CONST.test(table.const ?? '') || !source(table.block) || !Array.isArray(table.fields)
    || !table.fields.length || !table.fields.every(f => FIELD.test(f)) || new Set(table.fields).size !== table.fields.length
    || !table.fields.includes(table.key) || !table.fields.includes(table.target)
    || (table.select !== undefined && !table.fields.includes(table.select))
    || (table.keyPrefix !== undefined && !source(table.keyPrefix))) {
    fail('railsRuntime.registry.table requires const, block, unique fields, and key/target/select drawn from those fields');
  }
  const methods = r.methods ?? {};
  const resolver = methodShape(methods.resolver, 'railsRuntime.registry.methods.resolver');
  const list = methodShape(methods.list, 'railsRuntime.registry.methods.list');
  const lookup = methodShape(methods.lookup, 'railsRuntime.registry.methods.lookup');
  let dispatcher = null;
  if (r.dispatcher !== undefined) {
    const d = r.dispatcher;
    if (!d || typeof d !== 'object' || !cleanPath(d.file) || !CONST.test(d.class ?? '') || !METHOD.test(d.method ?? '')
      || !LOCAL.test(d.local ?? '') || !source(d.assignment) || !METHOD.test(d.invokes ?? '')) {
      fail('railsRuntime.registry.dispatcher requires file, class, method, local, assignment and invokes');
    }
    dispatcher = { file: d.file, class: d.class, method: d.method, local: d.local, assignment: d.assignment, invokes: d.invokes };
  }
  return {
    file: r.file, class: r.class,
    entry: { const: entry.const, shape: entry.shape },
    table: { const: table.const, block: table.block, fields: [...table.fields], key: table.key, target: table.target, select: table.select ?? null, keyPrefix: table.keyPrefix ?? null },
    methods: { resolver, list, lookup }, dispatcher,
  };
}

function chainConfig(c) {
  if (!c || typeof c !== 'object' || !cleanPath(c.file) || !CONST.test(c.class ?? '') || !SCOPED_CONST.test(c.const ?? '')) {
    fail('railsRuntime.chain requires a repository-relative file, a Ruby class name and the constant holding the ordered list');
  }
  const methods = c.methods ?? {};
  const list = methodShape(methods.list, 'railsRuntime.chain.methods.list');
  const caller = methodShape(methods.caller, 'railsRuntime.chain.methods.caller');
  if (!Array.isArray(c.probes) || !c.probes.length || !c.probes.every(p => METHOD.test(p)) || new Set(c.probes).size !== c.probes.length) {
    fail('railsRuntime.chain.probes requires the unique method names the chain calls on each member');
  }
  return { file: c.file, class: c.class, const: c.const, methods: { list, caller }, probes: [...c.probes] };
}

function schedulerConfig(s) {
  if (!s || typeof s !== 'object' || !cleanPath(s.file)) fail('railsRuntime.scheduler requires a repository-relative file');
  const receiver = s.receiver ?? 'Rails.application';
  const accessor = s.config ?? 'config';
  const configure = s.configure ?? 'configure';
  const jobBase = s.jobBase ?? 'ActiveJob::Base';
  const jobMethod = s.jobMethod ?? 'perform';
  const settings = s.settings ?? [];
  const entry = s.entry ?? {};
  if (!RECEIVER.test(receiver) || !LOCAL.test(accessor) || !METHOD.test(configure) || !METHOD.test(s.namespace ?? '')
    || !METHOD.test(s.setting ?? '') || !LOCAL.test(s.local ?? '') || !CONST.test(jobBase) || !METHOD.test(jobMethod)
    || !Array.isArray(settings) || !settings.every(name => METHOD.test(name)) || settings.includes(s.setting)
    || !FIELD.test(entry.schedule ?? '') || !FIELD.test(entry.class ?? '')
    || !SYMBOL.test(s.symbol ?? '') || !source(s.label) || /[\r\n]/.test(s.label)) {
    fail('railsRuntime.scheduler requires namespace, setting, local, entry.schedule, entry.class, symbol and label');
  }
  return {
    file: s.file, receiver, accessor, configure, namespace: s.namespace, setting: s.setting, local: s.local,
    settings: [...settings], entry: { schedule: entry.schedule, class: entry.class },
    jobBase, jobMethod, symbol: s.symbol, label: s.label,
  };
}

function configuration(ctx) {
  const config = ctx.config?.railsRuntime;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('railsRuntime requires a configuration object naming the registry, chain or scheduler to verify');
  }
  const registry = config.registry === undefined ? null : registryConfig(config.registry);
  const chain = config.chain === undefined ? null : chainConfig(config.chain);
  const scheduler = config.scheduler === undefined ? null : schedulerConfig(config.scheduler);
  if (!registry && !chain && !scheduler) fail('railsRuntime requires at least one of registry, chain or scheduler');
  const declared = config.sourceRoots ?? ['app'];
  if (!Array.isArray(declared) || !declared.length || !declared.every(root => cleanPath(String(root).replace(/\/+$/, '')))) {
    fail('railsRuntime.sourceRoots requires repository-relative directories');
  }
  // Prefix matching without the separator would let a root named "app" also
  // claim "application.rb" at the repository root.
  return { registry, chain, scheduler, roots: declared.map(root => String(root).replace(/\/+$/, '') + '/') };
}

function preservesLocalBinding(body, assignment, name) {
  const initialWrite = field(assignment, 'left');
  // Counting assignments misses destructuring, rescue targets, patterns and
  // Ruby for variables. Instead every occurrence must be a known read position
  // or the one established binding. Unknown grammar positions decline, including
  // nested scope binders even when they might only shadow the outer local.
  for (const node of descendants(body, () => true)) {
    if (node.type === 'call' && ['eval', 'instance_eval', 'class_eval', 'module_eval', 'binding', 'local_variable_set', 'send', '__send__', 'public_send', 'method', 'public_method'].includes(methodName(node))) return false;
    if (node.type === 'identifier' && node.text === 'binding') return false;
    // Literal =~ can introduce locals through named regexp captures without an
    // identifier node for the new local. It is outside the supported dataflow.
    if (node.type === 'binary' && field(node, 'operator')?.text === '=~') return false;
    if (!['identifier', 'hash_key_symbol'].includes(node.type) || node.text !== name || node.id === initialWrite.id) continue;
    const parent = node.parent;
    if (node.type === 'hash_key_symbol') {
      if (parent?.type === 'pair' && field(parent, 'key')?.id === node.id) continue;
      return false;
    }
    if (parent?.type === 'call' && (field(parent, 'receiver')?.id === node.id || field(parent, 'method')?.id === node.id)) continue;
    if (parent?.type === 'assignment' && field(parent, 'right')?.id === node.id) continue;
    if (parent?.type === 'pair' && field(parent, 'value')?.id === node.id) continue;
    if (['if', 'unless', 'if_modifier', 'unless_modifier', 'while', 'until'].includes(parent?.type) && field(parent, 'condition')?.id === node.id) continue;
    if (['argument_list', 'array', 'binary', 'unary', 'element_reference', 'interpolation', 'splat_argument', 'block_argument', 'body_statement', 'block_body', 'parenthesized_statements'].includes(parent?.type)) continue;
    return false;
  }
  return true;
}

function registryEdges(cfg, m, edges) {
  const r = cfg.registry;
  if (!r) return;
  const record = m.classFor(r.class);
  if (record?.file !== r.file || m.classHazards(record).some(name => RESHAPERS.includes(name))) return;
  const entry = m.assignment(record, r.entry.const);
  if (!entry || !same(field(entry, 'right'), r.entry.shape)) return;
  const assignment = m.assignment(record, r.table.const);
  const toHash = unfreeze(field(assignment, 'right'));
  if (toHash?.type !== 'call' || methodName(toHash) !== 'to_h' || !same(field(toHash, 'block'), r.table.block)) return;
  const array = field(toHash, 'receiver');
  if (array?.type !== 'array') return;
  const entries = [], keys = new Set();
  for (const row of children(array)) {
    if (row.type !== 'call' || field(row, 'receiver')?.text !== r.entry.const || methodName(row) !== 'new' || field(row, 'block')) return;
    const fields = hash(field(row, 'arguments'));
    if (!fields || [...fields.keys()].some(k => !r.table.fields.includes(k))) return;
    const key = literal(fields.get(r.table.key)), target = literal(fields.get(r.table.target));
    const selected = r.table.select ? fields.get(r.table.select) : null;
    if (!key || !target || !/^\w+(?:\.\w+)*$/.test(key) || !CONST.test(target) || keys.has(key)
      || selected && !['true', 'false'].includes(selected.type)) return;
    keys.add(key);
    if (!r.table.select || selected?.type === 'true') entries.push({ key, target, row });
  }
  // Two entries whose keys differ only by the prefix the lookup strips resolve
  // to the same request at runtime, so neither one is the proved target.
  const strip = key => r.table.keyPrefix && key.startsWith(r.table.keyPrefix) ? key.slice(r.table.keyPrefix.length) : key;
  const normalizedKeys = entries.map(e => strip(e.key));
  if (new Set(normalizedKeys).size !== normalizedKeys.length) return;
  const resolver = m.ownMethod(record, r.methods.resolver.name, true);
  const list = m.ownMethod(record, r.methods.list.name, true);
  const lookup = m.ownMethod(record, r.methods.lookup.name, true);
  if (!resolver || !list || !lookup
    || !same(field(resolver.node, 'body'), r.methods.resolver.body)
    || !same(field(list.node, 'body'), r.methods.list.body)
    || !same(field(lookup.node, 'body'), r.methods.lookup.body)) return;
  const d = r.dispatcher;
  const holder = d ? m.classFor(d.class) : null;
  const call = d && holder?.file === d.file ? m.ownMethod(holder, d.method, false) : null;
  let dispatch = false;
  if (call) {
    const body = field(call.node, 'body');
    const assignments = descendants(body, n => ['assignment', 'operator_assignment'].includes(n.type) && field(n, 'left')?.text === d.local);
    const invokes = descendants(body, n => n.type === 'call' && methodName(n) === d.invokes && field(n, 'receiver')?.type === 'call'
      && methodName(field(n, 'receiver')) === 'new' && field(field(n, 'receiver'), 'receiver')?.text === d.local);
    dispatch = assignments.length === 1 && same(field(assignments[0], 'right'), d.assignment) && invokes.length === 1
      && assignments[0].endIndex < invokes[0].startIndex
      && assignments[0].parent.id === body.id
      && invokes[0].parent.id === body.id
      && preservesLocalBinding(body, assignments[0], d.local);
  }
  const selectedNote = r.table.select ? `; ${r.table.select}=true` : '';
  const dispatchTargets = new Map();
  for (const item of entries) {
    const target = m.classFor(item.target);
    if (!target) continue;
    const via = `possible ${r.class} ${r.table.const}[${item.key}] -> ${item.target}${selectedNote}`;
    edges.push({ source: resolver.symbol.id, target: target.symbol.id, relation: 'dispatches', via });
    const ordinaryAllocation = m.defaultConstructor(item.target);
    const callee = dispatch && ordinaryAllocation ? m.lookup(item.target, d.invokes) : null;
    if (callee && callee.visibility === 'public') {
      const mappings = dispatchTargets.get(callee.symbol.id) ?? [];
      mappings.push(`${item.key} -> ${item.target}`); dispatchTargets.set(callee.symbol.id, mappings);
    }
  }
  for (const [target, mappings] of dispatchTargets) {
    const via = `possible ${r.class} ${r.table.const}: ${mappings.join(' | ')}${selectedNote}`;
    // The host deduplicates endpoints, so emitting one row per registry entry
    // would silently retain the first key as if it were the selected receiver.
    // Overlong evidence declines this bridge; distinct class mappings remain.
    if (Buffer.byteLength(via) <= 1024) edges.push({ source: call.symbol.id, target, relation: 'dispatches', via });
  }
}

function chainEdges(cfg, m, edges) {
  const c = cfg.chain;
  if (!c) return;
  const record = m.classFor(c.class);
  if (record?.file !== c.file) return;
  const assignment = m.assignment(record, c.const), array = unfreeze(field(assignment, 'right'));
  if (array?.type !== 'array') return;
  const names = children(array).map(literal);
  if (names.some(n => !n || !CONST.test(n)) || new Set(names).size !== names.length) return;
  const list = m.ownMethod(record, c.methods.list.name, true), caller = m.ownMethod(record, c.methods.caller.name, true);
  // Exactly two: the assignment itself and the one read inside the list method.
  // A third reference is a use this analyzer has not read and cannot account for.
  const uses = descendants(m.tree(record.file).rootNode, n => n.type === 'constant' && n.text === c.const);
  if (uses.length !== 2) return;
  if (!list || !caller || !same(field(list.node, 'body'), c.methods.list.body)
    || !same(field(caller.node, 'body'), c.methods.caller.body)) return;
  for (const [index, name] of names.entries()) for (const method of c.probes) {
    const target = m.lookup(name, method, true);
    if (target && target.visibility === 'public') {
      edges.push({ source: caller.symbol.id, target: target.symbol.id, relation: 'dispatches', via: `possible ${c.const}[${index}] ${name}.${method}; ordered chain may stop after handled` });
    }
  }
}

function schedulerEdges(cfg, m, nodes, edges) {
  const s = cfg.scheduler;
  if (!s) return;
  const root = m.tree(s.file)?.rootNode;
  if (!root) return;
  const receiverConfig = `${s.receiver}.${s.accessor}`;
  const binding = `${s.accessor}.${s.namespace}.${s.setting}`;
  const configures = children(root).filter(n => n.type === 'call' && same(field(n, 'receiver'), s.receiver) && methodName(n) === s.configure);
  if (configures.length !== 1) return;
  const body = field(field(configures[0], 'block'), 'body'), statements = children(body);
  const assignments = descendants(root, n => n.type === 'assignment' && field(n, 'left')?.text === s.local);
  const bindings = descendants(root, n => n.type === 'assignment' && same(field(n, 'left'), binding));
  if (assignments.length !== 1 || bindings.length !== 1 || !statements.some(n => n.id === assignments[0].id) || !statements.some(n => n.id === bindings[0].id)
    || !same(field(bindings[0], 'right'), s.local) || assignments[0].endIndex > bindings[0].startIndex) return;
  // Once attached, mutation through config aliases affects the same hash even
  // without another use of the local. Only the known binding may reference the
  // setting object; other settings in the namespace may use their own accessors.
  const application = n => n.type === 'call' && same(n, s.receiver);
  const configuration = n => n.type === 'identifier' && n.text === s.accessor
    || n.type === 'call' && same(n, receiverConfig);
  for (const reference of descendants(root, application)) {
    const use = reference.parent;
    if (use?.type !== 'call' || field(use, 'receiver')?.id !== reference.id || ![s.accessor, s.configure].includes(methodName(use))) return;
  }
  for (const reference of descendants(root, configuration)) {
    const use = reference.parent;
    if (use?.type !== 'call' || field(use, 'receiver')?.id !== reference.id || methodName(use) !== s.namespace) return;
  }
  const namespaced = n => n.type === 'call' && methodName(n) === s.namespace
    && (same(field(n, 'receiver'), s.accessor) || same(field(n, 'receiver'), receiverConfig));
  for (const reference of descendants(root, namespaced)) {
    const use = reference.parent;
    if (use?.type !== 'call' || field(use, 'receiver')?.id !== reference.id) return;
    if (methodName(use) === s.setting && use.id !== field(bindings[0], 'left').id) return;
    if (methodName(use) !== s.setting && !s.settings.includes(methodName(use))) return;
  }
  const rows = hash(field(assignments[0], 'right'));
  if (!rows) return;
  const forbidden = new Set(), permitted = new Set([field(assignments[0], 'left').id, field(bindings[0], 'right').id]);
  // A conditional addition for a different literal key cannot replace a proved
  // base entry. Dynamic keys, escaping aliases, or unknown mutators can, so they
  // invalidate the table. No conditional schedule is promoted to a known one.
  for (const update of descendants(root, n => n.type === 'assignment' && field(n, 'left')?.type === 'element_reference' && field(field(n, 'left'), 'object')?.text === s.local)) {
    const lhs = field(update, 'left'), key = children(lhs).find(n => n.type === 'simple_symbol');
    if (!key) return;
    forbidden.add(key.text.slice(1)); permitted.add(field(lhs, 'object').id);
  }
  if (descendants(root, n => n.type === 'identifier' && n.text === s.local && !permitted.has(n.id)).length) return;
  for (const [key, row] of rows) {
    if (forbidden.has(key)) continue;
    const fields = hash(row), schedule = literal(fields?.get(s.entry.schedule)), name = literal(fields?.get(s.entry.class));
    if (!schedule || !name || !/^\S+(?: +\S+){4}$/.test(schedule) || !CONST.test(name)) continue;
    let klass = m.classFor(name), asynchronous = false, seen = new Set();
    while (klass && !seen.has(klass.full) && seen.size < 12) {
      seen.add(klass.full);
      const superName = constName(children(field(klass.node, 'superclass'))[0]);
      if (superName === s.jobBase) { asynchronous = true; break; }
      klass = m.parent(klass);
    }
    const target = asynchronous ? m.lookup(name, s.jobMethod) : null;
    if (!target) continue;
    const span = `L${row.startPosition.row + 1}-L${row.endPosition.row + 1}`, id = `${s.file}#${s.symbol}.${key}`;
    nodes.push({ id, path: s.file, name: `${s.label} ${key}`, kind: 'function', span });
    edges.push({ source: id, target: target.symbol.id, relation: 'enqueues', via: `${s.label} ${key}: ${schedule}; ${name}.${s.jobMethod} asynchronously when scheduler enabled` });
  }
}

export default function runtime(ctx) {
  const cfg = configuration(ctx);
  const m = rubyModel(ctx, { roots: cfg.roots }), nodes = [], edges = [];
  try { registryEdges(cfg, m, edges); chainEdges(cfg, m, edges); schedulerEdges(cfg, m, nodes, edges); }
  finally { m.close(); }
  ctx.log(`${nodes.length} schedule declarations; ${edges.length} verified runtime relationships`);
  return { nodes, edges };
}
