// fuzz.mjs — seeded differential + determinism fuzzer for parse.js.
//
// Generates random Markdown documents from a seeded PRNG and checks two
// invariants that must hold for EVERY input:
//   1. parse() never throws and always returns a string;
//   2. parse() is deterministic: rendering the same input twice gives the
//      same output (the parser keeps module-level inline state, so this
//      catches state leaking between calls).
//
// Two generation modes cover different shapes of input. Soup mode mixes
// random lines from fragment pools (words, inline markup, block
// constructs, stray punctuation). Nested mode grows deeply nested
// constructs — quotes inside quotes, lists inside quotes, emphasis
// inside emphasis — where container bookkeeping is most likely to slip.
//
// With --compare N, the first N documents are additionally rendered with
// the kit's vendored marked and any byte differences are reported (the
// count is informational: random soup hits edges outside the practice
// set, and one residual emphasis edge is already known — see README
// "Known edge").
//
// Usage (from the entry directory):
//   node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N]
//                 [--show N] [--mode soup|nested] [--max-depth N]
//                 [--marked PATH]
//   --seed N      PRNG seed (default 1); the same seed reproduces the run
//   --count N     documents to generate (default 500)
//   --max-lines N maximum lines per document, soup mode (default 12)
//   --mode M      soup (default) or nested
//   --max-depth N maximum nesting depth, nested mode (default 4)
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
// Seeded PRNG: sfc32, seeded from one 32-bit integer.
// ---------------------------------------------------------------------------

// Fold an arbitrary seed string into a 32-bit integer (FNV-1a).
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    hash ^= text.charCodeAt(k);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// One step of splitmix32: spreads a single seed into uncorrelated words.
function splitmix32(state) {
  let z = (state + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

// sfc32 ("small fast chaotic"): four words of state, one counter. Small,
// fast, and deterministic for a fixed seed — the same seed reproduces
// the same document stream on every run and every machine.
function makePrng(seed) {
  let a = splitmix32(seed);
  let b = splitmix32(a);
  let c = splitmix32(b);
  let d = splitmix32(c);
  let counter = 1;
  return function next() {
    const t = (a + b + counter++) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fragment pools, grouped by the role each fragment plays.
// ---------------------------------------------------------------------------

const FRAGMENTS = {
  words: [
    'alpha', 'beta', 'gamma', 'delta', 'word', 'text', 'hello', 'world',
    'foo', 'bar', 'baz', 'qux', 'lorem', 'ipsum', 'one', 'two', 'three',
    'a', 'I', '42', 'x1', 'under_score', 'dash-ed', 'CamelCase', 'MiXeD',
    'nord', 'syd', 'east', 'west', 'kapitel', 'rubrik', 'notat', '2026',
  ],
  inline: [
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
    '[a](b "t (x)")', '[a][b]', '[a][]', '![a](b)', '<ftp://h/x>',
    '~~a~~b~~', '*a*b', '_a_b', 'a*b', 'x_ y', '1 * 2', 'a | b',
  ],
  blocks: [
    '# Heading', '## Heading two', '### Deep', 'Heading\n=======', 'Sub\n---',
    '---', '***', '___', '- - -', '> quote', '> > nested quote', '>> quote2',
    '- item one', '- item two', '1. first', '2. second', '1) paren',
    '- [ ] todo', '- [x] done', '- [X] done upper', '+ plus item', '* star item',
    '```\ncode block\n```', '```js\nconst x = 1;\n```', '~~~\ntilde\n~~~',
    '    indented code', '\t tab code', '| a | b |\n|---|---|', '| a |\n|--|',
    '<div>\nhtml block\n</div>', '<!-- html comment -->', '<?php echo 1; ?>',
    '[r1]: https://example.com "ref title"', '[r2]: </weird url>',
    'setext\n===', 'para text here', '', '   ', '\t',
    '###### six', '#nope', '10. tenth', '0. zero', '- - nested dash',
    '> - quoted item', '- > item quote', '```info\nx\n```',
  ],
  punct: ['*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '#', '-', '|', '!', '\\', '"', "'", '=', '.', ':'],
  // Openers that deepen nesting in nested mode, and their closers.
  nestOpen: ['> ', '- ', '1. ', '*', '**', '_', '~~', '`', '[', '(', '<div>\n'],
  nestWord: ['deep', 'nest', 'inner', 'core', 'leaf', 'x', 'yy', 'zzz'],
};

// ---------------------------------------------------------------------------
// Document generation
// ---------------------------------------------------------------------------

// Draw one element of `pool` with the PRNG.
function draw(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

// A random inline soup line: words, inline bits and stray punctuation,
// joined with spaces (sometimes with odd spacing or tabs).
function soupLine(rng, maxBits) {
  const bitCount = 1 + Math.floor(rng() * maxBits);
  const bits = [];
  for (let k = 0; k < bitCount; k++) {
    const roll = rng();
    if (roll < 0.45) bits.push(draw(rng, FRAGMENTS.words));
    else if (roll < 0.85) bits.push(draw(rng, FRAGMENTS.inline));
    else bits.push(draw(rng, FRAGMENTS.punct));
  }
  const joiner = rng() < 0.1 ? '\t' : rng() < 0.15 ? '  ' : ' ';
  return bits.join(joiner);
}

// A random soup document: block lines, inline soup lines, and sometimes
// a deliberately unterminated final line or extra blank lines.
function soupDocument(rng, maxLines) {
  const lineCount = 1 + Math.floor(rng() * maxLines);
  const lines = [];
  for (let k = 0; k < lineCount; k++) {
    const roll = rng();
    if (roll < 0.5) lines.push(draw(rng, FRAGMENTS.blocks));
    else if (roll < 0.85) lines.push(soupLine(rng, 6));
    else lines.push(draw(rng, FRAGMENTS.words) + ' ' + draw(rng, FRAGMENTS.inline));
  }
  let doc = lines.join('\n');
  if (rng() < 0.3) doc += '\n';
  if (rng() < 0.2) doc += '\n\n';
  return doc;
}

// One nested construct: an opener, a nested core (or a plain word at
// depth 0), and the matching closer when the opener has one. Delimiter
// openers close with themselves; '[' closes with '](u)' or ']' at
// random; block openers ('> ', '- ', '1. ') prefix a whole line.
function nestedConstruct(rng, depth) {
  const opener = draw(rng, FRAGMENTS.nestOpen);
  const core = depth <= 0
    ? draw(rng, FRAGMENTS.nestWord)
    : nestedConstruct(rng, depth - 1);
  if (opener === '> ' || opener === '- ' || opener === '1. ') {
    return opener + core;
  }
  if (opener === '<div>\n') return opener + core + '\n</div>';
  if (opener === '[') {
    return rng() < 0.5 ? '[' + core + '](https://example.com)' : '[' + core + ']';
  }
  if (opener === '(') return '(' + core + ')';
  return opener + core + opener;
}

// A nested document: several lines, each a nested construct at a random
// depth up to maxDepth, sometimes joined into one paragraph.
function nestedDocument(rng, maxDepth) {
  const lineCount = 1 + Math.floor(rng() * 6);
  const lines = [];
  for (let k = 0; k < lineCount; k++) {
    const depth = Math.floor(rng() * (maxDepth + 1));
    lines.push(nestedConstruct(rng, depth));
  }
  return lines.join(rng() < 0.5 ? '\n' : '\n\n');
}

// Dispatch to the mode's generator.
function makeDocument(rng, opts) {
  if (opts.mode === 'nested') return nestedDocument(rng, opts.maxDepth);
  return soupDocument(rng, opts.maxLines);
}

// ---------------------------------------------------------------------------
// One document's checks
// ---------------------------------------------------------------------------

// Render `doc` twice and compare against marked when asked. Returns a
// result record: {ok, kind?, error?, mismatch?}.
function checkOne(doc, renderMarked) {
  let first;
  try {
    first = parse(doc);
  } catch (err) {
    return { ok: false, kind: 'crash', error: String(err) };
  }
  if (typeof first !== 'string') {
    return { ok: false, kind: 'non-string', error: `returned ${typeof first}` };
  }
  let second;
  try {
    second = parse(doc);
  } catch (err) {
    return { ok: false, kind: 'crash-on-reparse', error: String(err) };
  }
  if (second !== first) {
    return { ok: false, kind: 'nondeterministic', error: 'second render differs' };
  }
  if (renderMarked) {
    const theirs = renderMarked(doc);
    if (theirs !== first) {
      return { ok: true, mismatch: { mine: first, marked: theirs } };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CLI + run
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    seed: '1', count: 500, maxLines: 12, compare: 0, show: 3,
    mode: 'soup', maxDepth: 4, marked: null,
  };
  const readNumber = (k, fallback) => {
    const raw = argv[k + 1];
    if (raw === undefined) throw new Error(`missing value for ${argv[k]}`);
    return Number(raw) || fallback;
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    switch (arg) {
      case '--seed': opts.seed = argv[++k] ?? '1'; break;
      case '--count': opts.count = Math.max(1, readNumber(k, 500)); k++; break;
      case '--max-lines': opts.maxLines = Math.max(1, readNumber(k, 12)); k++; break;
      case '--compare': opts.compare = Math.max(0, readNumber(k, 0)); k++; break;
      case '--show': opts.show = Math.max(0, readNumber(k, 0)); k++; break;
      case '--max-depth': opts.maxDepth = Math.max(0, readNumber(k, 4)); k++; break;
      case '--mode': {
        const mode = argv[++k];
        if (mode !== 'soup' && mode !== 'nested') {
          throw new Error(`unknown mode: ${mode} (soup or nested)`);
        }
        opts.mode = mode;
        break;
      }
      case '--marked': opts.marked = argv[++k] ?? null; break;
      case '--help':
      case '-h':
        console.log('usage: node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N] [--show N] [--mode soup|nested] [--max-depth N] [--marked PATH]');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg} (see --help)`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const numericSeed = /^-?\d+$/.test(String(opts.seed))
    ? Number(opts.seed) >>> 0
    : fnv1a(String(opts.seed));
  const rng = makePrng(numericSeed);
  let renderMarked = null;
  if (opts.compare > 0) {
    const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
    const markedModule = await import(markedPath);
    renderMarked = (doc) => markedModule.marked.parse(doc);
  }

  const stats = { crashes: 0, nonString: 0, nondeterministic: 0, mismatches: 0 };
  const failures = [];
  const mismatchSamples = [];

  for (let idx = 0; idx < opts.count; idx++) {
    const doc = makeDocument(rng, opts);
    const marked = renderMarked && idx < opts.compare ? renderMarked : null;
    const result = checkOne(doc, marked);
    if (!result.ok) {
      if (result.kind === 'crash' || result.kind === 'crash-on-reparse') stats.crashes++;
      else if (result.kind === 'non-string') stats.nonString++;
      else stats.nondeterministic++;
      if (failures.length < opts.show) {
        failures.push({ kind: result.kind, index: idx, error: result.error, input: doc });
      }
      continue;
    }
    if (result.mismatch) {
      stats.mismatches++;
      if (mismatchSamples.length < opts.show) {
        mismatchSamples.push({ index: idx, input: doc, ...result.mismatch });
      }
    }
  }

  const failed = stats.crashes + stats.nonString + stats.nondeterministic;
  console.log(`fuzz: seed=${opts.seed} mode=${opts.mode} docs=${opts.count} maxLines=${opts.maxLines}`);
  console.log(`  crashes=${stats.crashes} non-string=${stats.nonString} nondeterministic=${stats.nondeterministic}`);
  if (renderMarked) {
    console.log(`  vs marked: compared ${Math.min(opts.compare, opts.count)}, mismatches=${stats.mismatches} (informational)`);
  }
  for (const entry of failures) {
    console.log(`--- ${entry.kind} #${entry.index}: ${entry.error}`);
    console.log(JSON.stringify(entry.input));
  }
  for (const entry of mismatchSamples) {
    console.log(`--- mismatch vs marked #${entry.index} input=${JSON.stringify(entry.input)}`);
    console.log(`    mine  : ${JSON.stringify(entry.mine.slice(0, 200))}`);
    console.log(`    marked: ${JSON.stringify(entry.marked.slice(0, 200))}`);
  }
  console.log(failed === 0
    ? 'fuzz: OK — both invariants held on every document'
    : `fuzz: FAIL — ${failed} invariant violation(s)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('fuzz failed:', err.message);
  process.exitCode = 1;
});
