/**
 * A reopening is not a definition.
 *
 * Ruby lets any file reopen any constant, and extraction cannot tell `class String`
 * adding one method from `class Workspace` defining a model — both mint a node. When
 * the real constant lives OUTSIDE the repository, that reopening is the only node
 * with the name, and the single-candidate branch of `pickRubyConstant` handed it to
 * every reference to the real thing.
 *
 * Measured on dailywerk at `3fabcfa1` before this landed: an initializer reopening
 * `String` collected 76 references from 56 files, every sampled one an
 * `is_a?(String)` type check — while the four files that actually call
 * `.truncate_bytes` got nothing, because a method call on a receiver is not a
 * constant reference. The dependency was reported exactly backwards. A test helper
 * reopening `ActiveSupport` collected three more, all from production initializers,
 * which is how the TypeScript half of this defect announced itself too.
 *
 * The declines below are the milestone. Everything after them is a guard: the rule
 * is a short list of constants the repository provably cannot own, NOT a rule about
 * file paths, and these pin the difference. A path rule was measured first and cost
 * 17 correct edges to remove 3 more wrong ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { EdgeV1, GraphV1 } from "../src/graph/types.js";

const RAILS = {
  Gemfile: `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb":
    `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
};

async function withGraph(
  files: Record<string, string>,
  body: (g: GraphV1) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-reopen-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const abs = join(dir, name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    await buildGraph(dir);
    body(readGraph(wiringPath(join(dir, "graft")))!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const edgesTo = (g: GraphV1, target: string): EdgeV1[] =>
  g.edges.filter((e) => e.target === target && e.relation !== "contains");

/** A file that reopens `String` only to add a method, exactly as a Rails app does. */
const STRING_PATCH = {
  "config/initializers/string_truncate_bytes.rb":
    `class String\n  def truncate_bytes(limit)\n    byteslice(0, limit)\n  end\nend\n`,
};

test("a reopened core class is not the repository's String", async () => {
  await withGraph(
    {
      ...RAILS,
      ...STRING_PATCH,
      "app/models/user.rb":
        `class User\n  def check(value)\n    raise ArgumentError unless value.is_a?(String)\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        edgesTo(g, "config/initializers/string_truncate_bytes.rb#String").map((e) => e.source),
        [],
        "`is_a?(String)` is a type check against Ruby's String, not a dependency on the patch",
      );
    },
  );
});

test("a reopened framework module is not the repository's ActiveSupport", async () => {
  await withGraph(
    {
      ...RAILS,
      "test/test_helper.rb": `module ActiveSupport\n  class TestCase\n    def freeze_time; end\n  end\nend\n`,
      "config/initializers/rls_safety.rb":
        `ActiveSupport.on_load(:active_record) do\n  puts "safe"\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        edgesTo(g, "test/test_helper.rb#ActiveSupport").map((e) => e.source),
        [],
        "a production initializer must not be reported as depending on the test helper",
      );
    },
  );
});

// ---- guards: the rule is a list of foreign constants, not a rule about paths ----

test("the namespace still resolves, so ActiveSupport::TestCase keeps working", async () => {
  // The decline is scoped to the mode that puts an EDGE on the answer. Resolving a
  // NAMESPACE on the way to a nested constant asks a different question, and every
  // Rails test in the world depends on the answer.
  await withGraph(
    {
      ...RAILS,
      "test/test_helper.rb": `module ActiveSupport\n  class TestCase\n    def freeze_time; end\n  end\nend\n`,
      "test/models/user_test.rb": `class UserTest < ActiveSupport::TestCase\n  def test_it; end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        g.edges
          .filter((e) => e.source === "test/models/user_test.rb#UserTest" && e.relation === "extends")
          .map((e) => e.target),
        ["test/test_helper.rb#ActiveSupport.TestCase"],
      );
    },
  );
});

test("the file that reopens it may still refer to it", async () => {
  await withGraph(
    {
      ...RAILS,
      "config/initializers/string_truncate_bytes.rb":
        `class String\n  def truncate_bytes(limit)\n    byteslice(0, limit)\n  end\nend\n` +
        `RETURNS = String\n`,
    },
    (g) => {
      const same = edgesTo(g, "config/initializers/string_truncate_bytes.rb#String");
      assert.ok(same.length > 0, "a same-file reference is read from source, not guessed");
      assert.ok(same.every((e) => e.confidence === "extracted"), "and stays `extracted`");
    },
  );
});

test("a top-level constant at its autoload home is the application's own", async () => {
  // `app/models/set.rb` declaring `Set` shadows the stdlib deliberately, and Ruby
  // agrees. Zeitwerk is the authority in a Rails app and it says this file owns it.
  await withGraph(
    {
      ...RAILS,
      "app/models/set.rb": `class Set\n  def add(x); end\nend\n`,
      "app/models/user.rb": `class User\n  def go\n    Set.new\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        edgesTo(g, "app/models/set.rb#Set").map((e) => e.source),
        ["app/models/user.rb#User.go"],
      );
    },
  );
});

test("a file named for the constant is its own, with or without an autoloader", async () => {
  // No Rails here, so there is no autoload map to consult. The naming convention
  // every Ruby project follows stands in: `lib/set.rb` is allowed to be about `Set`,
  // and `string_truncate_bytes.rb` is not about `String`.
  await withGraph(
    {
      "lib/set.rb": `class Set\n  def add(x); end\nend\n`,
      "lib/user.rb": `class User\n  def go\n    Set.new\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(edgesTo(g, "lib/set.rb#Set").map((e) => e.source), ["lib/user.rb#User.go"]);
    },
  );
});

test("a namespaced constant is never foreign, however its last segment reads", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/services/entitlements/set.rb": `module Entitlements\n  class Set\n    def add(x); end\n  end\nend\n`,
      "app/services/entitlements/resolver.rb":
        `module Entitlements\n  class Resolver\n    def resolve\n      Set.new\n    end\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        edgesTo(g, "app/services/entitlements/set.rb#Entitlements.Set").map((e) => e.source),
        ["app/services/entitlements/resolver.rb#Entitlements.Resolver.resolve"],
        "`Set` inside `module Entitlements` is Entitlements::Set, and the repository owns it",
      );
    },
  );
});

test("a constant the repository owns survives a file that does not name it", async () => {
  // `db/seeds/support.rb` really does define `StructuredSeeds`, and no rule about
  // file paths can know that. Measured on dailywerk, a path rule dropped 17 correct
  // edges like this one to remove 3 more wrong ones. This is why the rule is a list.
  await withGraph(
    {
      ...RAILS,
      "db/seeds/support.rb": `module StructuredSeeds\n  def self.price; 1; end\nend\n`,
      "db/seeds/agents.seeds.rb": `StructuredSeeds.price\n`,
    },
    (g) => {
      assert.ok(
        edgesTo(g, "db/seeds/support.rb#StructuredSeeds").length > 0,
        "the file is named `support`, the constant is not, and it is still the repo's",
      );
    },
  );
});

test("framework names are only foreign where a framework is detected", async () => {
  // `Rails` in a repo with no Gemfile naming rails is just a constant someone chose.
  await withGraph(
    {
      "lib/boot.rb": `module Rails\n  def self.env; "test"; end\nend\n`,
      "lib/runner.rb": `class Runner\n  def go\n    Rails.env\n  end\nend\n`,
    },
    (g) => {
      assert.deepEqual(
        edgesTo(g, "lib/boot.rb#Rails").map((e) => e.source),
        ["lib/runner.rb#Runner.go"],
      );
    },
  );
});

// ------------------------------------------------ gem-owned constants, from the lockfile

/**
 * The closed lists name Ruby's core and Rails' own namespaces. A repository reopens
 * gem constants too — an initializer patching `I18n`, `lib/patches/` patching `Aws`
 * — and those collected every reference to the gem: 734 for one `I18n` initializer
 * in a held-out application, and 58 on dailywerk, where `app/models/ruby_llm/
 * model_record.rb` opens `module RubyLLM` only to nest a model while every source
 * that names `RubyLLM` is calling the gem. The lockfile says which top-level
 * constants gems provide, by the naming convention.
 */
const LOCKED = (gems: string) => `GEM\n  remote: https://rubygems.org/\n  specs:\n${gems}\nPLATFORMS\n  ruby\n`;

test("a reopened gem constant is not the repository's definition", async () => {
  await withGraph(
    {
      ...RAILS,
      "Gemfile.lock": LOCKED(`    kaminari (1.2)\n    rails (7.1.0)\n      activesupport (= 7.1.0)\n`),
      "config/initializers/kaminari_extra.rb": `module Kaminari\n  EXTRA = 1\nend\n`,
      "app/services/search.rb": `class Search\n  def go\n    Kaminari.paginate_array([])\n  end\nend\n`,
    },
    (g) => assert.deepEqual(edgesTo(g, "config/initializers/kaminari_extra.rb#Kaminari").map((e) => e.source), []),
  );
});

test("a hyphenated gem name owns its first segment", async () => {
  await withGraph(
    {
      ...RAILS,
      "Gemfile.lock": LOCKED(`    aws-sdk-s3 (1.1)\n`),
      "lib/aws_ext.rb": `module Aws\n  QUIET = true\nend\n`,
      "app/services/store.rb": `class Store\n  def go\n    Aws.config\n  end\nend\n`,
    },
    (g) => assert.deepEqual(edgesTo(g, "lib/aws_ext.rb#Aws").map((e) => e.source), []),
  );
});

test("a subclass of a patched core class extends the external name, not the patch", async () => {
  // The constant resolver declined, and the bare-name ladder then found the same
  // reopening by unique name. What it extends is Ruby's Hash.
  await withGraph(
    {
      ...RAILS,
      "lib/patches/hash_ext.rb": `class Hash\n  def blank_leaves? = false\nend\n`,
      "app/models/envelope.rb": `class Envelope < Hash\nend\n`,
    },
    (g) => {
      const ext = g.edges.filter((e) => e.source === "app/models/envelope.rb#Envelope" && e.relation === "extends");
      assert.deepEqual(ext.map((e) => e.target), ["Hash"]);
    },
  );
});

test("a gem-named constant the repository owns at its autoload home still resolves", async () => {
  await withGraph(
    {
      ...RAILS,
      "Gemfile.lock": LOCKED(`    widget (1.0)\n`),
      "app/models/widget.rb": `class Widget\nend\n`,
      "app/services/maker.rb": `class Maker\n  def go\n    Widget.new\n  end\nend\n`,
    },
    (g) => assert.deepEqual(edgesTo(g, "app/models/widget.rb#Widget").map((e) => e.source), ["app/services/maker.rb#Maker.go"]),
  );
});

test("a locked gem's own dependency lines are read as the gems they are, nothing more", async () => {
  // Six-space lines under a spec are that gem's dependencies; only the four-space
  // spec lines name gems. `tenancy` appears only as a dependency here.
  await withGraph(
    {
      ...RAILS,
      "Gemfile.lock": LOCKED(`    rails (7.1.0)\n      tenancy (>= 1)\n`),
      "config/initializers/tenancy.rb": `module Tenancy\n  def self.on = true\nend\n`,
      "app/services/maker.rb": `class Maker\n  def go\n    Tenancy.on\n  end\nend\n`,
    },
    (g) => assert.deepEqual(edgesTo(g, "config/initializers/tenancy.rb#Tenancy").map((e) => e.source), ["app/services/maker.rb#Maker.go"]),
  );
});

test("without a lockfile a reopened gem constant resolves as it always did", async () => {
  await withGraph(
    {
      ...RAILS,
      "config/initializers/kaminari_extra.rb": `module Kaminari\n  EXTRA = 1\nend\n`,
      "app/services/search.rb": `class Search\n  def go\n    Kaminari.paginate_array([])\n  end\nend\n`,
    },
    (g) => assert.deepEqual(edgesTo(g, "config/initializers/kaminari_extra.rb#Kaminari").map((e) => e.source), ["app/services/search.rb#Search.go"]),
  );
});
