/**
 * Static Rails route-table extractor: config/routes.rb -> [{verb, pattern, controller, action}]
 * No Rails boot, no runtime. The DSL is constrained enough to parse directly.
 */
import { readFileSync } from 'node:fs';
import { parseRuby, field, children, walk, walkAll } from './ruby.mjs';

const VERBS = ['get', 'post', 'patch', 'put', 'delete', 'head', 'options'];
const PLURAL_DEFAULT = ['index', 'create', 'new', 'edit', 'show', 'update', 'destroy'];
const SINGULAR_DEFAULT = ['show', 'create', 'new', 'edit', 'update', 'destroy'];

// A line scanner cannot distinguish executable DSL from route-looking heredoc
// content. Parse Ruby first and flatten only executable statements, retaining
// their declaration spans. The existing conservative DSL interpreter still
// decides which scopes and options it understands.
function logicalLines(source) {
  const tree=parseRuby(source);
  if(!tree)return [];
  const out=[];
  const emit=(text,node,endLine=node.endPosition.row+1)=>out.push({text,line:node.startPosition.row+1,endLine});
  const cleaned=(node,endIndex=node.endIndex)=>{
    const chars=node.text.split('');
    walkAll(node,n=>{if(n.type==='comment')for(let i=n.startIndex-node.startIndex;i<n.endIndex-node.startIndex;i++)chars[i]=' ';});
    return chars.slice(0,endIndex-node.startIndex).join('').replace(/\s+/g,' ').trim();
  };
  const visit=node=>{
    if(node.type==='comment')return;
    if(['program','body_statement','then','else','block_body'].includes(node.type)) {for(const child of children(node))visit(child);return;}
    if(node.type==='if'||node.type==='unless') {
      emit(node.type+' '+cleaned(field(node,'condition')),node);
      visit(field(node,'consequence'));
      if(field(node,'alternative')){emit('else',node);visit(field(node,'alternative'));}
      emit('end',node);return;
    }
    if(node.type==='call') {
      const block=field(node,'block');
      let interpolated=false;
      for(const arg of children(field(node,'arguments')))walk(arg,n=>{if(['interpolation','heredoc_body'].includes(n.type))interpolated=true;});
      if(interpolated){emit('constraints do',node);emit('end',node);return;}
      if(block) {
        const head=cleaned(node,block.startIndex);
        emit(head+' do',node,block.startPosition.row+1);
        const body=field(block,'body');if(body)visit(body);
        emit('end',node);
      }else emit(cleaned(node),node);
      return;
    }
    // Control-flow and declarations outside the supported DSL cannot certify
    // routes. Their bodies stay suppressed and block overlapping joins.
    if(!['assignment','string','heredoc_body','heredoc_beginning'].includes(node.type)) {emit('constraints do',node);emit('end',node);}
  };
  try{visit(tree.rootNode);}finally{tree.delete();}
  return out;
}

function symList(raw) {
  if (!raw) return null;
  const pct = raw.match(/%i\[([^\]]*)\]/);
  if (pct) return pct[1].trim().split(/\s+/).filter(Boolean);
  const arr = raw.match(/\[([^\]]*)\]/);
  if (arr) return arr[1].split(',').map((s) => s.trim().replace(/^:/, '')).filter(Boolean);
  const one = raw.match(/:([a-z_]+)/);
  return one ? [one[1]] : null;
}
function opt(line, key) {
  const m = line.match(new RegExp(`\\b${key}:\\s*(%i\\[[^\\]]*\\]|\\[[^\\]]*\\]|:[a-z0-9_]+|"[^"]*"|'[^']*')`));
  return m ? m[1] : null;
}
function strOpt(line, key) {
  const v = opt(line, key);
  return v ? v.replace(/^["':]|["']$/g, '') : null;
}
const singular = (n) => (n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.replace(/s$/, ''));

/**
 * Parse a route table from SOURCE rather than from a path.
 *
 * Both measurement and contained execution use this parser. File reads stay in
 * their respective hosts; the scanner never boots Rails or evaluates Ruby.
 */
export function parseRouteSource(source, options = {}) {
  return parseRouteLines(logicalLines(source), options);
}

export function parseRoutes(file, options = {}) {
  return parseRouteSource(readFileSync(file, 'utf8'), options);
}

function parseRouteLines(lines, options) {
  const out = [];
  let declaration;
  const emit = route => out.push({ ...route, line: declaration.line, endLine: declaration.endLine });
  const stack = [{ kind: 'root', path: '', mod: '' }];
  const top = () => stack[stack.length - 1];
  const basePath = () => stack.map((f) => f.path).join('');
  const baseMod = () => stack.map((f) => f.mod).join('');
  /** The enclosing `resources` frame, if we are directly inside one. */
  const enclosingResource = () => [...stack].reverse().find((f) => f.kind === 'resources');
  const uncertain = line => {
    const route = line.match(/^(get|post|patch|put|delete|head|options|resources|resource)\s+(?:["']([^"']+)["']|:([a-z0-9_]+))/);
    const segment = route ? route[2] ?? route[3] : '';
    emit({ verb: route && VERBS.includes(route[1]) ? route[1].toUpperCase() : '*',
      pattern: `${basePath()}${segment ? '/' + segment.replace(/^\//, '') : ''}` || '/', controller: null, action: null, source: 'unsupported', prefix: true });
  };

  for (const record of lines) {
    declaration=record;
    const line=record.text;
    if (line === 'end') { if (stack.length > 1) stack.pop(); continue; }
    const opensBlock = /\bdo\b\s*$/.test(line);
    let m;

    // An `if` consumes an `end` just like a namespace. Ignoring the opener
    // popped the control namespace early and moved the later developer routes
    // outside /api/v1. Unknown conditions keep their frame but emit no routes.
    if (/^(if|unless)\b/.test(line)) {
      const expression = line.replace(/^(if|unless)\s+/, '');
      const checks = expression.split(/\s*\|\|\s*/);
      const known = options.environment && checks.every(check => /^Rails\.env\.[a-z_]+\?$/.test(check));
      const matched = known && checks.some(check => check === `Rails.env.${options.environment}?`);
      stack.push({ kind: 'conditional', path: '', mod: '', disabled: !known || (line.startsWith('unless ') ? matched : !matched), uncertain: !known });
      continue;
    }
    if (/^(else|elsif)\b/.test(line)) { top().disabled = true; top().uncertain = true; continue; }
    if (stack.some(frame => frame.disabled)) {
      if (stack.some(frame => frame.uncertain) && /^(get|post|patch|put|delete|head|options|resources|resource)\b/.test(line)) uncertain(line);
      if (opensBlock) stack.push({ kind: 'ignored', path: '', mod: '', disabled: true });
      continue;
    }
    if (/^Rails\.application\.routes\.draw\s+do$/.test(line)) {
      stack.push({ kind: 'draw', path: '', mod: '' });
      continue;
    }
    if (/^mount\b/.test(line)) {
      const segment = line.match(/(?:=>|\bat:)\s*["']([^"']+)["']/)?.[1];
      emit({ verb: '*', pattern: `${basePath()}${segment ? '/' + segment.replace(/^\//, '') : ''}` || '/',
        controller: null, action: null, source: 'unsupported', prefix: true });
      continue;
    }

    // Segment regexp constraints are understood by the routing oracle; object
    // predicates and other Ruby control flow cannot be decided statically.
    const unsafeConstraint = /\bconstraints:/.test(line) && !/\bconstraints:\s*\{\s*\w+:\s*\/[^\n]+\/\s*\}/.test(line);
    const dynamicOption = ['path', 'module', 'controller', 'action', 'param', 'only', 'except', 'on']
      .some(key => new RegExp(`\\b${key}:`).test(line) && opt(line, key) === null);
    if (unsafeConstraint || dynamicOption || /\s(?:if|unless)\s/.test(line) || /^(constraints|defaults|concern|with_options)\b/.test(line)) {
      uncertain(line);
      if (opensBlock) stack.push({ kind: 'unsupported', path: '', mod: '', disabled: true, uncertain: true });
      continue;
    }

    if ((m = line.match(/^namespace\s+:([a-z0-9_]+)/))) {
      stack.push({
        kind: 'namespace',
        path: `/${strOpt(line, 'path') ?? m[1]}`,
        mod: `${strOpt(line, 'module') ?? m[1]}/`,
      });
      if (!opensBlock) stack.pop();
      continue;
    }

    if (/^scope\b/.test(line)) {
      const lit = line.match(/^scope\s+["']([^"']+)["']/)?.[1] ?? null;
      const p = strOpt(line, 'path') ?? lit;
      const mod = strOpt(line, 'module');
      stack.push({ kind: 'scope', path: p ? `/${p.replace(/^\//, '')}` : '', mod: mod ? `${mod}/` : '' });
      if (!opensBlock) stack.pop();
      continue;
    }

    // member/collection blocks hang off the enclosing resources frame
    if (line === 'member do' || line === 'collection do') {
      const res = enclosingResource();
      stack.push({
        kind: line.slice(0, line.indexOf(' ')),
        path: line.startsWith('member') && res?.plural ? `/:${res.param}` : '',
        mod: '',
      });
      continue;
    }

    if ((m = line.match(/^(resources|resource)\s+:([a-z0-9_]+)/))) {
      const plural = m[1] === 'resources';
      const name = m[2];
      const seg = `/${strOpt(line, 'path') ?? name}`;
      const controllerName = strOpt(line, 'controller') ?? (plural || name.endsWith('s') ? name : `${name}s`);
      const controller = controllerName.startsWith('/') ? controllerName.slice(1) : `${baseMod()}${controllerName}`;
      const only = symList(opt(line, 'only'));
      const except = symList(opt(line, 'except'));
      let actions = plural ? [...PLURAL_DEFAULT] : [...SINGULAR_DEFAULT];
      if (only) actions = actions.filter((a) => only.includes(a));
      if (except) actions = actions.filter((a) => !except.includes(a));
      const parent = top().kind === 'resources' ? (top().plural ? top().childId : '') : '';
      const base = basePath() + parent + seg;
      const param = strOpt(line, 'param') ?? 'id';
      const shape = {
        index:   { verb: 'GET',    path: base },
        create:  { verb: 'POST',   path: base },
        new:     { verb: 'GET',    path: `${base}/new` },
        edit:    { verb: 'GET',    path: plural ? `${base}/:${param}/edit` : `${base}/edit` },
        show:    { verb: 'GET',    path: plural ? `${base}/:${param}` : base },
        update:  { verb: 'PATCH',  path: plural ? `${base}/:${param}` : base },
        destroy: { verb: 'DELETE', path: plural ? `${base}/:${param}` : base },
      };
      for (const a of actions) {
        if (!shape[a]) continue;
        emit({ verb: shape[a].verb, pattern: shape[a].path, controller, action: a, source: 'resources' });
        if (a === 'update') emit({ verb: 'PUT', pattern: shape[a].path, controller, action: a, source: 'resources' });
      }
      if (opensBlock) {
        // The frame contributes only `/things`; children decide whether they need
        // `/:thing_id` (nested resource), `/:id` (member) or nothing (collection).
        stack.push({ kind: 'resources', path: parent + seg, mod: '', controller, plural, param, childId: `/:${singular(name)}_${param}` });
      }
      continue;
    }

    if ((m = line.match(new RegExp(`^(${VERBS.join('|')})\\s+(.*)$`)))) {
      const verb = m[1].toUpperCase();
      const rest = m[2];
      const on = strOpt(line, 'on');
      const actionOverride = strOpt(line, 'action');
      const target = rest.match(/(?:\bto:\s*|=>\s*)["']([^"']+)["']/);
      const pathLit = rest.match(/^\s*["']([^"']+)["']/)?.[1] ?? null;
      const symAction = rest.match(/^\s*:([a-z0-9_]+)/)?.[1] ?? null;
      const res = enclosingResource();
      // Directly inside `resources :x do`, a bare verb route with `on:` uses the
      // member/collection shape; without `on:` it is nested under `/:x_id`.
      let prefix = '';
      if (res && top().kind === 'resources') {
        if (on === 'member') prefix = res.plural ? `/:${res.param}` : '';
        else if (on === 'collection') prefix = '';
        else prefix = res.plural ? res.childId : '';
      }

      if (target) {
        const [c, a] = target[1].split('#');
        const seg2 = pathLit ?? symAction;
        const p = seg2 ? `${basePath()}${prefix}/${seg2.replace(/^\//, '')}` : `${basePath()}${prefix}`;
        emit({ verb, pattern: p, controller: c.startsWith('/') ? c.slice(1) : `${baseMod()}${c}`, action: a, source: 'explicit' });
        continue;
      }
      const tail = pathLit ?? symAction;
      if (tail && res) {
        emit({
          verb,
          pattern: `${basePath()}${prefix}/${tail.replace(/^\//, '')}`,
          controller: res.controller,
          action: actionOverride ?? symAction ?? tail,
          source: 'member',
        });
        continue;
      }
      if (pathLit) {
        emit({ verb, pattern: `${basePath()}/${pathLit.replace(/^\//, '')}`, controller: null, action: null, source: 'unresolved' });
      }
      continue;
    }

    if (opensBlock || /^(case|begin|for|while|until|def|class|module)\b/.test(line)) {
      uncertain(line);
      stack.push({ kind: 'unsupported', path: '', mod: '', disabled: true, uncertain: true });
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('routes.mjs') && process.argv[2]) {
  console.log(JSON.stringify(parseRoutes(process.argv[2]), null, 2));
}
