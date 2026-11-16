// diff.mjs — show one practice case rendered by parse.js and by marked,
// side by side, with the differing region highlighted.
//
// Usage:
//   node diff.mjs <case-id-or-index> [--cases PATH] [--marked PATH]
//                                    [--context N] [--json]
//   node diff.mjs --all [--cases PATH] [--marked PATH]
//
//   <case>       a case id (as in cases.json) or a 0-based index
//   --all        scan every case and list the ones that differ
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const opts = {
    target: null,
    all: false,
    json: false,
    context: 80,
    cases: null,
    marked: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--all') opts.all = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--context') opts.context = Number(argv[++k] ?? 80);
    else if (arg === '--cases') opts.cases = argv[++k] ?? null;
    else if (arg === '--marked') opts.marked = argv[++k] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node diff.mjs <case-id-or-index> | --all [--cases PATH] [--marked PATH] [--context N] [--json]');
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

function findCase(cases, target) {
  if (/^\d+$/.test(target)) {
    const idx = Number(target);
    if (idx < 0 || idx >= cases.length) return null;
    return { index: idx, entry: cases[idx] };
  }
  const idx = cases.findIndex((entry) => entry.id === target);
  if (idx === -1) return null;
  return { index: idx, entry: cases[idx] };
}

// Find the first and last differing positions between two strings.
// Returns {start, endA, endB}: the differing span is a[start..endA)
// versus b[start..endB). Identical strings give start === endA === endB.
function diffSpan(a, b) {
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

// Render a span with visible escapes for newlines/tabs so whitespace
// differences are obvious.
function visible(s) {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\r', '\\r');
}

function showOne(entry, index, mine, theirs, context) {
  console.log(`case ${index} — ${entry.id}`);
  console.log('─'.repeat(60));
  console.log('INPUT (markdown):');
  console.log(visible(entry.markdown));
  console.log('─'.repeat(60));
  if (mine === theirs) {
    console.log('IDENTICAL — both render to:');
    console.log(visible(mine));
    return;
  }
  const { start, endA, endB } = diffSpan(mine, theirs);
  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(mine.length, endA + context);
  const ctxEndB = Math.min(theirs.length, endB + context);
  console.log(`DIFFER — first difference at offset ${start} (mine ${mine.length} chars, marked ${theirs.length} chars)`);
  console.log('MINE (with context):');
  console.log(visible(mine.slice(ctxStart, ctxEndA)));
  console.log('MARKED (with context):');
  console.log(visible(theirs.slice(ctxStart, ctxEndB)));
  console.log('MINE differing span only:');
  console.log(JSON.stringify(mine.slice(start, endA)));
  console.log('MARKED differing span only:');
  console.log(JSON.stringify(theirs.slice(start, endB)));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.all && opts.target === null) {
    console.error('usage: node diff.mjs <case-id-or-index> | --all [--cases PATH] [--marked PATH] [--context N] [--json]');
    process.exit(2);
  }
  const casesPath = opts.cases ?? join(KIT_DIR, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = readJson(casesPath);
  const markedMod = await import(markedPath);
  const markedParse = markedMod.marked?.parse ?? markedMod.parse ?? markedMod.default;

  if (opts.all) {
    const mismatches = [];
    for (let i = 0; i < cases.length; i++) {
      const mine = parse(cases[i].markdown);
      const theirs = markedParse(cases[i].markdown);
      if (mine !== theirs) mismatches.push({ index: i, id: cases[i].id });
    }
    if (opts.json) {
      console.log(JSON.stringify({ total: cases.length, mismatches }, null, 2));
    } else if (mismatches.length === 0) {
      console.log(`all ${cases.length} cases identical`);
    } else {
      console.log(`${mismatches.length} of ${cases.length} cases differ:`);
      for (const m of mismatches) console.log(`  #${m.index} ${m.id}`);
    }
    process.exit(mismatches.length === 0 ? 0 : 1);
  }

  const found = findCase(cases, opts.target);
  if (!found) {
    console.error(`no case matches: ${opts.target}`);
    process.exit(2);
  }
  const mine = parse(found.entry.markdown);
  const theirs = markedParse(found.entry.markdown);
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
  showOne(found.entry, found.index, mine, theirs, opts.context);
  process.exit(mine === theirs ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
