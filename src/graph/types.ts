/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP
 * vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */

/** What a node represents. LSP SymbolKind, narrowed to what our extractors produce. */
export type Kind =
  | "file"
  | "class"
  | "function"
  | "method"
  | "interface" // TS + Go
  | "type" // TS + Go (type alias / named type)
  | "enum" // TS + PHP + Java
  | "struct" // Go only
  | "trait" // PHP only
  // Also Ruby's own full-fidelity module kind (see extract.ts's describeRuby),
  // not just the generic (tags.scm) breadth tier's use below — every
  // tree-sitter grammar's tags.scm uses the tree-sitter tags @definition.<X>
  // vocabulary, and module/constant/variable are common across the long tail
  // (Rust consts, top-level lets, …). Kept distinct rather than coerced so the
  // breadth tier's kinds read truthfully in cards/skeleton.
  | "module"
  | "constant"
  | "variable";

/** How confident we are an edge is true, best-first. The hand-written AST
 * resolver assigns `extracted`/`inferred`; the opt-in LSP enrichment pass
 * (`inarch build --lsp`) can promote an edge to compiler-grade `lsp_resolved`
 * (an exact server-confirmed target) or `lsp_dispatch` (an interface/virtual
 * candidate). Order matters: consumers that rank by provenance treat earlier
 * values as stronger.
 *
 * `type_bound` is the receiver-typed reading (M3): the target was chosen because
 * the receiver's TYPE was known — a constant written at the call site, a variable
 * assigned from one, a declared association reader, or the enclosing class for an
 * implicit `self` — and the method was then looked up on that class and its own
 * ancestors. It sits below `extracted` because it reasons across files, and above
 * `inferred` because `inferred` is a bare-name guess with no receiver behind it:
 * the whole point of separating them is that a reader (and `graph-quality`) can
 * see which edges came from a type and which from a name.
 *
 * `convention` is the framework-rule reading (M4): nothing in either file names the
 * other, and the edge exists because a framework's own naming rule connects them —
 * `DocumentsController#index` renders `app/views/documents/index.html.erb`, a view
 * can call any module under `app/helpers/`. It sits below `type_bound` because a
 * convention is a rule about where things are PUT, not about what they are, and
 * above `inferred` because it is never a guess between candidates: the rule names
 * one target, that target was verified to exist as a node, and an ambiguous rule
 * emits nothing. An edge the source states outright — `render "shared/nav"`,
 * `layout "admin"` — is `extracted` and not this. */
export type Confidence =
  | "lsp_resolved"
  | "lsp_dispatch"
  | "extracted"
  | "type_bound"
  | "ruby_dispatch" // a known possible runtime receiver, never an exhaustive call set
  | "ruby_injection" // conditional keyword/default binding with source evidence
  | "convention"
  | "inferred"
  // A locally approved extension contributed this edge. It is never promoted to
  // resolver confidence merely because the extension returned that string.
  | "extension";

/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";

/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
  code: string;
  span: string; // e.g. "L189-L196"
}

export interface NodeV1 {
  // identity
  id: string; // path-scoped: "src/cache.ts#Cache.get"
  name: string; // the symbol's own name: "get"
  kind: Kind;
  // method nodes only: the bare name of the immediate enclosing class/receiver
  // ("Cache" for "get"). Lets owner-qualified lookups (resolve.ts's ownerMethod
  // index) key off a stored field instead of re-deriving it by slicing `id`,
  // which breaks once ids can carry a dedup ordinal (`Cache.get~2`).
  owner?: string;

  // location (Tier-1, deterministic)
  path: string; // repo-relative: "src/cache.ts"
  span: string; // whole definition: "L165-L222"
  signature: string | null; // "get(k: string): number" — null for kind:"file"
  exported: boolean;
  // How the node was extracted. "ast" = a first-class hand-written extractor
  // (TS/JS/Python/Go, full-fidelity). "generic" = the tags.scm breadth tier
  // (signature-only; symbols + bare edges, no scope-aware binding).
  // "synthesized" = declared by a framework macro rather than written down —
  // `has_many :items` really does define `items`/`item_ids`, but there is no `def`
  // anywhere and the node's span points at the macro call site instead. Kept
  // distinct from "ast" so a reader can tell a generated `items` from a hand-written
  // one, and so a consumer that wants only code a human typed can filter for it.
  // Ruby's `attr_accessor` synthesis (M0 Phase 5) deliberately stays "ast": it
  // predates this value, it is plain Ruby rather than a framework vocabulary, and
  // re-stamping it would churn every existing Ruby graph for no new information.
  origin: "ast" | "generic" | "synthesized" | "extension";
  extension?: string;
  extensionDigest?: string;
  body_hash: string; // sha256 of the definition text; the Tier-2 re-run trigger
  chars?: number; // byte length of the WHOLE file (file nodes only); the baseline
  //                 `ask` uses to estimate tokens saved vs reading the file whole
  body_text?: string; // searchable whitespace-normalized definition body (Tier-1,
  //                 symbol nodes only, capped). Ranks `ask` queries so a term in
  //                 the code — not just the name/signature — is findable; never
  //                 emitted to the agent (that reads verbatim source via `--source`).
  //                 Absent on file nodes and on graphs built before this field.
  arity?: number; // declared parameter count (method/constructor nodes). Disambiguates
  //                 OVERLOADS, which only Java has among the languages parsed here: two
  //                 same-named methods on one class are otherwise separable only by
  //                 arity, and picking the wrong one turns a delegating overload into a
  //                 self-loop. Absent on graphs built before this field, and on
  //                 languages that do not emit it — resolution then behaves as before.
  variadic?: boolean; // the last parameter is a vararg (`String... xs`), so the declared
  //                 arity is a MINIMUM, not an equality. Never arity-filtered out.
  // What a call must hold to reach this method: an INSTANCE of the owner
  // (`def x`), or the CLASS OBJECT itself (`def self.x`, `class << self`). Ruby
  // files both under one id — `Child#fire` and `Child.fire` are the same string —
  // and a receiver-typed resolver that cannot tell them apart answers `Child.fire`
  // with the instance method when Ruby reaches the INHERITED `Parent.fire`.
  // Emitted for Ruby only, and absent on graphs built before it: consumers must
  // read "absent" as "unknown, matches either", never as "instance".
  receiver?: "instance" | "class";

  // meaning (Tier-2, one LLM call)
  summary_state: SummaryState;
  summary: string | null;
  crux: Crux | null;
}

export type Relation =
  | "contains" // file → symbol, class → method (structural)
  | "calls" // function → function it invokes
  | "imports" // file → module
  | "references" // symbol → symbol it names but doesn't call
  | "implements" // TS: class → interface
  | "extends" // class → base class
  // Rails (M4): a method hands rendering to a TEMPLATE — a controller action to its
  // conventional view, an explicit `render :edit`, a `layout "admin"` declaration, a
  // template to a partial it includes. Its own relation rather than a `calls`, for
  // two reasons. It is not a call: control leaves for a file, the target is a `file`
  // node rather than a symbol, and counting it among `calls` would move the
  // call-resolution rate this project measures itself by. And M4's acceptance asks
  // for the precision of these edges SPECIFICALLY — the lesson of T7b is that a
  // claim mixed into a larger number is a claim the harness cannot check.
  | "renders"
  // A frontend request reaches the controller action serving it. Keeping this
  // separate prevents route-derived cross-language wiring from becoming calls.
  | "serves"
  | "enqueues" // schedules asynchronous execution
  | "dispatches"; // conditional runtime/framework target, with evidence in via

export interface EdgeV1 {
  source: string; // node id
  target: string; // node id, or an unresolved module string for imports
  relation: Relation;
  confidence: Confidence;
  origin?: "extension";
  extension?: string;
  extensionDigest?: string;
  /** The declaration or receiver condition that justified this edge. */
  via?: string;
}

/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
  prefix: string;
  label: string;
  markers: string[];
}

export interface GraphV1 {
  meta: {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    /** Deterministic identity of the approved extension execution outcomes. */
    extensionState?: string;
    /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
     * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
    scopes?: ScopeV1[];
  };
  nodes: NodeV1[];
  edges: EdgeV1[];
}
