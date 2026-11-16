// fuzz.mjs — seeded differential + determinism fuzzer for parse.js.
//
// Random Markdown documents come from a seeded PRNG, and two invariants
// must hold for EVERY input:
//   1. parse() never throws and always returns a string;
//   2. parse() is deterministic: rendering the same input twice gives
//      the same output (the parser keeps module-level inline state, so
//      this catches state leaking between calls).
//
// Two generation modes cover different input shapes. Soup mode mixes
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

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = process.env.MAKEFUN_KIT_DIR ??
  join(ENTRY_DIR, '..', 'markdown-render-speed-02-kit');

const USAGE_TEXT =
  'usage: node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N] ' +
  '[--show N] [--mode soup|nested] [--max-depth N] [--marked PATH]';

// ---------------------------------------------------------------------------
// Seeded PRNG: sfc32, seeded from one 32-bit integer.
// ---------------------------------------------------------------------------

// Fold an arbitrary seed string into a 32-bit integer (FNV-1a).
function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let pos = 0; pos < text.length; pos++) {
    hash ^= text.charCodeAt(pos);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// One step of splitmix32: spreads a single seed into uncorrelated words.
function spreadSeed(state) {
  let z = (state + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

// sfc32 ("small fast chaotic"): four words of state, one counter. Small,
// fast, and deterministic for a fixed seed — the same seed reproduces
// the same document stream on every run and every machine.
function createRng(seed) {
  let a = spreadSeed(seed);
  let b = spreadSeed(a);
  let c = spreadSeed(b);
  let d = spreadSeed(c);
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

const POOLS = {
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
function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

// Pick a bit class by its probability band: words 45%, inline 40%,
// punctuation 15%.
function pickBit(rng) {
  const roll = rng();
  if (roll < 0.45) return pick(rng, POOLS.words);
  if (roll < 0.85) return pick(rng, POOLS.inline);
  return pick(rng, POOLS.punct);
}

// A random inline soup line: words, inline bits and stray punctuation,
// joined with spaces (sometimes with odd spacing or tabs).
function randomSoupLine(rng, maxBits) {
  const bitCount = 1 + Math.floor(rng() * maxBits);
  const bits = [];
  for (let k = 0; k < bitCount; k++) bits.push(pickBit(rng));
  const joiner = rng() < 0.1 ? '\t' : rng() < 0.15 ? '  ' : ' ';
  return bits.join(joiner);
}

// One line of a soup document: a block line, an inline soup line, or a
// word plus an inline fragment.
function soupDocLine(rng) {
  const roll = rng();
  if (roll < 0.5) return pick(rng, POOLS.blocks);
  if (roll < 0.85) return randomSoupLine(rng, 6);
  return pick(rng, POOLS.words) + ' ' + pick(rng, POOLS.inline);
}

// A random soup document: block lines, inline soup lines, and sometimes
// a deliberately unterminated final line or extra blank lines.
function randomSoupDoc(rng, maxLines) {
  const lineCount = 1 + Math.floor(rng() * maxLines);
  const lines = [];
  for (let k = 0; k < lineCount; k++) lines.push(soupDocLine(rng));
  let doc = lines.join('\n');
  if (rng() < 0.3) doc += '\n';
  if (rng() < 0.2) doc += '\n\n';
  return doc;
}

// One nested construct: an opener, a nested core (or a plain word at
// depth 0), and the matching closer when the opener has one. Delimiter
// openers close with themselves; '[' closes with '](u)' or ']' at
// random; block openers ('> ', '- ', '1. ') prefix a whole line.
function nestedPiece(rng, depth) {
  const opener = pick(rng, POOLS.nestOpen);
  const core = depth <= 0
    ? pick(rng, POOLS.nestWord)
    : nestedPiece(rng, depth - 1);
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
function randomNestedDoc(rng, maxDepth) {
  const lineCount = 1 + Math.floor(rng() * 6);
  const lines = [];
  for (let k = 0; k < lineCount; k++) {
    const depth = Math.floor(rng() * (maxDepth + 1));
    lines.push(nestedPiece(rng, depth));
  }
  return lines.join(rng() < 0.5 ? '\n' : '\n\n');
}

// Dispatch to the mode's generator.
function generateDoc(rng, opts) {
  if (opts.mode === 'nested') return randomNestedDoc(rng, opts.maxDepth);
  return randomSoupDoc(rng, opts.maxLines);
}

// ---------------------------------------------------------------------------
// One document's checks
// ---------------------------------------------------------------------------

// Render `doc`, catching any throw. Returns {ok, value, error}.
function safeParse(doc) {
  try {
    return { ok: true, value: parse(doc) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Render `doc` twice and compare against marked when asked. Returns a
// result record: {ok, kind?, error?, mismatch?}.
function verifyDoc(doc, renderMarked) {
  const first = safeParse(doc);
  if (!first.ok) return { ok: false, kind: 'crash', error: first.error };
  if (typeof first.value !== 'string') {
    return { ok: false, kind: 'non-string', error: `returned ${typeof first.value}` };
  }
  const second = safeParse(doc);
  if (!second.ok) return { ok: false, kind: 'crash-on-reparse', error: second.error };
  if (second.value !== first.value) {
    return { ok: false, kind: 'nondeterministic', error: 'second render differs' };
  }
  if (renderMarked) {
    const theirs = renderMarked(doc);
    if (theirs !== first.value) {
      return { ok: true, mismatch: { mine: first.value, marked: theirs } };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CLI + run
// ---------------------------------------------------------------------------

// Number-valued flags: their option key, fallback, and minimum.
const NUMBER_FLAGS = {
  '--count': { key: 'count', fallback: 500, min: 1 },
  '--max-lines': { key: 'maxLines', fallback: 12, min: 1 },
  '--compare': { key: 'compare', fallback: 0, min: 0 },
  '--show': { key: 'show', fallback: 0, min: 0 },
  '--max-depth': { key: 'maxDepth', fallback: 4, min: 0 },
};

function readOptions(argv) {
  const opts = {
    seed: '1', count: 500, maxLines: 12, compare: 0, show: 3,
    mode: 'soup', maxDepth: 4, marked: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const numeric = NUMBER_FLAGS[arg];
    if (numeric !== undefined) {
      const raw = argv[++k];
      if (raw === undefined) throw new Error(`missing value for ${argv[k - 1]}`);
      opts[numeric.key] = Math.max(numeric.min, Number(raw) || numeric.fallback);
      continue;
    }
    switch (arg) {
      case '--seed': opts.seed = argv[++k] ?? '1'; break;
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
        console.log(USAGE_TEXT);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg} (see --help)`);
    }
  }
  return opts;
}

// Resolve a seed string to the 32-bit integer the PRNG takes.
function seedToInt(seed) {
  if (/^-?\d+$/.test(String(seed))) return Number(seed) >>> 0;
  return hashSeed(String(seed));
}

// Load the vendored marked module's parse function.
async function importMarked(path) {
  const markedModule = await import(path);
  return (doc) => markedModule.marked.parse(doc);
}

async function main() {
  const opts = readOptions(process.argv.slice(2));
  const rng = createRng(seedToInt(opts.seed));
  let renderMarked = null;
  if (opts.compare > 0) {
    const markedPath = opts.marked ?? join(KIT_ROOT, 'baselines', 'vendor', 'marked', 'marked.esm.js');
    renderMarked = await importMarked(markedPath);
  }

  const stats = { crashes: 0, nonString: 0, nondeterministic: 0, mismatches: 0 };
  const failures = [];
  const mismatchSamples = [];

  for (let idx = 0; idx < opts.count; idx++) {
    const doc = generateDoc(rng, opts);
    const marked = renderMarked && idx < opts.compare ? renderMarked : null;
    const result = verifyDoc(doc, marked);
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
