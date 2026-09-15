/**
 * A named import is evidence of the configured client; an identifier spelling is
 * not. The parser is TypeScript 6.0.3, vendored as a self-contained CommonJS file
 * so every executable byte belongs to the approved extension package. Reproduce
 * it with esbuild.transform(typescript/lib/typescript.js, {minify:true,
 * legalComments:'inline', target:'node24'}); its license is kept alongside it.
 */
import ts from './typescript.cjs';
import { posix as path } from 'node:path';
import { parseRouteSource } from './routes.mjs';
import { rubyModel } from './ruby-model.mjs';

const sourceExtension = /\.[cm]?[jt]sx?$/;
const cleanPath = value => typeof value === 'string' && value.length && !value.startsWith('/')
  && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const patternKey = value => value.split(/[?#]/)[0].replace(/:[a-z0-9_]+/gi, ':p').replace(/\/+$/, '') || '/';
const distinct = values => [...new Set(values)];

function configuration(ctx) {
  const config = ctx.config?.railsSeam ?? ctx.config;
  if (!config || !cleanPath(config.client?.module) || !/^[A-Za-z_$][\w$]*$/.test(config.client?.function ?? '')
    || typeof config.client?.base !== 'string' || !/^\/(?!\/)/.test(config.client.base)
    || !Array.isArray(config.roots) || !config.roots.length || !config.roots.every(cleanPath)) {
    throw Error('railsSeam requires client.module, client.function, client.base and source roots');
  }
  const roots = config.sourceRoots ?? ['app'];
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => cleanPath(String(root).replace(/\/+$/, '')))) {
    throw Error('railsSeam.sourceRoots requires repository-relative directories');
  }
  // Trailing separator: a root named "app" must not also claim "application.rb".
  return { ...config, routes: config.routes ?? 'config/routes.rb', sourceRoots: roots.map(root => String(root).replace(/\/+$/, '') + '/') };
}

function sourceProgram(ctx, config) {
  const files = new Set(ctx.listFiles());
  const parsed = new Map();
  const read = file => {
    if (!files.has(file)) return null;
    if (!parsed.has(file)) {
      const text = ctx.readFile(file);
      if (text === null) return null;
      parsed.set(file, ts.createSourceFile(`/repo/${file}`, text, ts.ScriptTarget.Latest, true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
    }
    return parsed.get(file);
  };
  const packages = new Map();
  for (const file of files) {
    if (!file.endsWith('/package.json') && file !== 'package.json') continue;
    try {
      const pkg = JSON.parse(ctx.readFile(file));
      if (!pkg.name || !pkg.exports) continue;
      const records = packages.get(pkg.name) ?? [];
      records.push({ root: path.dirname(file), exports: pkg.exports });
      packages.set(pkg.name, records);
    } catch { /* An invalid manifest cannot establish an import target. */ }
  }
  function resolveModule(specifier, importer) {
    let relative;
    if (specifier.startsWith('.')) relative = path.normalize(path.join(path.dirname(importer), specifier));
    else {
      const segments = specifier.split('/');
      const name = segments.splice(0, specifier.startsWith('@') ? 2 : 1).join('/');
      const records = packages.get(name);
      if (records?.length !== 1) return null;
      const pkg = records[0], key = segments.length ? `./${segments.join('/')}` : '.';
      const target = typeof pkg.exports === 'string' && key === '.' ? pkg.exports : pkg.exports[key];
      if (typeof target !== 'string' || !target.startsWith('./') || !cleanPath(target.slice(2))) return null;
      relative = path.join(pkg.root, target.slice(2));
    }
    if (!cleanPath(relative)) return null;
    const candidates = files.has(relative) ? [relative] : ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map(ext => relative + ext).filter(file => files.has(file));
    return candidates.length === 1 && sourceExtension.test(candidates[0]) ? candidates[0] : null;
  }
  const reaches = new Map();
  function reachesClient(file, active = new Set()) {
    if (file === config.client.module) return true;
    if (reaches.has(file)) return reaches.get(file);
    if (active.has(file)) return false;
    const source = read(file);
    if (!source || source.parseDiagnostics.length) return false;
    active = new Set(active).add(file);
    const found = source.statements.some(statement => ts.isExportDeclaration(statement) && statement.moduleSpecifier
      && typeof statement.moduleSpecifier.text === 'string'
      && reachesClient(resolveModule(statement.moduleSpecifier.text, file), active));
    reaches.set(file, found);
    return found;
  }
  const roots = [];
  for (const file of files) {
    if (!sourceExtension.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
      || !config.roots.some(root => file.startsWith(root + '/'))) continue;
    const source = read(file);
    if (!source || source.parseDiagnostics.length) { parsed.delete(file); continue; }
    const candidate = source.statements.some(statement => ts.isImportDeclaration(statement)
      && typeof statement.moduleSpecifier.text === 'string'
      && reachesClient(resolveModule(statement.moduleSpecifier.text, file)));
    if (candidate) roots.push(file);
    else parsed.delete(file);
  }
  const unwrap = name => name.replace(/^\/repo\//, '');
  const host = {
    getSourceFile: file => read(unwrap(file)) ?? undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/repo',
    getDirectories: () => [], fileExists: file => files.has(unwrap(file)), readFile: file => ctx.readFile(unwrap(file)) ?? undefined,
    getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(name => {
      const file = resolveModule(name, unwrap(containing));
      if (!file || !reachesClient(file)) return undefined;
      return { resolvedFileName: `/repo/${file}`, extension: file.endsWith('x') ? ts.Extension.Tsx : ts.Extension.Ts };
    }),
  };
  const program = ts.createProgram(roots.map(file => `/repo/${file}`), { noLib: true, allowJs: true,
    target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve }, host);
  return { program, checker: program.getTypeChecker(), roots };
}

function unalias(symbol, checker) {
  const seen = new Set();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    if (seen.has(symbol)) return null;
    seen.add(symbol); symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function constant(node, checker) {
  if (!ts.isIdentifier(node)) return null;
  const declarations = unalias(checker.getSymbolAtLocation(node), checker)?.declarations;
  if (declarations?.length !== 1) return null;
  const declaration = declarations[0];
  return ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const ? declaration.initializer : null;
}

// A template literal is one syntax tree, including nested `${...}` and quotes.
// Query suffixes are discarded only when every possible returned string is empty
// or starts with '?'. Treating every suffix variable as a query would bind
// `/items${suffix}` to /items even when suffix is '/search'.
function values(node, checker, active = new Set(), queryOnly = false) {
  if (!node || active.has(node) || active.size > 32) return null;
  active = new Set(active).add(node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return values(node.expression, checker, active, queryOnly);
  if (ts.isStringLiteralLike(node)) return [node.text.split(/[?#]/)[0] + (/[?#]/.test(node.text) ? '?' : '')];
  if (ts.isIdentifier(node)) {
    const initializer = constant(node, checker);
    if (initializer) return values(initializer, checker, active, queryOnly);
    const type = checker.getTypeAtLocation(node), parts = type.isUnion() ? type.types : [type];
    return parts.length <= 16 && parts.every(part => part.isStringLiteral()) ? parts.map(part => part.value) : null;
  }
  if (ts.isConditionalExpression(node)) {
    const a = values(node.whenTrue, checker, active, queryOnly), b = values(node.whenFalse, checker, active, queryOnly);
    return a && b && a.length + b.length <= 16 ? distinct([...a, ...b]) : null;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = values(node.left, checker, active, queryOnly), b = values(node.right, checker, active, queryOnly);
    return a && b && a.length * b.length <= 16 ? distinct(a.flatMap(left => b.map(right => left.includes('?') ? left : left + right))) : null;
  }
  if (ts.isTemplateExpression(node)) {
    let paths = [node.head.text];
    for (const span of node.templateSpans) {
      const next = [];
      for (const prefix of paths) {
        if (/[?#]/.test(prefix)) { next.push(prefix.split(/[?#]/)[0] + '?'); continue; }
        const known = values(span.expression, checker, active, queryOnly);
        if (known) {
          for (const part of known) next.push(prefix + part + (part.includes('?') ? '' : span.literal.text));
        } else if (!queryOnly && prefix.endsWith('/') && (ts.isIdentifier(span.expression) || ts.isPropertyAccessExpression(span.expression)
          || ts.isCallExpression(span.expression) && ts.isIdentifier(span.expression.expression) && span.expression.expression.text === 'encodeURIComponent')) {
          next.push(prefix + ':p' + span.literal.text);
        } else return null;
      }
      if (next.length > 16) return null;
      paths = distinct(next);
    }
    return paths;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const declarations = unalias(checker.getSymbolAtLocation(node.expression), checker)?.declarations;
    if (declarations?.length !== 1 || !ts.isFunctionDeclaration(declarations[0]) || !declarations[0].body) return null;
    const returns = statement => !!statement && (ts.isReturnStatement(statement)
      || ts.isBlock(statement) && returns(statement.statements.at(-1))
      || ts.isIfStatement(statement) && returns(statement.thenStatement) && returns(statement.elseStatement));
    if (!returns(declarations[0].body)) return null;
    const expressions = [];
    const visit = part => {
      if (ts.isReturnStatement(part)) expressions.push(part.expression);
      else if (!ts.isFunctionLike(part)) ts.forEachChild(part, visit);
    };
    ts.forEachChild(declarations[0].body, visit);
    if (!expressions.length) return null;
    const outputs = expressions.map(expression => values(expression, checker, active, true));
    if (outputs.some(output => !output || output.some(value => value !== '' && !value.startsWith('?')))) return null;
    return distinct(outputs.flat());
  }
  return null;
}

function method(node, checker) {
  if (!node) return 'GET';
  if (ts.isIdentifier(node)) node = constant(node, checker);
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  let verb = 'GET', seen = false;
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text !== 'method') continue;
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return null;
    if (property.name.getText().replace(/^["']|["']$/g, '') !== 'method') continue;
    if (seen || !ts.isStringLiteralLike(property.initializer)) return null;
    verb = property.initializer.text.toUpperCase(); seen = true;
  }
  return /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/.test(verb) ? verb : null;
}

const underscoreOwner = owner => owner.replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/\./g, '/').toLowerCase();

function actionNode(ctx, controller, action, model) {
  const file=`app/controllers/${controller}_controller.rb`;
  const owners=(ctx.index.byPath[file]??[]).filter(node=>node.kind==='class'
    && underscoreOwner(node.id.split('#')[1]??'')===`${controller}_controller`);
  if(owners.length!==1)return null;
  const name=owners[0].id.split('#')[1].replaceAll('.', '::');
  const target=model.lookup(name,action,false);
  return target?.visibility==='public'?target.symbol:null;
}

// The host's enclosing() intentionally includes variables and classes. A local
// result declaration can therefore hide its owning function. Resolve callable
// ownership here so standalone and isolated execution use exactly the same rule.
function callableAt(ctx, file, line) {
  const candidates = (ctx.index.byPath[file] ?? []).filter(node => ['function', 'method'].includes(node.kind)
    && node.startLine <= line && line <= node.endLine);
  let best = null;
  for (const node of candidates) {
    if (!best || node.endLine - node.startLine < best.endLine - best.startLine) best = node;
  }
  if (!best || candidates.some(node => node.id !== best.id &&
    (node.startLine > best.startLine || node.endLine < best.endLine
      || (node.startLine === best.startLine && node.endLine === best.endLine)))) return null;
  return best;
}

export function scanSeam(ctx) {
  const config = configuration(ctx), { program, checker, roots } = sourceProgram(ctx, config);
  const model=rubyModel(ctx, { roots: config.sourceRoots });
  const clientSource = program.getSourceFile(`/repo/${config.client.module}`);
  const clientModule = clientSource && checker.getSymbolAtLocation(clientSource);
  const client = clientModule && unalias(checker.getExportsOfModule(clientModule).find(symbol => symbol.name === config.client.function), checker);
  const sites = [];
  for (const file of roots) {
    const source = program.getSourceFile(`/repo/${file}`);
    if (!source) continue;
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const expression = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const symbol = unalias(checker.getSymbolAtLocation(expression), checker);
        if (client && symbol === client) {
          const possible = values(node.arguments[0], checker);
          const paths = possible && possible.every(value => value.startsWith('/') && !value.startsWith('//'))
            ? distinct(possible.map(value => patternKey(config.client.base.replace(/\/$/, '') + value))) : null;
          sites.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            rawPath: node.arguments[0]?.getText(source) ?? '', verb: method(node.arguments[1], checker), paths });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const routesSource = ctx.readFile(config.routes);
  const routes = routesSource === null ? [] : parseRouteSource(routesSource, { environment: config.environment });
  const table = new Map(), collided = new Set();
  const blocked = routes.filter(route => route.source === 'unsupported' || !route.controller || !route.action || /[*()]/.test(route.pattern))
    .map(route => ({ ...route, pattern: route.pattern.split(/[*()]/)[0] || '/' }));
  const overlaps = (blocker, candidate) => {
    const a = patternKey(blocker).split('/').filter(Boolean), b = candidate.split('/').filter(Boolean);
    return a.length <= b.length && a.every((part, i) => part.startsWith(':') || b[i].startsWith(':') || part === b[i]);
  };
  for (const route of routes) {
    if (!route.controller || !route.action || /[*()]/.test(route.pattern)) continue;
    const key = `${route.verb} ${patternKey(route.pattern)}`, prior = table.get(key);
    if (!prior) table.set(key, route);
    else if (prior.controller !== route.controller || prior.action !== route.action) collided.add(key);
  }
  const edges = [], misses = [], stats = { sites: sites.length, joined: 0, edges: 0, routes: routes.length, collisions: collided.size };
  for (const site of sites) {
    let reason;
    if (!site.paths || !site.verb) reason = !site.paths ? 'unsupported-path' : 'unsupported-method';
    const matches = !reason ? site.paths.map(pattern => {
      const key = `${site.verb} ${pattern}`;
      return collided.has(key) || blocked.some(route => (route.verb === '*' || route.verb === site.verb) && overlaps(route.pattern, pattern)) ? null : table.get(key);
    }) : [];
    if (!reason && (matches.some(match => !match) || !matches.length)) reason = 'missing-or-ambiguous-route';
    if (reason) { misses.push({ ...site, reason }); continue; }
    stats.joined++;
    const from = callableAt(ctx, site.file, site.line);
    const targets = matches.map(route => actionNode(ctx, route.controller, route.action, model));
    if (!from || !['function', 'method'].includes(from.kind)) reason = 'no-source-symbol';
    else if (targets.some(target => !target)) reason = 'no-target-symbol';
    if (reason) { misses.push({ ...site, reason }); continue; }
    site.matches = matches.map((route, index) => ({ pattern: site.paths[index], controller: route.controller, action: route.action, target: targets[index].id }));
    for (const target of distinct(targets.map(node => node.id))) {
      const paths = site.matches.filter(match => match.target === target).map(match => match.pattern);
      edges.push({ source: from.id, target, relation: 'serves', via: `${site.verb} ${paths.join(' | ')}` });
    }
  }
  const nodes=[];
  if(config.routeEntrypoints===true) {
    for(const [key,route] of table) {
      if(collided.has(key)||blocked.some(blocker=>(blocker.verb==='*'||blocker.verb===route.verb)&&overlaps(blocker.pattern,patternKey(route.pattern))))continue;
      const target=actionNode(ctx,route.controller,route.action,model);
      if(!target||!Number.isInteger(route.line)||!Number.isInteger(route.endLine))continue;
      const id=`${config.routes}#HTTP.${encodeURIComponent(key)}`;
      nodes.push({id,path:config.routes,name:key,kind:'function',span:`L${route.line}-L${route.endLine}`});
      edges.push({source:id,target:target.id,relation:'serves',via:key});
    }
  }
  stats.edges = edges.length;
  model.close();
  return { nodes, edges, sites, routes, stats, misses };
}

export default function railsSeam(ctx) {
  const result = scanSeam(ctx);
  ctx.log(`${result.stats.sites} verified client call sites · ${result.stats.joined} joined to a route · ${result.stats.edges} resolved to node pairs`);
  for (const reason of distinct(result.misses.map(miss => miss.reason))) ctx.log(`${result.misses.filter(miss => miss.reason === reason).length} declined: ${reason}`);
  return { nodes: result.nodes, edges: result.edges };
}
