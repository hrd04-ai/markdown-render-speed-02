// fuzz.mjs — seeded differential + determinism fuzzer for parse.js.
//
// Random Markdown documents come from a seeded PRNG, and two
// invariants must hold for EVERY input:
//   1. parse() never throws and always returns a string;
//   2. parse() is deterministic: rendering the same input twice gives
//      the same output (the parser keeps module-level inline state, so
//      this catches state leaking between calls).
//
// Three generation modes cover different input shapes. Soup mode mixes
// random lines from fragment pools (words, inline markup, block
// constructs, stray punctuation). Nested mode grows deeply nested
// constructs — quotes inside quotes, lists inside quotes, emphasis
// inside emphasis — where container bookkeeping is most likely to slip.
// Mixed mode alternates soup lines with nested pieces, so a document
// can hold a deeply nested construct next to a stray fence or a table
// row, the way real documents do.
//
// With --compare N, the first N documents are additionally rendered
// with the kit's vendored marked and any byte differences are reported
// (the count is informational: random soup hits edges outside the
// practice set, and one residual emphasis edge is already known — see
// README "Known edge").
//
// Usage (from the entry directory):
//   node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N]
//                 [--show N] [--mode soup|nested|mixed] [--max-depth N]
//                 [--marked PATH] [--stats]
//   --seed N      PRNG seed (default 1); the same seed reproduces the run
//   --count N     documents to generate (default 500)
//   --max-lines N maximum lines per document, soup/mixed mode (default 12)
//   --mode M      soup (default), nested, or mixed
//   --max-depth N maximum nesting depth, nested/mixed mode (default 4)
//   --compare N   diff the first N documents against marked (default 0)
//   --show N      print up to N failing/crashing documents (default 3)
//   --marked P    vendored marked module (default: the kit's baseline)
//   --stats       print a feature histogram of the generated docs
//
// Exit code is 0 when both invariants hold on every generated
// document; a crash, a non-string result, or nondeterminism exits 1
// and prints the offending input (with its seed) so the case can be
// reproduced exactly.

import { parse } from './parse.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = process.env.MAKEFUN_KIT_DIR ??
  join(ENTRY_DIR, '..', 'markdown-render-speed-02-kit');

const HELP_TEXT =
  'usage: node fuzz.mjs [--seed N] [--count N] [--max-lines N] [--compare N] ' +
  '[--show N] [--mode soup|nested|mixed] [--max-depth N] [--marked PATH] [--stats]';

// ---------------------------------------------------------------------------
// Seeded PRNG: mulberry32, seeded from one 32-bit integer.
// ---------------------------------------------------------------------------

// Fold an arbitrary seed string into a 32-bit integer (FNV-1a).
function foldSeed(text) {
  let hash = 0x811c9dc5;
  for (let pos = 0; pos < text.length; pos++) {
    hash ^= text.charCodeAt(pos);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: a tiny 32-bit generator with good low-bit behaviour for
// its size. One word of state, fully deterministic for a fixed seed —
// the same seed reproduces the same document stream on every run and
// every machine. Wrapped in a small class so the generators can draw
// floats, bounded integers, and pool picks from one object.
class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  // Next float in [0, 1).
  float() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Next integer in [0, bound).
  int(bound) {
    return Math.floor(this.float() * bound);
  }

  // True with the given probability.
  chance(p) {
    return this.float() < p;
  }

  // One element of `pool`, uniformly at random.
  pick(pool) {
    return pool[this.int(pool.length)];
  }
}

// Resolve a seed string to the 32-bit integer the PRNG takes.
function seedToInt(seed) {
  if (/^-?\d+$/.test(String(seed))) return Number(seed) >>> 0;
  return foldSeed(String(seed));
}

// ---------------------------------------------------------------------------
// Fragment pools, grouped by the role each fragment plays.
// ---------------------------------------------------------------------------

const POOLS = {
  words: [
    'oak', 'pine', 'birch', 'maple', 'river', 'stone', 'ember', 'frost',
    'harbor', 'meadow', 'summit', 'valley', 'copper', 'silver', 'marble',
    'velvet', 'cobalt', 'amber', 'jasper', 'willow', 'aspen', 'cedar',
    'zephyr', 'quill', 'ledger', 'harbor', 'beacon', 'lantern', 'compass',
    'voyage', 'anchor', 'harbor', 'meadow', 'prairie', 'canyon', 'glacier',
  ],
  inline: [
    '*italic*', '**bold**', '_italic_', '__bold__', '***both***',
    '___both___', '`snippet`', '``code `x` ``', '~~deleted~~',
    '~~gone *and* back~~', '[site](https://example.org)',
    '[page](/docs "guide")', '[ref][r7]', '[shortcut]',
    '![pic](photo.jpg)', '![pic](photo.jpg "caption")',
    '<https://example.org>', '<person@example.org>', 'www.example.org',
    'https://example.org/p_(q)', 'person@example.org', 'mailto:a@b.org',
    '&lt;', '&gt;', '&quot;', '&#66;', '&#x42;', '&nosuch;', '&', '<',
    '\\*literal\\*', '\\\\', '\\`backtick\\`', 'x_y_z', 'x*y*z', '3*4*5',
    '<b>raw</b>', '<span class="x">raw</span>', '</span>', '<section>',
    '<!-- note -->', 'word  \nbreak', 'padded   ', '*x **y** z*',
    '**x *y* z**', '_x **y** z_', '[x](y "t (z)")', '[x][y]', '[x][]',
    '![x](y)', '<sftp://h/p>', '~~x~~y~~', '*x*y', '_x_y', 'p*q',
    'm_ n', '7 * 8', 'p | q',
  ],
  blocks: [
    '# Title', '## Second level', '### Third', 'Headline\n=======',
    'Subhead\n-------', '---', '***', '___', '- - -', '> quoted',
    '> > double quoted', '>> quoted2', '- first item', '- second item',
    '1. one', '2. two', '3) paren', '- [ ] open', '- [x] closed',
    '- [X] closed upper', '+ plus one', '* star one',
    '```\nplain code\n```', '```py\nprint(1)\n```', '~~~\ntilde\n~~~',
    '    code indent', '\t tab indent', '| c1 | c2 |\n|---|---|',
    '| c1 |\n|--|', '<article>\nhtml\n</article>',
    '<!-- block comment -->', '<?xml version="1" ?>',
    '[r7]: https://example.org "ref"', '[r8]: </odd url>',
    'setext line\n===', 'plain paragraph', '', '   ', '\t',
    '###### deepest', '#nospace', '11. eleven', '0. none',
    '- - dash dash', '> - quoted list', '- > list quote',
    '```rust\nlet x = 2;\n```',
  ],
  punct: ['*', '_', '~', '`', '[', ']', '(', ')', '<', '>', '#', '-', '|', '!', '\\', '"', "'", '=', '.', ':', ';', ','],
  // Edge fragments: inputs that sit on a parser decision boundary —
  // autolinks with entities, emphasis crossing link brackets, setext
  // under quotes, definitions with tricky titles, fences with odd
  // info strings. Used only by mixed mode so the soup/nested
  // distributions (and their fixed gate seeds) stay unchanged.
  edge: [
    'www.example.org/path?a=1&amp;b=2', 'https://example.org/x_(y)_z',
    'a@b.co.uk trailing.', '[*em* link](https://example.org)',
    '[**strong** link][r7]', '> setext head\n> =====',
    '> lazy line\nno marker here', '[r7]: /url (title (paren))',
    '[r7]: /url "title \\"escaped\\""', '```info with spaces\nx\n```',
    '````\n```\ninner\n```\n````', '| a | b |\n| :- | -: |\n| 1 | 2 |',
    '|a|\n|---|\n|b|c|', '- - - -\n- item\n  - nested\n    - deep',
    '1. one\n2) paren two', '*a **b *c* d** e*', '_a _b_ c_',
    '~~a ~~b~~ c~~', '`code *not em*`', 'a \\* b \\[ c',
    '<a href="https://example.org">www.example.org</a>',
    'text\n<!-- comment\nspanning lines -->\nmore text',
    '&#x41;&#65;&copy; entities', 'x\u00a0y nbsp\u2003z em',
    // Second edge batch: reference links with empty labels, images
    // with titles, fences inside quotes, tables with escaped pipes,
    // headings with trailing hashes, and autolinks at line edges.
    '[empty][]', '[empty][ ]', '![alt]()', '![a](b "t" )',
    '> ```\n> fenced in quote\n> ```', '| a \\| b | c |\n|---|---|',
    '## Head ##', '## Head ##  ', '# Head # text',
    'start https://example.org end', '(https://example.org)',
    '<ftp://files.example.org/pub>', 'user+tag@mail.example.com',
    'a_b_c_d_e', '*a*b*c*d*e', '~~a~b~~c', '`a``b`c``d`',
    '[a](b) [c](d) [e](f)', 'x [y] (z)', '[a][b][c]',
    'line\\\ncontinuation', 'para\n\n\n\npara2',
  ],
  // Openers that deepen nesting in nested/mixed mode, and their closers.
  nestOpen: ['> ', '- ', '2. ', '*', '**', '_', '~~', '`', '[', '(', '<section>\n'],
  nestWord: ['core', 'seed', 'node', 'leaf', 'root', 'a', 'bb', 'ccc'],
};

// ---------------------------------------------------------------------------
// Document generation
// ---------------------------------------------------------------------------

// One inline bit by probability band: words 45%, inline 40%,
// punctuation 15%.
function randomBit(rng) {
  const roll = rng.float();
  if (roll < 0.45) return rng.pick(POOLS.words);
  if (roll < 0.85) return rng.pick(POOLS.inline);
  return rng.pick(POOLS.punct);
}

// A random inline soup line: words, inline bits and stray punctuation,
// joined with spaces (sometimes with odd spacing or tabs).
function soupLine(rng, maxBits) {
  const count = 1 + rng.int(maxBits);
  const bits = [];
  for (let k = 0; k < count; k++) bits.push(randomBit(rng));
  const joiner = rng.chance(0.1) ? '\t' : rng.chance(0.15) ? '  ' : ' ';
  return bits.join(joiner);
}

// One line of a soup document: a block line, an inline soup line, or a
// word plus an inline fragment.
function soupDocLine(rng) {
  const roll = rng.float();
  if (roll < 0.5) return rng.pick(POOLS.blocks);
  if (roll < 0.85) return soupLine(rng, 6);
  return rng.pick(POOLS.words) + ' ' + rng.pick(POOLS.inline);
}

// A random soup document: block lines, inline soup lines, and sometimes
// a deliberately unterminated final line or extra blank lines.
function soupDocument(rng, maxLines) {
  const count = 1 + rng.int(maxLines);
  const lines = [];
  for (let k = 0; k < count; k++) lines.push(soupDocLine(rng));
  let doc = lines.join('\n');
  if (rng.chance(0.3)) doc += '\n';
  if (rng.chance(0.2)) doc += '\n\n';
  return doc;
}

// One nested construct: an opener, a nested core (or a plain word at
// depth 0), and the matching closer when the opener has one. Delimiter
// openers close with themselves; '[' closes with '](u)' or ']' at
// random; block openers ('> ', '- ', '2. ') prefix a whole line.
function nestedPiece(rng, depth) {
  const opener = rng.pick(POOLS.nestOpen);
  const core = depth <= 0 ? rng.pick(POOLS.nestWord) : nestedPiece(rng, depth - 1);
  if (opener === '> ' || opener === '- ' || opener === '2. ') {
    return opener + core;
  }
  if (opener === '<section>\n') return opener + core + '\n</section>';
  if (opener === '[') {
    return rng.chance(0.5)
      ? '[' + core + '](https://example.org)'
      : '[' + core + ']';
  }
  if (opener === '(') return '(' + core + ')';
  return opener + core + opener;
}

// A nested document: several lines, each a nested construct at a random
// depth up to maxDepth, sometimes joined into one paragraph.
function nestedDocument(rng, maxDepth) {
  const count = 1 + rng.int(6);
  const lines = [];
  for (let k = 0; k < count; k++) {
    lines.push(nestedPiece(rng, rng.int(maxDepth + 1)));
  }
  return lines.join(rng.chance(0.5) ? '\n' : '\n\n');
}

// A mixed document: soup lines, nested pieces and edge fragments
// interleaved, so one document can hold a deeply nested construct
// beside a stray fence, a table row, or an autolink with an entity.
// The mix is a roll per line: nested 40%, soup 40%, edge 20%.
function mixedDocument(rng, maxLines, maxDepth) {
  const count = 1 + rng.int(maxLines);
  const lines = [];
  for (let k = 0; k < count; k++) {
    const roll = rng.float();
    if (roll < 0.4) lines.push(nestedPiece(rng, rng.int(maxDepth + 1)));
    else if (roll < 0.8) lines.push(soupDocLine(rng));
    else lines.push(rng.pick(POOLS.edge));
  }
  let doc = lines.join('\n');
  if (rng.chance(0.25)) doc += '\n';
  return doc;
}

// Dispatch to the mode's generator.
function generateDoc(rng, opts) {
  if (opts.mode === 'nested') return nestedDocument(rng, opts.maxDepth);
  if (opts.mode === 'mixed') return mixedDocument(rng, opts.maxLines, opts.maxDepth);
  return soupDocument(rng, opts.maxLines);
}

// ---------------------------------------------------------------------------
// One document's checks
// ---------------------------------------------------------------------------

// Render `doc`, catching any throw. Returns {ok, value, error}.
function tryParse(doc) {
  try {
    return { ok: true, value: parse(doc) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Render `doc` twice and compare against marked when asked. Returns a
// result record: {ok, kind?, error?, mismatch?}.
function checkDoc(doc, renderMarked) {
  const first = tryParse(doc);
  if (!first.ok) return { ok: false, kind: 'crash', error: first.error };
  if (typeof first.value !== 'string') {
    return { ok: false, kind: 'non-string', error: `returned ${typeof first.value}` };
  }
  const second = tryParse(doc);
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

const KNOWN_MODES = ['soup', 'nested', 'mixed'];

function parseOptions(argv) {
  const opts = {
    seed: '1', count: 500, maxLines: 12, compare: 0, show: 3,
    mode: 'soup', maxDepth: 4, marked: null, stats: false,
  };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    const numeric = NUMBER_FLAGS[arg];
    if (numeric !== undefined) {
      const raw = argv[k + 1];
      if (raw === undefined) throw new Error(`missing value for ${arg}`);
      opts[numeric.key] = Math.max(numeric.min, Number(raw) || numeric.fallback);
      k++;
      continue;
    }
    switch (arg) {
      case '--seed': opts.seed = argv[k + 1] ?? '1'; k++; break;
      case '--mode': {
        const mode = argv[k + 1];
        if (!KNOWN_MODES.includes(mode)) {
          throw new Error(`unknown mode: ${mode} (soup, nested, or mixed)`);
        }
        opts.mode = mode;
        k++;
        break;
      }
      case '--marked': opts.marked = argv[k + 1] ?? null; k++; break;
      case '--stats': opts.stats = true; break;
      case '--help':
      case '-h':
        console.log(HELP_TEXT);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg} (see --help)`);
    }
  }
  return opts;
}

// Load the vendored marked module's parse function.
async function loadMarked(path) {
  const markedModule = await import(path);
  return (doc) => markedModule.marked.parse(doc);
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const rng = new Rng(seedToInt(opts.seed));
  let renderMarked = null;
  if (opts.compare > 0) {
    const markedPath = opts.marked ?? join(KIT_ROOT, 'baselines', 'vendor', 'marked', 'marked.esm.js');
    renderMarked = await loadMarked(markedPath);
  }

  const stats = { crashes: 0, nonString: 0, nondeterministic: 0, mismatches: 0 };
  const failures = [];
  const mismatchSamples = [];
  let longestDoc = 0;
  let totalDocChars = 0;
  // Feature histogram for --stats: how many generated documents
  // contain each construct (a doc counts once per feature, however
  // many times the feature appears in it).
  const features = {
    fence: 0, table: 0, quote: 0, list: 0, link: 0, image: 0,
    html: 0, autolink: 0, entity: 0, heading: 0,
  };
  function tallyFeatures(doc) {
    if (doc.includes('```') || doc.includes('~~~')) features.fence++;
    if (doc.includes('|')) features.table++;
    if (doc.includes('\n>') || doc.startsWith('>')) features.quote++;
    if (/(^|\n)[ \t]{0,3}(-|\+|\*|\d+[.)])[ \t]/.test(doc)) features.list++;
    if (doc.includes('](') || doc.includes('][')) features.link++;
    if (doc.includes('![')) features.image++;
    if (doc.includes('<') && /<[a-zA-Z/!]/.test(doc)) features.html++;
    if (doc.includes('://') || doc.includes('www.') || doc.includes('@')) features.autolink++;
    if (doc.includes('&') && /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.test(doc)) features.entity++;
    if (/(^|\n)#{1,6}[ \t]/.test(doc)) features.heading++;
  }

  for (let idx = 0; idx < opts.count; idx++) {
    const doc = generateDoc(rng, opts);
    totalDocChars += doc.length;
    if (doc.length > longestDoc) longestDoc = doc.length;
    if (opts.stats) tallyFeatures(doc);
    const marked = renderMarked && idx < opts.compare ? renderMarked : null;
    const result = checkDoc(doc, marked);
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
  const avgDocChars = Math.round(totalDocChars / opts.count);
  console.log(`fuzz: seed=${opts.seed} mode=${opts.mode} docs=${opts.count} maxLines=${opts.maxLines}`);
  console.log(`  doc sizes: avg ${avgDocChars} chars, longest ${longestDoc} chars`);
  console.log(`  crashes=${stats.crashes} non-string=${stats.nonString} nondeterministic=${stats.nondeterministic}`);
  if (opts.stats) {
    const hist = Object.entries(features)
      .map(([name, n]) => `${name}=${n}`)
      .join(' ');
    console.log(`  features (docs containing): ${hist}`);
  }
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
