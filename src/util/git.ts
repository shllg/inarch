/**
 * Running git for its OUTPUT, with the settings that would otherwise rewrite it.
 *
 * Every caller here parses what git prints, so anything a user can configure that
 * changes the shape of that text is a correctness problem rather than a preference.
 * The four documented `blast.test.ts` failures were exactly this, carried as
 * furniture since before the fork and blamed on the fixture: `diff.mnemonicPrefix`
 * replaces the `a/`…`b/` pair with mnemonic letters — `c/` for a commit, `i/` for the
 * index, `w/` for the worktree — so a header reads
 *
 *     +++ w/src/math.ts
 *
 * The hunk parser strips `b/`, kept `w/src/math.ts`, matched it against no file from
 * the name-status pass, and attached the hunk to nothing. With no line ranges the
 * blast seeder falls back to whole-file seeding, so an edit to one function reported
 * the whole file and then walked `imports` instead of `calls`. The command did not
 * fail; it answered a coarser question, and a coarser answer from an impact tool is
 * the failure mode this project exists to prevent.
 *
 * Pinning beats parsing. Teaching the parser about mnemonic prefixes would still
 * leave `diff.noprefix`, `diff.srcPrefix` and `diff.dstPrefix`, and a custom prefix
 * is an arbitrary string — there is no way to tell where it ends and the path
 * begins. Forcing the values removes the variable instead of enumerating it.
 *
 * `-c` rather than a flag because it works on every git: `--default-prefix` arrived
 * in 2.45, and `color.ui` has no per-command equivalent that covers `git log`.
 * Unknown keys are inert on older versions.
 */
import { spawnSync } from "node:child_process";

const PINNED = [
  // Paths are printed raw; the callers here handle UTF-8 and `-z` themselves.
  "core.quotePath=false",
  // The prefix pair, from every direction it can be changed.
  "diff.mnemonicPrefix=false",
  "diff.noprefix=false",
  "diff.srcPrefix=a/",
  "diff.dstPrefix=b/",
  // `color.ui=always` emits ANSI through a pipe. `--no-color` covers the patch pass
  // and nothing covers `git log`, so it is pinned once here for all of them.
  "color.ui=false",
].flatMap((setting) => ["-c", setting]);

/**
 * Run git in `root` and return stdout, or null when git fails — not a repo, no
 * git, an unknown ref. A failure is never distinguished from empty output by the
 * callers, so it must not be returned as one.
 */
export function runGit(root: string, args: string[]): string | null {
  const res = spawnSync("git", [...PINNED, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  return res.stdout;
}
