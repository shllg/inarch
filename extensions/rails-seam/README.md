# rails-seam

Two graph extensions for Rails applications, in one approved package.

- **`extension.mjs`** — the seam scanner. It reads the frontend's HTTP calls,
  resolves each request path against `config/routes.rb`, and emits a `serves`
  edge from the calling function to the controller action that answers it. This
  is the one edge a language-by-language extractor can never produce, because
  the two ends are written in different languages and joined only by a string.
- **`runtime.mjs`** — the runtime dispatch analyzer. A registry, an ordered
  classifier chain and a cron table all choose their target at runtime out of
  data, so the call site names nothing. It reads the data instead.

Both are configuration-driven and neither contains an application's identifiers.

## Why the configuration is so specific

`runtime.mjs` will not emit an edge merely because a constant has the right
name. It requires the surrounding source to still match the shape the
configuration declares — the table's construction, the bodies of the methods
that read it, the assignment that selects the receiver. The comparison is over a
normalized token stream, so reformatting is free and a changed body is not.

That is deliberate. Indirection is exactly where a wrong edge is most expensive:
an agent told that `Dispatcher#call` reaches `Archive#call` will edit
`Archive#call`. When the application is refactored the declared shape stops
matching and the edges disappear, which is the correct failure — an agent with
no edge runs a grep, an agent with a stale edge rewrites the wrong method.

Keeping the shapes in configuration rather than in the extension is what lets
one package serve applications that spell their registry differently, and what
keeps this repository free of any particular application's internals.

## `railsSeam`

| Key | Required | Meaning |
|---|---|---|
| `client.module` | yes | Repository-relative module exporting the request function |
| `client.function` | yes | The exported name every request goes through |
| `client.base` | yes | Path prefix the client prepends, e.g. `/api/v1` |
| `roots` | yes | Directories to scan for call sites |
| `routes` | no | Route file, default `config/routes.rb` |
| `environment` | no | Environment whose route guards apply |
| `routeEntrypoints` | no | Also emit a node per reachable route |
| `sourceRoots` | no | Where the application's Ruby lives, default `["app"]` |

A named import of `client.function` is the evidence; an identifier that merely
spells the same is not. Literal paths, parameter templates and locally
resolvable constants join; an unknown runtime path stays ambiguous and emits
nothing.

## `railsRuntime`

At least one of `registry`, `chain` or `scheduler` is required. Each is
independent, and an absent section simply does not run. `sourceRoots` defaults
to `["app"]`.

### `registry`

Data that maps a key to a class, plus the methods that read it.

| Key | Meaning |
|---|---|
| `file`, `class` | Where the registry is defined, and its Ruby class name |
| `entry.const`, `entry.shape` | The row constructor and the source it must match |
| `table.const`, `table.block` | The table constant and its `to_h` block |
| `table.fields` | Every field a row may carry; an unknown field declines the table |
| `table.key`, `table.target` | Which fields hold the lookup key and the class name |
| `table.select` | Optional boolean field; only rows set `true` are considered |
| `table.keyPrefix` | Optional prefix the lookup strips before comparing keys |
| `methods.resolver` / `.list` / `.lookup` | Singleton method names and their exact bodies |
| `dispatcher` | Optional: the caller that resolves a class and invokes it |

With `dispatcher` configured, the analyzer additionally proves that the local
holding the resolved class is never rebound between assignment and call, that
the target's constructor is ordinary allocation, and that the invoked method is
public on the receiver. Any doubt declines the bridge but keeps the registry
mapping, which is independently verified.

### `chain`

An ordered list of class names that each get probed in turn.

| Key | Meaning |
|---|---|
| `file`, `class`, `const` | Where the list lives and the constant holding it |
| `methods.list`, `methods.caller` | The method that materializes the list and the one that walks it |
| `probes` | The methods called on each member |

The constant must be referenced exactly twice — its own assignment, and the one
read inside `methods.list`. A third reference is a use this analyzer has not
read and cannot account for.

### `scheduler`

A cron table attached to a job framework's configuration.

| Key | Meaning |
|---|---|
| `file` | The initializer that builds and attaches the table |
| `namespace`, `setting` | Configuration accessors, e.g. `good_job` and `cron` |
| `local` | The local variable holding the table before it is attached |
| `settings` | Other accessors in the namespace that may appear |
| `entry.schedule`, `entry.class` | Row keys holding the cron expression and job class |
| `symbol`, `label` | Identity and display name for the emitted schedule nodes |
| `receiver`, `config`, `configure` | Default `Rails.application`, `config`, `configure` |
| `jobBase`, `jobMethod` | Default `ActiveJob::Base` and `perform` |

Once the table is attached, a mutation through any alias reaches the same hash,
so an escaping reference or an unknown mutator invalidates the whole table
rather than the one row it touches.

## Vendored parsers

`typescript.cjs`, `web-tree-sitter.cjs` and `ruby-wasm.mjs` are vendored because
an approved package is snapshotted and digested as a directory: every executable
byte must be inside it, and native addons are outside the extension contract.
Their licences and notices sit beside them and are part of the package.

## Running it outside the host

`seam.mjs` runs the scanner against a built graph without the host, for
measurement:

```sh
node seam.mjs REPO path/to/wiring.json path/to/config.json --json
```

`oracle.rb` independently checks the scanner's route joins against real
`ActionDispatch` recognition, without booting the application:

```sh
ruby oracle.rb REPO scanner-report.json [environment]
```
