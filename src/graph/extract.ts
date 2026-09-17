/**
 * Tier-1 extraction: source file → {@link NodeV1}[] + raw edges, via tree-sitter.
 *
 * Deterministic and dependency-only (no LLM, no network). Emits one node per
 * definition (file, class, function, method, interface, type, enum, and TS
 * arrow-function consts) plus unresolved edge intents. Edge *targets* are
 * resolved against the whole-repo node index later, in build.ts.
 */
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Cpp from "tree-sitter-cpp";
import R from "tree-sitter-r";
import Ruby from "tree-sitter-ruby";
import Java from "tree-sitter-java";
import Kotlin from "tree-sitter-kotlin";
import Swift from "tree-sitter-swift";
import PHP from "tree-sitter-php";
import { basename } from "node:path";
import { contentHash } from "../util/id.js";
import { associationConstant, camelize } from "./zeitwerk.js";
import {
  collectBindings,
  rubyMethodReturnType,
  rubyConstructorType,
  rubyConstructionHasBlock,
  rubyScopeKey,
  rubyBlockSelfContext,
  rubyNamedClassFactory,
  rubyUnknownFactoryBlock,
  rubyBlockClassScope,
  rubyBindingDeclarations,
  goReceiverVarOf,
  resolveRecvType,
  cppDeclaratorName,
  resolveCppQualified,
  stripCppTemplateArgs,
  type FileBindings,
  type RubySelfKind,
  type RubySelfContext,
  type RubyType,
  type RubyValueKind,
  type RubyTypeCtx,
} from "./bindings.js";
import type { Kind, NodeV1, Relation } from "./types.js";

export type Language =
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "cpp"
  | "r"
  | "ruby"
  | "java"
  | "kotlin"
  | "swift"
  | "php";

/**
 * Extension → the tree-sitter grammar that parses it, and the label a human expects
 * to see for it.
 *
 * The two are not the same, and conflating them under-reported coverage: `.mjs` is
 * parsed by the typescript grammar, so a JS repo's build banner read `[typescript]`
 * and a `.jsx` one read `[tsx]`. Both are true about the *parser* and misleading
 * about the repo — people went looking for why their JavaScript hadn't been indexed
 * when it had, and could not tell a language that was merely unlabelled from one
 * that really was skipped (see issue #36).
 *
 * One table, both readings derived from it, so adding an extension cannot fix
 * extraction and forget the label. Ordered longest-suffix-first: `.tsx` has to be
 * tested before `.ts` would match it.
 */
const EXTENSIONS: ReadonlyArray<{ ext: string; grammar: Language; label: string }> = [
  { ext: ".tsx", grammar: "tsx", label: "tsx" },
  { ext: ".jsx", grammar: "tsx", label: "jsx" },
  { ext: ".mts", grammar: "typescript", label: "typescript" },
  { ext: ".cts", grammar: "typescript", label: "typescript" },
  { ext: ".ts", grammar: "typescript", label: "typescript" },
  { ext: ".mjs", grammar: "typescript", label: "javascript" },
  { ext: ".cjs", grammar: "typescript", label: "javascript" },
  { ext: ".js", grammar: "typescript", label: "javascript" },
  { ext: ".pyi", grammar: "python", label: "python" },
  { ext: ".py", grammar: "python", label: "python" },
  { ext: ".go", grammar: "go", label: "go" },
  // One "cpp" grammar for the whole C/C++ family — tree-sitter-cpp parses C as a
  // strict-ish superset, same approach clangd and most polyglot tooling take. No
  // separate C grammar/language for v1 (documented limitation, not an oversight).
  { ext: ".hpp", grammar: "cpp", label: "cpp" },
  { ext: ".hh", grammar: "cpp", label: "cpp" },
  { ext: ".hxx", grammar: "cpp", label: "cpp" },
  { ext: ".cpp", grammar: "cpp", label: "cpp" },
  { ext: ".cc", grammar: "cpp", label: "cpp" },
  { ext: ".cxx", grammar: "cpp", label: "cpp" },
  { ext: ".h", grammar: "cpp", label: "cpp" },
  { ext: ".rb", grammar: "ruby", label: "ruby" },
  { ext: ".java", grammar: "java", label: "java" },
  { ext: ".kt", grammar: "kotlin", label: "kotlin" },
  { ext: ".kts", grammar: "kotlin", label: "kotlin" },
  { ext: ".swift", grammar: "swift", label: "swift" },
  { ext: ".php", grammar: "php", label: "php" },
  // `entryFor` lower-cases the path before matching, so this one entry covers
  // both `.R` (the conventional case in real R codebases) and `.r`.
  { ext: ".r", grammar: "r", label: "r" },
];

function entryFor(path: string): (typeof EXTENSIONS)[number] | undefined {
  const p = path.toLowerCase();
  return EXTENSIONS.find((e) => p.endsWith(e.ext));
}

/** Every file extension a depth-tier (hand-written) extractor claims. */
export function depthExtensions(): string[] {
  return EXTENSIONS.map((e) => e.ext);
}

/** Map a file path to a supported language, or null if unsupported. */
export function languageOf(path: string): Language | null {
  return entryFor(path)?.grammar ?? null;
}

/**
 * What to *call* the language of this file, for a banner or a repo map — or null when
 * the file isn't indexed at all, which is the distinction {@link languageOf} shares
 * and the one that matters to a reader checking coverage.
 */
export function languageLabelOf(path: string): string | null {
  return entryFor(path)?.label ?? null;
}

/**
 * An edge whose target isn't resolved yet. build.ts turns these into EdgeV1 by
 * matching `name`/`specifier` against the repo-wide node index.
 */
export interface RawEdge {
  /** Keyword injection is conditional dataflow, never an exclusive variable type.
   * Keep the declaration/call site until constants and method owners are resolved. */
  rubyBinding?: { key: string; value: RubyBindingValue | null; parameter?: string };
  rubyArguments?: Record<string, RubyBindingValue | null> | null;
  rubyReceiverBinding?: string;
  rubyBlockSteps?: Array<"first" | "map">;
  rubyBlockArrayEvidence?: string[];
  rubyConstructed?: boolean;
  source: string; // resolved node id
  relation: Relation;
  file: string; // the file this edge originates in (scopes name resolution)
  targetId?: string; // already-resolved target (contains)
  /** module path to resolve (imports / imported-symbol references). On a
   * `calls` edge (TypeScript): the callee is a named import from this module,
   * and `name` is its EXPORTED name; resolve.ts then confines resolution to
   * that module instead of guessing from a unique repo-wide name match (#330). */
  specifier?: string;
  name?: string; // symbol name to resolve (extends/implements/calls)
  /** imports only, and only for `export … from '…'`: the name the re-exporting
   * module exposes, when it differs from `name`. `export { Inner as Outer }` records
   * `name: "Inner"` (what the target module defines) and `exportedAs: "Outer"` (what
   * an importer writes). Absent means the two are the same. */
  exportedAs?: string;
  viaMember?: boolean; // calls: was it `obj.foo()` (→ prefer method targets)?
  /** calls with viaMember: the receiver's resolved type name (from bindings /
   * self / this / Go receiver), when a confident local clue exists. */
  recvType?: string;
  /** calls without viaMember: which kinds the bare-name match may resolve to.
   * Most languages' bare-name call is always a free function, so this is absent
   * for them (resolve.ts defaults to `["function"]`). R (Phase 4) is the
   * exception that needs it WIDENED: `obj$method()` with an untyped receiver (not
   * self/private/super, which already resolve precisely via viaMember+recvType)
   * still has a real shot at a correct match if the method name happens to be
   * uniquely defined across the repo — R6 methods are kind "method", not
   * "function", so without this override every such call would be
   * unconditionally unresolvable rather than just occasionally ambiguous.
   *
   * Ruby sets it to the default explicitly, for the opposite reason: M0 widened it
   * to "method" so a bare word could reach a sibling or mixed-in method, and M3
   * reaches those owner-qualified instead. What the widening left behind was a
   * bare word matching a method on an UNRELATED class, which Ruby's own lookup
   * cannot do — a receiverless word is `self.word`, and off the ancestry the only
   * thing it can find is a top-level `def`, kind "function". */
  kinds?: Kind[];
  /** calls: the number of arguments at the CALL SITE. Only emitted for languages
   * with overloading (Java, Swift), where a same-named sibling on the same class is
   * otherwise indistinguishable — and picking wrong turns a delegating overload
   * into a self-loop. */
  argCount?: number;
  /** A bare call that the language resolves member-first, carried as ONE edge with
   * two readings: the member reading (Swift's `viaMember` + `recvType`, Ruby's
   * `rubyRecvBase: "self"` + `rubyOwnerFqn`) is tried first, and this flag lets
   * resolve.ts fall back to the free-function/bare-name reading when the owner
   * chain has no such member — and ONLY then, so a name defined as both a member
   * and a free function yields the member edge alone, exactly as the language
   * dispatches it. An AMBIGUOUS member set still drops the edge outright; the
   * fallback is for "no member anywhere", never for "several".
   *
   * Swift: a bare lowercase call inside a type body (inner scope wins). Ruby:
   * every receiverless call inside a class, because Ruby has no free functions —
   * a top-level `def` is a private method on Object, so `helper` inside a class
   * really is `self.helper` and only reaches a top-level definition when the
   * class's own ancestors have nothing by that name. */
  implicitSelf?: boolean;
  /** Ruby only: `Module.nesting` at the reference site, innermost first
   * (`["A::B::C", "A::B", "A"]`). Present on every Ruby `references` edge and on
   * Ruby heritage edges (superclass and `include`/`extend`/`prepend`), which is
   * what routes them through the constant resolver rather than the bare-name
   * ladder. Its presence — not the language of the file — is the switch, so a
   * graph built before this field resolves exactly as it did before. */
  nesting?: string[];
  /** Ruby only: which heritage form produced this `extends` edge. The graph relation
   * is the same for all four, but Ruby's CONSTANT lookup is not: `prepend`ed modules
   * come before the class, `include`d ones after it (both in reverse declaration
   * order), the superclass last — and `extend` contributes nothing at all, because it
   * targets the singleton class and `Module.nesting`'s step 2 walks `cref.ancestors`.
   * Resolving `Inner` inside `class Child < Base; include Mix; end` to `Base::Inner`
   * when Ruby says `Mix::Inner` is a wrong edge, not a missing one, so the order is
   * reconstructed in `resolve.ts` from this tag rather than from emission order. */
  rubyHeritage?: "superclass" | "include" | "prepend" | "extend";
  /** Ruby only: this edge is a constant ASSIGNMENT (`MAX = 10`), not a reference.
   * It never becomes a graph edge — the value has no node to point at — but the
   * declaration still shadows every outer constant of that name, so `resolve.ts`
   * records the FQN and declines rather than resolving past it to an unrelated
   * top-level class. Ruby finds the constant here; we simply cannot name it. */
  rubyConstDecl?: boolean;
  /** Syntactically named Class.new superclass. Validation waits for the complete
   * constant index; a shadowed factory never supplies dispatch or heritage. */
  rubyClassFactory?: boolean;
  /** A mutation of a statically named class object, retained even when the
   * mutating call itself cannot resolve to an indexed method. */
  rubyClassMutation?: boolean;
  /** Factory blocks can declare constants in their outer lexical namespace.
   * Their syntax still depends on the factory executing; semantic ownership
   * alone cannot withdraw those declarations when the factory is rejected. */
  rubyFactoryDependencies?: string[];
  /** Validation-only class-object aliases. They never establish instance types
   * or executable targets; every possible writer can invalidate a factory. */
  rubyConstAlias?: RubyBindingValue;
  rubyClassAliasBinding?: { key: string; value: RubyBindingValue | null };
  rubyClassMutationBinding?: string;
  /** Ruby only: the fully-qualified name of the class this edge was declared in
   * (`Api::V1::User`), for the macro edges whose receiver is that class and is known
   * exactly. The generic `recvType` is a BARE class name shared across every
   * language, so `before_save :stamp` inside `A::User` matched a `stamp` defined on
   * an unrelated `B::User` — a wrong edge produced from a declaration that leaves no
   * room for doubt about its receiver. This resolves against an FQN-keyed method
   * index and the class's own Ruby ancestor chain instead. */
  rubyOwnerFqn?: string;
  /** Ruby only: this edge was declared inside an `ActiveSupport::Concern`'s
   * `included do` block, so its real subjects are the classes that INCLUDE the
   * concern, not the concern itself. `resolve.ts` re-attributes it across the
   * resolved `extends` edges and drops it entirely when nothing includes the
   * concern — declining rather than attributing a callback to a module that never
   * runs it. */
  viaConcern?: boolean;
  /** Ruby only (M3): where this call's receiver TYPE comes from. Its presence is
   * what routes the edge through receiver-typed resolution instead of the
   * bare-name ladder, so a graph built before M3 resolves exactly as it did.
   *
   *   - `"self"` — the receiver is the enclosing class, named exactly by
   *     `rubyOwnerFqn`: an explicit `self.foo`, or a receiverless `foo` (which in
   *     Ruby IS `self.foo`; there are no free functions).
   *   - `"const"` — the receiver is a constant written at the call site or a
   *     variable assigned from one, carried in `rubyRecvConst` and resolved by
   *     M1's constant resolver against `nesting`.
   *
   * A receiver that is neither — a parameter, a rescue binding, `params[:x]`, a
   * duck-typed service object — sets nothing and emits NO edge at all. That is
   * the milestone's whole point: `e.message` used to resolve, by unique name, to
   * a ViewComponent's `attr_reader :message`, 161 times. */
  rubyRecvBase?: "self" | "const";
  rubySuper?: boolean;
  /** An include/prepend/extend argument was not a constant; retain the barrier. */
  rubyHeritageUnknown?: boolean;
  rubyJob?: "perform_later" | "perform_now";
  rubyJobConfigured?: boolean;
  rubyMailbox?: "routing" | "before_processing" | "after_processing" | "around_processing";
  /** Ruby only (M3): the receiver's class as WRITTEN (`User`, `Api::V1::Job`,
   * `::Top::Thing`), for `rubyRecvBase === "const"`. Paired with `nesting`, since
   * what a constant names depends on where it is written. */
  rubyRecvConst?: string;
  /** Ruby only (M3): reader calls applied to the base before this call —
   * `user.subscriptions.active` is base `user`, steps `["subscriptions"]`, name
   * `active`. Each step is resolved on the running type and must have a DECLARED
   * return type (an association) for the walk to continue; a step that does not
   * declines the whole edge rather than resolving `active` against the base. */
  rubyRecvSteps?: string[];
  /** Ruby only (M3): this `references` edge's constant is also the RETURN type of
   * the method with this node id — an association reader (`has_many :posts`
   * declares that `posts` yields `Post`s) or a method whose every exit agrees on
   * one class (`current_user`). `resolve.ts` records it so a chained receiver can
   * be walked one hop at a time. */
  rubyReturnsFor?: string;
  /** Ruby only (M3b): what `rubyReturnsFor`'s method hands back — an INSTANCE of the
   * named class, the class OBJECT, or an ActiveRecord `collection`. `has_many :posts`
   * yields a CollectionProxy, which forwards class methods and scopes to `Post` and
   * raises `NoMethodError` for its instance methods; `belongs_to :blog` yields one
   * Blog. Treating both as "a Post"/"a Blog" is what made `blog.posts.publish`
   * resolve to an instance method Ruby cannot reach. */
  rubyReturnsKind?: RubyValueKind;
  /** Ruby only (M3b): the return type came from ActiveRecord's finder vocabulary, so
   * it holds only if the class really is a model. See `rubyRecvFinder`. */
  rubyReturnsAssumesModel?: boolean;
  /** Ruby only (M3b): what the receiver IS, not merely which class it names.
   * `User` and `User.new` name the same class and answer disjoint sets of methods;
   * see `RubyValueKind`. */
  rubyRecvKind?: RubyValueKind;
  /** Ruby only (M3b): the receiver's kind was read off ActiveRecord's finder of this
   * name (`Widget.first` means "a Widget" only because AR says so). A plain Ruby
   * class with its own `def self.first` means whatever its body returns, so
   * resolve.ts tries that declaration first and falls back to AR's reading only for
   * a class that actually descends from it. */
  rubyRecvFinder?: string;
  /** Ruby only (M3b): the association name this `references` edge was declared for
   * (`has_many :posts` → `"posts"`). Turns the association edges into a registry
   * resolve.ts can look associations up in, which is what following a `through:`
   * requires. */
  rubyAssocName?: string;
  /** Ruby only (M3b): the `through:` association, when the declaration names one.
   * Its target class is stated by the SOURCE reflection on the join model, not by
   * this association's own name — `has_many :people, through: :memberships, source:
   * :person` is a collection of `User` when `Membership` declares `belongs_to
   * :person, class_name: "User"`. `name` carries Rails' own default inflection as
   * the fallback for a join model that is not in this repo. */
  rubyAssocThrough?: string;
  /** Ruby only (M3b): the association names to look for on the join model, in the
   * order Rails tries them — what `source:` names, or else the association's own
   * name and its singular. */
  rubyAssocSourceNames?: string[];
  /** Ruby only (M3): a carrier, not an edge. It exists to state a type and must
   * never reach the graph — the same role `rubyConstDecl` plays for shadowing
   * declarations. An INFERRED return type is not a reference anyone wrote: the
   * method's own body usually names the class anyway (and M1 emits that edge from
   * the source text), and where it does not, minting one would put a dependency in
   * the graph that the file does not contain. */
  rubyTypeOnly?: boolean;
  /** Ruby/Rails only (M4): the template spec this call names, exactly as written —
   * `render "shared/nav"`, `render :edit`, `layout "admin"`. A path, not a symbol:
   * `resolve.ts` turns it into a file under the view root beside the rendering file
   * and emits nothing when no such template was indexed. Kept as the literal because
   * which of Rails' two lookups applies is a property of the CALL, not of the
   * string — a controller's `render "shared/banner"` is a template and a view's is a
   * partial, which ActionController's own `_normalize_args` is what settles. */
  railsTemplateSpec?: string;
  /** Ruby/Rails only (M4): which lookup `railsTemplateSpec` takes. Absent together
   * with the spec on a `renders` edge that is a CARRIER rather than an edge: a
   * `render` in a controller whose target this pass cannot name still tells us the
   * action rendered something, which is what stops the naming convention claiming
   * a template Rails would never reach. */
  railsTemplateKind?: "template" | "partial" | "layout";
  /** Ruby/Rails only (M4): a carrier, never an edge — an instance variable used by a
   * controller method or read by a template, for the contract between the two.
   * `@documents` assigned in an action and read in the view Rails renders for it is
   * a real interface that neither file states, and unlike the two names in a
   * `renders` edge it is checkable from the source of both sides. Emitted only for
   * the two file shapes that can form such a pair; one raw edge per ivar OCCURRENCE
   * across a whole Rails app would be tens of thousands of them for a relationship
   * that means nothing anywhere else. */
  railsIvar?: string;
  /** Ruby/Rails only (M4): this use ASSIGNS the ivar. Absent means it reads it. */
  railsIvarWrite?: boolean;
  /** Ruby/Rails only (M4): this `references` edge came from `helper_method :name`,
   * so its target is callable from every template the declaring controller renders.
   * The edge itself is the declaration — a controller really does name that method —
   * and the flag is what lets resolve.ts also file the target in the index a
   * template's bare words are resolved against. */
  railsHelperExport?: boolean;
}

export type RubyBindingValue = { binding: string } | { constant: string; file: string; nesting: string[] };

export interface ExtractResult {
  nodes: NodeV1[];
  rawEdges: RawEdge[];
}

/** Max chars of normalized body stored per symbol for search. Large enough that
 * essentially every real definition is stored whole — only a rare giant function
 * is clipped — while bounding how much the committed graph can grow. */
const MAX_BODY_CHARS = 5000;

/** Cap for a file node's module-level residual (imports, constants, module
 * docstring — everything not inside a symbol). Higher than the per-symbol cap
 * because a data-heavy module (constant tables, big config dicts) is legitimate
 * residual, and it's the recall play — but still bounded. */
const MAX_FILE_BODY_CHARS = 16000;

/** The searchable body of a definition: its source text, whitespace-collapsed
 * so every identifier becomes a token, capped at `max`. Search-only — the agent
 * still reads verbatim source via `ask --source`, which slices the file from
 * disk, so nothing here reaches the agent's context. */
function searchBody(text: string, max = MAX_BODY_CHARS): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length > max ? norm.slice(0, max) : norm;
}

/** A file's module-level residual: the lines NOT covered by any symbol span.
 * Symbol bodies are already indexed on their own nodes, so this captures only
 * what they miss — top-of-file imports, module constants, module docstrings —
 * making a file findable by a term that lives outside every function/class.
 * `symbols` are the file's emitted nodes (with `Lx-Ly` spans); `source` is the
 * whole file. Far leaner than storing full-file bodies (no symbol duplication). */
function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const s of symbols) {
    const m = s.span.match(/^L(\d+)-L(\d+)$/);
    if (!m) continue;
    for (let r = Number(m[1]); r <= Number(m[2]) && r < covered.length; r++) covered[r] = 1;
  }
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) if (!covered[i + 1]) kept.push(lines[i]);
  return searchBody(kept.join(" "), MAX_FILE_BODY_CHARS);
}

const TS_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

const PY_KINDS: Record<string, Kind> = {
  class_definition: "class",
  function_definition: "function", // → "method" inside a class (resolved in the walk)
};

// Go: `type_spec` is intentionally absent — its kind (struct/interface/type) depends on
// the named type's shape, so it's resolved dynamically in describe().
const GO_KINDS: Record<string, Kind> = {
  function_declaration: "function",
  method_declaration: "method",
};

// C++: no flat kind-map lookup — function_definition carries no `name` field
// (it's buried inside a declarator chain), so describeCpp() handles it directly.
const CPP_KINDS: Record<string, Kind> = {
  class_specifier: "class",
  struct_specifier: "struct",
  enum_specifier: "enum",
};

// R: `function_definition` carries no name field at all (unlike every other
// supported language) — its identifier always comes from context (an
// assignment's other side), resolved dynamically in describeR(). Empty, like
// Go's own table — never consulted, kept only to satisfy KINDS_BY_LANG's type.
const R_KINDS: Record<string, Kind> = {};
// Java: a record is a nominal data carrier, so it takes "struct" — the same role
// Go's struct plays — rather than "class", which would make a service and a DTO
// indistinguishable in a repo where DTOs are most of the type surface.
const JAVA_KINDS: Record<string, Kind> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "struct",
  annotation_type_declaration: "interface",
  annotation_type_element_declaration: "method",
  method_declaration: "method",
  constructor_declaration: "method",
};

/** Java type declarations: they set `enclosingClass` for the methods nested in them,
 * which "class"-only logic would miss for a record's or interface's members. */
const JAVA_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum", "struct"]);

const KOTLIN_KINDS: Record<string, Kind> = {
  class_declaration: "class", // → "interface" / "enum" / "interface" (annotation) in describeKotlin
  object_declaration: "class", // a singleton object is class-like (companion objects included)
  function_declaration: "function", // → "method" inside a type (resolved in the walk)
  secondary_constructor: "method", // the class's own secondary constructor
  type_alias: "type",
  property_declaration: "variable", // top-level `val`/`var` only (fields resolved in the walk)
};

/** Kotlin type declarations: they set `enclosingClass` for the members nested in them.
 * "class" also covers object_declaration (it maps to "class"); interface/enum are the
 * same class_declaration node rekinded in describeKotlin, so all three land in the set. */
const KOTLIN_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "enum"]);

const SWIFT_KINDS: Record<string, Kind> = {
  class_declaration: "class", // → "struct" / "enum" in describeSwift (one node type covers all five keywords)
  protocol_declaration: "interface",
  function_declaration: "function", // → "method" inside a type (resolved in the walk)
  protocol_function_declaration: "method", // a protocol requirement is always a member
  init_declaration: "method", // the type's own initializer (named after it, like a Java constructor)
  typealias_declaration: "type",
  property_declaration: "variable", // top-level `let`/`var` only (fields resolved in the walk)
};

/** Swift type declarations: they set `enclosingClass` for the members nested in them.
 * class/struct/enum are the same class_declaration node rekinded in describeSwift
 * (an actor takes "class"); protocols are "interface". "module" is an extension
 * body — a member-contributing scope named after the extended type, deliberately
 * NOT a type kind in the graph so it can never make the real declaration's name
 * ambiguous (see describeSwift's extension branch) — but its members still
 * promote to methods owned by that type, which is why it belongs in this set. */
const SWIFT_TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "class",
  "struct",
  "enum",
  "interface",
  "module",
]);

// PHP: definition node types are all distinct (no py-style function→method
// promotion needed — a class body uses `method_declaration`, not
// `function_definition`). `trait_declaration` maps to the PHP-only `trait` kind.
const PHP_KINDS: Record<string, Kind> = {
  function_definition: "function",
  method_declaration: "method",
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

// Ruby: `class`/`module`/`method`/`singleton_method` all carry a real `name`
// field, but a bare `method` node's KIND depends on whether it's lexically
// inside a class/module (→ "method") or at top level (→ "function") — same
// promotion Python does for `function_definition` — so it's resolved
// dynamically in describeRuby() rather than a static table lookup.
const RUBY_KINDS: Record<string, Kind> = {};

const KINDS_BY_LANG: Record<Language, Record<string, Kind>> = {
  typescript: TS_KINDS,
  tsx: TS_KINDS,
  python: PY_KINDS,
  go: GO_KINDS,
  cpp: CPP_KINDS,
  r: R_KINDS,
  ruby: RUBY_KINDS,
  java: JAVA_KINDS,
  kotlin: KOTLIN_KINDS,
  swift: SWIFT_KINDS,
  php: PHP_KINDS,
};

/** The two element shapes a JSX component usage takes. Named once so the call table
 * and `calleeName` cannot drift apart. `jsx_closing_element` is deliberately absent:
 * `</Widget>` is the tail of the same usage the opening tag already recorded, and
 * counting it would double every JSX edge. */
const JSX_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  "jsx_opening_element",
  "jsx_self_closing_element",
]);

/**
 * The node type(s) that constitute a call site, per language.
 *
 * Java is the reason this is a set rather than a string: `method_invocation` and
 * `object_creation_expression` (`new Foo()`) are separate node types, and a Java
 * codebase's constructor calls are a large share of its real edges. PHP is
 * likewise multi-shape: a call is a function / member / nullsafe-member / scoped
 * call, never a single `call_expression`.
 *
 * JSX is that same argument in a React codebase (#382). `<Widget/>` is how a
 * component gets invoked — the runtime calls the function and passes it props —
 * but it parses as `jsx_opening_element` / `jsx_self_closing_element`, so a
 * component's consumers produced no edges at all and `callers`/`blast` went
 * structurally blind across the whole component layer, the one place a "you
 * changed this, these break" answer is worth most. Only the `tsx` grammar can
 * reach these node types; `.ts` and `.js` are parsed by `typescript`, which has
 * no JSX at all, so widening it would be dead weight.
 */
const CALL_TYPES: Record<Language, ReadonlySet<string>> = {
  typescript: new Set(["call_expression"]),
  tsx: new Set(["call_expression", ...JSX_ELEMENT_TYPES]),
  python: new Set(["call"]),
  go: new Set(["call_expression"]),
  cpp: new Set(["call_expression"]),
  java: new Set(["method_invocation", "object_creation_expression"]),
  kotlin: new Set(["call_expression"]),
  swift: new Set(["call_expression"]),
  php: new Set([
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]),
  r: new Set(["call"]),
  ruby: new Set(["call"]),
};

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function",
  "function_expression",
  "generator_function",
]);

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_MAP: ReadonlyMap<string, "protected" | "private"> = new Map();
const EMPTY_NESTING: readonly string[] = [];

const parser = new Parser();
const GRAMMARS: Record<Language, unknown> = {
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  go: Go,
  cpp: Cpp,
  r: R,
  ruby: Ruby,
  java: Java,
  kotlin: Kotlin,
  swift: Swift,
  php: PHP.php,
};

export interface WalkCtx {
  rel: string;
  source: string;
  lang: Language;
  kinds: Record<string, Kind>;
  scope: string[]; // enclosing definition names, for id scoping
  enclosingKind: Kind | null; // kind of the nearest enclosing definition
  parentId: string; // nearest enclosing definition id, or the file id
  bindings: FileBindings; // variable/field -> type, for receiver-type lookups
  enclosingClass: string | null; // nearest enclosing class (py/ts `self`/`this`)
  goReceiverVar: string | null; // Go receiver var, e.g. `w` in `func (w *Worker)`
  importedSymbols: ReadonlyMap<string, { name: string; specifier: string }>;
  // C++ visibility is stateful (an `access_specifier` token applies to every
  // subsequent sibling in a `field_declaration_list`), unlike every other
  // per-node exported check in this file. null outside any class/struct body
  // (top-level definitions default to exported — see cppExported).
  cppAccess: "public" | "private" | "protected" | null;
  // R6 (Phase 2): which list we're inside while walking an `R6Class(...)` call's
  // arguments — set only for the direct span of a `public =`/`private =`/
  // `active =` `list(...)`'s own entries (see walk()'s special-cased `argument`
  // interception), null everywhere else including inside a method's own body.
  rR6Access: "public" | "private" | "active" | null;
  // R (Phase 2): S3 generics registered in THIS file via a local `UseMethod()`
  // call, precomputed once per file (see collectRGenerics). A `name.Class`
  // assignment only becomes an S3 method if `name` is in this set or the
  // curated base-R generics list — see describeR's doc comment for the
  // ambiguity this guards against (`read.csv` is not S3 dispatch).
  rGenerics: ReadonlySet<string>;
  // R6 (Phase 3): the immediate parent class's name (from `inherit =`) for the
  // R6 class we're currently inside, so a `super$method()` call in any of its
  // methods' bodies can resolve directly to the PARENT's method instead of
  // (wrongly) the current class's own same-named override. Unlike rR6Access,
  // this is NOT reset when descending into a method — it needs to stay live
  // for the method's whole body, only changing when a genuinely different
  // class is entered. Null outside any class, or for a class with no parent.
  rSuperClass: string | null;
  // Ruby (Phase 3): the current visibility mode inside a class/module body —
  // starts "public", switches on a bare `private`/`protected`/`public`
  // identifier statement, and applies FORWARD ONLY to subsequent sibling
  // defs (Ruby language semantics). Reset to "public" whenever a genuinely
  // new class/module body is entered (mirrors rSuperClass's reset rule) —
  // NOT reset per-definition, since it must stay live across sibling defs.
  rubyVisibility: "public" | "protected" | "private";
  // Ruby (Phase 3): names marked private/protected by a POST-HOC symbol
  // call (`private :foo`) anywhere in the CURRENT class/module body,
  // pre-scanned once when that body is entered (see rubyPostHocVisibility())
  // — because such a call can appear textually after the def it targets,
  // a single forward pass over rubyVisibility can't see it in time. Reset
  // whenever a new class/module body is entered, same trigger as
  // rubyVisibility.
  rubyPostHoc: ReadonlyMap<string, "protected" | "private">;
  // Ruby (M1): `Module.nesting` at this point in the walk, innermost first —
  // ["A::B::C", "A::B", "A"] inside `module A; module B; class C`. This is the
  // chain Ruby itself searches for a bare constant, and it is NOT the same as
  // `scope`: the compact form `class A::B::C` pushes ONE entry, not three, so
  // its body cannot see `A::B` or `A`. Both spellings occur in real Rails code
  // and they are not interchangeable — see rubyCref().
  rubyNesting: readonly string[];
  // Class.new blocks keep their lexical cref while methods use the new owner.
  rubyOwner: string | undefined;
  // Ruby (M2): the Rails context, or null when this repo is not a Rails app.
  // Its PRESENCE is the gate on the whole ActiveRecord/ActiveSupport vocabulary —
  // `has_many :items` in a plain gem is an ordinary call to a method the repo
  // defines, and reading it as an association would invent four methods that do not
  // exist. Detection happens once per build (see zeitwerk.ts) and is deliberately
  // conservative; directory shape alone never implies Rails.
  rubyRails: RailsContext | null;
  /** M4: which half of the controller↔template instance-variable contract this file
   * can supply, or null for the overwhelming majority of files that are neither.
   * Computed once per file rather than tested per node, and null is what keeps a
   * whole Rails app from emitting one carrier edge per `@ivar` occurrence. */
  railsIvarRole: "writer" | "reader" | null;
  // Ruby (M2): are we inside an ActiveSupport::Concern's `included do ... end`?
  // That block executes in the INCLUDER, so a callback declared there is a callback
  // on every class that includes the concern, not on the concern itself. The edges
  // carry `viaConcern` and resolve.ts re-attributes them across the resolved
  // `extends` edges M1 produces.
  rubyIncludedBlock: boolean;
  // Ruby (M2): the method names the current class/module writes out with a real
  // `def`. A macro must not synthesize a name the class also defines, because the
  // `def` OVERRIDES the generated method — that is the whole point of writing it.
  // Not merely tidier: `Current` in filewerk-rails declares `attribute :organization`
  // and then defines `def organization=`, and synthesizing anyway minted the
  // generated node first, handing it the base id and pushing the real method to
  // `organization=~2`. Every existing reference to that method silently moved.
  rubyOwnDefs: ReadonlySet<string>;
  // Ruby (M3b): the nearest enclosing class's SCOPE PATH, dotted exactly as
  // bindings.ts stores it. `enclosingClass` is only the bare name, and an `@ivar`
  // binding is filed under the full path — reconstructing it from `scope` at each
  // call site is how the two walks drift apart.
  rubyClassScope: string | null;
  // Ruby (M3b): what `self` IS here — an instance of the enclosing class, or the
  // class object. `def self.x`, `class << self` and a class body are all the class
  // object, and it answers a different set of methods than an instance does. This
  // is both the receiver kind of a bare `self` call and the slot an `@ivar` here
  // belongs to.
  rubySelfKind: RubySelfContext;
  // Ruby (M3b): does a `def` in this body ALSO become a singleton method on the
  // module? `module_function` and `extend self` both say yes, and 112 of dailywerk's
  // service modules are written that way — `Tool::Denials.reject(...)` calls an
  // ordinary `def reject` through it. Such a method answers BOTH chains, so it is
  // emitted with no `receiver` at all rather than a claim to one.
  rubyModuleFunction: boolean;
  // Ruby (M3b): are we inside a concern's `class_methods do ... end`? `self` there is
  // the INCLUDER CLASS at run time, so a bare call in one of its methods is a class
  // method call — `requiring_workos_sync` calling the `scope :workos_pending_sync`
  // its own concern declared is the shape, and reading `self` as an instance lost it.
  rubyInClassMethods: boolean;
}

/** What the Ruby macro extractor needs to know about the surrounding Rails app. */
export interface RailsContext {
  /** `inflect.acronym` overrides, so `has_many :api_clients` infers `APIClient`. */
  acronyms: ReadonlyMap<string, string>;
}

/** Options threaded into a single file's extraction. Absent → the plain-language
 * behaviour, which is what every non-Ruby language and every non-Rails repo gets. */
export interface ExtractOptions {
  rails?: RailsContext | null;
}

/** A definition we're about to emit, normalized across the shapes we handle. */
interface DefDescriptor {
  name: string; // the bare symbol name (used for the node's `name` and call resolution)
  idName?: string; // id-scope segment when it differs from `name` (Go: `Receiver.method`)
  kind: Kind;
  headerEnd: number; // char index where the signature ends (body starts)
  hashNode: Parser.SyntaxNode; // node whose text forms body_hash / span
  // A method whose owner can't be read off ctx.enclosingClass because the
  // definition doesn't lexically nest inside its class. C++ out-of-line
  // definitions (`void Foo::bar() {}`) and R's S3/S4 methods both sit at
  // file/namespace scope, dispatched by qualifier/name rather than nesting —
  // same idea as Go's receiver-qualified methods (mirrors that special-case
  // in walk()). R6 methods DO nest (inside the class-defining call's own
  // public=/private=/active= lists) and rely on the ordinary
  // ctx.enclosingClass fallback instead, so they leave this unset.
  owner?: string;
  arity?: number; // declared parameter count — overload disambiguation (Java)
  variadic?: boolean; // last parameter is a vararg, so `arity` is a minimum
  receiver?: RubySelfKind; // Ruby: instance method vs `def self.` — see NodeV1.receiver
}

/** tree-sitter's string `parse()` fails with "Invalid argument" on any input
 * ≥ 32 KB, which silently drops large files — often the most important ones (a
 * 2000-line command module, a core tab implementation). The callback form has
 * no such limit as long as each returned chunk is under 32 KB, so we always feed
 * the source in <32 KB slices. Code-unit indexing matches `String.slice`. */
const PARSE_CHUNK = 16384;
function parseSource(source: string): Parser.SyntaxNode {
  return parser.parse((index: number) => source.slice(index, index + PARSE_CHUNK)).rootNode;
}

export function extractFile(rel: string, source: string, lang: Language, opts: ExtractOptions = {}): ExtractResult {
  parser.setLanguage(GRAMMARS[lang] as never);
  const root = parseSource(source);
  const bindings = collectBindings(root, lang, opts.rails != null);
  const importedSymbols = collectImportedSymbols(root, lang);
  const rGenerics = lang === "r" ? collectRGenerics(root) : EMPTY_SET;

  const nodes: NodeV1[] = [
    {
      id: rel,
      name: basename(rel),
      kind: "file",
      path: rel,
      span: `L1-L${root.endPosition.row + 1}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];

  const ctx: WalkCtx = {
    rel,
    source,
    lang,
    kinds: KINDS_BY_LANG[lang],
    scope: [],
    enclosingKind: null,
    parentId: rel,
    bindings,
    enclosingClass: null,
    goReceiverVar: null,
    importedSymbols,
    cppAccess: null,
    rR6Access: null,
    rGenerics,
    rSuperClass: null,
    rubyVisibility: "public",
    rubyPostHoc: EMPTY_MAP,
    rubyNesting: EMPTY_NESTING,
    rubyOwner: undefined,
    rubyRails: opts.rails ?? null,
    railsIvarRole: opts.rails ? railsIvarRole(rel) : null,
    rubyIncludedBlock: false,
    rubyOwnDefs: EMPTY_SET,
    rubyClassScope: null,
    rubySelfKind: "instance",
    rubyModuleFunction: false,
    rubyInClassMethods: false,
  };
  // Every id minted this file, seeded with the file node's own id (`rel`) so a
  // top-level definition can never collide with it. Threaded as its own
  // parameter rather than living on WalkCtx — WalkCtx is spread into every
  // childCtx, so a by-ref Set there would read as ordinary inherited context
  // when it's actually accidental shared mutable state across the whole walk.
  const minted = new Set<string>([rel]);
  walkNamedChildren(root.namedChildren, ctx, nodes, rawEdges, minted);
  // nodes[0] is the file node; the rest are its symbols. Index the module-level
  // residual on the file node so a term outside every symbol still surfaces it.
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}

/** Mint-time uniqueness: a document-order duplicate (same name reopened, or two
 * sibling defs that happen to collide) gets `~2`, `~3`, ... instead of silently
 * shadowing the first. The while-loop (not a single `~2` guess) is what makes
 * this collision-proof: a source name that itself ends in ~N would collide
 * with a single-guess suffix, so this keeps incrementing until it finds a
 * truly free id rather than trusting one candidate suffix is unused. */
export function mintId(base: string, minted: Set<string>): string {
  let id = base;
  let k = 2;
  while (minted.has(id)) id = `${base}~${k++}`;
  minted.add(id);
  return id;
}

/**
 * tree-sitter-php 0.23.x cannot parse a `const` inside an enum body (#145). An
 * array initializer collapses the whole `enum_declaration` into ERROR; the
 * method is recovered as a sibling `function_definition`. 0.24.2 parses this
 * natively but is ABI 15 and cannot load on Graft's tree-sitter 0.21.1.
 *
 * Bound: only an ERROR that already contains `enum_case` + `name` is treated as
 * a collapsed enum. Only `const_declaration` / `function_definition` /
 * `method_declaration` / ERROR siblings are absorbed, stopping at a `}` ERROR.
 * Unknown ERROR nodes are still walked, never mapped to a type. Clean
 * class/enum trees are `class_declaration` / `enum_declaration` and skip this.
 */
function phpCollapsedEnumName(node: Parser.SyntaxNode): string | null {
  if (node.type !== "ERROR") return null;
  if (!node.namedChildren.some((c) => c.type === "enum_case")) return null;
  return node.namedChildren.find((c) => c.type === "name")?.text ?? null;
}

function phpCollapsedEnumHold(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "const_declaration" ||
    node.type === "function_definition" ||
    node.type === "method_declaration" ||
    node.type === "ERROR"
  );
}

function phpCollapsedEnumClose(node: Parser.SyntaxNode): boolean {
  return node.type === "ERROR" && node.text.trim() === "}";
}

function walkNamedChildren(
  children: Parser.SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  if (ctx.lang !== "php") {
    for (const child of children) walk(child, ctx, out, edges, minted);
    return;
  }
  for (let i = 0; i < children.length; ) {
    const n = children[i]!;
    const enumName = phpCollapsedEnumName(n);
    if (enumName) {
      const group: Parser.SyntaxNode[] = [n];
      let j = i + 1;
      while (j < children.length && phpCollapsedEnumHold(children[j]!)) {
        const next = children[j]!;
        group.push(next);
        j++;
        if (phpCollapsedEnumClose(next)) break;
      }
      emitPhpCollapsedEnum(enumName, n, group, ctx, out, edges, minted);
      i = j;
      continue;
    }
    walk(n, ctx, out, edges, minted);
    i++;
  }
}

function emitPhpCollapsedEnum(
  name: string,
  errorNode: Parser.SyntaxNode,
  group: Parser.SyntaxNode[],
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
): void {
  const last = group[group.length - 1]!;
  const id = mintId(`${ctx.rel}#${[...ctx.scope, name].join(".")}`, minted);
  const body = ctx.source.slice(errorNode.startIndex, last.endIndex);
  out.push({
    id,
    name,
    kind: "enum",
    path: ctx.rel,
    span: `L${errorNode.startPosition.row + 1}-L${last.endPosition.row + 1}`,
    signature: `enum ${name}`,
    exported: true,
    origin: "ast",
    body_hash: contentHash(body),
    body_text: searchBody(body),
    summary_state: "pending",
    summary: null,
    crux: null,
  });
  edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
  const childCtx: WalkCtx = {
    ...ctx,
    scope: [...ctx.scope, name],
    enclosingKind: "enum",
    parentId: id,
  };
  for (const g of group) {
    if (phpCollapsedEnumClose(g)) continue;
    if (phpCollapsedEnumName(g)) {
      walkNamedChildren(g.namedChildren, childCtx, out, edges, minted);
      continue;
    }
    walk(g, childCtx, out, edges, minted);
  }
}

function walk(node: Parser.SyntaxNode, ctx: WalkCtx, out: NodeV1[], edges: RawEdge[], minted: Set<string>): void {
  if (ctx.lang === "ruby") {
    if (rubyUnknownFactoryBlock(node)) return;
    const mutation = rubyClassMutationTarget(node, ctx);
    if (mutation) edges.push({ source: ctx.parentId, relation: "references", file: ctx.rel,
      ...mutation, nesting: [...ctx.rubyNesting], rubyClassMutation: true, rubyTypeOnly: true });
  }
  // A block written in a class body, whose method this pass does not recognize.
  // minitest's `test "…" do … end` becomes an INSTANCE method; Rails' `included do …
  // end` runs in the includer's class body; the syntax is identical and only the
  // caller knows which. Reading every one of them as the class body dropped 927 real
  // calls into dailywerk's own test helpers in a single run, so `self` here is
  // declared unknown and the lookup tries both chains rather than picking one.
  // Mirrors bindings.ts's rule exactly — see `RubySelfContext`. The blocks this pass
  // DOES recognize (`included do`, `class_methods do`, a `scope` lambda, a
  // `define_method` body) never reach here: each is consumed by a branch below that
  // walks the block's CHILDREN with the reading it knows to be right.
  if (ctx.lang === "ruby" && (rubyBlockSelfContext(node, ctx.rubySelfKind) !== ctx.rubySelfKind || rubyBlockClassScope(node, ctx.rubyClassScope) !== ctx.rubyClassScope)) {
    walkNamedChildren(node.namedChildren, { ...ctx, rubySelfKind: rubyBlockSelfContext(node, ctx.rubySelfKind),
      rubyClassScope: rubyBlockClassScope(node, ctx.rubyClassScope) }, out, edges, minted);
    return;
  }
  // M4: the controller↔template instance-variable contract. Emitted here, before
  // anything consumes the node, because `@documents = …` is an assignment rather than
  // a call and the branches below never see it as one.
  if (ctx.rubyRails && ctx.railsIvarRole) rubyIvarEdges(node, ctx, edges);
  // A class declaration inside Class.new's block writes into the lexical
  // namespace, not the anonymous class's self. Keep ids aligned with that same
  // cref; constant lookup alone cannot repair a wrongly owned definition node.
  if (ctx.lang === "ruby" && ctx.rubyOwner !== ctx.rubyNesting[0] &&
      (node.type === "class" || node.type === "module" || rubyNamedClassFactory(node))) {
    const scope = ctx.rubyNesting[0]?.split("::") ?? [];
    const parentId = scope.length ? `${ctx.rel}#${scope.join(".")}` : ctx.rel;
    ctx = { ...ctx, scope, parentId };
  }
  const desc = describe(node, ctx);
  if (desc) {
    // `idName` scopes the id (e.g. a Go method under its receiver: `#DB.Count`) while
    // `name` stays the bare symbol name so member-call resolution matches it.
    const idPart = desc.idName ?? desc.name;
    const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
    const id = mintId(base, minted);
    const isGoMethod = ctx.lang === "go" && node.type === "method_declaration";
    // The bare name of this node's OWN immediate enclosing class/receiver — for a
    // Go method that's its receiver type (methods aren't nested, so ctx.enclosingClass
    // wouldn't see it); for a C++ out-of-line definition (`Foo::bar() {}`) or an R
    // S3/S4 method it's the qualifier/class describeCpp/describeR already resolved
    // (desc.owner — these don't lexically nest inside their class either); for
    // every other method it's simply what the nearest ancestor class
    // already set as ctx.enclosingClass. Only method nodes carry it — resolve.ts's
    // ownerMethod index is the sole consumer (see NodeV1.owner's doc comment).
    const owner: string | undefined =
      desc.kind === "method"
        ? (isGoMethod ? (goReceiverType(node) ?? undefined) : (desc.owner ?? ctx.enclosingClass ?? undefined))
        : undefined;
    out.push({
      id,
      name: desc.name,
      kind: desc.kind,
      path: ctx.rel,
      span: `L${desc.hashNode.startPosition.row + 1}-L${desc.hashNode.endPosition.row + 1}`,
      signature: clean(ctx.source.slice(desc.hashNode.startIndex, desc.headerEnd)),
      exported:
        ctx.lang === "python"
          ? !desc.name.startsWith("_")
          : ctx.lang === "go"
            ? goExported(desc.name)
            : ctx.lang === "cpp"
              ? cppExported(ctx)
              : ctx.lang === "r"
                ? rExported(desc.name, ctx, node)
                : ctx.lang === "ruby"
                  ? rubyExported(desc.name, ctx)
                  : ctx.lang === "java"
                    ? javaExported(node)
                    : ctx.lang === "kotlin"
                      ? kotlinExported(node)
                      : ctx.lang === "swift"
                        ? swiftExported(node)
                        : ctx.lang === "php"
                          ? phpExported(node)
                          : tsExported(node),
      origin: "ast",
      body_hash: contentHash(desc.hashNode.text),
      body_text: searchBody(desc.hashNode.text),
      summary_state: "pending",
      summary: null,
      crux: null,
      ...(owner !== undefined ? { owner } : {}),
      ...(desc.arity !== undefined ? { arity: desc.arity } : {}),
      ...(desc.variadic ? { variadic: true } : {}),
      ...(desc.receiver !== undefined ? { receiver: desc.receiver } : {}),
    });
    // structural containment
    edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
    // class heritage — in Java an interface may also `extends`, and a record/enum
    // may `implements`, so every type declaration is a heritage site, not just a class.
    const javaTypeDecl = ctx.lang === "java" && JAVA_TYPE_KINDS.has(desc.kind);
    const kotlinTypeDecl = ctx.lang === "kotlin" && KOTLIN_TYPE_KINDS.has(desc.kind);
    const swiftTypeDecl = ctx.lang === "swift" && SWIFT_TYPE_KINDS.has(desc.kind);
    if (desc.kind === "class" || desc.kind === "struct" || javaTypeDecl || kotlinTypeDecl || swiftTypeDecl)
      edges.push(...heritageEdges(node, id, ctx));
    if (ctx.lang === "php") edges.push(...phpAttributeReferenceEdges(node, id, ctx));
    if (ctx.lang === "java") edges.push(...javaAnnotationReferenceEdges(node, id, ctx));

    // Ruby modules own methods and are mixin targets exactly like classes do
    // (see Phase 4) — `enclosingClass` is reused as the generic "nearest
    // owning type" slot, not literally class-only.
    const rubyModuleDecl = ctx.lang === "ruby" && desc.kind === "module";
    const enclosingClass =
      desc.kind === "class" ||
      desc.kind === "struct" ||
      rubyModuleDecl ||
      javaTypeDecl ||
      kotlinTypeDecl ||
      swiftTypeDecl
        ? desc.name
        : isGoMethod
          ? goReceiverType(node)
          : (desc.owner ?? ctx.enclosingClass);
    const rubyFactory = ctx.lang === "ruby" ? rubyNamedClassFactory(node) : null;
    const rubyBodyOwner = rubyFactory?.block ?? node;
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, idPart],
      enclosingKind: desc.kind,
      parentId: id,
      enclosingClass,
      goReceiverVar: isGoMethod ? goReceiverVarOf(node) : ctx.goReceiverVar,
      importedSymbols:
        desc.kind === "function" || desc.kind === "method"
          ? withoutShadowedImports(ctx.importedSymbols, node)
          : ctx.importedSymbols,
      cppAccess:
        ctx.lang === "cpp" && (desc.kind === "class" || desc.kind === "struct")
          ? (desc.kind === "class" ? "private" : "public")
          : ctx.cppAccess,
      // Reset on every new definition — this is a purely local marker for "we're
      // still inside THIS class-defining call's own public=/private=/active=
      // argument chain," not something that should leak into a nested definition
      // (a method's own body, or — vanishingly rare but possible — another class
      // defined inside one).
      rR6Access: null,
      // Unlike rR6Access, only reset when entering a genuinely new class (so it
      // stays live through a method's whole body, where super$ / super. calls
      // actually happen) — inherited unchanged for every other definition kind.
      // Swift reads it off the declaration's own `:` clause, so `super.ping()`
      // resolves against the PARENT type, not the overriding current one.
      rSuperClass:
        desc.kind === "class"
          ? ctx.lang === "r"
            ? rR6ParentClass(node)
            : ctx.lang === "swift"
              ? swiftSuperClassName(node)
              : null
          : ctx.rSuperClass,
      rubyVisibility:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module") ? "public" : ctx.rubyVisibility,
      rubyPostHoc:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? rubyPostHocVisibility(rubyBodyOwner)
          : ctx.rubyPostHoc,
      rubyOwnDefs:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? rubyOwnDefNames(rubyBodyOwner)
          : ctx.rubyOwnDefs,
      rubyOwner:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? rubyCref(ctx.rubyNesting[0], idPart) : ctx.rubyOwner,
      rubyNesting:
        ctx.lang === "ruby" && !rubyFactory && (desc.kind === "class" || desc.kind === "module")
          ? [rubyCref(ctx.rubyNesting[0], idPart), ...ctx.rubyNesting]
          : ctx.rubyNesting,
      // A class defined inside an `included do` block is its own subject; the
      // re-attribution applies to declarations made ON the includer, not to
      // everything lexically underneath the block.
      rubyIncludedBlock:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? false
          : ctx.rubyIncludedBlock,
      // Mirrors bindings.ts's own walk exactly — the two scope stacks have to agree
      // on the key an `@ivar` is filed under, and a divergence here is silent.
      rubyClassScope:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? [...ctx.scope, idPart].join(".")
          : ctx.rubyClassScope,
      // `extend self` applies to the whole module regardless of where it is written
      // (verified: a `def` ABOVE it is reachable as a class method too), so it is
      // pre-scanned when the body is entered. `module_function` is forward-only and
      // is handled in the body walk, exactly as `private` is.
      rubyModuleFunction:
        ctx.lang === "ruby" && (desc.kind === "class" || desc.kind === "module")
          ? rubyExtendsSelf(rubyBodyOwner)
          : ctx.rubyModuleFunction,
      rubySelfKind:
        ctx.lang !== "ruby"
          ? ctx.rubySelfKind
          : desc.kind === "class" || desc.kind === "module" || node.type === "singleton_method"
            ? "class"
            : node.type === "method"
              ? (rubyInSingletonClass(node) || ctx.rubyInClassMethods ? "class" : "instance")
              : ctx.rubySelfKind,
    };
    // M3: a method whose every exit agrees on one class declares its own return
    // type, which is what lets `current_user.can_delete_account?` resolve — the
    // reader is hand-written, so no Rails macro states what it yields. A carrier,
    // never an edge; see `RawEdge.rubyTypeOnly`.
    if (ctx.lang === "ruby" && (desc.kind === "method" || desc.kind === "function")) {
      const returns = rubyMethodReturnType(node, rubyTypeCtx(childCtx));
      if (returns) {
        edges.push({
          source: id,
          relation: "references",
          name: returns.fqn,
          file: ctx.rel,
          nesting: [...ctx.rubyNesting],
          rubyReturnsFor: id,
          rubyReturnsKind: returns.kind,
          ...(returns.finder ? { rubyReturnsAssumesModel: true } : {}),
          rubyTypeOnly: true,
        });
      }
    }
    const bodyNodeStart = out.length;
    const bodyEdgeStart = edges.length;
    walkNamedChildren(rubyFactory ? rubyFactory.block?.namedChildren ?? [] : node.namedChildren, childCtx, out, edges, minted);
    if (rubyFactory) {
      for (let i = bodyEdgeStart; i < edges.length; i++) {
        edges[i].rubyFactoryDependencies = [...(edges[i].rubyFactoryDependencies ?? []), id];
      }
      for (let i = bodyNodeStart; i < out.length; i++) edges.push({ source: id, targetId: out[i].id,
        relation: "contains", file: ctx.rel, rubyTypeOnly: true, rubyFactoryDependencies: [id] });
    }
    return;
  }

  if (ctx.lang === "ruby") {
    for (const declaration of rubyBindingDeclarations(node)) {
      const { name, value, parameter } = declaration;
      if (name.startsWith("@@") || name.startsWith("$")) continue;
      const single = ctx.bindings.hasSingleRubyWrite(rubyScopeKey(name, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind), name);
      edges.push({ source: ctx.parentId, file: ctx.rel, relation: "references", rubyTypeOnly: true,
        rubyOwnerFqn: ctx.rubyOwner,
        rubyClassAliasBinding: { key: rubyBindingKey(name, ctx), value: rubyClassAliasValue(value, ctx) },
        rubyBinding: { key: rubyBindingKey(name, ctx), ...(parameter ? { parameter } : {}),
          value: single && (parameter || node.type === "assignment") ? rubyBindingValue(value, ctx) : null } });
    }
  }

  // C++ visibility is stateful: an `access_specifier` token inside a class/struct
  // body applies to every subsequent sibling until the next one, so this walks
  // `field_declaration_list`'s children by hand, tracking the current level, rather
  // than letting the generic recursion below hand every child the same ctx.
  if (ctx.lang === "cpp" && node.type === "field_declaration_list") {
    let access = ctx.cppAccess;
    for (const child of node.namedChildren) {
      if (child.type === "access_specifier") {
        access = child.text as "public" | "private" | "protected";
        continue;
      }
      walk(child, { ...ctx, cppAccess: access }, out, edges, minted);
    }
    return;
  }

  // R6 (Phase 2): `public =`/`private =`/`active =` inside an R6Class(...) call's
  // own arguments is a `list(...)` call whose named entries become methods —
  // this is R's version of a class body, but structurally it's several levels of
  // ordinary call/argument nodes rather than a dedicated grammar construct, so it
  // needs its own interception (mirrors how every other stateful/pattern-matched
  // R construct in this walk needs one). `ctx.enclosingKind === "class"` scopes
  // this to the class-defining call's own direct structure — once we're inside
  // an actual method's body, enclosingKind has moved on to "method" and an
  // unrelated nested `list(public = list(fn = function() {}))` elsewhere won't
  // be misread as another class body.
  if (
    ctx.lang === "r" &&
    ctx.enclosingKind === "class" &&
    ctx.rR6Access === null &&
    node.type === "argument"
  ) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (
      argName?.type === "identifier" &&
      (argName.text === "public" || argName.text === "private" || argName.text === "active") &&
      value?.type === "call" &&
      rCalleeName(value) === "list"
    ) {
      const access = argName.text;
      for (const entry of rCallArgs(value)) {
        walk(entry, { ...ctx, rR6Access: access }, out, edges, minted);
      }
      return;
    }
  }

  // not a definition — capture calls/imports/references, then descend with the same context
  // R's `call` node is also its ONLY vehicle for library()/require()/source() —
  // there's no separate import-statement grammar construct to key off, so isImport
  // must be checked before the generic calls path or every import call would be
  // captured as a (harmlessly unresolvable, but wrong) `calls` edge instead.
  // Bare `super` is its own AST node; parenthesized forms wrap that node in a
  // call. Capture the keyword once, retaining the enclosing method's identity.
  if (ctx.lang === "ruby" && node.type === "super" && ctx.rubyOwner) {
    edges.push({ source: ctx.parentId, relation: "calls", name: ctx.scope.at(-1), file: ctx.rel,
      rubySuper: true, rubyOwnerFqn: ctx.rubyOwner, rubyRecvKind: ctx.rubySelfKind });
  }
  const callTypes = CALL_TYPES[ctx.lang];
  if (isImport(node, ctx.lang)) {
    const spec = importSpecifier(node, ctx.lang);
    if (spec) edges.push({ source: ctx.rel, relation: "imports", specifier: spec, file: ctx.rel });
    // Imported identifiers are declarations, not uses. The import-binding pass
    // above already recorded them, so do not descend and emit false references.
    return;
  } else if (
    (ctx.lang === "typescript" || ctx.lang === "tsx") &&
    node.type === "export_statement" &&
    node.childForFieldName("source")
  ) {
    // `export { Select } from './select'` produced nothing at all: not the dependency
    // on `./select`, and no record that this module offers the name. An importer of
    // the barrel therefore reached a module that does not define what it asked for,
    // and resolution either dropped the edge or fell through to a repo-wide name
    // match. Both halves are recorded here; resolve.ts walks them.
    //
    // The `source` field is what separates a re-export from a plain `export { x }`,
    // which names no module and must stay untouched.
    for (const e of reexportEdges(node, ctx.rel)) edges.push(e);
    // The names in an export clause are declarations of what this module exposes,
    // not uses of anything, so descending would only emit false references.
    return;
  } else if (callTypes.has(node.type)) {
    // R6Class(...) / a Phase-5 mixin list(...) is already consumed by its
    // enclosing binary_operator as the class definition (see describeR) — the
    // walk still reaches this SAME call node again, recursing generically to
    // find its public=/private=/active= arguments (there's no other path to
    // them), and it must not ALSO be treated as an ordinary call to a
    // function literally named "R6Class"/"list".
    const rubyMixins = ctx.lang === "ruby" && ctx.enclosingClass !== null ? rubyMixinTargets(node) : null;
    if (rubyMixins) {
      if (rubyMixins.unknown) edges.push({
        source: ctx.parentId, relation: "extends", file: ctx.rel,
        nesting: [...ctx.rubyNesting], rubyOwnerFqn: ctx.rubyOwner,
        rubyHeritage: rubyMixins.keyword, rubyHeritageUnknown: true, rubyTypeOnly: true,
      });
      for (const target of rubyMixins.targets) {
        edges.push({
          source: ctx.parentId,
          relation: "extends",
          name: target,
          file: ctx.rel,
          nesting: [...ctx.rubyNesting],
          rubyHeritage: rubyMixins.keyword,
        });
      }
      // Retaining the unresolved composition must not swallow calls that compute
      // its argument, such as a locally defined factory().
      if (rubyMixins.unknown) for (const child of node.childForFieldName("arguments")?.namedChildren ?? []) {
        walk(child, ctx, out, edges, minted);
      }
      return;
    }
    if (ctx.lang === "ruby" && ctx.enclosingClass !== null) {
      const synthesized = rubySynthesizedMethods(node, ctx);
      if (synthesized.length > 0) {
        for (const s of synthesized) emitRubySynthesizedMethod(s, ctx, out, edges, minted, "ast");
        return;
      }
      // An `ActiveSupport::Concern`'s `included do ... end`. Its body is ordinary
      // class-body syntax, so it is walked with the same ctx plus the marker that
      // sends whatever it declares to the concern's includers.
      // `class_methods do ... end` in an ActiveSupport::Concern. Rails turns the block
      // into a nested `module ClassMethods` and `extend`s that into every includer, so
      // what it declares are the INCLUDER's class methods — not its instance methods,
      // and not the concern's own singleton methods, which `include` never hands over.
      // Filed under the name Rails itself gives the module, which is also where a
      // hand-written `module ClassMethods` already lands, so one lookup finds both.
      const classMethodsBody = ctx.rubyRails ? rubyClassMethodsBlock(node) : null;
      if (classMethodsBody) {
        const cmCtx: WalkCtx = {
          ...ctx,
          scope: [...ctx.scope, RUBY_CLASS_METHODS],
          enclosingClass: RUBY_CLASS_METHODS,
          // `rubyNesting` deliberately UNCHANGED: `class_methods do` is a block, not a
          // lexical scope, so a constant written inside it resolves against the
          // concern exactly as one written beside it does — and `rubyOwnerFqn` then
          // names the concern, which is where its own macros are filed.
          rubyClassScope: [...ctx.scope, RUBY_CLASS_METHODS].join("."),
          rubyOwnDefs: EMPTY_SET,
          rubyInClassMethods: true,
        };
        for (const child of classMethodsBody.namedChildren) walk(child, cmCtx, out, edges, minted);
        return;
      }
      const includedBody = ctx.rubyRails ? rubyIncludedDoBlock(node) : null;
      if (includedBody) {
        for (const child of includedBody.namedChildren) {
          walk(child, { ...ctx, rubyIncludedBlock: true }, out, edges, minted);
        }
        return;
      }
      if (ctx.rubyRails) {
        const macroMethods = rubyMacroMethods(node, ctx);
        const macroEdges = rubyMacroEdges(node, ctx, ctx.parentId);
        const declared = macroMethods.filter((m) => !ctx.rubyOwnDefs.has(m.name));
        if (declared.length > 0 || macroEdges.length > 0) {
          const mintedIds = new Map<string, string>();
          for (const m of declared) {
            mintedIds.set(m.name, emitRubySynthesizedMethod(m, ctx, out, edges, minted, "synthesized"));
          }
          const reader = rubyAssociationReader(node);
          const readerId = reader ? mintedIds.get(reader) : undefined;
          // M3: the association reader is the one method in a Rails app whose
          // RETURN type is declared. Tag the constant reference the macro already
          // emits with the reader's node id rather than minting a second edge for
          // a fact the first one carries — resolve.ts then knows that calling this
          // method yields that class, which is what makes `blog.posts.recent`
          // resolvable at all. A reader the class overrides with a real `def` is
          // not minted, so it gets no id and no declared type, which is right: a
          // hand-written `def posts` returns whatever its body returns.
          if (readerId) {
            const macroName = node.childForFieldName("method")?.text ?? "";
            for (const me of macroEdges) {
              if (me.relation !== "references") continue;
              me.rubyReturnsFor = readerId;
              me.rubyReturnsKind = rubyAssociationKind(macroName);
            }
          }
          edges.push(...macroEdges);
          edges.push(...rubyDelegateForwards(node, ctx, mintedIds));
          // An association extension (`has_many :things do def latest; end end`)
          // carries a block none of the synthesized methods claimed. Rails defines
          // those methods on the association PROXY — `blog.posts.latest` — and not on
          // the model, so minting `Blog#latest` invents a method the class does not
          // have, and a false method is not inert: `before_save :latest` could then
          // bind to it. Scope them under the generated reader, the closest thing the
          // graph has to that proxy, and keep walking so nothing inside is lost —
          // consuming a macro without descending is how `scope` silently dropped
          // every call in its own body.
          const trailing = node.childForFieldName("block");
          if (trailing && !declared.some((m) => sameSyntaxNode(m.hashNode, trailing))) {
            const blockCtx: WalkCtx =
              reader && readerId
                ? { ...ctx, scope: [...ctx.scope, reader], parentId: readerId, enclosingClass: reader }
                : ctx;
            for (const child of trailing.namedChildren) walk(child, blockCtx, out, edges, minted);
          }
          // Return, so the macro call does not ALSO become an ordinary call edge to
          // a function literally named `has_many` — the same reason the mixin and
          // `attr_*` branches above return.
          return;
        }
      }
    }
    // M4: Rails' render vocabulary, additively — a `render "shared/nav"` is both a
    // template reference and (harmlessly) an ordinary call to a method no repo
    // defines. Placed here rather than in the class-body macro table above because
    // `render` is written inside method bodies and at a template's top level, never
    // as a class-body declaration.
    if (ctx.lang === "ruby" && ctx.rubyRails && node.type === "call") {
      edges.push(...rubyRenderEdges(node, ctx));
    }
    const consumedCallee = ctx.lang === "r" && node.type === "call" ? rCalleeName(node) : null;
    const isConsumedRClassCall =
      consumedCallee === "R6Class" || (consumedCallee === "list" && rIsMixinContainer(node));
    const named = isConsumedRClassCall ? null : calleeName(node, ctx);
    // `await onSubmit?.(values)` inside a React component calls a PROP. The name is
    // declared in the component's own props type and destructured out of its
    // parameter, so nothing in the repository defines it and the only correct answer
    // is no edge. The edge was emitted anyway and resolve.ts had nowhere good to send
    // it: a bare name carries no specifier, so it goes around #335's module gate into
    // the repo-wide unique-name tier, which bound production code to a Storybook
    // story's `onSubmit` at `inferred` (corpus dw-h11-032) and put 14 more edges from
    // production into `.stories.`/`.test.` files. Dropping it here rather than
    // teaching resolution a better guess is the point: the callee is a value this
    // function was handed, and no amount of name matching can make that a definition.
    //
    // PARAMETERS ONLY, and that restriction is load-bearing. A nested
    // `const notify = () => {}` or `function later() {}` MINTS A NODE, so its call
    // already resolves same-file at `extracted` — suppressing local declarations too
    // would throw those away. A parameter is the binding form that never mints one.
    const callee = named && isLocalParameterCall(node, named, ctx) ? null : named;
    if (callee) {
      // A bare TypeScript call through a named import carries where the callee
      // comes from. `ctx.importedSymbols` already excludes bindings shadowed by
      // a local declaration in scope, so `useRouter()` under a local
      // `function useRouter` stays a bare name. Without this, resolve.ts's
      // unique-name fallback bound a call to `useRouter` from "next/navigation"
      // to an unrelated test mock of the same name (#330).
      const imported =
        !callee.viaMember && (ctx.lang === "typescript" || ctx.lang === "tsx")
          ? ctx.importedSymbols.get(callee.name)
          : undefined;
      const callEdge: RawEdge = {
        source: ctx.parentId,
        relation: "calls",
        name: imported ? imported.name : callee.name,
        viaMember: callee.viaMember,
        file: ctx.rel,
        ...(imported ? { specifier: imported.specifier } : {}),
        ...(callee.kinds ? { kinds: callee.kinds } : {}),
      };
      if (ctx.lang === "ruby") callEdge.rubyArguments = rubyKeywordArguments(node, ctx);
      // Overloading languages: the call site's argument count, to pick the right
      // overload (see RawEdge.argCount).
      const argCount =
        ctx.lang === "java" ? javaArgCount(node) : ctx.lang === "swift" ? swiftArgCount(node) : undefined;
      if (argCount !== undefined) callEdge.argCount = argCount;
      // Swift: a bare lowercase call inside a type body may be an implicit-`self`
      // member call (`walk()` for `self.walk()`), syntactically indistinguishable
      // from a free-function call — and Swift's own lookup is member-FIRST (inner
      // scope wins). So the edge is emitted as the member reading, typed to the
      // enclosing class — resolved through the owner-qualified method index and
      // the class's in-repo ancestor chain (`clearLogs()` in a test subclass
      // finds the base class's method) — with `implicitSelf` letting resolve.ts
      // fall back to the free-function reading only when no member exists on the
      // chain. One edge, both readings, language-order precedence. This is
      // deliberately NOT a bare-name kind widening: dogfooding on
      // swift-composable-architecture, a global unique-name match bound
      // `contains(element)` inside `extension Set` — a stdlib call — to an
      // unrelated type's only in-repo `contains`. And not for an UpperCamelCase
      // callee: that is an initializer call (`Text("hi")`), which takes
      // resolve.ts's class/struct/enum fallback instead — extension nodes (kind
      // "module") can never false-match it.
      const swiftImplicitSelf =
        ctx.lang === "swift" &&
        !callee.viaMember &&
        !callee.kinds &&
        ctx.enclosingClass &&
        !/^[A-Z]/.test(callee.name);
      if (swiftImplicitSelf) {
        edges.push({
          ...callEdge,
          viaMember: true,
          recvType: ctx.enclosingClass!,
          implicitSelf: true,
        });
      } else if (callee.ruby) {
        // Ruby (M3): the receiver's type, however it was established, travels as
        // its own fields — `recvType` is a BARE class name and Ruby resolution is
        // fully-qualified, which is the distinction M1 and M2 were built on.
        edges.push({ ...callEdge, ...callee.ruby });
      } else {
        const recvType = callee.recvType ?? resolveRecvType(callee.receiver, ctx);
        edges.push(recvType ? { ...callEdge, recvType } : callEdge);
      }
    }
  } else if (ctx.lang === "ruby" && node.type === "identifier" && rubyBareCallPosition(node, ctx)) {
    // Ruby's optional parens mean a paren-less, argument-less method call
    // (`helper`) is syntactically indistinguishable from a local-variable
    // read — tree-sitter-ruby emits a plain `identifier` for both, unlike
    // `helper(1)` / `helper 1`, which get a real `call` node (see
    // `rubyCallee`'s own doc comment). Per spec ("bare `foo(...)`/`foo`...
    // resolve by name the same way R's Phase 1 does"), a bare word in one of the
    // two positions `rubyBareCallPosition` allows is a call candidate.
    //
    // M3 gave this an owner: inside a class the word is `self.<word>`, so it
    // resolves on that class and its ancestors FIRST and only falls back to the
    // bare-name ladder when nothing on the chain answers. That is also what makes
    // the receiver position safe to include — `organization.id` really does call
    // `attr_reader :organization`, and the two real call sites of filewerk's
    // `BulkActionsService#organization` are exactly that shape.
    const own = ctx.rubyOwner;
    edges.push({
      source: ctx.parentId,
      relation: "calls",
      name: node.text,
      viaMember: false,
      file: ctx.rel,
      // `function` only — see rubyCallee's no-receiver branch for why.
      kinds: ["function"],
      ...(own ? { rubyRecvBase: "self" as const, rubyOwnerFqn: own, rubyRecvKind: ctx.rubySelfKind } : {}),
      // A word standing alone as its own statement may still be a top-level
      // method, so it keeps the bare-name fallback. A word in RECEIVER position
      // does not: `foo.bar` where the class has no `foo` is a receiver this pass
      // cannot type, and answering it with whatever unique `foo` exists elsewhere
      // in the repo is the exact guess M3 exists to stop making.
      ...(own && node.parent?.type === "body_statement" ? { implicitSelf: true as const } : {}),
    });
  } else if (
    ctx.lang === "ruby" &&
    (node.type === "constant" || node.type === "scope_resolution") &&
    rubyConstPath(node) !== null // `obj::CONST` falls through: its head may hold calls
  ) {
    // M1: a constant reference, carrying the nesting chain it must be resolved
    // against. `raise CrossTenantAccessError` produced NOTHING under M0 — nine
    // raise sites in filewerk-rails pointing at a class the graph already had a
    // node for — because Ruby has no import statement, so there was no specifier
    // to key off and nothing else emitted a `references` edge for Ruby at all.
    //
    // A qualified path emits ONE edge, naming its terminal. Descending would also
    // emit the head (`TenantSecurity` for `TenantSecurity::CrossTenantAccessError`),
    // and on a real app that lands squarely on the module a `callers` query is
    // most often asked about — a second, wrong answer bolted onto a right one.
    // Hence the `return`: a scope_resolution's parts are not separate references.
    const path = isRubyConstantDefinition(node) ? null : rubyConstPath(node);
    if (path !== null) {
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: path,
        file: ctx.rel,
        nesting: [...ctx.rubyNesting],
      });
    } else if (isRubyConstantAssignment(node)) {
      // `MAX = 10` defines a constant that no node can represent — the value is an
      // integer, not a symbol. It still SHADOWS: `X` inside `module A` that declares
      // `X = 123` is `A::X`, and must never resolve to an unrelated top-level
      // `class X`. Recording the declaration lets resolve.ts stop at the level Ruby
      // stops at instead of walking past it. Qualified assignments retain their
      // path too: resolve.ts resolves the namespace before recording the terminal
      // identity, so `A::Job = object` cannot leave an old workflow target alive.
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: rubyConstPath(node)!,
        file: ctx.rel,
        nesting: [...ctx.rubyNesting],
        rubyConstDecl: true,
        rubyConstAlias: rubyClassAliasValue(node.parent?.childForFieldName("right") ?? null, ctx) ?? undefined,
      });
    }
    return;
  } else if (ctx.lang === "php" && node.type === "use_declaration") {
    // Trait composition inside a class body (`use HasFactory, Notifiable;`).
    // Modelled as `implements`: like an interface, a trait is a contract of
    // behaviour the class mixes in (Graft's Relation set has no `uses`).
    for (const t of node.namedChildren) {
      if (t.type === "name" || t.type === "qualified_name") {
        edges.push({ source: ctx.parentId, relation: "implements", name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
      }
    }
    return;
  } else if (
    (node.type === "identifier" || isTsTypeUse(node, ctx.lang)) &&
    !isDirectCallee(node, callTypes, ctx.lang) &&
    !isDeclarationName(node)
  ) {
    const imported = ctx.importedSymbols.get(node.text);
    if (imported) {
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: imported.name,
        specifier: imported.specifier,
        file: ctx.rel,
      });
    } else if (isTsTypeUse(node, ctx.lang) && !shadowedByTypeParameter(node)) {
      // A type the file declares itself is never in `importedSymbols`, so a file's own
      // types were the one thing it could not see — while a CALL to a same-file symbol
      // has always resolved. Reference and call disagreed about what a file can see of
      // itself, and every labelled miss left on the TypeScript corpus was this.
      //
      // No specifier, deliberately: resolve.ts binds a specifier-less TypeScript
      // reference against THIS file only and drops when the name is not uniquely
      // declared here. It must not fall through to a repo-wide unique name — a type
      // this file neither imports nor declares is not this file's to resolve.
      edges.push({
        source: ctx.parentId,
        relation: "references",
        name: node.text,
        file: ctx.rel,
      });
    }
  }

  if (ctx.lang === "ruby" && node.type === "body_statement") {
    let visibility = ctx.rubyVisibility;
    let moduleFunction = ctx.rubyModuleFunction;
    for (const child of node.namedChildren) {
      const switchTo = rubyVisibilitySwitch(child);
      if (switchTo) {
        visibility = switchTo;
        continue;
      }
      // A bare `module_function` applies to every `def` BELOW it and none above —
      // verified on Ruby 3.4, where the method defined before it raises NoMethodError
      // on the module. Same forward-only rule as `private`, so it rides the same walk.
      if (child.type === "identifier" && child.text === "module_function") {
        moduleFunction = true;
        continue;
      }
      const inline = rubyInlineVisibility(child);
      if (inline) {
        walk(inline.methodNode, { ...ctx, rubyVisibility: inline.visibility, rubyModuleFunction: moduleFunction }, out, edges, minted);
        continue;
      }
      walk(child, { ...ctx, rubyVisibility: visibility, rubyModuleFunction: moduleFunction }, out, edges, minted);
    }
    return;
  }

  // Java anonymous class (`new Type() { … }`): tree-sitter-java has no
  // `anonymous_class` node (unlike PHP) — the body is an optional `class_body`
  // on `object_creation_expression`. Mint `{anonymous}` (mirroring PHP #144 /
  // `{closure}`) so nested methods take that owner instead of the enclosing
  // type's, which otherwise pollutes `ownerMethod` and steals real call edges
  // (#161). The constructor call edge above still fires for `new Type()`.
  if (ctx.lang === "java" && node.type === "object_creation_expression") {
    const body = node.namedChildren.find((c) => c.type === "class_body");
    if (body) {
      const idPart = "{anonymous}";
      const base = `${ctx.rel}#${[...ctx.scope, idPart].join(".")}`;
      const id = mintId(base, minted);
      out.push({
        id,
        name: "{anonymous}",
        kind: "class",
        path: ctx.rel,
        span: `L${node.startPosition.row + 1}-L${node.endPosition.row + 1}`,
        signature: clean(ctx.source.slice(node.startIndex, body.startIndex)),
        exported: false,
        origin: "ast",
        body_hash: contentHash(node.text),
        body_text: searchBody(node.text),
        summary_state: "pending",
        summary: null,
        crux: null,
      });
      edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
      // Single supertype from `new Type()`: emit `implements` so an interface
      // target resolves (adapters are the common case; a class target drops
      // under resolve's implements kind filter — drop-not-guess).
      const superName = javaConstructedTypeName(node.childForFieldName("type"));
      if (superName) {
        edges.push({ source: id, relation: "implements", name: superName, file: ctx.rel });
      }
      const anonCtx: WalkCtx = {
        ...ctx,
        scope: [...ctx.scope, idPart],
        enclosingKind: "class",
        parentId: id,
        enclosingClass: "{anonymous}",
      };
      for (const child of node.namedChildren) {
        walk(child, child.type === "class_body" ? anonCtx : ctx, out, edges, minted);
      }
      return;
    }
  }

  for (const child of node.namedChildren) walk(child, ctx, out, edges, minted);
}

/**
 * Named imports whose local binding can be recognized later as a symbol use.
 * Namespace/default imports are intentionally excluded: they do not tell us
 * the exported symbol name, so wiring them would require guessing.
 */
function collectImportedSymbols(
  root: Parser.SyntaxNode,
  lang: Language,
): Map<string, { name: string; specifier: string }> {
  if (lang === "typescript" || lang === "tsx") {
    const out = new Map<string, { name: string; specifier: string }>();
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "import_statement") {
        const specifier = importSpecifier(node, lang);
        if (!specifier) return;
        collectTsImportBindings(node, specifier, out);
        return;
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return out;
  }
  if (lang === "php") return collectPhpImportedSymbols(root);
  return new Map();
}

/** PHP `use` bindings: local alias → { exported name, FQN specifier }. */
function collectPhpImportedSymbols(root: Parser.SyntaxNode): Map<string, { name: string; specifier: string }> {
  const out = new Map<string, { name: string; specifier: string }>();
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "namespace_use_declaration") {
      collectPhpUseDeclaration(node, out);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}

function collectPhpUseDeclaration(
  decl: Parser.SyntaxNode,
  out: Map<string, { name: string; specifier: string }>,
): void {
  const prefix = decl.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\\$/, "") ?? "";
  const clauses: Parser.SyntaxNode[] = [];
  for (const child of decl.namedChildren) {
    if (child.type === "namespace_use_clause") clauses.push(child);
    if (child.type === "namespace_use_group") {
      for (const c of child.namedChildren) {
        if (c.type === "namespace_use_clause") clauses.push(c);
      }
    }
  }
  for (const clause of clauses) {
    const binding = phpUseClauseBinding(clause, prefix);
    if (binding) out.set(binding.local, { name: binding.name, specifier: binding.specifier });
  }
}

function phpUseClauseBinding(
  clause: Parser.SyntaxNode,
  prefix: string,
): { local: string; name: string; specifier: string } | null {
  const names = clause.namedChildren.filter((c) => c.type === "name");
  const qualified = clause.namedChildren.find((c) => c.type === "qualified_name");
  let fqn: string;
  let importedName: string;
  if (qualified) {
    fqn = qualified.text.replace(/^\\/, "");
    importedName = fqn.replace(/^.*\\/, "");
  } else if (names[0]) {
    importedName = names[0].text;
    fqn = prefix ? `${prefix}\\${importedName}` : importedName;
  } else {
    return null;
  }
  const alias =
    qualified && names.length >= 1
      ? names[names.length - 1].text
      : names.length >= 2
        ? names[1].text
        : undefined;
  const local = alias ?? importedName;
  return { local, name: importedName, specifier: fqn };
}

/** PHP 8 attributes on a definition → `references` edges to the attribute class. */
function phpAttributeReferenceEdges(node: Parser.SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "attribute_list") continue;
    for (const group of child.namedChildren) {
      if (group.type !== "attribute_group") continue;
      for (const attr of group.namedChildren) {
        if (attr.type !== "attribute") continue;
        const ref = phpAttributeClassRef(attr, ctx);
        if (ref) {
          edges.push({
            source: sourceId,
            relation: "references",
            name: ref.name,
            ...(ref.specifier ? { specifier: ref.specifier } : {}),
            file: ctx.rel,
          });
        }
      }
    }
  }
  return edges;
}

function phpAttributeClassRef(
  attr: Parser.SyntaxNode,
  ctx: WalkCtx,
): { name: string; specifier?: string } | null {
  const nameNode =
    attr.childForFieldName("name") ??
    attr.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  if (!nameNode) return null;
  if (nameNode.type === "qualified_name") {
    const fqn = nameNode.text.replace(/^\\/, "");
    return { name: fqn.replace(/^.*\\/, ""), specifier: fqn };
  }
  const bare = nameNode.text;
  const imported = ctx.importedSymbols.get(bare);
  if (imported) return { name: imported.name, specifier: imported.specifier };
  return { name: bare };
}

/** Java annotations on a definition → `references` edges to the annotation type. */
function javaAnnotationReferenceEdges(node: Parser.SyntaxNode, sourceId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return edges;
  for (const child of mods.namedChildren) {
    if (child.type !== "marker_annotation" && child.type !== "annotation") continue;
    const name = javaAnnotationTypeName(child);
    if (name) {
      edges.push({
        source: sourceId,
        relation: "references",
        name,
        file: ctx.rel,
      });
    }
  }
  return edges;
}

/** The type named by `@Foo` / `@a.b.Foo(...)`. Arguments are ignored (issue #89).
 * A scoped name is kept whole, matching heritage: a bare last segment would
 * false-match an unrelated in-repo type (#103). */
function javaAnnotationTypeName(anno: Parser.SyntaxNode): string | null {
  const nameNode = anno.childForFieldName("name");
  if (!nameNode) return null;
  if (nameNode.type === "identifier" || nameNode.type === "scoped_identifier") return nameNode.text;
  return null;
}

function collectTsImportBindings(
  node: Parser.SyntaxNode,
  specifier: string,
  out: Map<string, { name: string; specifier: string }>,
): void {
  if (node.type === "import_specifier") {
    const name = node.childForFieldName("name")?.text;
    const local = node.childForFieldName("alias")?.text ?? name;
    if (name && local) out.set(local, { name, specifier });
    return;
  }
  for (const child of node.namedChildren) collectTsImportBindings(child, specifier, out);
}

/**
 * Do these two wrappers stand for the same syntax node? `===` does not answer that:
 * node-tree-sitter materializes `SyntaxNode` objects on demand and caches them
 * weakly, so reaching one node twice can return two different JS objects. Comparing
 * wrappers makes a purely syntactic question depend on collector timing — two cold
 * builds of unchanged source then disagree on `references` edges (#116).
 *
 * `id` is the stable identity, unique within one tree, so the tree is compared too.
 * A `Tree` is one object per parse (unlike its nodes), so `===` is right for it.
 */
function sameSyntaxNode(
  a: Parser.SyntaxNode | null | undefined,
  b: Parser.SyntaxNode | null | undefined,
): boolean {
  return !!a && !!b && a.tree === b.tree && a.id === b.id;
}

/**
 * A parameter or local declaration wins over an import inside that function.
 * Drop that imported binding for the whole function rather than create a false
 * dependency. Nested functions are separate scopes and filter themselves.
 */
function withoutShadowedImports(
  imports: ReadonlyMap<string, { name: string; specifier: string }>,
  definition: Parser.SyntaxNode,
): ReadonlyMap<string, { name: string; specifier: string }> {
  if (imports.size === 0) return imports;
  const shadowed = new Set<string>();
  const definitionValue = definition.childForFieldName("value");
  const visit = (node: Parser.SyntaxNode): void => {
    if (!sameSyntaxNode(node, definition) && !sameSyntaxNode(node, definitionValue) && isFunctionBoundary(node)) {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
      return;
    }
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") shadowed.add(name.text);
    } else if (node.type === "required_parameter" || node.type === "optional_parameter") {
      const pattern = node.childForFieldName("pattern");
      if (pattern?.type === "identifier") shadowed.add(pattern.text);
    } else if (node.type === "identifier" && node.parent?.type === "formal_parameters") {
      shadowed.add(node.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(definition);
  if (![...shadowed].some((name) => imports.has(name))) return imports;
  return new Map([...imports].filter(([local]) => !shadowed.has(local)));
}

/**
 * Is this bare call really a call to something a parameter bound?
 *
 * Confined to the JS/TS family (`.js`/`.jsx` parse with the `typescript`/`tsx`
 * grammars, so the two `ctx.lang` values cover all six extensions) because that is
 * where it is measured. The argument generalizes — a parameter is a value, not a
 * definition, in every language here — but a rule that drops edges has to be checked
 * against a corpus before it is widened, and Python and Go have none in this project.
 *
 * A member call is excluded: `o.onSubmit()` never took the bare-name path. So is an
 * imported name, which is bound at the top level and already module-confined.
 */
function isLocalParameterCall(
  node: Parser.SyntaxNode,
  callee: { name: string; viaMember: boolean },
  ctx: WalkCtx,
): boolean {
  if (ctx.lang !== "typescript" && ctx.lang !== "tsx") return false;
  if (callee.viaMember) return false;
  if (ctx.importedSymbols.has(callee.name)) return false;
  return boundByEnclosingParameter(node, callee.name);
}

/**
 * Walk out to the module's top level looking for a parameter that binds `name`.
 *
 * Stopping at `program` is the whole precision argument: a top-level binding is a
 * definition with a node, and T4's same-file `extracted` answers depend on it.
 * Only what is bound INSIDE some enclosing function counts.
 */
function boundByEnclosingParameter(node: Parser.SyntaxNode, name: string): boolean {
  for (let cur = node.parent; cur && cur.type !== "program"; cur = cur.parent) {
    if (cur.type === "catch_clause") {
      const caught = cur.childForFieldName("parameter");
      if (caught && patternBinds(caught, name)) return true;
      continue;
    }
    if (!isFunctionBoundary(cur)) continue;
    // An arrow with parentheses has `parameters`; `each => each()` has `parameter`.
    const params = cur.childForFieldName("parameters") ?? cur.childForFieldName("parameter");
    if (params && patternBinds(params, name)) return true;
  }
  return false;
}

/**
 * Does this parameter pattern bind `name`?
 *
 * Two fields are deliberately not followed, and both would produce a wrong answer in
 * the expensive direction — a dropped edge that nothing reports:
 *   - `pair_pattern`'s `key`. In `{ onSubmit: submit }` the binding is `submit`;
 *     `onSubmit` is a property name that exists only on the caller's object.
 *   - a parameter's `type_annotation`. `onSave?: (save: X) => void` contains a whole
 *     `formal_parameters` of its own, and recursing into it would let a type's
 *     parameter name suppress a real call to a function called `save`.
 *
 * An unrecognised node type answers `false` — it keeps today's behaviour rather than
 * silently widening a rule whose entire job is to remove edges.
 */
function patternBinds(node: Parser.SyntaxNode, name: string): boolean {
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return node.text === name;
    case "required_parameter":
    case "optional_parameter": {
      const pattern = node.childForFieldName("pattern");
      return pattern !== null && patternBinds(pattern, name);
    }
    case "pair_pattern": {
      const value = node.childForFieldName("value");
      return value !== null && patternBinds(value, name);
    }
    case "object_assignment_pattern":
    case "assignment_pattern": {
      const left = node.childForFieldName("left");
      return left !== null && patternBinds(left, name);
    }
    case "formal_parameters":
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return node.namedChildren.some((child) => patternBinds(child, name));
    default:
      return false;
  }
}

function isFunctionBoundary(node: Parser.SyntaxNode): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "method_definition" ||
    node.type === "arrow_function" ||
    node.type === "function_expression" ||
    node.type === "function"
  );
}

/** A direct invocation already emits a stronger `calls` edge. Java names the callee
 * in a `name` field (there is no `function` field on `method_invocation`), so both
 * spellings count. */
function isDirectCallee(
  node: Parser.SyntaxNode,
  callTypes: ReadonlySet<string>,
  lang: Language,
): boolean {
  // `await f<T>(x)` parses an `await_expression` in between the callee and its
  // call (see calleeExpression), so there the call is the GRANDparent. Without
  // this hop the callee would emit a `references` edge beside its `calls` edge,
  // where every other spelling of the same call emits only the call.
  const viaAwait =
    (lang === "typescript" || lang === "tsx") && node.parent?.type === "await_expression";
  const parent = viaAwait ? node.parent?.parent : node.parent;
  if (!parent || !callTypes.has(parent.type)) return false;
  return (
    sameSyntaxNode(calleeExpression(parent, lang), node) ||
    sameSyntaxNode(parent.childForFieldName("name"), node)
  );
}

/** Definition/declaration identifiers name a new binding; they do not use one. */
function isDeclarationName(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  return sameSyntaxNode(parent?.childForFieldName("name"), node);
}

/**
 * Is this node a TypeScript type POSITION — a use of a type, rather than a
 * declaration of one or a name that already has an edge of its own?
 *
 * Every TypeScript type position produces a `type_identifier`, never an `identifier`:
 * in `function f(input: TaskInput): Promise<TaskRecord>`, `f` and `input` are
 * `identifier` while `TaskInput`, `Promise` and `TaskRecord` are `type_identifier`.
 * The reference walk keyed on `identifier` alone, so a file's type dependencies were
 * invisible — a service module's contract with the rest of the app is mostly its
 * types, and `blast` could not see any of it.
 *
 * No allow-list of built-ins is needed and none should be added. This used to be the
 * import requirement's doing — `Promise`, `Array` and `Record` are not imported — and
 * since T4 emits for same-file types too, it is resolution's: no file declares them,
 * so the same-file lookup finds nothing and drops. Either way, by construction.
 *
 * Two positions are excluded, both because the name there is not the file's to
 * resolve:
 *
 *   - `A.B` parses as a `nested_type_identifier` whose `A` is an `identifier` and
 *     whose `B` is a `type_identifier`. `B` is a member of the namespace `A`, not a
 *     symbol this file imported, so binding it would reach for any same-named type
 *     anywhere — the unique-name failure this resolver exists to refuse.
 *   - A heritage clause already emits `extends`/`implements` from heritageEdges().
 *     `implements Iface` names its type with a `type_identifier`, so without this it
 *     would acquire a second, redundant `references` edge beside the first.
 */
/**
 * Is this `type_identifier` actually a type PARAMETER in scope, rather than the
 * same-named type the file declares?
 *
 * `interface Shadow {...}` beside `function f<Shadow>(x: Shadow)` is legal and the
 * annotation means the parameter, not the interface. A type parameter is not a graph
 * node, so without this the name would fall through to the file's declaration and
 * produce a confident edge to the wrong target. Rare, but it is a wrong edge, and a
 * wrong edge costs more than a missing one.
 */
function shadowedByTypeParameter(node: Parser.SyntaxNode): boolean {
  const name = node.text;
  for (let scope = node.parent; scope; scope = scope.parent) {
    const params = scope.childForFieldName("type_parameters");
    if (!params) continue;
    for (const param of params.namedChildren) {
      if (param.type !== "type_parameter") continue;
      if (param.childForFieldName("name")?.text === name) return true;
    }
  }
  return false;
}

function isTsTypeUse(node: Parser.SyntaxNode, lang: Language): boolean {
  if (lang !== "typescript" && lang !== "tsx") return false;
  if (node.type !== "type_identifier") return false;
  const parent = node.parent?.type;
  return (
    parent !== "nested_type_identifier" &&
    parent !== "extends_clause" &&
    parent !== "implements_clause"
  );
}

/** Recognize the definition shapes: mapped node types, Go's type/method forms, and
 * TS arrow-consts. */
function describe(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (ctx.lang === "go") return describeGo(node, ctx);
  if (ctx.lang === "cpp") return describeCpp(node, ctx);
  if (ctx.lang === "r") return describeR(node, ctx);
  if (ctx.lang === "ruby") return describeRuby(node, ctx);
  if (ctx.lang === "java") return describeJava(node, ctx);
  if (ctx.lang === "kotlin") return describeKotlin(node, ctx);
  if (ctx.lang === "swift") return describeSwift(node, ctx);

  // PHP closures: `$h = function () {…}` / `fn() => …`, and bare callbacks
  // (`$routes->get('/x', function () {…})`). Captured as function nodes so a
  // closure-only file (a routing table, a DI container) keeps its structure
  // and the calls inside attribute to the closure, not the file.
  if (ctx.lang === "php" && (node.type === "anonymous_function" || node.type === "arrow_function")) {
    const body = node.childForFieldName("body");
    return {
      name: phpClosureName(node),
      kind: "function",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // PHP anonymous classes (`new class implements I {…}`): minted as a class
  // node named `{anonymous}` (mirroring `{closure}`, deduplicated per file by
  // mintId). Without this the type vanished — no node, no heritage edge — and
  // its methods mis-attributed to the enclosing function (issue #144). The
  // class kind makes the walk emit heritageEdges (base_clause /
  // class_interface_clause are direct children) and own the nested methods.
  if (ctx.lang === "php" && node.type === "anonymous_class") {
    const body = node.childForFieldName("body");
    return {
      name: "{anonymous}",
      kind: "class",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  const mapped = ctx.kinds[node.type];
  if (mapped) {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    let kind = mapped;
    if (ctx.lang === "python" && mapped === "function" && ctx.enclosingKind === "class") {
      kind = "method";
    }
    // tree-sitter-php 0.23.x recovers a collapsed enum method as function_definition
    // at program scope; walkNamedChildren reparents it under the enum, and this
    // promotion is what keeps the kind `method` rather than a leaked `function`.
    if (ctx.lang === "php" && mapped === "function" && ctx.enclosingKind === "enum") {
      kind = "method";
    }
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  // TS: `const foo = (…) => …` / `const foo = function () {}`
  if ((ctx.lang === "typescript" || ctx.lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FUNCTION_VALUE_TYPES.has(value.type)) {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const vbody = value.childForFieldName("body");
      return {
        name,
        kind: "function",
        headerEnd: vbody ? vbody.startIndex : node.endIndex,
        hashNode: node,
      };
    }
    // `const Button = forwardRef((props, ref) => …)` declares exactly what
    // `const Button = (props) => …` declares; it just hands the body to a wrapper on
    // the way. Reading only the first form cost a React codebase nearly its whole
    // shared component layer — 68 of DailyWerk's 71 such components had no node at
    // all, so `<Alert>` in 54 files pointed at nothing and a call could not even be
    // ambiguous about them.
    const nameNode = node.childForFieldName("name");
    const wrapped = value && nameNode?.type === "identifier" && isComponentName(nameNode.text)
      ? wrappedFunctionValue(value)
      : null;
    if (wrapped) {
      const name = nameNode!.text;
      const wbody = wrapped.childForFieldName("body");
      // The header runs to the inner body, so the signature carries `forwardRef<…>`
      // and the parameter list — which is what a reader needs to tell these apart.
      return {
        name,
        kind: "function",
        headerEnd: wbody ? wbody.startIndex : node.endIndex,
        hashNode: node,
      };
    }
  }
  return null;
}

/**
 * Does this name belong to a React component?
 *
 * Not a style preference — JSX enforces it. A lowercase tag is a DOM element, so any
 * component written as `<X />` must be capitalised, and the capital is therefore
 * evidence rather than convention.
 *
 * It is what separates the two things `const x = someCall(fn)` can mean. Without it,
 * accepting a direct function literal swept up every `const authState = useMemo(() =>
 * …, [])` in the repo — a hook returning a VALUE, recorded as a function — and took
 * dailywerk from 71 expected new definitions to 782, most of them wrong. A wrapper
 * cannot be told from a hook by the shape of its argument; both take a function. It
 * can be told by what the result is allowed to be called.
 */
function isComponentName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase();
}

/**
 * The function literal a wrapping call declares, or null if the call declares none.
 *
 * The argument must be a function literal passed DIRECTLY. That is the whole of the
 * precision argument: a direct function literal is a body being declared here, while
 * anything else is a value being computed, and the two are not the same claim.
 * Measured against DailyWerk, the line falls exactly where it should —
 * `forwardRef((props, ref) => …)` and `memo(function Inner() {…})` are accepted;
 * `createContext(null)`, `createFileRoute('/dash')` and `Object.assign(a, b)` are not.
 *
 * A function nested inside an object argument is deliberately NOT enough.
 * `meta.story({ render: () => … })` is configuration that happens to contain a
 * callback, and accepting it would turn 207 Storybook stories into definitions.
 *
 * `memo(Existing)` is declined too: it names no body, and the body it wraps already
 * has a node of its own. An alias is not a second definition.
 */
function wrappedFunctionValue(value: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // `memo(fn) as typeof fn` — the cast is not the declaration; look through it.
  let call = value;
  while (call.type === "as_expression" || call.type === "satisfies_expression") {
    const inner = call.namedChildren[0];
    if (!inner) return null;
    call = inner;
  }
  if (call.type !== "call_expression") return null;
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.namedChildren) {
    if (FUNCTION_VALUE_TYPES.has(arg.type)) return arg;
  }
  return null;
}

/** Go definition shapes: top-level funcs, receiver methods, and named types
 * (struct / interface / type alias). Methods carry no nesting — they're qualified
 * by their receiver type (`User.Save`) so calls can resolve and cards read clearly. */
function describeGo(node: Parser.SyntaxNode, _ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "function_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const body = node.childForFieldName("body");
    return { name, kind: "function", headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "method_declaration") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const recv = goReceiverType(node);
    const body = node.childForFieldName("body");
    // Bare `name` (so `recv.Method()` calls resolve); receiver-qualified `idName`
    // (so the id is `file.go#Receiver.Method` and stays unique per receiver).
    return {
      name,
      idName: recv ? `${recv}.${name}` : name,
      kind: "method",
      headerEnd: body ? body.startIndex : node.endIndex,
      hashNode: node,
    };
  }

  // `type Name <shape>` — one type_spec per name (grouped `type ( … )` yields several).
  if (node.type === "type_spec") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const type = node.childForFieldName("type");
    const kind: Kind =
      type?.type === "struct_type" ? "struct" : type?.type === "interface_type" ? "interface" : "type";
    // Header ends where the body opens (`{`) for struct/interface, else the whole node
    // (a one-line alias like `type ID int`).
    const headerEnd = type && (kind === "struct" || kind === "interface") ? type.startIndex : node.endIndex;
    return { name, kind, headerEnd, hashNode: node };
  }

  return null;
}

/**
 * R definition shapes. `function_definition` carries no name field at all, so
 * unlike every other supported language the name always comes from an
 * enclosing assignment, detected here. The plain-function assignment check
 * (op-filtering `binary_operator`, the right-assign body-swap) is duplicated
 * in bindings.ts's own `rDefName` rather than imported — same reasoning as
 * this file's Go receiver helpers: bindings.ts can't take a value import back
 * on extract.ts. bindings.ts doesn't need the S3/S4/R6 half of this at all
 * (no handleR binding collector exists — see bindings.ts's own doc comment).
 *
 * Phase 1 (flat extraction — every named function is a plain `function` node)
 * plus Phase 2 (S3/S4/R6 class awareness, R's class systems being library
 * *convention* rather than grammar syntax, unlike every other language graft
 * supports):
 *   - left-assign (`<-`/`<<-`/`=`) / right-assign (`->`/`->>`) function
 *     assignment — Phase 1's shape, see the two `binary_operator`/
 *     `function_definition` branches below. Right-assign's AST shape does NOT
 *     mirror left-assign's the way it looks like it should (confirmed
 *     empirically, not assumed — R's `->` has low enough precedence that it's
 *     absorbed into the function's own `body` field as a `binary_operator`
 *     instead of the function sitting inside an outer wrapper); only an
 *     explicitly parenthesized `(function() {}) -> foo` produces the
 *     "expected" outer-wrapping shape, which isn't specially handled (falls
 *     through as an anonymous function).
 *   - `name.Class <- function() {}` — an S3 method, IF `name` is a known
 *     generic (registered locally via `UseMethod()` in this file, or one of a
 *     curated set of common base-R generics — see `rS3Split`'s doc comment
 *     for the false-positive risk this guards against).
 *   - `Foo <- R6::R6Class("Foo", public = list(...), private = list(...))` —
 *     an R6 class; its `public =`/`private =`/`active =` list entries become
 *     methods, handled by walk()'s own `argument`-node interception (this
 *     function only recognizes the class itself; the "a call defines a
 *     symbol" list-walking lives in walk() since it needs to mint several
 *     nodes, not describe a single one).
 *   - `Foo <- list(public = list(...), private = list(...))` (Phase 5) — a
 *     plain-list "mixin"/"extension" bundle, NOT wrapped in `R6::R6Class(...)`
 *     at all: a real, deliberate convention found dogfooding against a real
 *     R6-heavy corpus (25 files, 11 of them entirely invisible to the graph
 *     without this) for sharing method bundles across classes via splicing
 *     (`public = c(Foo$public, list(...))`) rather than `inherit =`. Only
 *     recognized when the list actually has a `public =`/`private =` entry
 *     (see `rIsMixinContainer`) — an ordinary data/config list never matches.
 *     Reuses kind "class" (nothing better-fitting exists, and everything
 *     downstream — the method-list walking, visibility — only cares that
 *     ctx.enclosingKind is "class", not how the container was spelled); no
 *     heritage edge, since splicing isn't `inherit =`-based inheritance.
 *   - `setClass("Foo", ...)` / `setMethod("generic", "Foo", function() {})`
 *     — S4 class/method calls, recognized as bare top-level `call` nodes
 *     (setClass/setMethod have side effects registering with the S4 system;
 *     they're essentially never assigned to a variable). `setGeneric()` is
 *     NOT specially extracted — it doesn't naturally map to a class or method
 *     kind, and the plan flags it as a case not worth the design risk.
 */
function describeR(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    if (lhs?.type !== "identifier") return null;
    if (rhs?.type === "function_definition") {
      return rFunctionDescriptor(lhs.text, rhs, rhs.childForFieldName("body"), ctx);
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "R6Class") {
      // The class node itself; its public=/private=/active= method lists are
      // handled by walk()'s own `argument`-node interception, not here.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    if (rhs?.type === "call" && rCalleeName(rhs) === "list" && rIsMixinContainer(rhs)) {
      // Phase 5: a plain-list mixin/extension bundle — same treatment as R6Class.
      return { name: lhs.text, kind: "class", headerEnd: rhs.endIndex, hashNode: rhs };
    }
    return null;
  }

  if (node.type === "function_definition") {
    // Right-assign (`function() {} -> foo`): see this function's own doc
    // comment for why this doesn't mirror the binary_operator branch above.
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    return rFunctionDescriptor(rhs.text, node, body.childForFieldName("lhs"), ctx);
  }

  if (node.type === "call") {
    return describeRTopLevelCall(node);
  }

  // R6 (Phase 2): reached via walk()'s own `argument`-node interception for a
  // `public =`/`private =`/`active =` list entry — see the special case there
  // for why this can't just be a flat kind-table/node-type check like every
  // other definition shape.
  if (node.type === "argument" && ctx.rR6Access !== null) {
    const argName = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (argName?.type !== "identifier" || value?.type !== "function_definition") return null;
    const body = value.childForFieldName("body");
    return {
      name: argName.text,
      kind: "method",
      headerEnd: body ? body.startIndex : value.endIndex,
      hashNode: value,
      // owner deliberately unset — R6 methods DO lexically nest inside the
      // class-defining call, so ctx.enclosingClass already has it.
    };
  }

  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/** A plain function assignment (left- or right-assign), OR — if `name` matches
 * a known S3 generic's `generic.Class` pattern — an S3 method instead. `body`
 * is the function's REAL content node (already resolved by the caller for
 * either assignment direction), used only for `headerEnd`; `hashNode` is
 * always the `function_definition` itself. */
function rFunctionDescriptor(
  name: string,
  hashNode: Parser.SyntaxNode,
  body: Parser.SyntaxNode | null | undefined,
  ctx: WalkCtx,
): DefDescriptor {
  const headerEnd = body ? body.startIndex : hashNode.endIndex;
  const s3 = rS3Split(name, ctx.rGenerics);
  if (s3) {
    return {
      name: s3.generic,
      idName: `${s3.className}.${s3.generic}`,
      kind: "method",
      headerEnd,
      hashNode,
      owner: s3.className,
    };
  }
  return { name, kind: "function", headerEnd, hashNode };
}

/**
 * S3 dispatch detection: does `name` split as `generic.Class` for some KNOWN
 * generic? Tries the longest possible generic prefix first (so a dotted
 * generic itself, like `as.character`, is found before a shorter false match)
 * and only ever matches a generic that's either registered locally via
 * `UseMethod()` in this file (see `collectRGenerics`) or in the small curated
 * `R_BASE_GENERICS` set below.
 *
 * This is the genuinely ambiguous part of R support the plan calls out:
 * `read.csv`, `data.frame`, and `as.character` used as an ordinary helper
 * name are NOT S3 dispatch, and nothing in the grammar distinguishes them
 * from `print.MyClass`. Erring toward the curated set staying small — a
 * missed S3 method (false negative, falls back to an ordinary `function`
 * node) is a much smaller problem than a false positive misfiling an
 * unrelated dotted-name function as some other class's method.
 */
function rS3Split(name: string, generics: ReadonlySet<string>): { generic: string; className: string } | null {
  const parts = name.split(".");
  if (parts.length < 2) return null;
  for (let i = parts.length - 1; i >= 1; i--) {
    const generic = parts.slice(0, i).join(".");
    if (generics.has(generic) || R_BASE_GENERICS.has(generic)) {
      return { generic, className: parts.slice(i).join(".") };
    }
  }
  return null;
}

/** Common base-R S3 generics worth assuming even without local evidence —
 * print.Foo/format.Foo etc. are the single most common real-world S3
 * pattern, and a local `UseMethod()` call will never exist for them (they
 * ship in base/methods/stats, not the user's own repo). Deliberately small
 * and unsurprising rather than exhaustive — see `rS3Split`'s doc comment. */
const R_BASE_GENERICS = new Set([
  "print",
  "format",
  "summary",
  "plot",
  "str",
  "toString",
  "as.character",
  "as.list",
  "as.data.frame",
  "as.vector",
  "as.numeric",
  "as.matrix",
  "length",
  "dim",
  "names",
  "rev",
  "sort",
  "unique",
  "predict",
  "coef",
  "residuals",
  "fitted",
  "update",
  "merge",
  "all.equal",
  "anova",
  "confint",
  "vcov",
  "logLik",
]);

/** Every S3 generic THIS file registers via a local `UseMethod()` call, so
 * `rS3Split` can recognize `generic.Class` methods for a repo's own generics,
 * not just the base-R ones. Runs once per file, ahead of the main walk (same
 * pre-pass shape as `collectImportedSymbols`). Cross-file generics — a
 * generic defined in one file, dispatched on in another — aren't found this
 * way; that would need a whole-repo pass extractFile has no visibility into,
 * the same limitation Go/C++'s per-file bindings already accept. */
function collectRGenerics(root: Parser.SyntaxNode): Set<string> {
  const generics = new Set<string>();
  const visit = (node: Parser.SyntaxNode): void => {
    let fnDef: Parser.SyntaxNode | null = null;
    let ownName: string | null = null;
    if (node.type === "binary_operator") {
      const op = node.childForFieldName("operator")?.text;
      const lhs = node.childForFieldName("lhs");
      const rhs = node.childForFieldName("rhs");
      if (op && R_ASSIGN_OPS.has(op) && lhs?.type === "identifier" && rhs?.type === "function_definition") {
        fnDef = rhs;
        ownName = lhs.text;
      }
    } else if (node.type === "function_definition") {
      const body = node.childForFieldName("body");
      if (body?.type === "binary_operator") {
        const op = body.childForFieldName("operator")?.text;
        const rhs = body.childForFieldName("rhs");
        if (op && R_RIGHT_ASSIGN_OPS.has(op) && rhs?.type === "identifier") {
          fnDef = node;
          ownName = rhs.text;
        }
      }
    }
    if (fnDef && ownName) {
      const arg = findUseMethodArg(fnDef.childForFieldName("body"));
      if (arg !== undefined) generics.add(arg || ownName); // "" means UseMethod() with no args
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return generics;
}

/** Searches a function body for a `UseMethod(...)` call and returns its
 * string-literal generic-name argument, `""` if called with no arguments
 * (defaults to the enclosing function's own name), or `undefined` if no
 * `UseMethod` call is found at all. */
function findUseMethodArg(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "call" && rCalleeName(node) === "UseMethod") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    return first?.type === "string" ? (rStringContent(first) ?? "") : "";
  }
  for (const child of node.namedChildren) {
    const found = findUseMethodArg(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** S4: `setClass("Foo", ...)` → a class; `setMethod("generic", "Foo",
 * function() {})` → a method owned by "Foo". Both are ordinary top-level
 * `call` nodes — S4's registration functions have side effects and are
 * essentially never assigned to a variable, unlike R6Class. */
function describeRTopLevelCall(node: Parser.SyntaxNode): DefDescriptor | null {
  const callee = rCalleeName(node);
  if (callee === "setClass") {
    const first = rCallArgs(node)[0]?.childForFieldName("value");
    const name = first?.type === "string" ? rStringContent(first) : null;
    if (!name) return null;
    return { name, kind: "class", headerEnd: node.endIndex, hashNode: node };
  }
  if (callee === "setMethod") {
    const args = rCallArgs(node);
    const generic = args[0] ? rStringContent(args[0].childForFieldName("value") ?? null) : null;
    const className = args[1] ? rStringContent(args[1].childForFieldName("value") ?? null) : null;
    const defArg = args.find((a) => a.childForFieldName("name")?.text === "definition") ?? args[2];
    const fnDef = defArg?.childForFieldName("value");
    if (!generic || !className || fnDef?.type !== "function_definition") return null;
    const body = fnDef.childForFieldName("body");
    return {
      name: generic,
      idName: `${className}.${generic}`,
      kind: "method",
      headerEnd: body ? body.startIndex : fnDef.endIndex,
      hashNode: fnDef,
      owner: className,
    };
  }
  return null;
}

/** A call's callee name, whether bare (`R6Class(...)`) or namespace-qualified
 * (`R6::R6Class(...)`). Null if the callee isn't a simple name (e.g. itself a
 * call, or a `$`-based access). */
function rCalleeName(node: Parser.SyntaxNode): string | null {
  const fn = node.childForFieldName("function");
  if (fn?.type === "identifier") return fn.text;
  if (fn?.type === "namespace_operator") {
    const rhs = fn.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** A call's positional/named `argument` children (skipping the `,`/`(`/`)`
 * punctuation tokens that share the `arguments` node's child list). */
function rCallArgs(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type === "argument") ?? [];
}

/** An R `string` node's unquoted text, or null if `node` isn't a string. */
function rStringContent(node: Parser.SyntaxNode | null): string | null {
  if (node?.type !== "string") return null;
  const content = node.namedChildren.find((c) => c.type === "string_content");
  return content?.text ?? null;
}

/** The value of a call's named argument (`setClass("Foo", contains = "Base")`
 * → the `contains` argument), or null if absent. */
function rNamedArg(node: Parser.SyntaxNode, argName: string): Parser.SyntaxNode | null {
  const arg = rCallArgs(node).find((a) => a.childForFieldName("name")?.text === argName);
  return arg?.childForFieldName("value") ?? null;
}

/** An R6 class-defining node's `inherit =` parent class name (a bare
 * identifier — the parent's own generator variable, not a string), for
 * `super$` call resolution (Phase 3). `node` is whatever describeR matched: a
 * binary_operator for R6 (`Foo <- R6::R6Class(...)`) or, for any other kind of
 * class (S4's setClass, which has no `super`), the call itself — always null
 * there since `rCalleeName(call) !== "R6Class"`. */
function rR6ParentClass(node: Parser.SyntaxNode): string | null {
  const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
  if (call?.type !== "call" || rCalleeName(call) !== "R6Class") return null;
  const value = rNamedArg(call, "inherit");
  return value?.type === "identifier" ? value.text : null;
}

/** Does this `list(...)` call look like a Phase-5 mixin/extension bundle —
 * i.e. does it have a `public =` or `private =` entry whose own value is
 * itself a `list(...)` call? This is the one check standing between "class-
 * like container" and an ordinary data/config list (`list(a = 1, b = 2)`,
 * or even one that happens to have a field named "public" holding something
 * else) — real code never coincidentally shapes plain data this way, so it's
 * a safe, precise signal without needing a naming-convention heuristic. */
function rIsMixinContainer(node: Parser.SyntaxNode): boolean {
  return rCallArgs(node).some((a) => {
    const name = a.childForFieldName("name")?.text;
    if (name !== "public" && name !== "private") return false;
    const value = a.childForFieldName("value");
    return value?.type === "call" && rCalleeName(value) === "list";
  });
}

/** A base-class name list from either a bare string (`contains = "Base"`) or
 * a `c(...)` call of strings (`contains = c("Base1", "Base2")`) — S4's
 * multiple-inheritance form. */
function rStringOrCVector(value: Parser.SyntaxNode | null): string[] {
  if (!value) return [];
  const single = rStringContent(value);
  if (single) return [single];
  if (value.type === "call" && rCalleeName(value) === "c") {
    return rCallArgs(value)
      .map((a) => rStringContent(a.childForFieldName("value")))
      .filter((s): s is string => !!s);
  }
  return [];
}

/** R6 visibility follows the `public =`/`private =`/`active =` section a
 * method was declared in (see walk()'s `argument`-node interception) —
 * `ctx.rR6Access` is only set for that direct span, so a plain function or an
 * S3/S4 method (neither of which has a real visibility concept) checks for a
 * roxygen `@export` tag next (Phase 3), falling back to the leading-dot naming
 * convention only when there's no roxygen evidence to go on at all. `node` is
 * the exact node describeR matched — see `rRoxygenExported`'s doc comment for
 * why that's always the right one to check for a preceding comment block. */
function rExported(name: string, ctx: WalkCtx, node: Parser.SyntaxNode): boolean {
  if (ctx.rR6Access !== null) return ctx.rR6Access !== "private";
  const roxygen = rRoxygenExported(node);
  if (roxygen !== null) return roxygen;
  return !name.startsWith(".");
}

/**
 * Roxygen `@export` detection (Phase 3): does `node` — a top-level definition
 * statement (a `binary_operator` assignment, a right-assigned
 * `function_definition`, or an S4 `setClass`/`setMethod` call) — have a
 * roxygen doc block immediately preceding it, and if so, is it tagged
 * `@export`?
 *
 * `comment` is a grammar EXTRA in this grammar (floats loosely between
 * sibling nodes rather than attaching to "the next statement" via a field),
 * so this walks backward through `previousNamedSibling` collecting a
 * contiguous run of `comment` nodes — the run ends at the first non-comment
 * sibling, or at the first comment that isn't itself a roxygen (`#'`) line,
 * either of which is roxygen's own "this block documents the next statement"
 * boundary.
 *
 * Returns:
 *  - `true` — a roxygen block was found and it contains `@export`.
 *  - `false` — a roxygen block was found but it does NOT contain `@export`.
 *    This is deliberately a confident "not exported," not "unknown": roxygen
 *    generates a package's NAMESPACE from exactly its `@export`-tagged items,
 *    so a documented-but-untagged function is an explicit "internal, for
 *    maintainers only" signal, not an absence of evidence.
 *  - `null` — no roxygen block at all, so the caller should fall back to the
 *    leading-dot naming convention instead of guessing.
 */
function rRoxygenExported(node: Parser.SyntaxNode): boolean | null {
  let sib = node.previousNamedSibling;
  let sawRoxygen = false;
  let exported = false;
  while (sib?.type === "comment") {
    const text = sib.text.trim();
    if (!text.startsWith("#'")) break; // an ordinary # comment ends the roxygen block
    sawRoxygen = true;
    if (/^#'\s*@export\b/.test(text)) exported = true;
    sib = sib.previousNamedSibling;
  }
  return sawRoxygen ? exported : null;
}

/**
 * Ruby definition shapes for Phase 1: `class`, `module`, and `def` (plain
 * instance/top-level methods — `def self.x`/`def obj.x`/`class << self` land
 * in Phase 2). Unlike R, Ruby's grammar hands us real class/module nodes
 * directly — there's no S3/S4-style naming-convention inference to do here.
 */
function rubyHeaderEnd(body: Parser.SyntaxNode | null, fallback: Parser.SyntaxNode): number {
  // Comment-only and semicolon-empty definitions have no body node. Their terminal
  // syntax node is the declaration header, not the comment or statement separator.
  return body?.startIndex ?? fallback.endIndex;
}

function describeRuby(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const factory = rubyNamedClassFactory(node);
  if (factory) return { name: factory.name, kind: "class", hashNode: node,
    headerEnd: factory.block?.startIndex ?? node.endIndex };
  if (node.type === "class" || node.type === "module") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    // `class A::B::C` (the compact form) names itself via a `scope_resolution`
    // rather than a plain `constant`. M0 dropped it, and on a real Rails app
    // that cost a whole class of answers: all 12 filewerk controllers written
    // `class Admin::UsersController < ...` had NO class node, so their
    // superclass and `include` edges were missing outright and their actions
    // landed as file-scoped `index`/`show`/`destroy` nodes — 11 definitions
    // sharing one bare name, which no query can tell apart.
    //
    // `name` stays the terminal constant, because that is what call resolution
    // matches; `idName` carries the dotted path so the id is IDENTICAL to what
    // the nested spelling `module App; class InvitationsController` produces.
    // Two spellings of one class must not describe it under two names.
    const path = rubyConstPath(nameNode);
    if (path === null) return null;
    const segs = path.replace(/^::/, "").split("::");
    const body = node.childForFieldName("body");
    const header = node.childForFieldName("superclass") ?? nameNode;
    return {
      name: segs[segs.length - 1],
      ...(segs.length > 1 ? { idName: segs.join(".") } : {}),
      kind: node.type === "class" ? "class" : "module",
      headerEnd: rubyHeaderEnd(body, header),
      hashNode: node,
    };
  }
  if (node.type === "method") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const body = node.childForFieldName("body");
    const header = node.childForFieldName("parameters") ?? nameNode;
    return {
      name: nameNode.text,
      // A `def` promotes to "method" only when lexically nested inside a
      // class/module — a top-level `def` is a free function for our
      // purposes, mirroring Python's own function→method promotion.
      kind: ctx.enclosingClass !== null ? "method" : "function",
      headerEnd: rubyHeaderEnd(body, header),
      hashNode: node,
      // `def x` is an instance method — unless it is written inside `class << self`,
      // which is Ruby's other spelling of `def self.x` and is how 312 of
      // dailywerk's class methods are declared.
      // `module_function`/`extend self` make the method answer BOTH chains, so it
      // claims neither — an absent `receiver` is "unknown, matches either".
      ...(ctx.enclosingClass !== null && !ctx.rubyModuleFunction
        ? { receiver: (rubyInSingletonClass(node) ? "class" : "instance") as RubySelfKind }
        : {}),
    };
  }
  if (node.type === "singleton_method") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const body = node.childForFieldName("body");
    const header = node.childForFieldName("parameters") ?? nameNode;
    return {
      name: nameNode.text,
      // Owned by the enclosing class regardless of whether the receiver was
      // `self` or an arbitrary object expression (`def obj.x`) — Phase 2's
      // scope is recognizing the shape, not modeling per-object singleton
      // methods distinctly.
      kind: "method",
      headerEnd: rubyHeaderEnd(body, header),
      hashNode: node,
      // `def self.x` answers a call on the class OBJECT. `def obj.x` for some other
      // object answers neither reading of the enclosing class, so it is left
      // unstamped — "unknown", which matches either rather than claiming one.
      ...(rubySingletonIsSelf(node) ? { receiver: "class" as RubySelfKind } : {}),
    };
  }
  return null;
}

/** Direct singleton definitions and metaprogramming can replace Class.new even
 * without reopening `class Class`. Keep their named receiver as a barrier; the
 * resolver checks its lexical identity using the same constant lookup as calls. */
function rubyClassMutationTarget(node: Parser.SyntaxNode, ctx: WalkCtx): { name?: string; rubyClassMutationBinding?: string } | null {
  let receiver: Parser.SyntaxNode | null = null;
  if (node.type === "singleton_method" || node.type === "singleton_class") receiver = node.childForFieldName("object") ?? node.childForFieldName("value");
  else if (node.type === "call" && ["define_singleton_method", "define_method", "alias_method", "remove_method", "undef_method", "class_eval", "class_exec", "module_eval", "module_exec", "instance_eval", "instance_exec", "prepend", "include", "extend", "const_set", "remove_const", "send", "public_send", "__send__"].includes(node.childForFieldName("method")?.text ?? "")) {
    receiver = node.childForFieldName("receiver");
    if ((!receiver || receiver.type === "self") && ctx.rubySelfKind === "class" && ctx.rubyOwner) return { name: `::${ctx.rubyOwner}` };
  }
  while (receiver?.type === "call") receiver = receiver.childForFieldName("receiver");
  if (!receiver) return null;
  const path = rubyConstPath(receiver);
  if (path) return { name: path };
  if (receiver.type === "identifier" && rubyIsVar(receiver, ctx)) return { rubyClassMutationBinding: rubyBindingKey(receiver.text, ctx) };
  const type = rubyReceiverType(receiver, ctx);
  return type?.base === "const" && type.kind === "class" && !type.steps.length ? { name: type.constPath } : null;
}

/** Alias evidence only invalidates Class.new assumptions. Following it must not
 * turn a class object into an instance binding in the ordinary call resolver. */
function rubyClassAliasValue(node: Parser.SyntaxNode | null, ctx: WalkCtx): RubyBindingValue | null {
  if (!node) return null;
  const constant = rubyConstPath(node);
  if (constant) return { constant, file: ctx.rel, nesting: [...ctx.rubyNesting] };
  if (node.type === "identifier" && rubyIsVar(node, ctx)) return { binding: rubyBindingKey(node.text, ctx) };
  return null;
}

/**
 * A constant reference rendered the way Ruby writes it: `Runner`, `A::B::Runner`,
 * or `::Runner` for the top-level escape. Null when any part of the path is not a
 * constant — `obj::CONST` and `foo.bar::Baz` are legal Ruby but their head is a
 * runtime value, so nothing static can say what they name.
 *
 * The leading `::` is preserved rather than stripped: it is the programmer saying
 * "not the one you would have found," and `resolve.ts` reads it as an instruction
 * to skip the nesting chain entirely. Dropping it would silently turn a
 * deliberate escape into an ordinary shadowed lookup.
 */
function rubyConstPath(node: Parser.SyntaxNode): string | null {
  if (node.type === "constant") return node.text;
  if (node.type !== "scope_resolution") return null;
  const name = node.childForFieldName("name");
  if (name?.type !== "constant") return null;
  const scope = node.childForFieldName("scope");
  if (!scope) return `::${name.text}`; // `::Foo` — no scope field is the marker
  const head = rubyConstPath(scope);
  return head === null ? null : `${head}::${name.text}`;
}

/**
 * The cref a class/module body opens, appended to the enclosing one.
 *
 * `idPart` is dotted (`App.InvitationsController` for the compact form), which is
 * exactly the property that makes this correct: the compact form contributes its
 * WHOLE path as one nesting entry, so `class A::B::C` yields `[A::B::C]` while the
 * nested spelling yields `[A::B::C, A::B, A]`. That difference is Ruby's, not an
 * approximation of it, and it is why the two forms genuinely resolve differently.
 *
 * One known divergence: `module M; class ::Foo` opens top-level `::Foo`, so Ruby's
 * nesting is `[Foo]` where this produces `M::Foo`. M0 emitted no node at all for
 * that shape, so nothing regresses; it is left alone because the id would then
 * disagree with `ctx.scope`, which is built from the same lexical chain.
 */
function rubyCref(parent: string | undefined, idPart: string): string {
  const own = idPart.split(".").join("::");
  return parent ? `${parent}::${own}` : own;
}

/**
 * Is this constant node a *definition* rather than a reference?
 *
 * Three shapes, and all three would otherwise become an edge pointing at the very
 * thing being declared:
 *  - `class Foo` / `module Foo` — the walk descends into a class node's own name.
 *  - `FOO = 1` / `A::B = 1` — the assignment's left-hand side.
 *  - `class Foo < Bar` — the superclass, already carried by an `extends` edge;
 *    emitting a `references` edge too would double-count every heritage line.
 *
 * Mixin arguments (`include Mod`) need no case here: the mixin branch in walk()
 * consumes the call and returns without descending into its argument list.
 */
function isRubyConstantDefinition(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "superclass") return true;
  return (
    sameSyntaxNode(parent.childForFieldName("name"), node) ||
    sameSyntaxNode(parent.childForFieldName("left"), node)
  );
}

/**
 * Is this constant the left-hand side of an assignment — `MAX = 10` rather than
 * `class Max`? The distinction matters only for shadowing: see `RawEdge.rubyConstDecl`.
 */
function isRubyConstantAssignment(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (parent?.type !== "assignment" && parent?.type !== "operator_assignment") return false;
  return sameSyntaxNode(parent.childForFieldName("left"), node);
}

/**
 * `initialize` is unconditionally private by Ruby language rule, regardless
 * of the surrounding visibility mode. Otherwise: a post-hoc `private
 * :name`/`protected :name` in the current class/module body wins over the
 * forward mode-switch state (it's a more specific, deliberate override);
 * absent that, the current mode-switch state (already resolved to an inline
 * override, if any, by the caller passing a one-off ctx — see
 * rubyInlineVisibility) decides.
 */
function rubyExported(name: string, ctx: WalkCtx): boolean {
  if (name === "initialize") return false;
  const postHoc = ctx.rubyPostHoc.get(name);
  if (postHoc) return false;
  return ctx.rubyVisibility === "public";
}

/**
 * One shallow pass over a class/module's own `body`, collecting every
 * `private :sym`/`protected :sym` post-hoc call — see WalkCtx.rubyPostHoc's
 * doc comment for why this can't be folded into the forward
 * rubyVisibility pass. Deliberately shallow (direct body children only,
 * `namedChildren` not a full recursive walk) — a `private :sym` nested
 * inside a conditional or another method body is not a class-level
 * visibility declaration and should not be treated as one.
 */
/**
 * Does this module body contain a bare `extend self`?
 *
 * Unlike `module_function`, it is position-independent: `extend self` extends the
 * module with its own instance methods, and Ruby resolves that at call time, so a
 * `def` written ABOVE the line is reachable as a class method too (verified on Ruby
 * 3.4). A pre-scan is therefore the only correct reading.
 */
function rubyExtendsSelf(classOrModuleNode: Parser.SyntaxNode): boolean {
  const body = classOrModuleNode.childForFieldName("body");
  if (!body) return false;
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "call") continue;
    if (stmt.childForFieldName("receiver")) continue;
    if (stmt.childForFieldName("method")?.text !== "extend") continue;
    const args = stmt.childForFieldName("arguments");
    if (args?.namedChildren.some((a) => a.type === "self")) return true;
  }
  return false;
}

function rubyPostHocVisibility(classOrModuleNode: Parser.SyntaxNode): ReadonlyMap<string, "protected" | "private"> {
  const body = classOrModuleNode.childForFieldName("body");
  if (!body) return EMPTY_MAP;
  const out = new Map<string, "protected" | "private">();
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "call") continue;
    const methodNode = stmt.childForFieldName("method");
    if (methodNode?.type !== "identifier") continue;
    if (methodNode.text !== "private" && methodNode.text !== "protected") continue;
    const args = stmt.childForFieldName("arguments");
    if (!args) continue;
    for (const sym of args.namedChildren) {
      if (sym.type === "simple_symbol") out.set(sym.text.slice(1), methodNode.text as "protected" | "private");
    }
  }
  return out;
}

/**
 * Every method name this class/module writes out with a real `def`, collected in one
 * shallow pass when the body is entered — the same shape, and for the same reason, as
 * {@link rubyPostHocVisibility}: a macro can appear textually before the `def` that
 * overrides it, so a forward-only walk cannot see it in time.
 *
 * Shallow on purpose (direct body children, plus the one level of `body_statement`
 * the grammar wraps them in). A `def` nested inside a conditional or another method
 * is not the class's own declaration and must not suppress a macro.
 */
function rubyOwnDefNames(classOrModuleNode: Parser.SyntaxNode): ReadonlySet<string> {
  const body = classOrModuleNode.childForFieldName("body");
  if (!body) return EMPTY_SET;
  const out = new Set<string>();
  const consider = (n: Parser.SyntaxNode): void => {
    if (n.type === "method" || n.type === "singleton_method") {
      const name = n.childForFieldName("name")?.text;
      if (name) out.add(name);
      return;
    }
    // `private def foo` wraps the method in a call; the def is still the class's own.
    const inline = rubyInlineVisibility(n);
    if (inline) {
      const name = inline.methodNode.childForFieldName("name")?.text;
      if (name) out.add(name);
    }
  };
  for (const stmt of body.namedChildren) consider(stmt);
  return out;
}

/** A bare `private`/`protected`/`public` statement (no call, no args) — the
 * mode-switch form. Returns the mode to switch to, or null if `node` isn't
 * one. `module_function` is deliberately NOT handled — it has dual
 * public-singleton-method/private-instance-method semantics with no clean
 * fit in this schema; see the plan's Task 3 notes. */
function rubyVisibilitySwitch(node: Parser.SyntaxNode): "public" | "protected" | "private" | null {
  if (node.type !== "identifier") return null;
  if (node.text === "private" || node.text === "protected" || node.text === "public") return node.text;
  return null;
}

/** `private def foo; end` / `protected def foo; end` — the inline form.
 * Returns the wrapped method node and the one-off visibility to apply to it
 * (independent of, and without mutating, the surrounding mode-switch
 * state), or null if `node` isn't this shape. */
function rubyInlineVisibility(
  node: Parser.SyntaxNode,
): { methodNode: Parser.SyntaxNode; visibility: "protected" | "private" } | null {
  if (node.type !== "call") return null;
  const methodField = node.childForFieldName("method");
  if (methodField?.type !== "identifier") return null;
  if (methodField.text !== "private" && methodField.text !== "protected") return null;
  const args = node.childForFieldName("arguments");
  const sole = args?.namedChildren[0];
  if (sole?.type !== "method" && sole?.type !== "singleton_method") return null;
  return { methodNode: sole, visibility: methodField.text as "protected" | "private" };
}

/**
 * The method an `obj.attr` call site actually invokes: `attr=` when it stands on
 * the left of an assignment, `attr` everywhere else.
 *
 * Ruby's assignment syntax hides a method call. `Current.user = current_user` is
 * `Current.user=(current_user)`, and tree-sitter spells it as an ordinary `call`
 * node parked in an `assignment`'s `left` field — indistinguishable, at the call
 * node itself, from the READ two lines further down. Until M3 typed the receiver
 * both were bare-name matches that resolved to nothing, so the difference never
 * surfaced; typed, the writer would have landed squarely on the reader's node and
 * `inarch callers user` would have reported every `Current.user = …` in the app as
 * a caller of a method it never calls.
 *
 * An operator assignment (`self.count += 1`) really does call both `count` and
 * `count=`. Only the writer is emitted, keeping this file's "err toward false
 * negatives" rule rather than minting a second edge from one call node.
 */
function rubyAssignedMethodName(node: Parser.SyntaxNode, name: string): string {
  let cur: Parser.SyntaxNode = node;
  // `a.x, b.y = 1, 2` — each target sits inside the list that IS the left field.
  if (cur.parent?.type === "left_assignment_list") cur = cur.parent;
  const parent = cur.parent;
  if (
    (parent?.type === "assignment" || parent?.type === "operator_assignment") &&
    sameSyntaxNode(parent.childForFieldName("left"), cur)
  ) {
    return `${name}=`;
  }
  return name;
}

/** How many reader hops a chained receiver may take before the walk gives up.
 * `a.b.c.d.e` is already past anything a Rails app writes on purpose, and each
 * hop needs a DECLARED return type to continue, so the cap only bounds a
 * pathological expression rather than deciding any real one. */
const RUBY_RECV_CHAIN_CAP = 4;

/** A receiver whose class M3 can name: a base (the enclosing class, or a constant)
 * plus the reader calls applied to it before the call in question. */
type RubyReceiver =
  | { base: "self"; kind: RubyValueKind; constructed?: boolean; steps: string[] }
  | { base: "const"; constPath: string; kind: RubyValueKind; finder?: string; steps: string[] };

/**
 * The class of a Ruby receiver expression, or null when this pass cannot say —
 * which is the answer for most receivers and is the point of the milestone.
 *
 * The four typeable shapes, and why each is safe:
 *
 *   - `self` — the enclosing class, named exactly.
 *   - a constant (`User.find`, `::Api::V1::Job.call`) — the programmer wrote the
 *     class at the call site; M1 resolves what it names from `nesting`.
 *   - a variable assigned from a constant (`user = User.find(1)` … `user.save`) —
 *     `collectBindings` typed it, and withdrew the binding if any other write in
 *     the same scope disagreed.
 *   - a receiverless name that is NOT a variable here (`organization.id` inside a
 *     class declaring `attr_reader :organization`) — Ruby has no free functions,
 *     so this is `self.organization`, and it becomes a step on the `self` base.
 *     `bindings.isRubyVar` is what separates it from a parameter of the same name,
 *     and getting that wrong in either direction is a wrong edge, not a missing
 *     one.
 *
 * Everything else — a literal, an index (`params[:id]`), a ternary, a method call
 * with no declared return type, an instance variable assigned something unreadable
 * — is null, and the caller emits no edge at all.
 */
function rubyReceiverType(node: Parser.SyntaxNode, ctx: WalkCtx): RubyReceiver | null {
  if (node.type === "self") return { base: "self", kind: ctx.rubySelfKind, steps: [] };
  if (node.type === "constant" || node.type === "scope_resolution") {
    const path = rubyConstPath(node);
    // The class OBJECT, not an instance of it. `Ledger.post` reaches `def self.post`
    // and its `extend`ed modules; it does not reach `def post`.
    return path === null ? null : { base: "const", constPath: path, kind: "class", steps: [] };
  }
  if (node.type === "identifier") {
    const bound = rubyLookupVar(node, ctx);
    if (bound) return { base: "const", constPath: bound.fqn, kind: bound.kind, finder: bound.finder, steps: [] };
    // A variable with no knowable type. NOT a call on self — reading it as one
    // would bind a parameter to a same-named accessor on its own class.
    if (rubyIsVar(node, ctx)) return null;
    if (node.text === "new" && ctx.rubySelfKind === "class") return { base: "self", kind: "instance", constructed: true, steps: [] };
    return { base: "self", kind: ctx.rubySelfKind, steps: [node.text] };
  }
  if (node.type === "instance_variable" || node.type === "class_variable" || node.type === "global_variable") {
    // No `self` fallback here: an instance variable that was never assigned a
    // typeable value is `nil`, not a method.
    const bound = rubyLookupVar(node, ctx);
    return bound ? { base: "const", constPath: bound.fqn, kind: bound.kind, finder: bound.finder, steps: [] } : null;
  }
  if (node.type === "call") {
    const method = node.childForFieldName("method");
    if (method?.type !== "identifier") return null;
    const inner = node.childForFieldName("receiver");
    if (method.text === "new" && rubyConstructionHasBlock(node)) return null;
    if (method.text === "new" && ctx.rubySelfKind === "class" && (!inner || inner.type === "self")) {
      return { base: "self", kind: "instance", constructed: true, steps: [] };
    }
    // `User.new`, `User.find(1)` — a constructor or finder on a constant is an
    // INSTANCE of it, and collapsing it here is what lets `Post.new.blog.publish`
    // walk at all: as a bare step, `new` resolves to no node and the chain dies.
    // The argument shape decides: `User.first(2)` is an Array, not a User.
    if (inner && (inner.type === "constant" || inner.type === "scope_resolution")) {
      const fqn = rubyConstPath(inner);
      const built = fqn === null ? null : rubyConstructorType(fqn, method.text, node, rubyTypeCtx(ctx));
      if (built) {
        return { base: "const", constPath: built.fqn, kind: built.kind, finder: built.finder, steps: [] };
      }
    }
    const head: RubyReceiver | null = inner
      ? rubyReceiverType(inner, ctx)
      : rubyIsVar(method, ctx)
        ? null
        : { base: "self", kind: ctx.rubySelfKind, steps: [] };
    if (!head) return null;
    if (head.steps.length >= RUBY_RECV_CHAIN_CAP) return null;
    return { ...head, steps: [...head.steps, method.text] };
  }
  return null;
}

/** The binding-table question every Ruby receiver asks, with the scope key and the
 * read position both taken from where the name actually sits. */
function rubyLookupVar(node: Parser.SyntaxNode, ctx: WalkCtx): RubyType | null {
  const key = rubyScopeKey(node.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind);
  return ctx.bindings.lookupRuby(key, node.text, node.startIndex);
}

function rubyIsVar(node: Parser.SyntaxNode, ctx: WalkCtx): boolean {
  const key = rubyScopeKey(node.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind);
  return ctx.bindings.isRubyVar(key, node.text, node.startIndex);
}

/** The slice of `WalkCtx` bindings.ts's type questions need. */
function rubyTypeCtx(ctx: WalkCtx): RubyTypeCtx {
  return {
    bindings: ctx.bindings,
    scope: ctx.scope,
    classScope: ctx.rubyClassScope,
    selfKind: ctx.rubySelfKind,
    rails: ctx.rubyRails !== null,
  };
}

/** `def x` written inside a `class << self` block, which is how Ruby's other
 * spelling of `def self.x` reaches the walk: `method` → `body_statement` →
 * `singleton_class`. */
function rubyInSingletonClass(node: Parser.SyntaxNode): boolean {
  return node.parent?.parent?.type === "singleton_class";
}

/** Is this `def self.x`, as opposed to `def some_other_object.x`? Only the former
 * puts a method on the enclosing class's singleton; the latter is a method on some
 * runtime object this pass cannot name. */
function rubySingletonIsSelf(node: Parser.SyntaxNode): boolean {
  const obj = node.childForFieldName("object");
  return obj?.type === "self";
}

/** The M3 receiver fields for a `RawEdge`, or null when the receiver's class is
 * unnamed — including the case where it IS `self` but there is no enclosing class
 * to name (a top-level `def`, where `self` is `main`). */
function rubyRecvFields(recv: RubyReceiver, ctx: WalkCtx): Partial<RawEdge> | null {
  const steps = recv.steps.length > 0 ? { rubyRecvSteps: recv.steps } : {};
  if (recv.base === "self") {
    const own = ctx.rubyOwner;
    return own ? { rubyRecvBase: "self", rubyOwnerFqn: own, rubyRecvKind: recv.kind,
      ...(recv.constructed ? { rubyConstructed: true } : {}), ...steps } : null;
  }
  return {
    rubyRecvBase: "const",
    rubyRecvConst: recv.constPath,
    nesting: [...ctx.rubyNesting],
    rubyRecvKind: recv.kind,
    ...(recv.finder ? { rubyRecvFinder: recv.finder } : {}),
    ...steps,
  };
}

/**
 * Ruby's `call` node splits the callee into `receiver` + `method` fields (never a
 * single `function` field), so it's intercepted before the shared lookup every
 * other language uses.
 *
 * M3 replaced what used to happen here. Every receiver shape that was not `self`
 * — `obj.method`, `Klass.method` — resolved by BARE NAME, and on a real Rails app
 * that was the single largest source of wrong edges in the graph: `e.message`,
 * `error.message` and `flash[:message]`'s neighbours all landed on the one node in
 * the repo named `message`, a ViewComponent's `attr_reader`, 161 times. A receiver
 * is now either typed — and then resolved on that class and its ancestors — or it
 * emits nothing at all.
 *
 * A receiverless call keeps the bare-name reading, but only as a FALLBACK behind
 * the enclosing class's own chain (`implicitSelf`): Ruby has no free functions, so
 * `helper` inside a class means `self.helper`, and only means a top-level `def`
 * when nothing on the class's ancestry answers. The `kinds` widening to "method"
 * stays for that fallback — a mixed-in module's method is a legitimate target and
 * `resolveName` cannot otherwise see it.
 *
 * `super` is captured separately with its defining method, because its target is
 * the next implementation in the ancestor chain rather than a method named super.
 */
function rubyCallee(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
): { name: string; viaMember: boolean; kinds?: Kind[]; ruby?: Partial<RawEdge> } | null {
  const methodNode = node.childForFieldName("method");
  if (!methodNode) return null;
  if (methodNode.type === "super") return null; // the keyword is captured by walk
  const name = rubyAssignedMethodName(node, methodNode.text);
  const receiverNode = node.childForFieldName("receiver");
  if (!receiverNode) {
    // The bare-name fallback is `function` only, and that is Ruby's own rule, not
    // a tightening for its own sake: a receiverless word is `self.word`, so the
    // only definitions it can reach are the enclosing class's ancestry — already
    // tried, owner-qualified, above — and a top-level `def`, which Ruby makes a
    // private method on Object and this graph records as kind "function". A
    // "method" on some unrelated class is not reachable that way, and matching one
    // is how a bare `warn` in a Falcon config file became a call into a rake
    // task's logger.
    const own = ctx.rubyOwner;
    if (!own) return { name, viaMember: false, kinds: ["function"] };
    return {
      name,
      viaMember: false,
      kinds: ["function"],
      ruby: { rubyRecvBase: "self", rubyOwnerFqn: own, rubyRecvKind: ctx.rubySelfKind, implicitSelf: true },
    };
  }
  // ActiveJob's configured proxy keeps its job class, but an ordinary `set`
  // method need not. Carry the syntax; resolution verifies ancestry and overrides.
  if (ctx.rubyRails && (name === "perform_later" || name === "perform_now")) {
    const configured = receiverNode.type === "call" && receiverNode.childForFieldName("method")?.text === "set";
    const base = configured ? receiverNode.childForFieldName("receiver") : receiverNode;
    const job = base ? rubyConstPath(base) : null;
    if (job) return { name, viaMember: true, ruby: {
      rubyRecvBase: "const", rubyRecvConst: job, rubyRecvKind: "class", nesting: [...ctx.rubyNesting],
      rubyJob: name, ...(configured ? { rubyJobConfigured: true } : {}),
    } };
  }
  const recv = rubyReceiverType(receiverNode, ctx);
  if (!recv) {
    const binding = rubyBindingValue(receiverNode, ctx, true);
    const block = rubyMapBlockEvidence(receiverNode, ctx);
    return binding && "binding" in binding ? { name, viaMember: true,
      ruby: { rubyReceiverBinding: binding.binding, rubyOwnerFqn: ctx.rubyOwner,
        rubyBlockSteps: block?.steps, rubyBlockArrayEvidence: block?.evidence } } : null;
  }
  const fields = rubyRecvFields(recv, ctx);
  if (!fields) return null;
  return { name, viaMember: true, ruby: fields };
}

function rubyBindingKey(name: string, ctx: WalkCtx): string {
  return name.startsWith("@")
    ? `${ctx.rubyOwner ?? ""}%${ctx.rubySelfKind}|${name}`
    : `${ctx.parentId}|${name}`;
}

function rubyBindingReadAllowed(node: Parser.SyntaxNode, local: boolean): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "method" || parent.type === "singleton_method") break;
    if (["block", "do_block", "lambda"].includes(parent.type)) {
      if (local || rubyBlockSelfContext(parent, "instance") === "unknown") return false;
    }
  }
  return true;
}

/** This annotation is a block-self contract only, never a general receiver type.
 * Without an unchanged Array parameter (or literal Array), a method named map
 * could just as well instance_exec the block on a foreign object. */
function rubyArrayParameterEvidence(receiver: Parser.SyntaxNode, method: Parser.SyntaxNode, ctx: WalkCtx): string | null {
  if (receiver.type !== "identifier" || !rubyIsVar(receiver, ctx) || rubyLookupVar(receiver, ctx) ||
      !ctx.bindings.hasSingleRubyWrite(rubyScopeKey(receiver.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind), receiver.text)) return null;
  const parameter = method.childForFieldName("parameters")?.namedChildren.find(p =>
    (p.type === "identifier" ? p.text : p.childForFieldName("name")?.text) === receiver.text);
  if (!parameter) return null;
  const value = parameter.childForFieldName("value");
  if (value && value.type !== "array") return null;
  let nextRow = method.startPosition.row;
  for (let comment = method.previousNamedSibling; comment?.type === "comment" && comment.endPosition.row + 1 >= nextRow; comment = comment.previousNamedSibling) {
    const match = comment.text.match(/^#\s*@param\s+(\w+)\s+\[((?:::)?Array(?:<[^\]\n]+>)?)\](?:\s|$)/);
    if (match?.[1] === receiver.text) return `annotation-derived @param ${receiver.text} [${match[2]}] at ${ctx.rel}:${comment.startPosition.row + 1}`;
    nextRow = comment.startPosition.row;
  }
  return null;
}

function rubyMapBlockEvidence(node: Parser.SyntaxNode, ctx: WalkCtx): { steps: Array<"first" | "map">; evidence: string[] } | null {
  const steps: Array<"first" | "map"> = [];
  const evidence: string[] = [];
  let method: Parser.SyntaxNode | null = node;
  while (method && method.type !== "method" && method.type !== "singleton_method") method = method.parent;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "method" || parent.type === "singleton_method") break;
    if (!["block", "do_block", "lambda"].includes(parent.type)) continue;
    const call = parent.parent;
    if (call?.type !== "call" || call.childForFieldName("method")?.text !== "map") return null;
    let receiver = call.childForFieldName("receiver");
    if (receiver?.type === "call" && receiver.childForFieldName("method")?.text === "first") {
      const args = receiver.childForFieldName("arguments")?.namedChildren ?? [];
      if (args.length !== 1 || args[0].type.includes("splat") || rubyConstructionHasBlock(receiver)) return null;
      steps.push("first");
      receiver = receiver.childForFieldName("receiver");
    }
    if (!receiver) return null;
    const proof = receiver.type === "array" ? `literal Array at ${ctx.rel}:${receiver.startPosition.row + 1}`
      : method ? rubyArrayParameterEvidence(receiver, method, ctx) : null;
    if (!proof) return null;
    evidence.push(proof);
    steps.push("map");
  }
  return { steps: [...new Set(steps)], evidence: [...new Set(evidence)] };
}

/** Only a literal construction or an existing local/ivar can carry an injection.
 * A reader with the same name, splat, block capture or arbitrary factory cannot. */
function rubyBindingValue(node: Parser.SyntaxNode | null, ctx: WalkCtx, allowMapReceiver = false): RubyBindingValue | null {
  if (!node || ctx.rubySelfKind === "unknown") return null;
  if (node.type === "instance_variable" || (node.type === "identifier" && rubyIsVar(node, ctx))) {
    if (!ctx.bindings.hasSingleRubyWrite(rubyScopeKey(node.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind), node.text)) return null;
    if (!rubyBindingReadAllowed(node, node.type === "identifier")) return null;
    const blocks = rubyMapBlockEvidence(node, ctx);
    if (blocks === null || (blocks.steps.length && !allowMapReceiver)) return null;
    return { binding: rubyBindingKey(node.text, ctx) };
  }
  if (node.type !== "call" || node.childForFieldName("method")?.text !== "new") return null;
  // A constructor block can install singleton methods or otherwise replace the
  // receiver's dispatch. A class name alone cannot certify that modified object.
  if (rubyConstructionHasBlock(node)) return null;
  const recv = node.childForFieldName("receiver");
  const constant = recv ? rubyConstPath(recv) : null;
  return constant ? { constant, file: ctx.rel, nesting: [...ctx.rubyNesting] } : null;
}

function rubyKeywordArguments(node: Parser.SyntaxNode, ctx: WalkCtx): Record<string, RubyBindingValue | null> | null {
  if (node.childForFieldName("method")?.text === "new" && rubyConstructionHasBlock(node)) return null;
  const result: Record<string, RubyBindingValue | null> = Object.create(null);
  for (const arg of node.childForFieldName("arguments")?.namedChildren ?? []) {
    if (["hash_splat_argument", "forward_argument", "splat_argument"].includes(arg.type)) return null;
    if (arg.type !== "pair") continue;
    const key = arg.childForFieldName("key");
    if (key?.type !== "hash_key_symbol" || Object.hasOwn(result, key.text)) return null;
    const value = arg.childForFieldName("value");
    result[key.text] = value ? rubyBindingValue(value, ctx)
      : rubyBindingReadAllowed(key, true) && ctx.bindings.hasSingleRubyWrite(rubyScopeKey(key.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind), key.text) && ctx.bindings.isRubyVar(rubyScopeKey(key.text, ctx.scope, ctx.rubyClassScope, ctx.rubySelfKind), key.text, key.startIndex)
        ? { binding: rubyBindingKey(key.text, ctx) } : null;
  }
  return result;
}

const RUBY_MIXIN_KEYWORDS = new Set(["include", "extend", "prepend"] as const);

/**
 * `include Mod`/`extend Mod`/`prepend Mod` (bare, no receiver) inside a
 * class/module body — every named `constant` argument becomes a mixin
 * target. Returns null for anything else (an ordinary call, or `foo.include
 * Bar` with an explicit receiver, which isn't mixin composition).
 *
 * The keyword travels with the targets because the three are one relation in the
 * graph and three different things in Ruby's constant lookup — see
 * `RawEdge.rubyHeritage`.
 */
function rubyMixinTargets(
  node: Parser.SyntaxNode,
): { keyword: "include" | "extend" | "prepend"; targets: string[]; unknown: boolean } | null {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier") return null;
  const keyword = methodNode.text as "include" | "extend" | "prepend";
  if (!RUBY_MIXIN_KEYWORDS.has(keyword)) return null;
  if (node.childForFieldName("receiver")) return null;
  const args = node.childForFieldName("arguments");
  // A computed argument can install methods or inclusion hooks just as a named
  // module can. Dropping it made workflow resolution mistake unknown ancestry
  // for an empty method set, including in mixed `include Known, factory()` calls.
  const paths = (args?.namedChildren ?? []).map(c => rubyConstPath(c));
  const targets = paths.filter((p): p is string => p !== null);
  const unknown = paths.some(p => p === null);
  return paths.length > 0 ? { keyword, targets, unknown } : null;
}

interface RubySynthesizedMethod {
  name: string;
  hashNode: Parser.SyntaxNode; // span for signature/body_hash/body_text
  headerEnd: number;
  /** What a call must hold to reach it — see `NodeV1.receiver`. Almost every macro
   * declares instance methods; `scope` declares a CLASS method, and
   * `ActiveSupport::CurrentAttributes`' `attribute` genuinely declares both, so it
   * leaves this undefined rather than claiming one. */
  receiver?: RubySelfKind;
}

/**
 * `attr_accessor`/`attr_reader`/`attr_writer :sym[, ...]` and
 * `define_method(:name) { ... }` — call shapes that stand for one or more
 * method definitions with no `def`/`method` node of their own. Returns []
 * for anything else, so the caller can safely fall through to the ordinary
 * call-edge path.
 */
function rubySynthesizedMethods(node: Parser.SyntaxNode, ctx: WalkCtx): RubySynthesizedMethod[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier") return [];
  if (node.childForFieldName("receiver")) return [];
  const args = node.childForFieldName("arguments");
  const symbols = (args?.namedChildren ?? []).filter((c) => c.type === "simple_symbol").map((c) => c.text.slice(1));

  if (methodNode.text === "attr_reader") return symbols.map((s) => ({ name: s, hashNode: node, headerEnd: node.startIndex }));
  if (methodNode.text === "attr_writer") return symbols.map((s) => ({ name: `${s}=`, hashNode: node, headerEnd: node.startIndex }));
  if (methodNode.text === "attr_accessor") {
    return symbols.flatMap((s) => [
      { name: s, hashNode: node, headerEnd: node.startIndex },
      { name: `${s}=`, hashNode: node, headerEnd: node.startIndex },
    ]);
  }
  if (methodNode.text === "define_method") {
    const sym = args?.namedChildren[0];
    if (sym?.type !== "simple_symbol") return [];
    const block = node.childForFieldName("block");
    if (!block) return [];
    return [{ name: sym.text.slice(1), hashNode: block, headerEnd: block.startIndex }];
  }
  return [];
}

/**
 * The ActiveRecord/ActiveSupport macro vocabulary.
 *
 * Rails' implicitness is *conventional*, not dynamic-in-principle: `has_many :items`
 * is an edge declaration, `before_save :normalize` names a method in the same class,
 * and `scope :active, -> {}` defines a class method. None of it needs inference — it
 * needs a parser that knows the words. This is deliberately a table rather than a
 * pattern: an unknown macro must read as "not ours" and fall through to the ordinary
 * call path, never as "probably an association."
 */
const AR_ASSOCIATIONS = new Set(["belongs_to", "has_one", "has_many", "has_and_belongs_to_many"]);
/** ActiveRecord's built-in cast types, which is how `attribute :price, :decimal` is
 * told apart from `attribute :user, :organization` — see the `attribute` branch. */
const AR_CAST_TYPES = new Set([
  "string", "text", "integer", "bigint", "float", "decimal", "numeric", "datetime", "time",
  "date", "boolean", "binary", "json", "jsonb", "uuid", "inet", "cidr", "macaddr", "money",
  "interval", "point", "line", "box", "hstore", "xml", "tsvector", "daterange", "numrange",
  "tsrange", "tstzrange", "int4range", "int8range", "array", "immutable_string",
]);
const AR_CALLBACKS = new Set([
  "before_validation", "after_validation",
  "before_save", "around_save", "after_save",
  "before_create", "around_create", "after_create",
  "before_update", "around_update", "after_update",
  "before_destroy", "around_destroy", "after_destroy",
  "after_commit", "after_rollback", "after_initialize", "after_find", "after_touch",
  "before_action", "around_action", "after_action", // ActionController, same shape
  "validate",
]);

/** The symbol arguments of a macro call (`:a, :b` → ["a","b"]), ignoring options. */
function rubySymbolArgs(args: Parser.SyntaxNode | null): string[] {
  return (args?.namedChildren ?? [])
    .filter((c) => c.type === "simple_symbol")
    .map((c) => c.text.slice(1));
}

/**
 * A literal option value from a macro's trailing hash (`class_name: "User"`).
 *
 * Returns null for anything that is not a plain string or symbol literal — a
 * constant, a method call, an interpolation. That null is load-bearing: the spec's
 * "do not synthesize what you cannot name" means the reader methods are still emitted
 * (Rails defines them regardless) while the target edge is not, because the only
 * honest description of `class_name: OWNER_CLASS` is that this pass cannot read it.
 */
/**
 * A macro option, as a tri-state.
 *
 *   - `null`             — the key is not there at all.
 *   - `{value: null}`    — the key is there and this pass cannot read it.
 *   - `{value: "User"}`  — a plain string or symbol literal.
 *   - `{value: true}`    — the literal `true` (`prefix: true`, `polymorphic: true`).
 *   - `{value: false}`   — the literal `false` (`scopes: false`).
 *
 * The middle case is the load-bearing one and it used to be indistinguishable from
 * the first. `belongs_to :owner, :class_name => OWNER_CLASS` names its target with a
 * constant this pass cannot evaluate; reading that as "no override given" made it
 * fall back to the inflected `Owner`, which is a different class. A key that is
 * present and unreadable must decline, not guess.
 *
 * Both hash syntaxes are recognised, because `:class_name => X` is not rare in older
 * Rails code and a regex for `class_name:` alone silently missed it.
 */
function rubyMacroOption(
  args: Parser.SyntaxNode | null,
  key: string,
): { value: string | boolean | null } | null {
  for (const arg of args?.namedChildren ?? []) {
    const pairs = arg.type === "hash" ? arg.namedChildren : arg.type === "pair" ? [arg] : [];
    for (const pair of pairs) {
      if (pair.type !== "pair") continue;
      const k = pair.childForFieldName("key");
      const name = k?.type === "hash_key_symbol" ? k.text : k?.type === "simple_symbol" ? k.text.slice(1) : null;
      if (name !== key) continue;
      const v = pair.childForFieldName("value");
      if (v?.type === "simple_symbol") return { value: v.text.slice(1) };
      if (v?.type === "true") return { value: true };
      if (v?.type === "false") return { value: false };
      if (v?.type !== "string") return { value: null };
      const content = v.namedChildren.find((c) => c.type === "string_content");
      // An interpolated string has no single `string_content` covering the whole
      // literal, so this also rejects `class_name: "#{prefix}User"` — correctly.
      return { value: content && content.text === v.text.slice(1, -1) ? content.text : null };
    }
  }
  return null;
}

/**
 * Which half of the controller↔template instance-variable contract a file can supply.
 *
 * `@documents` assigned in `DocumentsController#index` and read in
 * `app/views/documents/index.html.erb` is a real interface between two files that
 * never name each other — and, unlike the `renders` edge between them, one both
 * sides state in their own source. It is also the only ivar relationship worth
 * recording: everywhere else an instance variable is private to its object, and
 * emitting a carrier edge per occurrence across a whole Rails app would be tens of
 * thousands of them to describe nothing.
 *
 * So only two shapes qualify, and the test is the path, which is what the Rails
 * convention is made of in the first place.
 */
export function railsIvarRole(rel: string): "writer" | "reader" | null {
  if (RAILS_CONTROLLER_FILE.test(rel)) return "writer";
  return rel.toLowerCase().endsWith(".erb") ? "reader" : null;
}

/**
 * The ivar carriers for one node: an assignment in a controller, a read in a
 * template. Never an edge in its own right — `resolve.ts` pairs the two sides and
 * drops everything it cannot pair.
 *
 * A controller records only WRITES. A read there (`@documents.each` inside a
 * `before_action`) says nothing about what a template needs, and counting it as a
 * write would make every ivar look like it had several writers and decline the lot.
 */
function rubyIvarEdges(node: Parser.SyntaxNode, ctx: WalkCtx, edges: RawEdge[]): void {
  if (ctx.railsIvarRole === "writer") {
    if (node.type !== "assignment" && node.type !== "operator_assignment") return;
    const left = node.childForFieldName("left");
    if (left?.type !== "instance_variable") return;
    edges.push({
      source: ctx.parentId, relation: "references", name: left.text, file: ctx.rel,
      railsIvar: left.text, railsIvarWrite: true,
    });
    return;
  }
  if (node.type !== "instance_variable") return;
  edges.push({
    source: ctx.parentId, relation: "references", name: node.text, file: ctx.rel,
    railsIvar: node.text,
  });
}

/** Does this call have a positional argument at all? A `render` whose arguments are
 * all keywords (`render json: x`, `render status: :ok`) names no template; one with
 * a positional does, whether or not this pass can read it. */
function rubyHasPositionalArg(args: Parser.SyntaxNode | null): boolean {
  const first = args?.namedChildren?.[0];
  return !!first && first.type !== "pair" && first.type !== "hash";
}

/** The first positional argument of a call, when it is a plain string or symbol
 * literal and nothing else. An interpolated string, a constant, a variable or a
 * method call all return null — `render @document` and `render Card.new` name a
 * template only at runtime, and a static pass that answered them would be guessing. */
function rubyFirstLiteralArg(args: Parser.SyntaxNode | null): string | null {
  const first = args?.namedChildren?.[0];
  if (!first) return null;
  if (first.type === "simple_symbol") return first.text.slice(1);
  if (first.type !== "string") return null;
  const content = first.namedChildren.find((c) => c.type === "string_content");
  // Same test `rubyMacroOption` uses: a `string_content` that does not span the whole
  // literal means there was interpolation in it.
  return content && content.text === first.text.slice(1, -1) ? content.text : null;
}

/** A controller file, by Rails' own `app/controllers/**_controller.rb` convention —
 * which is what decides whether a bare `render "shared/banner"` names a TEMPLATE or
 * a PARTIAL. Verified: `ActionController::Base#_normalize_args("shared/banner")`
 * returns `{template: "shared/banner"}`, while the same string in a view is
 * `ActionView`'s partial shorthand. */
const RAILS_CONTROLLER_FILE = /(?:^|\/)app\/controllers\/.+_controller\.rb$/;

/**
 * Rails' render vocabulary at a CALL site — `render "shared/nav"`, `render :edit`,
 * `render partial: "row"`, `render template: "x/y"`, `render layout: "wide"`.
 *
 * Additive, not consuming: `render` is ActionView's, no repo defines it, and the
 * ordinary call edge this call also produces resolves to nothing on its own. What is
 * emitted here is the template SPEC as written; turning it into a path is
 * `resolve.ts`'s job, because only it knows which templates were actually indexed
 * and an edge to a template that is not there must not exist.
 *
 * Everything that is not a literal declines. `render @document` really does render a
 * template in Rails — `app/views/documents/_document.html.erb`, via the model's
 * `to_partial_path` — and it is left alone anyway: that path depends on the object's
 * CLASS at runtime, and `@document` has no type here.
 */
function rubyRenderEdges(node: Parser.SyntaxNode, ctx: WalkCtx): RawEdge[] {
  if (node.childForFieldName("receiver")) return []; // `x.render` is somebody else's
  const method = node.childForFieldName("method");
  if (method?.text !== "render" && method?.text !== "render_to_string") return [];
  const args = node.childForFieldName("arguments");
  const out: RawEdge[] = [];
  const emit = (spec: string, kind: "template" | "partial" | "layout"): void => {
    out.push({
      source: ctx.parentId,
      relation: "renders",
      name: spec,
      file: ctx.rel,
      railsTemplateSpec: spec,
      railsTemplateKind: kind,
    });
  };

  const partial = rubyMacroOption(args, "partial");
  const template = rubyMacroOption(args, "template");
  const layout = rubyMacroOption(args, "layout");
  if (typeof partial?.value === "string") emit(partial.value, "partial");
  if (typeof template?.value === "string") emit(template.value, "template");
  // `layout:` rides ALONGSIDE whatever is being rendered rather than replacing it,
  // which is why it is not part of the either/or below.
  if (typeof layout?.value === "string") emit(layout.value, "layout");
  const inController = RAILS_CONTROLLER_FILE.test(ctx.rel);
  const positional = rubyHasPositionalArg(args);
  // The positional spec, unless an explicit key already said what this renders.
  if (!partial && !template) {
    const first = rubyFirstLiteralArg(args);
    if (first !== null) emit(first, inController ? "template" : "partial");
  }
  // In a controller, a render that REPLACES the action's template matters beyond
  // what it names: Rails reaches the naming convention only for an action that
  // rendered nothing, so `def update; render @document; end` never renders
  // `update.html.erb`. A spec-less carrier records that, and it is the unnameable
  // renders — `render @document`, `render "shared/#{x}"` — that need it most,
  // because those have no edge of their own to supersede the convention with.
  //
  // `render json:` is deliberately NOT one of them, and the distinction is not
  // pedantic: the commonest shape in a real controller is
  //
  //     def index
  //       respond_to do |format|
  //         format.html
  //         format.json { render json: @document_types }
  //       end
  //     end
  //
  // where the HTML branch renders `index.html.erb` by the convention and the JSON
  // branch renders no template at all. Suppressing on any `render` whatsoever cost
  // exactly those four edges on filewerk, every one of them real.
  if (inController && (positional || partial || template)) {
    out.push({ source: ctx.parentId, relation: "renders", file: ctx.rel });
  }
  return out;
}

/**
 * Apply a macro's `prefix:`/`suffix:` options to the names it would otherwise define.
 *
 * Returns null when an option is present but cannot be read — synthesize nothing
 * rather than a method under a name Rails will not use. `fallback` is what
 * `prefix: true` means for this macro: the delegation target, the store column, the
 * enum attribute.
 */
function rubyAffixNames(
  names: string[],
  args: Parser.SyntaxNode | null,
  fallback: string | null,
): string[] | null {
  const prefix = rubyMacroAffix(args, "prefix", fallback);
  const suffix = rubyMacroAffix(args, "suffix", fallback);
  if (prefix === "unreadable" || suffix === "unreadable") return null;
  if (!prefix && !suffix) return names;
  return names.map((n) => {
    const head = prefix ? `${prefix.affix}_` : "";
    const tail = suffix ? `_${suffix.affix}` : "";
    return `${head}${n}${tail}`;
  });
}

/** A macro option that names something (`class_name:`, `source:`), as a plain string,
 * or null when it is absent OR unreadable — for the callers that treat both the same. */
function rubyMacroName(args: Parser.SyntaxNode | null, key: string): string | null {
  const opt = rubyMacroOption(args, key);
  return typeof opt?.value === "string" ? opt.value : null;
}

/**
 * The affix a naming option asks for, or null when there is none.
 *
 * `prefix: true` means "use `fallback`" — the delegation target for `delegate`, the
 * store column for `store_accessor`, the attribute for `enum`. `prefix: :admin` names
 * it outright. Anything else (an unreadable value) yields null, and the caller then
 * synthesizes nothing rather than a method under the wrong name.
 */
function rubyMacroAffix(
  args: Parser.SyntaxNode | null,
  key: string,
  fallback: string | null,
): { affix: string } | "unreadable" | null {
  const opt = rubyMacroOption(args, key);
  if (opt === null) return null;
  if (opt.value === false) return null;
  if (opt.value === true) return fallback ? { affix: fallback } : "unreadable";
  if (typeof opt.value === "string") return { affix: opt.value };
  return "unreadable";
}

/** Every `%i[...]`/`%w[...]`/array-of-symbols entry, for `enum`. */
function rubyEnumValues(node: Parser.SyntaxNode | null): string[] {
  if (!node) return [];
  if (node.type === "array" || node.type === "symbol_array" || node.type === "string_array") {
    return node.namedChildren
      .map((c) => (c.type === "simple_symbol" ? c.text.slice(1) : c.type === "bare_symbol" || c.type === "bare_string" || c.type === "string_content" ? c.text : null))
      .filter((x): x is string => !!x);
  }
  return [];
}

/**
 * The methods a Rails macro declares. Same contract as `rubySynthesizedMethods`,
 * which is why it returns the same shape and hangs off the same call site — PR #275's
 * author named this as the follow-up in exactly those terms, and Phase 5's
 * `attr_accessor` handling is the template rather than a thing to redesign.
 *
 * Every node this produces gets `origin: "synthesized"`: there is no `def` anywhere,
 * and the span points at the macro call, so a reader must be able to tell it from a
 * method someone actually typed.
 */
function rubyMacroMethods(node: Parser.SyntaxNode, ctx: WalkCtx): RubySynthesizedMethod[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier" || node.childForFieldName("receiver")) return [];
  const macro = methodNode.text;
  const args = node.childForFieldName("arguments");
  const syms = rubySymbolArgs(args);
  const at = (name: string): RubySynthesizedMethod => ({ name, hashNode: node, headerEnd: node.startIndex, receiver: "instance" });

  if (AR_ASSOCIATIONS.has(macro)) {
    const name = syms[0];
    if (!name) return [];
    const out = [at(name), at(`${name}=`)];
    if (macro === "belongs_to" || macro === "has_one") {
      out.push(at(`build_${name}`), at(`create_${name}`));
      // `reload_x` exists on belongs_to only; has_one gets `reload_x` too in modern
      // Rails, but only belongs_to is documented for it across the versions this
      // has to describe, so has_one stops short rather than claiming a method that
      // may not be there.
      if (macro === "belongs_to") out.push(at(`reload_${name}`));
    } else {
      const singular = associationConstant(name, ctx.rubyRails!.acronyms)
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
      out.push(at(`${singular}_ids`), at(`${singular}_ids=`));
    }
    return out;
  }

  if (macro === "scope" || macro === "default_scope") {
    // A scope's lambda IS the method's body, so the node spans the lambda and the
    // walk descends into it — the same shape `define_method` already uses, and the
    // reason matters: consuming the macro without descending silently drops every
    // call inside the scope. Measured, not theoretical — `scope :for_organization,
    // ->(org) { ... Current.system_admin? }` in filewerk-rails lost its call edge
    // that way, and the eval caught it as two missing answers.
    const body = rubyLambdaBody(args);
    const name = macro === "default_scope" ? "default_scope" : syms[0];
    if (!name) return [];
    // A scope is a CLASS method: `Post.recent`, never `post.recent`. It is also what
    // a `has_many` collection proxy forwards, which is why `blog.posts.recent`
    // resolves while `blog.posts.publish` does not.
    return body
      ? [{ name, hashNode: body, headerEnd: body.startIndex, receiver: "class" as RubySelfKind }]
      : [{ ...at(name), receiver: "class" as RubySelfKind }];
  }
  if (macro === "attribute") {
    // Two macros share this name and they disagree about their own arguments.
    // ActiveRecord's is `attribute :price, :decimal` — one attribute, then a CAST
    // TYPE. ActiveSupport::CurrentAttributes' is `attribute :user, :organization,
    // :system_admin` — every symbol is an attribute. Reading the second as the first
    // is not hypothetical: filewerk-rails' `Current` declares five that way, and
    // taking only the head would arbitrarily grant `user` its reader while denying
    // `organization` one, purely on argument order.
    //
    // The types are a closed, known set, so the trailing symbols answer it: all of
    // them types means the ActiveRecord form, anything else means they are names.
    const isActiveRecordForm = syms.length > 1 && syms.slice(1).every((t) => AR_CAST_TYPES.has(t));
    const names = isActiveRecordForm ? syms.slice(0, 1) : syms;
    // ActiveRecord's `attribute :price, :decimal` declares an instance accessor.
    // CurrentAttributes' `attribute :user` declares BOTH — `Current.user` delegates
    // to `Current.instance.user` — and `Current.user` is one of the most-called
    // receivers in a Rails app. Neither reading is wrong, so it claims neither.
    const recv: RubySelfKind | undefined = isActiveRecordForm ? "instance" : undefined;
    return names.flatMap((n) => [{ ...at(n), receiver: recv }, { ...at(`${n}=`), receiver: recv }]);
  }
  if (macro === "store_accessor") {
    // `store_accessor :settings, :theme, prefix: true` defines `settings_theme`, NOT
    // `theme` — verified against a running ActiveRecord, which is also where the
    // `suffix:` spelling (`theme_settings`) came from. Synthesizing the unprefixed
    // name invents a method the class does not have, and a false method is not an
    // inert one: it can absorb a callback and it adds ambiguity that suppresses a
    // real match elsewhere.
    const column = syms[0];
    if (!column) return [];
    const keys = syms.slice(1);
    const affixed = rubyAffixNames(keys, args, column);
    if (affixed === null) return [];
    // The store column is an ordinary attribute of its own, unaffected by the option.
    return [at(column), at(`${column}=`), ...affixed.flatMap((n) => [at(n), at(`${n}=`)])];
  }
  if (macro === "delegate") {
    // `delegate :name, :email, to: :user` — every symbol except the `to:` target,
    // which lives in the options hash and is therefore not in `syms`.
    //
    // `prefix: true` renames all of them after the target (`user_name`), and
    // `prefix: :admin` after the given word. Getting this wrong is what put a bare
    // `name` on the class.
    const to = rubyMacroName(args, "to");
    const affixed = rubyAffixNames(syms, args, to);
    return affixed === null ? [] : affixed.map((sN) => at(sN));
  }
  if (macro === "enum") {
    // Two spellings: `enum status: %i[draft live]` (classic) and
    // `enum :status, %i[draft live]` (Rails 7+). Both declare the same methods.
    let values: string[] = [];
    const attrName = syms[0] ?? null;
    for (const arg of args?.namedChildren ?? []) {
      const pairs = arg.type === "hash" ? arg.namedChildren : arg.type === "pair" ? [arg] : [];
      for (const pair of pairs) if (pair.type === "pair") values.push(...rubyEnumValues(pair.childForFieldName("value")));
      values.push(...rubyEnumValues(arg));
    }
    // `prefix:`/`suffix:` rename every generated method after the attribute, and
    // `scopes: false` / `instance_methods: false` remove whole families of them. An
    // enum declared with both off generates NOTHING, and this used to synthesize six
    // methods for it. Confirmed against a running ActiveRecord in each combination.
    const named = rubyAffixNames(values, args, attrName);
    if (named === null) return [];
    const scopes = rubyMacroOption(args, "scopes")?.value !== false;
    const instanceMethods = rubyMacroOption(args, "instance_methods")?.value !== false;
    return named.flatMap((v) => [
      ...(scopes ? [at(v)] : []),
      ...(instanceMethods ? [at(`${v}?`), at(`${v}!`)] : []),
    ]);
  }
  return [];
}

/** The reader method an association macro generates — the name its extension block's
 * methods hang off. Null for any other macro, which never takes one. */
/** The scope segment `class_methods do` contributes — the name Rails gives the
 * module it builds. Shared with bindings.ts's own walk, which must push the same
 * segment or every binding inside the block is filed where nothing looks. */
export const RUBY_CLASS_METHODS = "ClassMethods";

/** `class_methods do ... end` (bare, with a block) → the block's body. */
function rubyClassMethodsBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const m = node.childForFieldName("method");
  if (m?.type !== "identifier" || m.text !== "class_methods" || node.childForFieldName("receiver")) return null;
  const block = node.childForFieldName("block");
  return block?.type === "do_block" || block?.type === "block" ? (block.childForFieldName("body") ?? block) : null;
}

/** Whether an association hands back ONE record or a collection proxy. The proxy is
 * a different object with a different method set — see `RawEdge.rubyReturnsKind`. */
function rubyAssociationKind(macro: string): RubyValueKind {
  return macro === "belongs_to" || macro === "has_one" ? "instance" : "collection";
}

function rubyAssociationReader(node: Parser.SyntaxNode): string | null {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier" || !AR_ASSOCIATIONS.has(methodNode.text)) return null;
  if (node.childForFieldName("receiver")) return null;
  return rubySymbolArgs(node.childForFieldName("arguments"))[0] ?? null;
}

/**
 * The class an association names, or null when the declaration does not establish one.
 *
 * Every branch here is a case where the inflected guess is provably not the answer,
 * and each was reproduced against a running Rails before it was written:
 *
 *   - `polymorphic: true` has no single target class by definition. `belongs_to
 *     :subject, polymorphic: true` was pointing at an unrelated `Subject` model.
 *   - `through:` names an association on ANOTHER class, so the target is whatever
 *     that one resolves to — `has_many :members, through: :memberships, source: :user`
 *     is `User`, and was pointing at an unrelated `Member`. The `source:`/`class_name:`
 *     forms are readable here; the bare `through:` form is not, because it needs the
 *     other class's declarations, which this pass has not seen yet.
 *   - a `class_name:` that is present but unreadable means "cannot name it", and must
 *     not fall through to the plural's implication.
 *
 * Declining costs an edge. Guessing costs an agent a refactor against the wrong model.
 */
function rubyAssociationTarget(
  macro: string,
  name: string,
  args: Parser.SyntaxNode | null,
  ctx: WalkCtx,
): string | null {
  const className = rubyMacroOption(args, "class_name");
  if (className) return typeof className.value === "string" ? className.value : null;
  if (rubyMacroOption(args, "polymorphic")?.value === true) return null;
  const through = rubyMacroOption(args, "through");
  if (through) {
    // `source:` names the association on the through-class and REDIRECTS the target:
    // `has_many :members, through: :memberships, source: :user` is a collection of
    // `User`, and the plural's own implication — `Member` — is a different model that
    // happens to exist. `source_type:` names the class outright.
    //
    // With neither, the plural's implication is right, because that is exactly what
    // Rails itself falls back to: it looks for an association named `:tags` or `:tag`
    // on the through-class, and absent a `class_name:` override there, that is `Tag`.
    // Declining the whole bare form was measured to cost real edges — `has_many :tags,
    // through: :document_tags` among them — to guard a case this cannot see anyway.
    if (typeof through.value !== "string" && through.value !== true) return null;
    const sourceType = rubyMacroName(args, "source_type");
    if (sourceType) return sourceType;
    const source = rubyMacroOption(args, "source");
    if (source) return typeof source.value === "string" ? associationConstant(source.value, ctx.rubyRails!.acronyms) : null;
  }
  return associationConstant(name, ctx.rubyRails!.acronyms);
}

/**
 * The edges a Rails macro declares, as opposed to the methods.
 *
 * `classId` is the enclosing class/module node — the declaration site, which is what
 * a `callers` query on an association should surface.
 */
/**
 * The scopes Rails searches for an association's class, which are NOT the ones Ruby
 * searches for a bare constant.
 *
 * `ActiveRecord::Inheritance#compute_type` walks the MODEL's own namespace: for
 * `Admin::Post` and a `:user` association it tries `Admin::Post::User`, then
 * `Admin::User`, then `::User`. Ruby's lexical nesting for the compact spelling
 * `class Admin::Post` is just `["Admin::Post"]` — `Admin` is not in it — so the two
 * disagree exactly when a namespaced model shadows a top-level one, which is the
 * case the compact form makes common. Verified against ActiveRecord 8.1: the
 * association resolves to `Admin::User`, and M3's lexical lookup answered `::User`.
 */
function rubyAssocNesting(ctx: WalkCtx): string[] {
  const own = ctx.rubyOwner;
  if (!own) return [...ctx.rubyNesting];
  const segs = own.split("::");
  const out: string[] = [];
  for (let i = segs.length; i > 0; i--) out.push(segs.slice(0, i).join("::"));
  return out;
}

/**
 * What resolve.ts needs to FOLLOW a `through:` association instead of guessing at it.
 *
 * `has_many :people, through: :memberships, source: :person` names no class. Rails
 * reads the `person` reflection on `Membership`, and if that declares `class_name:
 * "User"` the collection is of `User` — verified against ActiveRecord 8.1, where an
 * unrelated `Person` model also existed and was NOT the answer. M2 inflected
 * `source:` directly and referenced `Person`.
 *
 * Empty when the declaration already names its class outright (`class_name:`,
 * `source_type:`), or when `through:`/`source:` is written as something this pass
 * cannot read.
 */
function rubyThroughFields(name: string, args: Parser.SyntaxNode | null, ctx: WalkCtx): Partial<RawEdge> {
  if (rubyMacroOption(args, "class_name") || rubyMacroName(args, "source_type")) return {};
  const through = rubyMacroOption(args, "through");
  if (!through || typeof through.value !== "string") return {};
  const source = rubyMacroOption(args, "source");
  if (source && typeof source.value !== "string") return {};
  // Rails looks for an association named `:tags`, then `:tag`, on the join model —
  // the same fallback pair its own `source_reflection_name` tries.
  const singular = associationConstant(name, ctx.rubyRails!.acronyms)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return {
    rubyAssocThrough: through.value,
    rubyAssocSourceNames: source ? [source.value as string] : [name, singular],
  };
}

function rubyMacroEdges(node: Parser.SyntaxNode, ctx: WalkCtx, classId: string): RawEdge[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier" || node.childForFieldName("receiver")) return [];
  const macro = methodNode.text;
  const args = node.childForFieldName("arguments");
  const syms = rubySymbolArgs(args);
  const out: RawEdge[] = [];

  if (macro === "routing") {
    for (const pair of args?.namedChildren ?? []) {
      if (pair.type !== "pair") continue;
      const value = pair.childForFieldName("value");
      // Ruby symbols/strings only; interpolation and runtime-selected mailboxes
      // do not name a statically verifiable processing endpoint.
      const name = value?.type === "simple_symbol" ? value.text.slice(1)
        : value?.type === "string" && value.namedChildren.length === 1 && value.namedChildren[0].type === "string_content" ? value.namedChildren[0].text : null;
      if (!name || !/^[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)*$/.test(name)) continue;
      const target = name.split("/").map(part => camelize(part, ctx.rubyRails!.acronyms)).join("::") + "Mailbox";
      out.push({ source: classId, relation: "dispatches", name: target, file: ctx.rel,
        rubyOwnerFqn: ctx.rubyOwner, rubyMailbox: "routing" });
    }
    return out;
  }
  if (macro === "before_processing" || macro === "after_processing" || macro === "around_processing") {
    for (const sym of syms) out.push({ source: classId, relation: "dispatches", name: sym, file: ctx.rel,
      rubyOwnerFqn: ctx.rubyOwner, rubyMailbox: macro });
    return out;
  }

  if (AR_ASSOCIATIONS.has(macro) && syms[0]) {
    const target = rubyAssociationTarget(macro, syms[0], args, ctx);
    if (target) {
      out.push({
        source: classId, relation: "references", name: target, file: ctx.rel,
        nesting: rubyAssocNesting(ctx), // Rails' namespace walk, not Ruby's lexical nesting
        rubyAssocName: syms[0],
        ...rubyThroughFields(syms[0], args, ctx),
        // Declared inside an `included do`, this association belongs to each class
        // that includes the concern, exactly as a callback declared there does.
        ...(ctx.rubyIncludedBlock ? { viaConcern: true } : {}),
      });
    }
    return out;
  }

  if (AR_CALLBACKS.has(macro)) {
    // The sleeper win: `before_save :normalize_email` is a symbol literal that
    // nothing connects to `def normalize_email`, and it is unambiguous. Spelled as
    // a member call on the enclosing class so it resolves owner-qualified — which
    // also walks the superclass chain — and declines when no such method exists.
    for (const sym of syms) {
      out.push({
        source: classId, relation: "calls", name: sym, file: ctx.rel,
        viaMember: true, recvType: ctx.enclosingClass!,
        ...(ctx.rubyOwner ? { rubyOwnerFqn: ctx.rubyOwner } : {}),
        ...(ctx.rubyIncludedBlock ? { viaConcern: true } : {}),
      });
    }
    return out;
  }

  if (macro === "helper_method") {
    // `helper_method :current_user` exports a controller method to every template
    // that controller renders. Emitted with the same shape as `validates` — an
    // owner-qualified `references` that declines when the class has no such method —
    // plus the flag that tells resolve.ts to file the target under a name a
    // template's bare words may resolve to. A template's `self` is an
    // `ActionView::Base`, so without a declaration like this one a bare word in a
    // view has nothing it can legitimately reach.
    for (const sym of syms) {
      out.push({
        source: classId, relation: "references", name: sym, file: ctx.rel,
        recvType: ctx.enclosingClass!,
        railsHelperExport: true,
        ...(ctx.rubyOwner ? { rubyOwnerFqn: ctx.rubyOwner } : {}),
        ...(ctx.rubyIncludedBlock ? { viaConcern: true } : {}),
      });
    }
    return out;
  }

  if (macro === "layout" && ctx.enclosingClass !== null) {
    // `layout "admin"` names a template outright. One edge from the class, at the
    // class, because a layout applies to every action it declares — including the
    // ones a subclass adds, which is why the SOURCE is the controller and not an
    // action. `layout nil`, `layout :method_name` and `layout false` name no file
    // and produce nothing; `rubyFirstLiteralArg` is what declines them. Gated on
    // being inside a class because `layout` is an ordinary English word — and
    // because, unlike `has_many`, a method could plausibly be called that.
    const spec = rubyFirstLiteralArg(args);
    if (spec !== null) {
      out.push({
        source: classId, relation: "renders", name: spec, file: ctx.rel,
        railsTemplateSpec: spec, railsTemplateKind: "layout",
      });
    }
    return out;
  }

  if (macro === "validates" || macro === "validates_presence_of") {
    // Points at the attribute when one exists as a node — usually only when it was
    // itself declared by a macro (`attribute :email`) or written by hand. A plain DB
    // column has no node, so most of these resolve to nothing, which is correct.
    for (const sym of syms) {
      out.push({
        source: classId, relation: "references", name: sym, file: ctx.rel,
        recvType: ctx.enclosingClass!,
        ...(ctx.rubyOwner ? { rubyOwnerFqn: ctx.rubyOwner } : {}),
        ...(ctx.rubyIncludedBlock ? { viaConcern: true } : {}),
      });
    }
    return out;
  }
  return out;
}

/**
 * `delegate :name, :email, to: :user` — the forward, as a call from each generated
 * method to the one it actually reaches.
 *
 * The generated methods themselves are `rubyMacroMethods`' business; this is the
 * type edge. `Post#user_name` calling `User#name` is exactly the chain M3 resolves
 * for `post.user.name` written out by hand, so it is spelled the same way: base
 * `self`, one step through the `to:` reader, then the delegated name. Everything
 * that makes the chain decline elsewhere declines here too — a `to:` target with
 * no declared type (`to: :class`, a plain `attr_reader`) simply resolves to
 * nothing, which is the honest answer for a forward whose destination is unknown.
 *
 * A delegated name the class also writes out with a real `def` was never minted,
 * so it has no id here and gets no edge: the `def` is what runs, and it does not
 * forward.
 */
function rubyDelegateForwards(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
  mintedIds: ReadonlyMap<string, string>,
): RawEdge[] {
  const methodNode = node.childForFieldName("method");
  if (methodNode?.type !== "identifier" || methodNode.text !== "delegate") return [];
  if (node.childForFieldName("receiver")) return [];
  const own = ctx.rubyOwner;
  if (!own) return [];
  const args = node.childForFieldName("arguments");
  const to = rubyMacroName(args, "to");
  if (!to) return [];
  const syms = rubySymbolArgs(args);
  const local = rubyAffixNames(syms, args, to);
  if (local === null) return [];
  const out: RawEdge[] = [];
  for (let i = 0; i < syms.length; i++) {
    const id = mintedIds.get(local[i]);
    if (!id) continue;
    out.push({
      source: id,
      relation: "calls",
      name: syms[i],
      file: ctx.rel,
      viaMember: true,
      rubyRecvBase: "self",
      rubyOwnerFqn: own,
      // `delegate :x, to: :y` writes `def x; y.x; end` — an instance method calling a
      // reader on the same instance.
      rubyRecvKind: "instance",
      rubyRecvSteps: [to],
    });
  }
  return out;
}

/** The `{ ... }` / `do ... end` body of a lambda argument, which is what a `scope`
 * macro's second argument always is. Null when the macro was given something else
 * (a symbol, a method reference), in which case there is no body to descend into. */
function rubyLambdaBody(args: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== "lambda") continue;
    const body = arg.childForFieldName("body");
    if (body) return body;
  }
  return null;
}

/** Is this node the `included do ... end` block of an `ActiveSupport::Concern`? */
function rubyIncludedDoBlock(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type !== "call") return null;
  const m = node.childForFieldName("method");
  if (m?.type !== "identifier" || m.text !== "included" || node.childForFieldName("receiver")) return null;
  return node.childForFieldName("block") ?? null;
}

function emitRubySynthesizedMethod(
  m: RubySynthesizedMethod,
  ctx: WalkCtx,
  out: NodeV1[],
  edges: RawEdge[],
  minted: Set<string>,
  origin: NodeV1["origin"],
): string {
  const base = `${ctx.rel}#${[...ctx.scope, m.name].join(".")}`;
  const id = mintId(base, minted);
  out.push({
    id,
    name: m.name,
    kind: "method",
    path: ctx.rel,
    span: `L${m.hashNode.startPosition.row + 1}-L${m.hashNode.endPosition.row + 1}`,
    signature: clean(ctx.source.slice(m.hashNode.startIndex, m.headerEnd)),
    exported: rubyExported(m.name, ctx),
    origin,
    body_hash: contentHash(m.hashNode.text),
    body_text: searchBody(m.hashNode.text),
    summary_state: "pending",
    summary: null,
    crux: null,
    owner: ctx.enclosingClass ?? undefined,
    ...(m.receiver !== undefined ? { receiver: m.receiver } : {}),
  });
  edges.push({ source: ctx.parentId, relation: "contains", targetId: id, file: ctx.rel });
  // define_method's block body can contain further calls/definitions — walk
  // it under a child scope exactly like an ordinary method body would get.
  // attr_* synthesized methods have no such body (m.hashNode is the whole
  // call node, nothing further to descend into beyond what the outer walk
  // already will).
  if (m.hashNode.type === "block" || m.hashNode.type === "do_block") {
    const childCtx: WalkCtx = {
      ...ctx,
      scope: [...ctx.scope, m.name],
      enclosingKind: "method",
      parentId: id,
      // What `self` is inside the block, which decides what a bare word there can
      // reach. A `scope`'s lambda runs on the class — `scope :recent, -> { where(…) }`
      // — while a `define_method` block runs on an instance. Inheriting the class
      // body's reading for both would look every bare call in a `define_method` up
      // among the class methods.
      rubySelfKind: m.receiver ?? "instance",
    };
    for (const child of m.hashNode.namedChildren) walk(child, childCtx, out, edges, minted);
  }
  return id;
}

/**
 * Does this bare `identifier` invoke a method, as opposed to reading a
 * local variable or a parameter? Ruby's optional parens make the two
 * spellings identical, so this is a position question plus a variable question.
 *
 * Before M3 the answer was one narrow position — a bare word standing alone as its
 * own statement — and that function's own comment admitted both costs: a local
 * variable read that way misfired as a call, and every OTHER position was given up
 * on, because listing them meant listing the declaration positions too and missing
 * one of those is a wrong edge rather than an absent one.
 *
 * M3 supplies the missing half. `bindings.isRubyVar` says which names are variables
 * here, so the position rule no longer carries that weight alone, and the positions
 * become an inclusion list of places a value is READ (`RUBY_VALUE_PARENTS`). What
 * that buys, measured on filewerk-rails: `old_user = user` inside
 * `Current#with_user` and the three `*_template` reads inside
 * `UploadZone::Component#filtered_html_options` — an assignment right-hand side and
 * three hash values, all genuine implicit-self calls M0-M2 could not see. Plus
 * receiver position, `organization.id`, the shape both real call sites of
 * `BulkActionsService#organization` take.
 *
 * Receiver position in particular is unusable without `isRubyVar`:
 * `initialize(organization:)` in that same class makes `organization.id` inside
 * `initialize` a local read, and `e.message` in every rescue clause in the app
 * would become a call on the enclosing class.
 */
function rubyBareCallPosition(node: Parser.SyntaxNode, ctx: WalkCtx): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (!rubyIsValuePosition(node, parent)) return false;
  return !rubyIsVar(node, ctx);
}

/**
 * Node types whose named children are VALUES being read, never names being
 * declared. An inclusion list, deliberately, and not the exclusion list the shape
 * of the problem keeps suggesting: a position missing from this set costs one
 * edge, while a declaration position missing from an exclusion set would turn
 * `def foo` and `|foo|` into calls on the enclosing class. Every entry was read
 * off the grammar with a parse dump, not assumed.
 *
 * Notable absentees, each on purpose:
 *   - `method`/`singleton_method`/`class`/`module` — their `name` child.
 *   - every `*_parameter` node and the three parameter lists.
 *   - `in_clause` — Ruby 3 pattern matching BINDS names inside it (`in {name: n}`),
 *     so nothing under it is a read. Its `case_match` subject is, and that is listed.
 *   - `alias`/`undef` — both take method names, not values.
 */
const RUBY_VALUE_PARENTS: ReadonlySet<string> = new Set([
  // statement lists: an identifier standing alone as its own statement.
  // `program` is the FILE's own statement list, and it is here because of ERB
  // (M4): a template stitches to Ruby at top level, so `<%= current_user %>` — the
  // commonest tag there is — parses as a lone identifier whose parent is `program`
  // and nothing else. It is the same read in a `.rb` file, where Ruby also calls it;
  // measured on filewerk and dailywerk, adding it moved no `.rb` edge at all.
  "program",
  "body_statement", "block_body", "then", "else", "ensure", "do", "begin",
  // expressions
  "argument_list", "right_assignment_list", "binary", "unary", "conditional",
  "array", "interpolation", "parenthesized_statements", "splat_argument",
  "block_argument", "hash_splat_argument",
  // conditions and case subjects
  "if", "unless", "while", "until", "elsif", "when", "case", "case_match",
]);

/**
 * Is this identifier in a position where it reads a value?
 *
 * Three parent types need a field check rather than a blanket answer, because
 * each holds both a name and a value:
 *   - `assignment`/`operator_assignment` — `left` is a target, `right` is a read.
 *   - `pair` — the `value` is a read.
 *   - `call` — the `receiver` is a read (`organization.id` really does call
 *     `attr_reader :organization`), while the `method` field is the name being
 *     called and already has its own edge. Reading `user.name`'s `name` as a call
 *     on the ENCLOSING class would be a confidently wrong edge.
 */
function rubyIsValuePosition(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): boolean {
  if (parent.type === "assignment" || parent.type === "operator_assignment") {
    return sameSyntaxNode(parent.childForFieldName("right"), node);
  }
  if (parent.type === "pair") return sameSyntaxNode(parent.childForFieldName("value"), node);
  if (parent.type === "call") return sameSyntaxNode(parent.childForFieldName("receiver"), node);
  return RUBY_VALUE_PARENTS.has(parent.type);
}

/** Java definition shapes. Uniform in a way Go's are not: every declaration carries
 * a `name` field and (for types and most members) a `body`, so one mapped lookup
 * covers classes, interfaces, enums, records, methods, and constructors. Methods are
 * lexically nested in their type, so — unlike Go — they need no receiver qualification. */
function describeJava(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  const mapped = ctx.kinds[node.type];
  if (!mapped) return null;
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const body = node.childForFieldName("body");
  const desc: DefDescriptor = {
    name,
    kind: mapped,
    headerEnd: body ? body.startIndex : node.endIndex,
    hashNode: node,
  };
  // Only callables carry arity. A record declaration also has a `parameters` node,
  // but its components are not an overload set and must never be filtered against.
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const params = node.childForFieldName("parameters");
    if (params) {
      const declared = params.namedChildren.filter(
        (c) => c.type === "formal_parameter" || c.type === "spread_parameter",
      );
      desc.arity = declared.length;
      if (declared.some((c) => c.type === "spread_parameter")) desc.variadic = true;
    }
  }
  return desc;
}

/** Kotlin definition shapes. Unlike Java's, tree-sitter-kotlin exposes no `name`
 * or `body` fields: a definition's name is an unnamed `simple_identifier` (functions)
 * or `type_identifier` (types) child, and its body is a `class_body` / `function_body`
 * / `statements` child. `class_declaration` also folds classes, interfaces, and enum
 * classes into one node type — the kind is read off the declaration's own keywords. */
function describeKotlin(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (type parameters, primary
  // constructor parameters and delegation specifiers are all nested beneath it).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (receiver type, params
  // and type parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  // `class X : A, B()` heritage lives in `delegation_specifier` children; a nested
  // type parameter's identifier is one of the same node type, so only direct children
  // count as the declared name.
  const headEnd = (type: string): number => {
    const body = node.namedChildren.find((c) => c.type === type);
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const name = typeName();
    if (!name) return null;
    let kind: Kind = "class";
    if (node.namedChildren.some((c) => c.type === "enum_class_body")) kind = "enum";
    else if (node.children.some((c) => c.type === "interface")) kind = "interface";
    else {
      const mods = node.namedChildren.find((c) => c.type === "modifiers");
      // `annotation class` → the interface role Java's annotation_type_declaration plays.
      if (mods?.namedChildren.some((c) => c.type === "class_modifier" && c.text === "annotation"))
        kind = "interface";
    }
    const body = node.namedChildren.find(
      (c) => c.type === "class_body" || c.type === "enum_class_body",
    );
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: node };
  }

  if (node.type === "object_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "class", headerEnd: headEnd("class_body"), hashNode: node };
  }

  if (node.type === "function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind = KOTLIN_TYPE_KINDS.has(ctx.enclosingKind ?? "file") ? "method" : "function";
    return { name, kind, headerEnd: headEnd("function_body"), hashNode: node };
  }

  if (node.type === "secondary_constructor") {
    // Constructors carry no name of their own — they are the class's own, so scope the
    // node under the enclosing class the same way Java's constructor_declaration does.
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("statements"),
      hashNode: node,
    };
  }

  if (node.type === "type_alias") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `val`/`var` only — a class property is a field, not a definition node
    // (no depth tier emits fields), so it must not become one.
    if (ctx.enclosingKind !== null) return null;
    const decl = node.namedChildren.find((c) => c.type === "variable_declaration");
    const name = decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/** Swift definition shapes. Like Kotlin's, tree-sitter-swift exposes no `name` or
 * `body` fields: a definition's name is a direct `type_identifier` (types) or
 * `simple_identifier` (functions) child, and its body is a `class_body` /
 * `enum_class_body` / `protocol_body` / `function_body` child. One
 * `class_declaration` node type covers `class`, `struct`, `enum`, `actor` AND
 * `extension` — the declaration's own keyword token tells them apart. */
function describeSwift(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  // The first direct `type_identifier` is the declared name (generic parameters and
  // inheritance specifiers are all nested beneath other child nodes).
  const typeName = (): string | null =>
    node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  // The first direct `simple_identifier` is the function name (parameters and
  // generic parameters are all nested beneath other child nodes).
  const funcName = (): string | null =>
    node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  const headEnd = (...types: string[]): number => {
    const body = node.namedChildren.find((c) => types.includes(c.type));
    return body ? body.startIndex : node.endIndex;
  };

  if (node.type === "class_declaration") {
    const kw = node.children.find(
      (c) =>
        c.type === "class" ||
        c.type === "struct" ||
        c.type === "enum" ||
        c.type === "actor" ||
        c.type === "extension",
    )?.type;
    let name: string | null;
    if (kw === "extension") {
      // `extension Point { … }` has no name of its own — the extended type's IS its
      // identity, so the node takes that name: members mint as `Point.method`,
      // `enclosingClass` becomes `Point`, and a member call on a Point receiver
      // resolves to them exactly as if they were declared on the type. A qualified
      // target (`extension Swift.Array`) reduces to its last component, matching
      // how the extended type is itself named in the graph.
      //
      // Its KIND is "module", not "class": the type usually already has a real
      // declaration, and a second same-named "class" node would make the name
      // AMBIGUOUS to resolveName — every `Point(...)` initializer call and every
      // `: Point` heritage target would then drop instead of resolving (resolve
      // never guesses between same-named candidates). "module" keeps the node out
      // of type-name resolution entirely while SWIFT_TYPE_KINDS still makes it
      // own its members; typed member calls are untouched either way, since they
      // go through the owner-qualified method index, not the type's own node.
      const ut = node.namedChildren.find((c) => c.type === "user_type");
      const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
      name = ids.length ? ids[ids.length - 1]!.text : null;
    } else {
      name = typeName();
    }
    if (!name) return null;
    // An actor is class-like (reference semantics, methods) and there is no
    // dedicated actor kind, so it takes "class".
    const kind: Kind =
      kw === "extension" ? "module" : kw === "struct" ? "struct" : kw === "enum" ? "enum" : "class";
    return { name, kind, headerEnd: headEnd("class_body", "enum_class_body"), hashNode: node };
  }

  if (node.type === "protocol_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "interface", headerEnd: headEnd("protocol_body"), hashNode: node };
  }

  // A protocol requirement (`protocol_function_declaration`) has no body and is
  // always a member; an ordinary `function_declaration` is a method exactly when
  // it is nested in a type (or an extension of one).
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    const name = funcName();
    if (!name) return null;
    const kind: Kind =
      node.type === "protocol_function_declaration" ||
      SWIFT_TYPE_KINDS.has(ctx.enclosingKind ?? "file")
        ? "method"
        : "function";
    return {
      name,
      kind,
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "init_declaration") {
    // Initializers carry no name of their own — they are the type's own, so scope
    // the node under the enclosing type the same way Java's constructor_declaration
    // does. (A protocol's `init` requirement lands here too, owned by the protocol.)
    if (!ctx.enclosingClass) return null;
    return {
      name: ctx.enclosingClass,
      kind: "method",
      headerEnd: headEnd("function_body"),
      hashNode: node,
      ...swiftArity(node),
    };
  }

  if (node.type === "typealias_declaration") {
    const name = typeName();
    if (!name) return null;
    return { name, kind: "type", headerEnd: node.endIndex, hashNode: node };
  }

  if (node.type === "property_declaration") {
    // Top-level `let`/`var` only — a stored/computed property inside a type is a
    // field, not a definition node (no depth tier emits fields), so it must not
    // become one. `deinit` and `subscript` are likewise skipped: neither is ever
    // the target of a resolvable call edge, and neither carries a usable name.
    if (ctx.enclosingKind !== null) return null;
    const name = node.namedChildren
      .find((c) => c.type === "pattern")
      ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return null;
    return { name, kind: "variable", headerEnd: node.endIndex, hashNode: node };
  }

  return null;
}

/** Java visibility: `public` (or `protected`) on the declaration's own modifier list.
 * A package-private or private member is not part of the API surface. Read off the
 * `modifiers` child's tokens, ignoring annotations, which live in the same node. */
function javaExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return false;
  return mods.children.some((c) => c.type === "public" || c.type === "protected");
}

/** Kotlin visibility: exported by default (`public` is implicit); only an explicit
 * `internal` / `private` / `protected` visibility modifier hides a definition. */
function kotlinExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  if (!mods) return true;
  const vis = mods.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || vis.text === "public";
}

/** Declared parameter count for a Swift callable, for overload disambiguation
 * (the same role Java's `arity`/`argCount` pair plays). `parameter` nodes are
 * direct children of the declaration; a default value's `=` sits as a SIBLING
 * token after its parameter, and a variadic `...` sits inside its parameter.
 * `arity` is the REQUIRED minimum (parameters minus defaults) and `variadic`
 * marks any default or variadic parameter, so `narrowByArity`'s at-least
 * semantics keeps every overload a call of that shape could reach. */
function swiftArity(node: Parser.SyntaxNode): { arity: number; variadic?: boolean } {
  const params = node.children.filter((c) => c.type === "parameter");
  const defaults = node.children.filter((c) => c.type === "=").length;
  const hasVariadic = params.some((p) => p.children.some((c) => c.type === "..."));
  const arity = Math.max(0, params.length - defaults);
  return hasVariadic || defaults > 0 ? { arity, variadic: true } : { arity };
}

/** Argument count at a Swift call site: the `value_argument`s plus one for a
 * trailing closure (`run(x) { … }` calls a two-parameter function). */
function swiftArgCount(node: Parser.SyntaxNode): number | undefined {
  const suffix = node.namedChildren.find((c) => c.type === "call_suffix");
  if (!suffix) return undefined;
  const args =
    suffix.namedChildren
      .find((c) => c.type === "value_arguments")
      ?.namedChildren.filter((c) => c.type === "value_argument").length ?? 0;
  const trailing = suffix.namedChildren.some((c) => c.type === "lambda_literal") ? 1 : 0;
  return args + trailing;
}

/** Swift visibility: the default (`internal`) is module-wide, and a repo is
 * typically one module — so `public` / `open` / `package` / `internal` all count
 * as API surface, and only an explicit `private` / `fileprivate` hides a
 * definition. A setter-only restriction (`private(set)`) leaves the getter
 * visible, so it does not hide the symbol either. */
function swiftExported(node: Parser.SyntaxNode): boolean {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  const vis = mods?.namedChildren.find((c) => c.type === "visibility_modifier");
  return !vis || (vis.text !== "private" && vis.text !== "fileprivate");
}

/** The superclass a Swift class declaration names: its FIRST inheritance
 * specifier — Swift's grammar requires the superclass to precede any protocol
 * in the `:` list, so when a superclass exists it is always this entry. A
 * class conforming only to protocols yields that protocol's name instead, but
 * `super` is illegal in such a class, so no call site ever consults it. Null
 * for a bare `class Foo` (and for an extension, whose declaration carries no
 * heritage for the original type — `super` inside one stays unresolved). */
function swiftSuperClassName(node: Parser.SyntaxNode): string | null {
  const spec = node.namedChildren.find((c) => c.type === "inheritance_specifier");
  const ids = spec?.namedChildren
    .find((c) => c.type === "user_type")
    ?.namedChildren.filter((c) => c.type === "type_identifier");
  return ids?.length ? ids[ids.length - 1]!.text : null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (u *User) …` → `User`). Null if it can't be read. */
function goReceiverType(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver"); // parameter_list
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Go visibility: a symbol is exported iff its own name starts with an uppercase
 * letter. For a receiver-qualified method name, the own name is the part after the dot. */
function goExported(name: string): boolean {
  const own = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const first = own[0] ?? "";
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/** C++ definition shapes: classes/structs/enums (a direct `name`-field lookup,
 * same as the flat-table languages) and function/method definitions, whose name
 * is buried inside a declarator chain rather than a `name` field — this grammar's
 * analogue of `describeGo`'s special-casing, not the flat-table path C#/TS use. */
function describeCpp(node: Parser.SyntaxNode, ctx: WalkCtx): DefDescriptor | null {
  if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "enum_specifier") {
    const name = node.childForFieldName("name")?.text;
    if (!name) return null;
    const kind: Kind = node.type === "class_specifier" ? "class" : node.type === "struct_specifier" ? "struct" : "enum";
    const body = node.childForFieldName("body");
    return { name, kind, headerEnd: body ? body.startIndex : node.endIndex, hashNode: cppHashNode(node) };
  }

  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator");
    const resolved = declarator ? cppDeclaratorName(declarator) : null;
    if (!resolved) return null;
    const body = node.childForFieldName("body");
    const headerEnd = body ? body.startIndex : node.endIndex;
    const hashNode = cppHashNode(node);
    if (resolved.scope !== null) {
      // Out-of-class definition (`void Foo::bar() {}`): the owner comes from the
      // qualifier, not ctx.enclosingClass — the definition sits at file/namespace
      // scope, not nested inside the class. This is the single most important case
      // to get right for a header/source-split codebase: miss it and every
      // out-of-line method silently disappears from the graph.
      return {
        name: resolved.name,
        idName: `${resolved.scope}.${resolved.name}`,
        kind: "method",
        headerEnd,
        hashNode,
        owner: resolved.scope,
      };
    }
    const kind: Kind = ctx.enclosingKind === "class" || ctx.enclosingKind === "struct" ? "method" : "function";
    return { name: resolved.name, kind, headerEnd, hashNode };
  }

  return null;
}

/** `template_declaration` wraps a `class_specifier`/`struct_specifier`/
 * `function_definition` as a child, not a field — so when the templated
 * declaration's immediate parent is a template, the wider template node becomes
 * the span/hash/signature source instead, attributing the `template<typename T>`
 * line to the header so the card doesn't cut it off. `headerEnd` (a char offset
 * into the shared source string) stays valid regardless of which node is used. */
function cppHashNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
  return node.parent?.type === "template_declaration" ? node.parent : node;
}

/** C++ visibility: a class member is exported iff its section is `public` — the
 * only place the language has "exported"-style semantics. Non-members (free
 * functions, classes/structs/enums, and out-of-line method definitions — the
 * last because ctx.cppAccess is unset at the file/namespace scope where the
 * definition itself sits) default to exported: v1 doesn't model `static`/
 * anonymous-namespace internal linkage. */
function cppExported(ctx: WalkCtx): boolean {
  return ctx.cppAccess == null || ctx.cppAccess === "public";
}

/** PHP visibility: a class member is "exported" unless it is `private`/`protected`.
 * Top-level functions/classes carry no visibility modifier and are always visible. */
function phpExported(node: Parser.SyntaxNode): boolean {
  const vis = node.namedChildren.find((c) => c.type === "visibility_modifier");
  return vis ? vis.text === "public" : true;
}

/** Name for a PHP closure / arrow-fn: the variable it's assigned to
 * (`$handler = fn(...)` -> `handler`, mirroring how TS names arrow-consts),
 * else the anonymous `{closure}` (deduplicated per file by mintId).
 *
 * The "is this the assignment's right-hand side" check compares tree-sitter node
 * `.id` (a stable per-tree node identity) rather than `===` on the wrapper
 * objects: the binding does not guarantee that two traversals to the same
 * underlying node hand back the same JS wrapper, so `right === node` can be false
 * even when they are the same node — producing a stray `{closure}` name that
 * makes `inarch check` report the graph STALE against its own stored output. */
function phpClosureName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

function heritageEdges(node: Parser.SyntaxNode, classId: string, ctx: WalkCtx): RawEdge[] {
  const edges: RawEdge[] = [];
  if (ctx.lang === "java") {
    // `superclass` holds `extends X`; `super_interfaces` holds `implements A, B`
    // (and, on an interface declaration, `extends A, B` — which tree-sitter-java
    // still spells `extends_interfaces`).
    const typeParams = javaTypeParameterNames(node);
    for (const child of node.namedChildren) {
      const relation: Relation | null =
        child.type === "superclass"
          ? "extends"
          : child.type === "super_interfaces" || child.type === "extends_interfaces"
            ? "implements"
            : null;
      if (!relation) continue;
      for (const entry of javaSupertypeEntries(child)) {
        const name = javaSupertypeName(entry);
        // Belt-and-braces. A type VARIABLE is never a supertype, and erasing the
        // arguments already removes every case measured on gson and spring-petclinic
        // (identical output with this filter removed) — Java cannot extend or implement
        // a type variable, so a surviving `T` would have to come from a shape neither
        // repo contains. Kept because a wrong supertype is not a cosmetic edge: it
        // feeds `classParents` and from there call resolution.
        if (!name || typeParams.has(name)) continue;
        edges.push({ source: classId, relation, name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "kotlin") {
    // The `:` clause is a list of `delegation_specifier`s — a superclass construction
    // (`class A : B()`), an interface, or `by` delegation. The first `type_identifier`
    // under each names the type; everything else (type args, delegation target) is not
    // the heritage target, so only the head type counts.
    for (const child of node.namedChildren) {
      if (child.type !== "delegation_specifier") continue;
      const t = child.namedChildren.find((c) => c.type === "user_type")?.namedChildren.find(
        (c) => c.type === "type_identifier",
      );
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "swift") {
    // `class A: B, C` — each `inheritance_specifier` (a direct child of the
    // declaration; protocols and extensions carry them too) wraps a `user_type`
    // whose LAST direct `type_identifier` is the bare supertype name: a
    // module-qualified `Foundation.NSObject` reduces to `NSObject`, and generic
    // arguments live in nested nodes so they never leak in. Swift cannot say
    // syntactically whether a specifier is the superclass or a protocol
    // conformance (that needs the target's kind), so every edge is `extends` —
    // the same collapse Kotlin's delegation specifiers make.
    for (const child of node.namedChildren) {
      if (child.type !== "inheritance_specifier") continue;
      const ids = child.namedChildren
        .find((c) => c.type === "user_type")
        ?.namedChildren.filter((c) => c.type === "type_identifier");
      const t = ids?.length ? ids[ids.length - 1] : undefined;
      if (t) edges.push({ source: classId, relation: "extends", name: t.text, file: ctx.rel });
    }
    return edges;
  }
  if (ctx.lang === "python") {
    const supers = node.childForFieldName("superclasses"); // argument_list
    for (const c of supers?.namedChildren ?? []) {
      if (c.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: c.text, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "cpp") {
    // Unlike C#, every base-list entry here is a true base class (C++ has no
    // `interface` keyword), so every one emits `extends` — no "first = extends,
    // rest = implements" heuristic needed. `access_specifier` tokens (`public`/
    // `private`/`protected`) are plain siblings in the clause, not fields.
    const clause = node.namedChildren.find((c) => c.type === "base_class_clause");
    for (const t of clause?.namedChildren ?? []) {
      if (t.type === "type_identifier" || t.type === "qualified_identifier" || t.type === "template_type") {
        edges.push({ source: classId, relation: "extends", name: stripCppTemplateArgs(t.text), file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "r") {
    // `node` is whatever describeR matched: a binary_operator for R6
    // (`Foo <- R6::R6Class(...)`) or the call itself for S4 (`setClass(...)`
    // is a bare top-level statement, essentially never assigned).
    const call = node.type === "binary_operator" ? node.childForFieldName("rhs") : node;
    if (call?.type !== "call") return edges;
    const callee = rCalleeName(call);
    if (callee === "R6Class") {
      // `inherit = ParentClass` — a bare identifier (the parent's own
      // generator variable), not a string; R6 supports single inheritance only.
      const value = rNamedArg(call, "inherit");
      if (value?.type === "identifier") {
        edges.push({ source: classId, relation: "extends", name: value.text, file: ctx.rel });
      }
    } else if (callee === "setClass") {
      // `contains = "Base"` or `contains = c("Base1", "Base2")` — S4 supports
      // multiple inheritance.
      for (const name of rStringOrCVector(rNamedArg(call, "contains"))) {
        edges.push({ source: classId, relation: "extends", name, file: ctx.rel });
      }
    }
    return edges;
  }
  if (ctx.lang === "ruby") {
    const factory = rubyNamedClassFactory(node);
    if (factory) return [{ source: classId, relation: "extends", name: factory.parent,
      file: ctx.rel, nesting: [...ctx.rubyNesting], rubyHeritage: "superclass", rubyClassFactory: true }];
    const superclass = node.childForFieldName("superclass");
    // `class C < D::E` — M0 required a plain `constant` here, so every namespaced
    // parent emitted nothing at all. The name is kept as written and carries the
    // nesting chain, so resolve.ts can run Ruby's own lookup on it instead of a
    // bare-name match that could never have matched `D::E` in the first place.
    const path = superclass?.namedChildren[0] ? rubyConstPath(superclass.namedChildren[0]) : null;
    if (path !== null) {
      edges.push({
        source: classId, relation: "extends", name: path, file: ctx.rel,
        nesting: [...ctx.rubyNesting], rubyHeritage: "superclass",
      });
    }
    return edges;
  }
  if (ctx.lang === "php") {
    // `class C extends B implements I, J` → base_clause (extends) +
    // class_interface_clause (implements); names may be namespace-qualified.
    for (const clause of node.namedChildren) {
      const relation: Relation | null =
        clause.type === "base_clause" ? "extends" : clause.type === "class_interface_clause" ? "implements" : null;
      if (!relation) continue;
      for (const t of clause.namedChildren) {
        if (t.type === "name" || t.type === "qualified_name") {
          edges.push({ source: classId, relation, name: t.text.replace(/^.*\\/, ""), file: ctx.rel });
        }
      }
    }
    return edges;
  }
  const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
  for (const clause of heritage?.namedChildren ?? []) {
    const relation: Relation | null =
      clause.type === "implements_clause"
        ? "implements"
        : clause.type === "extends_clause"
          ? "extends"
          : null;
    if (!relation) continue;
    for (const t of clause.namedChildren) {
      if (t.type === "identifier" || t.type === "type_identifier") {
        edges.push({ source: classId, relation, name: t.text, file: ctx.rel });
      }
    }
  }
  return edges;
}

/**
 * The supertypes a heritage clause names, one node each — NOT every `type_identifier`
 * beneath it.
 *
 * `superclass` wraps a single type; `super_interfaces`/`extends_interfaces` wrap a
 * `type_list` of them. Descending blindly instead walked into `type_arguments`, so
 * `implements Comparable<Item>` reported `Item` as a supertype too.
 */
function javaSupertypeEntries(clause: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const list = clause.namedChildren.find((c) => c.type === "type_list");
  return list ? [...list.namedChildren] : [...clause.namedChildren];
}

/**
 * What a supertype entry is CALLED, or null when this pass cannot say.
 *
 * Type arguments are erased, because they are not part of the supertype's identity:
 *
 *     Base           |  Base<Item>          -> Base
 *
 * A qualified name is kept WHOLE rather than reduced to its final segment:
 *
 *     Outer.Inner    |  Outer.Inner<K>      -> Outer.Inner
 *
 * Heritage keeps an unresolved base as the edge target by design ("usually an
 * external/imported type — keep the name"), so the full string is both truthful and
 * unable to false-match a node id, where a bare `Inner` could collide with an
 * unrelated in-repo type. That differs from construction (#103), which drops a
 * qualified name instead — construction has no keep-the-name contract to fall back on.
 */
function javaSupertypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaSupertypeName(node.namedChildren[0]);
  if (node.type === "scoped_type_identifier") return node.text;
  return node.type === "type_identifier" ? node.text : null;
}

/** The names a declaration binds as its own type parameters (`class C<T, U>` → T, U),
 * so they can never be mistaken for supertypes. */
function javaTypeParameterNames(decl: Parser.SyntaxNode): ReadonlySet<string> {
  const params = decl.childForFieldName("type_parameters");
  if (!params) return new Set();
  const out = new Set<string>();
  const visit = (n: Parser.SyntaxNode): void => {
    if (n.type === "type_identifier") out.add(n.text);
    for (const c of n.namedChildren) visit(c);
  };
  visit(params);
  return out;
}

/**
 * The node a call expression actually NAMES, seeing through the one wrapper the
 * grammar puts in the way.
 *
 * tree-sitter-typescript binds `await` tighter than a type-argument list, so
 * `await target<string>(x)` parses as if it were `(await target)<string>(x)`: the
 * `call_expression`'s `function` field is an `await_expression` holding the real
 * callee, not the callee itself. The non-generic `await target(x)` parses the
 * other way round — `await_expression` wrapping `call_expression` — which is why
 * only the combination ever failed, and why it failed silently: `calleeName`
 * returned null, no `calls` edge was emitted, and the callee still surfaced as a
 * `references` edge from the identifier walk, so the graph looked populated. In
 * one frontend that was 111 call sites across 31 files, 108 of them to a single
 * typed API client, lost purely because the author had written
 * `const r = await api<T>(…)` rather than `return api<T>(…)`.
 *
 * The parse is not wrong about WHICH name is called, only about where that name
 * sits, so unwrapping at the two sites that read the field is the whole fix —
 * `identifier` and `member_expression` keep their existing handling, `tsReceiver`
 * typing included. It also covers `await obj.m<T>(x)` and `await this.m<T>(x)`,
 * so the defect cost intra-class method edges too. Guarded to TypeScript because
 * no other language in CALL_TYPES has `await` as an expression prefix, and
 * widening it would be dead weight a reader has to disprove.
 */
function calleeExpression(call: Parser.SyntaxNode, lang: Language): Parser.SyntaxNode | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  // An `await_expression` has exactly one named child: the awaited operand. Any
  // other shape is one this pass does not understand, and guessing at a callee is
  // how you get a wrong edge rather than a missing one.
  if ((lang === "typescript" || lang === "tsx") && fn.type === "await_expression") {
    return fn.namedChildren.length === 1 ? fn.namedChildren[0] : null;
  }
  return fn;
}

function calleeName(
  node: Parser.SyntaxNode,
  ctx: WalkCtx,
): { name: string; viaMember: boolean; receiver?: string; recvType?: string; kinds?: Kind[]; ruby?: Partial<RawEdge> } | null {
  const lang = ctx.lang;
  // Ruby is the one language whose callee needs the walk state: M3 types a
  // receiver from the file's binding table and from `Module.nesting`, neither of
  // which is readable off the call node alone.
  if (lang === "ruby") return rubyCallee(node, ctx);
  // Java first: `method_invocation` has NO `function` field (it splits the callee
  // into `object` + `name`), so the shared lookup below would return null for every
  // Java call site and the language would extract nodes with no call edges at all.
  if (lang === "java") {
    if (node.type === "object_creation_expression") {
      // `new Foo()` — the constructed type is the call target, named as the graph
      // names it.
      const name = javaConstructedTypeName(node.childForFieldName("type"));
      return name ? { name, viaMember: false } : null;
    }
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const obj = node.childForFieldName("object");
    // No `object` means an implicit-`this` call (`decorate(name)`), which in Java is a
    // method call, not a free function — Java has none. Reporting it as a plain call
    // would send it to the function-only resolver and drop it, losing the most common
    // intra-class edge there is. Spelling it as a `this` member call routes it through
    // owner-qualified resolution, which also walks the superclass chain and stays
    // conservative: an unmatched name (e.g. a static import) resolves to nothing.
    if (!obj) return { name: nameNode.text, viaMember: true, receiver: "this" };
    return { name: nameNode.text, viaMember: true, receiver: javaReceiver(obj) };
  }

if (lang === "kotlin") {
    // `call_expression` = callee expression + `call_suffix`. A bare `foo()` names a
    // plain call; `obj.foo()` is a `navigation_expression` whose trailing
    // `navigation_suffix` holds the method name and whose object is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "this_expression" || receiver?.type === "super_expression")
        return { name: name.text, viaMember: true, receiver: receiver.type === "this_expression" ? "this" : "super" };
    }
    return null;
  }

  if (lang === "swift") {
    // Same shape as Kotlin's: `call_expression` = callee expression + `call_suffix`.
    // A bare `foo()` names a plain call (this also covers `Animal()` initializer
    // calls, which have no distinguishing syntax); `obj.foo()` is a
    // `navigation_expression` whose trailing `navigation_suffix` holds the member
    // name and whose head is the receiver.
    const target = node.namedChildren[0];
    if (target?.type === "simple_identifier") return { name: target.text, viaMember: false };
    if (target?.type === "navigation_expression") {
      const suffix = target.namedChildren.find((c) => c.type === "navigation_suffix");
      const name = suffix?.namedChildren.find((c) => c.type === "simple_identifier");
      const receiver = target.namedChildren[0];
      if (!name) return null;
      if (receiver?.type === "simple_identifier")
        return { name: name.text, viaMember: true, receiver: receiver.text };
      if (receiver?.type === "self_expression" || receiver?.type === "super_expression")
        return {
          name: name.text,
          viaMember: true,
          receiver: receiver.type === "self_expression" ? "self" : "super",
        };
      if (receiver?.type === "navigation_expression") {
        // `self.repo.save()` — one hop off self is a field access and binds like
        // TS's `this.x`. Deeper chains and call-result receivers carry no
        // confident local clue, so those fall through with no receiver.
        const head = receiver.namedChildren[0];
        const field = receiver.namedChildren
          .find((c) => c.type === "navigation_suffix")
          ?.namedChildren.find((c) => c.type === "simple_identifier");
        if (head?.type === "self_expression" && field)
          return { name: name.text, viaMember: true, receiver: `self.${field.text}` };
      }
      // Still a member call even with an unknowable receiver (a chained call, a
      // literal, a subscript): recvType stays unset and resolve drops it rather
      // than guessing — same contract as Java's and TS's unknown receivers.
      return { name: name.text, viaMember: true };
    }
    return null;
  }

  if (lang === "php") return phpCallee(node);

  if (lang === "tsx" && JSX_ELEMENT_TYPES.has(node.type)) {
    // `<Widget>…</Widget>` and `<Widget/>`: the element's `name` field is the
    // callee. React calls the component with the props as its argument, so this
    // is the same "X invokes Y" fact as `Widget({children})` — it just does not
    // spell it as a `call_expression`. There is no receiver to type: an element
    // name is a value in lexical scope, exactly like a bare call's callee.
    //
    // Casing is not a heuristic, and the test is deliberately for the INTRINSIC
    // side rather than the component side. JSX's rule, as TypeScript's own
    // `isIntrinsicJsxName` states it, is `ch >= 'a' && ch <= 'z' || name.includes("-")`:
    // a name starting with an ASCII lowercase letter is a host element React
    // forwards to the DOM as a string, and so is any hyphenated name (a custom
    // element). EVERYTHING else is an ordinary binding in lexical scope.
    //
    // Asking "does it start A-Z" instead is not the same question, and gets three
    // real cases wrong: `<Écran/>` (uppercase, but not ASCII), `<_Widget/>` and
    // `<$Widget/>` — all three are bindings the grammar hands back as plain
    // `identifier`, and all three would vanish silently. The ASCII range is correct
    // here precisely because it is the lowercase half: TypeScript restricts the
    // intrinsic test to a-z, so a non-ASCII initial is a component by definition.
    //
    // A namespaced name (`<svg:circle/>`) arrives as `jsx_namespace_name`, not
    // `identifier`, so the type check above already excludes it — which is right,
    // since TypeScript treats those as intrinsic too.
    //
    // A dotted element name (`<UI.Button/>`, `<Widget.Slot/>`) is a
    // `member_expression`, not an `identifier`, and is left alone on purpose: it
    // needs a receiver type the way `ui.button()` does, and the namespace import
    // it usually comes from binds none — the same wall qualified construction
    // hits in Java (see javaConstructedTypeName). Resolving the trailing segment
    // on its own is the guess this module does not make.
    //
    // `kinds` rather than the function-only default: a class component
    // (`class Boundary extends React.Component`) is as much a component as a
    // function one, and this is scoped to element names, so an ordinary
    // `Widget()` call in the same file still resolves against functions alone.
    const name = node.childForFieldName("name");
    if (name?.type !== "identifier") return null;
    if (/^[a-z]/.test(name.text) || name.text.includes("-")) return null;
    return { name: name.text, viaMember: false, kinds: ["function", "class"] };
  }

  const fn = calleeExpression(node, lang);
  if (!fn) return null;
  if (fn.type === "identifier") return { name: fn.text, viaMember: false };
  if (lang === "python" && fn.type === "attribute") {
    const a = fn.childForFieldName("attribute") ?? fn.namedChildren.at(-1);
    return a ? { name: a.text, viaMember: true, receiver: pyReceiver(fn) } : null;
  }
  if (lang === "go" && fn.type === "selector_expression") {
    // `pkg.Fn()` / `recv.Method()` — the called name is the trailing field.
    const p = fn.childForFieldName("field") ?? fn.namedChildren.at(-1);
    const operand = fn.childForFieldName("operand");
    const receiver = operand?.type === "identifier" ? operand.text : undefined;
    return p ? { name: p.text, viaMember: true, receiver } : null;
  }
  if ((lang === "typescript" || lang === "tsx") && fn.type === "member_expression") {
    const p = fn.childForFieldName("property") ?? fn.namedChildren.at(-1);
    return p ? { name: p.text, viaMember: true, receiver: tsReceiver(fn) } : null;
  }
  if (lang === "cpp" && fn.type === "field_expression") {
    // `obj.method()` / `ptr->method()` — member call, receiver resolved via the
    // normal bindings-lookup path (same as ts/py), not a direct recvType.
    const field = fn.childForFieldName("field");
    if (field?.type !== "field_identifier" && field?.type !== "destructor_name") return null;
    return { name: field.text, viaMember: true, receiver: cppReceiver(fn.childForFieldName("argument")) };
  }
  if (lang === "cpp" && fn.type === "qualified_identifier") {
    // `Foo::bar()` / `std::max()` — static/namespaced call. The scope IS the
    // type name already (not a variable to look up), so it's supplied directly
    // as recvType, bypassing resolveRecvType's bindings-lookup path entirely.
    const { scope, nameNode } = resolveCppQualified(fn);
    if (!nameNode.text) return null;
    return scope ? { name: nameNode.text, viaMember: true, recvType: scope } : { name: nameNode.text, viaMember: false };
  }
  if (lang === "r" && (fn.type === "extract_operator" || fn.type === "namespace_operator")) {
    const rhs = fn.childForFieldName("rhs");
    if (rhs?.type !== "identifier") return null;
    if (fn.type === "extract_operator") {
      const lhs = fn.childForFieldName("lhs");
      if (lhs?.type === "identifier" && (lhs.text === "self" || lhs.text === "private")) {
        // R6 (Phase 2): `self$method()` / `private$method()` — resolves directly to
        // the enclosing class via ctx.enclosingClass, same mechanism (and same
        // magic receiver string) as Python/TS's self/cls/this — see
        // resolveRecvType, which already special-cases "self" generically.
        return { name: rhs.text, viaMember: true, receiver: "self" };
      }
      if (lhs?.type === "identifier" && lhs.text === "super") {
        // R6 (Phase 3): `super$method()` — R6's inheritance-dispatch keyword,
        // resolves directly to the PARENT class via ctx.rSuperClass (NOT
        // ctx.enclosingClass — that would wrongly find the current class's own
        // same-named override instead of climbing to the parent).
        return { name: rhs.text, viaMember: true, receiver: "super" };
      }
      // Any other `obj$method()` (Phase 4): still a PLAIN name match, not a
      // typed member call — there's no general field-type-binding table for
      // R6 composition (`private$other_obj$method()`), and a real codebase's
      // dominant field-assignment shape (constructor-parameter pass-through,
      // `do.call(class_var$new, ...)` dynamic dispatch) turned out to defeat
      // the simple "field <- SomeClass$new()" pattern every other language's
      // binding table relies on anyway — see plan_r_language_support.md's
      // Phase 2 "known gaps" and the follow-up investigation against a real
      // R6-heavy corpus. What DOES help: bare-name resolution must be allowed
      // to match a "method" node here, not just "function" — R6 methods are
      // always kind "method", so without `kinds` below, EVERY untyped `$`
      // call would be unconditionally unresolvable rather than just
      // occasionally ambiguous (resolve.ts already drops a genuinely
      // ambiguous bare-name match rather than guessing, so this only adds
      // resolutions for uniquely-named methods, never a wrong-class guess).
      return { name: rhs.text, viaMember: false, kinds: ["function", "method"] };
    }
    // `pkg::fun()` (qualified call) — always a real function/exported symbol,
    // never an R6 method (those are only ever reached via `$` on an instance),
    // so no need to widen the match kinds here.
    return { name: rhs.text, viaMember: false };
  }
  return null;
}

/** The number of arguments at a Java call site (`method_invocation` or
 * `object_creation_expression`), read off the `arguments` list. Undefined when the
 * list is absent, which keeps resolution at its previous name-only behavior rather
 * than filtering on a count we never established. */
function javaArgCount(node: Parser.SyntaxNode): number | undefined {
  const args = node.childForFieldName("arguments");
  return args ? args.namedChildren.length : undefined;
}

/**
 * The name a `new` CONSTRUCTS, as the graph names it — or null when this pass cannot
 * say, in which case the construction resolves to nothing.
 *
 * Erasing type arguments is the only transformation here, because it is the only one
 * that provably does not change which type is being named:
 *
 *     Box            -> Box
 *     Box<String>    -> Box     (the node is `Box`; the arguments are not part of it)
 *     Box<>          -> Box
 *
 * A QUALIFIED name is deliberately dropped rather than reduced to its final segment:
 *
 *     java.io.File   -> null    (not the repo's own `File`)
 *     Beta.Builder   -> null    (not `Alpha.Builder` in the same file)
 *
 * Collapsing those was the first attempt at this fix, and it traded lost edges for
 * WRONG ones — `new java.io.File(…)` resolved to an unrelated in-repo `File`, and a
 * nested `Beta.Builder` bound to a sibling `Alpha.Builder` at `extracted` confidence,
 * because the same-file tiebreak takes the first candidate. Dropping keeps this pass
 * on the resolver's own rule: resolve precisely, or not at all.
 *
 * Deliberately NOT shared with bindings.ts's `javaTypeName`. That one answers "what
 * type does this variable HOLD", where reducing `java.util.List` to `List` is a local
 * heuristic with different stakes; this one answers "what type is being constructed",
 * and the two questions do not have the same safe answer. Supporting qualified
 * construction properly needs an import-aware type index, not a longer helper.
 */
function javaConstructedTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "generic_type") return javaConstructedTypeName(node.namedChildren[0]);
  return node.type === "type_identifier" ? node.text : null;
}

/** A Java call's receiver text: a bare identifier (`repo.save()`), `this`, or
 * `this.x` for a field access (`this.repo.save()`). A chained call or a qualified
 * static reference yields none — there is no confident local clue to bind. */
function javaReceiver(obj: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!obj) return undefined;
  if (obj.type === "identifier") return obj.text;
  if (obj.type === "this") return "this";
  if (obj.type === "field_access") {
    const inner = obj.childForFieldName("object");
    const field = obj.childForFieldName("field");
    if (inner?.type === "this" && field) return `this.${field.text}`;
  }
  return undefined;
}

/** py `attribute` node's receiver text: bare identifier, or `self.x` for a
 * chained `self.x.y()`. Anything else (e.g. a chained call `f().g()`) → none. */
function pyReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "attribute") {
    const innerObj = obj.childForFieldName("object");
    const innerAttr = obj.childForFieldName("attribute");
    if (innerObj?.type === "identifier" && innerObj.text === "self" && innerAttr) return `self.${innerAttr.text}`;
  }
  return undefined;
}

/**
 * PHP call shapes: `foo()` (function_call_expression), `$obj->m()` /
 * `$obj?->m()` (member/nullsafe_member_call_expression), and `Cls::m()`
 * (scoped_call_expression). The called name is the trailing `name`; the
 * receiver, when locally knowable (`$this`, `self`/`static`/`parent`), feeds
 * receiver-typed resolution the same way Python's `self` and Go's receiver do.
 */
function phpCallee(node: Parser.SyntaxNode): { name: string; viaMember: boolean; receiver?: string } | null {
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    const name = fn ? phpName(fn) : null;
    return name ? { name, viaMember: false } : null;
  }
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  if (node.type === "scoped_call_expression") {
    return { name: nameNode.text, viaMember: true, receiver: phpScopeReceiver(node.childForFieldName("scope")) };
  }
  // member_call_expression / nullsafe_member_call_expression
  return { name: nameNode.text, viaMember: true, receiver: phpObjReceiver(node.childForFieldName("object")) };
}

/** A PHP callee identifier: bare `name`, or the trailing segment of a
 * `qualified_name` (`\App\helpers\slug` → `slug`). Dynamic calls (`$fn()`) → null. */
function phpName(node: Parser.SyntaxNode): string | null {
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "") || null;
  return null;
}

/** `$obj->m()` receiver: `$this` normalizes to `this` (→ enclosing class); any
 * other variable is returned verbatim for a bindings lookup. */
function phpObjReceiver(obj: Parser.SyntaxNode | null): string | undefined {
  if (obj?.type !== "variable_name") return undefined;
  return obj.text === "$this" ? "this" : obj.text;
}

/** `Cls::m()` receiver: `self`/`static`/`parent` normalize to `self` (→ enclosing
 * class); an explicit class name is the trailing segment of its qualified path. */
function phpScopeReceiver(scope: Parser.SyntaxNode | null): string | undefined {
  if (!scope) return undefined;
  const text = scope.text;
  if (scope.type === "relative_scope" || text === "self" || text === "static" || text === "parent") return "self";
  if (scope.type === "name") return text;
  if (scope.type === "qualified_name") return text.replace(/^.*\\/, "");
  return undefined;
}

/** ts `member_expression` node's receiver text: `this`, `this.x`, or a bare identifier. */
function tsReceiver(fn: Parser.SyntaxNode): string | undefined {
  const obj = fn.childForFieldName("object");
  if (obj?.type === "this") return "this";
  if (obj?.type === "identifier") return obj.text;
  if (obj?.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj?.type === "this" && innerProp) return `this.${innerProp.text}`;
  }
  return undefined;
}

/** cpp `field_expression`'s `argument` (the object before `.`/`->`) receiver text:
 * `this`, `this.x` (a `this->x.y()` chain), or a bare identifier. Mirrors `tsReceiver`. */
function cppReceiver(argument: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!argument) return undefined;
  if (argument.type === "this") return "this";
  if (argument.type === "identifier") return argument.text;
  if (argument.type === "field_expression") {
    const innerArg = argument.childForFieldName("argument");
    const innerField = argument.childForFieldName("field");
    if (innerArg?.type === "this" && innerField) return `this.${innerField.text}`;
  }
  return undefined;
}

/** R has no import statement at the grammar level — `library(x)`, `require(x)`,
 * and `source("f.R")` are ordinary `call` nodes, indistinguishable from any other
 * call except by their callee name. This is call-SITE pattern matching, a first
 * for this function's normal node-type switch — every other language's import
 * shape is a dedicated grammar construct. */
const R_IMPORT_CALLS = new Set(["library", "require", "source"]);

function isImport(node: Parser.SyntaxNode, lang: Language): boolean {
  // Go: match the per-import leaf, so single (`import "fmt"`) and grouped
  // (`import ( … )`) forms each yield one edge as the walk recurses into the list.
  if (lang === "go") return node.type === "import_spec";
  if (lang === "cpp") return node.type === "preproc_include";
  if (lang === "r") {
    if (node.type !== "call") return false;
    const fn = node.childForFieldName("function");
    return fn?.type === "identifier" && R_IMPORT_CALLS.has(fn.text);
  }
  if (lang === "java") return node.type === "import_declaration";
  if (lang === "kotlin") return node.type === "import_header";
  if (lang === "swift") return node.type === "import_declaration";
  // PHP: one edge per imported symbol — the clause leaf inside a (possibly
  // grouped) `use A\B, C\D;` / `use A\{B, C};` declaration.
  if (lang === "php") return node.type === "namespace_use_clause";
  return node.type === "import_statement" || node.type === "import_from_statement";
}

/**
 * The re-export facts in `export … from '…'`, as `imports` raw edges carrying a name.
 *
 * Riding the existing `imports` relation is deliberate. A re-export IS a dependency on
 * the module it names — one the graph did not record at all before — so the edge is
 * worth emitting on its own account, and `name` makes it additionally readable as "this
 * module offers that symbol from there". No new relation enters the public vocabulary
 * for what is an internal resolution aid, and the cache format does not change.
 *
 * Three shapes, from `tree-sitter-typescript`:
 *   - `export { A } from './m'`        → export_specifier, field `name`
 *   - `export { A as B } from './m'`   → the same, plus field `alias`; `name` is what
 *                                        the TARGET defines, `alias` what importers write
 *   - `export * from './m'`            → a `source` and no export_clause at all
 *
 * A star is recorded as the reserved name `*`, which no JavaScript identifier can be,
 * so it cannot collide with a real symbol. `export type { A } from './m'` parses
 * identically to the named form and needs no special case.
 */
function reexportEdges(node: Parser.SyntaxNode, rel: string): RawEdge[] {
  const source = node.childForFieldName("source");
  const spec = source?.namedChildren.find((c) => c.type === "string_fragment")?.text;
  if (!spec) return [];
  const clause = node.namedChildren.find((c) => c.type === "export_clause");
  if (!clause) {
    return [{ source: rel, relation: "imports", specifier: spec, name: "*", file: rel }];
  }
  const out: RawEdge[] = [];
  for (const spc of clause.namedChildren) {
    if (spc.type !== "export_specifier") continue;
    const inner = spc.childForFieldName("name")?.text;
    if (!inner) continue;
    const outer = spc.childForFieldName("alias")?.text;
    out.push({
      source: rel,
      relation: "imports",
      specifier: spec,
      name: inner,
      ...(outer && outer !== inner ? { exportedAs: outer } : {}),
      file: rel,
    });
  }
  return out;
}

function importSpecifier(node: Parser.SyntaxNode, lang: Language): string | null {
  if (lang === "php") {
    // namespace_use_clause → its `qualified_name`/`name`, e.g. `App\Models\Animal`.
    const q = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
    return q ? q.text.replace(/^\\/, "") : null;
  }
  if (lang === "python") {
    const m =
      node.childForFieldName("module_name") ??
      node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
    return m?.text ?? null;
  }
  if (lang === "go") {
    // import_spec's `path` is an interpreted_string_literal, e.g. `"mymod/pkg/util"`.
    const path = node.childForFieldName("path") ?? node.namedChildren.at(-1);
    return path ? path.text.replace(/^["`]|["`]$/g, "") : null;
  }
  if (lang === "cpp") {
    // `path` is a `string_literal` for `"foo.h"` or a `system_lib_string` for
    // `<foo.h>` — cleaner than C#'s `using_directive`, which has no field at all.
    const path = node.childForFieldName("path");
    if (!path) return null;
    if (path.type === "system_lib_string") return path.text.replace(/^<|>$/g, "");
    const content = path.namedChildren.find((c) => c.type === "string_content");
    return content?.text ?? path.text.replace(/^"|"$/g, "");
  }
  if (lang === "r") {
    // library(pkg) / library("pkg") / require(pkg) / source("f.R") — the target is
    // always the first (and normally only) positional argument, bare symbol or string.
    const value = rCallArgs(node)[0]?.childForFieldName("value") ?? null;
    if (value?.type === "identifier") return value.text;
    return rStringContent(value);
  }
  if (lang === "java") {
    // `import a.b.C;` / `import static a.b.C.d;` / `import a.b.*;` — the fully
    // qualified name is the scoped_identifier; a wildcard `*` is a separate token
    // and is dropped, leaving the package as the import target.
    const id = node.namedChildren.find(
      (c) => c.type === "scoped_identifier" || c.type === "identifier",
    );
    return id?.text ?? null;
  }
  if (lang === "kotlin") {
    // `import com.example.Foo` — the dotted path is the `identifier` child. A
    // wildcard (`import a.b.*`) and an `as` alias are separate children, so the
    // identifier text is already the module path (wildcards dropped, like Java).
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  if (lang === "swift") {
    // `import UIKit` / `import struct Foundation.Date` — the dotted path is the
    // `identifier` child (an import-kind keyword like `struct` is a separate
    // token). Swift imports name MODULES, not files, so the specifier resolves
    // to a repo file only when a same-named module target exists; external
    // frameworks stay as unresolved (but truthful) import intents.
    return node.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
  }
  const str = node.namedChildren.find((c) => c.type === "string");
  if (!str) return null;
  const frag = str.namedChildren.find((c) => c.type === "string_fragment");
  return frag?.text ?? str.text.replace(/^['"]|['"]$/g, "");
}

/** Signature = the definition header, whitespace-collapsed, trailing punctuation stripped. */
function clean(raw: string): string | null {
  const sig = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(=>|[{:=])\s*$/, "")
    .trim();
  return sig || null;
}

/** TS: a definition is exported if any ancestor is an `export` statement. */
function tsExported(node: Parser.SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    p = p.parent;
  }
  return false;
}
