/**
 * A namespace wrapper is not a definition either.
 *
 * The mirror image of the reopened-constant defect. There, a file reopening a
 * constant the repository does not own collected every reference to the real one.
 * Here the reopening is in the SAME file as the reference, and `pickRubyConstant`
 * preferred it over the constant's autoload home:
 *
 *     # app/services/turn_provenance/classifier.rb
 *     class TurnProvenance          # <- opened only to nest the class below
 *       class Classifier
 *         def classify(m) = TurnProvenance.from_metadata(m)
 *       end
 *     end
 *
 * `from_metadata` lives in `app/services/turn_provenance.rb`, which Zeitwerk names
 * as the file that defines `TurnProvenance`. The edge pointed at the two-line
 * wrapper instead, which contains none of it.
 *
 * Measured on dailywerk at `3fabcfa1`: 21 edges, 18 `references` and 3 `extends`.
 * The `extends` half is the sharper one — `Intake::Webhook < Intake` is Rails STI,
 * and the answer to "what does it inherit from" was a namespace stub rather than
 * the 240-line model.
 *
 * The cause is branch ORDER, not a missing rule. `pickRubyConstant` already
 * consults the autoload map; it just did so only after the same-file branch had
 * already returned. The fix moves the map in front, and the tests after the two
 * declines pin every case where same-file must still win.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-nswrap-"));
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

const edge = (g: GraphV1, source: string, relation: string): EdgeV1 | undefined =>
  g.edges.find((e) => e.source === source && e.relation === relation);

/** `app/models/intake.rb` is where Zeitwerk says `Intake` is defined. */
const STI = {
  ...RAILS,
  "app/models/intake.rb":
    `class Intake < ApplicationRecord\n` +
    `  def self.from_token(t)\n    find_by(token: t)\n  end\n` +
    `end\n`,
  "app/models/intake/webhook.rb":
    `class Intake\n` +
    `  class Webhook < Intake\n` +
    `    def resolve\n      Intake.from_token(token)\n    end\n` +
    `  end\n` +
    `end\n`,
};

test("STI inheritance names the model, not the namespace wrapper beside it", async () => {
  await withGraph(STI, (g) => {
    const e = edge(g, "app/models/intake/webhook.rb#Intake.Webhook", "extends");
    assert.ok(e, "Intake::Webhook must extend something");
    assert.equal(e.target, "app/models/intake.rb#Intake");
  });
});

test("a call on the enclosing constant reaches the file that defines it", async () => {
  await withGraph(STI, (g) => {
    const e = edge(g, "app/models/intake/webhook.rb#Intake.Webhook.resolve", "references");
    assert.ok(e, "resolve must reference Intake");
    assert.equal(e.target, "app/models/intake.rb#Intake");
    assert.equal(e.confidence, "inferred");
  });
});

// ---------------------------------------------------------------- guards

test("the autoload home referring to itself stays same-file and extracted", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/services/tenancy.rb":
        `module Tenancy\n` +
        `  def self.bypass? = false\n` +
        `  def self.check = Tenancy.bypass?\n` +
        `end\n`,
    },
    (g) => {
      const e = edge(g, "app/services/tenancy.rb#Tenancy.check", "references");
      assert.ok(e);
      assert.equal(e.target, "app/services/tenancy.rb#Tenancy");
      assert.equal(e.confidence, "extracted");
    },
  );
});

test("without Rails there is no autoload map, so same-file still wins", async () => {
  await withGraph(
    {
      "lib/thing.rb": `module Thing\n  def self.go = 1\nend\n`,
      "lib/thing/part.rb":
        `module Thing\n  class Part\n    def run = Thing.go\n  end\nend\n`,
    },
    (g) => {
      const e = edge(g, "lib/thing/part.rb#Thing.Part.run", "references");
      assert.ok(e);
      assert.equal(e.target, "lib/thing/part.rb#Thing");
    },
  );
});

test("a constant with no autoload home anywhere keeps its same-file reopening", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/services/alpha/one.rb":
        `module Helpers\n  class One\n    def run = Helpers.go\n  end\nend\n`,
      "app/services/alpha/two.rb": `module Helpers\n  class Two; end\nend\n`,
    },
    (g) => {
      const e = edge(g, "app/services/alpha/one.rb#Helpers.One.run", "references");
      assert.ok(e);
      assert.equal(e.target, "app/services/alpha/one.rb#Helpers");
      assert.equal(e.confidence, "extracted");
    },
  );
});

test("a nested constant resolves to its own home, not its parent's", async () => {
  await withGraph(STI, (g) => {
    const contains = g.edges.filter(
      (e) => e.relation === "contains" && e.target === "app/models/intake/webhook.rb#Intake.Webhook",
    );
    assert.equal(contains.length, 1);
    assert.equal(contains[0].source, "app/models/intake/webhook.rb#Intake");
  });
});

test("the home file is still reachable as a call target", async () => {
  await withGraph(STI, (g) => {
    const e = g.edges.find(
      (x) =>
        x.source === "app/models/intake/webhook.rb#Intake.Webhook.resolve" &&
        x.relation === "calls" &&
        x.target === "app/models/intake.rb#Intake.from_token",
    );
    assert.ok(e, "the receiver-typed call must still land on the real method");
  });
});

test("two reopenings inside the home file itself stay in document order", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/services/pair.rb":
        `module Pair\n  def self.go = 1\nend\n` +
        `module Pair\n  class Inner\n    def run = Pair.go\n  end\nend\n`,
    },
    (g) => {
      const e = edge(g, "app/services/pair.rb#Pair.Inner.run", "references");
      assert.ok(e);
      assert.equal(e.target, "app/services/pair.rb#Pair");
      assert.equal(e.confidence, "extracted");
    },
  );
});
