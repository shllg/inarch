/**
 * A `def` inside a block is not a top-level method.
 *
 * RSpec writes helpers as `def` inside `RSpec.describe … do`, and Ruby makes each
 * one a method on that example group — reachable from inside the group, or from a
 * group that includes the shared context it came from. Extraction mints it as a free
 * function (there is no class to name), and the repo-wide unique-name tier then
 * bound every bare call of that name, anywhere, to it: every `context "…" do` in a
 * suite to one spec's own helper named `context`, a `delete "…"` route in
 * config/routes.rb to a spec's `def delete`.
 *
 * Measured: a held-out RSpec application lost 2,836 of its 2,839 Ruby
 * `calls/inferred` edges and gained none; filewerk lost 32 — the `root_path`,
 * `name` and `metadata` helpers the M4 comment in resolve.ts already named, fenced
 * off there for templates only; dailywerk (Minitest, helpers inside classes) did not
 * move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1 } from "../src/graph/types.js";

async function withGraph(files: Record<string, string>, body: (g: GraphV1) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-blockdef-"));
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

const callsFrom = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e) => e.source === source && e.relation === "calls").map((e) => e.target).sort();

const ROUTER = { "app/services/router.rb": `class Router\n  def go\n    render_it\n  end\nend\n` };

test("a bare call in another file does not bind to a def inside an RSpec block", async () => {
  await withGraph(
    { ...ROUTER, "spec/a_spec.rb": `RSpec.describe "A" do\n  def render_it\n    1\n  end\nend\n` },
    (g) => assert.deepEqual(callsFrom(g, "app/services/router.rb#Router.go"), []),
  );
});

test("nor to a def in `class << self` inside an anonymous Class.new block", async () => {
  // `class << self` names no owner here — the class is anonymous — so it must not
  // end the walk the way a named class does.
  await withGraph(
    {
      ...ROUTER,
      "spec/b_spec.rb":
        `RSpec.describe "B" do\n  let(:k) do\n    Class.new do\n      class << self\n        def render_it\n          1\n        end\n      end\n    end\n  end\nend\n`,
    },
    (g) => assert.deepEqual(callsFrom(g, "app/services/router.rb#Router.go"), []),
  );
});

// ---------------------------------------------------------------- guards

test("the block's own file still reaches its helper", async () => {
  await withGraph(
    {
      "spec/c_spec.rb":
        `RSpec.describe "C" do\n  def helper\n    1\n  end\n\n  def uses\n    helper\n  end\nend\n`,
    },
    (g) => assert.deepEqual(callsFrom(g, "spec/c_spec.rb#uses"), ["spec/c_spec.rb#helper"]),
  );
});

test("a true top-level def is still a top-level method", async () => {
  // In Ruby a file-level `def` becomes a private method on Object, callable from
  // anywhere once loaded — the one case the unique-name tier legitimately answers.
  await withGraph(
    {
      "config/initializers/console.rb": `def render_it\n  1\nend\n`,
      ...ROUTER,
    },
    (g) => assert.deepEqual(callsFrom(g, "app/services/router.rb#Router.go"), ["config/initializers/console.rb#render_it"]),
  );
});

test("a block-scoped twin no longer makes a real top-level def ambiguous", async () => {
  // Two function nodes named `render_it` used to be two global candidates, and the
  // real one declined. The block-scoped one never was a candidate.
  await withGraph(
    {
      "config/initializers/console.rb": `def render_it\n  1\nend\n`,
      "spec/d_spec.rb": `RSpec.describe "D" do\n  def render_it\n    2\n  end\nend\n`,
      ...ROUTER,
    },
    (g) => assert.deepEqual(callsFrom(g, "app/services/router.rb#Router.go"), ["config/initializers/console.rb#render_it"]),
  );
});
