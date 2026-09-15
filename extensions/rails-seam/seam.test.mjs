import { test } from 'node:test';
import assert from 'node:assert/strict';
import railsSeam from './extension.mjs';
import { parseRouteSource } from './routes.mjs';

function context(source, routes, extra = {}, options = {}) {
  const files = { 'client.ts': 'export async function request<T>(path: string, options = {}): Promise<T> { throw Error() }',
    'web/service.ts': source, 'config/routes.rb': routes, ...extra };
  const node = (file, name, owner = 'Api.V2.ItemsController') => ({ id: `${file}#${owner}.${name}`, name, kind: 'method', startLine: 1, endLine: 100 });
  const byPath = { 'web/service.ts': [{ id: 'web/service.ts#run', name: 'run', kind: 'function', startLine: 1, endLine: 200 }],
    'app/controllers/api/v2/items_controller.rb': ['index', 'show', 'create', 'destroy', 'search'].map((name,i) => ({...node('app/controllers/api/v2/items_controller.rb', name),startLine:i+2,endLine:i+2})),
    ...options.index };
  for (const file of Object.keys(byPath)) {
    files[file] ??= 'class Api::V2::ItemsController\n def index; end\n def show; end\n def create; end\n def destroy; end\n def search; end\nend';
    if(file.startsWith('app/controllers/')&&!byPath[file].some(n=>n.kind==='class')) {
      const owner=files[file].match(/class ([\w:]+)/)?.[1];
      if(owner)byPath[file].push({id:file+'#'+owner.replaceAll('::','.'),name:owner.split('::').at(-1),kind:'class',startLine:1,endLine:files[file].split('\n').length});
    }
  }
  const logs = [];
  return { repoRoot: '/repo', index: { byPath, has: id => Object.values(byPath).flat().some(n => n.id === id),
      enclosing: (file, line) => byPath[file]?.filter(n => n.startLine <= line && n.endLine >= line).sort((a, b) => a.endLine-a.startLine-b.endLine+b.startLine)[0] },
    readFile: path => files[path] ?? null,
    listFiles: (root = '.') => Object.keys(files).filter(file => root === '.' || file.startsWith(root + '/')).sort(),
    config: { railsSeam: { client: { module: 'client.ts', function: 'request', base: '/api/v2' }, roots: ['web'], environment: 'development', ...options.config } },
    log: message => logs.push(message), logs };
}
const routes = 'Rails.application.routes.draw do\n namespace :api do\n namespace :v2 do\n resources :items, only: %i[index show create destroy]\n end\n end\nend';

test('seam: configured import aliases and nested template query expressions resolve', async () => {
  const ctx = context("import { request as send } from '../client';\nfunction query() { return true ? `?q=${'nested'}` : '' }\nexport async function run(id: string) { return send<{value: string}>(`/items/${id}${query()}`) }", routes);
  const result = await railsSeam(ctx);
  assert.equal(result.edges?.length, 1);
  assert.equal(result.edges[0].target, 'app/controllers/api/v2/items_controller.rb#Api.V2.ItemsController.show');
  assert.equal(result.edges[0].relation, 'serves');
});

test('seam: unrelated, shadowed and commented same-name calls do not become sites', async () => {
  const ctx = context("import { request } from '../client';\n// request('/items')\nconst text = `request('/items')`;\nfunction fake(request: any) { return request('/items') }\nexport function run() { return request('/items') }", routes);
  const result = await railsSeam(ctx);
  assert.equal(result.edges?.length, 1);
});

test('seam: namespace stack survives an environment conditional', () => {
  const source = 'Rails.application.routes.draw do\n namespace :api do\n namespace :v2 do\n namespace :control do\n if Rails.env.development? || Rails.env.test?\n namespace :dev_tools do\n resources :tools, only: :index\n end\n end\n end\n namespace :developer do\n resources :items, only: :index\n end\n end\n end\nend';
  const found = parseRouteSource(source, { environment: 'development' });
  assert.ok(found.some(route => route.pattern === '/api/v2/developer/items' && route.controller === 'api/v2/developer/items'));
});

test('seam: unknown conditions and unsupported constraints decline', async () => {
  for (const route of ["if feature_enabled?\n get 'items', to: 'items#index'\n end", "get 'items', to: 'items#index', constraints: SomeConstraint.new"]) {
    const ctx = context("import { request } from '../client'; export function run() { return request('/items') }",
      `Rails.application.routes.draw do\n namespace :api do\n namespace :v2 do\n ${route}\n end\n end\nend`);
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
  }
});

test('seam: route collisions, dynamic suffixes and uncertain HTTP methods decline', async () => {
  for (const call of ["request(`/items${suffix}`)", "request('/items', options)", "request('/items', { method: verb })", "request('/items', { ...options })"]) {
    const ctx = context(`import { request } from '../client'; export function run(suffix: string, options: any, verb: string) { return ${call} }`, routes);
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0, call);
  }
  const ctx = context("import { request } from '../client'; export function run() { return request('/items') }",
    routes.replace('resources :items, only: %i[index show create destroy]', "get 'items', to: 'items#index'\n get 'items', to: 'other#index'"));
  assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
});

test('seam: literal query, const paths and equivalent conditional paths are recognized', async () => {
  const ctx = context("import { request } from '../client'; export function run(flag: boolean) { const path = flag ? `/items?q=${flag}` : '/items'; return request(path, { method: 'POST' }) }", routes);
  assert.equal((await railsSeam(ctx)).edges?.[0]?.target, 'app/controllers/api/v2/items_controller.rb#Api.V2.ItemsController.create');
});

test('seam: workspace export maps and explicit reexports identify the actual client', async () => {
  const ctx = context("import { request } from './barrel'; export function run() { return request('/items') }", routes,
    { 'web/barrel.ts': "export { request } from '@sample/runtime/client'", 'package.json': '{"workspaces":["packages/*"]}',
      'packages/runtime/package.json': '{"name":"@sample/runtime","exports":{"./client":"../../client.ts"}}' });
  // A package export escaping its package root is invalid even if a file exists.
  assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
  const valid = context("import { request } from './barrel'; export function run() { return request('/items') }", routes,
    { 'web/barrel.ts': "export { request } from '@sample/runtime/client'", 'packages/runtime/package.json': '{"name":"@sample/runtime","exports":{"./client":"./client.ts"}}',
      'packages/runtime/client.ts': 'export function request(path: string) {}' },
    { config: { client: { module: 'packages/runtime/client.ts', function: 'request', base: '/api/v2' } } });
  assert.equal((await railsSeam(valid)).edges?.length, 1);
});

test('seam: target identity requires the expected controller owner', async () => {
  const file = 'app/controllers/api/v2/items_controller.rb';
  const ctx = context("import { request } from '../client'; export function run() { return request('/items') }", routes, {},
    { index: { [file]: [{ id: `${file}#OtherController.index`, name: 'index', kind: 'method', startLine: 1, endLine: 2 }] } });
  assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
});

test('seam: resources include new/edit and honor custom member parameters', () => {
  const found = parseRouteSource('Rails.application.routes.draw do\n resources :items, param: :slug do\n member do\n get :search\n end\n end\nend');
  assert.ok(found.some(route => route.pattern === '/items/new' && route.action === 'new'));
  assert.ok(found.some(route => route.pattern === '/items/:slug/edit' && route.action === 'edit'));
  assert.ok(found.some(route => route.pattern === '/items/:slug/search'));
});

test('seam: non-method shorthand options preserve the default verb', async () => {
  const ctx = context("import { request } from '../client'; export function run(signal: any) { return request('/items', {signal}) }", routes);
  assert.equal((await railsSeam(ctx)).edges?.length, 1);
});

test('seam: finite literal path alternatives produce only their proved handlers', async () => {
  const ctx = context("import { request } from '../client'; export function run(action: 'list' | 'detail') { return request(`/items/${action}`) }",
    routes.replace('resources :items, only: %i[index show create destroy]', "get 'items/list', to: 'items#index'\n get 'items/detail', to: 'items#show'"));
  assert.deepEqual((await railsSeam(ctx)).edges?.map(edge => edge.target).sort(), [
    'app/controllers/api/v2/items_controller.rb#Api.V2.ItemsController.index',
    'app/controllers/api/v2/items_controller.rb#Api.V2.ItemsController.show',
  ]);
});

test('seam: explicit controller inheritance resolves the defining graph method', async () => {
  const own = 'app/controllers/api/v2/items_controller.rb', parent = 'app/controllers/api/v2/base_items_controller.rb';
  const ctx = context("import { request } from '../client'; export function run() { return request('/items') }", routes,
    { [own]: 'class Api::V2::ItemsController < ::Api::V2::BaseItemsController\nend', [parent]: 'class Api::V2::BaseItemsController\n def index; end\nend' },
    { index: { [own]: [{id: own+'#Api.V2.ItemsController', name: 'ItemsController', kind: 'class', startLine: 1, endLine: 2}],
      [parent]: [{id: parent+'#Api.V2.BaseItemsController.index', name: 'index', kind: 'method', startLine: 2, endLine: 2}] } });
  assert.equal((await railsSeam(ctx)).edges?.[0]?.target, parent+'#Api.V2.BaseItemsController.index');
});

test('seam: an unsupported competing route blocks a seemingly unique static match', async () => {
  for (const competing of ["if feature_enabled?\n get 'items', to: 'other#index'\n end", "get 'items', to: 'other#index', constraints: SomeConstraint.new"]) {
    const ctx = context("import { request } from '../client'; export function run() { return request('/items') }",
      routes.replace('resources :items, only: %i[index show create destroy]', competing + "\n get 'items', to: 'items#index'"));
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
  }
});

test('seam: a query helper that can fall through is not a proved query suffix', async () => {
  const ctx = context("import { request } from '../client'; function query(flag: boolean) { if (flag) return '?q=1' } export function run() { return request(`/items${query(true)}`) }", routes);
  assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
});

test('seam: a same-named interface member in the client module is not its exported function', async () => {
  const ctx = context("import type { Similar } from '../client'; export function run(other: Similar) { return other.request('/items') }", routes,
    { 'client.ts': 'export function request(path: string) {}\nexport interface Similar { request(path: string): unknown }' });
  assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
});

test('seam: glob routes and mounted engines prevent unsupported competing joins', async () => {
  for (const competing of ["get '*path', to: 'other#index'", "mount Other::Engine => 'items'"]) {
    const ctx = context("import { request } from '../client'; export function run() { return request('/items') }",
      routes.replace('resources :items, only: %i[index show create destroy]', competing + "\n get 'items', to: 'items#index'"));
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
  }
});

test('seam: dynamic route options and conditional modifiers do not become default routes', async () => {
  for (const declaration of ["resources :items, only: allowed_actions", "get 'items', to: 'items#index' if feature_enabled?"]) {
    const ctx = context("import { request } from '../client'; export function run() { return request('/items') }",
      routes.replace('resources :items, only: %i[index show create destroy]', declaration));
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0, 0);
  }
});

test('seam: a nested variable cannot hide the function owning a request', async () => {
  const file = 'web/service.ts';
  const ctx = context("import { request } from '../client';\nexport function run() {\n const result = request('/items');\n return result;\n}", routes, {},
    { index: { [file]: [
      {id:file+'#run',name:'run',kind:'function',startLine:2,endLine:5},
      {id:file+'#run.result',name:'result',kind:'variable',startLine:3,endLine:3},
    ] } });
  assert.equal(ctx.index.enclosing(file,3).kind,'variable');
  assert.equal((await railsSeam(ctx)).edges?.[0]?.source,file+'#run');
});

test('seam: the unique innermost callable owns a request inside nested functions', async () => {
  const file = 'web/service.ts';
  const ctx = context("import { request } from '../client';\nexport function run() {\n function nested() {\n  const result = request('/items');\n  return result;\n }\n return nested();\n}", routes, {},
    { index: { [file]: [
      {id:file+'#run',name:'run',kind:'function',startLine:2,endLine:8},
      {id:file+'#run.nested',name:'nested',kind:'function',startLine:3,endLine:6},
      {id:file+'#run.nested.result',name:'result',kind:'variable',startLine:4,endLine:4},
    ] } });
  assert.equal((await railsSeam(ctx)).edges?.[0]?.source,file+'#run.nested');
});

test('seam: ambiguous callable spans and variable-only sites have no source edge', async () => {
  const file = 'web/service.ts';
  for (const symbols of [
    [{id:file+'#a',name:'a',kind:'function',startLine:1,endLine:5}, {id:file+'#b',name:'b',kind:'function',startLine:1,endLine:5}],
    [{id:file+'#a',name:'a',kind:'function',startLine:1,endLine:4}, {id:file+'#b',name:'b',kind:'function',startLine:2,endLine:5}],
    [{id:file+'#result',name:'result',kind:'variable',startLine:3,endLine:3}],
  ]) {
    const ctx = context("import { request } from '../client';\nexport function run() {\n return request('/items');\n}", routes, {}, {index:{[file]:symbols}});
    assert.equal((await railsSeam(ctx)).edges?.length ?? 0,0);
  }
});

test('route entrypoints: verified server routes exist without a frontend request and use declaration spans', async () => {
 const ctx=context('export function run() {}',routes,{}, {config:{routeEntrypoints:true}});
 const result=await railsSeam(ctx);
 assert.equal(result.nodes.length,4);
 assert.equal(result.edges.length,4);
 assert.ok(result.nodes.every(n=>n.path==='config/routes.rb'&&n.span==='L4-L4'));
 assert.ok(result.edges.every(e=>e.relation==='serves'&&e.source.startsWith('config/routes.rb#HTTP.')));
});

test('route entrypoints: collision and conditional route declarations decline without clients', async () => {
 for(const competing of ["get 'items', to: 'other#index'", "if enabled?\n get 'items', to: 'other#index'\nend"]) {
  const ctx=context('export function run() {}',routes.replace('resources :items, only: %i[index show create destroy]',competing+"\nget 'items', to: 'items#index'"),{}, {config:{routeEntrypoints:true}});
  assert.equal((await railsSeam(ctx)).edges.length,0);
 }
});

test('route parser: Ruby comments, heredocs, percent strings and interpolated routes cannot fabricate routes', () => {
 for(const source of [
  '=begin\nRails.application.routes.draw do\n get "items", to: "items#index"\nend\n=end',
  'text = <<~ROUTES\nRails.application.routes.draw do\n get "items", to: "items#index"\nend\nROUTES',
  'text = %q{\nRails.application.routes.draw do\n get "items", to: "items#index"\nend\n}',
  'Rails.application.routes.draw do\n get "#{path}", to: "items#index"\nend',
 ])assert.equal(parseRouteSource(source).filter(r=>r.controller).length,0);
});

test('route entrypoints: multiline declaration spans and explicit HEAD/OPTIONS verbs survive parsing', async () => {
 const source='Rails.application.routes.draw do\n namespace :api do\n namespace :v2 do\n head "items",\n to: "items#index"\n options "items", to: "items#index"\n end\n end\nend';
 const ctx=context('export function run() {}',source,{}, {config:{routeEntrypoints:true}});
 const result=await railsSeam(ctx);
 assert.equal(result.edges.length,2);
 assert.deepEqual(result.nodes.map(n=>n.span),['L4-L5','L6-L6']);
 assert.deepEqual(result.edges.map(e=>e.via),['HEAD /api/v2/items','OPTIONS /api/v2/items']);
});


test('route targets: singleton and conditional definitions cannot impersonate controller actions', async () => {
 const file='app/controllers/api/v2/items_controller.rb';
 for(const source of ['class Api::V2::ItemsController\n def self.index; end\nend', 'class Api::V2::ItemsController\n if enabled?\n def index; end\n end\nend']) {
  const ctx=context("import { request } from '../client'; export function run() { return request('/items') }",routes,{[file]:source},{config:{routeEntrypoints:true}});
  assert.ok(!(await railsSeam(ctx)).edges.some(e=>e.target.endsWith('.index')));
 }
});

test('route targets: private methods are not HTTP actions', async () => {
 const file='app/controllers/api/v2/items_controller.rb';
 for(const declaration of ['private\n def index; end','def index; end\n private :index']) {
  const source='class Api::V2::ItemsController\n '+declaration+'\nend';
  const startLine=source.split('\n').findIndex(l=>l.includes('def index'))+1;
  const ctx=context('export function run() {}',routes,{[file]:source},{config:{routeEntrypoints:true},index:{[file]:[{id:file+'#Api.V2.ItemsController.index',name:'index',kind:'method',startLine,endLine:startLine}]}});
  assert.equal((await railsSeam(ctx)).edges.length,0);
 }
});

test('route targets: include cannot hide a directly defined action but prepend remains uncertain',async()=>{
 const file='app/controllers/api/v2/items_controller.rb';
 for(const [macro,expected] of [['include',1],['prepend',0]]){
  const source=`class Api::V2::ItemsController\n ${macro} Shared\n def index; end\nend`;
  const ctx=context('export function run() {}',routes,{[file]:source},{config:{routeEntrypoints:true},index:{[file]:[{id:file+'#Api.V2.ItemsController.index',name:'index',kind:'method',startLine:3,endLine:3}]}});
  assert.equal((await railsSeam(ctx)).edges.length,expected);
 }
});

test('review: inherited private controller actions never become server or frontend route edges', async () => {
 const child='app/controllers/api/v2/items_controller.rb', parent='app/controllers/base_controller.rb';
 for(const declaration of ['private :index','protected :index','private(*actions)','if enabled?\n private :index\nend']) {
  const ctx=context("import {request} from '../client'; export function run() { return request('/items') }",routes,{
   [child]:`class Api::V2::ItemsController < BaseController\n ${declaration}\nend`,
   [parent]:'class BaseController\n def index; end\nend',
  },{config:{routeEntrypoints:true},index:{
   [child]:[{id:child+'#Api.V2.ItemsController',name:'ItemsController',kind:'class',startLine:1,endLine:5}],
   [parent]:[{id:parent+'#BaseController',name:'BaseController',kind:'class',startLine:1,endLine:3},{id:parent+'#BaseController.index',name:'index',kind:'method',startLine:2,endLine:2}],
  }});
  assert.equal((await railsSeam(ctx)).edges.length,0,declaration);
 }
});

test('review: inline comments cannot supply route targets, options, or namespace paths', () => {
 const source=`Rails.application.routes.draw do
 namespace :api, # path: 'wrong'
 path: 'right' do
 get 'items', # to: 'items#show'
 to: 'items#index'
 end
end`;
 const parsed=parseRouteSource(source).filter(r=>r.controller);
 assert.equal(parsed.length,1);
 assert.equal(parsed[0].action,'index');
 assert.equal(parsed[0].pattern,'/right/items');
});
