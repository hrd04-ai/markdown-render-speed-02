// diff.mjs — show one practice case rendered by parse.js and by marked,
// side by side, with the differing region highlighted.
//
// Two views are available for a differing case. The span view shows the
// first differing byte range with context around it; the hunk view
// (--hunks) splits both renderings into lines and prints the changed
// lines with -/+ markers, which reads better when the difference spans
// several lines of HTML.
//
// Usage:
//   node diff.mjs <case-id-or-index> [--cases PATH] [--marked PATH]
//                                    [--context N] [--json] [--hunks]
//   node diff.mjs --all [--cases PATH] [--marked PATH] [--show N]
//                                 [--hunks] [--json]
//
//   <case>       a case id (as in cases.json) or a 0-based index
//   --all        scan every case and list the ones that differ
//   --show N     with --all: also print the first N diffs in full
//   --hunks      line-based -/+ hunk view instead of the span view
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

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = process.env.MAKEFUN_KIT_DIR ??
  join(HERE, '..', 'markdown-render-speed-02-kit');

const USAGE =
  'usage: node diff.mjs <case-id-or-index> | --all [--cases PATH] ' +
  '[--marked PATH] [--context N] [--json] [--hunks] [--show N]';

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function loadMarked(path) {
  const mod = await import(path);
  const fn = mod.marked?.parse ?? mod.parse ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`no parse function in ${path}`);
  return (doc) => fn(doc);
}

function parseCli(argv) {
  const opts = {
    target: null,
    all: false,
    json: false,
    hunks: false,
    show: 0,
    context: 80,
    cases: null,
    marked: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--all') opts.all = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--hunks') opts.hunks = true;
    else if (arg === '--context') opts.context = Number(argv[++k] ?? 80);
    else if (arg === '--show') opts.show = Math.max(0, Number(argv[++k] ?? 0));
    else if (arg === '--cases') opts.cases = argv[++k] ?? null;
    else if (arg === '--marked') opts.marked = argv[++k] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (!arg.startsWith('-') && opts.target === null) {
      opts.target = arg;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// Resolve a target (numeric index or case id) to {index, entry}.
function locateCase(cases, target) {
  if (/^\d+$/.test(target)) {
    const idx = Number(target);
    if (idx < 0 || idx >= cases.length) return null;
    return { index: idx, entry: cases[idx] };
  }
  const idx = cases.findIndex((entry) => entry.id === target);
  if (idx === -1) return null;
  return { index: idx, entry: cases[idx] };
}

// First and last differing positions between two strings: the differing
// span is a[start..endA) versus b[start..endB). Identical strings give
// start === endA === endB.
function spanOfDifference(a, b) {
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

// Render a string with visible escapes for backslashes, newlines, tabs
// and carriage returns, so whitespace differences are obvious.
function showWhitespace(s) {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r');
}

// Line-based hunk view: the changed lines of `mine` (marked -) and
// `theirs` (marked +), with two lines of unchanged context on each side.
// The hunk boundaries come from the common line prefix and suffix.
function hunkView(mine, theirs) {
  const mineLines = mine.split('\n');
  const theirLines = theirs.split('\n');
  let first = 0;
  while (
    first < mineLines.length &&
    first < theirLines.length &&
    mineLines[first] === theirLines[first]
  ) first++;
  let lastMine = mineLines.length;
  let lastTheir = theirLines.length;
  while (
    lastMine > first &&
    lastTheir > first &&
    mineLines[lastMine - 1] === theirLines[lastTheir - 1]
  ) {
    lastMine--;
    lastTheir--;
  }
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
  if (ctxEndTheir > ctxEndMine) {
    for (let k = ctxEndMine; k < ctxEndTheir; k++) out.push('  ' + theirLines[k]);
  }
  return out.join('\n');
}

// Span view: the differing byte range with `context` characters around it.
function spanView(mine, theirs, context) {
  const { start, endA, endB } = spanOfDifference(mine, theirs);
  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(mine.length, endA + context);
  const ctxEndB = Math.min(theirs.length, endB + context);
  const lines = [];
  lines.push(
    `DIFFER — first difference at offset ${start} ` +
    `(mine ${mine.length} chars, marked ${theirs.length} chars)`,
  );
  lines.push('MINE (with context):');
  lines.push(showWhitespace(mine.slice(ctxStart, ctxEndA)));
  lines.push('MARKED (with context):');
  lines.push(showWhitespace(theirs.slice(ctxStart, ctxEndB)));
  lines.push('MINE differing span only:');
  lines.push(JSON.stringify(mine.slice(start, endA)));
  lines.push('MARKED differing span only:');
  lines.push(JSON.stringify(theirs.slice(start, endB)));
  return lines.join('\n');
}

function reportCase(entry, index, mine, theirs, opts) {
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
  if (opts.hunks) console.log(hunkView(mine, theirs));
  else console.log(spanView(mine, theirs, opts.context));
}

// Scan every case; returns the list of {index, id} mismatches.
function scanAll(cases, renderMarked) {
  const mismatches = [];
  for (let i = 0; i < cases.length; i++) {
    const mine = parse(cases[i].markdown);
    const theirs = renderMarked(cases[i].markdown);
    if (mine !== theirs) mismatches.push({ index: i, id: cases[i].id });
  }
  return mismatches;
}

async function run() {
  const opts = parseCli(process.argv.slice(2));
  if (!opts.all && opts.target === null) {
    console.error(USAGE);
    process.exit(2);
  }
  const casesPath = opts.cases ?? join(KIT_DIR, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = loadJson(casesPath);
  const renderMarked = await loadMarked(markedPath);

  if (opts.all) {
    const mismatches = scanAll(cases, renderMarked);
    if (opts.json) {
      console.log(JSON.stringify({ total: cases.length, mismatches }, null, 2));
    } else if (mismatches.length === 0) {
      console.log(`all ${cases.length} cases identical`);
    } else {
      console.log(`${mismatches.length} of ${cases.length} cases differ:`);
      for (const m of mismatches) console.log(`  #${m.index} ${m.id}`);
      for (const m of mismatches.slice(0, opts.show)) {
        console.log('');
        const mine = parse(cases[m.index].markdown);
        const theirs = renderMarked(cases[m.index].markdown);
        reportCase(cases[m.index], m.index, mine, theirs, opts);
      }
    }
    process.exit(mismatches.length === 0 ? 0 : 1);
  }

  const found = locateCase(cases, opts.target);
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
  reportCase(found.entry, found.index, mine, theirs, opts);
  process.exit(mine === theirs ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
