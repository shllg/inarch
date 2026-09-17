/**
 * Zeitwerk: the Rails half of Ruby constant resolution.
 *
 * Rails' autoloader makes path and constant a bijection — `app/services/a/b/runner.rb`
 * defines `A::B::Runner`, and `app/models/concerns/role_based_access_control.rb`
 * defines `RoleBasedAccessControl` rather than `Concerns::RoleBasedAccessControl`,
 * because `app/models/concerns` is itself an autoload root. That map is the only
 * thing in a Rails app that can adjudicate between two files defining the same
 * constant, so it is used for exactly that and nothing else.
 *
 * It is gated on Rails detection, deliberately and conservatively: a plain Ruby gem
 * with an `app/` directory gets nesting resolution only. A maintainer of a polyglot
 * tool cares that the framework-specific half cannot fire on a non-framework repo,
 * so these tests assert the negative as hard as the positive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { isClean, probeDrift } from "../src/graph/fingerprint.js";
import { extractInputsKey } from "../src/graph/extract-cache.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function buildAndRead(files: Record<string, string>): Promise<{ dir: string; graph: GraphV1 }> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-zw-"));
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  await buildGraph(dir);
  const graph = readGraph(wiringPath(join(dir, "graft")))!;
  return { dir, graph };
}

const withGraph = async (files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> => {
  const { dir, graph } = await buildAndRead(files);
  try {
    body(graph);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const refs = (graph: GraphV1, source: string): string[] =>
  graph.edges.filter((e) => e.relation === "references" && e.source === source).map((e) => e.target).sort();

/** The two files that make a directory look like a Rails application. */
const RAILS = {
  "Gemfile": `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb": `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
};

/** Two files defining a top-level `Thing`, one under an autoload root and one not. */
const AMBIGUOUS_THING = {
  "app/models/thing.rb": `class Thing; end\n`,
  "lib/thing.rb": `class Thing; end\n`,
  "app/models/user.rb": `class User\n  def go\n    Thing.new\n  end\nend\n`,
};

test("zeitwerk: the autoload map decides between two files defining one constant", async () => {
  // Without it this is ambiguous and drops. `lib/` is not an autoload root in a
  // default Rails app, so exactly one candidate is reachable by autoload and the
  // reference has a single honest answer.
  await withGraph({ ...RAILS, ...AMBIGUOUS_THING }, (graph) => {
    assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), ["app/models/thing.rb#Thing"]);
  });
});

test("zeitwerk: the same ambiguity in a plain Ruby project produces no edge", async () => {
  // The negative half of the gate, and the reason it is a gate: an `app/` directory
  // is not evidence of Rails, so nothing may be inferred from the path shape alone.
  await withGraph(AMBIGUOUS_THING, (graph) => {
    assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), []);
  });
});

test("zeitwerk: a Gemfile without rails is not a Rails app", async () => {
  // `config/application.rb` alone is not enough — a plain gem may have one.
  await withGraph(
    {
      "Gemfile": `source "https://rubygems.org"\ngem "sinatra"\n`,
      "config/application.rb": `module Dummy; end\n`,
      ...AMBIGUOUS_THING,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), []);
    },
  );
});

test("zeitwerk: `app/models/concerns` is a root, so its constants are top-level", async () => {
  // The case that makes this worth having at all. If `app/models/concerns` were an
  // ordinary directory the file would define `Concerns::RoleBasedAccessControl`,
  // and the decoy below — which really is `Concerns::RoleBasedAccessControl` — would
  // win. Getting the root set right is what keeps the right one.
  await withGraph(
    {
      ...RAILS,
      "app/models/concerns/role_based_access_control.rb": `module RoleBasedAccessControl\n  def authorize!; end\nend\n`,
      "lib/role_based_access_control.rb": `module RoleBasedAccessControl\n  def authorize!; end\nend\n`,
      "app/models/user.rb": `class User\n  def go\n    RoleBasedAccessControl.name\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(
        refs(graph, "app/models/user.rb#User.go"),
        ["app/models/concerns/role_based_access_control.rb#RoleBasedAccessControl"],
      );
    },
  );
});

test("zeitwerk: a nested path maps to a nested constant", async () => {
  // `app/services/billing/invoice.rb` defines `Billing::Invoice`, so the decoy at
  // `app/models/invoice.rb` (which would be a top-level `Invoice`) is not it.
  await withGraph(
    {
      ...RAILS,
      "app/services/billing/invoice.rb": `module Billing\n  class Invoice; end\nend\n`,
      "app/jobs/billing/invoice.rb": `module Billing\n  class Invoice; end\nend\n`,
      "app/models/checkout.rb": `class Checkout\n  def run\n    Billing::Invoice.new\n  end\nend\n`,
    },
    (graph) => {
      // BOTH candidates are legal Zeitwerk paths for `Billing::Invoice`. The map
      // cannot choose, so neither may be guessed at.
      assert.deepEqual(refs(graph, "app/models/checkout.rb#Checkout.run"), []);
    },
  );
});

test("zeitwerk: an acronym inflection changes which file defines the constant", async () => {
  // `inflect.acronym "API"` makes `api_client.rb` define `APIClient`; without it
  // that file defines `ApiClient` and the constant has no home at all. This is the
  // one place the inflector is load-bearing rather than cosmetic.
  const files = {
    ...RAILS,
    "app/services/api_client.rb": `class APIClient; end\n`,
    "app/lib/apiclient.rb": `class APIClient; end\n`,
    "app/models/user.rb": `class User\n  def go\n    APIClient.new\n  end\nend\n`,
  };

  await withGraph(
    { ...files, "config/initializers/inflections.rb": `ActiveSupport::Inflector.inflections do |inflect|\n  inflect.acronym "API"\nend\n` },
    (graph) => {
      assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), ["app/services/api_client.rb#APIClient"]);
    },
  );

  await withGraph(files, (graph) => {
    // No inflections file: `api_client.rb` camelizes to `ApiClient` and `apiclient.rb`
    // to `Apiclient`. Neither is `APIClient`, so the map abstains and so do we.
    assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), []);
  });
});

test("zeitwerk: config.autoload_paths adds a root", async () => {
  // Parsed best-effort from config/application.rb. A repo that adds `lib` to the
  // autoload paths really does autoload `lib/thing.rb` as `Thing`, and then the
  // ambiguity with `app/models/thing.rb` is genuine again.
  await withGraph(
    {
      "Gemfile": RAILS.Gemfile,
      "config/application.rb":
        `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application\n` +
        `    config.autoload_paths << Rails.root.join("lib")\n  end\nend\n`,
      ...AMBIGUOUS_THING,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), [], "two autoloadable homes is still ambiguous");
    },
  );
});

test("zeitwerk: lexical nesting still wins over the autoload map", async () => {
  // The map is a tiebreaker for an ambiguous repo-wide match, never a first
  // resort. Ruby resolves `Thing` inside `module Billing` to `Billing::Thing`
  // whatever the autoloader would have done with a top-level `Thing`.
  await withGraph(
    {
      ...RAILS,
      "app/models/thing.rb": `class Thing; end\n`,
      "app/services/billing/thing.rb": `module Billing\n  class Thing; end\nend\n`,
      "app/services/billing/charge.rb": `module Billing\n  class Charge\n    def run\n      Thing.new\n    end\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(
        refs(graph, "app/services/billing/charge.rb#Billing.Charge.run"),
        ["app/services/billing/thing.rb#Billing.Thing"],
      );
    },
  );
});

/*
 * Freshness. Rails detection reads two files, and only one of them is Ruby.
 */

test("zeitwerk: editing the Gemfile out of Rails registers as drift", async () => {
  // The whole resolver configuration hangs off this one line, and a Gemfile is not a
  // source file, so nothing was watching it. Queries kept answering from a
  // Zeitwerk-resolved graph that an explicit rebuild would have thrown away — and the
  // probe, which is what decides whether to rebuild, said everything was clean.
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-zw-fresh-"));
  try {
    for (const [name, content] of Object.entries({ ...RAILS, ...AMBIGUOUS_THING })) {
      const abs = join(dir, name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    await buildGraph(dir);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!), "clean immediately after a build");

    writeFileSync(join(dir, "Gemfile"), `source "https://rubygems.org"\ngem "sinatra"\n`);
    assert.deepEqual(probeDrift(dir, join(dir, "graft"))!.changed, ["Gemfile"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zeitwerk: adding a Gemfile registers as drift too", async () => {
  // The other direction: a repo can BECOME a Rails app, and an appearing file is not
  // a changed one.
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-zw-fresh2-"));
  try {
    for (const [name, content] of Object.entries({ "config/application.rb": RAILS["config/application.rb"], ...AMBIGUOUS_THING })) {
      const abs = join(dir, name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    await buildGraph(dir);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));

    writeFileSync(join(dir, "Gemfile"), RAILS.Gemfile);
    assert.deepEqual(probeDrift(dir, join(dir, "graft"))!.added, ["Gemfile"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zeitwerk: an acronym's SPELLING changes the extraction-cache identity", async () => {
  // `inflect.acronym "API"` and `inflect.acronym "Api"` both key on `api` and imply
  // different constants — `APIClient` versus `ApiClient`. Keying the memo on the keys
  // alone let an incremental build replay parses made under the other spelling.
  const key = (v: string) => extractInputsKey({ acronyms: new Map([["api", v]]) });
  assert.notEqual(key("API"), key("Api"));
  assert.equal(extractInputsKey(null), "plain");
});

/**
 * `config.autoload_lib(ignore: …)` — Rails 7.1 replaced pushing `lib` onto
 * `config.autoload_paths` by hand with this, and both corpus apps use it. Until it
 * was read, `lib` was not a root, so `lib/tenancy.rb` was not the home of `Tenancy`
 * and a file that merely opened `module Tenancy` to nest a concern outranked it.
 * Measured on dailywerk at `3fabcfa1`: 3 references retargeted off the wrapper and
 * **157 that had been declining as ambiguous** resolved, every sampled one a real
 * `Tenancy.cross_workspace` or `Tenancy.scoped_bypass?`.
 */
const APP_WITH = (body: string) => ({
  "Gemfile": RAILS.Gemfile,
  "config/application.rb":
    `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application\n` +
    `    ${body}\n  end\nend\n`,
});

test("zeitwerk: config.autoload_lib makes lib a root", async () => {
  await withGraph(
    {
      ...APP_WITH(`config.autoload_lib(ignore: %w[assets tasks])`),
      "lib/tenancy.rb": `module Tenancy\n  def self.bypass? = false\nend\n`,
      "app/models/concerns/tenancy/scoped.rb":
        `module Tenancy\n  module Scoped\n    def check = Tenancy.bypass?\n  end\nend\n`,
    },
    (graph) => {
      assert.deepEqual(
        refs(graph, "app/models/concerns/tenancy/scoped.rb#Tenancy.Scoped.check"),
        ["lib/tenancy.rb#Tenancy"],
        "the home in lib outranks the namespace wrapper beside the reference",
      );
    },
  );
});

test("zeitwerk: an ignored lib subdirectory is nobody's home", async () => {
  // The ignore list only bites on a constant the subdirectory would otherwise own,
  // so the fixture has to be namespaced: `lib/tasks/report.rb` under root `lib` is
  // `Tasks::Report`, exactly what `app/services/tasks/report.rb` is. Drop the ignore
  // list and those are two homes, the map abstains, and the edge disappears. The
  // argument exists because eager-loading these raises LoadError — a file Rails never
  // autoloads cannot be the definition site of anything.
  await withGraph(
    {
      ...APP_WITH(`config.autoload_lib(ignore: %w[assets tasks rubo_cop])`),
      "lib/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 1\n  end\nend\n`,
      "app/services/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 2\n  end\nend\n`,
      "app/models/user.rb": `class User\n  def run = Tasks::Report.go\nend\n`,
    },
    (graph) => {
      assert.deepEqual(
        refs(graph, "app/models/user.rb#User.run"),
        ["app/services/tasks/report.rb#Tasks.Report"],
        "lib/tasks is ignored, so exactly one home is left",
      );
    },
  );
});

test("zeitwerk: autoload_lib with a bracketed string list is read the same way", async () => {
  await withGraph(
    {
      ...APP_WITH(`config.autoload_lib(ignore: ["assets", "tasks"])`),
      "lib/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 1\n  end\nend\n`,
      "app/services/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 2\n  end\nend\n`,
      "app/models/user.rb": `class User\n  def run = Tasks::Report.go\nend\n`,
    },
    (graph) => {
      assert.deepEqual(
        refs(graph, "app/models/user.rb#User.run"),
        ["app/services/tasks/report.rb#Tasks.Report"],
      );
    },
  );
});

test("zeitwerk: a lib subdirectory that is NOT ignored is a home like any other", async () => {
  // The other side of the same fixture, and the one that proves the ignore list is
  // being read rather than `lib` simply never producing namespaced constants.
  await withGraph(
    {
      ...APP_WITH(`config.autoload_lib(ignore: %w[assets rubo_cop])`),
      "lib/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 1\n  end\nend\n`,
      "app/services/tasks/report.rb": `module Tasks\n  class Report\n    def self.go = 2\n  end\nend\n`,
      "app/models/user.rb": `class User\n  def run = Tasks::Report.go\nend\n`,
    },
    (graph) => {
      assert.deepEqual(refs(graph, "app/models/user.rb#User.run"), [], "two homes, so the map abstains");
    },
  );
});

test("zeitwerk: without autoload_lib, lib is still not a root", async () => {
  // The guard on the whole change. A default Rails app does not autoload `lib`, and
  // AMBIGUOUS_THING has to keep resolving to the one reachable home.
  await withGraph({ ...RAILS, ...AMBIGUOUS_THING }, (graph) => {
    assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), ["app/models/thing.rb#Thing"]);
  });
});

test("zeitwerk: autoload_lib makes two homes genuinely ambiguous again", async () => {
  // The mirror of the test above, and the reason this is a root rather than a
  // preference: once `lib` really is autoloaded, `lib/thing.rb` and
  // `app/models/thing.rb` are two homes for one constant and the map must abstain.
  await withGraph(
    { ...APP_WITH(`config.autoload_lib(ignore: %w[tasks])`), ...AMBIGUOUS_THING },
    (graph) => {
      assert.deepEqual(refs(graph, "app/models/user.rb#User.go"), []);
    },
  );
});
