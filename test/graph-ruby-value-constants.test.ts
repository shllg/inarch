/**
 * `Session::INTERNAL_GATEWAY` depends on `Session`.
 *
 * A value constant is not a node — `INTERNAL_GATEWAY = "internal"` defines a string,
 * not a symbol — so a qualified reference to one resolved to nothing, and the class
 * that declares it went with it. `dw-h11-045` recorded the symptom as "constants in
 * a `when` clause emit no reference"; the probe showed `when` was incidental and
 * `g == Session::INTERNAL` dropped the same way.
 *
 * The fix points one reference at the class or module whose body declares the value,
 * found through the head's ancestry the way Ruby looks it up. The rule that emits
 * only a path's TERMINAL stays: for `Billing::Invoice` the head would be a second
 * answer bolted onto a right one. For a value there is no first answer.
 *
 * It also reaches `ToolCall = Data.define(...)`, a class built by a call, which mints
 * no node — `dw-h11-043` recorded that absence.
 *
 * Measured at `3fabcfa1`/filewerk: dailywerk +614, filewerk +179, nothing lost;
 * 20/20 and 15/15 sampled edges verified against both the use and the declaration.
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
  const dir = mkdtempSync(join(tmpdir(), "graft-ruby-values-"));
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

const refs = (g: GraphV1, source: string): string[] =>
  g.edges.filter((e) => e.source === source && e.relation === "references").map((e) => e.target).sort();

const SESSION = { "app/models/session.rb": `class Session\n  INTERNAL = "internal"\nend\n` };
const router = (body: string) => ({ ...SESSION, "app/services/router.rb": `class Router\n  def go(g)\n${body}\n  end\nend\n` });
const GO = "app/services/router.rb#Router.go";

test("a value constant in a when clause references its declaring class", async () => {
  await withGraph(router(`    case g\n    when Session::INTERNAL then 1\n    end`), (g) => {
    assert.deepEqual(refs(g, GO), ["app/models/session.rb#Session"]);
  });
});

test("the same value constant in a comparison references it too", async () => {
  await withGraph(router(`    g == Session::INTERNAL`), (g) => {
    assert.deepEqual(refs(g, GO), ["app/models/session.rb#Session"]);
  });
});

test("a class built by Data.define is reached through the class declaring it", async () => {
  await withGraph(
    {
      "app/services/runtime.rb": `class Runtime\n  ToolCall = Data.define(:id, :name)\nend\n`,
      "app/services/router.rb": `class Router\n  def go\n    Runtime::ToolCall.new(id: 1, name: "x")\n  end\nend\n`,
    },
    (g) => assert.deepEqual(refs(g, GO), ["app/services/runtime.rb#Runtime"]),
  );
});

test("an inherited value constant is found on the ancestor that declares it", async () => {
  await withGraph(
    {
      "app/models/base.rb": `class Base\n  LIMIT = 10\nend\n`,
      "app/models/child.rb": `class Child < Base\nend\n`,
      "app/services/router.rb": `class Router\n  def go\n    Child::LIMIT\n  end\nend\n`,
    },
    (g) => assert.deepEqual(refs(g, GO), ["app/models/base.rb#Base"]),
  );
});

// ---------------------------------------------------------------- guards

test("a qualified CLASS still references only its terminal", async () => {
  await withGraph(
    {
      "app/models/billing.rb": `module Billing\nend\n`,
      "app/models/billing/invoice.rb": `module Billing\n  class Invoice\n  end\nend\n`,
      "app/services/router.rb": `class Router\n  def go\n    Billing::Invoice.new\n  end\nend\n`,
    },
    (g) => assert.deepEqual(refs(g, GO), ["app/models/billing/invoice.rb#Billing.Invoice"]),
  );
});

test("a constant the repository never declares references nothing", async () => {
  await withGraph(router(`    g == Session::NOT_DECLARED_ANYWHERE`), (g) => assert.deepEqual(refs(g, GO), []));
});

test("a gem constant references nothing", async () => {
  await withGraph(router(`    g == Faraday::VERSION`), (g) => assert.deepEqual(refs(g, GO), []));
});

test("a value declared in two class bodies is a choice, and declines", async () => {
  await withGraph(
    {
      "app/models/session.rb": `class Session\n  INTERNAL = "a"\nend\n`,
      "app/models/session_extras.rb": `class Session\n  INTERNAL = "b"\nend\n`,
      "app/services/router.rb": `class Router\n  def go(g)\n    g == Session::INTERNAL\n  end\nend\n`,
    },
    (g) => assert.deepEqual(refs(g, GO), []),
  );
});

test("a value assigned from outside any class body has no owner to point at", async () => {
  await withGraph(
    {
      "app/models/session.rb": `class Session\nend\n`,
      "config/initializers/session_values.rb": `Session::INTERNAL = "x"\n`,
      "app/services/router.rb": `class Router\n  def go(g)\n    g == Session::INTERNAL\n  end\nend\n`,
    },
    (g) => assert.deepEqual(refs(g, GO), []),
  );
});
