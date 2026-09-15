import treeSitter from './web-tree-sitter.cjs';
import { runtimeWasm, rubyWasm } from './ruby-wasm.mjs';

// Native addons are outside the extension contract. These pinned WASM bytes
// come from web-tree-sitter 0.26.13 and tree-sitter-ruby 0.23.1; loading from
// memory keeps the complete parser inside the approved package snapshot.
const { Parser, Language } = treeSitter;
await Parser.init({ wasmBinary: runtimeWasm });
const language = await Language.load(rubyWasm);
export function parseRuby(source) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (tree.rootNode.hasError) { tree.delete(); return null; }
  return tree;
}
export const field = (node, name) => node?.childForFieldName(name);
export const children = node => node?.namedChildren.filter(n => n.type !== 'comment') ?? [];
export function walk(node, fn) { fn(node); for (const child of children(node)) walk(child, fn); }
export function walkAll(node, fn) { fn(node); for (const child of node.namedChildren) walkAll(child, fn); }
export function tokens(node) {
  if (!node || node.type === 'comment') return '';
  if (!node.childCount) return node.text;
  return node.children.map(tokens).filter(Boolean).join(' ');
}
export function normalized(source) {
  const tree = parseRuby(source);
  if (!tree) return null;
  const result = tokens(tree.rootNode); tree.delete(); return result;
}
export function literal(node) {
  if (node?.type !== 'string' || children(node).some(n => n.type !== 'string_content')) return null;
  const text = node.text;
  if (!/^(["']).*\1$/s.test(text) || text.includes('\\')) return null;
  return text.slice(1, -1);
}
export const constName = node => node && ['constant', 'scope_resolution'].includes(node.type) && /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(node.text) ? node.text.replace(/^::/, '') : null;
export function callIs(node, receiver, name) {
  return node?.type === 'call' && tokens(field(node, 'receiver')) === normalized(receiver) && field(node, 'method')?.text === name;
}
