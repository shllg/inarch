# Local graph extensions

An extension adds project-specific nodes and edges after core resolution and LSP
enrichment, before the graph is written. Core nodes and edges cannot be rewritten
or deleted. Extensions are disabled until explicitly approved for a repository.

## Register and inspect

Keep each extension in a dedicated directory. Its entry must be an ES module
(`.mjs` or `.js`); use relative imports for helpers in that directory.

```sh
graft ext allow /path/to/extension/entry.mjs /path/to/repo --config /path/to/config.json
graft ext list /path/to/repo
graft build /path/to/repo --dry-run
graft build /path/to/repo
graft ext status /path/to/repo --json
graft ext revoke <id-or-entry-path> /path/to/repo
```

Approval covers the canonical repository path, entry path, every included module
and JSON file in the package, and the supplied configuration. A helper edit also
invalidates approval. Run `ext allow` again after reviewing changes. Configuration
is copied at approval time; editing an external config file does not change a grant.

Grants live under `${XDG_STATE_HOME:-~/.local/state}/graft/extensions`, outside the
repository. `GRAFT_EXTENSION_STATE_DIR` can select another external state directory.
Project configuration, including tracked or symlinked `.graft/config.json`, cannot
register executable code. Approval permits execution during builds and automatic
query refreshes. Revocation and package changes invalidate the graph fingerprint;
the next build or refresh removes the previous contribution.

Freshness also covers the host-captured extension source view: file bytes and
paths, including non-parser files and empty directories. Every execution input
digest from a complete capture is retained, including failed runs. The current
view must match all of them. Incomplete captures are tracked as execution failures.
Checks do not execute extensions. This requires a bounded byte scan for
active extensions; core-only and pre-execution skipped builds avoid that cost.
The known graph output directory is excluded from capture and comparison to
avoid self-invalidating builds with a custom `--dir`.

A maximum of eight packages may be approved per repository. Package snapshots include
`.mjs`, `.cjs`, `.js`, and `.json` files recursively, excluding dot entries and
`node_modules`. Symlinks and special files are rejected. Limits are 256 included
files, 8 MiB, 4,096 directory entries, and 32 directory levels. No dependency
discovery or package installation occurs.

## Contract

```js
export default async function extend(ctx) {
  const from = ctx.index.byPath["frontend/calendar.ts"]?.find(n => n.name === "list");
  const to = ctx.index.byPath["app/controllers/calendars_controller.rb"]
    ?.find(n => n.name === "index");
  if (!from || !to) return {};
  // A real extension must parse and verify the route before asserting this join.
  const verified = verifyRoute(ctx.readFile("config/routes.rb"), "GET", "/calendars");
  if (!verified) return {};
  ctx.log("one verified route");
  return {
    edges: [{ source: from.id, target: to.id, relation: "serves", via: "GET /calendars" }]
  };
}
```

`verifyRoute` above stands for the extension's own parser and verification. The
host checks graph structure; it cannot prove that a route assertion is true.

The context contains:

- `repoRoot`: `"/repo"`, the isolated source view.
- `index.byPath`: location records `{id, name, kind, startLine, endLine}`, grouped by
  repository-relative path. This is the core graph's location index, without its
  source bodies, summaries, or earlier extensions' additions.
- `index.has(id)` and `index.enclosing(path, line)`: membership and the smallest
  enclosing non-file symbol, or `null`.
- `readFile(path)`: synchronous UTF-8 source text, or `null` when unavailable.
- `listFiles(path = ".")`: sorted repository-relative file paths.
- `config`: the JSON object copied into the approval.
- `log(message)`: bounded diagnostic text shown during an interactive build.

Return an object with optional `nodes` and `edges` arrays. Other top-level keys,
including deletion requests, are rejected. Every endpoint must exist in the core
graph or the same contribution. One invalid item rejects the whole contribution.

A new node supplies `id`, `path`, `name`, `kind`, and `span` (`L1-L5`). Its id
must start with its normalized repository-relative path and `#`, be unique, and
refer to an existing source span. The host reads and hashes that span; submitted
summaries and confidence cannot impersonate core output. New nodes omit retained
source bodies to avoid amplification from overlapping submitted spans.

Edges supply `source`, `target`, and `relation`; `via` is optional short evidence.
The supported relations are `contains`, `calls`, `imports`, `references`,
`implements`, `extends`, `renders`, `serves`, `dispatches`, and `enqueues`.
A `calls` edge cannot cross a language boundary. Use `serves` for a verified
route declaration or frontend request to handler relationship, `dispatches` for
a verified possible runtime target, and `enqueues` for an asynchronous handoff.
Evidence should identify the supported receiver, selector, or scheduling rule
and any conditions; these relationships do not prove that execution occurs.
Exact duplicate source/relation/target edges preserve the original edge and
confidence. Aggregate evidence for several selectors reaching the same endpoint
before returning the contribution, so deduplication cannot discard alternatives.

The host stamps `origin: "extension"`, `extension` (the registration id), and
`extensionDigest` on every addition, and `confidence: "extension"` on edges.
Strict graph quality validates and counts this provenance. Structural validation
does not establish semantic correctness: callers must check the extension's
evidence before acting on an uncertain assertion.

`callers --json` preserves relation, origin, confidence, extension digest and `via`
on direct and transitive hits. Structural `ask` queries include the same bridge
relations. Lexical `ask` can accompany a selected symbol with one proved
`renders`/`serves` endpoint, reserving at least half the result budget for ranked
matches and preserving scope isolation. `check` revalidates extension node source spans and
reports approval/package drift without executing extensions.

## Execution boundary

Extensions require Linux, Node 24 or newer, `/usr/bin/bwrap`, and
`/usr/bin/prlimit`. Graft probes the required namespaces and runtime capabilities.
Unsupported environments record a skip and still build the core graph. There is
no uncontained fallback.

The worker receives verified package bytes and a private source copy. Bubblewrap
isolates mount, process, network and other namespaces, drops capabilities, disables
nested user namespaces, supplies an empty environment, and mounts inputs read-only.
The live repository is never mounted: its Unix sockets and symlinks cannot expose
host services or files. Node permissions and module restrictions add defense in
depth; the OS boundary is the containment mechanism.

The source copy excludes every dot entry, symlink, and special file; directories
named `node_modules`, `vendor`, `tmp`, `log`, `coverage`, `dist`, `build`, and
`graft`; names starting with `credentials.` or `secrets.` (also those bare names);
and `.pem`, `.key`, `.p12`, and `.pfx` files. New-node validation enforces the
same exclusions. Other included source may contain sensitive information; these
conventions cannot identify every secret embedded in source code.

Source snapshots are capped at 256 MiB, 50,000 entries, and 64 levels. Execution
has a 15-second deadline including snapshot preparation, a 30-second aggregate
build budget, 16 MiB output, 64 KiB stderr/log limits, and OS memory/CPU/descriptor
limits. Timeout forcibly terminates descendants. Contributions are capped at
10,000 nodes and 100,000 edges. Parent validation shares a 16 MiB unique-source
budget and a 32 MiB normalized-addition budget across the build, with an 8 MiB
individual source-file limit. Deadlines and byte limits also apply to rejected
attempts. Each extension currently receives its own bounded source copy.

## Failure and visibility

Throwing, timing out, invalid output, changed packages, or unavailable isolation
leave the core graph usable. Build output reports status and added counts.
Source freshness and execution health are separate: `check` reports degraded
coverage when a registered extension did not complete successfully, and navigation
includes a short warning with fixed reason codes. A successful zero-edge result is
healthy. Failed contributions are removed, never carried forward from an older graph.
Execution outcomes and captured input identities bind the published graph to its
fingerprint; an unsuccessful cache write cannot certify a different graph.

Automatic refresh retries transient execution failures after a persisted 60-second
cooldown, rechecking under the normal refresh lock. Source, package and approval
changes can trigger a refresh sooner. Changed or revoked packages are never executed
without valid approval. Repeated queries during the cooldown use the core graph with
the coverage warning. An explicit build retries immediately; `GRAFT_REFRESH=0` keeps
refresh disabled while retaining the warning. Legacy fingerprints without execution
health rebuild once. Invalid output or an extension error requires changed inputs,
corrected approval/package state or an explicit build.

`build --dry-run` lists registrations without running extensions, refreshing
upkeep, or writing a graph.

Each attempt appends start and terminal events to the external state's
`runs.jsonl`. `ext status` reads the last 100 complete events from a bounded tail.
Records contain timestamps, ids, approved digests, outcome, duration, and counts;
failures include a fixed host reason code such as `timeout`, `extension-error`,
`unapproved-changed`, `isolation-unavailable` or `merge-rejected`.
diagnostic source text and extension logs are not persisted there. An interrupted
build may leave a start event without a terminal event. If recording cannot start,
the extension does not execute. The append-only audit can be archived by its owner.
Malformed or torn lines produce source-free corruption markers while neighboring
valid events remain readable. Interactive diagnostic controls are sanitized.

Containment does not prove an extension's returned statements. An approved module
can return misleading edges or diagnostics. Provenance, conservative verification,
and a labelled evaluation corpus remain necessary.

## Bundled packages

`extensions/rails-seam/` is a worked example that ships with this repository: a
cross-language `serves` scanner and a runtime dispatch analyzer for Rails. It is
not loaded automatically — it is granted by path like any other package, and its
own README documents its configuration.

```sh
graft ext allow extensions/rails-seam/extension.mjs . --config rails.json
graft ext allow extensions/rails-seam/runtime.mjs   . --config rails.json
```

It exists because an extension API is only as good as the hardest consumer
anyone actually wrote against it. Its tests run in `npm test`.
