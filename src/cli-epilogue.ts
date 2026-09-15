/**
 * `inarch init`'s closing epilogue: the ASCII wordmark + numbered next steps,
 * printed to stderr after the per-file ✓/·/⚠ lines. Extracted out of cli.ts
 * so the exact text — spacing is hand-aligned, not incidental — can be
 * unit-tested without spawning the CLI.
 */

// The widest line (index 4, tied with index 3 at 37 chars) gets the live
// node/edge stats appended, when a graph exists.
const WORDMARK_LINES = [
  "   _                           _",
  "  (_) _ __    __ _  _ __  ___ | |__",
  "  | || '_ \\  / _` || '__|/ __|| '_ \\",
  "  | || | | || (_| || |  | (__ | | | |",
  "  |_||_| |_| \\__,_||_|   \\___||_| |_|",
];
const STATS_LINE_INDEX = 4;

// A green for the wordmark — inarch is a grafting term — and a muted grey for
// the secondary stats suffix. Only applied when stderr is a real TTY (tests
// spawn/call this without one, so existing plain-text assertions keep passing).
const indigo = (s: string) => `\x1b[38;2;92;168;110m${s}\x1b[0m`;
const muted = (s: string) => `\x1b[38;5;244m${s}\x1b[0m`;

interface Step {
  label: string;
  command: string;
  /** Extra continuation lines under this step, left-padded to the same column. */
  extra?: string[];
}

export interface InitEpilogueOptions {
  /** Whether a graft graph exists on disk (built by this run, or a prior one). */
  graphBuilt: boolean;
  /** Node count from the built graph — only meaningful when `graphBuilt`. */
  nodes?: number;
  /** Edge count from the built graph — only meaningful when `graphBuilt`. */
  edges?: number;
}

/** Renders the `inarch init` next-steps epilogue (no trailing newline — the
 * caller's `console.error` adds the one trailing newline). */
export function formatInitEpilogue(opts: InitEpilogueOptions): string {
  const { graphBuilt, nodes, edges } = opts;
  const tty = Boolean(process.stderr.isTTY);

  const wordmark = WORDMARK_LINES.map((l) => (tty ? indigo(l) : l));
  if (graphBuilt && nodes !== undefined && edges !== undefined) {
    const stats = `  ${nodes.toLocaleString("en-US")} nodes · ${edges.toLocaleString("en-US")} edges`;
    wordmark[STATS_LINE_INDEX] += tty ? muted(stats) : stats;
  }

  const steps: Step[] = [
    ...(graphBuilt ? [] : [{ label: "build the graph", command: "inarch build" }]),
    { label: "restart your agent", command: "a new session picks up inarch automatically" },
    {
      label: "code as usual",
      command: "ask your agent to fix a bug or explain a flow —",
      extra: ["it now answers from the graph"],
    },
    {
      label: "explore by hand",
      command: 'inarch ask "where is auth handled?" · inarch callers <fn> · inarch viz',
    },
  ];

  const indent = "  ";
  const gap = "  ";
  const labelWidth = Math.max(...steps.map((s, i) => `${i + 1}. ${s.label}`.length));
  const columnWidth = indent.length + labelWidth + gap.length;

  const stepLines: string[] = [];
  steps.forEach((s, i) => {
    const prefix = `${indent}${i + 1}. ${s.label}`;
    stepLines.push(prefix.padEnd(columnWidth) + s.command);
    for (const extra of s.extra ?? []) {
      stepLines.push(" ".repeat(columnWidth) + extra);
    }
  });

  const closing = `${indent}share it: git add .claude && git commit — teammates run \`inarch build\` for their own local graph`;

  return [...wordmark, "", ...stepLines, "", closing].join("\n");
}
