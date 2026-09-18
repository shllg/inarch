# Writing an extension for your project

`docs/extensions.md` is the reference: the contract, the sandbox, the limits.
This guide covers the part the reference skips: **when an extension is the right
tool, why it has to be written the way it does, and how to build one step by step.**
The running example is a small extension that you can copy.

## Why extensions exist

inarch resolves what the **language** states. `Checkout.new.complete!` is a call to
`Checkout#complete!` because Ruby says so. The graph can prove that edge from the
source.

A large part of a real application's wiring is not stated by the language at all.
**Data** decides it:

- a string topic joins a publisher to its subscribers (`bus.publish("order.paid")`)
- a URL joins a frontend `fetch` to a controller action in another language
- a registry, a hash of handlers, or a config file picks a class at runtime
- a job name, a cron table or a queue decides what runs later
- a DSL your team wrote means something only your team defined

The core graph stops at these on purpose. When it cannot prove a target, the
correct output is no edge. inarch tells agents to trust its answers, and they act
on them. **A missing edge costs an agent one `grep`. A wrong edge costs a wrong
refactor.** So the core never guesses. A string that happens to match a class
name is not evidence.

Often you know more than the core can safely know. Your project guarantees
something: every handler is subscribed in one file, every route goes through one
client function. An extension is where you **state that convention and check it
against the source**. Then the graph can follow paths it would otherwise have to
leave blank.

## When to write one, and when not to

Write one when all of these hold:

1. **You can name the blind spot.** `inarch callers X` stops at a place where you
   know the path continues, and the continuation depends on a string, a table or a
   config value.
2. **The convention is enforced, not hoped for.** It is a rule your code follows
   everywhere, not a habit most files happen to share.
3. **Every edge can be checked from source.** You can point at the lines that prove
   each edge you emit.

Don't write one when:

- **The gap is a language feature.** If inarch misses a plain Ruby or TypeScript
  construct, fix it in the core or report it. Everyone benefits, and a core fix
  gets the core's own evaluation.
- **You would have to guess.** If the honest answer for some call sites is "it
  depends", those sites get no edge. An extension that fills the gap with a
  plausible answer is worse than no extension.
- **Only a running system knows the answer.** Extensions read source. They cannot
  observe traffic, a database or a feature flag.

## The one rule: decline, don't guess

Everything below follows from one rule. **When the evidence does not settle an
edge, emit nothing, and count the case.**

- If the topic is held in a variable, the site gets no edge.
- If the handler class is defined twice, it gets no edge.
- If the configuration no longer matches the code, it gets no edge.

This also sets how an extension should fail as the code changes. After a refactor
it should **lose** edges, not keep stale ones. An agent with no edge runs a
search. An agent with a stale edge edits the wrong method.

## Walkthrough: a string-keyed event bus

The application has a tiny publish/subscribe bus:

```ruby
# config/initializers/event_subscriptions.rb
Events::Bus.subscribe("order.paid", Billing::ReceiptMailer)
Events::Bus.subscribe("order.paid", Analytics::RevenueTracker)

# app/services/checkout.rb
class Checkout
  def complete!(order)
    Events::Bus.publish("order.paid", order)
  end
end

# app/handlers/billing/receipt_mailer.rb
module Billing
  class ReceiptMailer
    def call(order) = ...
  end
end
```

### 1. Find the blind spot

```sh
inarch callers complete! --direction out
```

The answer is `Events::Bus.publish` and nothing else. That is correct: the core
resolved the call it could see. Nothing in `checkout.rb` names `ReceiptMailer`.
The only link between the two ends is the string `"order.paid"`.

### 2. Write the convention down, including what you refuse

Before writing any code, write the rule in one paragraph:

> A call `Events::Bus.publish("<topic>", …)` with a **literal** topic dispatches to
> the `call` method of every class subscribed to `<topic>` in
> `config/initializers/event_subscriptions.rb`.

Then list every case the rule does not settle. These become the declines:

| case | why it declines |
|---|---|
| topic in a variable: `publish(topic, …)` | the topic is not known from source |
| handler class defined in two places | picking one would be a guess |
| `publish` outside any method | no symbol to attach the edge to |
| topic nobody subscribes to | nothing to point at, and worth knowing |
| commented-out line | not code |

If you cannot fill in this table, the convention is not ready to be an extension.

### 3. The package

An extension is an ES module in **its own directory**. Everything under that
directory is part of what gets approved. Keep the project-specific names in a
config file, so the code stays generic and the approval covers both.

```
tools/inarch/event-bus/
  extension.mjs
  extension.test.mjs
tools/inarch/event-bus.config.json
```

```json
{
  "eventBus": {
    "receiver": "Events::Bus",
    "subscriptions": ["config/initializers/event_subscriptions.rb"],
    "roots": ["app"],
    "handlerMethod": "call"
  }
}
```

The extension:

```js
// Joins `Events::Bus.publish("topic")` to every handler subscribed to "topic".
// Neither end names the other: the only link is a string. Core resolution sees a
// call to `publish` and stops there, correctly — this is project convention, not Ruby.
export default async function extend(ctx) {
  const { receiver, subscriptions, roots, handlerMethod = "call" } = ctx.config.eventBus ?? {};
  if (!receiver || !subscriptions?.length || !roots?.length) {
    ctx.log("eventBus: incomplete configuration, nothing emitted");
    return {};
  }
  const bus = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const SUBSCRIBE = new RegExp(`\\b${bus}\\.subscribe\\(\\s*(["'])([\\w.:-]+)\\1\\s*,\\s*((?:::)?[A-Z]\\w*(?:::[A-Z]\\w*)*)\\s*\\)`);
  const PUBLISH = new RegExp(`\\b${bus}\\.publish\\(\\s*(?:(["'])([\\w.:-]+)\\1|([^,)]+))`);
  const declined = {};
  const decline = (why) => { declined[why] = (declined[why] ?? 0) + 1; };

  // 1. Every node id in the core graph, so a handler constant can be checked for
  //    exactly one definition. Two definitions is a choice we must not make.
  const allNodes = Object.values(ctx.index.byPath).flat();
  const handlerNode = (constant) => {
    const suffix = `#${constant.replace(/^::/, "").replaceAll("::", ".")}.${handlerMethod}`;
    const hits = allNodes.filter((n) => n.id.endsWith(suffix));
    return hits.length === 1 ? hits[0] : null;
  };

  // 2. topic -> [{ node, where }], read from the subscription files only.
  const subscribers = new Map();
  for (const file of subscriptions) {
    const lines = (ctx.readFile(file) ?? "").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("#")) return;
      const m = SUBSCRIBE.exec(line);
      if (!m) return;
      const node = handlerNode(m[3]);
      if (!node) return decline("handler-not-unique");
      const list = subscribers.get(m[2]) ?? [];
      list.push({ node, constant: m[3], where: `${file}:${i + 1}` });
      subscribers.set(m[2], list);
    });
  }

  // 3. Every publish site under the configured roots.
  const edges = [];
  for (const root of roots) {
    for (const file of ctx.listFiles(root)) {
      if (!file.endsWith(".rb")) continue;
      (ctx.readFile(file) ?? "").split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("#")) return;
        const m = PUBLISH.exec(line);
        if (!m) return;
        if (!m[2]) return decline("topic-not-literal");
        const from = ctx.index.enclosing(file, i + 1);
        if (!from) return decline("publish-outside-a-definition");
        const targets = subscribers.get(m[2]);
        if (!targets) return decline("topic-without-subscribers");
        for (const t of targets) {
          edges.push({
            source: from.id,
            target: t.node.id,
            relation: "dispatches",
            via: `${receiver} "${m[2]}" -> ${t.constant}#${handlerMethod} (subscribed ${t.where})`,
          });
        }
      });
    }
  }
  ctx.log(`eventBus: ${edges.length} edges; declined ${JSON.stringify(declined)}`);
  return { edges };
}
```

It reads only three things from the host:
- `ctx.readFile` and `ctx.listFiles` give it the source.
- `ctx.index.byPath` holds the core graph's symbols, so it can check that a handler
  exists exactly once.
- `ctx.index.enclosing(path, line)` finds the method a line belongs to.

It returns edges between **existing** node ids. The host rejects the whole
contribution if one endpoint does not exist.

This example matches source with regular expressions because the syntax it looks
for is narrow and line-shaped. For anything wider, use a real parser.
`extensions/rails-seam/` bundles the TypeScript compiler and tree-sitter for that
reason.

### 4. Choose the weakest relation that is still true

The relation tells an agent how much to trust the edge. Pick the one that claims
no more than you proved:

| relation | use it for |
|---|---|
| `calls` | a direct call you could prove. Cannot cross a language boundary. |
| `dispatches` | a target that **may** run at runtime, chosen from data |
| `enqueues` | work handed off to run later: a job, a queue, a cron entry |
| `serves` | a request or route joined to the handler that answers it, including across languages |
| `renders` | a template or component rendered by name |
| `references` | a use that is not a call |

A publish reaches its subscribers through the bus, and the bus could skip a
handler, rescue an error, or run conditionally. So this example emits
`dispatches`, not `calls`.

### 5. Make `via` the proof

`via` is a short string stored on each edge, and agents read it before acting. Put
in it the evidence someone would need to check the edge by hand:

```
Events::Bus "order.paid" -> Billing::ReceiptMailer#call (subscribed config/initializers/event_subscriptions.rb:1)
```

An edge that carries the file and line of its evidence can be checked in a few
seconds. An edge with no evidence has to be either trusted or rederived.

### 6. Test it without inarch

The extension is a plain function of `ctx`. You can test it with `node --test` and
a fake context, with no graph build and no approval. Test the declines as
carefully as the edges, because the declines are the precision.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import extend from "./extension.mjs";

// A fake context: just enough of the host's API for this extension.
function context(files, nodes) {
  const byPath = {};
  for (const n of nodes) (byPath[n.id.split("#")[0]] ??= []).push(n);
  return {
    repoRoot: "/repo",
    config: { eventBus: { receiver: "Events::Bus", subscriptions: ["config/subs.rb"], roots: ["app"] } },
    index: {
      byPath,
      has: (id) => nodes.some((n) => n.id === id),
      enclosing: (path, line) =>
        (byPath[path] ?? []).filter((n) => n.kind !== "file" && n.startLine <= line && line <= n.endLine)
          .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] ?? null,
    },
    readFile: (path) => files[path] ?? null,
    listFiles: (root = ".") => Object.keys(files).filter((f) => root === "." || f.startsWith(root + "/")).sort(),
    log: () => {},
  };
}

const HANDLER = { id: "app/h/mailer.rb#Mailer.call", name: "call", kind: "method", startLine: 2, endLine: 2 };
const PUBLISHER = { id: "app/checkout.rb#Checkout.run", name: "run", kind: "method", startLine: 2, endLine: 4 };

test("a literal topic reaches its subscriber", async () => {
  const ctx = context(
    { "config/subs.rb": `Events::Bus.subscribe("paid", Mailer)`,
      "app/checkout.rb": `class Checkout\n  def run\n    Events::Bus.publish("paid", 1)\n  end\nend` },
    [HANDLER, PUBLISHER],
  );
  const { edges } = await extend(ctx);
  assert.deepEqual(edges.map((e) => [e.source, e.target, e.relation]),
    [[PUBLISHER.id, HANDLER.id, "dispatches"]]);
});

test("a topic held in a variable declines", async () => {
  const ctx = context(
    { "config/subs.rb": `Events::Bus.subscribe("paid", Mailer)`,
      "app/checkout.rb": `class Checkout\n  def run\n    Events::Bus.publish(topic, 1)\n  end\nend` },
    [HANDLER, PUBLISHER],
  );
  assert.deepEqual((await extend(ctx)).edges, []);
});

test("a handler defined twice declines", async () => {
  const twin = { ...HANDLER, id: "app/h/other.rb#Mailer.call" };
  const ctx = context(
    { "config/subs.rb": `Events::Bus.subscribe("paid", Mailer)`,
      "app/checkout.rb": `class Checkout\n  def run\n    Events::Bus.publish("paid", 1)\n  end\nend` },
    [HANDLER, twin, PUBLISHER],
  );
  assert.deepEqual((await extend(ctx)).edges, []);
});
```

```sh
node --test tools/inarch/event-bus/
```

### 7. Approve, build, query

```sh
inarch ext allow tools/inarch/event-bus/extension.mjs . --config tools/inarch/event-bus.config.json
inarch build .
```

The build reports what the extension did, including what it refused:

```
  extension 217465757353: ok, 0 nodes, 2 edges (214ms)
  [extension] eventBus: 2 edges; declined {"topic-not-literal":1}
```

Now the path the core had to leave blank is there, in both directions:

```sh
inarch callers complete! --direction out --json
#   calls        app/events/bus.rb#Events.Bus.publish
#   dispatches   app/handlers/analytics/revenue_tracker.rb#Analytics.RevenueTracker.call
#   dispatches   app/handlers/billing/receipt_mailer.rb#Billing.ReceiptMailer.call

inarch callers call --in app/handlers/billing/receipt_mailer.rb --json
#   app/services/checkout.rb#Checkout.complete!
#     via: Events::Bus "order.paid" -> Billing::ReceiptMailer#call (subscribed …:1)
```

Every addition carries `origin: "extension"` and `confidence: "extension"`, so an
agent can tell it apart from what the core proved.

### 8. Live with the approval

Approval covers the package's exact bytes and its configuration. **Edit any file
in the package, and the approval stops applying:**

```
$ inarch ext list .
2174…  changed  …/event-bus/extension.mjs — package changed; run inarch ext allow again
$ inarch build .
  extension 217465757353: skipped, 0 nodes, 0 edges (1ms)
$ inarch check .
graph check: DEGRADED
extension coverage incomplete: 217465757353: unapproved-changed; …
```

The extension's edges are removed, not carried forward from the last good run.
Review the change, then run `ext allow` again.

## Why it works this way

Each constraint below feels like friction the first time. Each one exists because
of what goes wrong without it.

- **Approval, not configuration.** An extension is code that runs on your machine
  during every build. A committed `.inarch/config.json` can never register one,
  because a pull request should not be able to run code on its reviewer's laptop.
  The grant is stored outside the repository, and you give it.
- **The approval is tied to the path.** A grant names one repository path.
  A second checkout or a git worktree of the same project needs its own
  `ext allow`. Upgrading the package, such as pulling a new version of a bundled
  extension, also needs a renewed approval. Until then, builds skip it and `check`
  says so.
- **A sandbox with no network and a copy of the source.** The extension sees a
  private copy of the repository, without dotfiles, `node_modules`, `vendor`,
  `tmp`, logs, and files that look like secrets. It gets an empty environment and
  a time limit. It cannot read what it does not need, and it cannot hang your
  build.
- **Additions only.** An extension can add nodes and edges. It can never remove or
  rewrite what the core resolved, so a buggy extension cannot make the core graph
  wrong. It can only add wrong edges on top, and those are labelled with their
  origin.
- **Structure is checked, truth is not.** The host verifies that the ids exist and
  the spans are real. It cannot verify that `"order.paid"` really reaches
  `ReceiptMailer`. That is the extension's job, which is why the declines, the
  `via` evidence and the tests matter more than the edge count.

## Keeping it honest over time

- **Watch the decline counts in the build log.** If a count moves without a code
  change you expected, investigate. A growing `topic-not-literal` count means the
  convention is eroding.
- **Keep a few known answers.** Pick three or four paths you have verified by hand
  and check them after changing the extension. A labelled answer catches a
  regression that looks like a success.
- **Match shapes, not names.** When the convention depends on the shape of a
  method or table, put that shape in the configuration and require the source to
  still match it. `extensions/rails-seam/` does this. When the application is
  refactored, the shape stops matching and the edges go away, which is the correct
  failure.
- **Keep project identifiers in config.** The code then stays reviewable on its
  own, and one package can serve several projects.

## Pitfalls

- **Comments and strings.** A pattern-matching extension finds text in comments
  and string literals too. Skip the obvious cases, and use a parser once the
  syntax gets wider.
- **`ctx.index` holds the core graph only.** It does not include other
  extensions' additions. An extension cannot build on another extension's edges.
- **`enclosing` returns `null` at the top level.** Decline those sites instead of
  attaching them to the file.
- **One bad item rejects everything.** A single edge to a nonexistent id discards
  the whole contribution. Check ids against `ctx.index` before emitting.
- **Duplicates collapse.** If several selectors reach the same target, combine
  their evidence into one `via` before returning. Otherwise deduplication keeps
  one and drops the rest.
- **No dependencies are installed.** The package is its own `.mjs`, `.cjs`, `.js`
  and `.json` files, up to 8 MiB. Vendor a library as a file if you need one, the
  way `rails-seam` vendors its parsers.
- **Tooling that refreshes the graph needs the same grants.** A refresh that
  cannot see the approvals treats them as revoked and removes their edges. This
  matters if you point `GRAFT_EXTENSION_STATE_DIR` at a custom store: every
  command that can refresh the graph needs the same value, not just `build`.

## Further reading

- `docs/extensions.md`: the full contract, sandbox and failure reference.
- `extensions/rails-seam/`: a production extension that joins a TypeScript frontend's
  HTTP calls to Rails controller actions, and a registry/cron dispatch analyzer.
  Both are configuration-driven and include their tests.
