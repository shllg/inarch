/**
 * A method the repository adds to a core class, reached from its callers.
 *
 * `config/initializers/string_truncate_bytes.rb` defines `String#truncate_bytes`.
 * Four files call it. None of them had an edge to it, while — before docs/39 — 76
 * files that merely named `String` in an `is_a?` check did. The dependency was
 * reported backwards, and removing the wrong half left the right half empty.
 *
 * "Who calls this monkey patch" is the hardest question to answer by grep, because
 * the method name is the only clue and nothing at the call site names the file.
 *
 * The mechanism is one change: `rubyExprType` learns core classes. Everything else
 * already existed — locals are typed from their assignment, chains walk, and a
 * method whose exits agree declares its return type. The blast radius is bounded by
 * construction: a receiver typed `String` can only reach methods the repository
 * itself defines on `String`, which is one method in dailywerk and none in filewerk.
 *
 * Measured on dailywerk at `3fabcfa1`: **+3 edges, 0 lost, nodes identical.**
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
const BASE = {
  Gemfile: `source "https://rubygems.org"\ngem "rails", "~> 7.1"\n`,
  "config/application.rb":
    `require "rails/all"\nmodule Dummy\n  class Application < Rails::Application; end\nend\n`,
  [PATCH]: `class String\n  def truncate_bytes(limit)\n    byteslice(0, limit)\n  end\nend\n`,
};

async function withGraph(files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-core-"));
  try {
    for (const [name, content] of Object.entries({ ...BASE, ...files })) {
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

/** Does `source` reach the monkey patch? */
const patched = (g: GraphV1, source: string): boolean =>
  g.edges.some((e) => e.source === source && e.relation === "calls" && e.target === `${PATCH}#String.truncate_bytes`);

const svc = (body: string) => ({ "app/services/thing.rb": `class Thing\n${body}\nend\n` });

// ------------------------------------------------------------------ the milestone

test("a string literal names its own class", async () => {
  await withGraph(svc(`  def go\n    "hello".truncate_bytes(3)\n  end`), (g) => {
    assert.ok(patched(g, "app/services/thing.rb#Thing.go"));
  });
});

test("to_s is a String whoever the receiver is", async () => {
  await withGraph(svc(`  def go(value)\n    value.to_s.truncate_bytes(3)\n  end`), (g) => {
    assert.ok(patched(g, "app/services/thing.rb#Thing.go"));
  });
});

test("a core class method with a fixed return types its result", async () => {
  await withGraph(svc(`  def go(path)\n    File.read(path).truncate_bytes(3)\n  end`), (g) => {
    assert.ok(patched(g, "app/services/thing.rb#Thing.go"));
  });
});

test("a core step on a typed local collapses rather than becoming a chain step", async () => {
  // `String#scrub` is not a node in this repository, so left as a step the walk
  // would look for it, find nothing, and drop the whole call.
  await withGraph(svc(`  def go(path)\n    raw = File.read(path)\n    raw.scrub.truncate_bytes(3)\n  end`), (g) => {
    assert.ok(patched(g, "app/services/thing.rb#Thing.go"));
  });
});

test("join with a string separator is a String, whatever the receiver is", async () => {
  await withGraph(svc(`  def go(doc)\n    doc.paragraphs.map(&:text).join("\\n").truncate_bytes(3)\n  end`), (g) => {
    assert.ok(patched(g, "app/services/thing.rb#Thing.go"));
  });
});

// ------------------------------------------------------------------ guards

test("join without a string literal separator declines", async () => {
  // The literal IS the evidence. `Thread#join` takes a numeric timeout, and a
  // separator this pass cannot read leaves the two indistinguishable.
  await withGraph(svc(`  def go(parts, sep)\n    parts.join(sep).truncate_bytes(3)\n  end`), (g) => {
    assert.equal(patched(g, "app/services/thing.rb#Thing.go"), false);
  });
});

test("a repository's own method named for a core one does not type its result", async () => {
  // The precision argument for keeping the receiver in the table key. dailywerk
  // defines `strip`, `scrub`, `read` and `split` on its own classes; a table keyed
  // on the bare method name would have called every one of them a String.
  await withGraph(
    {
      "app/services/normalizer.rb": `class Normalizer\n  def self.strip(v)\n    v\n  end\nend\n`,
      ...svc(`  def go(value)\n    Normalizer.strip(value).truncate_bytes(3)\n  end`),
    },
    (g) => assert.equal(patched(g, "app/services/thing.rb#Thing.go"), false),
  );
});

test("a core method on an UNTYPED receiver declines", async () => {
  await withGraph(svc(`  def go(bytes)\n    bytes.scrub.truncate_bytes(3)\n  end`), (g) => {
    assert.equal(patched(g, "app/services/thing.rb#Thing.go"), false);
  });
});

test("a repository class receiver still resolves exactly as before", async () => {
  await withGraph(
    {
      "app/models/widget.rb": `class Widget\n  def shiny?\n    true\n  end\nend\n`,
      ...svc(`  def go\n    w = Widget.new\n    w.shiny?\n  end`),
    },
    (g) => {
      assert.ok(
        g.edges.some((e) =>
          e.source === "app/services/thing.rb#Thing.go" && e.relation === "calls" &&
          e.target === "app/models/widget.rb#Widget.shiny?"),
      );
    },
  );
});

test("with no patch on the core class, a typed receiver produces nothing at all", async () => {
  // The bound on the whole milestone: core typing cannot invent an edge, because
  // there is nothing in the repository for a `String` receiver to reach.
  await withGraph(
    { [PATCH]: `# no patch here\n`, ...svc(`  def go(v)\n    v.to_s.strip.length\n  end`) },
    (g) => {
      const out = g.edges.filter((e) => e.source === "app/services/thing.rb#Thing.go" && e.relation === "calls");
      assert.deepEqual(out, []);
    },
  );
});
