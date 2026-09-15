# Inarch

A code-graph engine for large repositories. It parses your source with
tree-sitter and precomputes the structure a coding agent otherwise rediscovers
by reading files: what exists, where it lives, and what calls what. Querying
that graph costs a few hundred tokens; rebuilding the same understanding from
source costs thousands, and misses the edges.

The structural build is deterministic and offline — no model, no API key, no
network. An optional `--deep` pass adds LLM-written summaries through a provider
key you supply.

Inarch is a fork of [Graft](https://github.com/trailhq/Graft). It adds
full-fidelity Ruby and Rails support and a graph extension system, and it
removes the telemetry and the hosted-service integration. Graft is MIT-licensed;
its copyright notice is retained in full. Inarch is a personal tool, not a
product, and is unaffiliated with Graft's authors.

Ruby extraction began as [@kapelner](https://github.com/kapelner)'s work in
[trailhq/Graft#275](https://github.com/trailhq/Graft/pull/275) — 33 of the 35
commits it is built on are his. Everything above the depth tiers is new here.

---

## Install

```bash
npm install -g "git+https://github.com/shllg/inarch.git#inarch/v0.19.0"
inarch --version
```

Installing from a git tag is the whole distribution story. There is no npm
package; see [Support](#support) for what that implies.

Release tags are prefixed `inarch/v…` because the repository also carries the
upstream release tags it was forked from, and `v0.18.0` there is Graft's, not
ours. The version restarts the minor series rather than continuing upstream's:
this tree is upstream 0.18.0 minus the hosted server and the telemetry, plus
Ruby, Rails and extensions, and calling that 0.18.0 would claim a parity it
does not have.

Node 20 or newer. On a machine with `ignore-scripts=true` in its npm config, add
`--ignore-scripts=false` — one grammar ships no prebuild and must compile.

## Quick start

```bash
cd your-repo
inarch build          # writes graft/ — the wiring graph and per-file cards
inarch map            # orientation: directory clusters, hubs, hotspots
inarch ask "where is auth handled?" --source
inarch callers Billing::Invoice#charge --depth 2
```

`inarch init` wires the graph into whichever coding agents the machine has, so
they query it on their own. It prompts before writing anything, and
`--dry-run` lists every file it would touch.

---

## Rails

This is why the fork exists. A generic extractor reads Rails as a pile of files
with very few edges between them, because the wiring is in macros, in routes and
in string keys rather than in calls. Inarch models the parts that carry real
structure:

| What | How it resolves |
|---|---|
| **Constants** | Ruby's own `Module.nesting` order, with Zeitwerk's path convention as the tiebreak — not a global name match |
| **Method dispatch** | The receiver's declared type. An `attr_reader`, a constructor assignment or a `Data.define` field is what binds a call to one definition |
| **Visibility** | `private` / `protected` / `public`, `private_class_method` and `class << self` all change which definitions a call can reach |
| **Macros** | `has_many`, `belongs_to`, `delegate`, `attr_accessor`, `define_method` and friends synthesize the methods they declare, from the options they were given rather than from the name |
| **Jobs** | `perform_later` becomes an `enqueues` edge to the job's `perform`, not a call to the enqueue helper |
| **Views** | ERB templates are indexed and a controller action gets a `renders` edge to the template it actually renders |
| **Routes** | `config/routes.rb` is parsed and verified against disk, so an HTTP path gets a `serves` edge to the controller action behind it |

Every one of those is a *decision to emit an edge or not*. Where the source does
not state enough to resolve a target, Inarch emits nothing. A missing edge costs
an agent one grep; a wrong edge costs it a bad refactor, because the graph is
presented to the model as an answer to act on.

The relation and confidence vocabulary is part of the output: `serves`,
`dispatches`, `enqueues`, `renders`, `calls`, `extends`, `contains`, `imports`,
`references`, each carrying how it was resolved — `extracted`, `type_bound`,
`inferred`, `convention`, `ruby_dispatch`, `ruby_injection`, `extension`, or
`lsp_resolved`.

---

## Extensions

Some structure lives in an application's own conventions and cannot be modelled
generically: a registry that maps string keys to handler classes, a classifier
chain, a cron table. An extension is a package you approve for one repository
that contributes nodes and edges to the build.

```bash
inarch ext allow ./extensions/rails-seam/extension.mjs . --config seam.json
inarch ext list
inarch ext status
inarch ext revoke <id>
```

Approval is per repository and covers the package's complete contents plus its
configuration, both digested. Changing either requires renewing the grant.
Extension code runs in OS isolation during builds, and a failure is reported
rather than silently dropping edges.

`extensions/rails-seam/` is the worked example and ships in the tree: it reads a
Rails route table and an application's declared runtime shapes, verifies each
against the repository's own source as a normalized token stream, and emits an
edge only where the source still matches what the configuration declared.
Reformatting is free; a changed method body withdraws the edge. Its
[README](extensions/rails-seam/README.md) documents the configuration schema.

See [docs/extensions.md](docs/extensions.md) for the extension API.

---

## Supported languages

Parsed with tree-sitter at two levels of fidelity, plus an optional
compiler-grade layer. All of it is `$0` and deterministic.

- **Full fidelity** — scope-aware, cross-file call and import resolution:
  **Ruby**, **TypeScript / JavaScript** (incl. JSX & TSX), **Python**, **Go**,
  **C/C++**, **Java**, **Kotlin**, **PHP**, **Swift**, **R**. ERB templates are
  indexed as a container tier above Ruby.

- **Broad** — symbols plus name-resolved call edges via a generic extractor:
  **Rust, C#, Scala, Elixir, Solidity, OCaml, Zig, Dart, Clojure, Nix, Lua**.

- **Compiler-grade edges (opt-in)** — `inarch build --lsp` adds precise
  `lsp_resolved` edges when a language server is on your `PATH`:
  rust-analyzer, clangd, gopls, pyright, typescript-language-server. Best
  effort; with no server installed the graph is unchanged.

A file whose language is not listed is skipped, not indexed.
[CREDITS.md](CREDITS.md) names the people behind the inherited extractors.

---

## Agent integration

```bash
inarch init                     # detects your agents and writes each one's native instruction file
inarch init --dry-run           # list every file it would touch, then exit
inarch init --agents cursor kiro
inarch init --no-global         # skip writes outside this repo
inarch uninstall -y             # the exact inverse
```

Claude Code additionally gets a statusline and hooks that keep the graph fresh
and report what the graph saved per turn. Every other agent gets an instruction
block and, where it supports one, an MCP server entry.

### MCP server

```bash
inarch mcp                      # stdio MCP server
```

Six tools: `graft_find_code`, `graft_find_all`, `graft_trace_calls`,
`graft_file_api`, `graft_repo_map`, `graft_check_freshness`. The tool names keep
their inherited prefix so instruction files and skill cards written against them
keep working.

---

## CLI

```bash
inarch build [dir]                    # wiring graph + per-file cards (no LLM, no key)
inarch build --deep                   # add the LLM layer: concept nodes + per-symbol summary/crux
inarch build --lsp                    # add compiler-grade edges from a language server
inarch build --extensions .rb .ts     # only include these code extensions
inarch build --no-reuse               # re-parse everything instead of replaying from cache
inarch build --follow-submodules      # include initialized submodules; persists the choice

inarch ask "<task>" [dir]             # ranked nodes + exact file:line
inarch ask "<task>" --source          # inline the relevant code spans
inarch ask "<task>" --in <scope>      # narrow to one sub-project

inarch skeleton <file> [dir]          # every signature in one file, no bodies
inarch callers <symbol> [dir]         # who calls/references/imports/implements/extends it
inarch callers <symbol> --direction out   # the reverse
inarch callers <symbol> -d N          # transitive, out to depth N

inarch grep "<regex>" [dir]           # exhaustive over indexed files, grouped by enclosing symbol
inarch map [dir]                      # token-budgeted repo orientation
inarch blast [dir]                    # blast radius of a diff
inarch check [dir]                    # exit 1 if graft/ has drifted from the code
inarch viz [dir]                      # interactive viewer on localhost

inarch ext allow <module> [repo] --config <file>   # approve an extension package
inarch ext list | ext status | ext revoke <id>

inarch version                        # the installed version
inarch --dir <path>                   # use a graph directory other than <repo>/graft
```

`ask`, `skeleton`, `callers`, `grep`, `map` and `blast` refresh the graph first
if the working tree moved. `--no-refresh` answers from disk as-is;
`GRAFT_NO_REFRESH=1` does the same for every command.

Ruby symbols are addressed with dots: `Module::Class#method` is queried as
`Module.Class.method`.

---

## Configuration

Environment variables keep their inherited `GRAFT_` prefix. Renaming 56 of them
across 96 use sites would put a conflict on every file upstream ever touches,
and the sync is worth more than the consistency.

| Variable | What it does |
|---|---|
| `GRAFT_DIR` | Graph directory (default `<repo>/graft`) |
| `GRAFT_PROVIDER` | Wire format for `--deep`: `openai`, `anthropic`, `litellm`, `orcarouter` |
| `GRAFT_API_KEY` / `GRAFT_MODEL` / `GRAFT_BASE_URL` | Provider credentials and endpoint |
| `GRAFT_NO_REFRESH` | Never auto-refresh before a query |
| `GRAFT_REFRESH=hash` | Hash every file instead of trusting size+mtime |
| `GRAFT_NO_GITIGNORE` / `GRAFT_NO_IGNORE` | Skip the `.gitignore` / `.ignore` writes |
| `GRAFT_NO_STATUSLINE` | Skip the Claude Code statusLine during `init` |
| `GRAFT_EXTENSION_STATE_DIR` | Where extension grants are stored |

[`.env.example`](.env.example) carries the full list.

Local state: `<repo>/graft/` is the graph, `<repo>/.inarch/` is this
repository's own settings, and extension grants live under
`$XDG_STATE_HOME/inarch/extensions/`.

## What runs where

- **On your machine, no key, no network** — the structural graph. `build`,
  `check`, `ask`, `grep`, `map`, `callers`, `skeleton` and `blast` are
  deterministic tree-sitter and never call a model.
- **Through your provider key** — only `build --deep` and `blast --name`, and
  only to the endpoint you configured.

There is no telemetry, no usage ping, no version check and no hosted component.
Those are removed, not disabled: `rg -i 'posthog|telemetry' src/` returns
nothing.

---

## Development

```bash
npm install --ignore-scripts=false    # one grammar has no prebuild
npm run build
npm test
npx tsc -p tsconfig.json --noEmit
```

Four tests in `test/blast.test.ts` fail on a pristine checkout and are inherited.

## Support

Inarch is maintained for its author's own use. Issues and pull requests are not
monitored, releases happen when something is needed, and the fork carries no
compatibility promise — if it is useful to you, pin a tag.

## License

MIT. See [LICENSE](LICENSE), which retains the original copyright notice
alongside ours.
