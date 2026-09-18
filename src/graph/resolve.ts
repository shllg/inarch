/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence is a two-tier provenance model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { toPosixPath } from "../util/paths.js";
import type { EdgeV1, Kind, NodeV1, Relation } from "./types.js";
import { languageOf, type RawEdge, type RubyBindingValue } from "./extract.js";
import type { RubySelfKind, RubyType, RubyValueKind } from "./bindings.js";
import { genericLangOf } from "./generic.js";
import { containerLangOf } from "./container.js";
import {
  controllerViews,
  controllerFileFor,
  isTemplatePath,
  isViewHelperPath,
  layoutTarget,
  partialTarget,
  templatePath,
  templatePrefix,
  templateTarget,
  viewRootFor,
  DEFAULT_LAYOUT,
} from "./rails-views.js";
import { camelize, isAutoloadHome, type ZeitwerkMap } from "./zeitwerk.js";

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
/** C/C++ source + header extensions, for resolving `#include` targets. */
const C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|inl|ipp|c\+\+|h\+\+)$/i;
/** JavaScript/TypeScript source extensions. Narrower than IMPORT_EXTS, which also
 * carries `.py`: only these files can import a workspace package by its name.
 *
 * It is also the gate for a same-file type reference, and for the same reason from
 * the other direction: extract.ts parses `.js`/`.jsx` with the TypeScript and TSX
 * grammars, so `ctx.lang` is `typescript`/`tsx` there too. That side gates on the
 * grammar, and this must cover the same files or the two halves disagree about
 * which ones they are talking about. */
const JS_EXT = /\.(m|c)?[jt]sx?$/i;
/** Python source + stub extensions, for the constructor-call fallback below. */
const PY_EXT = /\.pyi?$/i;
/** What a bare Python call falls back to when no function of that name exists:
 * construction. Only `class` — Python enums, dataclasses and NamedTuples are all
 * classes, so no other kind is reachable this way. */
const PY_CTOR_KINDS: Kind[] = ["class"];
/** Swift is Python's case with more nominal kinds: `Animal(legs: 4)` is an ordinary
 * call node with no `new` to mark construction, and struct/enum initializers are as
 * routine as class ones (a struct gets a memberwise init for free). Same fallback
 * shape — types are tried only once functions (and methods, see extract.ts's
 * implicit-self widening) have found nothing. */
const SWIFT_EXT = /\.swift$/i;
const SWIFT_CTOR_KINDS: Kind[] = ["class", "struct", "enum"];

/**
 * Languages whose symbols can genuinely reach each other. A call edge may not
 * cross a family boundary.
 *
 * This exists because name resolution is repo-wide and used to be language-blind.
 * A Go file calling the builtin `make(...)` has nothing in the repo to resolve
 * against, so the unique-global fallback below matched a TypeScript helper named
 * `make` in a frontend test file — and then every `make(map[...])` in the backend
 * became an edge into that file. One symbol collected 1040 in-edges across 476
 * files, and any pull request touching that test dragged the entire Go backend
 * into its blast radius. Uniqueness is what made it fire: the rarer the collision,
 * the more confident the old code was that it had found the right target.
 *
 * Only real interop is grouped here. TS/TSX/JS import each other freely; Kotlin,
 * Scala and Clojure compile against Java on one classpath; C and C++ share
 * headers. Everything else stands alone.
 */
const FAMILIES: ReadonlyArray<readonly string[]> = [
  ["typescript", "tsx"],
  ["java", "kotlin", "scala", "clojure"],
  ["c", "cpp"],
];
const FAMILY_OF = new Map<string, string>();
for (const group of FAMILIES) for (const lang of group) FAMILY_OF.set(lang, group[0]);

/**
 * The language family a path belongs to, or null when no tier claims the file.
 * A language of its own is its own family, so the common case needs no entry above.
 *
 * The container tier is consulted LAST and by its inner language, because that is
 * what a container file's symbols actually are: the Ruby in an `.erb` is Ruby and
 * the script in a `.vue` is TypeScript. Without this the guard read every container
 * file as "unknown family" and — per the rule below, that absence of data never
 * filters — let a bare word in a template reach a definition in any language in the
 * repo. filewerk has 45 Ruby top-level `def`s, all but one of them in `spec/`, and
 * they include `url_for`, `root_path`, `name` and `metadata`: exactly the names a
 * view writes.
 */
function familyOf(path: string): string | null {
  const lang = languageOf(path) ?? genericLangOf(path)?.name ?? containerLangOf(path)?.inner ?? null;
  if (!lang) return null;
  return FAMILY_OF.get(lang) ?? lang;
}

/**
 * Could a reference in `file` reach a definition in `candidatePath`?
 *
 * An unknown family never filters: absence of data is not evidence of a mismatch,
 * and refusing edges for every extension graft cannot name would lose real ones.
 */
function reachable(file: string, candidatePath: string): boolean {
  const from = familyOf(file);
  if (from === null) return true;
  const to = familyOf(candidatePath);
  return to === null || from === to;
}

/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
  module: string;
  dir: string;
}

/** A JavaScript/TypeScript workspace package that lives IN the repo: its declared
 * `name`, the directory its `package.json` sits in (posix, `.` for the repo root),
 * and the two fields that say where a subpath lands. A monorepo holds several —
 * `packages/runtime/`, `packages/ui/`. */
export interface WorkspacePackage {
  name: string;
  dir: string;
  /** `package.json`'s `main`, used only for the root subpath and only when the
   * package declares no `exports`. */
  main?: string;
  /** The string-valued half of `package.json`'s `exports`: subpath (`.`, `./api`,
   * `./*`) → the package-relative file it names. Absent when the package declares
   * none this pass can read. */
  exports?: Record<string, string>;
}

export interface ResolveOptions {
  /** The Go modules found in the repo. Enables mapping Go import package paths
   * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
   * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
  goModules?: GoModule[];
  /** The Rails autoload map, or null/absent when the repo is not a Rails app. Used
   * ONLY to break a tie between several files defining one constant — never as a
   * first resort, and never to invent a target Ruby's own lexical lookup did not
   * already find. A plain Ruby project therefore resolves constants identically
   * with or without it. */
  zeitwerk?: ZeitwerkMap | null;
  /** M4: false when the app writes `config.action_controller.include_all_helpers =
   * false`, which stops every `app/helpers/` module being mixed into every view.
   * Absent means Rails' default, true. Checked rather than assumed: assuming it
   * would put edges into helpers a template provably cannot reach. */
  railsIncludeAllHelpers?: boolean;
  /** Pinned public GoodJob package version; only verified forwarding conventions
   * may use this to cross an otherwise unknown external mixin. */
  goodJobVersion?: string;
  /** The workspace packages found in the repo. Enables mapping a BARE specifier that
   * names one of them (`@acme/runtime/api`) to the in-repo file it imports. Empty or
   * absent → every bare specifier stays an external string, which is the behaviour
   * before this option existed. */
  workspacePackages?: WorkspacePackage[];
}

export function resolveEdges(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  opts: ResolveOptions = {},
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const globalName = new Map<string, NodeV1[]>();
  const perFileName = new Map<string, Map<string, NodeV1[]>>();
  // Owner-qualified method index: "Owner.method" → candidate method nodes, for
  // typed member-call resolution (recvType + name → a specific class's method).
  const ownerMethod = new Map<string, NodeV1[]>();
  // Go package resolution: dir (posix) → its `.go` file node ids, for import mapping.
  const goFilesByDir = new Map<string, string[]>();
  // Java package resolution: a file's package-path suffix (`com/acme/Foo.java`) → its
  // file node ids. A Java import names a type by its fully-qualified name, which by
  // language convention mirrors the directory path under whatever source root the
  // project uses (`src/main/java/`, `src/`, …) — so the suffix is the portable key.
  const javaFilesBySuffix = new Map<string, string[]>();
  // C/C++ header resolution: a file's path-suffix (`net/socket.h`, `socket.h`) → its
  // file node ids, so an `#include` reached through an `-I` dir (not relative to the
  // including file) still resolves to the in-repo header when the suffix is unique.
  const cFilesBySuffix = new Map<string, string[]>();
  // Rust crate roots: the directory holding a `lib.rs` or `main.rs`. A `use crate::a::b`
  // resolves to `<crate root>/a/b.rs` (or `.../a/b/mod.rs`), relative to the crate the
  // importing file belongs to — so a workspace with several crates stays unambiguous.
  const rustCrateRoots: string[] = [];
  // PHP class resolution: a file's path-suffix (`Models/User.php`, `User.php`) → its file
  // node ids. A `use App\Models\User` names a PSR-4 class whose file mirrors the namespace
  // tail under some (unknown) source root, so the suffix is the portable key.
  const phpFilesBySuffix = new Map<string, string[]>();
  // Ruby constant resolution: fully-qualified constant → the class/module nodes
  // defining it. Ruby-only by construction, which is what keeps a Ruby `Invoice`
  // from ever reaching a TypeScript class of the same name — the guard is in the
  // index, not in a filter the caller has to remember to apply.
  const rubyFqn = new Map<string, NodeV1[]>();
  // "Owner::Fqn#method" → the method nodes defining it. `#` separates, because `::`
  // and `.` both occur inside the two halves.
  const rubyOwnerMethod = new Map<string, NodeV1[]>();
  const hasGoModules = !!opts.goModules?.length;
  const workspacePackages = opts.workspacePackages ?? [];
  for (const n of nodes) {
    if (n.kind === "file") {
      if (hasGoModules && n.path.endsWith(".go")) {
        const dir = posix.dirname(toPosixPath(n.path));
        push(goFilesByDir, dir, n.id);
      }
      if (n.path.endsWith(".java")) {
        // Index every directory-boundary suffix, since the source root is unknown:
        // `src/main/java/com/acme/Foo.java` is reachable as `com/acme/Foo.java`,
        // `acme/Foo.java`, and so on. The import's own FQN picks the right depth.
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(javaFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (C_EXT.test(n.path)) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(cFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (n.path.endsWith(".php")) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(phpFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      {
        const p = toPosixPath(n.path);
        if (p === "lib.rs" || p === "main.rs") rustCrateRoots.push("");
        else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs")) rustCrateRoots.push(posix.dirname(p));
      }
      continue;
    }
    push(globalName, n.name, n);
    let fileMap = perFileName.get(n.path);
    if (!fileMap) perFileName.set(n.path, (fileMap = new Map()));
    push(fileMap, n.name, n);
    if (n.kind === "method") {
      const owner = n.owner ?? ownerFromMethodId(n.id);
      if (owner) push(ownerMethod, `${owner}.${n.name}`, n);
    }
    if ((n.kind === "class" || n.kind === "module") && RB_EXT.test(n.path)) {
      const fqn = rubyFqnOf(n.id);
      if (fqn) push(rubyFqn, fqn, n);
    }
    if (n.kind === "method" && RB_EXT.test(n.path)) {
      // Owner-qualified by FULL Ruby name, unlike `ownerMethod` above, which is keyed
      // by the bare class name every language shares. See `RawEdge.rubyOwnerFqn`.
      const own = rubyFqnOf(n.id);
      const cut = own?.lastIndexOf("::") ?? -1;
      if (own && cut > 0) push(rubyOwnerMethod, `${own.slice(0, cut)}#${n.name}`, n);
    }
  }

  /**
   * The class or module whose body declares the value constant `ref` names, or null.
   *
   * The head resolves like any constant; the terminal is then looked up through the
   * head's ancestry, as Ruby does for `Child::LIMIT` declared on `Parent`. Only a
   * declaration written directly in a class or module body counts, and only one:
   * two bodies declaring the same path is a choice, and a declaration whose source
   * is not the owning scope — `Foo::BAR = 1` at a file's top level — has no class
   * node that honestly owns it.
   */
  const rubyValueConstantOwner = (ref: string, e: RawEdge): { id: string; confidence: EdgeV1["confidence"] } | null => {
    const cut = ref.lastIndexOf("::");
    if (cut <= 0) return null;
    const head = constNode(resolveRubyConstant(ref.slice(0, cut), e.nesting ?? [], e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn"));
    const headFqn = head ? rubyFqnOf(head.id) : null;
    if (!headFqn) return null;
    const walk = rubyLinearize(headFqn, rubyHeritage);
    if (walk.truncated) return null;
    const tail = ref.slice(cut + 2);
    for (const scope of walk.chain) {
      const decls = rubyConstAssignments.get(`${scope}::${tail}`);
      if (!decls?.length) continue;
      const sources = [...new Set(decls.map((d) => d.source))];
      if (sources.length !== 1) return null;
      const node = byId.get(sources[0]);
      if (!node || rubyFqnOf(node.id) !== scope) return null;
      return { id: node.id, confidence: node.path === e.file ? "extracted" : "inferred" };
    }
    return null;
  };

  // Ruby ancestors, FQN-keyed, for step 2 of the constant lookup. Built from the
  // heritage edges themselves in a pre-pass, because the answer is needed BEFORE
  // the main loop resolves them — a constant may only be visible through the very
  // superclass whose own name is a constant reference. The pre-pass runs the same
  // lookup with the ancestor step disabled, which terminates by construction and
  // costs one extra pass over the (small) heritage subset.
  const zeitwerk = opts.zeitwerk ?? null;

  // Constant ASSIGNMENTS, as fully-qualified names. These are declarations Ruby's
  // lookup finds but the graph cannot point at — `MAX = 10` has no node — so they
  // exist only to make the search stop where Ruby stops. See `RawEdge.rubyConstDecl`.
  const rubyShadow = new Set<string>();
  // Alias validation must use these same resolved assignment identities. A
  // qualified write can target an outer namespace despite its lexical nesting.
  const rubyConstAssignments = new Map<string, RawEdge[]>();
  for (const e of rawEdges) {
    if (!e.rubyConstDecl || !e.name || e.name.includes("::")) continue;
    const cref = e.nesting?.[0];
    const path = cref ? `${cref}::${e.name}` : e.name;
    rubyShadow.add(path);
    push(rubyConstAssignments, path, e);
  }

  // Ruby ancestors, FQN-keyed, for step 2 of the constant lookup. Built from the
  // heritage edges themselves in a pre-pass, because the answer is needed BEFORE
  // the main loop resolves them — a constant may only be visible through the very
  // superclass whose own name is a constant reference. The pre-pass runs the same
  // lookup with the ancestor step disabled, which terminates by construction and
  // costs one extra pass over the (small) heritage subset.
  //
  // Order is Ruby's, not emission order: `prepend`s (reverse declaration order),
  // then the class itself, then `include`s (reverse declaration order), then the
  // superclass. `extend` is absent by design — it composes the SINGLETON class, and
  // constant lookup walks `cref.ancestors`, which `extend` never touches.
  const rubyHeritage = new Map<string, RubyHeritage>();
  const rubyIncluders = new Map<string, string[]>();
  const NO_HERITAGE = new Map<string, RubyHeritage>();
  // The superclass as WRITTEN, resolved or not. `class User < ApplicationRecord`
  // resolves; `class ApplicationRecord < ActiveRecord::Base` does not, because
  // ActiveRecord is a gem and has no node here — and that unresolvable name is
  // exactly the evidence that the chain reaches a model. See `rubyModels`.
  const rubySuperNames = new Map<string, string[]>();
  const rubyExternalSupers = new Map<string, string[]>();
  const rubyUnknownMixins = new Set<string>();
  const rubyUnknownMixinNames = new Map<string, { name: string; kind: RawEdge["rubyHeritage"]; external: boolean }[]>();
  const supportedFrameworkMixins = new Set(["ActiveSupport::Concern", "GoodJob::ActiveJobExtensions::Concurrency", "GoodJob::ActiveJobExtensions::Labels"]);
  const composedNamespaces = new Set(rawEdges.filter(e => e.rubyHeritage).map(e => e.rubyOwnerFqn ?? rubyFqnOf(e.source)));
  const heritageByOwner = new Map<string, { kind: RawEdge["rubyHeritage"]; fqn: string; id: string }[]>();
  for (const e of rawEdges) {
    if (e.rubyHeritageUnknown) {
      const owner = e.rubyOwnerFqn ?? rubyFqnOf(e.source);
      if (owner) {
        rubyUnknownMixins.add(owner);
        push(rubyUnknownMixinNames, owner, { name: "<computed mixin>", kind: e.rubyHeritage, external: false });
      }
      continue;
    }
    if (e.relation !== "extends" || !e.name || !e.nesting) continue;
    const ownFqn = rubyFqnOf(e.source);
    if (!ownFqn) continue;
    if (e.rubyHeritage === "superclass" || e.rubyHeritage === undefined) push(rubySuperNames, ownFqn, e.name);
    const hit = resolveRubyConstant(e.name, e.nesting, e.file, rubyFqn, NO_HERITAGE, rubyShadow, zeitwerk, false);
    if (hit === null && e.rubyHeritage === "superclass") push(rubyExternalSupers, ownFqn, e.name);
    const parentFqn = hit && hit !== "stopped" ? rubyFqnOf(hit.id) : null;
    if (!hit || hit === "stopped" || !parentFqn) {
      if (e.rubyHeritage && e.rubyHeritage !== "superclass") {
        rubyUnknownMixins.add(ownFqn);
        const name = e.name.replace(/^::/, "");
        let external = hit === null;
        // Rails tests commonly reopen ActiveSupport to extend TestCase. Once its
        // namespace has a node, the absent gem member Concern returns "stopped"
        // rather than null. That is not a local replacement. For the framework
        // modules already supported below, verify the canonical module namespace
        // and an absent terminal; lexical shadows and composed namespaces decline.
        if (hit === "stopped" && supportedFrameworkMixins.has(name) && !rubyFqn.has(name)) {
          const namespace = e.name.slice(0, e.name.lastIndexOf("::"));
          const expected = name.slice(0, name.lastIndexOf("::"));
          const parent = resolveRubyConstant(namespace, e.nesting, e.file, rubyFqn, NO_HERITAGE, rubyShadow, zeitwerk, false, "fqn");
          external = !!parent && parent !== "stopped" && rubyFqnOf(parent.id) === expected &&
            byId.get(parent.id)?.kind === "module" && !composedNamespaces.has(expected) &&
            !(rubyOwnerMethod.get(`${expected}#const_missing`) ?? []).some(n => rubyNodeAnswers(n, "class"));
        }
        push(rubyUnknownMixinNames, ownFqn, { name, kind: e.rubyHeritage, external });
      }
      continue;
    }
    if (supportedFrameworkMixins.has(e.name.replace(/^::/, "")) && e.rubyHeritage !== "superclass") {
      // An in-repo replacement may implement arbitrary inclusion/extension hooks.
      // Its name cannot borrow the external framework package's target contract.
      rubyUnknownMixins.add(ownFqn);
      push(rubyUnknownMixinNames, ownFqn, { name: parentFqn, kind: e.rubyHeritage, external: false });
    }
    push(heritageByOwner, ownFqn, { kind: e.rubyHeritage, fqn: parentFqn, id: e.source });
    // The inverse edge, for M2: which classes include this concern. A declaration
    // inside an `included do` block runs in each of them, so this is the list its
    // edges get re-attributed across. `extend` is excluded: extending a concern does
    // not fire its `included` hook, so nothing declared there runs in the extender.
    if (e.rubyHeritage !== "extend") push(rubyIncluders, hit.id, e.source);
  }
  for (const [ownFqn, entries] of heritageByOwner) {
    const kindOf = (k: RawEdge["rubyHeritage"]) => entries.filter((x) => x.kind === k).map((x) => x.fqn);
    // A graph built before `rubyHeritage` existed tags nothing; those edges keep
    // their emission order rather than being silently reordered into a guess, and
    // are read as `include`s — the commonest of the three and the only one that
    // affects neither the head nor the tail of the linearization.
    const untagged = entries.filter((x) => x.kind === undefined).map((x) => x.fqn);
    if (new Set(kindOf("superclass")).size > 1) {
      rubyUnknownMixins.add(ownFqn);
      push(rubyUnknownMixinNames, ownFqn, { name: "<conflicting superclasses>", kind: "superclass", external: false });
    }
    rubyHeritage.set(ownFqn, {
      prepends: kindOf("prepend").reverse(),
      includes: [...kindOf("include").reverse(), ...untagged],
      supers: kindOf("superclass"),
      extends: kindOf("extend").reverse(),
    });
  }
  const rubyWorkflowUncertainShadows = new Set<string>();
  // Qualified assignments resolve their namespace, rather than appending a
  // literal `A::B` to the lexical nesting. They were previously discarded, so an
  // overwritten namespaced mailbox/job retained its original executable target.
  for (const e of rawEdges) {
    if (!e.rubyConstDecl || !e.name?.includes("::")) continue;
    const cut = e.name.lastIndexOf("::");
    const namespace = e.name.slice(0, cut);
    const terminal = e.name.slice(cut + 2);
    if (!namespace) { rubyShadow.add(terminal); push(rubyConstAssignments, terminal, e); continue; } // ::Name = ...
    const hit = resolveRubyConstant(namespace, e.nesting ?? [], e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn");
    const owner = hit && hit !== "stopped" ? rubyFqnOf(hit.id) : null;
    if (owner) {
      const path = `${owner}::${terminal}`;
      rubyShadow.add(path);
      push(rubyConstAssignments, path, e);
    } else {
      // An implicit Zeitwerk or gem namespace may have no indexed node. That
      // does not erase the assignment. Keep each possible lexical identity as a
      // workflow-only barrier; none of these possibilities resolves a new edge.
      const absolute = e.name.startsWith("::");
      const path = e.name.replace(/^::/, "");
      const ancestors = absolute ? [] : rubyLinearize(e.nesting?.[0], rubyHeritage).chain;
      const prefixes = absolute ? [""] : [...(e.nesting ?? []), ...ancestors, ""];
      for (const prefix of prefixes) rubyWorkflowUncertainShadows.add(prefix ? `${prefix}::${path}` : path);
    }
  }

  // A Class.new assignment is only a syntactic declaration until the complete
  // repository can prove that Class still names the builtin and the target has
  // one identity. Keep source nodes for inspection, as with reassigned ordinary
  // classes, but remove invalid candidates from EVERY resolution index. Filtering
  // just their incoming calls would leave their methods available to self dispatch,
  // inherited lookup and the unique-name fallback.
  const factories = rawEdges.filter(edge => edge.rubyClassFactory);
  if (factories.length) {
    const barriers = new Set([...rubyShadow, ...rubyWorkflowUncertainShadows]);
    const shadowed = (fqn: string): boolean => fqn.split("::").some((_, i, parts) => barriers.has(parts.slice(0, i + 1).join("::")));
    const invalid = new Set<string>();
    const mutations = rawEdges.filter(edge => edge.rubyClassMutation);
    const builtinAncestors = ["Class", "Module", "Object", "BasicObject"];
    const aliasBindings = new Map<string, (RubyBindingValue | null)[]>();
    const aliasConstants = new Map<string, (RubyBindingValue | null)[]>();
    for (const edge of rawEdges) {
      if (edge.rubyClassAliasBinding) push(aliasBindings, edge.rubyClassAliasBinding.key, edge.rubyClassAliasBinding.value);
    }
    for (const [path, assignments] of rubyConstAssignments) {
      for (const edge of assignments) push(aliasConstants, path, edge.rubyConstAlias ?? null);
    }
    // These aliases are barriers, never dispatch evidence. Keep every writer:
    // even a conflicting assignment may have exposed Class to a later mutation.
    // Visit each indexed alias once, so cycles terminate without a depth guess.
    // Missing bindings and unrelated external namespaces supply no evidence that
    // Class was modified; treating them as such disabled every real factory.
    const mutationAliases = (value: RubyBindingValue | null): string[] => {
      const pending = [value];
      const seen = new Set<string>();
      const targets = new Set<string>();
      while (pending.length) {
        const value = pending.pop();
        if (!value) continue;
        let key: string;
        let writers: (RubyBindingValue | null)[] | undefined;
        if ("binding" in value) {
          key = `binding:${value.binding}`;
          writers = aliasBindings.get(value.binding);
        } else {
          const prefixes = value.constant.startsWith("::") ? [""]
            : [...value.nesting, ...rubyLinearize(value.nesting[0], rubyHeritage).chain, ""];
          const path = value.constant.replace(/^::/, "");
          const match = prefixes.map(prefix => prefix ? `${prefix}::${path}` : path)
            .find(candidate => aliasConstants.has(candidate) || rubyFqn.has(candidate));
          key = `constant:${match ?? path}`;
          writers = match ? aliasConstants.get(match) : undefined;
          if (!writers) {
            const target = resolveRubyConstant(value.constant, value.nesting, value.file, rubyFqn,
              rubyHeritage, rubyShadow, zeitwerk, true, "fqn");
            if (target !== "stopped") targets.add(target ? rubyFqnOf(target.id)! : path);
            continue;
          }
        }
        if (seen.has(key) || !writers) continue;
        seen.add(key);
        pending.push(...writers);
      }
      return [...targets];
    };
    const mutationTargets = mutations.flatMap(edge => mutationAliases(edge.rubyClassMutationBinding
      ? { binding: edge.rubyClassMutationBinding }
      : edge.name ? { constant: edge.name, file: edge.file, nesting: edge.nesting ?? [] } : null));
    const builtinChanged = builtinAncestors.some(owner => (rubyOwnerMethod.get(`${owner}#new`) ?? [])
      .some(node => owner === "Class" || rubyNodeAnswers(node, "class"))) ||
      mutationTargets.some(target => builtinAncestors.includes(target));
    const mutatedOwners = new Set(mutationTargets);
    const factoryDispatch: RubyDispatch = { heritage: rubyHeritage, delegatesToInstance: new Set(),
      modules: new Set([...rubyFqn].filter(([, candidates]) => candidates.some(node => node.kind === "module")).map(([fqn]) => fqn)) };
    for (const edge of factories) {
      const owner = rubyFqnOf(edge.source)!;
      const factory = resolveRubyConstant("Class", edge.nesting ?? [], edge.file,
        rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn");
      const parent = edge.name ? resolveRubyConstant(edge.name, edge.nesting ?? [], edge.file,
        rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn") : "stopped";
      const constructor = rubySingletonChain(owner, factoryDispatch);
      const constructorChanged = constructor.truncated || constructor.steps.some(step =>
        mutatedOwners.has(step.scope) || ["new", "inherited"].some(name =>
          (rubyOwnerMethod.get(`${step.scope}#${name}`) ?? []).some(node => rubyNodeAnswers(node, step.want))));
      if (factory !== null || builtinChanged || constructorChanged || shadowed(owner) || (rubyFqn.get(owner)?.length ?? 0) !== 1 ||
          parent === "stopped" || (parent && (byId.get(parent.id)?.kind !== "class" || shadowed(rubyFqnOf(parent.id)!)))) invalid.add(owner);
    }
    const dependentDefinitions = rawEdges.filter(edge => edge.rubyTypeOnly && edge.relation === "contains" && edge.targetId && edge.rubyFactoryDependencies?.length);
    const dependsOnInvalid = (edge: RawEdge): boolean => !!edge.rubyFactoryDependencies?.some(id => invalid.has(rubyFqnOf(id)!));
    // A factory can inherit another factory or be nested under one. Withdraw the
    // dependent identity too; otherwise removing the first ancestry edge revives
    // its child's own methods through an apparently ordinary constant.
    for (let round = 0; round < factories.length; round++) {
      let grew = false;
      const unavailable = new Set([...invalid, ...dependentDefinitions.filter(dependsOnInvalid).map(edge => rubyFqnOf(edge.targetId!)!)]);
      for (const edge of factories) {
        const owner = rubyFqnOf(edge.source)!;
        if (invalid.has(owner)) continue;
        const parent = edge.name ? constNode(resolveRubyConstant(edge.name, edge.nesting ?? [], edge.file,
          rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn")) : null;
        const parentFqn = parent ? rubyFqnOf(parent.id) : null;
        if (unavailable.has(owner) || [...unavailable].some(path => owner.startsWith(`${path}::`) || parentFqn === path) ||
            (parentFqn && rubyLinearize(parentFqn, rubyHeritage).chain.some(scope => unavailable.has(scope)))) {
          invalid.add(owner); grew = true;
        }
      }
      if (!grew) break;
    }
    if (invalid.size) {
      const rejected = new Set(nodes.filter(node => {
        const fqn = RB_EXT.test(node.path) ? rubyFqnOf(node.id) : null;
        return fqn && [...invalid].some(path => fqn === path || fqn.startsWith(`${path}::`));
      }).map(node => node.id));
      for (const edge of dependentDefinitions) if (dependsOnInvalid(edge)) rejected.add(edge.targetId!);
      const retained = rawEdges.filter(edge => !dependsOnInvalid(edge) && !rejected.has(edge.source) && (!edge.targetId || !rejected.has(edge.targetId)))
        .map(edge => edge.rubyClassFactory ? { ...edge, rubyClassFactory: undefined } : edge);
      const withdrawnConstants = new Set([...invalid, ...nodes.filter(node => rejected.has(node.id) && (node.kind === "class" || node.kind === "module")).map(node => rubyFqnOf(node.id)!)]);
      for (const owner of withdrawnConstants) retained.push({ source: factories[0].file, file: factories[0].file,
        relation: "references", name: `::${owner}`, nesting: [], rubyConstDecl: true });
      return resolveEdges(nodes.filter(node => !rejected.has(node.id)), retained, opts);
    }
  }

  // Which classes are ActiveRecord models — the precondition for reading `first`,
  // `find` and `create` as the framework's finders rather than as somebody's own
  // class method. Closed over the resolved superclass chain AND the unresolved
  // name at its end, since the chain always terminates in a gem.
  const rubyJobs = collectRubyDescendants(rubyHeritage, rubyExternalSupers, new Set(["ActiveJob::Base", "::ActiveJob::Base"]));
  const rubyMailboxes = collectRubyDescendants(rubyHeritage, rubyExternalSupers, new Set(["ActionMailbox::Base", "::ActionMailbox::Base"]));
  const rubyModels = collectRubyDescendants(rubyHeritage, rubySuperNames, AR_BASE_NAMES);
  // The classes whose class-level calls fall through to an instance. See
  // `AS_CURRENT_ATTRIBUTES_NAMES`.
  const rubyDelegating = collectRubyDescendants(rubyHeritage, rubySuperNames, AS_CURRENT_ATTRIBUTES_NAMES);
  const rubyModuleFqns = new Set<string>();
  for (const [fqn, cands] of rubyFqn) if (cands.some((c) => c.kind === "module")) rubyModuleFqns.add(fqn);
  const rubyDispatch: RubyDispatch = {
    heritage: rubyHeritage,
    delegatesToInstance: rubyDelegating,
    modules: rubyModuleFqns,
  };

  // M3: declared RETURN types, keyed by the method node whose call yields them.
  // Only Rails' association macros declare one — `has_many :posts` says that
  // calling `posts` gives you `Post`s — and that single fact is what turns
  // `blog.posts.recent` from an untypeable chain into two ordinary owner-qualified
  // lookups. Keyed by node id rather than by `Owner#name` so an association
  // declared in an `ActiveSupport::Concern` still answers for every class that
  // includes it: the ancestor walk finds the concern's own reader node, which is
  // the id recorded here.
  //
  // Runs after `rubyHeritage` because naming the target class is itself a
  // constant lookup, and that lookup walks ancestors.
  //
  // The KIND travels with the class. `has_many :posts` hands back a CollectionProxy,
  // which forwards class methods and scopes to `Post` and raises NoMethodError for
  // its instance methods; `belongs_to :blog` hands back one Blog. M3 recorded only
  // the class name, so `blog.posts.publish` resolved to an instance method the
  // collection cannot reach.
  const rubyReturns = new Map<string, RubyType>();
  for (const e of rawEdges) {
    if (!e.rubyReturnsFor || !e.name || !e.nesting) continue;
    // `"fqn"`, like the association registry below and the receiver typing it feeds:
    // a return type is a CONSTANT PATH, never an edge. Asking for a node here let two
    // declines meant for edges veto types that were never in doubt — a method
    // returning `String` in a repository that patches `String` got no return type
    // (the foreign-constant decline of docs/39), and one returning a constant reopened
    // across several files with no autoload home got none either.
    const hit = constNode(resolveRubyConstant(e.name, e.nesting, e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn"));
    const target = hit ? rubyFqnOf(hit.id) : null;
    if (!target) continue;
    // A return type inferred through ActiveRecord's finder vocabulary — `def latest;
    // User.first; end` — is only true if `User` is a model. When it is not, the method
    // declares nothing this pass can use, which is the honest answer.
    if (e.rubyReturnsAssumesModel && !rubyModels.has(target)) continue;
    rubyReturns.set(e.rubyReturnsFor, { fqn: target, kind: e.rubyReturnsKind ?? "instance" });
  }

  // M3b: the association registry — every `has_many`/`belongs_to` that names its class
  // directly, keyed by the model it was declared on. Built so a `through:` can be
  // FOLLOWED rather than inflected: `has_many :people, through: :memberships, source:
  // :person` is a collection of whatever `Membership`'s `person` reflection says, and
  // when that declares `class_name: "User"` the plural's own implication — `Person` —
  // is a different model that happens to exist.
  const rubyAssoc = new Map<string, string>();
  for (const e of rawEdges) {
    if (e.relation !== "references" || !e.rubyAssocName || e.rubyAssocThrough || !e.name || !e.nesting) continue;
    const owner = rubyFqnOf(e.source);
    if (!owner) continue;
    const hit = constNode(resolveRubyConstant(e.name, e.nesting, e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn"));
    const target = hit ? rubyFqnOf(hit.id) : null;
    if (target) rubyAssoc.set(`${owner}#${e.rubyAssocName}`, target);
  }
  /** The class one of `names` is an association to, on `ownerFqn` or anything it
   * inherits or includes — a concern declaring `belongs_to :user` answers for every
   * model that includes it. */
  const lookupAssoc = (ownerFqn: string, names: readonly string[]): string | null => {
    for (const scope of rubyLinearize(ownerFqn, rubyHeritage).chain) {
      for (const n of names) {
        const hit = rubyAssoc.get(`${scope}#${n}`);
        if (hit) return hit;
      }
    }
    return null;
  };
  /**
   * The class a `through:` association really names, as an absolute constant path —
   * or `null` to decline, or the edge's own inflected fallback.
   *
   * The fallback is kept for exactly one case: a join model that is not in this repo.
   * Nothing there can declare a `class_name:` override this pass could have read, and
   * Rails' own default is then the inflection the macro already carries. When the join
   * model IS here, its declarations are the authority — a source reflection we cannot
   * find on it means Rails would raise, not that the guess is right.
   */
  const rubyThroughTarget = (e: RawEdge): string | null => {
    const owner = rubyFqnOf(e.source);
    const join = owner ? lookupAssoc(owner, [e.rubyAssocThrough!]) : null;
    if (!join) return e.name!;
    const followed = lookupAssoc(join, e.rubyAssocSourceNames ?? []);
    return followed === null ? null : `::${followed}`;
  };

  // classParents: class/interface name → its declared base-class names, from raw
  // `extends` edges (source id's own name → the base name). Used to walk up an
  // inheritance chain when a receiver's own type has no matching method.
  const classParents = new Map<string, string[]>();
  // Every `export … from '…'` in the repo, grouped by the module that wrote it, so a
  // barrel can be walked instead of guessed past. Built from the raw edges rather than
  // the resolved ones because the walk needs the SPECIFIER, which resolution consumes.
  const reexports = new Map<string, ReexportEntry[]>();
  for (const e of rawEdges) {
    if (e.relation !== "imports" || !e.name || !e.specifier) continue;
    const list = reexports.get(e.file);
    const entry = { name: e.name, exportedAs: e.exportedAs, specifier: e.specifier };
    if (list) list.push(entry);
    else reexports.set(e.file, [entry]);
  }

  for (const e of rawEdges) {
    if (e.relation !== "extends" || !e.name) continue;
    // The declaring class's own bare name — read from its node (keyed by n.name, set
    // once at mint time) rather than re-derived by slicing e.source, which breaks once
    // ids can carry a dedup ordinal (A3's `Cache~2`).
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classParents, ownName, e.name);
  }

  // classTraits: class name → trait names from raw `implements` edges in PHP files.
  // PHP models `use SomeTrait;` as implements; trait methods live on the trait owner,
  // not the using class, so resolveTypedMember walks these after the class lookup fails.
  const classTraits = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "implements" || !e.name || !e.file.endsWith(".php")) continue;
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classTraits, ownName, e.name);
  }

  /**
   * Who a Rails macro edge is really about: `[subject node id, its Ruby FQN, its file]`.
   *
   * Normally the class the macro is written in — one tuple. Inside an
   * `ActiveSupport::Concern`'s `included do`, one tuple per INCLUDER, because that is
   * where the declaration actually runs; the concern itself gets nothing, which is
   * the honest answer for a module that never executes it. A concern mixed into a
   * whole model layer would multiply one line into hundreds of edges, so past the cap
   * the output is none: the declaration is real, but the graph would stop being a
   * description and start being a hub.
   */
  const rubyMacroSubjects = (e: RawEdge): Array<[string, string | null, string]> => {
    if (!e.viaConcern) return [[e.source, e.rubyOwnerFqn ?? null, e.file]];
    const includers = rubyIncluders.get(e.source) ?? [];
    if (includers.length > RUBY_CONCERN_INCLUDER_CAP) return [];
    const out: Array<[string, string | null, string]> = [];
    for (const includer of includers) {
      const node = byId.get(includer);
      if (node) out.push([includer, rubyFqnOf(includer), node.path]);
    }
    return out;
  };

  // ---------------------------------------------------------------------------
  // M4: Rails view conventions. See `rails-views.ts` for the rules and the oracle
  // runs behind them; what lives here is the part that needs the whole node set.
  // ---------------------------------------------------------------------------

  // Every template that was actually INDEXED, keyed by its node id (= its path).
  // The node set and not the filesystem: a template excluded by an ignore rule or
  // an `--only-dir` has nothing to point at, and "the file is on disk" is not the
  // check that matters — "there is a node to name" is.
  const railsTemplates = new Set<string>();
  for (const n of nodes) if (n.kind === "file" && isTemplatePath(n.path)) railsTemplates.add(n.id);

  /**
   * Names a template may call on its own `self`, and the node each one means.
   *
   * A template's `self` is an `ActionView::Base`, a class no repo defines, so a bare
   * word in one is NOT the free-function call it is in a `.rb` file. Two declarations
   * make a name legitimately reachable — a module under `app/helpers/`, because
   * `include_all_helpers` mixes all of them into every view, and a controller's
   * `helper_method :current_user`. A name more than one of them defines is declined.
   */
  const railsViewHelpers = new Map<string, string[]>();
  const noteViewHelper = (name: string, id: string): void => {
    const at = railsViewHelpers.get(name);
    if (!at) railsViewHelpers.set(name, [id]);
    else if (!at.includes(id)) at.push(id);
  };
  if (zeitwerk && opts.railsIncludeAllHelpers !== false) {
    for (const n of nodes) {
      // `receiver === "class"` is a `def self.x` on the helper module: a view holds
      // an INSTANCE of the view context with the module mixed in, so it reaches the
      // module's instance methods and never its singleton ones.
      if (n.kind === "method" && n.receiver !== "class" && isViewHelperPath(n.path)) {
        noteViewHelper(n.name, n.id);
      }
    }
  }
  if (zeitwerk) {
    for (const e of rawEdges) {
      if (!e.railsHelperExport || !e.name || !e.rubyOwnerFqn) continue;
      // Against the DECLARING class, not the includers `rubyMacroSubjects` would
      // give. `helper_method :current_user` inside `Authenticatable` names
      // `Authenticatable#current_user`, and it names the same method however many
      // controllers include the concern — including none, which is the case where
      // going through the includers registered nothing at all.
      const hit = resolveRubyOwnerMethod(e.rubyOwnerFqn, e.name, e.file, rubyOwnerMethod, rubyDispatch);
      if (hit && hit !== "ambiguous") noteViewHelper(e.name, hit.id);
    }
  }

  // The two halves of the instance-variable contract, gathered from the carriers
  // extract.ts emitted for controllers and templates. Writers are keyed by the
  // CONTROLLER FILE rather than by class, because the pairing is by directory and a
  // controller reopened in two files would otherwise answer for only one of them.
  const railsIvarWriters = new Map<string, Map<string, Set<string>>>();
  const railsIvarReaders = new Map<string, Set<string>>();
  for (const e of rawEdges) {
    if (!e.railsIvar) continue;
    if (e.railsIvarWrite) {
      let byIvar = railsIvarWriters.get(e.file);
      if (!byIvar) railsIvarWriters.set(e.file, (byIvar = new Map()));
      const at = byIvar.get(e.railsIvar);
      if (at) at.add(e.source);
      else byIvar.set(e.railsIvar, new Set([e.source]));
    } else {
      const at = railsIvarReaders.get(e.file);
      if (at) at.add(e.railsIvar);
      else railsIvarReaders.set(e.file, new Set([e.railsIvar]));
    }
  }

  /**
   * Methods that render something themselves, so the naming convention is not ALSO
   * claimed for them.
   *
   * Rails reaches the convention only when the action produced no response at all,
   * and `update`'s `render :edit` is exactly that case: `update.html.erb` is never
   * rendered even when it exists. The marker is a `renders` carrier with no spec —
   * see `RawEdge.railsTemplateSpec` — because a render this pass CANNOT name is
   * still a render, and `render @document` is the shape where claiming the
   * conventional template would be most confidently wrong.
   */
  const railsExplicitRender = new Set<string>();
  for (const e of rawEdges) {
    if (e.relation === "renders" && !e.railsTemplateSpec) railsExplicitRender.add(e.source);
  }

  /** Controller files whose class declared a layout, so the `application` default is
   * not also claimed for them. */
  const railsDeclaredLayout = new Set<string>();
  for (const e of rawEdges) {
    if (e.relation === "renders" && e.railsTemplateKind === "layout") railsDeclaredLayout.add(e.source);
  }

  /** Directories some controller owns, as `<root>\0<prefix>` — what makes a
   * slash-less partial spec resolvable at all. See `partialTarget`. */
  const railsControllerPrefixes = new Set<string>();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const cv = controllerViews(n.path);
    if (cv) railsControllerPrefixes.add(`${cv.root}\0${cv.prefix}`);
  }

  /**
   * The file a `render`/`layout` spec names, or null when the convention cannot name
   * exactly one. Existence is checked by the caller, against the node set.
   */
  const railsRenderTarget = (from: string, spec: string, kind: "template" | "partial" | "layout"): string | null => {
    const root = viewRootFor(from);
    if (!root) return null;
    if (kind === "layout") return layoutTarget(root, spec);
    // A controller's own `controller_path` is the first prefix in its lookup chain,
    // so a slash-less spec written there resolves against it exactly.
    const ctrl = controllerViews(from);
    if (ctrl) {
      return kind === "template"
        ? templateTarget(root, spec, ctrl.prefix)
        : partialTarget(root, spec, ctrl.prefix);
    }
    // Written in a template: the fallback prefix is its own directory, and only when
    // that directory is some controller's — see `partialTarget` for the oracle run
    // that rules out the tempting "resolve it next door".
    const own = templatePrefix(root, from);
    const usable = own !== null && railsControllerPrefixes.has(`${root}\0${own}`) ? own : null;
    return kind === "template" ? templateTarget(root, spec, usable) : partialTarget(root, spec, usable);
  };

  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"], via?: string) => {
    const key = `${source}\0${relation}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, target, relation, confidence, ...(via ? { via } : {}) });
  };

  // A class node may survive a later constant assignment in the same static
  // index. Workflow targets cannot use that stale identity, nor a child of a
  // reassigned namespace, even if ordinary constant lookup finds the old node.
  const workflowShadowPaths = new Set([...rubyShadow, ...rubyWorkflowUncertainShadows]);
  const workflowShadowed = (fqn: string): boolean => {
    const parts = fqn.split("::");
    return parts.some((_, i) => workflowShadowPaths.has(parts.slice(0, i + 1).join("::")));
  };
  const workflowNamespaceChanged = (fqn: string): boolean =>
    workflowShadowed(fqn) || [...workflowShadowPaths].some(path => path.startsWith(`${fqn}::`));

  // An instance chain alone omits extended modules. Their included ancestors can
  // supply singleton methods, so workflow gates must inspect both lookup chains
  // before treating an absent override as proof that a framework entrypoint wins.
  const workflowScopesCache = new Map<string, readonly string[] | null>();
  const workflowScopes = (owner: string): readonly string[] | null => {
    if (workflowScopesCache.has(owner)) return workflowScopesCache.get(owner)!;
    const scopes = new Set<string>();
    const pending = [owner];
    while (pending.length) {
      const scope = pending.pop()!;
      if (scopes.has(scope)) continue;
      if (workflowShadowed(scope)) { workflowScopesCache.set(owner, null); return null; }
      if (scopes.size >= RUBY_ANCESTOR_CAP) { workflowScopesCache.set(owner, null); return null; }
      scopes.add(scope);
      const h = rubyHeritage.get(scope) ?? EMPTY_HERITAGE;
      pending.push(...h.prepends, ...h.includes, ...h.supers, ...h.extends);
      // M3 models a concern's class_methods module as a singleton lookup step.
      if (rubyModuleFqns.has(scope)) pending.push(`${scope}::ClassMethods`);
    }
    const result = [...scopes];
    workflowScopesCache.set(owner, result);
    return result;
  };

  // GoodJob 4.19.2 Concurrency installs enqueue/perform guards; its Labels
  // dependency prepends enqueue only to set labels and call super. Those hooks
  // can abort or retry, but preserve the ActiveJob perform target. Other versions
  // and local shadows have no such evidence. This exception belongs solely to
  // job entrypoint resolution, never Ruby super or general method dispatch.
  const jobMixinEvidence = (chain: readonly string[]): string | null => {
    let goodJob = false;
    for (const scope of chain) for (const mixin of rubyUnknownMixinNames.get(scope) ?? []) {
      if (!mixin.external || workflowShadowed(mixin.name)) return null;
      if (mixin.kind === "extend" && mixin.name === "ActiveSupport::Concern") continue;
      if (opts.goodJobVersion === "4.19.2" && mixin.kind === "include" &&
          (mixin.name === "GoodJob::ActiveJobExtensions::Concurrency" || mixin.name === "GoodJob::ActiveJobExtensions::Labels")) {
        // Concurrency's pinned contract also includes Labels and Concern. A local
        // replacement in either dependency invalidates that package evidence.
        if (["GoodJob::ActiveJobExtensions::Concurrency", "GoodJob::ActiveJobExtensions::Labels", "ActiveSupport::Concern"].some(workflowNamespaceChanged)) return null;
        goodJob = true;
        continue;
      }
      return null;
    }
    return goodJob ? "; GoodJob 4.19.2 concurrency/labels guards may abort or retry" : "";
  };

  const workflowMethod = (owner: string, name: string, file: string, want: RubyValueKind = "instance") =>
    resolveRubyOwnerMethod(owner, name, file, rubyOwnerMethod, rubyDispatch, want, true);
  // Reuse the ancestry index across call sites; scanning every class for every
  // bare word made inherited-hook discovery quadratic in a Rails application's
  // method count. Unknown mixins keep the corresponding receivers out entirely.
  const workflowReceivers = new Map<string, string[]>();
  for (const candidate of rubyFqn.keys()) {
    if (rubyModuleFqns.has(candidate) || workflowShadowed(candidate)) continue;
    const chain = rubyLinearize(candidate, rubyHeritage);
    const scopes = workflowScopes(candidate);
    if (chain.truncated || !scopes || scopes.some(scope => rubyUnknownMixins.has(scope))) continue;
    for (const owner of chain.chain) push(workflowReceivers, owner, candidate);
  }

  // A module's `super` depends on its includer, so its lexical ancestry cannot
  // answer. For class methods, continue after the defining owner in Ruby's
  // matching chain; unknown mixins may intercept and therefore stop resolution.
  const superTarget = (edge: RawEdge): string | null => {
    const owner = edge.rubyOwnerFqn;
    const method = byId.get(edge.source);
    if (!owner || !method || method.kind !== "method" || rubyModuleFqns.has(owner) || !method.receiver) return null;
    const scopes = workflowScopes(owner);
    if (!scopes || scopes.some(scope => rubyUnknownMixins.has(scope) || workflowShadowed(scope))) return null;
    const walk = method.receiver === "instance" ? rubyLinearize(owner, rubyHeritage) : null;
    const singleton = method.receiver === "class" ? rubySingletonChain(owner, rubyDispatch) : null;
    if (walk?.truncated || singleton?.truncated) return null;
    const steps: RubyLookupStep[] = walk ? walk.chain.map(scope => ({ scope, want: "instance" })) : singleton!.steps;
    const start = steps.findIndex(step => step.scope === owner && step.want === method.receiver);
    if (start < 0) return null;
    for (const step of steps.slice(start)) {
      if (rubyUnknownMixins.has(step.scope)) return null;
      if (step.scope === owner) continue;
      const candidates = (rubyOwnerMethod.get(`${step.scope}#${method.name}`) ?? []).filter(n => rubyNodeAnswers(n, step.want) && (!step.synthesizedOnly || n.origin === "synthesized"));
      if (candidates.length) return candidates.length === 1 ? candidates[0].id : null;
    }
    return null;
  };
  const superTargets = new Map<string, string>();
  for (const edge of rawEdges) if (edge.rubySuper) {
    const target = superTarget(edge);
    if (target) superTargets.set(edge.source, target);
  }
  const reachesBody = (entry: string, body: string): boolean => {
    const visited = new Set<string>();
    for (let cur: string | undefined = entry; cur && !visited.has(cur); cur = superTargets.get(cur)) {
      if (cur === body) return true;
      visited.add(cur);
    }
    return false;
  };

  // A keyword default is only one possible binding. Record explicit call-site
  // arguments separately so an override never inherits the default's class, and
  // forwarding retains the source declaration that justified each candidate.
  const bindingWriters = new Map<string, RawEdge[]>();
  const bindingParameters = new Map<string, RawEdge[]>();
  for (const edge of rawEdges) if (edge.rubyBinding) {
    push(bindingWriters, edge.rubyBinding.key, edge);
    if (edge.rubyBinding.parameter) push(bindingParameters, edge.source, edge);
  }
  const injectionOwnerSafe = (owner: string): boolean => {
    const scopes = workflowScopes(owner);
    return !!scopes && !rubyModuleFqns.has(owner) && scopes.every(scope =>
      !rubyUnknownMixins.has(scope) && !(rubyExternalSupers.get(scope) ?? []).some(name => !["Object", "::Object", "BasicObject", "::BasicObject"].includes(name)));
  };
  const constructionSafe = (owner: string, file: string): boolean => injectionOwnerSafe(owner) &&
    !workflowMethod(owner, "new", file, "class");
  const flowOwner = (edge: RawEdge): string | null => {
    if (edge.rubyRecvBase === "self") return edge.rubyOwnerFqn ?? null;
    if (!edge.rubyRecvConst) return null;
    const hit = constNode(resolveRubyConstant(edge.rubyRecvConst, edge.nesting ?? [], edge.file,
      rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn"));
    return hit ? rubyFqnOf(hit.id) : null;
  };
  const bindingCalls = new Map<string, RawEdge[]>();
  const factoryOwnersWithDescendants = new Set<string>();
  for (const owner of rubyHeritage.keys()) {
    for (const ancestor of rubyLinearize(owner, rubyHeritage).chain) if (ancestor !== owner) factoryOwnersWithDescendants.add(ancestor);
  }
  const eligibleConstruction = (edge: RawEdge, owner: string): boolean => constructionSafe(owner, edge.file) &&
    !(edge.rubyRecvBase === "self" && factoryOwnersWithDescendants.has(owner));
  const activeInjectionSource = (edge: RawEdge): boolean => {
    const source = byId.get(edge.source);
    if (source?.kind !== "method") return true;
    const fqn = rubyFqnOf(source.id);
    const owner = fqn?.slice(0, fqn.lastIndexOf("::"));
    if (!source.receiver || !owner) return false;
    const active = workflowMethod(owner, source.name, edge.file, source.receiver);
    return !!active && active !== "ambiguous" && active.id === source.id;
  };
  for (const edge of rawEdges) {
    if (edge.relation !== "calls" || edge.rubyArguments === undefined || !edge.rubyRecvBase || edge.rubyRecvSteps?.length) continue;
    if (!activeInjectionSource(edge)) continue;
    const owner = flowOwner(edge);
    if (!owner || !injectionOwnerSafe(owner)) continue;
    const constructing = edge.name === "new" && edge.rubyRecvKind === "class";
    const target = workflowMethod(owner, constructing ? "initialize" : edge.name!, edge.file,
      constructing ? "instance" : edge.rubyRecvKind);
    if (target && target !== "ambiguous" && bindingParameters.has(target.id)) {
      // A rejected constructor still counts as an unknown incoming call. Dropping
      // it entirely would revive an initializer default through the empty-set
      // fallback, bypassing the same constructor that blocked the factory edge.
      push(bindingCalls, target.id, (constructing || edge.rubyConstructed) && !eligibleConstruction(edge, owner)
        ? { ...edge, rubyArguments: null } : edge);
    }
  }
  type InjectionCandidate = { owner: string; proof: string[] };
  const bindingCache = new Map<string, InjectionCandidate[]>();
  const indexedRubyMethodNames = new Set([...rubyOwnerMethod.keys()].map(key => key.slice(key.lastIndexOf("#") + 1)));
  const bindingCandidates = (key: string, seen = new Set<string>()): InjectionCandidate[] => {
    if (seen.has(key) || seen.size >= 16) return [];
    if (bindingCache.has(key)) return bindingCache.get(key)!;
    const writers = bindingWriters.get(key) ?? [];
    // Even two agreeing writers are not a single injection declaration. A later
    // mutation or a writer in a reopened class must withdraw this inference.
    if (writers.length !== 1) return [];
    const writer = writers[0];
    if (!writer.rubyOwnerFqn || !injectionOwnerSafe(writer.rubyOwnerFqn)) return [];
    if (!activeInjectionSource(writer)) return [];
    const binding = writer.rubyBinding!;
    const name = key.split("|").at(-1)!;
    // attr_writer/accessor synthesize a writer without an assignment AST. Its
    // presence makes the injected slot mutable just like a second written def.
    if (name.startsWith("@") && workflowMethod(writer.rubyOwnerFqn, `${name.slice(1)}=`, writer.file,
      key.includes("%class|") ? "class" : "instance")) return [];
    const next = new Set(seen).add(key);
    const evaluate = (value: typeof binding.value): InjectionCandidate[] => {
      if (!value) return [];
      if ("binding" in value) return bindingCandidates(value.binding, next);
      const hit = constNode(resolveRubyConstant(value.constant, value.nesting, value.file,
        rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true, "fqn"));
      const owner = hit ? rubyFqnOf(hit.id) : null;
      return owner && constructionSafe(owner, value.file) ? [{ owner, proof: [`${value.file}: ${value.constant}.new`] }] : [];
    };
    let candidates: InjectionCandidate[] = [];
    if (binding.parameter) {
      const calls = bindingCalls.get(writer.source) ?? [];
      if (!calls.length) candidates = evaluate(binding.value).map(c => ({ ...c, proof: [...c.proof, `${writer.source} ${binding.parameter}: default`] }));
      for (const call of calls) {
        if (call.rubyArguments === null) continue;
        const explicit = Object.hasOwn(call.rubyArguments!, binding.parameter);
        const value = explicit ? call.rubyArguments![binding.parameter] : binding.value;
        candidates.push(...evaluate(value).map(c => ({ ...c, proof: [...c.proof,
          `${writer.source} ${binding.parameter}: ${explicit ? `argument from ${call.source}` : `default at ${call.source}`}`] })));
      }
    } else candidates = evaluate(binding.value).map(c => ({ ...c, proof: [...c.proof, `${writer.source} binds ${key.split("|").at(-1)}`] }));
    // One complete source proof per candidate type is enough to justify the
    // conditional edge. Keeping every equivalent caller path multiplies the
    // output at each forwarding hop without proving any additional target.
    candidates.sort((a, b) => a.proof.join("; ").localeCompare(b.proof.join("; ")));
    const unique = [...new Map(candidates.map(c => [c.owner, c])).values()];
    if (unique.length <= 16) bindingCache.set(key, unique);
    return unique.length <= 16 ? unique : [];
  };

  for (const e of rawEdges) {
    if (e.rubyReceiverBinding) {
      if (!e.rubyOwnerFqn || !injectionOwnerSafe(e.rubyOwnerFqn) || !activeInjectionSource(e)) continue;
      if (e.rubyBlockSteps?.some(step => indexedRubyMethodNames.has(step))) continue;
      const candidates = new Map<string, string[]>();
      for (const candidate of bindingCandidates(e.rubyReceiverBinding)) {
        const target = workflowMethod(candidate.owner, e.name!, e.file, "instance");
        if (target && target !== "ambiguous" && target.id !== e.source) push(candidates, target.id, candidate.proof.join("; "));
      }
      for (const [target, proofs] of candidates) add(e.source, target, "dispatches", "ruby_injection",
        `Ruby conditional injection ${e.rubyReceiverBinding.split("|").at(-1)}: ${proofs.sort()[0]}${e.rubyBlockSteps?.length
          ? `; conditional block self: ${e.rubyBlockArrayEvidence?.join("; ")}; Array#map${e.rubyBlockSteps.includes("first") ? " after Array#first(count)" : ""} preserves lexical self if that contract holds` : ""}`);
      continue;
    }
    if (e.rubyConstructed) {
      const owner = flowOwner(e);
      // `new` inside an inherited class method uses the dynamic subclass. Its
      // constructor or instance entrypoint may differ; the lexical class alone
      // cannot justify an exclusive call when known descendants exist.
      if (!owner || !eligibleConstruction(e, owner)) continue;
    }
    if (e.rubySuper) {
      const target = superTargets.get(e.source);
      if (target) add(e.source, target, "calls", "type_bound", "Ruby super: next implementation after the defining owner");
      continue;
    }
    if (e.rubyMailbox) {
      if (workflowShadowed("ActionMailbox::Base")) continue;
      const owner = e.rubyOwnerFqn;
      if (!owner || workflowShadowed(owner) || !rubyMailboxes.has(owner)) continue;
      const ancestry = rubyLinearize(owner, rubyHeritage);
      const scopes = workflowScopes(owner);
      if (ancestry.truncated || !scopes || scopes.some(scope => rubyUnknownMixins.has(scope))) continue;
      if (workflowMethod(owner, e.rubyMailbox, e.file, "class")) continue;
      const candidates = e.rubyMailbox === "routing" ? [e.name!] : [...rubyMailboxes].filter(candidate => rubyLinearize(candidate, rubyHeritage).chain.includes(owner));
      for (const targetOwner of candidates) {
        if (workflowShadowed(targetOwner) || !rubyMailboxes.has(targetOwner) || (rubyFqn.get(targetOwner)?.length ?? 0) !== 1) continue;
        const identity = resolveRubyConstant(`::${targetOwner}`, [], e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true);
        if (!identity || identity === "stopped" || rubyFqnOf(identity.id) !== targetOwner) continue;
        const chain = rubyLinearize(targetOwner, rubyHeritage);
        const targetScopes = workflowScopes(targetOwner);
        if (chain.truncated || !targetScopes || targetScopes.some(scope => rubyUnknownMixins.has(scope))) continue;
        const method = e.rubyMailbox === "routing" ? "process" : e.name!;
        const hit = workflowMethod(targetOwner, method, e.file);
        if (hit && hit !== "ambiguous") {
          add(e.source, hit.id, "dispatches", "convention", `ActionMailbox.${e.rubyMailbox}: conditional receiver ${targetOwner}#${method}`);
          if (e.rubyMailbox !== "routing") {
            const process = workflowMethod(targetOwner, "process", e.file);
            if (process && process !== "ambiguous" && process.id !== hit.id) add(process.id, hit.id, "dispatches", "convention",
              `ActionMailbox processing lifecycle: ${e.rubyMailbox} for receiver ${targetOwner}; declared at ${e.source}`);
          }
        }
      }
      continue;
    }
    // A type carrier states a fact for the pre-passes above and is not a
    // dependency the source file contains. See `RawEdge.rubyTypeOnly`.
    if (e.rubyTypeOnly) continue;
    // The same, for M4's instance-variable carriers: `@documents` is not a symbol
    // anywhere in this graph, and the only thing it can connect is a controller
    // method to a template — which the pass after this loop does, once both halves
    // have been gathered. See `RawEdge.railsIvar`.
    if (e.railsIvar) continue;
    if (e.relation === "contains" && e.targetId) {
      add(e.source, e.targetId, "contains", "extracted");
    } else if (e.relation === "imports" && e.specifier) {
      const target =
        hasGoModules && e.file.endsWith(".go")
          ? resolveGoImport(e.specifier, opts.goModules!, goFilesByDir)
          : e.file.endsWith(".java")
            ? resolveJavaImport(e.specifier, javaFilesBySuffix)
            : C_EXT.test(e.file)
              ? resolveCInclude(e.specifier, e.file, byId, cFilesBySuffix)
              : e.file.endsWith(".rs")
                ? resolveRustUse(e.specifier, e.file, byId, rustCrateRoots)
                : e.file.endsWith(".php")
                  ? resolvePhpUse(e.specifier, phpFilesBySuffix)
                  : resolveImport(e.specifier, e.file, byId, workspacePackages);
      add(e.source, target, "imports", "extracted");
    } else if (e.relation === "extends" || e.relation === "implements") {
      // `implements` also resolves to a `trait` — PHP models trait composition
      // (`use SomeTrait;`) as an implements edge, and a trait is a valid target.
      // "module" reaches `extends` resolution from two unrelated sources: Ruby's
      // Phase 4 include/extend/prepend mixin edges (which SHOULD match a
      // module) and Swift's own extension-body nodes (which must NOT — an
      // extension is deliberately kept out of type-declaration kinds so it can
      // never be mistaken for the real class it extends; see SWIFT_TYPE_KINDS's
      // doc comment in extract.ts). Gate the widening to Ruby files only, so a
      // same-named Swift extension can't shadow the real class declaration.
      const kinds: Kind[] =
        e.relation === "implements"
          ? ["interface", "trait"]
          : e.file.endsWith(".rb")
            ? ["class", "interface", "module"]
            : ["class", "interface"];
      // Ruby heritage goes through the constant resolver first: `class C < D::E`
      // and `include Auth::Helper` name a constant path, which the bare-name
      // ladder below could never match, and even a bare `include TenantSecurity`
      // means the one Ruby's nesting picks rather than the one that happens to be
      // globally unique. It declines rather than guesses, and then M0's own
      // resolution runs unchanged — so nothing this cannot answer regresses.
      const constHit = e.nesting
        ? resolveRubyConstant(e.name!, e.nesting, e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true)
        : null;
      // A search that STOPPED found the name and could not turn it into a node. The
      // bare-name ladder below would then answer with a different constant entirely —
      // measured: `include Actual` inside a `Scope` that assigns its own `Actual`
      // acquired an `extends` edge to the unrelated top-level module. Emit nothing.
      if (constHit === "stopped") continue;
      const hit = constHit ?? resolveName(e.name!, e.file, kinds, perFileName, globalName);
      // an unresolved base is usually an external/imported type — keep the name.
      add(e.source, hit?.id ?? e.name!, e.relation, hit?.confidence ?? "inferred");
    } else if (e.relation === "references" && e.name) {
      if (e.specifier) {
        // A named import gives both halves needed for sound resolution: the module
        // it came from and the exported name. Resolve inside that file only, so a
        // same-named symbol elsewhere in the repo cannot become a false edge.
        const targetFile = e.file.endsWith(".php")
          ? resolvePhpUse(e.specifier, phpFilesBySuffix)
          : resolveImport(e.specifier, e.file, byId, workspacePackages);
        if (!byId.has(targetFile)) continue; // external or unresolved module
        const candidates = perFileName.get(targetFile)?.get(e.name) ?? [];
        if (candidates.length === 1) {
          add(e.source, candidates[0].id, "references", "extracted");
        } else if (candidates.length === 0) {
          // The module is ours and does not define the name — a barrel. Walk its
          // re-exports rather than dropping, which is what made a design system's
          // whole component layer unreachable through its own index.
          const hit = resolveThroughReexports(targetFile, e.name, reexports, byId, perFileName, null, workspacePackages);
          if (hit && hit !== "ambiguous") add(e.source, hit.id, "references", "extracted");
        }
      } else if (e.nesting) {
        // Ruby (M1). The presence of a nesting chain is the switch, so this path
        // is provably unreachable for every other language and for any graph built
        // before the field existed. Unresolved constants — gems, stdlib, anything
        // outside the repo, which is most of what a Rails file names — drop
        // entirely rather than keeping the bare name the way heritage does: a
        // `references` target that is not a node id would put `ActiveRecord::Base`
        // into the graph as a phantom, and `graph-quality --strict` counts
        // dangling endpoints for exactly that reason.
        const constRef = e.rubyAssocThrough ? rubyThroughTarget(e) : e.name;
        if (constRef === null) continue;
        const hit = constNode(resolveRubyConstant(constRef, e.nesting, e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true));
        if (!hit) {
          // `Session::INTERNAL_GATEWAY` names a VALUE, and a value is not a node, so
          // the whole path resolved to nothing and the class that declares it — the
          // one thing this line depends on — went with it. One reference, to the
          // declaring class, is the honest answer; the head-plus-terminal rule above
          // exists to stop a second answer being bolted onto a right one, and here
          // there is no first answer to bolt it onto.
          const owner = e.rubyAssocThrough ? null : rubyValueConstantOwner(constRef, e);
          if (owner && owner.id !== e.source)
            add(e.source, owner.id, "references", owner.confidence, `value constant ${constRef.replace(/^::/, "")}`);
          continue;
        }
        if (hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
        // An association declared inside an `included do` is also each INCLUDER's —
        // `belongs_to :user` in `Owned` gives `Post` that association. Callbacks
        // declared there were already re-attributed; leaving associations behind made
        // a documented behaviour half-true.
        //
        // Unlike a callback, the concern KEEPS its own edge here. A callback names a
        // method the concern does not own, so attributing it to the concern is simply
        // wrong; a constant reference is a fact about the concern's own source text,
        // which stays true however many classes include it. It also has to stay true
        // past the includer cap: `Tenancy::Scoped` is included by 148 models, and
        // re-attribution alone would have turned one correct edge into none.
        if (e.viaConcern) {
          for (const [subject] of rubyMacroSubjects(e)) {
            if (hit.id !== subject) add(subject, hit.id, "references", hit.confidence);
          }
        }
      } else if (e.recvType && RB_EXT.test(e.file)) {
        // M2: `validates :email` names an ATTRIBUTE of this class, not a constant —
        // owner-qualified, so it resolves exactly like a member call and declines
        // the same way. Most of these find nothing, because a plain database column
        // has no node anywhere; that is the correct answer, not a gap.
        for (const [subject, ownerFqn, subjFile] of rubyMacroSubjects(e)) {
          const hit = ownerFqn
            ? resolveRubyOwnerMethod(ownerFqn, e.name, subjFile, rubyOwnerMethod, rubyDispatch)
            : resolveTypedMember(e.recvType, e.name, subjFile, ownerMethod, classParents, classTraits);
          if (hit && hit !== "ambiguous" && hit.id !== subject) add(subject, hit.id, "references", hit.confidence);
        }
      } else if (e.file.endsWith(".php") && byId.get(e.source)?.origin === "ast") {
        // PHP attribute without a `use` import (same-file or globally unique class).
        const refKinds: Kind[] = ["class", "interface", "trait", "enum"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      } else if (e.file.endsWith(".java") && byId.get(e.source)?.origin === "ast") {
        // Java annotation without a specifier (same-file or globally unique
        // `@interface`). Annotation types are `interface` kind — a class of the
        // same name is not a match, so `@Entity` cannot collapse onto an in-repo
        // `class Entity` (#103). Kind alone still cannot tell `@interface Service`
        // from `interface Service`, so only accept a candidate whose header
        // contains the literal `@interface` (`includes`, not `startsWith`: a
        // meta-annotated type is `@Documented @Retention(...) public @interface
        // JsonAdapter`). Unresolved targets keep the bare name, matching
        // heritage, rather than dropping the way PHP attributes do.
        const refKinds: Kind[] = ["interface"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        const anno = hit ? byId.get(hit.id) : undefined;
        if (hit && hit.id !== e.source && anno?.signature?.includes("@interface"))
          add(e.source, hit.id, "references", hit.confidence);
        else add(e.source, e.name, "references", "inferred");
      } else if (JS_EXT.test(e.file) && byId.get(e.source)?.origin === "ast") {
        // T4: a TypeScript type position naming a type THIS FILE declares. The extract
        // walk emits it without a specifier precisely because there is no module to
        // name — the declaration is right here.
        //
        // Same-file and unique, and nothing more. `resolveName` would be the obvious
        // call and it is the wrong one: its second tier answers with a repo-wide
        // unique name, which is how a Go builtin once resolved into a TypeScript test.
        // A type a file neither imports nor declares is not that file's to resolve, so
        // the correct output is no edge. Uniqueness is not a formality either —
        // interface merging makes `interface Merged` twice in one file emit two nodes,
        // and picking either is a guess.
        //
        // `extracted`, matching the PHP-attribute and Java-annotation arms above,
        // which resolve the same way: a file's own unambiguous declaration is not an
        // inference. The self-target check keeps a recursive type (`interface Tree {
        // kids: Tree[] }`) from becoming a self-loop.
        //
        // T8 widened this arm to value positions, and they do NOT share a kind list:
        // a `type_identifier` landing on a same-named `function` would be a wrong
        // answer in the one place this project cares most about. The value branch
        // states its own `kinds`; a type reference carries none and keeps this list.
        const refKinds: Kind[] = e.kinds ?? ["interface", "type", "class", "enum"];
        const local = (perFileName.get(e.file)?.get(e.name) ?? []).filter((n) =>
          refKinds.includes(n.kind),
        );
        if (local.length === 1 && local[0].id !== e.source)
          add(e.source, local[0].id, "references", "extracted");
      } else if (byId.get(e.source)?.origin === "generic") {
        // Breadth tier: a bare-name structural reference (extends / implements /
        // object-creation / module alias) the grammar marked but cannot type. Resolve
        // to a type-like definition, drop-rather-than-guess, never a self-loop. Gated on
        // generic origin so depth-tier references (which always carry a specifier) are
        // provably untouched.
        const refKinds: Kind[] = ["class", "interface", "struct", "enum", "type", "module"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      }
    } else if (e.relation === "renders") {
      // M4: a template the source NAMES — `render "shared/nav"`, `render :edit`,
      // `layout "admin"`. `extracted`, not `convention`: the spec is written down,
      // and all the convention supplied was the directory to look in.
      if (!e.railsTemplateSpec || !e.railsTemplateKind) continue;
      const target = railsRenderTarget(e.file, e.railsTemplateSpec, e.railsTemplateKind);
      // No such template was indexed → no edge. This is the whole discipline: a
      // convention that names a file which is not there has not found anything.
      if (target && railsTemplates.has(target)) add(e.source, target, "renders", "extracted");
    } else if (e.relation === "calls") {
      if (e.rubyJob) {
        if (workflowShadowed("ActiveJob::Base")) continue;
        const constant = resolveRubyConstant(e.rubyRecvConst!, e.nesting ?? [], e.file, rubyFqn, rubyHeritage, rubyShadow, zeitwerk, true);
        const owner = constant && constant !== "stopped" ? rubyFqnOf(constant.id) : null;
        if (!owner || workflowShadowed(owner)) continue;
        if (!rubyJobs.has(owner)) {
          const direct = resolveRubyTypedCall(e, rubyOwnerMethod, rubyDispatch, rubyReturns, rubyModels, rubyFqn, rubyShadow, zeitwerk);
          if (!e.rubyJobConfigured && direct && direct !== "ambiguous") add(e.source, direct.id, "calls", "type_bound");
          continue;
        }
        const chain = rubyLinearize(owner, rubyHeritage);
        const scopes = workflowScopes(owner);
        const mixinEvidence = scopes ? jobMixinEvidence(scopes) : null;
        if (chain.truncated || mixinEvidence === null) continue;
        const override = workflowMethod(owner, e.rubyJob, e.file, "class");
        if (e.rubyJobConfigured && workflowMethod(owner, "set", e.file, "class")) continue;
        if (override) {
          if (override !== "ambiguous" && !e.rubyJobConfigured) add(e.source, override.id, "calls", "type_bound");
          continue;
        }
        // Queued execution also invokes instance perform_now. An override there
        // can replace perform entirely, even when class perform_later is inherited.
        if (workflowMethod(owner, "perform_now", e.file, "instance")) continue;
        if (e.rubyJob === "perform_later" && workflowMethod(owner, "enqueue", e.file, "instance")) continue;
        const hit = workflowMethod(owner, "perform", e.file, "instance");
        if (hit && hit !== "ambiguous") add(e.source, hit.id, e.rubyJob === "perform_later" ? "enqueues" : "dispatches", "convention",
          `ActiveJob.${e.rubyJobConfigured ? "set(...)." : ""}${e.rubyJob}: ${owner}#perform${e.rubyJob === "perform_later" ? " may execute asynchronously after enqueue callbacks" : " may execute through callbacks"}${mixinEvidence}`);
        continue;
      }
      if (e.rubyRecvBase === "self" && e.rubyOwnerFqn && !e.rubyRecvSteps?.length && byId.get(e.source)?.kind === "method") {
        const owner = e.rubyOwnerFqn;
        const source = byId.get(e.source)!;
        if (!rubyModuleFqns.has(owner) && source.receiver && e.rubyRecvKind === source.receiver) {
          const targets = new Map<string, string[]>();
          for (const candidate of workflowReceivers.get(owner) ?? []) {
            const entry = workflowMethod(candidate, source.name, e.file, source.receiver);
            if (!entry || entry === "ambiguous" || !reachesBody(entry.id, source.id)) continue;
            const hit = workflowMethod(candidate, e.name!, e.file, source.receiver);
            if (hit && hit !== "ambiguous") push(targets, hit.id, candidate);
          }
          const lexical = workflowMethod(owner, e.name!, e.file, source.receiver);
          if (targets.size > 1 || (targets.size === 1 && (!lexical || lexical === "ambiguous" || !targets.has(lexical.id)))) {
            for (const [target, receivers] of targets) if (target !== e.source) add(e.source, target, "dispatches", "ruby_dispatch",
              `Ruby self.${e.name}: possible receiver ${receivers.join(", ")} (known receivers only)`);
            continue;
          }
        }
      }
      if (e.rubyRecvBase) {
        // M3: the receiver's type is known, so the method is looked up on that
        // class and its own Ruby ancestors — never by name across the repo.
        const hit = resolveRubyTypedCall(e, rubyOwnerMethod, rubyDispatch, rubyReturns, rubyModels, rubyFqn, rubyShadow, zeitwerk);
        if (hit === "ambiguous") continue; // several owners, none decidable — drop
        if (hit) {
          if (hit.id !== e.source) add(e.source, hit.id, "calls", "type_bound");
          continue;
        }
        // Nothing anywhere on the chain. A receiverless word may still be a
        // top-level method, so it falls through to the bare-name ladder below;
        // anything with an explicit receiver stops here, because "this class has
        // no such method" is an answer, not an invitation to guess.
        if (!e.implicitSelf) continue;
      }
      // `rubyRecvBase` excluded deliberately: an M3 call edge carries
      // `rubyOwnerFqn` too, and without this it would re-enter the macro path and
      // run the same owner-qualified lookup that just failed — swallowing the
      // bare-name fallback an `implicitSelf` edge is entitled to.
      if (!e.rubyRecvBase && (e.viaConcern || e.rubyOwnerFqn)) {
        // A Rails macro states its receiver exactly — the class it is written in, or,
        // inside an `ActiveSupport::Concern`'s `included do`, each class that INCLUDES
        // the concern. Either way the subject is a known class node, so this resolves
        // by full constant path rather than by the bare class name every language
        // shares. `before_save :stamp_audit` binds to `User#stamp_audit` in one
        // includer and to nothing at all in another that never defines it, and both
        // of those are the right answer for that class.
        for (const [subject, ownerFqn, subjFile] of rubyMacroSubjects(e)) {
          const hit = ownerFqn
            ? resolveRubyOwnerMethod(ownerFqn, e.name!, subjFile, rubyOwnerMethod, rubyDispatch)
            : resolveTypedMember(e.recvType!, e.name!, subjFile, ownerMethod, classParents, classTraits, e.argCount);
          if (hit && hit !== "ambiguous" && hit.id !== subject) add(subject, hit.id, "calls", hit.confidence);
        }
        continue;
      }
      if (e.viaMember) {
        if (!e.recvType) continue;
        const hit = resolveTypedMember(e.recvType, e.name!, e.file, ownerMethod, classParents, classTraits, e.argCount);
        if (hit === "ambiguous") continue; // drop — never guess past an ambiguous owner
        if (hit) {
          add(e.source, hit.id, "calls", hit.confidence);
          continue;
        }
        // No owner-qualified match means the call is unresolved. A unique bare
        // method name is not evidence that this receiver has that method — a
        // name-fallback here was measured to HALVE call-edge precision (73%→37%
        // vs a compiler-grade oracle) for a 3x count inflation, i.e. noise. See #35.
        //
        // One carve-out, which is NOT that fallback: a Swift `implicitSelf` edge
        // carries two readings of one bare call — member (tried above, in
        // Swift's own inner-scope-first order) and free function. Zero members
        // on the whole owner chain means the call was a free-function call after
        // all, so it falls through to bare-name resolution; an ambiguous member
        // set has already dropped it above, and a resolved member never reaches
        // here — a name defined as both member and free function yields the
        // member edge alone, exactly as Swift dispatches it.
        if (!e.implicitSelf) continue;
      }
      // M4: a bare word in a TEMPLATE is not a free-function call.
      //
      // A template's `self` is an `ActionView::Base`, a class no repo defines, so
      // the repo-wide bare-name ladder below has nothing legitimate to find and a
      // great deal to find by accident — filewerk's 45 Ruby top-level `def`s
      // include `url_for`, `root_path`, `name` and `metadata`, and 44 of them are in
      // `spec/`. What a view CAN reach is what a declaration says it can: a module
      // under `app/helpers/`, or a name a controller exported with `helper_method`.
      // Two definitions of a name means two possible owners, and that declines.
      //
      // A `def` written inside the template itself is tried first and is exact —
      // same file, no ambiguity to have.
      if (containerLangOf(e.file)?.layout === "interleaved") {
        const own = (perFileName.get(e.file)?.get(e.name!) ?? []).filter((n) => n.kind === "function");
        if (own.length === 1) add(e.source, own[0].id, "calls", "extracted");
        else {
          const helpers = railsViewHelpers.get(e.name!) ?? [];
          if (helpers.length === 1 && helpers[0] !== e.source) add(e.source, helpers[0], "calls", "convention");
        }
        continue;
      }
      // Every language's bare-name call is a free function, except R (Phase 4):
      // an untyped `obj$method()` there sets e.kinds to also allow a "method"
      // match — see extract.ts's calleeName R branch for why (R6 methods are
      // never kind "function", so without this every such call would be
      // unconditionally unresolvable rather than just occasionally ambiguous).
      // Three cases, because "a bare call" means something different per tier:
      //
      //  - generic (breadth tier): tags.scm captures ALL calls as bare names, since it
      //    cannot type a receiver. In method-heavy languages those target methods, so
      //    widen to methods — ONLY here, leaving depth-tier precision untouched (an
      //    ambiguous function-vs-method name still drops).
      //  - Java (depth tier): an implicit-`this` call is spelled as a member call in
      //    extract.ts, so the only bare call reaching here is `new Foo()`, whose target
      //    is a TYPE. Against the function index every constructor edge would drop.
      //  - everything else: functions, exactly as before.
      //
      // R (depth tier, Phase 4) sets `e.kinds` itself for an untyped `obj$method()`
      // (see above), and that explicit choice wins over the per-tier default.
      const srcOrigin = byId.get(e.source)?.origin;
      const callKinds: Kind[] =
        e.kinds ??
        (srcOrigin === "generic"
          ? ["function", "method"]
          : e.file.endsWith(".java")
            ? ["class", "struct", "enum", "interface"]
            : ["function"]);
      // A call through a named import (TypeScript, extract.ts) names its module.
      // An external or unresolved module means the callee is not in this repo:
      // drop the edge rather than let the unique-name fallback bind it to an
      // unrelated same-named local function (a test mock, a helper named
      // `expect`) and report it as a production dependency (#330). An in-repo
      // module that defines the name resolves to that definition alone; one
      // that does not (a barrel re-export) keeps the name-based fallback.
      if (e.specifier) {
        const targetFile = resolveImport(e.specifier, e.file, byId, workspacePackages);
        if (!byId.has(targetFile)) continue;
        const inModule = (perFileName.get(targetFile)?.get(e.name!) ?? []).filter((n) =>
          callKinds.includes(n.kind),
        );
        if (inModule.length === 1) {
          add(e.source, inModule[0].id, "calls", "extracted");
          continue;
        }
        if (inModule.length > 1) continue;
        // The module is ours and does not define the name: a barrel. #335 comments
        // above that this case "keeps the name-based fallback", and that fallback is
        // precisely what bound a production component to a same-named one in a
        // DIFFERENT application. Walk the re-exports first — every hop is read from
        // source — and only fall through when the barrel genuinely does not offer it.
        const viaBarrel = resolveThroughReexports(targetFile, e.name!, reexports, byId, perFileName, callKinds, workspacePackages);
        if (viaBarrel === "ambiguous") continue; // never guess past an ambiguous barrel
        if (viaBarrel) {
          add(e.source, viaBarrel.id, "calls", "extracted");
          continue;
        }
      }
      let hit = resolveName(e.name!, e.file, callKinds, perFileName, globalName);
      // Python is the Java case without the `new` to mark it: `Widget()` is an
      // ordinary call node, so a constructor edge dies against the function-only
      // index. Java can widen to types outright; Python has free functions, so
      // widening would trade real function edges for type ones. Hence a fallback,
      // not a swap — types are tried only once functions have found nothing, and
      // resolveName's same-file-then-unique-global rule still drops the ambiguous.
      if (!hit && PY_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, PY_CTOR_KINDS, perFileName, globalName);
      }
      if (!hit && SWIFT_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, SWIFT_CTOR_KINDS, perFileName, globalName);
      }
      if (hit) add(e.source, hit.id, "calls", hit.confidence); // drop unresolved calls (too noisy)
    }
  }

  // ---------------------------------------------------------------------------
  // M4: the edges nothing in either file writes down.
  // ---------------------------------------------------------------------------

  // Gated on Rails detection, exactly as the macro vocabulary is: `app/controllers`
  // and `app/views` are directory names, and a plain Ruby project that happens to
  // use them must come out of this pass untouched.
  //
  // A controller action renders the template that shares its name. Emitted for an
  // action DEFINED in that controller — an inherited one renders the subclass's
  // template through a prefix chain this pass does not walk, and answering it from
  // the base class's own directory would be a different file.
  for (const n of zeitwerk ? nodes : []) {
    if (n.kind !== "method" || n.receiver === "class") continue;
    const cv = controllerViews(n.path);
    if (!cv) continue;
    // An action that renders something EXPLICITLY has told us what it renders, and
    // Rails then never reaches the convention at all. `update` answering
    // `render :edit` must not also claim an `update.html.erb` that happens to exist.
    if (railsExplicitRender.has(n.id)) continue;
    const target = templatePath(cv.root, cv.prefix, n.name);
    if (railsTemplates.has(target)) add(n.id, target, "renders", "convention");
  }

  // `ApplicationController` with no `layout` of its own gets Rails' default. Only
  // that one class, deliberately: a layout is inherited, so `App::DocumentsController
  // < App::BaseController` uses the `layout "app"` its parent declares, and claiming
  // `application` for it would be wrong. From the root class the chain is followable
  // through the `extends` edges already in the graph.
  for (const n of zeitwerk ? nodes : []) {
    if (n.kind !== "class" || n.name !== "ApplicationController") continue;
    if (railsDeclaredLayout.has(n.id)) continue;
    const root = viewRootFor(n.path);
    if (!root) continue;
    const target = templatePath(root, "layouts", DEFAULT_LAYOUT);
    if (railsTemplates.has(target)) add(n.id, target, "renders", "convention");
  }

  // The instance-variable contract: `@documents` assigned in exactly one method of
  // the controller that owns this template's directory, and read in the template.
  //
  // Uniqueness is what makes it precise, and it is doing real work rather than
  // guarding a corner: `@document` is written by `show`, `edit` AND `update` in one
  // controller, so "which of them does `edit.html.erb` mean?" has no answer and the
  // pair is dropped. Measured on filewerk: 58 pairs resolve, 28 decline as ambiguous.
  for (const [template, ivars] of railsIvarReaders) {
    if (!railsTemplates.has(template)) continue;
    const root = viewRootFor(template);
    const prefix = root ? templatePrefix(root, template) : null;
    if (root === null || prefix === null) continue;
    const controller = controllerFileFor(root, prefix);
    const writers = controller ? railsIvarWriters.get(controller) : undefined;
    if (!writers) continue;
    for (const ivar of ivars) {
      const who = writers.get(ivar);
      if (!who || who.size !== 1) continue;
      const [only] = who;
      if (only !== template) add(only, template, "references", "convention");
    }
  }

  return out;
}

/** Ruby source, for the constant index. `.rbi`/`.rbs` are signature files with no
 * bodies and no autoload home, so they are deliberately not constants' definitions. */
const RB_EXT = /\.rb$/i;

/** How many ancestors the step-2 walk may examine before it gives up.
 *
 * A cap on the TOTAL, not on the depth: a Rails model with a dozen concerns is
 * three levels deep and wide, and cutting it off by depth stopped the search in the
 * middle of a chain that had further to run. Hitting this cap makes the whole lookup
 * decline (see `ancestorPrefixes`), so the number only has to be comfortably larger
 * than any real chain — 64 is roughly four times the widest model in the two
 * evaluation apps — while still bounding a pathological graph. */
const RUBY_ANCESTOR_CAP = 64;

/** How many includers one `included do` declaration may be re-attributed across.
 * A concern mixed into an entire model layer would otherwise turn a single line into
 * hundreds of edges and make the concern a false hub — the exact shape
 * `relations.ts` excludes `contains` to avoid. Past this, emit nothing. */
const RUBY_CONCERN_INCLUDER_CAP = 50;

/**
 * The fully-qualified Ruby constant a class/module node defines, read off its id.
 *
 * `app/models/current.rb#TenantSecurity.CrossTenantAccessError` →
 * `TenantSecurity::CrossTenantAccessError`. The dedup ordinal `mintId` appends is
 * stripped, because `class Foo` reopened later in the same file is ONE constant
 * with two nodes, not two constants — see `pickRubyConstant`, which relies on that.
 */
function rubyFqnOf(id: string): string | null {
  const hash = id.indexOf("#");
  if (hash === -1) return null; // a file node defines no constant of its own
  return id
    .slice(hash + 1)
    .split(".")
    .map((seg) => seg.replace(/~\d+$/, ""))
    .join("::");
}

/**
 * Constants the repository cannot own, because something outside it already does.
 *
 * Ruby lets any file reopen any constant, and extraction cannot tell `class String`
 * adding one method from `class Workspace` defining a model — both mint a node. When
 * the real constant lives outside the repository that reopening becomes the ONLY node
 * with the name, and `pickRubyConstant`'s single-candidate branch below then hands it
 * to every reference to the real thing.
 *
 * Measured on dailywerk at `3fabcfa1`: `config/initializers/string_truncate_bytes.rb`
 * reopened `String` to add `truncate_bytes` and collected **76 references from 56
 * files**, every sampled one an `is_a?(String)` type check — while the four files that
 * actually call `.truncate_bytes` got nothing at all, because a method call on a
 * receiver is not a constant reference. The dependency was reported exactly backwards:
 * ask what depends on that initializer and every answer was wrong and every right
 * answer was missing. `test/test_helper.rb` reopened `ActiveSupport` to reach
 * `ActiveSupport::TestCase` and collected three more, all from production initializers
 * calling `ActiveSupport.on_load` — production code reported as depending on the test
 * helper, which is exactly how the TypeScript half of this defect announced itself.
 *
 * **These are lists of facts, and that is deliberate.** A repository cannot define
 * Ruby's `String`, and a Rails application does not define `ActiveSupport`. Inferring
 * it from file paths instead was measured first and was worse: "the file is neither
 * the autoload home nor named for the constant" removed 96 edges rather than 79, and
 * 17 of the extra were correct — `db/seeds/support.rb` really does define
 * `StructuredSeeds`, and no path rule can know that. A list that is short, closed and
 * checkable beats a rule that is general and wrong.
 */
const RUBY_CORE_CONSTANTS: ReadonlySet<string> = new Set([
  "BasicObject", "Object", "Module", "Class", "Kernel", "Comparable", "Enumerable",
  "NilClass", "TrueClass", "FalseClass", "Numeric", "Integer", "Float", "Rational",
  "Complex", "String", "Symbol", "Array", "Hash", "Range", "Struct", "Data", "Set",
  "Proc", "Method", "UnboundMethod", "Binding", "Enumerator", "Encoding",
  "Exception", "StandardError", "RuntimeError", "ArgumentError", "TypeError",
  "NameError", "NoMethodError", "IndexError", "KeyError", "StopIteration",
  "FrozenError", "IOError", "EOFError", "SystemExit", "Interrupt", "SignalException",
  "Regexp", "MatchData", "Time", "File", "IO", "Dir", "Thread", "Fiber", "Mutex",
  "Queue", "ObjectSpace", "GC", "Math", "Process", "Signal", "Marshal", "Random",
]);

/** Gated on Rails detection, like everything else that assumes a framework. */
const RAILS_FRAMEWORK_CONSTANTS: ReadonlySet<string> = new Set([
  "Rails", "ActiveSupport", "ActiveRecord", "ActiveModel", "ActiveJob",
  "ActiveStorage", "ActionController", "ActionView", "ActionMailer", "ActionMailbox",
  "ActionCable", "ActionDispatch", "ActionText", "ActionPack", "Minitest", "Rack",
  "Mime", "Arel",
]);

/**
 * Is this lone node a REOPENING of a constant the repository does not own?
 *
 * Two exemptions, both for the case where a repository really does define a top-level
 * constant of that name and is entitled to. Zeitwerk's autoload map is the authority
 * in a Rails app: `app/models/set.rb` declaring `Set` is that application's `Set`,
 * shadowing the stdlib deliberately, and Ruby agrees. Outside Rails there is no
 * autoloader to ask, so the file naming convention every Ruby project follows stands
 * in — `lib/set.rb` is allowed to be about `Set`, and
 * `config/initializers/string_truncate_bytes.rb` is not about `String`.
 *
 * Only the single-candidate branch consults this. Two files reopening one foreign
 * constant already reach the ambiguity path below and decline for their own reason.
 */
function reopensForeignConstant(
  fqn: string,
  node: NodeV1,
  zeitwerk: ZeitwerkMap | null,
): boolean {
  if (fqn.includes("::")) return false;
  if (!RUBY_CORE_CONSTANTS.has(fqn) && !(zeitwerk && RAILS_FRAMEWORK_CONSTANTS.has(fqn)))
    return false;
  if (zeitwerk && isAutoloadHome(zeitwerk, node.path, fqn)) return false;
  const base = node.path.replace(/\.rb$/, "").split("/").pop() ?? "";
  return camelize(base, zeitwerk?.acronyms ?? new Map()).toLowerCase() !== fqn.toLowerCase();
}

/**
 * Choose among the nodes defining one fully-qualified constant.
 *
 * Returns `"ambiguous"` rather than a guess when several files define it and
 * nothing can adjudicate — and the caller must then STOP rather than try a
 * shallower prefix, because Ruby would have found the constant at this level too.
 * Continuing would answer a different question than the one the source asks.
 */
function pickRubyConstant(
  candidates: NodeV1[] | undefined,
  file: string,
  fqn: string,
  zeitwerk: ZeitwerkMap | null,
  want: "node" | "fqn" = "node",
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) {
    const c = candidates[0];
    // A file that reopens a foreign constant is not that constant's definition, and one
    // node is exactly the case that used to sail through here unchallenged. Scoped to
    // `want === "node"`, which is the mode that puts an EDGE on the answer; the
    // FQN-keyed lookups are asking whether a constant PATH exists so a receiver can be
    // typed, and `String#truncate_bytes` is still a real method on a real receiver.
    // Same-file references are kept and stay `extracted` — there the source genuinely
    // is talking about this declaration.
    if (want === "node" && c.path !== file && reopensForeignConstant(fqn, c, zeitwerk))
      return null;
    return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
  }
  // The autoload map goes FIRST, and the order is the whole fix. Zeitwerk names one
  // file as the definition of a constant; every other file that writes `class Intake`
  // is opening a namespace to nest something in it. Asking the same-file question
  // before the map meant a two-line wrapper outranked the 240-line model sitting in
  // `app/models/intake.rb` — so `Intake::Webhook < Intake`, plain Rails STI, answered
  // "what do I inherit from" with a stub, and `TurnProvenance.from_metadata` pointed
  // at a file that does not define `from_metadata`. 21 edges on dailywerk at
  // `3fabcfa1`, 18 `references` and 3 `extends`, and none of them a close call.
  //
  // A home in THIS file still reports `extracted`: the two branches agree there, and
  // the confidence describes how the name was matched, not which branch matched it.
  if (zeitwerk) {
    const homed = candidates.filter((c) => isAutoloadHome(zeitwerk, c.path, fqn));
    if (homed.length === 1)
      return { id: homed[0].id, confidence: homed[0].path === file ? "extracted" : "inferred" };
  }
  // Several nodes in THIS file are one reopened constant, not a choice — unlike
  // `resolveName`'s same-file branch, which requires uniqueness because there a
  // second node means a genuinely different symbol (`Alpha.Builder` vs
  // `Beta.Builder`). Here the ids agree on the whole constant path, so document
  // order is a deterministic pointer at a real part of the same thing. This is also
  // where a file that is its own home but reopens the constant twice lands, because
  // both nodes are then homed and the map declines to choose between them.
  const sameFile = candidates.filter((c) => c.path === file);
  if (sameFile.length > 0) return { id: sameFile[0].id, confidence: "extracted" };
  // A caller that only wants the CONSTANT PATH is not choosing between these at
  // all: this index is keyed by fully-qualified name, so every candidate answers
  // that question with the same string. `module Tenancy` in `lib/tenancy.rb` and
  // the `module Tenancy` that `app/models/concerns/tenancy/scoped.rb` opens are
  // one reopened constant in Ruby, and a receiver typed as `Tenancy` then finds
  // `Tenancy.cross_workspace` in the FQN-keyed method index wherever it was
  // written. Declining here cost 144 edges on dailywerk that the source states
  // outright. Pointing an `references` EDGE at one of them is a different
  // question, and that one still declines.
  if (want === "fqn") return { id: candidates[0].id, confidence: "inferred" };
  return "ambiguous";
}

/**
 * Resolve a Ruby constant reference the way Ruby resolves it.
 *
 *   1. `Module.nesting`, innermost first.
 *   2. The innermost cref's ancestors — prepends, then the class, then includes,
 *      then the superclass chain.
 *   3. Top level.
 *
 * `::X` skips straight to step 3, which is what the programmer wrote it for.
 *
 * **The HEAD decides, and then it commits.** For `A::B::C`, Ruby resolves `A` by
 * steps 1–3 and then looks for `B` inside whatever that turned out to be — it never
 * reconsiders an outer `A`. Trying the whole dotted path at each level instead reads
 * as a harmless shortcut and is not: with `module A; class B < Base; end; end`, where
 * `Base` defines `X`, and an unrelated top-level `B::X`, `B::X` written inside `A` is
 * `Base::X` in Ruby and was the unrelated one here. That is valid, running code, not
 * the NameError case the shortcut was justified by. So the head is resolved first and
 * the tail is looked up strictly within it (and its ancestors — which is how the
 * inherited `X` is found), declining when the tail is not there.
 *
 * The one place the whole path is still tried at every level is when the head names
 * nothing in the graph at all: `class Billing::Invoice` in compact form defines no
 * `Billing` node for Zeitwerk's implicit namespace, so there is no commit point to
 * honour and the flat scan is the only evidence available.
 */
function resolveRubyConstant(
  ref: string,
  nesting: readonly string[],
  file: string,
  fqnIndex: Map<string, NodeV1[]>,
  heritage: ReadonlyMap<string, RubyHeritage>,
  shadow: ReadonlySet<string>,
  zeitwerk: ZeitwerkMap | null,
  useAncestors: boolean,
  want: "node" | "fqn" = "node",
): RubyConstHit {
  const absolute = ref.startsWith("::");
  const bare = absolute ? ref.slice(2) : ref;
  const segments = bare.split("::");
  // Ruby's own order, so a constant that two ancestors both declare resolves to the
  // one Ruby would reach. The cref itself is already `nesting[0]`, so it is dropped
  // here: `Module.nesting` is searched in full BEFORE any ancestor.
  const lin = absolute || !useAncestors ? { chain: [], truncated: false } : rubyLinearize(nesting[0], heritage);
  const anc = { prefixes: lin.chain.filter((x) => x !== nesting[0]), truncated: lin.truncated };
  // A walk that ran out of budget did not prove the constant is absent from the
  // chain, so it may not fall through to the top level and answer a different
  // question. Decline instead — the whole point of step 2 is that step 3 is only
  // correct once step 2 has been exhausted.
  if (anc.truncated) return "stopped";
  const prefixes = absolute ? [""] : [...nesting, ...anc.prefixes, ""];

  /** One lookup at one fully-qualified name, honouring shadowing declarations. */
  const at = (fqn: string): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null => {
    const hit = pickRubyConstant(fqnIndex.get(fqn), file, fqn, zeitwerk, want);
    if (hit) return hit;
    // `X = 123` here means Ruby's search ends here. There is no node to name, so
    // the honest answer is no edge — never the outer constant Ruby would not reach.
    return shadow.has(fqn) ? "ambiguous" : null;
  };
  /** Does anything at all declare this constant? Deliberately weaker than `at`.
   *
   * A namespace on the way to the target does not have to be pinned to ONE node,
   * only to exist: `module App` is reopened by every controller file in a Rails
   * app, and asking `at` to choose between twenty of them reports "ambiguous" for
   * what is a single reopened constant. Requiring that here cost `App::BaseController`
   * every one of its compact-form subclasses — the tail was never even reached. The
   * terminal segment is still resolved through `at`, because that is the one an edge
   * actually points at. */
  const declares = (fqn: string): boolean => fqnIndex.has(fqn) || shadow.has(fqn);

  for (const prefix of prefixes) {
    const headFqn = prefix ? `${prefix}::${segments[0]}` : segments[0];
    if (segments.length === 1) {
      const head = at(headFqn);
      // Found here, but undecidable. Ruby's search ENDS at the first scope that
      // declares the name, so there is nothing further to try — and the caller must
      // not read this as "absent" and fall through to a bare-name match, which is how
      // `include Actual` inside `Scope`, shadowed by `Scope::Actual = Module.new`,
      // acquired an `extends` edge to the unrelated top-level `Actual`.
      if (head === "ambiguous") return "stopped";
      if (head) return head;
      continue;
    }
    if (!declares(headFqn)) continue;
    return resolveRubyQualified(headFqn, segments.slice(1), at, declares, heritage);
  }

  // The head names nothing in the graph — an implicit Zeitwerk namespace, a gem, or
  // stdlib. Fall back to the flat scan, which at least matches a compact-form
  // definition (`class Billing::Invoice`) that contributes no node for its own head.
  if (segments.length === 1) return null;
  for (const prefix of prefixes) {
    const fqn = prefix ? `${prefix}::${bare}` : bare;
    const hit = at(fqn);
    if (hit === "ambiguous") return "stopped";
    if (hit) return hit;
  }
  return null;
}

/**
 * What a Ruby constant lookup can answer, and why the third value exists.
 *
 * `null` means "nothing in this repo declares it" — a gem, stdlib, an implicit
 * Zeitwerk namespace — and a caller may reasonably fall back to something weaker.
 * `"stopped"` means Ruby's search ENDED here without producing a node: the name is
 * declared at this scope but by an assignment with no definition of its own, or by
 * two files this cannot choose between, or the ancestor walk ran out of budget
 * before it could prove absence. Falling back after `"stopped"` answers a different
 * question than the one the source asked.
 */
type RubyConstHit = { id: string; confidence: EdgeV1["confidence"] } | "stopped" | null;

/** The node behind a constant hit, or null for "no usable answer" — collapsing the
 * two negative cases where the caller genuinely treats them alike. */
function constNode(hit: RubyConstHit): { id: string; confidence: EdgeV1["confidence"] } | null {
  return hit && hit !== "stopped" ? hit : null;
}

/**
 * The tail of a qualified reference, resolved strictly inside the namespace its head
 * resolved to. Each segment is looked for in that namespace and then in its ancestors
 * — `A::B::X` finds an `X` that `B`'s superclass defines — and never at top level:
 * Ruby 2.5 removed the toplevel fallback for qualified names.
 *
 * The whole remaining path is tried before descending one segment, so an intermediate
 * namespace that exists only implicitly (`class A::B::C` in compact form mints no
 * `A::B` node) still resolves.
 */
function resolveRubyQualified(
  headFqn: string,
  tail: readonly string[],
  at: (fqn: string) => { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null,
  declares: (fqn: string) => boolean,
  heritage: ReadonlyMap<string, RubyHeritage>,
): RubyConstHit {
  let cur = headFqn;
  for (let i = 0; i < tail.length; i++) {
    const walk = rubyLinearize(cur, heritage);
    if (walk.truncated) return "stopped";
    const scopes = walk.chain;
    const rest = tail.slice(i).join("::");
    for (const scope of scopes) {
      const whole = at(`${scope}::${rest}`);
      if (whole === "ambiguous") return "stopped";
      if (whole) return whole;
    }
    // Not the terminal, so existence is enough — same reason as `declares`.
    const next = scopes.map((s) => `${s}::${tail[i]}`).find(declares);
    if (!next) return "stopped"; // Ruby raises NameError here; the graph declines
    cur = next;
  }
  return null;
}

/**
 * A Ruby class's declared heritage, kept split by keyword because the three do
 * different things and M3 merged them into one list.
 *
 * `prepend` inserts ABOVE the class — `Service.new.ping` reaches a prepended
 * `Override#ping`, not `Service#ping` — so a lookup that starts at the owner and
 * then walks its ancestors has the order exactly backwards for it. `extend`
 * composes the SINGLETON class and never appears in `cref.ancestors` at all: it
 * supplies class methods, not instance methods.
 */
interface RubyHeritage {
  prepends: string[];
  includes: string[];
  supers: string[];
  extends: string[];
}

const EMPTY_HERITAGE: RubyHeritage = { prepends: [], includes: [], supers: [], extends: [] };

/** The names a Rails app's models ultimately descend from. `ActiveRecord::Base`
 * lives in a gem and never has a node here, so the chain is recognized by the
 * unresolved NAME at its end. */
const AR_BASE_NAMES: ReadonlySet<string> = new Set(["ApplicationRecord", "ActiveRecord::Base", "::ActiveRecord::Base"]);

/**
 * `ActiveSupport::CurrentAttributes`, whose subclasses forward EVERY class-level
 * call to their singleton instance.
 *
 * Not a guess: `CurrentAttributes` defines `method_missing` to `instance.public_send`,
 * so `Current.system_admin?` reaches `def system_admin?` — verified on ActiveSupport
 * 8.1, including for a method no `attribute` declared. It is the one place in Rails
 * where the class object answers the instance chain, and `Current.*` is among the
 * most-called receivers in a Rails app: 28 answers in filewerk's corpus alone.
 */
const AS_CURRENT_ATTRIBUTES_NAMES: ReadonlySet<string> = new Set([
  "ActiveSupport::CurrentAttributes",
  "::ActiveSupport::CurrentAttributes",
]);

/**
 * Every class whose superclass chain reaches one of `baseNames`.
 *
 * For models, the gate on reading `User.first` as "one User": outside it, `first` is
 * whatever the class itself defines — `SomeService.create(...)` is the commonest PORO
 * shape in a Rails app, and M3 typed its result as a `SomeService` on the strength of
 * the name alone.
 *
 * A fixpoint rather than a walk, because `class User < ApplicationRecord` is seen
 * before `class ApplicationRecord < ActiveRecord::Base` as often as not.
 */
function collectRubyDescendants(
  heritage: ReadonlyMap<string, RubyHeritage>,
  superNames: ReadonlyMap<string, string[]>,
  baseNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const models = new Set<string>();
  for (const [fqn, names] of superNames) {
    if (names.some((n) => baseNames.has(n))) models.add(fqn);
  }
  // Bounded: each round must add at least one class or it stops, so the worst case
  // is one round per class in the graph.
  for (let round = 0; round < RUBY_ANCESTOR_CAP; round++) {
    let grew = false;
    for (const [fqn, h] of heritage) {
      if (models.has(fqn)) continue;
      if (h.supers.some((p) => models.has(p))) { models.add(fqn); grew = true; }
    }
    if (!grew) break;
  }
  return models;
}

/**
 * `Klass.ancestors`, nearest first, INCLUDING the class itself — Ruby's own
 * linearization, not a breadth-first approximation of it.
 *
 * The difference is not academic. With `Host` including `Sibling` and then `Near`,
 * and `Near` including `Deep`, Ruby answers `[Host, Near, Deep, Sibling]` and
 * dispatches a method both `Deep` and `Sibling` define to `Deep`. A breadth-first
 * walk visits `Sibling` before `Deep` and answers `Sibling` — a wrong edge that
 * looks right, because both targets exist and both are plausible.
 *
 * Depth-first, prepends before the class and includes after it, each expanded in
 * place. The `seen` set keeps the FIRST occurrence exactly as Ruby does when a
 * module appears twice in a hierarchy.
 *
 * `truncated` says the cap stopped the walk with ancestors still unexamined. A
 * caller must treat that as "unknown", not as "absent" — see `resolveRubyConstant`.
 */
function rubyLinearize(
  cref: string | undefined,
  heritage: ReadonlyMap<string, RubyHeritage>,
): { chain: string[]; truncated: boolean } {
  if (!cref) return { chain: [], truncated: false };
  const chain: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const expand = (fqn: string, depth: number): void => {
    if (truncated || seen.has(fqn)) return;
    if (chain.length >= RUBY_ANCESTOR_CAP || depth > RUBY_ANCESTOR_CAP) { truncated = true; return; }
    const h = heritage.get(fqn) ?? EMPTY_HERITAGE;
    for (const p of h.prepends) expand(p, depth + 1);
    if (seen.has(fqn)) return; // a prepend chain that loops back onto the class itself
    seen.add(fqn);
    chain.push(fqn);
    for (const m of h.includes) expand(m, depth + 1);
    for (const sup of h.supers) expand(sup, depth + 1);
  };
  expand(cref, 0);
  return { chain, truncated };
}

/** Everything a Ruby method lookup needs about the repo's class structure. Bundled
 * because the two facts always travel together and a positional pair of maps at each
 * of a dozen call sites is how they get passed in the wrong order. */
interface RubyDispatch {
  heritage: ReadonlyMap<string, RubyHeritage>;
  /** Classes whose class-level calls fall through to their singleton INSTANCE, so a
   * `Klass.method` there searches the instance chain too. `ActiveSupport::CurrentAttributes`
   * subclasses, and nothing else. */
  delegatesToInstance: ReadonlySet<string>;
  /** Which FQNs are `module`s rather than classes. A concern's own `ClassMethods` is
   * in its class-method chain — `class_methods do` siblings call each other, and
   * `requiring_sync` calling `pending` is that shape — but a plain class's would be a
   * phantom, so the step is offered only to modules. */
  modules: ReadonlySet<string>;
}

/** One place a method lookup looks, and what kind of definition counts there. */
interface RubyLookupStep {
  scope: string;
  /** `"class"` accepts `def self.x`; `"instance"` accepts `def x`. A node with no
   * `receiver` field at all — an older graph, a `def obj.x`, a macro that really
   * does define both — matches either. */
  want: RubySelfKind;
  /** Only a MACRO-declared definition counts at this step. The distinction a
   * concern turns on: `scope :pending, -> {…}` inside an `included do` becomes a
   * class method on every INCLUDER, while a hand-written `def self.helper` in the
   * same module does not (`include M` never puts `M.helper` on the includer, and
   * Ruby raises NoMethodError for it). Both are `receiver: "class"` owned by the
   * module; only `origin` tells them apart. */
  synthesizedOnly?: boolean;
}

/** The modules mixed into `fqn`, transitively — `prepend` and `include` only,
 * never the superclass. The list a concern's `ClassMethods` are reached through. */
function rubyMixinChain(fqn: string, heritage: ReadonlyMap<string, RubyHeritage>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([fqn]);
  const expand = (cur: string, depth: number): void => {
    if (depth > RUBY_ANCESTOR_CAP || out.length >= RUBY_ANCESTOR_CAP) return;
    const h = heritage.get(cur) ?? EMPTY_HERITAGE;
    for (const m of [...h.prepends, ...h.includes]) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
      expand(m, depth + 1);
    }
  };
  expand(fqn, 0);
  return out;
}

/**
 * Where Ruby looks for `Klass.method` — the SINGLETON class's ancestry, which
 * shares nothing with the instance one.
 *
 * Three sources, per class in the SUPERCLASS chain, in Ruby's order:
 *   - the class's own `def self.x` (and `class << self`),
 *   - the instance methods of every module it `extend`s,
 *   - the `ClassMethods` module of every concern it includes, which is what
 *     `class_methods do … end` compiles to and what a hand-written
 *     `module ClassMethods` inside an `ActiveSupport::Concern` already is.
 *
 * Then the same again on the superclass: class methods ARE inherited, which is why
 * `Child.fire` reaches `Parent.fire` even when `Child` defines an instance `fire`
 * (verified on Ruby 3.4).
 *
 * Two things deliberately absent. A module's own `def self.helper` is not offered
 * to includers — `include M` does not put `M.helper` on the includer, and Ruby
 * raises NoMethodError for it. And an included module's INSTANCE methods are not
 * here either: that is the other chain, and conflating the two is what made
 * `Svc.dispatch` answer with the `include`d module when Ruby answers with the
 * `extend`ed one.
 */
function rubySingletonChain(
  cref: string,
  dispatch: RubyDispatch,
): { steps: RubyLookupStep[]; truncated: boolean } {
  const heritage = dispatch.heritage;
  const steps: RubyLookupStep[] = [];
  const seen = new Set<string>();
  const pushStep = (scope: string, want: RubySelfKind, synthesizedOnly = false): void => {
    const key = `${scope}|${want}|${synthesizedOnly}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ scope, want, ...(synthesizedOnly ? { synthesizedOnly: true } : {}) });
  };
  // The superclass chain only — `include`d modules contribute class methods solely
  // through their `ClassMethods`, handled inside the loop.
  const klasses: string[] = [];
  const visited = new Set<string>();
  let cur: string | undefined = cref;
  while (cur && !visited.has(cur) && klasses.length < RUBY_ANCESTOR_CAP) {
    visited.add(cur);
    klasses.push(cur);
    cur = (heritage.get(cur) ?? EMPTY_HERITAGE).supers[0];
  }
  if (cur && !visited.has(cur)) return { steps, truncated: true };
  for (const klass of klasses) {
    if (steps.length >= RUBY_ANCESTOR_CAP) return { steps, truncated: true };
    pushStep(klass, "class");
    // A concern's own `ClassMethods`, so its `class_methods do` methods can call each
    // other — which Ruby allows, because inside one `self` is the includer class and
    // the whole module is extended into it. Modules only: on a plain class the same
    // step would invent a `Foo::ClassMethods` nothing extends.
    if (dispatch.modules.has(klass)) pushStep(`${klass}::ClassMethods`, "instance");
    const h = heritage.get(klass) ?? EMPTY_HERITAGE;
    for (const mod of h.extends) {
      pushStep(mod, "instance");
      for (const m of rubyMixinChain(mod, heritage)) pushStep(m, "instance");
    }
    for (const mixin of rubyMixinChain(klass, heritage)) {
      pushStep(`${mixin}::ClassMethods`, "instance");
      // …and the macros the concern declared in its `included do`, which run in the
      // includer and so define ITS class methods. Restricted to synthesized nodes so
      // the module's own `def self.x` stays where Ruby leaves it: out of reach.
      pushStep(mixin, "class", true);
    }
    // `ActiveSupport::CurrentAttributes` forwards anything its singleton class does
    // not answer to `instance`, so the instance chain is genuinely reachable from
    // `Current.` — the one Rails construct where the two chains meet. Appended
    // LAST, after everything a real class method could answer, because that is the
    // order `method_missing` runs in.
    if (dispatch.delegatesToInstance.has(klass)) {
      for (const m of rubyLinearize(klass, heritage).chain) pushStep(m, "instance");
    }
  }
  return { steps, truncated: false };
}

/** Does this definition answer a call made on `want`? An absent `receiver` is
 * "unknown", never "instance": graphs built before the field exists carry none,
 * and so does a macro that genuinely defines both halves. */
function rubyNodeAnswers(n: NodeV1, want: RubySelfKind): boolean {
  return n.receiver === undefined || n.receiver === want;
}

/**
 * A method on a Ruby class named by its FULL constant path, looked up the way Ruby
 * dispatches it — on the instance ancestry or the singleton one, never both.
 *
 * The generic `resolveTypedMember` keys on a bare class name, which is right for
 * languages where that is all a receiver expression yields. It is not right for a
 * Rails macro: `before_save :stamp` inside `A::User` states its receiver exactly, and
 * bare-name keying let that bind to a `stamp` defined on an unrelated `B::User`.
 *
 * `want` is what the CALLER holds, and it decides the chain:
 *   - `instance` — prepends, the class, its includes, its superclass. Instance
 *     methods only.
 *   - `class` — `def self.`, `extend`ed modules, concerns' `ClassMethods`, then the
 *     superclass's singleton chain.
 *   - `collection` — an ActiveRecord CollectionProxy. Verified against a running
 *     ActiveRecord 8.1: `blog.posts.publish_all` reaches `Post.publish_all` and
 *     `blog.posts.recent` reaches the scope, while `blog.posts.publish` raises
 *     NoMethodError for the instance method. So: the singleton chain, exactly.
 *
 * Ambiguity declines. Two files defining the same method on the same fully-qualified
 * class is a real choice this cannot make.
 */
function resolveRubyOwnerMethod(
  ownerFqn: string,
  name: string,
  file: string,
  index: Map<string, NodeV1[]>,
  dispatch: RubyDispatch,
  want: RubyValueKind = "instance",
  strict = false,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const instanceSteps = (): RubyLookupStep[] | null => {
    const walk = rubyLinearize(ownerFqn, dispatch.heritage);
    return walk.truncated ? null : walk.chain.map((scope) => ({ scope, want: "instance" as const }));
  };
  const classSteps = (): RubyLookupStep[] | null => {
    const walk = rubySingletonChain(ownerFqn, dispatch);
    return walk.truncated ? null : walk.steps;
  };
  let steps: RubyLookupStep[] | null;
  if (want === "instance") steps = instanceSteps();
  else if (want === "unknown") {
    // A bare call inside a block whose `self` nothing names. Both chains are live
    // possibilities, so both are searched — class first, since a block in a class
    // body is a class-level DSL more often than not. This is the one `want` that
    // widens rather than narrowing, and it exists because the alternative is to
    // guess which of two readings a `test "…" do` block has.
    const a = classSteps();
    const b = instanceSteps();
    steps = a === null || b === null ? null : [...a, ...b];
  } else steps = classSteps();
  if (steps === null) return null;
  for (const step of steps) {
    const all = index.get(`${step.scope}#${name}`);
    if (!all || all.length === 0) continue;
    const cands = all.filter((c) => rubyNodeAnswers(c, step.want) && (!step.synthesizedOnly || c.origin === "synthesized"));
    if (cands.length === 0) continue;
    if (strict && cands.length > 1) return "ambiguous";
    const sameFile = cands.filter((c) => c.path === file);
    // `type_bound` either way (M3). Both readings came from a KNOWN receiver
    // class, and the same-file/cross-file split that separates `extracted` from
    // `inferred` elsewhere describes how a NAME was matched — a distinction that
    // says nothing here, where the owner was never in doubt. Labelling them
    // separately is the point: it is how `graph-quality` can say how much of the
    // graph the type table produced.
    if (sameFile.length === 1) return { id: sameFile[0].id, confidence: "type_bound" };
    if (cands.length === 1) return { id: cands[0].id, confidence: "type_bound" };
    return "ambiguous";
  }
  return null;
}

/**
 * A Ruby call whose receiver type M3 established, resolved on that class.
 *
 * Three moves, and each one declines rather than widening:
 *
 *   1. The base — the enclosing class named exactly (`self`, a receiverless word,
 *      a callback), or a constant resolved by M1 against the nesting chain it was
 *      written in.
 *   2. Each reader step — `user.subscriptions.active` walks `subscriptions` first.
 *      A step resolves like any other member call, and then must have a DECLARED
 *      return type (`rubyReturns`) for the walk to continue. A hand-written method
 *      has none, so the chain stops there and the call resolves to nothing; that
 *      is the correct answer, not a gap, because the alternative is to look
 *      `active` up on `User` — a different class than the one the code names.
 *   3. The call itself, owner-qualified on whatever the walk arrived at.
 *
 * A fourth thing travels alongside all three: WHAT the receiver is. A class object,
 * an instance and an ActiveRecord collection name the same class and answer disjoint
 * sets of methods, and each step can change which one you hold — `Blog.new` is an
 * instance, `.posts` is a collection, `.first` is an instance again. `resolveRubyOwnerMethod`
 * takes it as `want` and walks the matching chain.
 *
 * `"ambiguous"` propagates out of a step: two classes could own it and picking one
 * is exactly the guess this milestone removes.
 */
function resolveRubyTypedCall(
  e: RawEdge,
  ownerIndex: Map<string, NodeV1[]>,
  dispatch: RubyDispatch,
  returns: ReadonlyMap<string, RubyType>,
  models: ReadonlySet<string>,
  fqnIndex: Map<string, NodeV1[]>,
  shadow: ReadonlySet<string>,
  zeitwerk: ZeitwerkMap | null,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  let cur: string | null;
  if (e.rubyRecvBase === "self") {
    cur = e.rubyOwnerFqn ?? null;
  } else {
    if (!e.rubyRecvConst) return null;
    // `"fqn"`: this lookup wants the receiver's CONSTANT PATH, not a node to point
    // an edge at, and several files opening one constant do not disagree about
    // that. See `pickRubyConstant`.
    const hit = constNode(resolveRubyConstant(e.rubyRecvConst, e.nesting ?? [], e.file, fqnIndex, dispatch.heritage, shadow, zeitwerk, true, "fqn"));
    cur = hit ? rubyFqnOf(hit.id) : null;
  }
  if (!cur) return null; // the receiver names a gem, stdlib, or nothing in the repo
  // Older graphs carry no kind. "instance" is what M3 assumed everywhere, so reading
  // an absent field that way keeps them resolving exactly as they did.
  let kind: RubyValueKind = e.rubyRecvKind ?? "instance";

  if (e.rubyRecvFinder) {
    // The receiver was typed off ActiveRecord's finder vocabulary (`Widget.first`).
    // Ruby would reach the class's OWN class method of that name first, so try that
    // and use whatever it declares; only when the class defines none is AR's reading
    // available, and only if the class really is a model.
    const own = resolveRubyOwnerMethod(cur, e.rubyRecvFinder, e.file, ownerIndex, dispatch, "class");
    if (own === "ambiguous") return "ambiguous";
    if (own) {
      const declared = returns.get(own.id);
      if (!declared) return null; // it exists, and says nothing about what it returns
      cur = declared.fqn;
      kind = declared.kind;
    } else if (!models.has(cur)) {
      return null; // not a model, and no such class method: `first` means something else
    }
  }

  for (const step of e.rubyRecvSteps ?? []) {
    const hop = resolveRubyOwnerMethod(cur, step, e.file, ownerIndex, dispatch, kind);
    if (hop === "ambiguous") return "ambiguous";
    if (!hop) return null;
    const next = returns.get(hop.id);
    if (!next) return null; // the step exists but does not declare what it returns
    cur = next.fqn;
    kind = next.kind;
  }
  return resolveRubyOwnerMethod(cur, e.name!, e.file, ownerIndex, dispatch, kind);
}

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/** Derive a method's owner from its dotted id when extract did not stamp `owner`
 * (PHP trait/interface methods today). `app.php#Loggable.log` → `Loggable`. */
function ownerFromMethodId(id: string): string | undefined {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  return segs.length >= 2 ? segs[segs.length - 2] : undefined;
}

/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */

interface ReexportEntry {
  name: string;
  exportedAs?: string;
  specifier: string;
}

/** How many `export … from` hops to follow before giving up. A design-system barrel is
 * two or three deep in practice; this is generous and bounds a pathological chain. */
const MAX_REEXPORT_HOPS = 8;

/**
 * Follow `export … from '…'` out of a module that does not define `name` itself.
 *
 * Specifier-confined at every hop: each step is an explicit re-export read out of
 * source, and the search only ever enters modules that source named. It never widens
 * to a repo-wide name match — that fallback is what bound a production component to a
 * different application's same-named one, and walking the barrel properly is how the
 * edge becomes evidence rather than coincidence.
 *
 * Returns the single matching node, `"ambiguous"` when more than one distinct
 * definition is reachable (two `export *` offering the same name is the real case, and
 * picking either is a guess), or null when nothing is.
 *
 * `seen` guards a re-export cycle, which is legal to write and would otherwise not
 * terminate.
 */
function resolveThroughReexports(
  file: string,
  name: string,
  reexports: Map<string, ReexportEntry[]>,
  byId: Map<string, NodeV1>,
  perFileName: Map<string, Map<string, NodeV1[]>>,
  kinds: Kind[] | null,
  // T3: a barrel very often re-exports from a workspace PACKAGE rather than a
  // relative path — `export { Input } from '@dailywerk/frontend-ui'` is the shape
  // this was found on — so the hop needs the same package map every other
  // specifier resolution gets, or it stops at the first bare specifier.
  workspacePackages: WorkspacePackage[],
  seen: Set<string> = new Set(),
  hops = 0,
): NodeV1 | "ambiguous" | null {
  if (hops >= MAX_REEXPORT_HOPS || seen.has(file)) return null;
  seen.add(file);
  const entries = reexports.get(file);
  if (!entries) return null;

  const found: NodeV1[] = [];
  let ambiguous = false;
  for (const entry of entries) {
    const star = entry.name === "*";
    // A named entry only answers for the name it exposes; a star answers for anything,
    // and carries the asked-for name straight through.
    if (!star && (entry.exportedAs ?? entry.name) !== name) continue;
    const inner = star ? name : entry.name;
    const target = resolveImport(entry.specifier, file, byId, workspacePackages);
    if (!byId.has(target)) continue; // external module — not ours to resolve
    const direct = (perFileName.get(target)?.get(inner) ?? []).filter(
      (n) => kinds === null || kinds.includes(n.kind),
    );
    if (direct.length === 1) {
      found.push(direct[0]);
      continue;
    }
    if (direct.length > 1) {
      ambiguous = true;
      continue;
    }
    const deeper = resolveThroughReexports(target, inner, reexports, byId, perFileName, kinds, workspacePackages, seen, hops + 1);
    if (deeper === "ambiguous") ambiguous = true;
    else if (deeper) found.push(deeper);
  }

  const distinct = [...new Set(found.map((n) => n.id))];
  if (distinct.length > 1 || (ambiguous && distinct.length > 0)) return "ambiguous";
  if (ambiguous) return "ambiguous";
  return distinct.length === 1 ? found.find((n) => n.id === distinct[0])! : null;
}

function resolveName(
  name: string,
  file: string,
  kinds: Kind[],
  perFileName: Map<string, Map<string, NodeV1[]>>,
  globalName: Map<string, NodeV1[]>,
): { id: string; confidence: EdgeV1["confidence"] } | null {
  const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  // Same-file requires a UNIQUE match, exactly as the cross-file branch below does.
  // Returning `local[0]` meant a file holding two same-named types (`Alpha.Builder` and
  // `Beta.Builder`, `Alpha.Inner` and `Beta.Inner`) silently resolved to whichever came
  // first in document order — and labelled it `extracted`, i.e. certain. That is the
  // guess this module's header says it does not make.
  if (local.length === 1) return { id: local[0].id, confidence: "extracted" };
  // Cross-file: also require a language that could actually reach this one.
  // Without it a unique name match ANYWHERE in the repo wins, which is how a Go
  // builtin ended up resolving into a TypeScript test — see FAMILIES above.
  const global = (globalName.get(name) ?? []).filter(
    (n) => kinds.includes(n.kind) && reachable(file, n.path),
  );
  // A framework-synthesized method COUNTS toward ambiguity but is never the
  // cross-file answer. It is declared, not written, and from another file the
  // bare-name ladder cannot tell `I18n.t(...)` from a `delegate :t, to: :helpers`
  // forwarder — measured on filewerk-rails, that single delegate absorbed 177 call
  // edges, a false hub of exactly the shape this project exists to remove. Counting
  // it toward ambiguity is the other half and matters just as much: once
  // `has_many :organization` has declared readers on a dozen models, a bare
  // `organization` genuinely has a dozen possible owners, and saying so drops 60
  // wrong edges that a unique-name match used to emit with confidence.
  //
  // Same-file is untouched above, deliberately: there the declaration is right there
  // in the source, `t(...)` inside `ApplicationComponent` really is that delegate,
  // and the match is certain rather than a guess. Everything else waits for M3 to
  // type the receiver, which is the milestone that owns the question.
  if (global.length === 1 && global[0].origin !== "synthesized") {
    return { id: global[0].id, confidence: "inferred" };
  }
  return null;
}

/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
/**
 * Narrow an overload set to the candidates a call of `argCount` arguments could
 * reach. Only Java emits `argCount`/`arity`, so for every other language this is
 * the identity function and resolution is byte-for-byte what it was.
 *
 * Deliberately conservative in both directions:
 *   - A variadic candidate (`String... xs`) accepts anything from `arity - 1`
 *     upward, so it is never filtered out by count.
 *   - A candidate with no recorded arity (a graph built before this field) is
 *     kept, since absence of data is not evidence of a mismatch.
 *   - If narrowing leaves nothing, the ORIGINAL set is returned. An empty result
 *     would silently drop a real edge; handing the full set back lets the existing
 *     same-file / "ambiguous" logic make the call exactly as before.
 */
function narrowByArity(candidates: NodeV1[], argCount?: number): NodeV1[] {
  if (argCount === undefined || candidates.length < 2) return candidates;
  const fits = candidates.filter((c) => {
    if (c.arity === undefined) return true;
    return c.variadic ? argCount >= c.arity - 1 : c.arity === argCount;
  });
  return fits.length > 0 ? fits : candidates;
}

function resolveTypedMember(
  recvType: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classParents: Map<string, string[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const MAX_DEPTH = 3;
  const visited = new Set<string>([recvType]);
  let frontier = [recvType];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    for (const type of frontier) {
      const all = ownerMethod.get(`${type}.${name}`)?.filter((c) => reachable(file, c.path));
      if (all && all.length > 0) {
        const candidates = narrowByArity(all, argCount);
        if (candidates.length === 1) {
          const c = candidates[0];
          return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
        }
        // Swift: several candidates surviving arity narrowing are a genuine
        // overload set distinguished only by parameter TYPES (`save(Int)` vs
        // `save(String)`), which this pass cannot read — the same-file tiebreak
        // below would pick whichever overload appears first in the file and
        // stamp it `extracted`, a confidently wrong edge. Drop instead.
        if (SWIFT_EXT.test(file)) return "ambiguous";
        const sameFile = candidates.find((c) => c.path === file);
        if (sameFile) return { id: sameFile.id, confidence: "extracted" };
        return "ambiguous"; // several, none same-file — drop and stop
      }
      const traitHit = resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount);
      if (traitHit === "ambiguous") return "ambiguous";
      if (traitHit) return traitHit;
    }
    const next: string[] = [];
    for (const type of frontier) {
      for (const parent of classParents.get(type) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return null; // chain exhausted, no candidate anywhere
}

/** Resolve a member call against methods declared on PHP traits used by `type`. */
function resolveTraitMember(
  type: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const traits = classTraits.get(type);
  if (!traits?.length) return null;
  const matches: NodeV1[] = [];
  for (const trait of traits) {
    const all = ownerMethod.get(`${trait}.${name}`)?.filter((c) => reachable(file, c.path));
    if (!all?.length) continue;
    matches.push(...narrowByArity(all, argCount));
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const c = matches[0];
    return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
  }
  return "ambiguous";
}

/**
 * The first in-repo file node a module path names: the path as written, then each
 * source extension, then the directory's `index`. Null when none of them is a node,
 * which is how a path pointing at build output or outside the repo stays unresolved.
 */
function importCandidate(base: string, byId: Map<string, NodeV1>): string | null {
  const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => noExt + e),
    ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
  ];
  for (const c of candidates) if (byId.has(c)) return c;
  return null;
}

/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 *
 * A bare specifier is not automatically external. In a monorepo it routinely names
 * an IN-REPO workspace package — `@acme/runtime/api` reaching
 * `packages/runtime/src/services/api.ts` through that package's `exports` map, a
 * mapping no path arithmetic can guess — and reading it as third-party costs every
 * edge through it. Measured on one frontend: 164 file `imports` edges pointed at a
 * phantom specifier string instead of the repo file they name, and every
 * `references` edge through such a specifier was discarded as external.
 *
 * It costs calls too wherever a named-import call gate is in play, since such a gate
 * must refuse the unique-name fallback for a module it believes is not in the repo —
 * 46 more dropped edges to one function in that same frontend.
 *
 * The workspace map is only consulted for JavaScript/TypeScript files. Python shares
 * this function and IMPORT_EXTS, and a Python `import frontend` must not acquire an
 * edge because some `package.json` in the repo happens to be named `frontend`.
 */
function resolveImport(
  spec: string,
  file: string,
  byId: Map<string, NodeV1>,
  packages: WorkspacePackage[],
): string {
  if (!spec.startsWith(".")) {
    if (packages.length === 0 || !JS_EXT.test(file)) return spec;
    return resolveWorkspaceImport(spec, packages, byId);
  }
  // Belt-and-braces: `node.path` is posix by construction (`../util/paths.ts`),
  // but this also accepts a hand-written or hand-edited graph.
  const dir = posix.dirname(toPosixPath(file));
  return importCandidate(posix.normalize(posix.join(dir, spec)), byId) ?? spec;
}

/**
 * Resolve a bare specifier that names an in-repo workspace package to the file it
 * imports; otherwise return the raw specifier, which is what a genuinely third-party
 * package must stay.
 *
 * The longest matching package name wins, so a sibling `@acme/ui-icons` is not
 * swallowed by `@acme/ui`.
 */
function resolveWorkspaceImport(
  spec: string,
  packages: WorkspacePackage[],
  byId: Map<string, NodeV1>,
): string {
  let best: { pkg: WorkspacePackage; subpath: string } | null = null;
  for (const pkg of packages) {
    let subpath: string | null = null;
    if (spec === pkg.name) subpath = ".";
    else if (spec.startsWith(`${pkg.name}/`)) subpath = `./${spec.slice(pkg.name.length + 1)}`;
    if (subpath === null) continue;
    if (!best || pkg.name.length > best.pkg.name.length) best = { pkg, subpath };
  }
  if (!best) return spec; // third-party — keep the package specifier
  const target = exportTarget(best.pkg, best.subpath);
  if (target === null) return spec;
  return importCandidate(posix.normalize(posix.join(best.pkg.dir, target)), byId) ?? spec;
}

/**
 * The package-relative file a subpath names, or null when the package does not offer
 * that subpath at all.
 *
 * `exports` is a closed door in Node's own resolver: a subpath it does not list is
 * not importable, so a miss returns null rather than falling through to a path join.
 * Guessing there would invent an edge to a file the importing code cannot reach —
 * precisely the kind of plausible-but-wrong target this resolver exists to refuse.
 *
 * Without `exports` the classic layout applies: a subpath IS a path under the package
 * directory, and the root is whatever `main` names, or an `index` for the ladder to
 * find.
 */
function exportTarget(pkg: WorkspacePackage, subpath: string): string | null {
  const exports = pkg.exports;
  if (!exports) return subpath === "." ? (pkg.main ?? "index") : subpath;
  const exact = exports[subpath];
  if (exact !== undefined) return exact;
  // A subpath pattern: one `*` stands for the rest, e.g. `"./*": "./src/*.ts"`.
  for (const [pattern, value] of Object.entries(exports)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    if (subpath.length < head.length + tail.length) continue;
    const rest = subpath.slice(head.length, subpath.length - tail.length);
    return value.replace("*", rest);
  }
  return null;
}

/**
 * Resolve a Java import's fully-qualified type name to an in-repo file node;
 * otherwise return the raw specifier (JDK or third-party type).
 *
 * Java names a *type*, not a path, and states no source root — `com.acme.Foo` may
 * live under `src/main/java/`, `src/`, or a module dir. Matching on the path SUFFIX
 * (`com/acme/Foo.java`) is therefore root-agnostic and needs no build-file parsing,
 * which is what keeps this deterministic and dependency-free.
 *
 * `import static com.acme.Foo.bar` names a member, so when the full name misses, the
 * last segment is dropped and the enclosing type retried. A wildcard (`com.acme.*`)
 * names a package rather than one file and is deliberately left unresolved: picking a
 * representative would invent an edge the source does not state.
 *
 * A suffix shared by two files (the same FQN under two source roots, e.g. a
 * duplicated test tree) is ambiguous, so it stays unresolved rather than guessing.
 */
function resolveJavaImport(spec: string, filesBySuffix: Map<string, string[]>): string {
  const hit = (fqn: string): string | null => {
    const suffix = `${fqn.split(".").join("/")}.java`;
    const files = filesBySuffix.get(suffix);
    return files && files.length === 1 ? files[0] : null;
  };
  const direct = hit(spec);
  if (direct) return direct;
  // `import static a.b.C.member` → retry as `a.b.C`.
  const dot = spec.lastIndexOf(".");
  if (dot > 0) {
    const enclosing = hit(spec.slice(0, dot));
    if (enclosing) return enclosing;
  }
  return spec;
}

/**
 * Resolve a C/C++ `#include "path"` to an in-repo file node: relative to the including
 * file first (the common case, and certain), else a UNIQUE path-suffix match — which
 * covers a header reached through an `-I` include directory rather than a relative path.
 * Anything ambiguous or not found stays the raw path (a system or out-of-repo header),
 * never a guessed edge.
 */
function resolveCInclude(
  spec: string,
  file: string,
  byId: Map<string, NodeV1>,
  bySuffix: Map<string, string[]>,
): string {
  const dir = posix.dirname(toPosixPath(file));
  const relJoin = posix.normalize(posix.join(dir, spec));
  if (byId.has(relJoin)) return relJoin; // relative to the including file — certain
  const hits = bySuffix.get(spec.replace(/^\.?\//, ""));
  if (hits && hits.length === 1) return hits[0]; // unique suffix — an -I-reached header
  return spec; // system/out-of-repo/ambiguous — keep the string, do not guess
}

/**
 * Resolve a PHP `use` fully-qualified name (`App\Models\User`) to the in-repo class file.
 * PSR-4 maps the namespace to a directory under some (unknown) source root and the class
 * to a `<Class>.php` file, so we match the longest namespace-tail suffix that names exactly
 * one file: `App/Models/User.php`, then `Models/User.php`, then `User.php`. The longest
 * unique match wins; an ambiguous tail or a vendor/out-of-repo class stays the raw name.
 */
function resolvePhpUse(fqn: string, bySuffix: Map<string, string[]>): string {
  const parts = fqn.split("\\").filter(Boolean);
  if (parts.length === 0) return fqn;
  for (let i = 0; i < parts.length; i++) {
    const suffix = `${parts.slice(i).join("/")}.php`;
    const hits = bySuffix.get(suffix);
    if (hits && hits.length === 1) return hits[0];
    if (hits && hits.length > 1) break; // ambiguous at the most specific level — do not guess
  }
  return fqn;
}

/**
 * Resolve a Rust `crate`-relative module path (`crate/a/b`, from `use crate::a::b::Item`)
 * to the in-repo module file — `<crate root>/a/b.rs` or `<crate root>/a/b/mod.rs`, where
 * the crate root is the `lib.rs`/`main.rs` directory the importing file lives under. The
 * per-file crate root keeps a multi-crate workspace unambiguous. Not found or ambiguous
 * (two roots, both `a/b.rs` and `a/b/mod.rs`) stays a `crate::…` string — never a guess.
 */
function resolveRustUse(spec: string, file: string, byId: Map<string, NodeV1>, crateRoots: string[]): string {
  const full = spec.replace(/^crate\/?/, ""); // "crate/a/b/Item" → "a/b/Item"; "crate" → ""
  const fpath = toPosixPath(file);
  // the crate this file belongs to: the longest root that contains it (workspace-safe)
  const owning = crateRoots
    .filter((r) => r === "" ? true : fpath === r || fpath.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length);
  // No owning crate root (e.g. an integration test under `tests/`, whose `crate::` is the
  // TEST binary's own root, not a lib) → do NOT search every crate in a workspace: that
  // resolves `crate::util` to some unrelated crate's util.rs. Keep it a string instead.
  if (owning.length === 0) return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
  const roots = [owning[0]];
  const segs = full === "" ? [] : full.split("/");
  const hitsFor = (rels: string[]): Set<string> => {
    const hits = new Set<string>();
    for (const r of roots) for (const rel of rels) {
      const cand = r === "" ? rel : `${r}/${rel}`;
      if (byId.has(cand)) hits.add(cand);
    }
    return hits;
  };
  // Try the longest module prefix first, shrinking toward — but NOT past — the first
  // segment. `crate::a::b::C` resolves as module `a/b` (C is the item); `crate::net` as
  // module `net`. The first prefix naming exactly one in-repo file wins; two matches at a
  // level are ambiguous → drop rather than guess.
  for (let k = segs.length; k >= 1; k--) {
    const modPath = segs.slice(0, k).join("/");
    const hits = hitsFor([`${modPath}.rs`, `${modPath}/mod.rs`]);
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) break;
  }
  // The crate root (`lib.rs`/`main.rs`) is a target ONLY for `use crate::Item` or
  // `use crate::{…}` — a deeper path whose module chain didn't resolve is genuinely
  // unknown (a re-export, an inline `mod`, or out-of-tree), so keep it as a string.
  if (segs.length <= 1) {
    const hits = hitsFor(["lib.rs", "main.rs"]);
    if (hits.size === 1) return [...hits][0];
  }
  return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
}

/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec: string, modules: GoModule[], filesByDir: Map<string, string[]>): string {
  let best: { mod: GoModule; subpath: string } | null = null;
  for (const mod of modules) {
    let subpath: string | null = null;
    if (spec === mod.module) subpath = "";
    else if (spec.startsWith(mod.module + "/")) subpath = spec.slice(mod.module.length + 1);
    if (subpath === null) continue;
    if (!best || mod.module.length > best.mod.module.length) best = { mod, subpath };
  }
  if (!best) return spec; // stdlib / third-party — keep the package path

  const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
  const files = filesByDir.get(dir);
  if (!files || files.length === 0) return spec;
  return [...files].sort()[0];
}
