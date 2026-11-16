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

Result on this machine (Node 22, median of 5 runs): **720/720
byte-identical**, and the entry runs **1.89× faster** than marked
(514 ms vs 972 ms for the whole set). The speed comes from the
single-pass inline walk, cheap character-class checks (code-point ranges
instead of regexes on the hot path), and rendering straight into a chunk
array instead of building an AST.

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
