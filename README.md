# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/hrd04-ai/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/hrd04-ai/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free CommonMark 0.31.2 + GFM parser in a single ES module, byte-identical to marked 18.1.3 on the competition's 720 practice cases — built for the make.fun "Make Markdown rendering faster" bounty.

## Layout

- `parse.js` — the whole parser: `parse(markdown)` returns HTML. No
  dependencies, no build step.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse()`, writes `/output/html.json`. Outside a container,
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for `/input` /
  `/output`.

## Architecture

The parser has two passes:

1. **Block pass** (`parseBlocks`). The source is split into lines (each
   line remembers whether a newline followed it — a final unterminated
   whitespace-only line is content, not blank). Lines are consumed into a
   small block tree: paragraphs, ATX/Setext headings, fenced and indented
   code, HTML blocks (all 7 types), thematic breaks, blockquotes, lists
   (with task items), and GFM tables. Link reference definitions are
   collected as paragraphs are consumed and resolved later.
2. **Inline pass** (`parseInline`). Each block's text is walked once,
   collecting output chunks and resolving emphasis through a delimiter
   stack and links through a bracket stack. It covers code spans, escaped
   characters, entities, emphasis/strong (with the CommonMark flanking
   rules), strikethrough, links and images (inline, reference, shortcut,
   collapsed), angle and extended autolinks (www, http/https/ftp,
   mailto:, xmpp:, bare emails), and raw inline HTML.

Behaviour was pinned by probing marked's outputs on hundreds of edge
cases — tab expansion at container boundaries, fence-indent stripping
(backtick fences only), the document-global "in link" state an inline
`<a>` tag sets, table delimiter quirks, and more. Marked's own source
was never consulted.

## Benchmark

Method: the kit's practice set (720 cases) is rendered with this parser
and with the kit's vendored marked 18.1.3, each over the whole set in a
single process, and the median wall-clock totals are compared.
Correctness is checked first: every case must be byte-identical to
marked's output before the timing counts.

Result on this machine (Node 22, median of 5 runs on the final code):
**720/720 byte-identical**, and the entry runs **1.66× faster** than
marked (601 ms vs 999 ms for the whole set). The speed comes from the
single-pass inline walk, cheap character-class checks (code-point ranges
instead of regexes on the hot path), and rendering straight into a chunk
array instead of building an AST.

## Tooling

Two scripts ship alongside the parser (both plain Node, no dependencies):

- `benchmark.mjs` — times `parse()` against the kit's vendored marked
  18.1.3 over the 720 practice cases. It checks correctness first (every
  case must be byte-identical to marked's output, or it exits 1), then
  runs warmup + timed passes and reports median/min/max/p95 per engine,
  the speedup, and the five slowest cases. Flags: `--runs N` (timed
  passes, default 5), `--warmup N`, `--cases <path>` (a cases.json to
  use instead of the kit's), `--marked <path>` (the marked module to
  compare against), `--json` (machine-readable report), `--report
  <path>` (write the JSON report to a file). The kit directory is taken
  from `MAKEFUN_KIT_DIR` when set, else `../markdown-render-speed-02-kit`
  relative to this repo.
- `fuzz.mjs` — a seeded deterministic fuzzer. It builds random markdown
  documents from fragment pools (plain words, inline markup, block
  constructs, punctuation soup) with a mulberry32 PRNG, then checks that
  `parse()` never throws, always returns a string, and is deterministic
  (same input rendered twice gives the same output). Flags: `--seed N`,
  `--count N`, `--compare N` (render the first N docs with marked too
  and count mismatches — informational only, since random soup hits
  edges outside the practice set), `--max-lines N`, `--verbose`.

```sh
node benchmark.mjs --runs 5
node fuzz.mjs --seed 7 --count 300 --compare 100
```

## Design notes

A few choices shape the whole parser:

- **Lines carry their newline.** Every source line remembers whether a
  newline followed it. That single bit settles several marked quirks at
  once: a final unterminated whitespace-only line is content, not blank;
  HTML blocks get their trailing newline only under the right conditions;
  a terminated `   \t` line is a table body row, not a blank.
- **Lazy lines are flagged, not re-parsed.** Blockquote and list-item
  collection marks continuation lines as lazy (and, where relevant, as
  never-a-table or never-a-setext). The paragraph consumer then treats
  them as plain text, which is exactly how marked treats them — no
  second-guessing at the inline level.
- **Emphasis resolves in two passes.** The inline walk first collects
  chunks and records every `*`/`_` delimiter run with its flanking
  information; a separate resolution pass then pairs openers and closers
  with the CommonMark rules (including the rule of 3, the intraword
  `_` restriction, and the odd/even length interplay between `*` and
  `_`). Keeping tokenization and resolution apart is what makes the
  `*write quote **uses 2*3*4**`-class inputs tractable at all.
- **Delimiters are data, not regexes.** Character classes (punctuation,
  whitespace, word characters) are code-point range checks, and the hot
  inline loop dispatches on single characters. Regexes appear only where
  a pattern is genuinely irregular (delimiter rows, task markers, email
  domains) and never inside a per-character loop.
- **No AST for inline content.** Inline parsing renders straight into a
  chunk array that is joined once at the end. Blocks are the only tree,
  and it is shallow: paragraphs, headings, code, quotes, lists, tables.

## Quirks catalog

Marked 18.1.3 does not implement CommonMark 0.31.2 exactly, and this
parser matches marked, quirks included. The ones that cost the most
debugging time, all pinned by probing marked's outputs (never its
source):

- **Fence indent stripping is backtick-only.** Content lines of a
  backtick fence lose the opening fence's indent; tilde-fence content
  keeps its indent verbatim. Tabs count as one column when stripping.
- **The `<a>` in-link state is document-global.** An inline `<a>` open
  tag whose name is followed by a literal space sets a flag that
  suppresses extended autolinks (www/http/email) for the rest of the
  document, across blocks, until the exact 4-character tag `</a>` (any
  case) clears it. A tab, newline, `>` or `/` after the name does not
  set it; `</a >` does not clear it. Tags inside HTML blocks, code
  spans, or link text do not touch the state.
- **Lazy setext and delimiter lines never convert.** Inside a
  blockquote, a lazy line that looks like a setext underline or a table
  delimiter row stays paragraph text — even when the paragraph it
  continues is otherwise a perfect setext heading or table header.
- **A terminated `   \t` line is a table body row.** A line of 0–3
  spaces plus a single tab, terminated by a newline, produces an empty
  table row instead of ending the table. Unterminated, it is blank.
- **List items swallow fence content.** While a fence inside a list
  item is open and already has a content line, under-indented lines
  that are not fence lines stay in the item as fence content — unless
  the previous item line could start a leaf block (indented code, ATX,
  HR, HTML block). If the first line after the fence open is
  under-indented, the item ends and the fence is empty.
- **Paragraph continuations inside list items lose 4 columns.** A
  continuation line with 4+ columns of leading whitespace is stripped
  by 4; a non-stripped continuation following a stripped one is
  preceded by a blank line inside the paragraph.
- **Link definitions are paragraph-scoped, first wins.** Definitions
  are extracted from the start of paragraph text (possibly spanning
  lines), the first definition of a label wins, and a paragraph that
  turns out to be only definitions produces no block at all — a setext
  or table line after it then starts a fresh block.
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
  candidate, and paren groups pair non-nested.

## Testing

- Practice set: the kit's harness renders all 720 cases with this
  parser and with marked and diffs them byte for byte. Target: 720/720.
- End-to-end: run `main.ts` against the practice cases with
  `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` set, then compare the
  produced `html.json` against marked's — same 720/720 target.
- Fuzzing: `node fuzz.mjs` with several seeds; zero crashes and zero
  nondeterminism are the bar. Mismatches against marked on random soup
  are logged for triage, not treated as failures — the practice set is
  the contract.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

## Known edge

One residual difference against marked on an out-of-sample probe (seed 2
in the builder's own fuzzing, 719/720 there): emphasis in
`*write quote **uses 2*3*4**` resolves differently. Three fix attempts
all regressed other cases, so the parser keeps its current behaviour on
that input. It does not affect the 720 practice cases.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
