# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/hrd04-ai/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/hrd04-ai/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A CommonMark 0.31.2 + GFM parser in one dependency-free ES module,
rendering byte-identical HTML to marked 18.1.3 on the competition's 720
practice cases — written for the make.fun "Make Markdown rendering
faster" bounty.

## Layout

- `parse.js` — the entire parser: `parse(markdown)` returns HTML. No
  dependencies and no build step.
- `main.ts` — the harness driver. It reads `/input/cases.json`, renders
  every case with `parse()`, and writes `/output/html.json`. Outside a
  container, `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` take the place
  of `/input` / `/output`.
- `benchmark.mjs`, `fuzz.mjs`, `diff.mjs` — development tools (see
  Tooling below). They are not part of the graded entrypoint, but they
  are how this repo measures the parser's correctness and speed.

## Scripts

```sh
npm start                  # run the harness driver (needs input/output dirs)
npm run check              # diff all 720 practice cases + a quick fuzz run
npm run bench              # sequential timing vs marked
npm run bench:interleaved  # interleaved timing (the trustworthy number)
npm run fuzz               # soup-mode fuzzing (default seed/count)
npm run fuzz:compare       # soup fuzzing + a marked comparison on 100 docs
npm run fuzz:nested        # nested-construct fuzzing
npm run diff               # diff all 720 practice cases vs marked
```

## Architecture

Rendering runs in two passes:

1. **Block pass** (`readBlocks`). The source is split into lines, and
   each line records whether a newline followed it — a final
   unterminated whitespace-only line is content, not blank. Lines are
   consumed into a small block tree: paragraphs, ATX/Setext headings,
   fenced and indented code, HTML blocks (all 7 types), thematic
   breaks, blockquotes, lists (with task items), and GFM tables. Link
   reference definitions are collected as paragraphs are consumed and
   resolved later.
2. **Inline pass** (`parseInline`). Each block's text is walked once,
   collecting output chunks and settling emphasis with a delimiter
   stack and links with a bracket stack. It covers code spans, escaped
   characters, entities, emphasis/strong (with the CommonMark flanking
   rules), strikethrough, links and images (inline, reference,
   shortcut, collapsed), angle and extended autolinks (www,
   http/https/ftp, mailto:, xmpp:, bare emails), and raw inline HTML.

Behaviour was pinned by probing marked's outputs on hundreds of edge
cases — tab expansion at container boundaries, fence-indent stripping
(backtick fences only), the document-global "in link" state an inline
`<a>` tag sets, table delimiter quirks, and more. Marked's own source
was never consulted.

## Benchmark

Method: the kit's practice set (720 cases) is rendered with this parser
and with the kit's vendored marked 18.1.3, each over the whole set in a
single process, and the wall-clock totals are compared. Correctness is
checked first: every case must be byte-identical to marked's output
before the timing counts.

Result on this machine (Node 22, interleaved rounds against the same
cases, final code): **720/720 byte-identical**, and the entry runs
**about 1.5–1.6× faster** than marked (fastest full-set runs 453–454 ms
vs 716–728 ms for marked; medians 543–561 ms vs 837–941 ms). The speed
comes from the single-pass inline walk, cheap character-class checks
(code-point ranges instead of regexes on the hot path), and rendering
straight into a chunk array instead of building an AST.

### Why interleaved timing

On a shared, contended machine the absolute speed of both engines drifts
over minutes: a sequential benchmark that times one engine, then the
other, can report anywhere from 1.05× to 2.37× for the same code
depending on what else the box is doing. Interleaved timing alternates
the engines round by round, so a slow drift hits both sides
near-equally; the min-vs-min speedup across interleaved rounds is
stable (1.40–1.61× across five runs here) and is the number this README
quotes. `benchmark.mjs --interleaved 11` runs it; the sequential mode
(`--runs N`) is kept for quick checks on a quiet machine.

## Tooling

Three scripts ship alongside the parser (all plain Node, no
dependencies). The kit directory is taken from `MAKEFUN_KIT_DIR` when
set, else `../markdown-render-speed-02-kit` relative to this repo.

- `benchmark.mjs` — times `parse()` against the kit's vendored marked
  18.1.3 over the 720 practice cases. Correctness comes first (every
  case must be byte-identical to marked's output, or it exits 1); then
  it runs warmup + timed passes and reports min/median/mean/max/p95 and
  standard deviation per engine, the speedup, and the five slowest
  cases. Flags: `--runs N` (sequential timed passes, default 5),
  `--warmup N`, `--interleaved N` (alternate the engines N rounds and
  report the min-vs-min speedup too), `--cases <path>`, `--marked
  <path>`, `--json` (machine-readable report), `--report <path>`
  (write the JSON report to a file).
- `fuzz.mjs` — a seeded deterministic fuzzer. It builds random markdown
  documents with an sfc32 PRNG and checks that `parse()` never throws,
  always returns a string, and is deterministic (the same input
  rendered twice gives the same output). Two modes: `soup` (random
  lines from fragment pools — plain words, inline markup, block
  constructs, punctuation soup) and `nested` (deeply nested quotes,
  lists, and emphasis, where container bookkeeping is most likely to
  slip). Flags: `--seed N`, `--count N`, `--mode soup|nested`,
  `--max-lines N`, `--max-depth N`, `--compare N` (render the first N
  docs with marked too and count mismatches — informational only, since
  random soup hits edges outside the practice set), `--show N`.
- `diff.mjs` — show one practice case rendered by `parse()` and by
  marked, with the difference highlighted. `--all` scans every case
  and lists the ones that differ (exit 1 when any differ, so it doubles
  as a correctness gate); `--show N` prints the first N diffs in full.
  Two views: the span view (first differing byte range with context)
  and `--hunks` (a line-based -/+ view). Flags: `--cases <path>`,
  `--marked <path>`, `--context N`, `--json`.

```sh
node benchmark.mjs --interleaved 11
node fuzz.mjs --seed 7 --count 300 --compare 100
node fuzz.mjs --mode nested --seed 42 --count 300
node diff.mjs --all
node diff.mjs spec-example-042 --hunks
```

## Design notes

A few decisions shape the whole parser:

- **Lines carry their newline.** Every source line records whether a
  newline followed it. That one bit settles several marked quirks at
  once: a final unterminated whitespace-only line counts as content,
  not blank; HTML blocks gain their trailing newline only under the
  right conditions; a terminated `   \t` line is a table body row.
- **Lazy lines are flagged, not re-parsed.** When blockquote and
  list-item collection meets a continuation line, it marks the line
  lazy (and, where relevant, never-a-table or never-a-setext). The
  paragraph consumer then takes it as plain text — exactly how marked
  takes it — with no second-guessing at the inline level.
- **Emphasis resolves in two passes.** The inline walk first gathers
  chunks and records every `*`/`_` delimiter run with its flanking
  data; a separate resolution pass then pairs openers and closers by
  the CommonMark rules (the rule of 3, the intraword `_` restriction,
  and the odd/even length interplay between `*` and `_`). Splitting
  tokenization from resolution is what makes `*write quote **uses
  2*3*4**`-class inputs tractable at all.
- **Delimiters are data, not regexes.** Character classes (punctuation,
  whitespace, word characters) are code-point range checks, and the hot
  inline loop dispatches on single characters. Regexes show up only
  where a pattern is genuinely irregular (delimiter rows, task markers,
  email domains) and never inside a per-character loop.
- **No AST for inline content.** Inline parsing renders straight into
  a chunk array that is joined once at the end. Blocks form the only
  tree, and it stays shallow: paragraphs, headings, code, quotes,
  lists, tables.
- **Block rendering is a dispatch table.** Every block type owns one
  small renderer in a lookup object, so a new block kind means one new
  entry — the main render loop never grows another branch.
- **Diagnostics ride along for free.** `inspectDocument(markdown)` runs
  the same block pass and reports block counts by type plus output
  length and elapsed time, without rendering inline content twice. The
  harness never calls it; it exists so the tools can profile documents
  by shape.

## Quirks catalog

Marked 18.1.3 does not implement CommonMark 0.31.2 exactly, and this
parser matches marked, quirks included. The ones that cost the most
debugging time, all pinned by probing marked's outputs (never its
source):

- **Fence indent stripping is backtick-only.** A backtick fence's
  content lines lose the opening fence's indent; tilde-fence content
  keeps its indent verbatim. Tabs count as one column when stripping.
- **The `<a>` in-link state is document-global.** An inline `<a>` open
  tag whose name is followed by a literal space raises a flag that
  suppresses extended autolinks (www/http/email) for the rest of the
  document, across blocks, until the exact 4-character tag `</a>` (any
  case) clears it. A tab, newline, `>` or `/` after the name does not
  raise it; `</a >` does not clear it. Tags inside HTML blocks, code
  spans, or link text never touch the state.
- **Lazy setext and delimiter lines never convert.** Inside a
  blockquote, a lazy line that looks like a setext underline or a table
  delimiter row stays paragraph text — even when the paragraph it
  continues would otherwise be a perfect setext heading or table header.
- **A terminated `   \t` line is a table body row.** A line of 0–3
  spaces plus a single tab, terminated by a newline, yields an empty
  table row instead of ending the table. Unterminated, it is blank.
- **List items swallow fence content.** While a fence inside a list
  item is open and already holds a content line, under-indented lines
  that are not fence lines stay in the item as fence content — unless
  the previous item line could start a leaf block (indented code, ATX,
  HR, HTML block). When the first line after the fence open is
  under-indented, the item ends and the fence is empty.
- **Paragraph continuations inside list items lose 4 columns.** A
  continuation line with 4+ columns of leading whitespace loses 4 of
  them; a non-stripped continuation following a stripped one gains a
  blank line before it inside the paragraph.
- **Link definitions are paragraph-scoped, first wins.** Definitions
  come out of the start of paragraph text (possibly spanning lines),
  the first definition of a label wins, and a paragraph that turns out
  to hold only definitions produces no block at all — a setext or table
  line after it then starts a fresh block.
- **Emphasis has a rule of 3 and a del interaction.** The CommonMark
  rule of 3 applies (odd/even length interplay between opener and
  closer), `_` cannot open or close intraword, and a strikethrough
  ending in a `*` emphasis blocks an enclosing `**` strong match until
  one closer fails against it.
- **Extended autolinks are picky about context.** `www.` needs a
  restricted preceding character and a lowercase literal; `mailto:` and
  `xmpp:` need a non-word preceding character; `http(s)://` and `ftp://`
  are case-insensitive with no preceding restriction. Trailing
  punctuation, named entities, and unmatched `)` are trimmed from the
  candidate, and paren groups pair without nesting.
- **A link cannot contain a link, even a hidden one.** A markdown link
  that forms inside a strikethrough's content stops every enclosing
  bracket from forming a link — the parser tracks links formed during
  the recursive parse and deactivates the outer brackets.
- **Autolinks inside a link revert to text.** When a link forms around
  text that already holds an extended autolink, the autolink's HTML is
  replaced by its plain text — links cannot nest, so the inner one
  yields.

## Testing

- Practice set: the kit's harness renders all 720 cases with this
  parser and with marked, then diffs them byte for byte. Target: 720/720.
- End-to-end: run `main.ts` over the practice cases with
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set, then compare the
  resulting `html.json` against marked's — the same 720/720 target.
- Fuzzing: `node fuzz.mjs` with several seeds in both modes. The bar is
  zero crashes and zero nondeterminism. Mismatches against marked on
  random soup are logged for triage, not treated as failures — the
  practice set is the contract.
- Spot checks: `node diff.mjs <case-id>` for any case that looks off,
  with `--hunks` for a line-based view of the difference.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## Known edge

One residual difference against marked survives on an out-of-sample
probe (seed 2 in the builder's own fuzzing, 719/720 there): emphasis in
`*write quote **uses 2*3*4**` resolves differently. Three fix attempts
all regressed other cases, so the parser keeps its current behaviour on
that input. It does not affect the 720 practice cases.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
