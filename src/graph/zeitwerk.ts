/**
 * Zeitwerk autoload map — the constant↔file bijection a Rails app is built on.
 *
 * Rails autoloads by convention: `app/services/a/b/runner.rb` defines
 * `A::B::Runner`, and `app/models/concerns/role_based_access_control.rb` defines
 * `RoleBasedAccessControl` rather than `Concerns::RoleBasedAccessControl`, because
 * `app/models/concerns` is itself an autoload root. That map is the only thing in
 * a Rails app that can adjudicate between two files defining the same constant, and
 * `resolve.ts` uses it for exactly that — as a tiebreaker after Ruby's own lexical
 * lookup has already had its turn, never as a first resort.
 *
 * **Gated on Rails detection, deliberately.** An `app/` directory is not evidence
 * of Rails; plenty of plain gems have one. Inferring roots from directory shape
 * alone would let a framework-specific rule fire on a non-framework repo, which is
 * precisely the boundary a polyglot tool's maintainers care about. Detection wants
 * both a `config/application.rb` and a Gemfile that names `rails`.
 *
 * Everything here is best-effort and degrades to "no opinion": an unparseable
 * `config.autoload_paths`, an exotic inflector, a file under no root at all — all
 * of them simply produce no entry, and the caller then declines rather than guesses.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { relPosix } from "../util/paths.js";

export interface ZeitwerkMap {
  /** repo-relative posix path → the constant Zeitwerk would autoload from it
   * (`app/models/concerns/tenant_security.rb` → `TenantSecurity`). Only `.rb`
   * files under an autoload root have an entry. */
  fqnByPath: ReadonlyMap<string, string>;
  /** The autoload roots found, repo-relative and posix. Kept for diagnostics and
   * because a future milestone (M2's macro targets) needs the root set itself,
   * not just the derived map. */
  roots: readonly string[];
  /** `inflect.acronym` overrides, keyed by the acronym downcased (`api` → `API`).
   * Shared with the Rails macro extractor so `has_many :api_clients` infers
   * `APIClient` and not `ApiClient` — the spec's "one inflector, not two". */
  acronyms: ReadonlyMap<string, string>;
  /** Top-level constants a locked gem provides, by the gem-naming convention:
   * `pagy` → `Pagy`, `aws-record` → `Aws`, `i18n` → `I18n`, `good_job` → `GoodJob`.
   * The repository cannot own these, so a file that reopens one is a patch, not a
   * definition — the defect-9 rule, extended past the hand-written core and Rails
   * lists. A name the convention gets wrong (`rspec-rails` is `RSpec`, not `Rspec`)
   * is simply absent, which leaves resolution exactly as it was. */
  gemConstants: ReadonlySet<string>;
}

/**
 * Directories under `app/` that Rails excludes from the autoload paths. They hold
 * assets and templates, not constants — and `app/views` in particular would
 * otherwise claim every ERB file's directory as a namespace.
 */
const APP_EXCLUDED = new Set(["assets", "javascript", "views"]);

/** Recognizes `gem "rails"` / `gem 'rails'`, including `gem "rails", "~> 7.1"`. */
const GEMFILE_RAILS = /^\s*gem\s+['"]rails['"]/m;

/**
 * `config.autoload_paths << Rails.root.join("lib")`, `config.eager_load_paths +=
 * %W[#{config.root}/lib]`, and the handful of other spellings that appear in real
 * `application.rb` files. Deliberately shallow: this pulls quoted path fragments
 * out of an autoload-paths line and keeps the ones that look like repo-relative
 * directories. Anything computed at runtime is invisible here and is meant to be —
 * a wrong root produces wrong constants for a whole directory tree.
 */
const AUTOLOAD_LINE = /config\.(?:eager_load_paths|autoload_paths|autoload_once_paths)\s*(?:<<|\+=|=)\s*(.+)/g;
const PATH_FRAGMENT = /['"]([^'"]+)['"]/g;

/**
 * `config.autoload_lib(ignore: %w[assets tasks])` — the Rails 7.1 spelling that
 * replaced pushing `lib` onto `config.autoload_paths` by hand, and the one both
 * corpus apps use. Both halves matter. Without the root, `lib/tenancy.rb` is not
 * the home of `Tenancy` and a file that merely opens `module Tenancy` outranks it.
 * Without the ignore list, every `lib/tasks/*.rb` claims a constant Rails never
 * autoloads — which is the whole reason the argument exists: eager-loading
 * `lib/rubo_cop` at boot raises LoadError, so apps name it here.
 */
const AUTOLOAD_LIB = /config\.autoload_lib(?:_once)?\s*(?:\(([^)]*)\))?/g;

/**
 * `Rails.autoloaders.main.push_dir(Rails.root.join("app/capability_packs"), namespace:
 * CapabilityPacks)` — a root whose constants live UNDER a namespace. dailywerk has
 * two. Without the namespace the map computed `Core::Pack` for a file that defines
 * `CapabilityPacks::Core::Pack`, so no file in either tree was ever anyone's home.
 * The call spans lines and nests parentheses, so it is scanned, not matched.
 */
const PUSH_DIR = /Rails\.autoloaders\.(?:main|once)\.push_dir\s*\(/g;

/** `config.autoload_paths -= [path]`, and the guides' other spelling of a removal. */
const AUTOLOAD_REMOVE = /config\.(?:eager_load_paths|autoload_paths|autoload_once_paths)\s*-=\s*(.+)/g;
const AUTOLOAD_DELETE = /(?:config|ActiveSupport::Dependencies)\.(?:eager_load_paths|autoload_paths|autoload_once_paths)\.delete\s*\(/g;

/** One path-bearing piece of an expression: a `.join(...)`, a string, or a local. */
const PATH_EXPR = /(?:Rails\.|config\.)?root\.join\s*\(([^)]*)\)|(['"])([^'"]*)\2|\b([a-z_]\w*)\b/g;
const PATH_LOCAL = /^[ \t]*([a-z_]\w*)[ \t]*=[ \t]*([^\n]+)$/gm;
const NAMESPACE_ARG = /\bnamespace:\s*((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)/;

/** `%w[a b]`, `%w(a b)`, `%w{a b}` — the list spelling `ignore:` almost always takes. */
const WORD_ARRAY = /%[wi][[({]([^\])}]*)[\])}]/;

/** `inflect.acronym "API"` inside `config/initializers/inflections.rb`. */
const ACRONYM = /\binflect\.acronym\s+['"]([^'"]+)['"]/g;

/**
 * The autoload map for `root`, or null when this is not a Rails app.
 *
 * `repoFiles` is buildGraph's single enumeration — the same Git-ignore-aware view
 * extraction and scope discovery use, so a vendored or ignored `app/` tree cannot
 * contribute roots (mirrors `readGoModules`, which takes the same list for the
 * same reason).
 */
/**
 * The files that decide whether this repo is a Rails app AT ALL, and which are not
 * source files, so nothing else tracks them.
 *
 * `config/application.rb` and `config/initializers/inflections.rb` are Ruby and are
 * already in the fingerprint by virtue of being parsed. A Gemfile is not, and it is
 * half the detection: editing it from `gem "rails"` to something else changes every
 * Ruby constant edge in the graph while leaving the freshness probe perfectly clean,
 * so queries kept answering from a Zeitwerk-resolved graph that an explicit rebuild
 * would have thrown away. See `writeFingerprint`.
 */
export const RAILS_WITNESS_FILES = ["Gemfile", "gems.rb"] as const;

export function discoverZeitwerk(root: string, repoFiles: string[]): ZeitwerkMap | null {
  const rels = repoFiles.map((f) => relPosix(root, f));
  const relSet = new Set(rels);
  if (!relSet.has("config/application.rb")) return null;

  const gemfile = RAILS_WITNESS_FILES.find((g) => relSet.has(g));
  if (!gemfile) return null;
  if (!GEMFILE_RAILS.test(read(posix.join(root, gemfile)) ?? "")) return null;

  const acronyms = readAcronyms(root, relSet);
  const { roots, ignored, namespaces } = discoverRoots(root, rels);

  const fqnByPath = new Map<string, string>();
  for (const rel of rels) {
    if (!rel.endsWith(".rb")) continue;
    // An ignored subtree is under a root but is not autoloaded, so it defines no
    // constant Zeitwerk would find and must not be anyone's home.
    if (ignored.some((dir) => rel.startsWith(`${dir}/`))) continue;
    // Longest root wins: `app/models/concerns/x.rb` belongs to `app/models/concerns`,
    // not `app/models`. Getting this backwards is what turns `RoleBasedAccessControl`
    // into `Concerns::RoleBasedAccessControl` — a constant that exists nowhere.
    const owner = roots.filter((r) => rel.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (owner === undefined) continue;
    const inner = rel.slice(owner.length + 1, -".rb".length);
    if (inner === "") continue;
    const path = inner.split("/").map((seg) => camelize(seg, acronyms)).join("::");
    const ns = namespaces.get(owner);
    fqnByPath.set(rel, ns ? `${ns}::${path}` : path);
  }
  return { fqnByPath, roots, acronyms, gemConstants: readGemConstants(root, relSet, acronyms) };
}

/**
 * Whether `path` is where Zeitwerk would look for `fqn` — either the file that
 * defines it outright, or a file defining one of its namespaces (a nested class
 * declared inside its parent's file, which Zeitwerk permits and Rails apps use
 * constantly for error classes).
 */
export function isAutoloadHome(zw: ZeitwerkMap, path: string, fqn: string): boolean {
  const owned = zw.fqnByPath.get(path);
  if (owned === undefined) return false;
  return fqn === owned || fqn.startsWith(`${owned}::`);
}

function read(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Rails' default autoload roots plus whatever `config/application.rb` adds.
 *
 * The default set is every immediate subdirectory of `app`, plus each of their
 * `concerns` subdirectories, minus assets/javascript/views. That is Rails' own
 * `config.paths.add "app"` glob, not a heuristic of ours. Only directories that
 * actually exist in the walked file list become roots, so a configured-but-absent
 * path contributes nothing.
 */
function discoverRoots(root: string, rels: string[]): { roots: string[]; ignored: string[]; namespaces: Map<string, string> } {
  const dirs = new Set<string>();
  for (const rel of rels) {
    let dir = posix.dirname(rel);
    while (dir !== "." && dir !== "/" && dir !== "") {
      dirs.add(dir);
      dir = posix.dirname(dir);
    }
  }

  const out = new Set<string>();
  for (const dir of dirs) {
    const segs = dir.split("/");
    if (segs[0] !== "app") continue;
    if (segs.length === 2 && !APP_EXCLUDED.has(segs[1])) out.add(dir);
    if (segs.length === 3 && segs[2] === "concerns" && !APP_EXCLUDED.has(segs[1])) out.add(dir);
  }

  const app = configSource(read(posix.join(root, "config/application.rb")) ?? "");
  const appLocals = pathLocals(app);
  const existing = (dir: string | null): dir is string => dir !== null && dirs.has(dir);

  for (const line of app.matchAll(AUTOLOAD_LINE))
    for (const dir of pathExprs(line[1], appLocals)) if (existing(dir)) out.add(dir);

  const ignored = new Set<string>();
  for (const call of app.matchAll(AUTOLOAD_LIB)) {
    if (!dirs.has("lib")) continue;
    out.add("lib");
    for (const dir of ignoredDirs(call[1] ?? "")) ignored.add(`lib/${dir}`);
  }

  // Removals, before any `push_dir`: the Rails guides' recipe for a namespaced
  // directory is to take it OUT of the autoload paths and hand it back to Zeitwerk
  // under a namespace. Read only the second half and the directory is both a plain
  // root and a namespaced one; read neither and every file in it is mapped to a
  // constant one namespace too short. A removed directory nobody re-adds is not
  // autoloaded at all, so it stops being anyone's home.
  for (const m of app.matchAll(AUTOLOAD_REMOVE))
    for (const dir of pathExprs(m[1], appLocals)) if (dir) out.delete(dir);
  for (const m of app.matchAll(AUTOLOAD_DELETE)) {
    const args = balancedArgs(app, m.index! + m[0].length);
    for (const dir of args === null ? [] : pathExprs(args, appLocals)) if (dir) out.delete(dir);
  }

  // `push_dir` belongs in an initializer — that is where the guides put it, next to
  // the `module Services; end` it needs — so config/initializers is read as well as
  // application.rb. Each file's locals are its own.
  const namespaces = new Map<string, string>();
  const pushSources = ["config/application.rb", ...rels.filter((r) => r.startsWith("config/initializers/") && r.endsWith(".rb")).sort()];
  for (const rel of pushSources) {
    const text = rel === "config/application.rb" ? app : configSource(read(posix.join(root, rel)) ?? "");
    if (!text.includes("push_dir")) continue;
    const locals = rel === "config/application.rb" ? appLocals : pathLocals(text);
    for (const call of text.matchAll(PUSH_DIR)) {
      const args = balancedArgs(text, call.index! + call[0].length);
      if (args === null) continue;
      const dir = pathExprs(firstArg(args), locals)[0] ?? null;
      if (!existing(dir)) continue;
      out.add(dir);
      const ns = NAMESPACE_ARG.exec(args);
      if (ns) namespaces.set(dir, ns[1].replace(/^::/, ""));
    }
  }
  return { roots: [...out], ignored: [...ignored], namespaces };
}

/**
 * Configuration text with its full-line comments removed. `application.rb` files
 * keep old settings commented out rather than deleted, and a reader that matched
 * `# config.autoload_paths << Rails.root.join('app', 'components')` made `app`
 * itself a root.
 */
function configSource(text: string): string {
  return text.split("\n").map((line) => (line.trimStart().startsWith("#") ? "" : line)).join("\n");
}

/**
 * The repository-relative directories a Ruby path expression names, in order, with
 * `null` for a piece this cannot place. Understood: a string literal (`"lib"`,
 * `"#{Rails.root}/lib"`), `Rails.root.join("a", "b")` / `root.join(...)` /
 * `config.root.join(...)` with its segments JOINED — an earlier reader took each
 * segment as a separate candidate, so `join('app', 'components')` proposed `app` —
 * an optional `.to_s`, and a local bound to one of those earlier in the same file.
 * Anything computed is invisible and meant to be: a wrong root maps a whole tree
 * to the wrong constants.
 */
function pathExprs(expr: string, locals: ReadonlyMap<string, string>): (string | null)[] {
  const out: (string | null)[] = [];
  for (const m of expr.matchAll(PATH_EXPR)) {
    if (m[1] !== undefined) {
      const segs = [...m[1].matchAll(PATH_FRAGMENT)].map((f) => f[1]);
      out.push(segs.length ? cleanPath(segs.join("/")) : null);
    } else if (m[3] !== undefined) out.push(cleanPath(m[3]));
    else if (m[4] !== undefined && locals.has(m[4])) out.push(locals.get(m[4])!);
  }
  return out;
}

/** `name = Rails.root.join("app/x")` and friends, read in document order. */
function pathLocals(text: string): Map<string, string> {
  const locals = new Map<string, string>();
  for (const m of text.matchAll(PATH_LOCAL)) {
    const dir = pathExprs(m[2], new Map())[0];
    if (dir) locals.set(m[1], dir);
  }
  return locals;
}

function cleanPath(raw: string): string | null {
  const cleaned = raw.replace(/#\{[^}]*\}/g, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return cleaned === "" || cleaned.startsWith("..") ? null : cleaned;
}

/** The first argument of an argument list, up to the first top-level comma. */
function firstArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** The argument text of a call whose `(` ends just before `start`, or null when the
 * parentheses never balance — a truncated file is not a root to guess at. */
function balancedArgs(text: string, start: number): string | null {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(start, i);
  }
  return null;
}

/**
 * The directory names in an `ignore:` argument. Both spellings appear in the wild —
 * `%w[assets tasks]` and `["assets", "tasks"]` — and a lone `ignore: "tasks"` is
 * legal too. Anything absolute or parent-escaping is dropped rather than normalized,
 * for the same reason a computed autoload path is: a wrong entry here silently
 * removes a whole subtree from the map.
 */
function ignoredDirs(args: string): string[] {
  const words = WORD_ARRAY.exec(args);
  const raw = words ? words[1].split(/\s+/) : [...args.matchAll(PATH_FRAGMENT)].map((m) => m[1]);
  const out: string[] = [];
  for (const word of raw) {
    const cleaned = word.replace(/^\/+/, "").replace(/\/+$/, "");
    if (cleaned === "" || cleaned.startsWith("..")) continue;
    out.push(cleaned);
  }
  return out;
}

/** The first segment of every gem in the lockfile's specs, camelized. Only the
 * four-space `name (version)` lines — the six-space ones below them are that gem's
 * own dependencies, which are locked too and appear as specs of their own. */
function readGemConstants(root: string, relSet: ReadonlySet<string>, acronyms: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  const lock = ["Gemfile.lock", "gems.locked"].find((f) => relSet.has(f));
  if (!lock) return out;
  for (const m of (read(posix.join(root, lock)) ?? "").matchAll(/^ {4}([A-Za-z0-9_.]+)(?:-[A-Za-z0-9_.-]+)? \(/gm))
    out.add(camelize(m[1], acronyms));
  return out;
}

function readAcronyms(root: string, relSet: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  if (!relSet.has("config/initializers/inflections.rb")) return out;
  const src = read(posix.join(root, "config/initializers/inflections.rb")) ?? "";
  for (const m of src.matchAll(ACRONYM)) out.set(m[1].toLowerCase(), m[1]);
  return out;
}

/**
 * `api_client` → `ApiClient`, or `APIClient` once `inflect.acronym "API"` is
 * configured. ActiveSupport's `camelize` with the acronym table, reduced to the
 * part Zeitwerk actually exercises: file basenames are `snake_case`, so the
 * per-underscore-segment reading is exact rather than an approximation of the
 * full inflector.
 */
export function camelize(segment: string, acronyms: ReadonlyMap<string, string>): string {
  return segment
    .split("_")
    .map((word) => acronyms.get(word.toLowerCase()) ?? (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join("");
}

/**
 * `items` → `item`, `people` → `person`. ActiveSupport's default singular rules,
 * which is what Rails itself uses to turn `has_many :people` into `Person`.
 *
 * Transcribed rather than approximated on purpose: a hand-rolled `chomp("s")` gets
 * `people` → `People`, `categories` → `Categorie` and `addresses` → `Addresse`, and
 * every one of those silently costs an association its target edge. The rules are
 * ordered — first match wins — exactly as ActiveSupport orders them.
 *
 * Being wrong here is cheap and self-correcting: a bad guess produces a constant name
 * that resolves to nothing, and the caller emits no edge. It can lose an edge; it
 * cannot invent one.
 */
/** ActiveSupport's `uncountable` list, verbatim. Matched against the LAST word of a
 * snake_case name the way ActiveSupport matches it, so `sales_fish` is uncountable
 * and `line_items` is not. */
const UNCOUNTABLE = new Set([
  "equipment", "fish", "information", "jeans", "money", "police", "rice", "series",
  "sheep", "species",
]);
const UNCOUNTABLE_RE = new RegExp(`\\b(?:${[...UNCOUNTABLE].join("|")})$`, "i");

/**
 * ActiveSupport's singular rules, in ActiveSupport's own evaluation order.
 *
 * Read off a running `ActiveSupport::Inflector.inflections.singulars` rather than
 * remembered, because the differences are not the ones intuition suggests. Three
 * that the previous hand-written table got wrong:
 *
 *   - `databases` needs its own rule, or `(x|ch|ss|sh)es$` never fires and the
 *     generic `s$` leaves `databasis` by way of `(cris|test)(is|es)$`.
 *   - the irregulars are RULES, not a word list, so `salespeople` singularizes to
 *     `salesperson`; an exact-match map only ever caught the bare `people`.
 *   - `moves` is irregular in ActiveSupport; the generic `([^f])ves$` rule turns it
 *     into `mofe`.
 *
 * Each irregular is a PAIR: the plural rule and an identity rule for the singular,
 * so an already-singular word stops rather than falling through to a generic rule.
 * `feet`, `teeth` and `geese` are absent on purpose — ActiveSupport does not
 * singularize them either, and this has to predict Rails, not English.
 */
const SINGULAR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(z)ombies$/i, "$1ombie"],
  [/(z)ombie$/i, "$1ombie"],
  [/(m)oves$/i, "$1ove"],
  [/(m)ove$/i, "$1ove"],
  [/(s)exes$/i, "$1ex"],
  [/(s)ex$/i, "$1ex"],
  [/(c)hildren$/i, "$1hild"],
  [/(c)hild$/i, "$1hild"],
  [/(m)en$/i, "$1an"],
  [/(m)an$/i, "$1an"],
  [/(p)eople$/i, "$1erson"],
  [/(p)erson$/i, "$1erson"],
  [/(database)s$/i, "$1"],
  [/(quiz)zes$/i, "$1"],
  [/(matr)ices$/i, "$1ix"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/^(ox)en/i, "$1"],
  [/(alias|status)(es)?$/i, "$1"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/(shoe)s$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(bus)(es)?$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/(m)ovies$/i, "$1ovie"],
  [/(s)eries$/i, "$1eries"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/([lr])ves$/i, "$1f"],
  [/(tive)s$/i, "$1"],
  [/(hive)s$/i, "$1"],
  [/([^f])ves$/i, "$1fe"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/([ti])a$/i, "$1um"],
  [/(n)ews$/i, "$1ews"],
  [/(ss)$/i, "$1"],
  [/s$/i, ""],
];

export function singularize(word: string): string {
  if (UNCOUNTABLE_RE.test(word)) return word;
  for (const [re, repl] of SINGULAR_RULES) {
    if (re.test(word)) return word.replace(re, repl);
  }
  return word;
}

export function associationConstant(name: string, acronyms: ReadonlyMap<string, string>): string {
  return camelize(singularize(name), acronyms);
}
