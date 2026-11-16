// diff.mjs — one practice case rendered by parse.js and by marked,
// side by side, with the differing region highlighted.
//
// Three views are available for a differing case:
//   * span (default): the first differing byte range with context;
//   * hunks (--hunks): the renderings split into lines, changed lines
//     marked -/+ — reads better when the difference spans several
//     lines of HTML;
//   * words (--words): the renderings split on word boundaries, with
//     the first differing word run shown — best when a single word or
//     attribute inside a long line is wrong.
//
// --all scans every case and lists the ones that differ (exit 1 when
// any differ, so it doubles as a correctness gate); --show N prints
// the first N diffs in full. --stats adds output-size totals for both
// engines to an --all run, which catches a renderer that silently
// drops or duplicates content on cases that still "look" right.
// --group clusters the mismatches by the HTML tag nearest the first
// difference, so a systematic bug (every mismatch inside <a>, say)
// shows up as one group instead of a flat list of case ids.
//
// Usage:
//   node diff.mjs <case-id-or-index> [--cases PATH] [--marked PATH]
//                                    [--context N] [--json] [--hunks]
//                                    [--words]
//   node diff.mjs --all [--cases PATH] [--marked PATH] [--show N]
//                                 [--hunks] [--words] [--json] [--stats]
//                                 [--group]
//
//   <case>       a case id (as in cases.json) or a 0-based index
//   --all        scan every case and list the ones that differ
//   --show N     with --all: also print the first N diffs in full
//   --hunks      line-based -/+ hunk view instead of the span view
//   --words      word-based view instead of the span view
//   --stats      with --all: also print output-size totals per engine
//   --group      with --all: cluster mismatches by nearest HTML tag
//   --cases P    cases file (default: the kit's practice input)
//   --marked P   vendored marked module (default: the kit's baseline)
//   --context N  characters of context around a difference (default 80)
//   --json       machine-readable output instead of the human report
//
// The kit directory comes from MAKEFUN_KIT_DIR when set, else
// ../markdown-render-speed-02-kit relative to this file.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parse.js';

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = process.env.MAKEFUN_KIT_DIR ??
  join(ENTRY_DIR, '..', 'markdown-render-speed-02-kit');

const HELP_TEXT =
  'usage: node diff.mjs <case-id-or-index> | --all [--cases PATH] ' +
  '[--marked PATH] [--context N] [--json] [--hunks] [--words] ' +
  '[--show N] [--stats] [--group]';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function loadMarked(path) {
  const mod = await import(path);
  const render = mod.marked?.parse ?? mod.parse ?? mod.default;
  if (typeof render !== 'function') throw new Error(`no parse function in ${path}`);
  return (doc) => render(doc);
}

// ---------------------------------------------------------------------------
// CLI parsing. Value flags carry a coercion; switches are plain booleans.
// ---------------------------------------------------------------------------

const VALUE_FLAGS = {
  '--context': { key: 'context', coerce: (raw) => Math.max(0, Number(raw ?? 80)) },
  '--show': { key: 'show', coerce: (raw) => Math.max(0, Number(raw ?? 0)) },
  '--cases': { key: 'cases', coerce: (raw) => raw ?? null },
  '--marked': { key: 'marked', coerce: (raw) => raw ?? null },
};

const SWITCH_FLAGS = {
  '--all': 'all',
  '--json': 'json',
  '--hunks': 'hunks',
  '--words': 'words',
  '--stats': 'stats',
  '--group': 'group',
};

function parseCli(argv) {
  const opts = {
    target: null,
    all: false,
    json: false,
    hunks: false,
    words: false,
    stats: false,
    show: 0,
    context: 80,
    cases: null,
    marked: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--help' || arg === '-h') {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    const switchKey = SWITCH_FLAGS[arg];
    if (switchKey !== undefined) {
      opts[switchKey] = true;
      continue;
    }
    const valueSpec = VALUE_FLAGS[arg];
    if (valueSpec !== undefined) {
      opts[valueSpec.key] = valueSpec.coerce(argv[k + 1]);
      k++;
      continue;
    }
    if (!arg.startsWith('-') && opts.target === null) {
      opts.target = arg;
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Case lookup
// ---------------------------------------------------------------------------

// Resolve a target (numeric index or case id) to {index, entry}.
function lookupCase(cases, target) {
  if (/^\d+$/.test(target)) {
    const idx = Number(target);
    if (idx < 0 || idx >= cases.length) return null;
    return { index: idx, entry: cases[idx] };
  }
  const idx = cases.findIndex((entry) => entry.id === target);
  if (idx === -1) return null;
  return { index: idx, entry: cases[idx] };
}

// ---------------------------------------------------------------------------
// Diff primitives
// ---------------------------------------------------------------------------

// First and last differing positions between two strings: the differing
// span is a[start..endA) versus b[start..endB). Identical strings give
// start === endA === endB.
function differingSpan(a, b) {
  let start = 0;
  const limit = Math.min(a.length, b.length);
  while (start < limit && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

// Common prefix/suffix of two arrays of pieces (lines or words):
// {first, lastMine, lastTheirs} — the changed pieces are
// [first, lastMine) and [first, lastTheirs).
function changedPieceRange(minePieces, theirPieces) {
  let first = 0;
  while (
    first < minePieces.length &&
    first < theirPieces.length &&
    minePieces[first] === theirPieces[first]
  ) first++;
  let lastMine = minePieces.length;
  let lastTheir = theirPieces.length;
  while (
    lastMine > first &&
    lastTheir > first &&
    minePieces[lastMine - 1] === theirPieces[lastTheir - 1]
  ) {
    lastMine--;
    lastTheir--;
  }
  return { first, lastMine, lastTheir };
}

// Render a string with visible escapes for backslashes, newlines, tabs
// and carriage returns, so whitespace differences are obvious.
function showWhitespace(s) {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Line-based hunk view: the changed lines of `mine` (marked -) and
// `theirs` (marked +), with two lines of unchanged context on each side.
function renderHunks(mine, theirs) {
  const mineLines = mine.split('\n');
  const theirLines = theirs.split('\n');
  const { first, lastMine, lastTheir } = changedPieceRange(mineLines, theirLines);
  const out = [];
  const ctxStart = Math.max(0, first - 2);
  const ctxEndMine = Math.min(mineLines.length, lastMine + 2);
  const ctxEndTheir = Math.min(theirLines.length, lastTheir + 2);
  for (let k = ctxStart; k < first; k++) out.push('  ' + mineLines[k]);
  for (let k = first; k < lastMine; k++) out.push('- ' + mineLines[k]);
  for (let k = first; k < lastTheir; k++) out.push('+ ' + theirLines[k]);
  for (let k = lastMine; k < ctxEndMine; k++) out.push('  ' + mineLines[k]);
  // Trailing context lines shared by both sides come from `mine`; when
  // the two sides end at different lengths, `theirs` has the last word.
  for (let k = ctxEndMine; k < ctxEndTheir; k++) out.push('  ' + theirLines[k]);
  return out.join('\n');
}

// Word-based view: split both renderings on word boundaries (keeping
// the separators), then show the first differing word run with three
// words of context on each side. Word runs are joined with a middle dot
// so the boundary between two adjacent words stays visible.
function renderWords(mine, theirs) {
  const splitter = /(\s+|[^\s\w]+)/g;
  const mineWords = mine.split(splitter).filter((w) => w !== '');
  const theirWords = theirs.split(splitter).filter((w) => w !== '');
  const { first, lastMine, lastTheir } = changedPieceRange(mineWords, theirWords);
  const ctxStart = Math.max(0, first - 3);
  const ctxEndMine = Math.min(mineWords.length, lastMine + 3);
  const ctxEndTheir = Math.min(theirWords.length, lastTheir + 3);
  const joinWords = (words) => words.map((w) => JSON.stringify(w)).join('·');
  return [
    `DIFFER — first differing word at word ${first} ` +
    `(mine ${mineWords.length} words, marked ${theirWords.length} words)`,
    'MINE words (with context):',
    joinWords(mineWords.slice(ctxStart, ctxEndMine)),
    'MARKED words (with context):',
    joinWords(theirWords.slice(ctxStart, ctxEndTheir)),
    'MINE differing words only:',
    joinWords(mineWords.slice(first, lastMine)),
    'MARKED differing words only:',
    joinWords(theirWords.slice(first, lastTheir)),
  ].join('\n');
}

// Span view: the differing byte range with `context` characters around it.
function renderSpan(mine, theirs, context) {
  const { start, endA, endB } = differingSpan(mine, theirs);
  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(mine.length, endA + context);
  const ctxEndB = Math.min(theirs.length, endB + context);
  return [
    `DIFFER — first difference at offset ${start} ` +
    `(mine ${mine.length} chars, marked ${theirs.length} chars)`,
    'MINE (with context):',
    showWhitespace(mine.slice(ctxStart, ctxEndA)),
    'MARKED (with context):',
    showWhitespace(theirs.slice(ctxStart, ctxEndB)),
    'MINE differing span only:',
    JSON.stringify(mine.slice(start, endA)),
    'MARKED differing span only:',
    JSON.stringify(theirs.slice(start, endB)),
  ].join('\n');
}

// Pick the view the flags asked for: words beats hunks beats span.
function renderDifference(mine, theirs, opts) {
  if (opts.words) return renderWords(mine, theirs);
  if (opts.hunks) return renderHunks(mine, theirs);
  return renderSpan(mine, theirs, opts.context);
}

function printCase(entry, index, mine, theirs, opts) {
  console.log(`case ${index} — ${entry.id}`);
  console.log('─'.repeat(60));
  console.log('INPUT (markdown):');
  console.log(showWhitespace(entry.markdown));
  console.log('─'.repeat(60));
  if (mine === theirs) {
    console.log('IDENTICAL — both render to:');
    console.log(showWhitespace(mine));
    return;
  }
  console.log(renderDifference(mine, theirs, opts));
}

// The HTML tag nearest the first difference between two renderings:
// scan back from the first differing offset in `mine` to the closest
// '<' within 40 characters and read the tag name after it (a leading
// '/' marks a closing tag). Returns e.g. 'a', '/em', 'code', or
// '(text)' when no tag is nearby — the difference is in plain text.
function diffTagContext(mine, theirs) {
  const { start } = differingSpan(mine, theirs);
  const windowStart = Math.max(0, start - 40);
  const before = mine.slice(windowStart, start);
  const openAt = before.lastIndexOf('<');
  if (openAt === -1) return '(text)';
  const afterOpen = before.slice(openAt + 1);
  const name = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(afterOpen);
  if (!name) return '(text)';
  return name[1] + name[2];
}

// Cluster mismatching cases by the tag nearest their first
// difference. Returns groups sorted by size (largest first), each
// {tag, count, ids} with up to 5 sample case ids.
function groupMismatches(cases, mismatches, renderMarked) {
  const groups = new Map();
  for (const m of mismatches) {
    const mine = parse(cases[m.index].markdown);
    const theirs = renderMarked(cases[m.index].markdown);
    const tag = diffTagContext(mine, theirs);
    const group = groups.get(tag) ?? { tag, count: 0, ids: [] };
    group.count++;
    if (group.ids.length < 5) group.ids.push(cases[m.index].id);
    groups.set(tag, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Full scan + output-size stats
// ---------------------------------------------------------------------------

// Scan every case; returns {mismatches, mineBytes, markedBytes,
// biggest} where biggest is the case with the largest mine output.
function scanAll(cases, renderMarked) {
  const mismatches = [];
  let mineBytes = 0;
  let markedBytes = 0;
  let biggest = { id: null, bytes: -1 };
  for (let i = 0; i < cases.length; i++) {
    const mine = parse(cases[i].markdown);
    const theirs = renderMarked(cases[i].markdown);
    mineBytes += Buffer.byteLength(mine, 'utf8');
    markedBytes += Buffer.byteLength(theirs, 'utf8');
    if (mine.length > biggest.bytes) {
      biggest = { id: cases[i].id, bytes: mine.length };
    }
    if (mine !== theirs) mismatches.push({ index: i, id: cases[i].id });
  }
  return { mismatches, mineBytes, markedBytes, biggest };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (!opts.all && opts.target === null) {
    console.error(HELP_TEXT);
    process.exit(2);
  }
  const casesPath = opts.cases ?? join(KIT_ROOT, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_ROOT, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = loadJson(casesPath);
  const renderMarked = await loadMarked(markedPath);

  if (opts.all) {
    const { mismatches, mineBytes, markedBytes, biggest } = scanAll(cases, renderMarked);
    const groups = opts.group && mismatches.length > 0
      ? groupMismatches(cases, mismatches, renderMarked)
      : null;
    if (opts.json) {
      console.log(JSON.stringify({
        total: cases.length,
        mismatches,
        mineBytes,
        markedBytes,
        biggestMineOutput: biggest,
        ...(groups ? { groups } : {}),
      }, null, 2));
    } else if (mismatches.length === 0) {
      console.log(`all ${cases.length} cases identical`);
      if (opts.stats) {
        console.log(`output bytes: mine ${mineBytes}, marked ${markedBytes}`);
        console.log(`largest mine output: ${biggest.id} (${biggest.bytes} chars)`);
      }
    } else {
      console.log(`${mismatches.length} of ${cases.length} cases differ:`);
      for (const m of mismatches) console.log(`  #${m.index} ${m.id}`);
      if (groups) {
        console.log('mismatch groups (by tag nearest the first difference):');
        for (const g of groups) {
          console.log(`  <${g.tag}>: ${g.count} case(s), e.g. ${g.ids.join(', ')}`);
        }
      }
      for (const m of mismatches.slice(0, opts.show)) {
        console.log('');
        const mine = parse(cases[m.index].markdown);
        const theirs = renderMarked(cases[m.index].markdown);
        printCase(cases[m.index], m.index, mine, theirs, opts);
      }
    }
    process.exit(mismatches.length === 0 ? 0 : 1);
  }

  const found = lookupCase(cases, opts.target);
  if (!found) {
    console.error(`no case matches: ${opts.target}`);
    process.exit(2);
  }
  const mine = parse(found.entry.markdown);
  const theirs = renderMarked(found.entry.markdown);
  if (opts.json) {
    console.log(JSON.stringify({
      index: found.index,
      id: found.entry.id,
      markdown: found.entry.markdown,
      mine,
      marked: theirs,
      identical: mine === theirs,
    }, null, 2));
    process.exit(mine === theirs ? 0 : 1);
  }
  printCase(found.entry, found.index, mine, theirs, opts);
  process.exit(mine === theirs ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
