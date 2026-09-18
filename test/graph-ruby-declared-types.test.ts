/**
 * Declared return and parameter types, read the way the resolver actually needs them.
 *
 * Two changes, pinned together because they answer one question — what does this
 * value hold — from two sources.
 *
 * 1. The return-type table resolved the returned constant asking for a NODE, while
 *    everything it feeds only needs a constant PATH. So two declines meant for edges
 *    vetoed types that were never in doubt: a method returning a String in a
 *    repository that patches String got no return type (the foreign-constant decline
 *    of docs/39), and one returning a class reopened in two files got none either.
 *
 * 2. YARD `@param x [String]` and `@return [String]`, for core classes only. dailywerk
 *    tags nearly every method, and two of its `truncate_bytes` call sites are
 *    reachable through nothing else. Bounded like the core-receiver tables: a value
 *    typed `String` can only reach what the repository itself defines on `String`.
 *
 * Measured on dailywerk at `3fabcfa1`: change 1 moves nothing there; change 2 adds
 * the 2 edges and loses none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

const PATCH = "config/initializers/string_patch.rb";
const RAILS = {
  Gemfile: `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb":
    `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
  [PATCH]: `class String\n  def truncate_bytes(limit)\n    byteslice(0, limit)\n  end\nend\n`,
};

async function withGraph(files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-declared-"));
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

const calls = (g: GraphV1, source: string, target: string): boolean =>
  g.edges.some((e) => e.source === source && e.relation === "calls" && e.target === target);
const PATCHED = `${PATCH}#String.truncate_bytes`;
const svc = (body: string) => ({ ...RAILS, "app/services/thing.rb": `class Thing\n${body}\nend\n` });
const GO = "app/services/thing.rb#Thing.go";

// ------------------------------------------------ 1. a return type is a constant path

test("a method returning a String chains, though the repository patches String", async () => {
  await withGraph(
    svc(`  def go(v)\n    normalize(v).truncate_bytes(3)\n  end\n\n  def normalize(v)\n    v.to_s.strip\n  end`),
    (g) => assert.ok(calls(g, GO, PATCHED)),
  );
});

test("a method returning a class reopened in two files still declares it", async () => {
  // No Rails, so no autoload map to pick a home: as a NODE this is a genuine two-way
  // choice and declines; as a constant PATH there was never any doubt.
  await withGraph(
    {
      "lib/widget.rb": `class Widget\n  def shiny? = true\nend\n`,
      "lib/widget_extras.rb": `class Widget\n  def dull? = false\nend\n`,
      "lib/maker.rb": `class Maker\n  def build\n    Widget.new\n  end\n\n  def go\n    build.shiny?\n  end\nend\n`,
    },
    (g) => assert.ok(calls(g, "lib/maker.rb#Maker.go", "lib/widget.rb#Widget.shiny?")),
  );
});

// ------------------------------------------------ 2. YARD tags naming a core class

test("@param types a parameter the body never assigns", async () => {
  await withGraph(
    svc(`  # @param bytes [String]\n  def go(bytes)\n    bytes.scrub.truncate_bytes(3)\n  end`),
    (g) => assert.ok(calls(g, GO, PATCHED)),
  );
});

test("@param with nil beside the class still types it", async () => {
  await withGraph(
    svc(`  # @param text [String, nil]\n  def go(text)\n    text.truncate_bytes(3)\n  end`),
    (g) => assert.ok(calls(g, GO, PATCHED)),
  );
});

test("@return declares what a body built on an opaque helper returns", async () => {
  // `helper(v)` is untyped, so the body settles nothing — the tag is the only answer.
  await withGraph(
    {
      ...RAILS,
      "app/services/normalizer.rb":
        `class Normalizer\n  # @return [String]\n  def self.clean(v)\n    helper(v).strip\n  end\nend\n`,
      "app/services/thing.rb": `class Thing\n  def go(v)\n    Normalizer.clean(v).truncate_bytes(3)\n  end\nend\n`,
    },
    (g) => assert.ok(calls(g, GO, PATCHED)),
  );
});

// ------------------------------------------------ guards

test("a union of two classes is not a type", async () => {
  await withGraph(
    svc(`  # @param v [String, Symbol]\n  def go(v)\n    v.truncate_bytes(3)\n  end`),
    (g) => assert.equal(calls(g, GO, PATCHED), false),
  );
});

test("two @return tags are two answers, and neither is taken", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/services/normalizer.rb":
        `class Normalizer\n  # @return [String] when found\n  # @return [Integer] otherwise\n  def self.clean(v)\n    helper(v)\n  end\nend\n`,
      "app/services/thing.rb": `class Thing\n  def go(v)\n    Normalizer.clean(v).truncate_bytes(3)\n  end\nend\n`,
    },
    (g) => assert.equal(calls(g, GO, PATCHED), false),
  );
});

test("the body outranks the tag", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/widget.rb": `class Widget\n  def shiny? = true\nend\n`,
      "app/services/thing.rb":
        `class Thing\n  # @return [String]\n  def build\n    Widget.new\n  end\n\n  def go\n    build.shiny?\n  end\n\n  def no\n    build.truncate_bytes(3)\n  end\nend\n`,
    },
    (g) => {
      assert.ok(calls(g, GO, "app/models/widget.rb#Widget.shiny?"));
      assert.equal(calls(g, "app/services/thing.rb#Thing.no", PATCHED), false);
    },
  );
});

test("a splat parameter is not typed by a tag about its elements", async () => {
  await withGraph(
    svc(`  # @param parts [String]\n  def go(*parts)\n    parts.truncate_bytes(3)\n  end`),
    (g) => assert.equal(calls(g, GO, PATCHED), false),
  );
});

test("a collection tag leaves the parameter untyped", async () => {
  // Measured: typing `@param tool_calls [Array<ToolCall>]` cost dailywerk exactly the
  // 2 ruby_injection edges that read block-self from an untyped Array parameter.
  await withGraph(
    {
      ...RAILS,
      "config/initializers/array_patch.rb": `class Array\n  def tally_up = size\nend\n`,
      "app/services/thing.rb": `class Thing\n  # @param items [Array<String>]\n  def go(items)\n    items.tally_up\n  end\nend\n`,
    },
    (g) => assert.equal(calls(g, GO, "config/initializers/array_patch.rb#Array.tally_up"), false),
  );
});

test("a tag naming an application class types nothing", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/widget.rb": `class Widget\n  def shiny? = true\nend\n`,
      "app/services/thing.rb": `class Thing\n  # @param w [Widget]\n  def go(w)\n    w.shiny?\n  end\nend\n`,
    },
    (g) => assert.equal(calls(g, GO, "app/models/widget.rb#Widget.shiny?"), false),
  );
});

// ------------------------------------------------ 3. endless defs

test("an endless def declares what its expression returns", async () => {
  // `def build = Widget.new`: the body field is the expression itself, not a
  // body_statement, so the result-path walk found no exit. 91 in dailywerk.
  await withGraph(
    {
      ...RAILS,
      "app/models/widget.rb": `class Widget\n  def shiny? = true\nend\n`,
      "app/services/thing.rb": `class Thing\n  def build = Widget.new\n\n  def go\n    build.shiny?\n  end\nend\n`,
    },
    (g) => assert.ok(calls(g, GO, "app/models/widget.rb#Widget.shiny?")),
  );
});

test("an endless def returning something unreadable declares nothing", async () => {
  await withGraph(
    {
      ...RAILS,
      "app/models/widget.rb": `class Widget\n  def shiny? = true\nend\n`,
      "app/services/thing.rb": `class Thing\n  def build = helper.thing\n\n  def go\n    build.shiny?\n  end\nend\n`,
    },
    (g) => assert.equal(calls(g, GO, "app/models/widget.rb#Widget.shiny?"), false),
  );
});
