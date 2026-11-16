// fuzz.mjs — seeded differential + determinism fuzzer for parse.js.
//
// Generates random Markdown documents from a seeded PRNG, renders each one
// with parse(), and checks two invariants that must hold for EVERY input:
//   1. parse() never throws and always returns a string;
//   2. parse() is deterministic: rendering the same input twice gives the
//      same output (the parser keeps module-level inline state, so this
//      catches state leaking between calls).
//
// With --compare N, the first N documents are additionally rendered with
// the kit's vendored marked and any byte differences are reported (the
// count is informational: one residual emphasis edge is already known,
// see README "Known edge").
//
// Usage (from the entry directory):
//   node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N]
//                 [--show N] [--marked PATH]
//   --seed N      PRNG seed (default 1); the same seed reproduces the run
//   --count N     documents to generate (default 500)
//   --max-lines N maximum lines per document (default 12)
//   --compare N   diff the first N documents against marked (default 0)
//   --show N      print up to N failing/crashing documents (default 3)
//   --marked P    vendored marked module (default: the kit's baseline)
//
// Exit code is 0 when both invariants hold on every generated document;
// a crash, a non-string result, or nondeterminism exits 1 and prints the
// offending input (with its seed) so the case can be reproduced exactly.

import { parse } from './parse.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = process.env.MAKEFUN_KIT_DIR ??
  join(HERE, '..', 'markdown-render-speed-02-kit');

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) + string seeding
// ---------------------------------------------------------------------------

// Fold an arbitrary seed string into a 32-bit integer (FNV-1a).
function hashSeedString(seedText) {
  let hash = 0x811c9dc5;
  for (let k = 0; k < seedText.length; k++) {
    hash ^= seedText.charCodeAt(k);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: small, fast, deterministic for a fixed 32-bit seed.
function makeRandom(seed) {
  let state = seed >>> 0;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Markdown fragment pools
// ---------------------------------------------------------------------------

const PLAIN_WORDS = [
  'alpha', 'beta', 'gamma', 'delta', 'word', 'text', 'hello', 'world',
  'foo', 'bar', 'baz', 'qux', 'lorem', 'ipsum', 'one', 'two', 'three',
  'a', 'I', '42', 'x1', 'under_score', 'dash-ed', 'CamelCase', 'MiXeD',
];

const INLINE_BITS = [
  '*em*', '**strong**', '_em_', '__strong__', '***both***', '___both___',
  '`code`', '``code `x` ``', '~~strike~~', '~~a *b* c~~',
  '[link](https://example.com)', '[link](/path "title")', '[ref][r1]',
  '[shortcut]', '![alt](img.png)', '![alt](img.png "t")',
  '<https://example.com>', '<user@example.com>', 'www.example.com',
  'https://example.com/a_(b)', 'user@example.com', 'mailto:a@b.co',
  '&amp;', '&copy;', '&#65;', '&#x41;', '&unknown;', '&', '<',
  '\\*not em\\*', '\\\\', '\\`tick\\`', 'a_b_c', 'a*b*c', '2*3*4',
  '<em>raw</em>', '<a href="x">raw link</a>', '</a>', '<div>', '<!-- c -->',
  'a  \nbreak', 'trailing  ', '*a **b** c*', '**a *b* c**', '_a **b** c_',
];

const BLOCK_BITS = [
  '# Heading', '## Heading two', '### Deep', 'Heading\n=======', 'Sub\n---',
  '---', '***', '___', '- - -', '> quote', '> > nested quote', '>> quote2',
  '- item one', '- item two', '1. first', '2. second', '1) paren',
  '- [ ] todo', '- [x] done', '- [X] done upper', '+ plus item', '* star item',
  '```\ncode block\n```', '```js\nconst x = 1;\n```', '~~~\ntilde\n~~~',
  '    indented code', '\t tab code', '| a | b |\n|---|---|', '| a |\n|--|',
  '<div>\nhtml block\n</div>', '<!-- html comment -->', '<?php echo 1; ?>',
  '[r1]: https://example.com "ref title"', '[r2]: </weird url>',
  'setext\n===', 'para text here', '', '   ', '\t',
];

const PUNCTUATION_BITS = ['*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '#', '-', '|', '!', '\\', '"', "'", '=', '.', ':'];

// ---------------------------------------------------------------------------
// Document generation
// ---------------------------------------------------------------------------

// Pick one element of `pool` using the PRNG.
function pickOne(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

// A random inline soup: words, inline bits and stray punctuation, joined
// with spaces (sometimes with odd spacing or tabs).
function randomInlineSoup(rng, maxBits) {
  const bitCount = 1 + Math.floor(rng() * maxBits);
  const bits = [];
  for (let k = 0; k < bitCount; k++) {
    const roll = rng();
    if (roll < 0.45) bits.push(pickOne(rng, PLAIN_WORDS));
    else if (roll < 0.85) bits.push(pickOne(rng, INLINE_BITS));
    else bits.push(pickOne(rng, PUNCTUATION_BITS));
  }
  const joiner = rng() < 0.1 ? '\t' : rng() < 0.15 ? '  ' : ' ';
  return bits.join(joiner);
}

// A random document: a few block lines, sometimes with inline soup lines
// and sometimes with a deliberately unterminated final line.
function randomDocument(rng, maxLines) {
  const lineCount = 1 + Math.floor(rng() * maxLines);
  const lines = [];
  for (let k = 0; k < lineCount; k++) {
    const roll = rng();
    if (roll < 0.5) lines.push(pickOne(rng, BLOCK_BITS));
    else if (roll < 0.85) lines.push(randomInlineSoup(rng, 6));
    else lines.push(pickOne(rng, PLAIN_WORDS) + ' ' + pickOne(rng, INLINE_BITS));
  }
  let doc = lines.join('\n');
  // Sometimes drop the trailing newline; sometimes add extra blank lines.
  if (rng() < 0.3) doc += '\n';
  if (rng() < 0.2) doc += '\n\n';
  return doc;
}

// ---------------------------------------------------------------------------
// CLI + run
// ---------------------------------------------------------------------------

function parseFuzzArguments(argv) {
  const opts = { seed: 1, count: 500, maxLines: 12, compare: 0, show: 3, marked: null };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--seed') opts.seed = argv[++k] ?? '1';
    else if (arg === '--count') opts.count = Math.max(1, Number(argv[++k]) || 500);
    else if (arg === '--max-lines') opts.maxLines = Math.max(1, Number(argv[++k]) || 12);
    else if (arg === '--compare') opts.compare = Math.max(0, Number(argv[++k]) || 0);
    else if (arg === '--show') opts.show = Math.max(0, Number(argv[++k]) || 0);
    else if (arg === '--marked') opts.marked = argv[++k] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N] [--show N] [--marked PATH]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg} (see --help)`);
  }
  return opts;
}

async function runFuzzer() {
  const opts = parseFuzzArguments(process.argv.slice(2));
  const numericSeed = /^-?\d+$/.test(String(opts.seed))
    ? Number(opts.seed) >>> 0
    : hashSeedString(String(opts.seed));
  const rng = makeRandom(numericSeed);
  let renderMarked = null;
  if (opts.compare > 0) {
    const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
    const markedModule = await import(markedPath);
    renderMarked = (doc) => markedModule.marked.parse(doc);
  }

  let crashes = 0;
  let nondeterministic = 0;
  let nonString = 0;
  let mismatches = 0;
  const shown = [];
  const mismatchShown = [];

  for (let idx = 0; idx < opts.count; idx++) {
    const doc = randomDocument(rng, opts.maxLines);
    let first;
    try {
      first = parse(doc);
    } catch (err) {
      crashes++;
      if (shown.length < opts.show) shown.push({ kind: 'crash', index: idx, error: String(err), input: doc });
      continue;
    }
    if (typeof first !== 'string') {
      nonString++;
      if (shown.length < opts.show) shown.push({ kind: 'non-string', index: idx, error: `returned ${typeof first}`, input: doc });
      continue;
    }
    let second;
    try {
      second = parse(doc);
    } catch (err) {
      crashes++;
      if (shown.length < opts.show) shown.push({ kind: 'crash-on-reparse', index: idx, error: String(err), input: doc });
      continue;
    }
    if (second !== first) {
      nondeterministic++;
      if (shown.length < opts.show) shown.push({ kind: 'nondeterministic', index: idx, error: 'second render differs', input: doc });
    }
    if (renderMarked && idx < opts.compare) {
      const theirs = renderMarked(doc);
      if (theirs !== first) {
        mismatches++;
        if (mismatchShown.length < opts.show) mismatchShown.push({ index: idx, input: doc, mine: first, marked: theirs });
      }
    }
  }

  const failed = crashes + nondeterministic + nonString;
  console.log(`fuzz: seed=${opts.seed} docs=${opts.count} maxLines=${opts.maxLines}`);
  console.log(`  crashes=${crashes} non-string=${nonString} nondeterministic=${nondeterministic}`);
  if (renderMarked) console.log(`  vs marked: compared ${Math.min(opts.compare, opts.count)}, mismatches=${mismatches} (informational)`);
  for (const entry of shown) {
    console.log(`--- ${entry.kind} #${entry.index}: ${entry.error}`);
    console.log(JSON.stringify(entry.input));
  }
  for (const entry of mismatchShown) {
    console.log(`--- mismatch vs marked #${entry.index} input=${JSON.stringify(entry.input)}`);
    console.log(`    mine  : ${JSON.stringify(entry.mine.slice(0, 200))}`);
    console.log(`    marked: ${JSON.stringify(entry.marked.slice(0, 200))}`);
  }
  console.log(failed === 0 ? 'fuzz: OK — both invariants held on every document' : `fuzz: FAIL — ${failed} invariant violation(s)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

runFuzzer().catch((err) => {
  console.error('fuzz failed:', err.message);
  process.exitCode = 1;
});
