/**
 * Receiver-type binding pass: a pre-order walk over a parsed file that answers,
 * for every local variable / parameter / class field / `self`|`this` attribute,
 * "what type is this?" — so a later member-call site (`app.include_router()`)
 * can look up `app`'s bound type instead of resolving on the bare method name
 * alone. Pure and dependency-only: no LLM, no network, no mutation of the AST.
 *
 * Only `import type` from extract.ts (never a value) — extract.ts imports
 * `collectBindings` from here, so a value import back would be a cycle.
 */
import type Parser from "tree-sitter";
import type { Language, WalkCtx } from "./extract.js";

/** Variable/field → bare type name, keyed by scope. Scope keys mirror
 * extract.ts's own scope stack (`scope.join(".")`, `""` at module level) so a
 * lookup from extract.ts's walk finds exactly what was bound in the same
 * lexical position. */
export class FileBindings {
  private map = new Map<string, string>();
  /** Ruby (M3): every name that is a VARIABLE in this scope, mapped to the offset
   * at which it BECAME one.
   *
   * Ruby spells a receiverless method call exactly like a variable read — tree-sitter
   * emits a plain `identifier` for both — so without this a `def go; organization.id;
   * end` inside a class that also takes an `organization:` parameter reads the
   * parameter as a call to the class's own `attr_reader :organization`. Tracked
   * separately from `map` because a variable with no knowable type still has to be
   * recognized AS a variable.
   *
   * The offset is the M3b half. Ruby's parser turns `x` into a local at the moment it
   * reads `x =`, so an `x.ping` written ABOVE that line is still a method call and must
   * not take the assigned type. `RUBY_ALWAYS_BOUND` opts an `@ivar` out of the
   * ordering, which it must be: `@user` assigned in `initialize` is read by methods
   * declared above it. */
  private rubyVars = new Map<string, number>();
  /** Ruby (M3): assignment types, pending the agreement check in `finalizeRuby`.
   * `null` means "assigned something this pass cannot type", which is a
   * disagreement like any other. */
  private rubyAssigned = new Map<string, RubyType | null>();
  private rubyWriteCounts = new Map<string, number>();
  /** The agreed Ruby types, filled by `finalizeRuby`. Separate from `map` because a
   * Ruby binding carries a receiver KIND that no other language has. */
  private rubyTypes = new Map<string, RubyType>();
  /** Ruby: the scope paths that are a real `def`. A local lookup walks outward from
   * the call site and STOPS at the first of these — see `rubyLocalScope`. */
  private rubyMethodScopes = new Set<string>();

  set(scopePath: string, name: string, type: string): void {
    this.map.set(`${scopePath}|${name}`, type);
  }

  /** Innermost-first: for scope ["a","b"] name "x", tries `a.b|x`, `a|x`, `|x`. */
  lookup(scope: string[], name: string): string | null {
    for (let i = scope.length; i >= 0; i--) {
      const hit = this.map.get(`${scope.slice(0, i).join(".")}|${name}`);
      if (hit) return hit;
    }
    return null;
  }

  /** Ruby (M3): note that `name` is a variable in the scope `rubyScopeKey` chose,
   * from `declAt` onwards, and what (if anything) it was assigned. Call with
   * `type = null` for a declaration that carries no type at all (a parameter, a
   * rescue binding) as well as for an assignment whose right-hand side cannot be
   * typed — both are the same fact: this name holds a value we cannot name. */
  noteRubyVar(scopeKey: string, name: string, type: RubyType | null, declAt: number): void {
    const key = `${scopeKey}|${name}`;
    this.rubyWriteCounts.set(key, (this.rubyWriteCounts.get(key) ?? 0) + 1);
    const seen = this.rubyVars.get(key);
    // The EARLIEST declaration wins: that is where Ruby's parser starts treating the
    // name as a local, and every later write only re-assigns it.
    if (seen === undefined || declAt < seen) this.rubyVars.set(key, declAt);
    if (!this.rubyAssigned.has(key)) this.rubyAssigned.set(key, type);
    else this.rubyAssigned.set(key, mergeRubyType(this.rubyAssigned.get(key) ?? null, type));
  }

  /** Ruby (M3): promote the assignments that every writer agreed on into the type
   * table. A name written twice with two different classes — or once with a class
   * and once with anything unreadable — reaches `lookupRuby` as nothing, because a
   * receiver that holds two types over one scope cannot be bound to either without
   * picking one at random. Order-independent: the disagreement poisons the entry
   * whichever assignment the walk saw first. */
  finalizeRuby(): void {
    for (const [key, type] of this.rubyAssigned) if (type) this.rubyTypes.set(key, type);
  }

  /** Ruby: note that `scopePath` is a `def`'s own scope — a hard wall for locals. */
  noteRubyMethodScope(scopePath: string): void {
    this.rubyMethodScopes.add(scopePath);
  }

  /**
   * The scope a local named `name` is actually bound in, walking outward from the
   * call site and stopping at the first `def`.
   *
   * Not exact, and not unconditionally innermost-first. Two different things wear
   * the same shape in a scope path:
   *
   *   - a segment extract.ts pushes that this walk never created — the lambda of
   *     `scope :for_user, ->(user) { … }`, a `define_method` block, an association
   *     extension. A block genuinely DOES see the enclosing scope's locals, so the
   *     segment must be transparent; treating it as a wall read `for_user`'s own
   *     parameter as a call to `AuditLog#user`.
   *   - a real `def`, which is a wall. A local assigned in a class BODY is invisible
   *     inside that class's methods (verified: `defined?` is nil there), and the
   *     unconditional outward walk typed such a method's receiver off it.
   *
   * The `rubyMethodScopes` set is what tells them apart, so a future divergence
   * between the two walks costs at most a missed edge rather than a wrong one.
   */
  private rubyLocalScope(scopeKey: string, name: string): string | null {
    const segs = scopeKey === "" ? [] : scopeKey.split(".");
    for (let i = segs.length; i >= 0; i--) {
      const key = segs.slice(0, i).join(".");
      if (this.rubyVars.has(`${key}|${name}`)) return key;
      if (i > 0 && this.rubyMethodScopes.has(key)) return null;
    }
    return null;
  }

  /** The key a Ruby name's binding is really stored under. Sigilled names
   * (`@x`, `@@x`, `$x`) are filed at a scope `rubyScopeKey` computed exactly and are
   * never walked for; only locals are. */
  private rubyKeyFor(scopeKey: string, name: string): string | null {
    if (name.startsWith("@") || name.startsWith("$")) {
      return this.rubyVars.has(`${scopeKey}|${name}`) ? scopeKey : null;
    }
    return this.rubyLocalScope(scopeKey, name);
  }

  /** Ruby (M3): is `name` a variable at this scope and position? */
  isRubyVar(scopeKey: string, name: string, at: number): boolean {
    const key = this.rubyKeyFor(scopeKey, name);
    if (key === null) return false;
    const declAt = this.rubyVars.get(`${key}|${name}`);
    return declAt !== undefined && at >= declAt;
  }

  /** Conditional injection must use the same declaration inventory as ordinary
   * typing. A for target, rescue binding or pattern can replace a keyword just
   * as an assignment does; a second AST walker must not forget those writes. */
  hasSingleRubyWrite(scopeKey: string, name: string): boolean {
    const key = this.rubyKeyFor(scopeKey, name);
    return key !== null && this.rubyWriteCounts.get(`${key}|${name}`) === 1;
  }

  /** Ruby (M3): the agreed type of `name` read at `at`, or null. A read before the
   * name became a local is not a variable read at all, so it has no type here. */
  lookupRuby(scopeKey: string, name: string, at: number): RubyType | null {
    const key = this.rubyKeyFor(scopeKey, name);
    if (key === null) return null;
    const declAt = this.rubyVars.get(`${key}|${name}`);
    if (declAt === undefined || at < declAt) return null;
    return this.rubyTypes.get(`${key}|${name}`) ?? null;
  }
}

const FN_VALUE_TYPES = new Set(["arrow_function", "function", "function_expression", "generator_function"]);

/** Definition-node types that push a new scope segment, mirroring extract.ts's
 * `describe()` closely enough to keep the two scope stacks in lockstep — but
 * duplicated here (not imported) to keep bindings.ts free of a value import on
 * extract.ts. Returns the def's scope segment (bare name, except a Go method
 * which is receiver-qualified — `Receiver.method` — exactly like extract.ts's
 * `idName`, so a binding recorded inside a Go method body is stored under the
 * same scope key extract.ts's walk will look it up with), or null if `node`
 * isn't a definition. */
export function defName(node: Parser.SyntaxNode, lang: Language, rails = false): string | null {
  if (lang === "java") {
    return JAVA_DEF_TYPES.has(node.type) ? (node.childForFieldName("name")?.text ?? null) : null;
  }
  if (lang === "go") {
    if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (!name) return null;
      const recv = goReceiverTypeOf(node);
      return recv ? `${recv}.${name}` : name;
    }
    if (node.type === "function_declaration" || node.type === "type_spec") {
      return node.childForFieldName("name")?.text ?? null;
    }
    return null;
  }
  if (lang === "cpp") {
    if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "enum_specifier") {
      return node.childForFieldName("name")?.text ?? null;
    }
    if (node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      const resolved = declarator ? cppDeclaratorName(declarator) : null;
      if (!resolved) return null;
      return resolved.scope ? `${resolved.scope}.${resolved.name}` : resolved.name;
    }
    return null;
  }
  if (lang === "r") return rDefName(node);
  if (lang === "ruby") return rubyDefName(node, rails);
  if (lang === "swift") return swiftDefName(node);
  if (lang === "php") {
    const phpDefTypes = new Set([
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "method_declaration",
      "function_definition",
    ]);
    if (phpDefTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
    // Closures push a scope segment in extract.ts too — mirror it so a typed
    // parameter bound inside a closure is keyed under the same scope path.
    if (node.type === "anonymous_function" || node.type === "arrow_function") return phpClosureName(node);
    // Anonymous classes likewise mint an `{anonymous}` scope segment (#144).
    if (node.type === "anonymous_class") return "{anonymous}";
    return null;
  }
  const defTypes =
    lang === "python"
      ? new Set(["class_definition", "function_definition"])
      : new Set([
          "class_declaration",
          "abstract_class_declaration",
          "function_declaration",
          "generator_function_declaration",
          "method_definition",
          "interface_declaration",
          "type_alias_declaration",
          "enum_declaration",
        ]);
  if (defTypes.has(node.type)) return node.childForFieldName("name")?.text ?? null;
  if ((lang === "typescript" || lang === "tsx") && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return node.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** The scope segment a Ruby definition pushes, mirroring extract.ts's
 * `describeRuby` — duplicated, not imported, per this file's
 * no-value-import-of-extract rule.
 *
 * The compact form is the whole reason this needs its own function. `class
 * A::B::C` names itself with a `scope_resolution`, and extract.ts pushes that path
 * DOTTED (`A.B.C`) as ONE scope segment so the id matches the nested spelling's.
 * Taking `name.text` instead yields `A::B::C`, and a binding filed under a scope
 * key extract.ts's walk never forms can never be looked up — silently, with no
 * error anywhere. */
function rubyDefName(node: Parser.SyntaxNode, rails: boolean): string | null {
  if (node.type === "method" || node.type === "singleton_method") {
    return node.childForFieldName("name")?.text ?? null;
  }
  // `class_methods do ... end` pushes the scope segment Rails' own generated module
  // carries, exactly as extract.ts does. Gated on Rails in both, or the two stacks
  // drift for a plain-Ruby repo that happens to define a `class_methods` method.
  if (node.type === "call") return rails && rubyIsClassMethodsBlock(node) ? "ClassMethods" : null;
  if (node.type !== "class" && node.type !== "module") return null;
  const nameNode = node.childForFieldName("name");
  const path = nameNode ? rubyConstPath(nameNode) : null;
  return path === null ? null : path.replace(/^::/, "").split("::").join(".");
}

/** This spelling supplies a named class candidate for resolver validation. Its block keeps
 * the caller's lexical constants, but owns methods and ivars on the new class. */
export function rubyNamedClassFactory(node: Parser.SyntaxNode): { name: string; parent: string; call: Parser.SyntaxNode; block: Parser.SyntaxNode | null } | null {
  if (node.type !== "assignment") return null;
  const left = node.childForFieldName("left");
  const call = node.childForFieldName("right");
  if (left?.type !== "constant" || call?.type !== "call" || call.childForFieldName("method")?.text !== "new") return null;
  const receiver = call.childForFieldName("receiver");
  if (receiver?.type !== "constant" || receiver.text !== "Class") return null;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 1) return null;
  const parent = rubyConstPath(args[0]);
  return parent ? { name: left.text, parent, call, block: call.childForFieldName("block") } : null;
}

/** A constant-assigned factory block can define methods on an unnamed object.
 * Letting its defs or ivar assignments enter the surrounding class gives callers
 * a confident edge into an object Ruby never uses. Recognized Class.new blocks
 * are consumed by their assignment in both walks before this barrier. Anonymous
 * stubs and ordinary constructor blocks retain their existing inspection/call
 * behavior; this repair only changes statically constant-assigned factories. */
export function rubyUnknownFactoryBlock(node: Parser.SyntaxNode): boolean {
  if (node.type !== "block" && node.type !== "do_block") return false;
  const call = node.parent;
  if (call?.type !== "call") return false;
  const assignment = call.parent;
  const left = assignment?.childForFieldName("left");
  return assignment?.type === "assignment" && (left?.type === "constant" || left?.type === "scope_resolution");
}

/** `class_methods do ... end` — ActiveSupport::Concern's spelling of a nested
 * `module ClassMethods`. Mirrors extract.ts's `rubyClassMethodsBlock`. */
function rubyIsClassMethodsBlock(node: Parser.SyntaxNode): boolean {
  const m = node.childForFieldName("method");
  if (m?.type !== "identifier" || m.text !== "class_methods" || node.childForFieldName("receiver")) return false;
  const block = node.childForFieldName("block");
  return block?.type === "do_block" || block?.type === "block";
}

/** A Ruby constant path as written (`Runner`, `A::B::Runner`, `::Runner`), or null
 * when any segment of it is a runtime value (`obj::CONST`). Mirrors extract.ts's
 * function of the same name — see the note on `rubyDefName` for why it is copied
 * rather than imported. */
function rubyConstPath(node: Parser.SyntaxNode): string | null {
  if (node.type === "constant") return node.text;
  if (node.type !== "scope_resolution") return null;
  const name = node.childForFieldName("name");
  if (name?.type !== "constant") return null;
  const scope = node.childForFieldName("scope");
  if (!scope) return `::${name.text}`;
  const head = rubyConstPath(scope);
  return head === null ? null : `${head}::${name.text}`;
}

/**
 * What a Ruby expression evaluates to: a class NAME plus what you are holding of
 * it. The second half is not decoration — it decides which methods dispatch.
 *
 * `User` and `User.new` name the same class and share nothing else. A class object
 * answers `def self.` methods, the modules it `extend`s, and the `ClassMethods` of
 * the concerns it includes; an instance answers `def` methods, the modules it
 * includes, and its superclass's. M3 typed the receiver but collapsed the two, and
 * the graph then said `Child.fire` reaches `Child#fire` when Ruby reaches
 * `Parent.fire` — a wrong edge carrying `type_bound`, the confidence value that
 * promises a type chose it.
 *
 * `collection` is ActiveRecord's third answer. `blog.posts` is a CollectionProxy,
 * not a Post: it forwards class methods and scopes to the model and raises
 * NoMethodError for its instance methods (verified against ActiveRecord 8.1).
 */
export type RubyValueKind = "instance" | "class" | "collection" | "unknown";

/** What a DEFINITION declares: `def x` versus `def self.x` / `class << self`. The
 * two values `NodeV1.receiver` can take. */
export type RubySelfKind = "instance" | "class";

/**
 * What `self` IS at a point in the walk, which has a third answer a definition
 * cannot have.
 *
 * A block written in a class body is the case: `test "it works" do … end` becomes
 * an INSTANCE method, `included do … end` runs in the includer's class body, and
 * `scope :recent, -> { … }` runs on the class — and nothing in the syntax says
 * which. Reading every such block as the class body cost dailywerk 927 real calls
 * into its own test helpers in one go. `"unknown"` makes the lookup try both chains
 * instead of picking one, and says so in the graph rather than pretending.
 */
export type RubySelfContext = RubySelfKind | "unknown";

/** Both walks must agree when a block's ivars belong to an object other than
 * lexical self. Otherwise an instance_eval assignment types the surrounding
 * service's field even though Ruby wrote it on a completely different object. */
export function rubyBlockSelfContext(node: Parser.SyntaxNode, current: RubySelfContext): RubySelfContext {
  if (node.type !== "block" && node.type !== "do_block") return current;
  return current === "class" || rubyBlockRebindsSelf(node)
    ? "unknown" : current;
}

function rubyBlockRebindsSelf(node: Parser.SyntaxNode): boolean {
  if (node.type !== "block" && node.type !== "do_block") return false;
  const method = node.parent?.childForFieldName("method")?.text;
  return !!method && ["instance_eval", "instance_exec", "class_eval", "class_exec", "module_eval", "module_exec"].includes(method);
}

/** Separate foreign blocks cannot share even the old unknown-self ivar slot.
 * That slot is useful for setup/test DSLs, but two instance_eval calls may run
 * on entirely unrelated objects. The source position isolates those bindings. */
export function rubyBlockClassScope(node: Parser.SyntaxNode, scope: string | null): string | null {
  return rubyBlockRebindsSelf(node) ? `${scope ?? ""}%rebound@${node.startIndex}` : scope;
}

export interface RubyType {
  fqn: string;
  kind: RubyValueKind;
  /** The name of the ActiveRecord finder the kind was read off (`Widget.first` →
   * `"first"`), when it was. Only the truth if `Widget` really is a model, so
   * resolve.ts re-checks the heritage chain — and, before that, whether the class
   * declares its OWN class method of that name, which Ruby would reach first.
   * A plain Ruby `SomeService.create(...)` means whatever its body returns. */
  finder?: string;
}

/**
 * What two writers of the same name agree on, or null when they do not.
 *
 * Agreement is on the class and what you hold of it. `finder` is PROVENANCE — how
 * this pass learned the kind — and deliberately does not have to match: a Rails
 * controller that writes `@config = Config.find(params[:id])` in one action and
 * `@config = Config.new` in another has two writers that agree it is a Config, and
 * requiring them to agree on how we know that cost every such controller its
 * binding. The stronger guard is kept, though: if ANY writer needed ActiveRecord's
 * vocabulary to read its kind, the merged type still carries a finder, so resolve.ts
 * still checks that the class really is a model before trusting it.
 */
export function mergeRubyType(a: RubyType | null, b: RubyType | null): RubyType | null {
  if (!a || !b) return null;
  if (a.fqn !== b.fqn || a.kind !== b.kind) return null;
  // Lexicographic rather than first-seen, so the merge does not depend on walk order.
  const finder = a.finder && b.finder ? (a.finder < b.finder ? a.finder : b.finder) : (a.finder ?? b.finder);
  return finder ? { fqn: a.fqn, kind: a.kind, finder } : { fqn: a.fqn, kind: a.kind };
}

export function sameRubyType(a: RubyType | null, b: RubyType | null): boolean {
  if (a === b) return true;
  return mergeRubyType(a, b) !== null;
}

/**
 * A declaration with no lexical start, for `noteRubyVar`'s `declAt`.
 *
 * Only LOCALS become variables at a point in the file: Ruby's parser turns `x`
 * from a method call into a local variable the moment it reads `x =`, and a `x.ping`
 * written ABOVE that line is still a call (verified: it dispatches to whatever `x`
 * the class defines). Instance and class variables have no such point — `@user`
 * assigned in `initialize` is read by a method declared above it — so they are
 * bound everywhere in their scope regardless of order.
 */
export const RUBY_ALWAYS_BOUND = -1;

/**
 * Where a Ruby name's binding is filed.
 *
 * Locals are keyed by the exact scope and looked up there, never by walking
 * outward: a local assigned in a class BODY is invisible inside that class's `def`
 * (verified — `defined?` is nil there), and the outward walk that M3 shared with
 * every other language typed such a `def`'s receiver off it.
 *
 * `@x` splits by `self`. In a class body or a `def self.`, `@x` is the CLASS
 * OBJECT's slot; in an instance method it is each instance's, and the two never
 * meet — `@config = Store.new` at class level beside `def config; @config; end`
 * reads nil at run time. `@@x` is genuinely shared between them, so it does not
 * split. `$x` is filed per file for var-ness only and never carries a type: it can
 * be assigned from any file in the program.
 */
export function rubyScopeKey(
  name: string,
  scope: readonly string[],
  classScope: string | null,
  selfKind: RubySelfContext,
): string {
  if (name.startsWith("$")) return "%global";
  if (name.startsWith("@@")) return classScope ?? "";
  if (name.startsWith("@")) {
    const own = classScope ?? "";
    // A third slot for a block whose `self` is unknown, kept apart from BOTH the
    // class object's and the instance's. `setup do @user = … end` and `test "…" do
    // @user.name end` share it; a `def` in the same class does not see it, which
    // costs a type rather than inventing one.
    if (selfKind === "unknown") return `${own}%block`;
    return selfKind === "class" ? `${own}%singleton` : own;
  }
  return scope.join(".");
}

/** The read/write position a binding question is asked at, plus the scope it is
 * asked in. Bundled because every Ruby type question now needs all of it, and a
 * five-argument call at each of two dozen sites drifts. */
export interface RubyTypeCtx {
  bindings?: FileBindings;
  scope: readonly string[];
  classScope: string | null;
  selfKind: RubySelfContext;
  /** Gates ActiveRecord's finder vocabulary. `new` is plain Ruby and is always on;
   * `first`/`find`/`create` mean something else entirely outside Rails. */
  rails: boolean;
}

/** Plain-Ruby class methods whose result is an instance of the receiver. */
const RUBY_PLAIN_CONSTRUCTORS: ReadonlySet<string> = new Set(["new", "instance"]);

/**
 * ActiveRecord's single-record finders, each with the argument shapes that keep it
 * one — because most of them return an ARRAY when asked for more than one, and the
 * name alone does not say which happened.
 *
 * Measured against a running ActiveRecord 8.1, not read off the guides:
 * `User.first(2)`, `User.last(2)`, `User.take(2)`, `User.find([1, 2])`,
 * `User.find(1, 2)` and `User.create!([{…}, {…}])` are all `Array`, and M3 typed
 * every one of them as a `User` — so a `.ping` on the result bound to `User#ping`
 * when Ruby was about to raise `NoMethodError` on an Array.
 *
 * Deliberately still a closed list. `User.where(…)` is a relation and
 * `User.pluck(:id)` is an array, and typing either as `User` would bind `.map`
 * and `.size` to whatever the model happens to define. A relation-returning call
 * produces NO binding, so the variable is recorded as an untypeable local and
 * every later call on it declines — the intended answer, not a gap.
 */
type RubyArgShape = (args: Parser.SyntaxNode | null) => boolean;
const AR_RECORD_FINDERS: ReadonlyMap<string, RubyArgShape> = new Map<string, RubyArgShape>([
  // `find` is the whole reason this map holds predicates: one id is a record, a
  // list or several ids is an Array of them.
  ["find", (a) => rubyArgCount(a) === 1 && !rubyFirstArgIsList(a)],
  ["find!", (a) => rubyArgCount(a) === 1 && !rubyFirstArgIsList(a)],
  // `first`/`last`/`take` take an optional COUNT, and any count at all makes an Array.
  ["first", (a) => rubyArgCount(a) === 0],
  ["first!", (a) => rubyArgCount(a) === 0],
  ["last", (a) => rubyArgCount(a) === 0],
  ["last!", (a) => rubyArgCount(a) === 0],
  ["take", (a) => rubyArgCount(a) === 0],
  ["take!", (a) => rubyArgCount(a) === 0],
  // The `_by` family takes conditions, never a count, so it is one record or nil.
  ["find_by", () => true],
  ["find_by!", () => true],
  ["find_or_create_by", () => true],
  ["find_or_create_by!", () => true],
  ["find_or_initialize_by", () => true],
  // The writers take an array of attribute hashes to build many at once.
  ["create", (a) => !rubyFirstArgIsList(a)],
  ["create!", (a) => !rubyFirstArgIsList(a)],
  ["build", (a) => !rubyFirstArgIsList(a)],
]);

function rubyArgCount(args: Parser.SyntaxNode | null): number {
  return args ? args.namedChildren.length : 0;
}

/** Is the call being handed a LIST of things to find or build? An array literal,
 * or more than one positional argument. A splat is unreadable either way, so it
 * counts as a list: `User.find(*ids)` is an Array whenever `ids` has two. */
function rubyFirstArgIsList(args: Parser.SyntaxNode | null): boolean {
  if (!args || args.namedChildren.length === 0) return false;
  const first = args.namedChildren[0];
  if (first.type === "array" || first.type === "splat_argument") return true;
  // Two positional arguments to `find` is `find(1, 2)`; a trailing options hash is
  // not a second record.
  return args.namedChildren.filter((c) => c.type !== "hash" && c.type !== "pair" && c.type !== "block").length > 1;
}

/** Statement-list nodes whose VALUE is the value of their last statement. */
const RUBY_TAIL_VALUED: ReadonlySet<string> = new Set([
  "body_statement", "begin", "then", "else", "do", "parenthesized_statements", "block_body",
]);

/** Branching expressions: their value is whichever branch ran, so they have a type
 * only when every branch agrees on one. */
const RUBY_BRANCHING: ReadonlySet<string> = new Set(["if", "unless", "case", "case_match", "conditional"]);

/**
 * Every value a statement list can produce — which is not just its tail.
 *
 * `def build; User.new; rescue; Gadget.new; end` returns a Gadget whenever the body
 * raises, and `begin … rescue … else X end` returns X whenever it does NOT: the
 * `else` clause REPLACES the body's tail as the value. M3 skipped both clauses on
 * the way to the tail and asserted the tail's class as the method's return type,
 * so a rescue that returned a different class produced a confident wrong chain.
 *
 * `ensure` never contributes: its value is discarded.
 */
function rubyResultPaths(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const rescues: Parser.SyntaxNode[] = [];
  let elseClause: Parser.SyntaxNode | null = null;
  let tail: Parser.SyntaxNode | null = null;
  for (const c of node.namedChildren) {
    if (c.type === "rescue") { rescues.push(c); continue; }
    if (c.type === "else") { elseClause = c; continue; }
    if (c.type === "ensure" || c.type === "elsif") continue;
    tail = c;
  }
  // An `else` here belongs to a begin/rescue only when a `rescue` is present; the
  // `else` arm of an `if` reaches this function as the node itself, with no siblings.
  const primary = rescues.length > 0 && elseClause ? elseClause : (elseClause ?? tail);
  const out: Parser.SyntaxNode[] = [];
  if (primary) out.push(primary);
  for (const r of rescues) {
    const body = r.childForFieldName("body");
    if (body) out.push(body);
    else return []; // a bare `rescue` with no body is nil; unreadable shape, decline
  }
  return out;
}

/**
 * The class a Ruby expression evaluates to, and what you hold of it — or null when
 * this pass cannot say.
 *
 * The base cases say so outright: a constant (`x = User` — the class OBJECT), or a
 * constructor/finder call on one (`User.new`, `User.find(1)` — an instance).
 *
 * The recursive cases exist because real Rails code rarely writes the base case on
 * its own line. `@current_user = if session[:impersonating_user_id] … User.find_by(…)
 * elsif … User.find_by(…) end` is the actual shape of `current_user` in
 * filewerk-rails, and it is the receiver of 90 call sites. A branch has a type only
 * when EVERY branch that produces one agrees; a branch producing `nil` is ignored
 * (that is what a finder returns when it finds nothing, and it does not make the
 * method return a different class), and a branch this pass cannot read at all
 * withdraws the answer entirely.
 */

/**
 * Ruby's own contracts, as three tables. None of these is an inference about this
 * repository — they are what the language guarantees, and they exist so that a
 * method the repository ADDS to a core class can be reached from its callers.
 *
 * Without them a monkey patch is invisible in exactly the direction that matters.
 * `config/initializers/string_truncate_bytes.rb` defines `String#truncate_bytes` in
 * dailywerk; the four files that call it had no edge to it, while 76 files that
 * merely mention `String` in a type check had one (see docs/39, where those 76 were
 * removed). "Who calls this monkey patch" is the single hardest question to answer
 * by grep, because the method name is the only clue and nothing in the call site
 * names the file.
 *
 * The blast radius is bounded by construction: a receiver typed as `String` can
 * only resolve to methods the repository itself defines on `String`. That is ONE
 * method in dailywerk and NONE in filewerk, so these tables cannot invent an edge
 * to a class the repository does not patch.
 */
const RUBY_LITERAL_TYPE: ReadonlyMap<string, string> = new Map([
  ["string", "String"],
  ["bare_string", "String"],
  ["string_array", "Array"],
  ["symbol_array", "Array"],
  ["integer", "Integer"],
  ["float", "Float"],
  ["rational", "Rational"],
  ["complex", "Complex"],
  ["array", "Array"],
  ["hash", "Hash"],
  ["simple_symbol", "Symbol"],
  ["delimited_symbol", "Symbol"],
  ["regex", "Regexp"],
  ["range", "Range"],
]);

/** The classes a YARD tag may type a value as: the ones a literal can produce. */
const RUBY_YARD_CORE: ReadonlySet<string> = new Set(RUBY_LITERAL_TYPE.values());

/**
 * Defined on `Object`, so every receiver answers them, and String by contract. A
 * class that overrides `to_s` to return a non-String is broken in ways `puts` would
 * expose long before a graph did. These are the only methods typed without knowing
 * what the receiver is.
 */
const RUBY_UNIVERSAL_TO_STRING: ReadonlySet<string> = new Set(["to_s", "inspect", "to_str"]);

/**
 * `<core class>#<method>` → what it returns, consulted ONLY when the receiver is
 * already typed as that class. Keeping the receiver in the key is the whole
 * precision argument: `strip` means String on a String and means whatever a
 * repository's `TextNormalizer.strip` says it means, and a table keyed on the bare
 * name could not tell those apart. That is the language-blind unique-name matching
 * `test/graph-cross-language.test.ts` exists to forbid, arriving by another door.
 */
const RUBY_CORE_RETURNS: ReadonlyMap<string, string> = new Map([
  ["String#strip", "String"], ["String#lstrip", "String"], ["String#rstrip", "String"],
  ["String#chomp", "String"], ["String#chop", "String"], ["String#squeeze", "String"],
  ["String#downcase", "String"], ["String#upcase", "String"], ["String#capitalize", "String"],
  ["String#swapcase", "String"], ["String#reverse", "String"], ["String#succ", "String"],
  ["String#scrub", "String"], ["String#force_encoding", "String"], ["String#encode", "String"],
  ["String#unicode_normalize", "String"], ["String#tr", "String"], ["String#delete", "String"],
  ["String#center", "String"], ["String#ljust", "String"], ["String#rjust", "String"],
  ["String#dup", "String"], ["String#freeze", "String"], ["String#b", "String"],
  ["String#lines", "Array"], ["String#chars", "Array"], ["String#bytes", "Array"],
  ["String#split", "Array"], ["String#length", "Integer"], ["String#size", "Integer"],
  ["String#bytesize", "Integer"],
  ["Array#join", "String"], ["Array#map", "Array"], ["Array#flat_map", "Array"],
  ["Array#compact", "Array"], ["Array#flatten", "Array"], ["Array#uniq", "Array"],
  ["Array#sort", "Array"], ["Array#reverse", "Array"], ["Array#to_a", "Array"],
  ["Array#length", "Integer"], ["Array#size", "Integer"],
  ["Hash#keys", "Array"], ["Hash#values", "Array"], ["Hash#to_a", "Array"],
  ["Hash#map", "Array"], ["Hash#merge", "Hash"], ["Hash#to_h", "Hash"],
]);

/**
 * Core CLASS methods with a fixed return. `File.read(path)` is a String, and a
 * local assigned from one is the receiver in two of dailywerk's `truncate_bytes`
 * call sites.
 *
 * The risk this carries and the earlier tables do not: a repository that defines
 * its OWN top-level `File` or `Dir` would be typed from this table instead. Neither
 * corpus repository does — the only core constant either of them reopens is
 * `String` — and a repository that shadows `File` has arranged for every reader to
 * be wrong, not just this one.
 */
const RUBY_CORE_CLASS_RETURNS: ReadonlyMap<string, string> = new Map([
  ["File#read", "String"], ["File#binread", "String"], ["File#basename", "String"],
  ["File#dirname", "String"], ["File#extname", "String"], ["File#expand_path", "String"],
  ["File#join", "String"], ["File#realpath", "String"], ["File#readlines", "Array"],
  ["Dir#pwd", "String"], ["Dir#home", "String"], ["Dir#glob", "Array"],
  ["Dir#entries", "Array"], ["Dir#children", "Array"],
]);

function rubyExprType(node: Parser.SyntaxNode, ctx: RubyTypeCtx, depth = 0): RubyType | null {
  if (depth > 8) return null;
  const recur = (n: Parser.SyntaxNode): RubyType | null => rubyExprType(n, ctx, depth + 1);
  if (node.type === "constant" || node.type === "scope_resolution") {
    const fqn = rubyConstPath(node);
    return fqn === null ? null : { fqn, kind: "class" };
  }
  if (node.type === "self") {
    const own = ctx.classScope ? ctx.classScope.split(".").join("::") : null;
    return own ? { fqn: own, kind: ctx.selfKind } : null;
  }
  void 0;
  if (node.type === "assignment" || node.type === "operator_assignment") {
    const right = node.childForFieldName("right");
    return right ? recur(right) : null;
  }
  if (RUBY_TAIL_VALUED.has(node.type)) {
    const paths = rubyResultPaths(node);
    return rubyAgree(paths, recur);
  }
  if (RUBY_BRANCHING.has(node.type)) return rubyBranchType(node, recur);
  if (ctx.bindings && (node.type === "identifier" || node.type === "instance_variable" || node.type === "class_variable")) {
    const key = rubyScopeKey(node.text, ctx.scope, ctx.classScope, ctx.selfKind);
    return ctx.bindings.lookupRuby(key, node.text, node.startIndex);
  }
  const literal = RUBY_LITERAL_TYPE.get(node.type);
  if (literal) return { fqn: literal, kind: "instance" };
  if (node.type !== "call") return null;
  const method = node.childForFieldName("method");
  const receiver = node.childForFieldName("receiver");
  if (!receiver || method?.type !== "identifier") return null;
  // `x.to_s` is a String whoever `x` is. A block would mean a different call shape
  // entirely, so it withdraws the answer here as it does for a constructor.
  if (RUBY_UNIVERSAL_TO_STRING.has(method.text) && !rubyConstructionHasBlock(node))
    return { fqn: "String", kind: "instance" };
  // `parts.join("\n")` is a String whatever `parts` is, and the STRING LITERAL is
  // the evidence rather than an assumption about the receiver. `join` on anything
  // else in the core library takes no separator — `Thread#join` takes a numeric
  // timeout — so an argument that is a bare string literal is what tells the two
  // apart. Without this the chain `doc.paragraphs.map(&:text).join("\n")` cannot be
  // typed at all, because `map` on an unknown receiver is not an Array by contract.
  if (method.text === "join" && !rubyConstructionHasBlock(node)) {
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    if (args.length === 1 && RUBY_LITERAL_TYPE.get(args[0].type) === "String")
      return { fqn: "String", kind: "instance" };
  }
  if (receiver.type === "constant" || receiver.type === "scope_resolution") {
    const fqn = rubyConstPath(receiver);
    if (fqn === null) return null;
    const core = RUBY_CORE_CLASS_RETURNS.get(`${fqn}#${method.text}`);
    if (core && !rubyConstructionHasBlock(node)) return { fqn: core, kind: "instance" };
    return rubyConstructorType(fqn, method.text, node, ctx);
  }
  // The receiver has to be typed BEFORE the table is consulted — see the comment on
  // RUBY_CORE_RETURNS for why the bare method name is not enough.
  const recv = recur(receiver);
  if (!recv || recv.kind !== "instance") return null;
  const returns = RUBY_CORE_RETURNS.get(`${recv.fqn}#${method.text}`);
  return returns && !rubyConstructionHasBlock(node) ? { fqn: returns, kind: "instance" } : null;
}

/**
 * The comment nodes directly above a `def`, nearest first.
 *
 * The first `def` in a class body is the case that needs care. tree-sitter-ruby
 * hangs the comments above it on the CLASS, as siblings of the body — so the method
 * itself has no previous sibling at all, and a reader that only walks siblings finds
 * no documentation on exactly the method a class most often documents first. Both
 * YARD readers go through here so they cannot disagree about which comments belong
 * to which method.
 */
export function rubyLeadingComments(method: Parser.SyntaxNode): Parser.SyntaxNode[] {
  let start = method.previousNamedSibling;
  const body = method.parent;
  if (!start && body?.type === "body_statement" && body.firstNamedChild?.startIndex === method.startIndex)
    start = body.previousNamedSibling;
  const out: Parser.SyntaxNode[] = [];
  let nextRow = method.startPosition.row;
  for (let c = start; c?.type === "comment" && c.endPosition.row + 1 >= nextRow; c = c.previousNamedSibling) {
    out.push(c);
    nextRow = c.startPosition.row;
  }
  return out;
}

/**
 * The ONE core class a YARD tag above `method` states, or null.
 *
 * `@param bytes [String]` and `@return [String]` are the author saying what a value
 * is, and dailywerk writes them on nearly every method. Two of its seven
 * `truncate_bytes` call sites are reachable through nothing else: a parameter the
 * body never assigns, and a normalizer whose body calls a sibling helper.
 *
 * Trusting a comment is a real choice, so it is bounded three ways. Only a CORE
 * class counts — a receiver typed `String` can reach nothing but methods the
 * repository itself defines on `String`, so a stale tag cannot invent an edge into
 * application code. Only a single class, with `nil` allowed beside it: `[String,
 * Symbol]` is a union this pass cannot choose from. And only when exactly one such
 * tag names the value; two `@return` lines are two answers.
 */
export function rubyYardCoreType(method: Parser.SyntaxNode, tag: "param" | "return", name?: string): string | null {
  const found: string[] = [];
  for (const c of rubyLeadingComments(method)) {
    const m = tag === "return"
      ? c.text.match(/^#\s*@return\s+\[([^\]\n]+)\]/)
      : c.text.match(/^#\s*@param\s+(\w+)\s+\[([^\]\n]+)\]/);
    if (!m || (tag === "param" && m[1] !== name)) continue;
    found.push(tag === "return" ? m[1] : m[2]);
  }
  if (found.length !== 1) return null;
  const types = found[0].split(",").map((t) => t.trim().replace(/^::/, "")).filter((t) => t !== "nil" && t !== "NilClass");
  if (types.length !== 1) return null;
  const base = types[0].replace(/[<{].*$/s, "");
  return RUBY_YARD_CORE.has(base) ? base : null;
}

/**
 * What a core method hands back, for a receiver whose class is ALREADY known.
 * `String` + `strip` → String; the class object `File` + `read` → String.
 *
 * This is the step the receiver WALK needs rather than the expression pass: a chain
 * like `raw.force_encoding(enc).scrub` builds a head of `String` and two steps, and
 * the step walk in resolve.ts then looks for `String#force_encoding` among the
 * repository's own nodes and correctly finds nothing. Collapsing the pair here keeps
 * the receiver flat and the type honest.
 */
export function rubyCoreMethodReturn(fqn: string, kind: RubyValueKind, name: string): RubyType | null {
  const table = kind === "class" ? RUBY_CORE_CLASS_RETURNS : RUBY_CORE_RETURNS;
  const out = table.get(`${fqn}#${name}`);
  return out ? { fqn: out, kind: "instance" } : null;
}

/**
 * The type of an expression standing in RECEIVER position, for the cases
 * `rubyReceiverType` cannot walk as a chain: a literal, and a call whose type the
 * core tables above settle. Kept separate from `rubyExprType` so the receiver walk
 * keeps its own precedence — a constructor, a bound variable and `self` are all
 * decided before this is asked.
 */
export function rubyCoreExprType(node: Parser.SyntaxNode, ctx: RubyTypeCtx): RubyType | null {
  const literal = RUBY_LITERAL_TYPE.get(node.type);
  if (literal) return { fqn: literal, kind: "instance" };
  return node.type === "call" ? rubyExprType(node, ctx) : null;
}

/** A constructor block may replace singleton methods on the yielded instance.
 * Every constructor type source needs this check, including assignments, method
 * returns and direct receivers; guarding only keyword injection left them typed. */
export function rubyConstructionHasBlock(node: Parser.SyntaxNode): boolean {
  return !!node.childForFieldName("block") || node.namedChildren.some(child => child.type === "block" || child.type === "do_block") ||
    !!node.childForFieldName("arguments")?.namedChildren.some(child => child.type === "block_argument" || child.type === "forward_argument");
}

/** `Klass.<name>(args)` read as a constructor or finder, or null when the name is
 * not one — in which case the caller must resolve `<name>` as an ordinary class
 * method and use ITS declared return type instead. */
export function rubyConstructorType(
  fqn: string,
  name: string,
  call: Parser.SyntaxNode,
  ctx: RubyTypeCtx,
): RubyType | null {
  if (rubyConstructionHasBlock(call)) return null;
  const args = call.childForFieldName("arguments");
  if (RUBY_PLAIN_CONSTRUCTORS.has(name)) return { fqn, kind: "instance" };
  if (!ctx.rails) return null;
  const yieldsOne = AR_RECORD_FINDERS.get(name);
  if (!yieldsOne) return null;
  return yieldsOne(args) ? { fqn, kind: "instance", finder: name } : null;
}

/** The one type every path agrees on. A `nil` path abstains rather than vetoing;
 * a path this pass cannot read withdraws the answer. */
function rubyAgree(
  paths: readonly Parser.SyntaxNode[],
  recur: (n: Parser.SyntaxNode) => RubyType | null,
): RubyType | null {
  let agreed: RubyType | null = null;
  for (const p of paths) {
    if (p.type === "nil") continue;
    const t = recur(p);
    if (!t) return null;
    if (agreed) {
      const merged = mergeRubyType(agreed, t);
      if (!merged) return null;
      agreed = merged;
      continue;
    }
    agreed = t;
  }
  return agreed;
}

/** The one type every branch of a conditional agrees on, or null. `nil` branches
 * (including an absent `else`, which is an implicit `nil`) abstain rather than
 * veto; anything else this pass cannot type vetoes. */
function rubyBranchType(
  node: Parser.SyntaxNode,
  recur: (n: Parser.SyntaxNode) => RubyType | null,
): RubyType | null {
  const arms: Parser.SyntaxNode[] = [];
  const collect = (n: Parser.SyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (c.type === "then" || c.type === "else") arms.push(c);
      else if (c.type === "elsif" || c.type === "when" || c.type === "in_clause") collect(c);
    }
  };
  if (node.type === "conditional") {
    // `c ? a : b` — three bare children, the condition first.
    arms.push(...node.namedChildren.slice(1));
  } else {
    collect(node);
  }
  const paths: Parser.SyntaxNode[] = [];
  for (const arm of arms) {
    if (arm.namedChildren.length === 0) continue; // an empty branch is nil
    if (arm.type === "then" || arm.type === "else") {
      paths.push(...rubyResultPaths(arm));
      continue;
    }
    paths.push(arm);
  }
  return rubyAgree(paths, recur);
}

/**
 * The class a Ruby method returns, when every exit agrees on one — or null, which
 * is the answer for the overwhelming majority of methods.
 *
 * This is the one type source M3 needs that no declaration provides. Rails states
 * an association's result (`has_many :posts`), but `current_user`,
 * `current_organization` and every hand-rolled memoized reader state nothing, and
 * between them they are the receiver of 126 call sites in filewerk-rails alone —
 * more than the `message` hotspot this milestone was measured against.
 *
 * Every exit means every `return`, the body's tail expression, AND every `rescue`
 * or `else` clause — see `rubyResultPaths`. A `return` with no value, and a `nil`
 * literal, abstain: `return nil unless x` does not make the method return
 * something other than a class. One exit this pass cannot read withdraws the whole
 * answer: a method that sometimes returns a `User` and sometimes something unknown
 * is not a `User`-returning method, and binding a chain through it would be a guess
 * with a class name attached to it.
 *
 * `return` inside a `lambda`/`->` returns from the lambda, not the method, so those
 * are not exits; a nested `def` is not this method's body at all.
 */
export function rubyMethodReturnType(
  node: Parser.SyntaxNode,
  ctx: RubyTypeCtx,
): RubyType | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  let agreed: RubyType | null = null;
  const consider = (n: Parser.SyntaxNode | null): boolean => {
    if (!n || n.type === "nil") return true;
    const t = rubyExprType(n, ctx);
    if (!t) return false;
    if (agreed) {
      const merged = mergeRubyType(agreed, t);
      if (!merged) return false;
      agreed = merged;
      return true;
    }
    agreed = t;
    return true;
  };
  let ok = true;
  const visitReturns = (n: Parser.SyntaxNode): void => {
    if (!ok) return;
    if (n.type === "method" || n.type === "singleton_method" || n.type === "lambda" || n.type === "class" || n.type === "module") return;
    if (n.type === "return") {
      const args = n.namedChildren[0];
      if (!args) return; // bare `return` is nil
      if (args.type === "argument_list" && args.namedChildren.length !== 1) { ok = false; return; }
      ok = consider(args.type === "argument_list" ? args.namedChildren[0] : args);
      return;
    }
    for (const c of n.namedChildren) visitReturns(c);
  };
  // `def build = Widget.new` — an endless def's body field is the expression itself,
  // not a body_statement, so the result-path walk below found no exit at all and 91
  // such methods in dailywerk declared nothing. The expression IS the only exit.
  if (body.type !== "body_statement") {
    visitReturns(body);
    return ok && consider(body) ? agreed : null;
  }
  for (const c of body.namedChildren) visitReturns(c);
  if (!ok) return null;
  for (const path of rubyResultPaths(body)) if (!consider(path)) return null;
  return agreed;
}

/**
 * Ruby (M3) variable/field -> class bindings, plus the variable NAMES themselves.
 *
 * Two outputs, and the second matters as much as the first. Ruby has no syntax
 * that distinguishes `organization` the local from `organization` the
 * receiverless call to `attr_reader :organization` — tree-sitter emits a plain
 * `identifier` for both — so the set of names that are variables here is what
 * stops a parameter from being read as a call into its own class. It is the
 * reason the pass records untypeable assignments at all.
 *
 * Where each name is filed, and from which position it counts as bound, is
 * `rubyScopeKey` and `RUBY_ALWAYS_BOUND`.
 */
export interface RubyBindingDeclaration {
  target: Parser.SyntaxNode;
  name: string;
  value: Parser.SyntaxNode | null;
  assignment: boolean;
  parameter?: string;
}

// Ruby's _mlhs contains nested destructured_left_assignment and rest_assignment,
// while formal/pattern captures use named parameter wrappers. Descend only these
// target containers: a call, subscript or constant lhs contains reads, not local
// declarations. Anonymous rest targets have no child to declare.
const RUBY_BINDING_TARGET_CONTAINERS = new Set([
  "left_assignment_list", "destructured_left_assignment", "rest_assignment", "destructured_parameter",
]);
const RUBY_NAMED_BINDING_PARAMETERS = new Set([
  "splat_parameter", "hash_splat_parameter", "block_parameter", "keyword_parameter", "optional_parameter",
]);

/** Decode variable writes once for both file-local typing and cross-file
 * injection invalidation. A second syntax list forgot for/rescue writers in
 * reopened classes even after the local type table correctly saw them. */
export function rubyBindingDeclarations(node: Parser.SyntaxNode): RubyBindingDeclaration[] {
  const declarations: RubyBindingDeclaration[] = [];
  const declare = (target: Parser.SyntaxNode, value: Parser.SyntaxNode | null = null, assignment = false, parameter?: string): void => {
    if (RUBY_BINDING_TARGET_CONTAINERS.has(target.type)) {
      for (const child of target.namedChildren) declare(child);
      return;
    }
    if (RUBY_NAMED_BINDING_PARAMETERS.has(target.type)) {
      const name = target.childForFieldName("name");
      if (name) declare(name);
      return;
    }
    const kind = target.type;
    if (kind !== "identifier" && kind !== "instance_variable" && kind !== "class_variable" && kind !== "global_variable") {
      return;
    }
    declarations.push({ target, name: target.text, value, assignment, ...(parameter ? { parameter } : {}) });
  };

  if (node.type === "assignment" || node.type === "operator_assignment") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left) return declarations;
    // A destructuring assignment hands no target an expression of its own, so
    // every name in it is recorded as untypeable rather than given the whole
    // right-hand side's type.
    if (left.type === "left_assignment_list") {
      declare(left);
      return declarations;
    }
    declare(left, right, true);
    return declarations;
  }
  if (node.type === "method_parameters" || node.type === "block_parameters" || node.type === "lambda_parameters") {
    for (const p of node.namedChildren) {
      const target = p.type === "identifier" || p.type === "destructured_parameter" ? p : (p.childForFieldName("name") ?? p);
      declare(target, p.childForFieldName("value"), false,
        node.type === "method_parameters" && p.type === "keyword_parameter" ? target.text : undefined);
    }
    return declarations;
  }
  // `rescue Foo => e` — `e` is a local for the rest of the clause, and it is the
  // single most common untypeable receiver in a Rails app (`e.message`).
  if (node.type === "exception_variable") {
    const first = node.namedChildren[0];
    if (first) declare(first);
    return declarations;
  }
  // `for x in list` — the only Ruby loop that introduces a name without an
  // assignment or a parameter list.
  if (node.type === "for") {
    const first = node.namedChildren[0];
    if (first) declare(first);
    return declarations;
  }
  // Ruby 3 pattern matching binds names too: `in {user: User => u}` makes `u` a
  // local, and `u.name` would otherwise read as a call on the enclosing class
  // through the receiver position extract.ts now accepts. Every identifier
  // directly under a pattern node is a binding — over-approximating here costs at
  // most a missed edge, while under-approximating costs a wrong one.
  if (["match_pattern", "test_pattern", "in_clause"].includes(node.type)) {
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type === "identifier") declare(pattern);
  }
  if (RUBY_PATTERN_NODES.has(node.type)) {
    for (const child of node.namedChildren) if (child.type === "identifier" || RUBY_NAMED_BINDING_PARAMETERS.has(child.type)) declare(child);
    const named = node.childForFieldName("name");
    if (named?.type === "identifier") declare(named);
    // `{dispatcher:}` binds a local despite having only a hash_key_symbol in
    // the tree. It must invalidate an earlier keyword just like `=> dispatcher`.
    const key = node.childForFieldName("key");
    if (node.type === "keyword_pattern" && key?.type === "hash_key_symbol" && node.namedChildren.length === 1) {
      declarations.push({ target: key, name: key.text, value: null, assignment: false });
    }
  }
  return declarations;
}

function handleRuby(node: Parser.SyntaxNode, ctx: RubyTypeCtx, bindings: FileBindings): void {
  for (const declaration of rubyBindingDeclarations(node)) {
    const { name, target, value, assignment } = declaration;
    const key = rubyScopeKey(name, ctx.scope, ctx.classScope, ctx.selfKind);
    const at = name.startsWith("@") || name.startsWith("$") ? RUBY_ALWAYS_BOUND : node.startIndex;
    let type = assignment && value && target.type !== "global_variable" ? rubyExprType(value, ctx) : null;
    // A method parameter the author typed. Splat, double-splat and block parameters
    // are excluded by construction — their parent is the wrapper, not the list — since
    // `*args` is an Array whatever its tag says about the elements.
    if (!assignment && node.type === "method_parameters" &&
        (node.parent?.type === "method" || node.parent?.type === "singleton_method") &&
        ["method_parameters", "optional_parameter", "keyword_parameter"].includes(target.parent?.type ?? "")) {
      const core = rubyYardCoreType(node.parent, "param", name);
      // Not a collection. `@param tool_calls [Array<ToolCall>]` is already evidence
      // for something narrower — what `self` is inside a block mapped over it — and
      // that reading requires the parameter to stay untyped. Typing it Array cost
      // exactly those 2 ruby_injection edges on dailywerk and bought nothing, since
      // the repository patches no collection class.
      if (core && core !== "Array" && core !== "Hash") type = { fqn: core, kind: "instance" };
    }
    bindings.noteRubyVar(key, name, type, at);
  }
}

/** Ruby 3 `case/in` pattern nodes, whose bare identifiers are BINDINGS. */
const RUBY_PATTERN_NODES: ReadonlySet<string> = new Set([
  "array_pattern",
  "find_pattern",
  "hash_pattern",
  "keyword_pattern",
  "as_pattern",
  "alternative_pattern",
]);

/** The scope segment a Swift definition pushes, mirroring extract.ts's
 * `describeSwift` (duplicated, not imported, per this file's
 * no-value-import-of-extract rule): types and extensions push the type's name
 * (an extension is named after the type it extends), functions their own name,
 * and an `init` the enclosing type's name — extract.ts names initializers after
 * their type, so the two scope stacks stay in lockstep inside an init body.
 * Typealias and top-level properties DO mint nodes in extract.ts but are
 * deliberately absent here: neither has a body a binding could be set in (a
 * property initializer's closure is the one vanishing exception, mis-keying
 * only bindings set inside itself). */
function swiftDefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "class_declaration") {
    if (node.children.some((c) => c.type === "extension")) {
      const ut = node.namedChildren.find((c) => c.type === "user_type");
      const ids = ut?.namedChildren.filter((c) => c.type === "type_identifier") ?? [];
      return ids.at(-1)?.text ?? null;
    }
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "protocol_declaration") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
    return node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  }
  if (node.type === "init_declaration") {
    const owner = node.parent?.parent; // class_body / protocol_body → the declaration
    return owner ? swiftDefName(owner) : null;
  }
  return null;
}

const R_ASSIGN_OPS = new Set(["<-", "<<-", "="]);
const R_RIGHT_ASSIGN_OPS = new Set(["->", "->>"]);

/**
 * The bare name a `binary_operator` (left-assign) or `function_definition`
 * (right-assign) node defines, for R's two plain-function assignment shapes —
 * this file's own `defName` uses it directly. extract.ts's `describeR`
 * duplicates the same op-filtering check rather than importing this (same
 * reasoning as the Go receiver helpers below: bindings.ts can't take a value
 * import back on extract.ts), and additionally needs to distinguish an S3
 * `generic.Class` method and R6/S4 class/method shapes this function doesn't
 * know about — bindings.ts has no equivalent need since no `handleR` binding
 * collector exists yet (R6/S4/S3 don't get a member/receiver-type table in
 * this pass; `self`/`private` resolve directly via `ctx.enclosingClass`
 * instead, needing no lookup). See `describeR`'s doc comment for why
 * right-assign's AST shape needs its own branch rather than mirroring
 * left-assign's (empirically, not assumed — `->`'s low precedence means it's
 * absorbed into the function's own `body` field, not an outer wrapper).
 * Null if `node` isn't one of these two shapes.
 */
export function rDefName(node: Parser.SyntaxNode): string | null {
  if (node.type === "binary_operator") {
    const op = node.childForFieldName("operator")?.text;
    if (!op || !R_ASSIGN_OPS.has(op)) return null;
    const lhs = node.childForFieldName("lhs");
    const rhs = node.childForFieldName("rhs");
    return lhs?.type === "identifier" && rhs?.type === "function_definition" ? lhs.text : null;
  }
  if (node.type === "function_definition") {
    const body = node.childForFieldName("body");
    if (body?.type !== "binary_operator") return null;
    const op = body.childForFieldName("operator")?.text;
    if (!op || !R_RIGHT_ASSIGN_OPS.has(op)) return null;
    const rhs = body.childForFieldName("rhs");
    return rhs?.type === "identifier" ? rhs.text : null;
  }
  return null;
}

/** The receiver parameter's own variable name for a Go method (`func (w *Worker) …`
 * → `w`). Null if it can't be read. */
export function goReceiverVarOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  return param?.childForFieldName("name")?.text ?? null;
}

/** The receiver's base type name for a Go method, unwrapping a pointer receiver
 * (`func (w *Worker) …` → `Worker`). Mirrors extract.ts's own `goReceiverType`
 * (duplicated, not imported, per this file's no-value-import-of-extract rule).
 * Null if it can't be read. */
function goReceiverTypeOf(node: Parser.SyntaxNode): string | null {
  const recv = node.childForFieldName("receiver");
  const param = recv?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
  return type?.type === "type_identifier" ? type.text : null;
}

/** Unwraps a C++ declarator through pointer/reference wrapping (`int* p`, `int& r`)
 * down to the innermost concrete declarator — a `function_declarator` for a
 * function/method, or a bare name node (`field_identifier`/`identifier`) for a
 * plain variable/field. `reference_declarator` carries its inner declarator as an
 * anonymous first child (no field), unlike `pointer_declarator`'s `declarator`
 * field, so the two branches unwrap differently. Null if the chain bottoms out. */
function unwrapCppDeclarator(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node ?? null;
  while (cur && (cur.type === "pointer_declarator" || cur.type === "reference_declarator")) {
    cur = cur.type === "pointer_declarator" ? cur.childForFieldName("declarator") : (cur.namedChildren[0] ?? null);
  }
  return cur;
}

/** Recursively resolves a (possibly nested) `qualified_identifier`'s innermost name
 * node and immediate scope text — e.g. `ns::Foo::bar` -> `{ scope: "Foo", nameNode: bar }`.
 * Nesting arises from namespace-qualified out-of-class definitions (`void ns::Foo::bar()`);
 * the innermost scope is the one that matters (the actual owning class), not the outer
 * namespace, so recursion always keeps the deepest level. */
export function resolveCppQualified(node: Parser.SyntaxNode): { scope: string | null; nameNode: Parser.SyntaxNode } {
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (name?.type === "qualified_identifier") return resolveCppQualified(name);
  return { scope: scope ? stripCppTemplateArgs(scope.text) : null, nameNode: name ?? node };
}

/** Strips trailing `<...>` template arguments from a scope/base-class name
 * (`Foo<T>` -> `Foo`) so it matches the plain name the class node itself carries.
 * v1 doesn't model template specialization identity — see the plan's known gaps. */
export function stripCppTemplateArgs(text: string): string {
  const i = text.indexOf("<");
  return i === -1 ? text : text.slice(0, i);
}

/** The bare name + owning-class scope (non-null only for an out-of-class definition,
 * e.g. `Foo::bar`) for a C++ function-like declarator — the `declarator` field of a
 * `function_definition`. Shared by extract.ts's `describeCpp` (the node's own name/kind)
 * and this file's `defName` (the scope-stack segment), so the two can never drift on
 * how a declarator is unwrapped — unlike the Go receiver helpers, which duplicate
 * across the two files per this file's own no-value-import-of-extract rule, this one
 * only flows extract.ts -> bindings.ts, the direction that's already a value import. */
export function cppDeclaratorName(declarator: Parser.SyntaxNode): { name: string; scope: string | null } | null {
  const fnDecl = unwrapCppDeclarator(declarator);
  if (!fnDecl || fnDecl.type !== "function_declarator") return null;
  const inner = fnDecl.childForFieldName("declarator");
  if (!inner) return null;
  if (inner.type === "qualified_identifier") {
    const { scope, nameNode } = resolveCppQualified(inner);
    return nameNode.text ? { name: nameNode.text, scope } : null;
  }
  if (
    inner.type === "identifier" ||
    inner.type === "field_identifier" ||
    inner.type === "destructor_name" ||
    inner.type === "operator_name"
  ) {
    return inner.text ? { name: inner.text, scope: null } : null;
  }
  return null;
}

/** Resolves a call site's receiver text (from `calleeName`) to a bound type
 * name, given the enclosing walk state. `self`/`cls`/`this`/the Go receiver
 * var resolve directly to the enclosing class; `super` — R6's `super$` and
 * Swift's `super.` alike — resolves to the PARENT class instead
 * (`ctx.rSuperClass`, not `ctx.enclosingClass` — a super call must climb past
 * the current class's own same-named override, not find it); anything else is
 * a bindings-map lookup, normalizing `this.` to `self.` since both are stored
 * the same way. */
export function resolveRecvType(
  receiver: string | undefined,
  ctx: Pick<WalkCtx, "scope" | "enclosingClass" | "goReceiverVar" | "lang" | "bindings" | "rSuperClass">,
): string | undefined {
  if (!receiver) return undefined;
  if (receiver === "self" || receiver === "cls" || receiver === "this") return ctx.enclosingClass ?? undefined;
  if (receiver === "super") return ctx.rSuperClass ?? undefined;
  if (receiver.startsWith("self.") || receiver.startsWith("this.")) {
    return (
      ctx.bindings.lookup(ctx.scope, receiver) ??
      ctx.bindings.lookup(ctx.scope, receiver.replace(/^this\./, "self.")) ??
      undefined
    );
  }
  // PHP static call `Foo::bar()`: the scope operand is a class name, so it *is*
  // the receiver type. (Member calls pass a `$var` receiver, filtered by the `$`.)
  if (ctx.lang === "php" && !receiver.startsWith("$")) return receiver;
  return (
    (ctx.lang === "go" && receiver === ctx.goReceiverVar ? ctx.enclosingClass : undefined) ??
    ctx.bindings.lookup(ctx.scope, receiver) ??
    // Swift type-member call `Animal.staticThing()`: an uppercase receiver with no
    // local binding is the type itself (Swift naming: types are UpperCamelCase,
    // values lowerCamelCase — and a shadowing binding was already tried above).
    (ctx.lang === "swift" && /^[A-Z]/.test(receiver) ? receiver : undefined) ??
    undefined
  );
}

function isClassNode(node: Parser.SyntaxNode, lang: Language): boolean {
  if (lang === "python") return node.type === "class_definition";
  if (lang === "cpp") return node.type === "class_specifier" || node.type === "struct_specifier";
  if (lang === "java") return JAVA_TYPE_DECLS.has(node.type);
  if (lang === "typescript" || lang === "tsx") {
    return node.type === "class_declaration" || node.type === "abstract_class_declaration";
  }
  // Swift: class_declaration covers class/struct/enum/actor/extension — all can
  // hold members whose `self.field` bindings live at the type's scope.
  if (lang === "swift") {
    return node.type === "class_declaration" || node.type === "protocol_declaration";
  }
  // Ruby: a module owns instance variables exactly as a class does — it is mixed
  // into something that has them — so both open the scope `@ivar` is filed at. A
  // `class_methods do` block is the module Rails generates, and opens one too.
  if (lang === "ruby") {
    return node.type === "class" || node.type === "module" || (node.type === "call" && rubyIsClassMethodsBlock(node));
  }
  return false;
}

/** Java declarations that push a scope segment — mirrors extract.ts's JAVA_KINDS. */
const JAVA_DEF_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
  "annotation_type_element_declaration",
  "method_declaration",
  "constructor_declaration",
]);

/** The subset of the above that owns `this.field` bindings. */
const JAVA_TYPE_DECLS: ReadonlySet<string> = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

/** Pass 1 over a parsed file: collect variable->type bindings. Pure. */
export function collectBindings(root: Parser.SyntaxNode, lang: Language, rails = false): FileBindings {
  const bindings = new FileBindings();
  const aliases = new Map<string, string>();
  collectAliases(root, lang, aliases);
  visit(root, lang, [], null, bindings, aliases, "instance", false, rails);
  // Ruby's bindings are agreed on across the whole file, not at the point of
  // assignment — a second, contradicting write anywhere in the same scope has to
  // be able to withdraw the first one. See `FileBindings.finalizeRuby`.
  if (lang === "ruby") bindings.finalizeRuby();
  return bindings;
}

/** Import aliases (`... as F`) can be declared anywhere relative to their use
 * textually, so this scans the whole tree once, ahead of the scope-aware walk. */
function collectAliases(node: Parser.SyntaxNode, lang: Language, aliases: Map<string, string>): void {
  if (lang === "python" && node.type === "aliased_import") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) {
      const orig = nameNode.type === "dotted_name" ? (nameNode.namedChildren.at(-1)?.text ?? nameNode.text) : nameNode.text;
      aliases.set(aliasNode.text, orig);
    }
  } else if ((lang === "typescript" || lang === "tsx") && node.type === "import_specifier") {
    const nameNode = node.childForFieldName("name");
    const aliasNode = node.childForFieldName("alias");
    if (nameNode && aliasNode) aliases.set(aliasNode.text, nameNode.text);
  }
  for (const child of node.namedChildren) collectAliases(child, lang, aliases);
}

/** `scope`/`classScope` mirror extract.ts's walk: `scope` is the enclosing
 * definition-name stack; `classScope` is the nearest enclosing class's scope
 * path (distinct from `scope` once we're inside one of its methods) — that's
 * where `self.attr`/`this.attr` bindings live. */
function visit(
  node: Parser.SyntaxNode,
  lang: Language,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
  selfKind: RubySelfContext,
  inSingletonClass: boolean,
  rails: boolean,
  rubyLexicalScope: string[] = [],
): void {
  if (lang === "ruby") {
    if (node.type === "class" || node.type === "module") scope = rubyLexicalScope;
    const factory = rubyNamedClassFactory(node);
    if (factory) {
      const ownScope = [...rubyLexicalScope, factory.name];
      for (const child of factory.block?.namedChildren ?? []) {
        visit(child, lang, ownScope, ownScope.join("."), bindings, aliases, "class", false, rails, rubyLexicalScope);
      }
      return;
    }
    if (rubyUnknownFactoryBlock(node)) return;
  }
  if (lang === "python") handlePy(node, scope, classScope, bindings, aliases);
  else if (lang === "go") handleGo(node, scope, bindings);
  else if (lang === "cpp") handleCpp(node, scope, classScope, bindings, aliases);
  // R has no member/receiver-type binding table — self/private/super resolve
  // directly via ctx.enclosingClass/ctx.rSuperClass instead (see extract.ts's
  // calleeName R branch) — so no handleR is needed here.
  else if (lang === "r") void 0;
  else if (lang === "ruby") handleRuby(node, { scope, classScope, selfKind, rails }, bindings);
  else if (lang === "java") handleJava(node, scope, classScope, bindings);
  else if (lang === "swift") handleSwift(node, scope, classScope, bindings);
  else if (lang === "php") handlePhp(node, scope, bindings);
  else handleTs(node, scope, classScope, bindings, aliases);

  const name = defName(node, lang, rails);
  let childScope = scope;
  let childClassScope = classScope;
  if (name !== null) {
    childScope = [...scope, name];
    if (isClassNode(node, lang)) childClassScope = childScope.join(".");
  }
  // Ruby: which object `self` is below this node, which is what decides whether an
  // `@ivar` here is the class object's slot or an instance's. A class/module body is
  // the class object; `def self.x` and everything inside `class << self` likewise;
  // an ordinary `def` is an instance — unless it sits directly in a `class << self`,
  // which is exactly how that form declares class methods.
  let childSelf = selfKind;
  let childInSingleton = inSingletonClass;
  if (lang === "ruby") {
    if (node.type === "class" || node.type === "module") { childSelf = "class"; childInSingleton = false; }
    else if (node.type === "singleton_class") { childSelf = "class"; childInSingleton = true; }
    else if (node.type === "singleton_method") { childSelf = "class"; childInSingleton = false; }
    else if (node.type === "method") { childSelf = inSingletonClass ? "class" : "instance"; childInSingleton = false; }
    // A block written in a class body re-binds `self` in ways only its caller knows.
    // Purely syntactic, and identical in extract.ts's walk — the two must agree on
    // the slot an `@ivar` here is filed under. See `RubySelfContext`.
    // A concern's `class_methods do` is the one block whose `self` IS known: the
    // includer class. `inSingletonClass` carries that to the `def`s inside it,
    // exactly as `class << self` does.
    else if (node.type === "call" && rubyIsClassMethodsBlock(node)) { childSelf = "class"; childInSingleton = true; }
    else {
      childSelf = rubyBlockSelfContext(node, selfKind);
      childClassScope = rubyBlockClassScope(node, childClassScope);
    }
  }
  if (lang === "ruby" && (node.type === "method" || node.type === "singleton_method") && name !== null) {
    bindings.noteRubyMethodScope(childScope.join("."));
  }
  for (const child of node.namedChildren) {
    visit(child, lang, childScope, childClassScope, bindings, aliases, childSelf, childInSingleton, rails,
      lang === "ruby" && (node.type === "class" || node.type === "module") ? childScope : rubyLexicalScope);
  }
}

/** Resolves a bare type name through `aliases` — every annotation path must
 * consult it, so an aliased import (`import Foo as Bar`) still binds to the
 * original name callers actually search for. See the "aliases already
 * resolved" contract above. */
function resolveAlias(name: string, aliases: Map<string, string>): string {
  return aliases.get(name) ?? name;
}

function pyTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === "identifier") return resolveAlias(node.text, aliases);
  if (node.type === "type") {
    const inner = node.namedChildren[0];
    return inner?.type === "identifier" ? resolveAlias(inner.text, aliases) : null;
  }
  return null;
}

function callTypeName(node: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (node?.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "identifier") return null;
  return aliases.get(fn.text) ?? fn.text;
}

/** Swift variable->type bindings from the confident, syntax-local clues:
 * a typed parameter (`func feed(animal: Animal)`, `init(keeper k: Keeper)` —
 * the LAST simple_identifier before the `:` is the local name, the first may be
 * an external argument label), a typed property (`var d: Doctor`), and an
 * initializer-call assignment (`let vet = Vet()` — an initializer call is an
 * ordinary call whose callee is the type's own UpperCamelCase name; Swift's
 * naming convention makes the case split reliable, the same way Go's `NewX`
 * convention is trusted in handleGo). A property directly inside a type body is
 * a field: bound at the type's scope, both bare (`repo.save()`) and
 * `self.`-prefixed (`self.repo.save()`), like Java's fields. */
function handleSwift(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
): void {
  const scopePath = scope.join(".");
  if (node.type === "parameter") {
    const ids = node.namedChildren.filter((c) => c.type === "simple_identifier");
    const name = ids.at(-1)?.text;
    const type = swiftTypeName(
      node.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type"),
    );
    if (name && type) bindings.set(scopePath, name, type);
    return;
  }
  if (node.type !== "property_declaration") return;
  const name = node.namedChildren
    .find((c) => c.type === "pattern")
    ?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
  if (!name) return;
  const annotated = node.namedChildren
    .find((c) => c.type === "type_annotation")
    ?.namedChildren.find((c) => c.type === "user_type" || c.type === "optional_type");
  const type =
    swiftTypeName(annotated) ??
    swiftCtorTypeName(node.namedChildren.find((c) => c.type === "call_expression"));
  if (!type) return;
  const isField = node.parent?.type === "class_body" || node.parent?.type === "protocol_body";
  const target = isField ? (classScope ?? scopePath) : scopePath;
  bindings.set(target, name, type);
  if (isField) bindings.set(target, `self.${name}`, type);
}

/** A Swift type node's bare name: a `user_type`'s LAST type_identifier (so a
 * module-qualified `Foundation.Date` binds as `Date`, generic arguments live in
 * nested nodes and never leak in), unwrapping one level of optional (`Animal?`).
 * Collections, tuples, and function types bind nothing — no single confident
 * receiver type to name. */
function swiftTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "optional_type") {
    return swiftTypeName(node.namedChildren.find((c) => c.type === "user_type"));
  }
  if (node.type !== "user_type") return null;
  const ids = node.namedChildren.filter((c) => c.type === "type_identifier");
  return ids.at(-1)?.text ?? null;
}

/** The type constructed by an initializer call (`Vet()` → `Vet`), or null when
 * the callee isn't a bare UpperCamelCase name — a lowercase callee is an
 * ordinary function whose return type a single-file pass cannot know. */
function swiftCtorTypeName(call: Parser.SyntaxNode | null | undefined): string | null {
  if (call?.type !== "call_expression") return null;
  const fn = call.namedChildren[0];
  if (fn?.type !== "simple_identifier") return null;
  return /^[A-Z]/.test(fn.text) ? fn.text : null;
}

/** PHP variable->type bindings from the two confident, syntax-local clues:
 * a type-hinted parameter (`function f(Foo $x)`) and a `new` assignment
 * (`$x = new Foo()`). Keyed by the `$var` text (with the `$`) so a
 * `$var->method()` call site resolves through resolveRecvType's bindings
 * lookup, exactly like Python's annotated params and Go's receiver. */
function handlePhp(node: Parser.SyntaxNode, scope: string[], bindings: FileBindings): void {
  if (node.type === "simple_parameter") {
    const type = phpTypeName(node.childForFieldName("type"));
    const name = node.childForFieldName("name");
    if (type && name?.type === "variable_name") bindings.set(scope.join("."), name.text, type);
    return;
  }
  if (node.type === "assignment_expression") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left?.type === "variable_name" && right?.type === "object_creation_expression") {
      const type = phpNewType(right);
      if (type) bindings.set(scope.join("."), left.text, type);
    }
  }
}

/** Closure name, duplicated from extract.ts's `phpClosureName` (this file must
 * not value-import extract.ts) so the two scope stacks agree on the segment a
 * closure pushes. The right-hand-side check compares node `.id` rather than
 * `===` on wrappers for the same reason as extract.ts: wrapper identity is not
 * stable across traversals, so `===` can spuriously fall through to `{closure}`
 * and desync this scope segment from the one extract.ts mints. */
function phpClosureName(node: Parser.SyntaxNode): string {
  const parent = node.parent;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === node.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "variable_name") return left.text.replace(/^\$/, "");
  }
  return "{closure}";
}

/** A PHP type hint's class name: unwrap `?T` (optional_type) and `named_type`,
 * de-qualify a namespaced name to its trailing segment. Null for primitives,
 * unions, and intersections (no single confident class to bind). */
function phpTypeName(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "named_type" || node.type === "optional_type") {
    return phpTypeName(node.namedChildren[0] ?? null);
  }
  if (node.type === "name") return node.text;
  if (node.type === "qualified_name") return node.text.replace(/^.*\\/, "");
  return null;
}

/** The class name of a `new Foo()` / `new App\Foo()`, de-qualified. */
function phpNewType(node: Parser.SyntaxNode): string | null {
  const cls = node.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  return cls ? cls.text.replace(/^.*\\/, "") : null;
}

function handlePy(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "typed_parameter") {
    const nameNode = node.namedChildren.find((c) => c.type === "identifier");
    const typeName = pyTypeName(node.childForFieldName("type"), aliases);
    if (nameNode && typeName) bindings.set(scopePath, nameNode.text, typeName);
    return;
  }
  if (node.type !== "assignment") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return;
  if (left.type === "identifier") {
    const typeField = node.childForFieldName("type");
    const typeName = typeField ? pyTypeName(typeField, aliases) : callTypeName(right, aliases);
    if (typeName) bindings.set(scopePath, left.text, typeName);
  } else if (left.type === "attribute") {
    const obj = left.childForFieldName("object");
    const attr = left.childForFieldName("attribute");
    if (obj?.type === "identifier" && (obj.text === "self" || obj.text === "cls") && attr) {
      const typeName = callTypeName(right, aliases);
      if (typeName) bindings.set(classScope ?? scopePath, `self.${attr.text}`, typeName);
    }
  }
}

function tsAnnotationTypeName(
  typeAnn: Parser.SyntaxNode | null | undefined,
  aliases: Map<string, string>,
): string | null {
  if (!typeAnn || typeAnn.type !== "type_annotation") return null;
  const t = typeAnn.namedChildren[0];
  return t?.type === "type_identifier" ? resolveAlias(t.text, aliases) : null;
}

function tsNewTypeName(value: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (value?.type !== "new_expression") return null;
  const ctor = value.childForFieldName("constructor");
  if (ctor?.type !== "identifier") return null;
  return aliases.get(ctor.text) ?? ctor.text;
}

function handleTs(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  const scopePath = scope.join(".");
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && FN_VALUE_TYPES.has(value.type)) return; // a function def, not a type binding
    const name = node.childForFieldName("name");
    if (name?.type !== "identifier") return;
    const typeName = tsNewTypeName(value, aliases) ?? tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (typeName) bindings.set(scopePath, name.text, typeName);
  } else if (node.type === "public_field_definition") {
    const name = node.childForFieldName("name");
    if (!name) return;
    const typeName =
      tsAnnotationTypeName(node.childForFieldName("type"), aliases) ??
      tsNewTypeName(node.childForFieldName("value"), aliases);
    if (typeName) bindings.set(classScope ?? scopePath, `this.${name.text}`, typeName);
  } else if (node.type === "required_parameter") {
    const pattern = node.childForFieldName("pattern");
    if (pattern?.type !== "identifier") return;
    const typeName = tsAnnotationTypeName(node.childForFieldName("type"), aliases);
    if (!typeName) return;
    bindings.set(scopePath, pattern.text, typeName);
    // A parameter PROPERTY (`constructor(private readonly svc: Svc){}`) is a parameter
    // AND a class field, so `this.svc` must resolve to its type — the default DI idiom
    // in NestJS/Angular. The plain-parameter binding above keys on the bare name and at
    // the constructor scope, which `this.svc.method()` call sites never reach; without
    // the field-style binding here their recvType is undefined and the call edge is
    // dropped (#76). Detected by the modifier child a plain parameter never carries.
    const isParamProperty = node.children.some(
      (c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.type === "override_modifier",
    );
    if (isParamProperty) bindings.set(classScope ?? scopePath, `this.${pattern.text}`, typeName);
  }
}

/**
 * Java bindings: locals, parameters, and fields.
 *
 * Java looks like the easy case — it is statically typed, so a declaration states
 * its own type with no inference needed. In practice modern Java leans on `var`,
 * which carries no type at the declaration site. Upstream's documented limit was
 * that a `var` local's member calls stay unresolved; this pass recovers them by
 * falling back to a `new X()` initializer when the declared type is absent or
 * `var`, covering locals, fields, and try-with-resources the same way.
 *
 * Varargs (`String... xs`), try-with-resources (`try (Foo f = ...)`),
 * enhanced-for (`for (Foo x : xs)`), and catch parameters (`catch (E e)`) also
 * bind their names, so a member call on any of them resolves through the bound
 * type rather than falling back to name-only resolution.
 *
 * Fields are recorded twice: bare (`repo.save()`) and `self.`-prefixed
 * (`this.repo.save()`), since resolveRecvType normalizes `this.` to `self.`.
 */
function handleJava(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
): void {
  const scopePath = scope.join(".");

  // formal_parameter: `Foo bar` in method/constructor signatures
  if (node.type === "formal_parameter") {
    const type = javaTypeName(node.childForFieldName("type"));
    const name = node.childForFieldName("name");
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // spread_parameter (varargs): `Foo... args` — tree-sitter gives this a distinct
  // node type with no field names; the type is the first named child and the name
  // lives inside a `variable_declarator`.
  if (node.type === "spread_parameter") {
    const typeNode = node.namedChildren.find((c) => c.type !== "variable_declarator");
    const name = node.namedChildren.find((c) => c.type === "variable_declarator")?.childForFieldName("name");
    const type = javaTypeName(typeNode);
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // resource (try-with-resources): `try (Foo f = new Foo())` — the `resource` node
  // has `type`, `name`, and `value` fields, binding like a local. `var f = new Foo()`
  // falls back to the constructed type.
  if (node.type === "resource") {
    const name = node.childForFieldName("name");
    const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(node.childForFieldName("value"));
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // enhanced_for_statement: `for (Foo f : items)` — the loop variable `f` is typed
  // by the `type` field; bind it under the lexical scope so `f.method()` inside the
  // loop body resolves.
  if (node.type === "enhanced_for_statement") {
    const name = node.childForFieldName("name");
    const type = javaTypeName(node.childForFieldName("type"));
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  // catch_formal_parameter: `catch (Exception e)` — tree-sitter gives this a
  // distinct node type (not `formal_parameter`); the type lives in a `catch_type`
  // child (which holds one `type_identifier`, or several for multi-catch
  // `IOException | BizException` — bind the first).
  if (node.type === "catch_formal_parameter") {
    const name = node.childForFieldName("name");
    const catchType = node.namedChildren.find((c) => c.type === "catch_type");
    const typeNode = catchType?.namedChildren.find(
      (c) => c.type === "type_identifier" || c.type === "scoped_type_identifier" || c.type === "identifier",
    );
    const type = javaTypeName(typeNode);
    if (type && name?.type === "identifier") bindings.set(scopePath, name.text, type);
    return;
  }

  if (node.type !== "local_variable_declaration" && node.type !== "field_declaration") return;

  const isField = node.type === "field_declaration";
  const target = isField ? (classScope ?? scopePath) : scopePath;

  for (const d of node.namedChildren) {
    if (d.type !== "variable_declarator") continue;
    const name = d.childForFieldName("name");
    if (name?.type !== "identifier") continue;
    // Declared type first; fall back to a `new X()` initializer when the type is
    // absent or `var` (upstream's documented limit) — recovers the common
    // `var x = new Foo()` shape without guessing at call-return inference.
    const type = javaTypeName(node.childForFieldName("type")) ?? javaNewTypeName(d.childForFieldName("value"));
    if (!type) continue;
    bindings.set(target, name.text, type);
    if (isField) bindings.set(target, `self.${name.text}`, type);
  }
}

/** A Java type node's bare name. `var` is the inferred-local keyword and states no
 * type, so it binds nothing. A generic binds to its erasure (`List<Order>` → `List`),
 * a qualified type to its final segment (`java.util.List` → `List`), and an array
 * to its element type (`Foo[]` → `Foo`). */
function javaTypeName(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text === "var" ? null : node.text;
  if (node.type === "generic_type") {
    const base = node.namedChildren[0];
    return base ? javaTypeName(base) : null;
  }
  if (node.type === "scoped_type_identifier") {
    return node.namedChildren.at(-1)?.text ?? null;
  }
  if (node.type === "array_type") {
    const el = node.childForFieldName("element") ?? node.namedChildren.find((c) => c.type !== "dimensions");
    return el ? javaTypeName(el) : null;
  }
  return null;
}

/** The type constructed by a `new X(...)` expression, or null when the value is
 * not an `object_creation_expression` (or the constructed type isn't a bare
 * `type_identifier`/`scoped_type_identifier`/`generic_type`). Used as the
 * fallback for a `var`-typed or untyped local/field/resource whose initializer
 * is a construction — the one shape a single-file pass can infer with no
 * return-type analysis. */
function javaNewTypeName(value: Parser.SyntaxNode | null | undefined): string | null {
  if (value?.type !== "object_creation_expression") return null;
  return javaTypeName(value.childForFieldName("type"));
}

function handleGo(node: Parser.SyntaxNode, scope: string[], bindings: FileBindings): void {
  const scopePath = scope.join(".");
  if (node.type === "var_spec") {
    const name = node.childForFieldName("name");
    let type = node.childForFieldName("type");
    if (type?.type === "pointer_type") type = type.namedChildren.at(-1) ?? null;
    if (name?.type === "identifier" && type?.type === "type_identifier") {
      bindings.set(scopePath, name.text, type.text);
    }
    return;
  }
  if (node.type !== "short_var_declaration") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left || !right) return;
  const names = left.namedChildren;
  const exprs = right.namedChildren;
  for (let i = 0; i < names.length; i++) {
    const nameNode = names[i];
    let expr = exprs[i];
    if (!nameNode || nameNode.type !== "identifier" || !expr) continue;
    if (expr.type === "unary_expression") {
      expr = expr.namedChildren.find((c) => c.type === "composite_literal") ?? expr;
    }
    let typeName: string | null = null;
    if (expr.type === "composite_literal") {
      const t = expr.childForFieldName("type");
      typeName = t?.type === "type_identifier" ? t.text : null;
    } else if (expr.type === "call_expression") {
      const fn = expr.childForFieldName("function");
      // Go convention: NewX(...) binds to X.
      if (fn?.type === "identifier" && /^New[A-Z]/.test(fn.text)) typeName = fn.text.slice(3);
    }
    if (typeName) bindings.set(scopePath, nameNode.text, typeName);
  }
}

/** A `field_declaration`'s bare type name — `type_identifier`/`qualified_identifier`
 * text directly, or a `template_type`'s own `name` field (`std::vector<Foo>` binds
 * as `std::vector`, `Box<T>` as `Box`). `primitive_type` and other built-ins return
 * null (nothing useful to bind a receiver to). */
function cppFieldTypeName(typeField: Parser.SyntaxNode | null | undefined, aliases: Map<string, string>): string | null {
  if (!typeField) return null;
  if (typeField.type === "type_identifier" || typeField.type === "qualified_identifier") {
    return resolveAlias(typeField.text, aliases);
  }
  if (typeField.type === "template_type") {
    const name = typeField.childForFieldName("name");
    return name ? resolveAlias(name.text, aliases) : null;
  }
  return null;
}

/** Member-variable type bindings: a `field_declaration` whose declarator unwraps to a
 * bare `field_identifier` (a data member, not a method prototype — those unwrap to a
 * `function_declarator` and are skipped) binds `this.<field>` -> its type, the same
 * purpose C#'s `handleCSharp` field-type collection serves — so `this->member.method()`
 * / `member.method()` call sites can resolve a receiver type. */
function handleCpp(
  node: Parser.SyntaxNode,
  scope: string[],
  classScope: string | null,
  bindings: FileBindings,
  aliases: Map<string, string>,
): void {
  if (node.type !== "field_declaration") return;
  const declarator = unwrapCppDeclarator(node.childForFieldName("declarator"));
  if (declarator?.type !== "field_identifier") return;
  const typeName = cppFieldTypeName(node.childForFieldName("type"), aliases);
  if (typeName) bindings.set(classScope ?? scope.join("."), `this.${declarator.text}`, typeName);
}
