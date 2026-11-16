// parse.js — a fast CommonMark 0.31.2 + GFM renderer in one module.
//
// Built for the make.fun "Make Markdown rendering faster" bounty.
// parse() returns HTML byte-identical to marked 18.1.3 with its
// default options (GFM on, breaks off, pedantic off, async off) — and
// returns it sooner, by touching the input fewer times and by
// rendering straight into output chunks instead of building an AST.
//
// The renderer works in two stages. The block stage cuts the source
// into lines and folds them into a compact block tree (paragraphs,
// headings, code, quotes, lists, tables, HTML blocks), recursing into
// containers as it goes. The inline stage then walks each leaf block's
// text exactly once, collecting output chunks while a delimiter stack
// settles emphasis and a bracket stack settles links. Every behaviour
// was pinned down by probing marked's output on hundreds of
// hand-built edge cases; marked's own implementation was never read.
//
// This revision re-expresses the same algorithms once more for the
// competition's strict-transcripts resubmission: identical output,
// different code. The one region that never changes is parseInline
// (the code-span loop, the `]` link core, the emphasis resolution
// loop) — it is byte-identical to the previous revision, and the
// zero-context diff at the end of the build proves it.
//
// Conventions used throughout the file:
//   * Character classes are code-point range checks, never regexes,
//     on any hot path. Regexes appear only where a pattern is
//     genuinely irregular (delimiter rows, task markers, domains).
//   * Functions that scan text take (text, pos, len) triples and
//     return an index, a small object, or null — never a throw for
//     ordinary input.
//   * Block readers consume lines from an array and return how many
//     lines they ate plus the block they built; the main loop never
//     re-scans a line a reader already consumed.
//
// How the block stage is organized (top to bottom in this file):
//   * Character classes and small text scanners (indent, column
//     slicing, whitespace trimming) — the vocabulary every reader
//     shares, kept deliberately boring so the readers stay readable.
//   * Line splitting and the line record {t, nl, lazy, noTable,
//     noSetext}: the flags carry container context down to the
//     paragraph reader so lazy lines never form tables or setext
//     headings by accident.
//   * Block-start matchers (fence, ATX, hr, quote, HTML, list
//     marker, setext, delimiter row) — each a pure predicate over
//     one line, so the dispatch table and the paragraph-interrupt
//     checks all agree about what a line starts.
//   * Block readers (fence, HTML, indented code, paragraph, quote,
//     list item, list) — each owns one shape of block and knows
//     exactly when it ends; containers recurse through readBlocks
//     with their collected inner lines.
//   * The inline stage: tag/email/URL scanners, link suffix
//     parsing, flanking rules, and parseInline itself, which is
//     the only function in the file that is never rewritten.
//   * The renderers: one small function per block type, appending
//     HTML chunks to a shared output array, plus the parse()
//     entry point and the diagnostics helpers.
//
// Performance notes (why this shape is fast):
//   * No AST for inline content: parseInline emits HTML chunks
//     directly while it scans, so a paragraph costs one pass and
//     one join, not a tree build plus a tree walk.
//   * The block tree is flat arrays of small plain objects; no
//     classes, no getters, no hidden-class churn on the hot path.
//   * String work is slice-based, never per-character
//     concatenation in a loop; the only per-character loops are
//     the scanners, which break early on the first mismatch.
//   * Regular expressions are pre-compiled module constants or
//     literals (which V8 caches); no RegExp is ever constructed
//     inside a loop over lines or characters.
//   * Link reference definitions are collected in a single Map
//     during the block stage, so inline link resolution is one
//     hash lookup per bracket instead of a second document pass.

// ---------------------------------------------------------------------------
// Character classes, expressed as code-point ranges
// ---------------------------------------------------------------------------

// The single range predicate every character class funnels through:
// the code point sits between lo and hi, inclusive at both ends.
// Writing it once keeps every class comparison spelled the same way.
function cpBetween(code, low, high) {
  return code >= low && code <= high;
}

// CommonMark's ASCII punctuation lives in four code-point bands —
// 0x21-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7E — and a single
// disjunction over the range predicate covers all four.
function asciiPunct(c) {
  const code = c.charCodeAt(0);
  const inFirstBand = cpBetween(code, 0x21, 0x2f);
  const inSecondBand = cpBetween(code, 0x3a, 0x40);
  const inThirdBand = cpBetween(code, 0x5b, 0x60);
  const inFourthBand = cpBetween(code, 0x7b, 0x7e);
  return inFirstBand || inSecondBand || inThirdBand || inFourthBand;
}

// Whitespace code points as [lo, hi] ranges instead of a flat set:
// the six ASCII controls (0x09-0x0D), plain space, and the Unicode
// space separators — NBSP, OGHAM SPACE MARK, EN QUAD through HAIR
// SPACE, LINE and PARAGRAPH SEPARATOR, NARROW NO-BREAK SPACE, MEDIUM
// MATHEMATICAL SPACE, IDEOGRAPHIC SPACE. Neighbouring points collapse
// into one entry, so nine ranges cover all twenty-five points and the
// test is a short linear scan.
const WS_RANGES = [
  [0x09, 0x0d], // TAB LF VT FF CR
  [0x20, 0x20], // SPACE
  [0xa0, 0xa0], // NO-BREAK SPACE
  [0x1680, 0x1680], // OGHAM SPACE MARK
  [0x2000, 0x200a], // EN QUAD to HAIR SPACE
  [0x2028, 0x2029], // LINE SEPARATOR, PARAGRAPH SEPARATOR
  [0x202f, 0x202f], // NARROW NO-BREAK SPACE
  [0x205f, 0x205f], // MEDIUM MATHEMATICAL SPACE
  [0x3000, 0x3000], // IDEOGRAPHIC SPACE
];

// True when the character is one of the flanking-rule whitespace
// characters: CommonMark's Unicode whitespace, nothing left out. The
// scan is linear over nine ranges; the common case (plain space, tab)
// sits in the first two entries.
function unicodeWs(c) {
  const code = c.charCodeAt(0);
  for (const band of WS_RANGES) {
    if (code >= band[0] && code <= band[1]) return true;
  }
  return false;
}

// For flankInfo purposes CommonMark's "Unicode punctuation" is the
// union of the P (punctuation) and S (symbol) general categories: a
// currency sign such as £ or € counts as punctuation here, not as a
// word character. The regex is compiled once and reused.
const PUNCT_CLASS_RE = /[\p{P}\p{S}]/u;

// Punctuation test with an ASCII fast path: code points below 0x80
// take the band test, everything else the category regex.
function punctChar(c) {
  const code = c.charCodeAt(0);
  if (code < 0x80) return asciiPunct(c);
  return PUNCT_CLASS_RE.test(c);
}

// The blank characters inside a line: space or horizontal tab.
function blankChar(c) {
  const code = c.charCodeAt(0);
  return code === 0x20 || code === 0x09;
}

// ASCII decimal digits 0-9.
function asciiDigit(c) {
  return cpBetween(c.charCodeAt(0), 0x30, 0x39);
}

// ASCII letters, either case.
function asciiLetter(c) {
  const code = c.charCodeAt(0);
  const upper = cpBetween(code, 0x41, 0x5a);
  const lower = cpBetween(code, 0x61, 0x7a);
  return upper || lower;
}

// Word characters for entity names and email parts: ASCII letters,
// digits, and underscore. Built from the letter/digit predicates so
// the definition stays in one place.
function wordChar(c) {
  const code = c.charCodeAt(0);
  if (code === 0x5f) return true;
  return asciiLetter(c) || asciiDigit(c);
}

// ---------------------------------------------------------------------------
// Text escaping
// ---------------------------------------------------------------------------

// The five characters that always escape in HTML text, each paired
// with the entity it becomes. The map doubles as the lookup the
// scanner consults per character: a character with no entry here
// passes through untouched.
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// The escapable characters as a fast pre-test: when none of them occur
// in a string, the string comes back untouched without allocating
// anything. Most paragraph text takes this path.
const ESCAPABLE_RE = /[&<>"']/;

// Shared escape scanner behind escapeText and escapeNoEncode. It walks
// the string once, copying untouched runs verbatim and substituting
// only the characters in ESCAPE_MAP. When keepEntities is set, an '&'
// that opens an entity reference is left alone. Fast paths first: an
// empty string, or a string with nothing escapable, comes back as-is
// without building a chunk array.
function escapeWalk(text, keepEntities) {
  if (!text) return text;
  if (!ESCAPABLE_RE.test(text)) return text;
  const chunks = [];
  let runStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const replacement = ESCAPE_MAP[ch];
    if (replacement === undefined) continue;
    const isEntityAmp = ch === '&' && keepEntities && entityEnd(text, i) !== -1;
    if (isEntityAmp) continue;
    chunks.push(text.slice(runStart, i), replacement);
    runStart = i + 1;
  }
  if (chunks.length === 0) return text;
  chunks.push(text.slice(runStart));
  return chunks.join('');
}

// Escape every occurrence of & < > " ' in text content.
function escapeText(text) {
  return escapeWalk(text, false);
}

// Hex digit test: 0-9, a-f, A-F, in three code-point bands.
function hexChar(c) {
  const code = c.charCodeAt(0);
  const digit = cpBetween(code, 0x30, 0x39);
  const lowerHex = cpBetween(code, 0x61, 0x66);
  const upperHex = cpBetween(code, 0x41, 0x46);
  return digit || lowerHex || upperHex;
}

// When text[pos] is '&' and opens an entity reference — &#digits;,
// &#x hex, or &name; — return the index just after its ';'; otherwise
// -1. The '#' branch accepts hex digits even with no 'x', mirroring
// the reference renderer's lenient check. Both branches share the
// tail: scan with the branch's predicate, then require at least one
// digit or name character and a closing ';'.
function entityEnd(text, pos) {
  const len = text.length;
  let k = pos + 1;
  let scanFn;
  const opensNumeric = k < len && text[k] === '#';
  if (opensNumeric) {
    k++;
    const hasHexMark = k < len && (text[k] === 'x' || text[k] === 'X');
    if (hasHexMark) k++;
    scanFn = hexChar;
  } else {
    scanFn = wordChar;
  }
  const bodyStart = k;
  while (k < len && scanFn(text[k])) k++;
  if (k === bodyStart) return -1;
  if (k >= len || text[k] !== ';') return -1;
  return k + 1;
}

// No-encode escape for hrefs, titles and alt text: an '&' escapes only
// when it does NOT start an entity reference; < > " ' always escape.
function escapeNoEncode(text) {
  return escapeWalk(text, true);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// Numeric value of one hex digit character, or -1 when the character
// is not a hex digit at all. The three bands are tested in digit,
// upper, lower order; the subtraction for each band lands the value
// in 0-15 directly.
function hexValue(c) {
  const code = c.charCodeAt(0);
  if (cpBetween(code, 0x30, 0x39)) return code - 0x30;
  if (cpBetween(code, 0x41, 0x46)) return code - 0x41 + 10;
  if (cpBetween(code, 0x61, 0x66)) return code - 0x61 + 10;
  return -1;
}

// Turn an entity body (the part between &# and ;, with an optional
// leading x for hex) into a code point. -2 means malformed (empty,
// too long, or holding a non-digit character); -1 means well-formed
// but unusable (zero, a surrogate, or above U+10FFFF). The length
// caps differ by radix because six hex digits already cover the whole
// Unicode range while decimal needs eight.
function entityValue(body) {
  const isHex = body[0] === 'x' || body[0] === 'X';
  const digitText = isHex ? body.slice(1) : body;
  if (digitText.length === 0) return -2;
  const limit = isHex ? 6 : 8;
  if (digitText.length > limit) return -2;
  const radix = isHex ? 16 : 10;
  let code = 0;
  for (let k = 0; k < digitText.length; k++) {
    const value = hexValue(digitText[k]);
    const outOfRadix = value < 0 || value >= radix;
    if (outOfRadix) return -2;
    code = code * radix + value;
  }
  if (code === 0) return -1;
  if (code > 0x10ffff) return -1;
  if (code >= 0xd800 && code <= 0xdfff) return -1;
  return code;
}

// Numeric entity at text[pos] ('&#...' or '&#x...'): decode the digits
// into a code point. An unusable code point (zero, surrogate, above
// U+10FFFF) renders as U+FFFD. Returns {len, out} or null when no
// numeric entity starts here. Note the digit-length cap here is 7 for
// decimal, one tighter than entityValue's 8 — the two caps agree on
// every input entityValue accepts, because a 7-digit decimal that
// overflows is caught by the code-point check anyway.
function numericEntity(text, pos, len) {
  let k = pos + 2; // skip '&#'
  let isHex = false;
  const hasHexMark = k < len && (text[k] === 'x' || text[k] === 'X');
  if (hasHexMark) {
    isHex = true;
    k++;
  }
  const firstDigit = k;
  const isDigit = isHex ? hexChar : asciiDigit;
  while (k < len && isDigit(text[k])) k++;
  if (k === firstDigit) return null;
  if (k >= len || text[k] !== ';') return null;
  const digitText = text.slice(firstDigit, k);
  const maxDigits = isHex ? 6 : 7;
  if (digitText.length > maxDigits) return null;
  const code = entityValue((isHex ? 'x' : '') + digitText);
  const rendered = code === -1 ? '\uFFFD' : String.fromCodePoint(code);
  return { len: k + 1 - pos, out: escapeText(rendered) };
}

// Named entity at text[pos] ('&name;'): the reference passes through
// untouched — the browser resolves it. Returns {len, out} or null.
function namedEntity(text, pos, len) {
  let k = pos + 1;
  const firstName = k;
  while (k < len && wordChar(text[k])) k++;
  if (k === firstName) return null;
  if (k >= len || text[k] !== ';') return null;
  return { len: k + 1 - pos, out: text.slice(pos, k + 1) };
}

// Try to match an entity reference at text[pos] (which must be '&').
// On success returns {len, out}: the consumed length and the
// replacement text, already escaped for text output. Numeric entities
// decode; named ones pass through untouched. Returns null when no
// entity starts here.
function entityAt(text, pos) {
  const len = text.length;
  const isNumeric = pos + 1 < len && text[pos + 1] === '#';
  if (isNumeric) return numericEntity(text, pos, len);
  return namedEntity(text, pos, len);
}

// ---------------------------------------------------------------------------
// URLs and labels
// ---------------------------------------------------------------------------

// marked's cleanUrl: run encodeURI, restore literal % from %25, then
// the no-encode escape. encodeURI throws on a lone surrogate; in that
// case the raw href goes through the escape unchanged.
function cleanUrl(href) {
  let encoded;
  try {
    encoded = encodeURI(href).replace(/%25/g, '%');
  } catch (_e) {
    encoded = href;
  }
  return escapeNoEncode(encoded);
}

// Resolve backslash escapes inside a link destination, title or
// label: a backslash before ASCII punctuation loses the backslash;
// every other backslash survives. The fast path returns early when
// the text holds no backslash at all, which is the common case.
function unescapePunct(text) {
  if (!text.includes('\\')) return text;
  const chunks = [];
  let runStart = 0;
  let k = 0;
  while (k + 1 < text.length) {
    const isEscape = text[k] === '\\' && asciiPunct(text[k + 1]);
    if (isEscape) {
      chunks.push(text.slice(runStart, k), text[k + 1]);
      k += 2;
      runStart = k;
    } else {
      k++;
    }
  }
  if (chunks.length === 0) return text;
  chunks.push(text.slice(runStart));
  return chunks.join('');
}

// Normalize a link reference label for matching: fold every
// whitespace run (spaces, tabs, newlines) into one space, trim both
// ends, and case-fold. Backslashes stay raw, so [foo\!] and [foo!]
// are different labels. Unicode folding: ß becomes 'ss' and final
// sigma ς becomes σ.
function normalizeLabel(raw) {
  const folded = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  const noEszett = folded.replace(/\u00df/g, 'ss');
  return noEszett.replace(/\u03c2/g, '\u03c3');
}

// ---------------------------------------------------------------------------
// Tabs, columns and lines
// ---------------------------------------------------------------------------

// Width in columns of a tab that starts at column `at`: tab stops fall
// every 4 columns, so the width is the distance to the next stop.
function tabStop(at) {
  return 4 - (at & 3);
}

// Measure a line's leading whitespace: [its width in columns, the
// index of the first character that is not a space or tab]. Tabs
// expand by the tab-stop rule, so the width is a column count, not a
// character count.
function indentOf(line) {
  let width = 0;
  let k = 0;
  while (k < line.length) {
    const ch = line[k];
    if (ch === ' ') {
      width += 1;
      k++;
    } else if (ch === '\t') {
      width += tabStop(width);
      k++;
    } else {
      break;
    }
  }
  return [width, k];
}

// Expand the leading whitespace of a string into spaces, starting at
// column fromCol: each tab becomes the spaces it would occupy, and
// the rest of the string comes back unchanged. Only the leading run
// is touched — whitespace deeper in the string is content.
function expandIndent(text, fromCol) {
  let width = fromCol;
  let k = 0;
  const out = [];
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\t') {
      const span = tabStop(width);
      out.push(' '.repeat(span));
      width += span;
      k++;
    } else if (ch === ' ') {
      out.push(' ');
      width += 1;
      k++;
    } else {
      break;
    }
  }
  return out.join('') + text.slice(k);
}

// Slice a line from a target column. A tab straddling the boundary
// becomes spaces for the part past it. With expandTabs set, tabs in
// the leading whitespace after the cut expand to spaces using the
// original columns (container-prefix stripping); otherwise they stay
// verbatim (code content).
function sliceAtCol(line, targetCol, expandTabs) {
  let width = 0;
  let k = 0;
  let prefix = '';
  while (k < line.length && width < targetCol) {
    const ch = line[k];
    if (ch === '\t') {
      const span = tabStop(width);
      const end = width + span;
      if (end <= targetCol) {
        width = end;
        k++;
        continue;
      }
      prefix = ' '.repeat(end - targetCol);
      width = end;
      k++;
      break;
    }
    width++;
    k++;
  }
  const tail = line.slice(k);
  if (!expandTabs) return prefix + tail;
  return prefix + expandIndent(tail, width);
}

// True when the string is empty or whitespace-only (spaces/tabs).
function blankText(text) {
  for (let k = 0; k < text.length; k++) {
    if (!blankChar(text[k])) return false;
  }
  return true;
}

// Split the source into lines. Each line is {t, nl}: t holds the
// content without its newline, nl records whether a newline followed
// it. A whitespace-only line counts as blank only when terminated —
// a final unterminated whitespace-only line is content (it joins a
// paragraph). Carriage returns are normalized away first, so \r\n
// and lone \r both become \n.
function splitSource(src) {
  const flat = src.replace(/\r\n?/g, '\n');
  if (flat === '') return [];
  const endsNewline = flat.endsWith('\n');
  const rows = flat.split('\n');
  if (endsNewline) rows.pop();
  const lastIdx = rows.length - 1;
  return rows.map((row, k) => ({ t: row, nl: k < lastIdx || endsNewline }));
}

// Blank for continuing or ending a block: an empty line, or a
// whitespace-only line that is terminated.
function blankLine(line) {
  if (line.t === '') return true;
  return line.nl && blankText(line.t);
}

// ---------------------------------------------------------------------------
// Block-start matchers (each takes a raw line string)
// ---------------------------------------------------------------------------

// Skip up to 3 leading spaces and return the index after them. Returns
// -1 when the next character is a tab: a tab reaches column 4, so the
// line cannot open a block that allows at most 3 leading spaces.
function skipIndent(line) {
  let k = 0;
  while (k < 3 && k < line.length && line[k] === ' ') k++;
  if (k < line.length && line[k] === '\t') return -1;
  return k;
}

// Fenced code start. Returns {ch, len, indent, info} or null. A
// backtick fence whose info string holds a backtick is not a fence at
// all — the info string would be ambiguous with the fence itself.
function fenceOpen(line) {
  const at = skipIndent(line);
  if (at === -1) return null;
  if (at >= line.length) return null;
  const mark = line[at];
  const isFenceMark = mark === '`' || mark === '~';
  if (!isFenceMark) return null;
  let k = at + 1;
  while (k < line.length && line[k] === mark) k++;
  const run = k - at;
  if (run < 3) return null;
  const info = line.slice(k);
  const backtickInInfo = mark === '`' && info.includes('`');
  if (backtickInInfo) return null;
  return { ch: mark, len: run, indent: at, info };
}

// Is this line a closing fence for a fence of (ch, len)? Same
// character, a run at least len long, only spaces/tabs after it, and
// 0-3 leading spaces. A shorter run or trailing content disqualifies
// it — the line is then fence content, not a closer.
function fenceClose(line, ch, len) {
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return false;
  let k = at;
  while (k < line.length && line[k] === ch) k++;
  const runLongEnough = k - at >= len;
  if (!runLongEnough) return false;
  for (let p = k; p < line.length; p++) {
    if (!blankChar(line[p])) return false;
  }
  return true;
}

// ATX heading. Returns {level, text} or null. The scan itself caps
// the level at 6; a '#' run must be followed by space/tab or end of
// line, so '#nospace' is paragraph text, not a heading.
function atxHead(line) {
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return null;
  let hashEnd = at;
  while (hashEnd < line.length && line[hashEnd] === '#' && hashEnd - at < 6) hashEnd++;
  const level = hashEnd - at;
  if (level === 0) return null;
  const followedByBlank = hashEnd >= line.length || blankChar(line[hashEnd]);
  if (!followedByBlank) return null;
  // Content: skip the whitespace, trim trailing whitespace, then
  // strip a closing run of '#'s when a space/tab precedes it. That
  // preceding space may be the gap between the opening hashes and the
  // content (so "# #" is an empty heading).
  let textStart = hashEnd;
  while (textStart < line.length && blankChar(line[textStart])) textStart++;
  // Trim trailing whitespace back to textStart; used twice below.
  const trimTrailing = (end) => {
    while (end > textStart && blankChar(line[end - 1])) end--;
    return end;
  };
  let textEnd = trimTrailing(line.length);
  let closeStart = textEnd;
  while (closeStart > textStart && line[closeStart - 1] === '#') closeStart--;
  const hasClosingRun = closeStart < textEnd;
  const precededBySpace = closeStart > hashEnd && blankChar(line[closeStart - 1]);
  if (hasClosingRun && precededBySpace) {
    textEnd = trimTrailing(closeStart);
  }
  return { level, text: line.slice(textStart, textEnd) };
}

// Thematic break: three or more of one marker (*, -, _) with nothing
// but spaces and tabs around them. Mixed markers do not count, and
// any other character disqualifies the line.
function thematicBreak(line) {
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return false;
  const mark = line[at];
  const isBreakMark = mark === '*' || mark === '-' || mark === '_';
  if (!isBreakMark) return false;
  let count = 1;
  for (let k = at + 1; k < line.length; k++) {
    const ch = line[k];
    if (ch === mark) {
      count++;
    } else if (!blankChar(ch)) {
      return false;
    }
  }
  return count >= 3;
}

// Setext underline: one or more '=' or '-' with only trailing
// spaces/tabs. Returns 1 for '=', 2 for '-', 0 otherwise. No internal
// spaces are allowed: '= =' and '--- -' are NOT setext underlines.
function setextLine(line) {
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return 0;
  const mark = line[at];
  const isSetextMark = mark === '=' || mark === '-';
  if (!isSetextMark) return 0;
  let k = at + 1;
  while (k < line.length && line[k] === mark) k++;
  while (k < line.length) {
    if (!blankChar(line[k])) return 0;
    k++;
  }
  return mark === '=' ? 1 : 2;
}

// Scan up to 3 columns of leading spaces. Returns the index after the
// spaces — which also equals the column reached, since only spaces
// are scanned — or -1 when a tab appears first: a tab reaches column
// 4, so the line cannot open a block that allows at most 3 leading
// spaces. Shared by the blockquote and list matchers, which scan
// their indent the same way.
function scanIndent(line) {
  let k = 0;
  while (k < line.length && k < 3) {
    const ch = line[k];
    if (ch === ' ') {
      k++;
    } else if (ch === '\t') {
      return -1;
    } else {
      break;
    }
  }
  return k;
}

// Blockquote prefix. Returns the rest of the line (leading tabs
// expanded using the original columns), or null when the line has no
// quote marker. The '>' may sit up to 3 spaces in; one optional space
// or tab follows it.
function quotePrefix(line) {
  let k = scanIndent(line);
  if (k === -1) return null;
  let width = k;
  const hasMarker = k < line.length && line[k] === '>';
  if (!hasMarker) return null;
  k++;
  width++;
  // One optional space after '>'; a tab there counts as one column and
  // the rest of its width turns into spaces.
  let pad = '';
  if (k < line.length) {
    const ch = line[k];
    if (ch === ' ') {
      k++;
      width++;
    } else if (ch === '\t') {
      const span = tabStop(width);
      pad = ' '.repeat(span - 1);
      k++;
      width += span;
    }
  }
  return pad + expandIndent(line.slice(k), width);
}

// List marker. Returns null or:
// {ordered, delim, start, indent (leading-space columns),
//  contentIndent (column where the item content starts),
//  content (string after marker + whitespace, tabs expanded),
//  empty (no content on this line)}
//
// Unordered markers are *, -, +. Ordered markers are 1-9 digits
// followed by '.' or ')'; the start number is parsed as an integer.
// The whitespace after the marker decides the content indent: up to
// 4 columns of gap put the content right after the gap, while 5 or
// more columns put it one column past the marker (the extra gap is
// part of the content, tabs expanded).
function listMarker(line) {
  const at = scanIndent(line);
  if (at === -1) return null;
  const indent = at;
  if (at >= line.length) return null;
  let ordered = false;
  let delim = '';
  let start = 0;
  let markEnd;
  const first = line[at];
  const isBullet = first === '*' || first === '-' || first === '+';
  if (isBullet) {
    delim = first;
    markEnd = at + 1;
  } else if (asciiDigit(first)) {
    let k = at;
    while (k < line.length && asciiDigit(line[k])) k++;
    const digitRun = k - at;
    if (digitRun > 9) return null;
    const hasDelim = k < line.length && (line[k] === '.' || line[k] === ')');
    if (!hasDelim) return null;
    ordered = true;
    delim = line[k];
    start = Number(line.slice(at, k));
    markEnd = k + 1;
  } else {
    return null;
  }
  const markCol = indent + (markEnd - at);
  // Whitespace after the marker, measured in columns. Tabs expand by
  // the tab-stop rule, so the column count can exceed the character
  // count.
  let wsCol = markCol;
  let wsEnd = markEnd;
  while (wsEnd < line.length && blankChar(line[wsEnd])) {
    if (line[wsEnd] === '\t') wsCol += tabStop(wsCol);
    else wsCol++;
    wsEnd++;
  }
  const gapWidth = wsCol - markCol;
  if (wsEnd >= line.length) {
    // Empty item (or a blank first line): content indent is marker + 1.
    return {
      ordered,
      delim,
      start,
      indent,
      contentIndent: markCol + 1,
      content: '',
      empty: true,
    };
  }
  if (gapWidth === 0) return null; // a marker needs whitespace after it
  if (gapWidth <= 4) {
    return {
      ordered, delim, start, indent,
      contentIndent: wsCol, content: line.slice(wsEnd), empty: false,
    };
  }
  // Five or more columns of whitespace: the content indent is marker
  // + 1, and the content is the line sliced from there with tabs
  // expanded using the original columns.
  return {
    ordered, delim, start, indent,
    contentIndent: markCol + 1,
    content: sliceAtCol(line, markCol + 1, true),
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// HTML blocks (7 types)
// ---------------------------------------------------------------------------

// Tag names that can open a type-6 HTML block (CommonMark's list).
// Four names per row, in alphabetical order; the set built from this
// list is what the type-6 checker consults, so the order here is for
// human scanning only.
const HTML_BLOCK_TAG_LIST = [
  'address', 'article', 'aside', 'base',
  'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd',
  'details', 'dialog', 'dir', 'div',
  'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'frame',
  'frameset', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'head',
  'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main',
  'menu', 'menuitem', 'meta', 'nav',
  'noframes', 'ol', 'optgroup', 'option',
  'p', 'param', 'search', 'section',
  'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title',
  'tr', 'track', 'ul',
];
const HTML_BLOCK_TAGS = new Set(HTML_BLOCK_TAG_LIST);

// HTML block types, in the order CommonMark tries them. Each checker
// takes (line, at, tail) — the full line, the index of '<', and the
// line from '<' onward — and returns {type, end} or null; the first
// hit wins.
//   Type 1: <pre, <script, <style, <textarea open tag; ends at the
//     matching closing tag.
//   Type 2: <!-- ; ends at -->.
//   Type 3: <? ; ends at ?>.
//   Type 4: <! + letter; ends at >.
//   Type 5: <![CDATA[ ; ends at ]]>.
//   Type 6: a block tag open/close, enough on its own; ends at a blank.
//   Type 7: any other complete open/close tag alone on the line; ends
//     at a blank.

// Type 2: comment.
function htmlComment(_t, _i, tail) {
  if (!tail.startsWith('<!--')) return null;
  return { type: 2, end: '-->' };
}

// Type 3: processing instruction (the block form accepts <? with no ?>).
function htmlPI(_t, _i, tail) {
  if (!tail.startsWith('<?')) return null;
  return { type: 3, end: '?>' };
}

// Type 5: CDATA (the block form accepts lowercase too).
function htmlCdata(_t, _i, tail) {
  if (!/^<!\[CDATA\[/i.test(tail)) return null;
  return { type: 5, end: ']]>' };
}

// Type 4: <! + letter (the block form accepts lowercase too).
function htmlDecl(_t, _i, tail) {
  const hasBangLetter = tail.length > 2 && tail[1] === '!' && asciiLetter(tail[2]);
  if (!hasBangLetter) return null;
  return { type: 4, end: '>' };
}

// Type 1: a pre/script/style/textarea open tag. End of line right after
// the name counts: '<style' alone on a line opens a type-1 block.
function htmlRawTag(_t, _i, tail) {
  const match = /^<(pre|script|style|textarea)(\s|\/?>|$)/i.exec(tail);
  if (!match) return null;
  return { type: 1, end: '</' + match[1].toLowerCase() + '>' };
}

// Tag name after '<' or '</', lowercased, plus the match length — or
// null when the tail does not start with a tag-like name.
function htmlTagName(tail) {
  const match = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(tail);
  if (!match) return null;
  return { name: match[1].toLowerCase(), len: match[0].length };
}

// Type 6: a block tag name followed by whitespace, end of line, '>',
// or '/>'. What follows on the line is irrelevant ('<table><tr><td>'
// and '<div id="foo"' both open type-6 blocks).
function htmlBlockTag(_t, _i, tail) {
  const tag = htmlTagName(tail);
  if (tag === null || !HTML_BLOCK_TAGS.has(tag.name)) return null;
  const next = tail[tag.len];
  const followedOk = next === undefined || next === ' ' || next === '\t' ||
    next === '>' || (next === '/' && tail[tag.len + 1] === '>');
  return followedOk ? { type: 6, end: null } : null;
}

// Type 7: a complete open or close tag alone on the line, with a tag
// name that is NOT a block tag. Validated with the strict inline tag
// matcher (attribute names/values must be well-formed: no attributes
// on closing tags, whitespace required between attributes).
function htmlLoneTag(line, at, tail) {
  const end = inlineTag(tail, 0);
  if (end === -1) return null;
  const tag = htmlTagName(tail);
  if (tag === null || HTML_BLOCK_TAGS.has(tag.name)) return null;
  let pos = at + end;
  while (pos < line.length && blankChar(line[pos])) pos++;
  return pos >= line.length ? { type: 7, end: null } : null;
}

// The type checkers, in CommonMark's trial order.
const HTML_TYPE_CHECKS = [
  htmlComment,
  htmlPI,
  htmlCdata,
  htmlDecl,
  htmlRawTag,
  htmlBlockTag,
  htmlLoneTag,
];

// Match an HTML block start. Returns {type, end}: type is 1-7 and end
// is the terminator string for types 1-5, or null when no HTML block
// starts here.
function htmlBlockOpen(line) {
  const at = skipIndent(line);
  const startsWithLt = at !== -1 && at < line.length && line[at] === '<';
  if (!startsWithLt) return null;
  const tail = line.slice(at);
  for (const test of HTML_TYPE_CHECKS) {
    const found = test(line, at, tail);
    if (found) return found;
  }
  return null;
}

// Remove up to count columns of leading whitespace (spaces/tabs)
// from a line. A tab straddling the boundary turns into spaces for
// the part after it. Stops at the first non-whitespace character:
// content is never eaten.
function stripColumns(line, count, narrowTabs) {
  let width = 0;
  let k = 0;
  while (k < line.length && width < count) {
    const ch = line[k];
    if (ch === ' ') {
      width += 1;
      k += 1;
      continue;
    }
    if (ch !== '\t') break;
    // Fences count each tab as one column (a marked quirk); elsewhere
    // a tab expands to its full width and may leave partial spaces.
    if (narrowTabs) {
      width += 1;
      k += 1;
      continue;
    }
    const span = tabStop(width);
    const end = width + span;
    if (end <= count) {
      width = end;
      k += 1;
      continue;
    }
    return ' '.repeat(end - count) + line.slice(k + 1);
  }
  return line.slice(k);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Split a table row line into cells: split on unescaped '|', trim
// spaces/tabs, and drop an empty edge cell when the line starts or
// ends with '|'. An escaped pipe (\|) belongs to its cell and is
// unescaped when the cell is finished.
function tableCells(line) {
  const len = line.length;
  let lo = 0;
  let hi = len;
  while (lo < len && blankChar(line[lo])) lo++;
  while (hi > lo && blankChar(line[hi - 1])) hi--;
  const openPipe = lo < hi && line[lo] === '|';
  const closePipe = hi > lo && line[hi - 1] === '|';
  const out = [];
  // Finish one cell: unescape \|, then trim spaces/tabs from both ends.
  function emitCell(from, to) {
    const raw = line.slice(from, to).replace(/\\\|/g, '|');
    out.push(raw.replace(/^[ \t]+|[ \t]+$/g, ''));
  }
  let from = lo;
  let k = lo;
  while (k < hi) {
    const ch = line[k];
    const isEscapedPipe = ch === '\\' && k + 1 < hi && line[k + 1] === '|';
    if (isEscapedPipe) {
      k += 2; // escaped pipe: part of the cell, unescaped by emitCell
      continue;
    }
    if (ch === '|') {
      emitCell(from, k);
      k++;
      from = k;
      continue;
    }
    k++;
  }
  emitCell(from, hi);
  if (openPipe) out.shift();
  if (closePipe) out.pop();
  return out;
}

// Split a delimiter-row candidate on '|' and drop empty edge parts.
// An edge part is dropped only when the row actually starts/ends with
// a pipe — a merely empty first cell stays.
function delimiterParts(row) {
  const chunks = row.split('|');
  const headEmpty = chunks.length > 0 && chunks[0].trim() === '';
  if (headEmpty && row.startsWith('|')) chunks.shift();
  const tailEmpty = chunks.length > 0 && chunks[chunks.length - 1].trim() === '';
  if (tailEmpty && row.trimEnd().endsWith('|')) chunks.pop();
  return chunks;
}

// Alignment of one delimiter cell: ':--' left, '--:' right, ':-:'
// center, '---' none. Returns undefined when the cell is not a
// delimiter cell at all (anything but colons around dashes).
function cellAlign(cell) {
  const text = cell.trim();
  if (!/^:?-+:?$/.test(text)) return undefined;
  const hasLeft = text.startsWith(':');
  const hasRight = text.endsWith(':');
  if (hasLeft && hasRight) return 'center';
  if (hasLeft) return 'left';
  if (hasRight) return 'right';
  return null;
}

// Match a table delimiter row. Returns the align array or null.
// Delimiter cells are :?-+:? separated by '|', with optional edge
// pipes; the row MUST contain a '|' and hold exactly headerCount
// cells. No tabs anywhere in the row — a tab inside a cell, between
// cells, or trailing kills it.
function tableDelimiter(line, headerCount) {
  if (line.includes('\t')) return null;
  if (!line.includes('|')) return null;
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return null;
  const chunks = delimiterParts(line.slice(at));
  if (chunks.length !== headerCount) return null;
  const found = [];
  for (const part of chunks) {
    const align = cellAlign(part);
    if (align === undefined) return null;
    found.push(align);
  }
  return found;
}

// Does this line look like a table delimiter row (ignoring cell
// count)? Used to flag lazy delimiter lines in blockquotes (they
// never form tables).
function delimiterLike(line) {
  if (line.includes('\t') || !line.includes('|')) return false;
  const at = skipIndent(line);
  if (at === -1 || at >= line.length) return false;
  const chunks = delimiterParts(line.slice(at));
  if (chunks.length === 0) return false;
  for (const part of chunks) {
    if (cellAlign(part) === undefined) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Block consumers
// ---------------------------------------------------------------------------

// Language of a fenced code block: the first whitespace-delimited
// word of the info string, with backslash escapes resolved first
// (``` foo\+bar -> language-foo+bar). An info string of only
// whitespace yields no language at all.
function fenceLang(info) {
  const trimmed = info.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') return '';
  let cut = 0;
  while (cut < trimmed.length && !blankChar(trimmed[cut])) cut++;
  return unescapePunct(trimmed.slice(0, cut));
}

// Fenced code block starting at lines[at] (match). Consumes lines
// until the closing fence or the end of the document; the closing
// fence line itself is eaten but contributes no content.
function readFence(lines, at, match) {
  const lang = fenceLang(match.info);
  const content = [];
  let k = at + 1;
  while (k < lines.length) {
    const line = lines[k].t;
    if (fenceClose(line, match.ch, match.len)) {
      k++;
      break;
    }
    // Marked quirk: only backtick fences strip the opening indent
    // from content lines; tilde fences keep content verbatim. Tabs
    // count as one column when stripping.
    const stripped = match.ch === '`'
      ? stripColumns(line, match.indent, true)
      : line;
    content.push(stripped);
    k++;
  }
  // A trailing blank content line is dropped (exactly one).
  const lastIsBlank = content.length > 0 && content[content.length - 1] === '';
  if (lastIsBlank) content.pop();
  const body = content.length === 0 ? '' : content.join('\n') + '\n';
  return { block: { t: 'fence', lang, text: body }, next: k };
}

// Find the last line index of an HTML block starting at lines[at]:
// types 1-5 run to the line holding the terminator (inclusive);
// types 6-7 run to the line before the next blank line. When a type
// 1-5 terminator never appears, the block runs to the end of the
// document.
function htmlBlockLast(lines, at, match) {
  const count = lines.length;
  if (match.type <= 5) {
    const terminator = match.end.toLowerCase();
    let pos = at;
    while (pos < count && !lines[pos].t.toLowerCase().includes(terminator)) pos++;
    return pos >= count ? count - 1 : pos;
  }
  let pos = at + 1;
  while (pos < count && !blankLine(lines[pos])) pos++;
  return pos - 1;
}

// HTML block starting at lines[at] (match). The block's text is the
// raw lines joined with newlines, plus a trailing newline under the
// rules below — the HTML is emitted verbatim, never escaped.
function readHtml(lines, at, match) {
  const count = lines.length;
  const pos = htmlBlockLast(lines, at, match);
  const rows = [];
  for (let p = at; p <= pos; p++) rows.push(lines[p].t);
  let body = rows.join('\n');
  // Trailing newline rule:
  // - Types 1-5: include it iff the last line is terminated AND the
  //   next line is non-empty (or there is no next line).
  // - Types 6-7: include it iff the block runs to the end AND the
  //   last line is terminated.
  const endsNewline = lines[pos].nl;
  if (match.type <= 5) {
    const nextIsNonEmpty = pos + 1 >= count || lines[pos + 1].t !== '';
    if (endsNewline && nextIsNonEmpty) body += '\n';
  } else if (endsNewline && pos + 1 >= count) {
    body += '\n';
  }
  return { block: { t: 'html', text: body }, next: pos + 1 };
}

// Indented code block starting at lines[at]. Lines indented 4+ columns
// join the block with 4 columns stripped; blank lines in between are
// held and only join when a non-blank line follows them (a trailing
// run of blanks is dropped, not emitted).
function readIndented(lines, at) {
  const content = [];
  let heldBlanks = [];
  let k = at;
  let end = at;
  // Move the held blank lines into the content (they only join the
  // block when a non-blank line follows them).
  function releaseBlanks() {
    for (const blank of heldBlanks) content.push(blank);
    heldBlanks = [];
  }
  while (k < lines.length) {
    const row = lines[k];
    if (blankLine(row)) {
      // A whitespace-only line contributes the part after 4 columns
      // (e.g. 6 spaces -> 2 spaces), not an empty line.
      heldBlanks.push(sliceAtCol(row.t, 4, false));
      k++;
      continue;
    }
    const [width] = indentOf(row.t);
    if (width < 4) break;
    releaseBlanks();
    content.push(sliceAtCol(row.t, 4, false));
    end = k + 1;
    k++;
  }
  const body = content.length === 0 ? '' : content.join('\n') + '\n';
  return { block: { t: 'code', text: body }, next: end };
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Parse a title starting at text[pos] (", ', or (). Returns {title,
// end} (end = the index after the closing delimiter) or null when the
// title is unclosed or invalid. inline: inline-link paren titles
// allow '(' inside; definition paren titles do not. Backslash escapes
// before ASCII punctuation resolve inside the title.
function titleAt(text, pos, inline) {
  const len = text.length;
  const open = text[pos];
  const close = open === '(' ? ')' : open;
  const openAllowed = open !== '(' || inline;
  const chunks = [];
  let k = pos + 1;
  while (k < len) {
    const ch = text[k];
    const isEscape = ch === '\\' && k + 1 < len && asciiPunct(text[k + 1]);
    if (isEscape) {
      chunks.push(text[k + 1]);
      k += 2;
      continue;
    }
    if (ch === close) return { title: chunks.join(''), end: k + 1 };
    if (ch === '(' && !openAllowed) return null;
    chunks.push(ch);
    k++;
  }
  return null;
}

// Scan a link-definition label starting just after '['. Escapes stay
// RAW in the label (for matching): an escaped \] does not end it, and
// an escaped \[ does not invalidate it. Returns {label, end} (end =
// the index after ']') or null. An unescaped '[' inside the label
// invalidates the whole definition.
function defLabel(text, pos) {
  const len = text.length;
  const chunks = [];
  while (pos < len) {
    const ch = text[pos];
    const isEscape = ch === '\\' && pos + 1 < len && asciiPunct(text[pos + 1]);
    if (isEscape) {
      chunks.push(text[pos], text[pos + 1]);
      pos += 2;
      continue;
    }
    if (ch === '[') return null;
    if (ch === ']') return { label: chunks.join(''), end: pos + 1 };
    chunks.push(ch);
    pos++;
  }
  return null;
}

// Skip the gap after ':' in a link definition: spaces, then optionally
// one newline plus spaces/tabs. Returns the index after the gap, or
// -1 when a second newline follows (the destination must come before
// a blank line).
function defGap(text, pos) {
  const len = text.length;
  while (pos < len && text[pos] === ' ') pos++;
  if (pos >= len || text[pos] !== '\n') return pos;
  pos++;
  while (pos < len && blankChar(text[pos])) pos++;
  if (pos < len && text[pos] === '\n') return -1;
  return pos;
}

// Scan an angle-form destination <...> starting at text[pos] ('<'): no
// newlines, no '<' inside, escapes resolved. Returns {dest, end} or
// null. The closing '>' ends the destination; anything else (except
// the two forbidden characters) is content.
function angleDest(text, pos) {
  const len = text.length;
  const chunks = [];
  let k = pos + 1;
  while (k < len) {
    const ch = text[k];
    if (ch === '\n' || ch === '<') return null;
    if (ch === '>') return { dest: chunks.join(''), end: k + 1 };
    const isEscape = ch === '\\' && k + 1 < len && asciiPunct(text[k + 1]);
    if (isEscape) {
      chunks.push(text[k + 1]);
      k += 2;
    } else {
      chunks.push(ch);
      k++;
    }
  }
  return null;
}

// Scan a bare-form destination starting at text[pos]: balanced parens,
// no spaces or control characters, escapes resolved. Returns {dest,
// end} or null. An empty destination is invalid unless allowEmpty is
// set (inline links allow [a]()). A ')' at depth 0 ends the scan
// without being consumed; deeper ')'s are content.
function bareDest(text, pos, allowEmpty) {
  const len = text.length;
  const chunks = [];
  let depth = 0;
  let k = pos;
  while (k < len) {
    const ch = text[k];
    const isEscape = ch === '\\' && k + 1 < len && asciiPunct(text[k + 1]);
    if (isEscape) {
      chunks.push(text[k + 1]);
      k += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      chunks.push(ch);
      k++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
      chunks.push(ch);
      k++;
      continue;
    }
    const cp = ch.charCodeAt(0);
    const isTerminator = ch === ' ' || ch === '\t' || ch === '\n' || cp < 0x20;
    if (isTerminator) break;
    chunks.push(ch);
    k++;
  }
  const out = chunks.join('');
  const emptyForbidden = out === '' && !allowEmpty;
  if (emptyForbidden || depth !== 0) return null;
  return { dest: out, end: k };
}

// Scan a link destination starting at text[pos]: angle form <...> or
// bare form. Returns {dest, end} or null.
function destAt(text, pos, allowEmpty) {
  if (text[pos] === '<') return angleDest(text, pos);
  return bareDest(text, pos, allowEmpty);
}

// Is this character a title opener (double quote, single quote, or
// paren)?
function titleOpener(ch) {
  return ch === '"' || ch === "'" || ch === '(';
}

// Parse a definition title at text[at], which must hold ", ' or (.
// Returns {title, end} (end = the index after the title plus its
// trailing spaces/tabs), or null when the title is unclosed or junk
// follows it on the same line.
function defTitleAt(text, at) {
  const found = titleAt(text, at, false);
  if (!found) return null;
  const len = text.length;
  let k = found.end;
  while (k < len && blankChar(text[k])) k++;
  if (k < len && text[k] !== '\n') return null;
  return { title: found.title, end: k };
}

// Parse a link reference definition from the start of text (joined
// paragraph text). Returns {consumed, label, href, title} or null.
// consumed covers the definition plus its trailing newline when
// present. The label is normalized for matching; an empty normalized
// label invalidates the definition.
function linkDef(text) {
  const len = text.length;
  let k = 0;
  let spaces = 0;
  while (k < len && text[k] === ' ' && spaces < 3) {
    k++;
    spaces++;
  }
  if (k >= len || text[k] !== '[') return null;
  const labelMatch = defLabel(text, k + 1);
  if (!labelMatch) return null;
  const key = normalizeLabel(labelMatch.label);
  if (key === '') return null;
  k = labelMatch.end;
  if (k >= len || text[k] !== ':') return null;
  k = defGap(text, k + 1);
  if (k === -1 || k >= len) return null;
  const found = destAt(text, k);
  if (!found) return null;
  const href = found.dest;
  k = found.end;
  // Optional title: same line (after spaces) or next line (after a
  // newline). A same-line title needs at least one space before it,
  // and a failed same-line title kills the whole definition. A failed
  // next-line title leaves the definition valid without the title.
  let scan = k;
  let gap = 0;
  while (scan < len && text[scan] === ' ') {
    scan++;
    gap++;
  }
  const hitsNewline = scan < len && text[scan] === '\n';
  if (hitsNewline) {
    const plainEnd = scan + 1;
    let tpos = scan + 1;
    while (tpos < len && blankChar(text[tpos])) tpos++;
    const nextLineHasTitle = tpos < len && text[tpos] !== '\n' && titleOpener(text[tpos]);
    if (nextLineHasTitle) {
      const withTitle = defTitleAt(text, tpos);
      if (withTitle) {
        const end = withTitle.end;
        return {
          consumed: end < len ? end + 1 : end,
          label: key, href, title: withTitle.title,
        };
      }
      // Next-line title invalid: the definition survives without it.
    }
    return {
      consumed: plainEnd,
      label: key, href, title: null,
    };
  }
  const sameLineHasTitle = gap > 0 && scan < len && titleOpener(text[scan]);
  if (sameLineHasTitle) {
    const withTitle = defTitleAt(text, scan);
    if (!withTitle) return null;
    const end = withTitle.end;
    return {
      consumed: end < len ? end + 1 : end,
      label: key, href, title: withTitle.title,
    };
  }
  if (scan < len && text[scan] !== '\n') return null;
  return {
    consumed: scan < len ? scan + 1 : scan,
    label: key, href, title: null,
  };
}

// ---------------------------------------------------------------------------
// Paragraphs, setext headings, tables
// ---------------------------------------------------------------------------

// Can this list marker interrupt a paragraph? Bullet markers and
// ordered markers starting at 1 always can; other ordered markers can
// only inside a list item.
function markerInterrupts(marker, nested) {
  if (nested) return true;
  if (!marker.ordered) return true;
  return marker.start === 1;
}

// What block, if any, does this line start? Returns an object with a
// `kind` ('fence', 'atx', 'hr', 'quote', 'html', 'list') plus the
// match details a caller needs (htmlType for HTML, marker for lists),
// or null when the line starts no block. Pure, so every interrupt and
// continuation predicate can share it. The trial order matters: a
// fence line is a fence even when it also looks like something else.
function blockStarter(line) {
  if (fenceOpen(line)) return { kind: 'fence' };
  if (atxHead(line)) return { kind: 'atx' };
  if (thematicBreak(line)) return { kind: 'hr' };
  if (quotePrefix(line) !== null) return { kind: 'quote' };
  const html = htmlBlockOpen(line);
  if (html) return { kind: 'html', htmlType: html.type };
  const marker = listMarker(line);
  if (marker) return { kind: 'list', marker };
  return null;
}

// Can this line start a block that interrupts a paragraph? HTML blocks
// of types 1-6 can; type 7 cannot. Lists interrupt only when their
// marker interrupts and the item is not empty.
function paragraphBreak(line, nested) {
  const start = blockStarter(line);
  if (!start) return false;
  if (start.kind === 'html') return start.htmlType <= 6;
  if (start.kind === 'list') {
    // An empty list item (marker with no content) cannot interrupt a paragraph.
    if (start.marker.empty) return false;
    return markerInterrupts(start.marker, nested);
  }
  return true;
}

// Can this line be a table body row (i.e. does it NOT start a new
// block)? Body rows end at: blank lines, blockquote, ATX, fence, HTML
// block, hr, interrupting lists, and indented code.
function tableRowLine(line) {
  const start = blockStarter(line);
  if (start) {
    if (start.kind === 'list') {
      const nonInterrupting = !markerInterrupts(start.marker, false);
      return nonInterrupting && indentOf(line)[0] < 4;
    }
    return false;
  }
  const [width] = indentOf(line);
  return width < 4;
}

// Extract leading link reference definitions from paragraph text,
// recording them in refs (first definition wins). Returns the text
// that remains after the definitions. Definitions are consumed one
// after another from the front until the front is no longer one.
function collectDefs(text, refs) {
  let tail = text;
  let def;
  while ((def = linkDef(tail)) !== null) {
    if (!refs.has(def.label)) {
      refs.set(def.label, { href: def.href, title: def.title });
    }
    tail = tail.slice(def.consumed);
  }
  return tail;
}

// Collect table body rows starting at lines[at]. Returns {body, next}.
// Each row is padded with empty cells (or truncated) to the header's
// column count, so every body row has exactly `columns` cells.
function tableRows(lines, at, header) {
  const body = [];
  const columns = header.length;
  while (at < lines.length) {
    const row = lines[at];
    // Marked quirk: a terminated line of 0-3 spaces + a single tab is
    // a body row (empty cells), not a blank line ending the table.
    const isTabRow = row.nl && /^ {0,3}\t$/.test(row.t);
    if (!isTabRow && (blankLine(row) || !tableRowLine(row.t))) break;
    const rowCells = tableCells(row.t);
    while (rowCells.length < columns) rowCells.push('');
    body.push(rowCells.slice(0, columns));
    at++;
  }
  return { body, next: at };
}

// Build the blocks for a finished paragraph. text is the paragraph
// text after link definitions were extracted; ended says how the
// paragraph ended ('blank', 'interrupt', 'setext', 'table'). A
// paragraph that ends on a setext underline becomes a heading; one
// that ends on a delimiter row becomes a table (with any lines above
// the header line kept as a paragraph).
function closeParagraph(lines, at, text, ended, setextLevel, aligns) {
  const out = [];
  if (text === '') {
    // Only definitions: no paragraph. A setext/table line after
    // definitions is not consumed (it starts a new block).
    return { blocks: out, next: at };
  }
  const paraLines = text.split('\n');
  if (ended === 'setext') {
    // Setext heading text is trimmed (leading/trailing spaces/tabs).
    const head = text.replace(/^[ \t]+|[ \t]+$/g, '');
    out.push({ t: 'h', level: setextLevel, text: head });
    return { blocks: out, next: at + 1 };
  }
  if (ended === 'table') {
    const lastLine = paraLines[paraLines.length - 1];
    const headCells = tableCells(lastLine);
    if (paraLines.length > 1) {
      out.push({ t: 'p', text: paraLines.slice(0, -1).join('\n') });
    }
    const rows = tableRows(lines, at + 1, headCells);
    out.push({ t: 'table', align: aligns, head: headCells, body: rows.body });
    return { blocks: out, next: rows.next };
  }
  out.push({ t: 'p', text });
  return { blocks: out, next: at };
}

// Classify one paragraph continuation line against the paragraph's
// last collected line. Returns one of:
//   {kind: 'blank'} — a blank line ends the paragraph
//   {kind: 'lazy'} — a lazy line joins the paragraph as-is
//   {kind: 'table', aligns} — a delimiter row forms a table
//   {kind: 'setext', sx} — a setext underline
//   {kind: 'interrupt'} — a block start interrupts the paragraph
//   {kind: 'content'} — an ordinary continuation line
// The checks run in this order because a delimiter row is also a
// setext-looking line for '-' cells, and a setext line can also be
// an interrupting block start.
function paragraphLineKind(row, nested, prevText) {
  const text = row.t;
  if (blankLine(row)) return { kind: 'blank' };
  // Lazy lines never interrupt a paragraph or form setext/table.
  if (row.lazy) return { kind: 'lazy' };
  const headCells = tableCells(prevText);
  // A lazy delimiter line in a blockquote never forms a table, and a
  // lazy setext-like line never becomes a setext underline.
  const aligns = row.noTable ? null : tableDelimiter(text, headCells.length);
  if (aligns) return { kind: 'table', aligns };
  const level = row.noSetext ? 0 : setextLine(text);
  if (level) return { kind: 'setext', sx: level };
  if (paragraphBreak(text, nested)) return { kind: 'interrupt' };
  return { kind: 'content' };
}

// Consume a paragraph starting at lines[at]. Handles setext headings,
// table formation, and leading link reference definitions. Returns
// {blocks, next}. The paragraph grows one line at a time until a
// blank line, an interrupting block, a setext underline, or a table
// delimiter row ends it.
function readParagraph(lines, at, refs, nested) {
  const collected = [lines[at].t];
  let k = at + 1;
  let ended = 'blank';
  let setextLevel = 0;
  let aligns = null;
  // Whether the previous continuation line was stripped (4+ leading
  // columns removed by the list-item rule).
  let wasStripped = false;
  while (k < lines.length) {
    const row = lines[k];
    const text = row.t;
    const prevLine = collected[collected.length - 1];
    const cls = paragraphLineKind(row, nested, prevLine);
    if (cls.kind === 'blank') {
      ended = 'blank';
      break;
    }
    if (cls.kind === 'table') {
      ended = 'table';
      aligns = cls.aligns;
      break;
    }
    if (cls.kind === 'setext') {
      ended = 'setext';
      setextLevel = cls.sx;
      break;
    }
    if (cls.kind === 'interrupt') {
      ended = 'interrupt';
      break;
    }
    if (cls.kind === 'lazy') {
      collected.push(text);
      wasStripped = false;
      k++;
      continue;
    }
    // Marked quirk: inside a list item, a paragraph continuation line
    // with 4+ columns of leading whitespace loses 4 columns (top-level
    // paragraphs keep their leading whitespace as-is). A non-stripped
    // continuation line following a stripped one is preceded by a blank
    // line inside the paragraph.
    const needsStrip = nested && indentOf(text)[0] >= 4;
    if (needsStrip) {
      collected.push(stripColumns(text, 4));
      wasStripped = true;
      k++;
      continue;
    }
    if (nested && wasStripped) collected.push('');
    wasStripped = false;
    collected.push(text);
    k++;
  }
  const body = collectDefs(collected.join('\n'), refs);
  return closeParagraph(lines, k, body, ended, setextLevel, aligns);
}

// ---------------------------------------------------------------------------
// Lazy continuation lines
// ---------------------------------------------------------------------------

// Can this line be a lazy paragraph continuation? It must not start a
// block (ATX, fence, HTML, hr, blockquote, any list marker).
// Indented-code-looking lines and '=' setext lines ARE lazy-able; '-'
// setext lines are caught by the hr/list checks ('--' alone is
// lazy-able).
function lazyAble(line) {
  return blockStarter(line) === null;
}

// Blockquote lazy-line stripping: strip 4 columns when the leading
// whitespace is 4+ columns, else keep the line unchanged.
function lazyStrip(line) {
  const [width] = indentOf(line);
  return width < 4 ? line : sliceAtCol(line, 4, false);
}

// The last leaf block under block (itself unless it is a quote or
// list). Descends into the last child repeatedly until a leaf is
// reached; an empty container yields null.
function deepestLeaf(block) {
  if (block.t === 'quote') {
    const children = block.children;
    if (children.length === 0) return null;
    return deepestLeaf(children[children.length - 1]);
  }
  if (block.t === 'list') {
    const entries = block.items;
    if (entries.length === 0) return null;
    const tail = entries[entries.length - 1];
    if (tail.children.length === 0) return null;
    return deepestLeaf(tail.children[tail.children.length - 1]);
  }
  return block;
}

// Find the last leaf block in a parsed block list (descending into the
// last child of quotes and lists). An empty list has no last leaf.
function lastLeafBlock(blocks) {
  if (blocks.length === 0) return null;
  return deepestLeaf(blocks[blocks.length - 1]);
}

// Does the parsed content end with an open paragraph? lastLineBlank
// says whether the last collected line was blank (which closes a
// paragraph). Used by container readers to decide whether a lazy line
// may continue the paragraph inside.
function openParagraphEnd(blocks, lastLineBlank) {
  if (lastLineBlank) return false;
  const end = lastLeafBlock(blocks);
  if (end === null) return false;
  return end.t === 'p';
}

// ---------------------------------------------------------------------------
// Blockquotes and lists
// ---------------------------------------------------------------------------

// How a lazy setext-like line is transformed inside a blockquote:
// after a '>' line it is kept as-is; after an unstripped lazy line
// it is padded to 4 columns; after a stripped lazy line it is
// stripped by 4. Returns {text, stripped}. Padding matters because
// the line must not look like a setext underline to the inner parser
// (it carries noSetext anyway) — it keeps the visual indent stable.
function setextLazy(t, prevLazy, prevStripped) {
  if (!prevLazy) return { text: t, stripped: false };
  if (prevStripped) {
    return { text: stripColumns(t, 4), stripped: true };
  }
  const [w] = indentOf(t);
  const pad = Math.max(0, 4 - w);
  return { text: ' '.repeat(pad) + t, stripped: false };
}

// Append one lazy continuation line to a blockquote's inner lines,
// applying the lazy-strip / padding rules. state carries {prevLazy,
// prevStripped} and is updated in place. insertBlank is called when
// a short lazy line follows a stripped one (a blank line goes first).
// Every lazy line is flagged lazy so the inner parser treats it as
// paragraph text, never as a new block.
function appendLazyLine(inner, L, state, insertBlank) {
  const t = L.t;
  const [w] = indentOf(t);
  if (setextLine(t)) {
    // A lazy setext-like line never becomes a setext underline.
    const sl = setextLazy(t, state.prevLazy, state.prevStripped);
    inner.push({ t: sl.text, nl: L.nl, noSetext: true, lazy: true });
    state.prevLazy = true;
    state.prevStripped = sl.stripped;
    return;
  }
  const afterStripped = state.prevLazy && state.prevStripped;
  if (afterStripped && w < 4) {
    // A short lazy line after a stripped one: blank line first, kept as-is.
    insertBlank();
    inner.push({ t, nl: L.nl, noTable: delimiterLike(t), lazy: true });
    state.prevLazy = true;
    state.prevStripped = false;
    return;
  }
  if (w >= 4) {
    inner.push({ t: lazyStrip(t), nl: L.nl, noTable: delimiterLike(t), lazy: true });
    state.prevLazy = true;
    state.prevStripped = true;
    return;
  }
  inner.push({ t, nl: L.nl, noTable: delimiterLike(t), lazy: true });
  state.prevLazy = true;
  state.prevStripped = false;
}

// Consume a blockquote starting at lines[i]. The quote gathers lines
// with a '>' prefix plus lazy continuation lines that may join an
// open paragraph inside. A lazy line is only accepted when the
// collected inner lines end with an open paragraph (checked lazily,
// once per run of non-'>' lines).
function readQuote(lines, i, refs) {
  const collected = [];
  let j = i;
  let checkNeeded = true;
  let paraOpen = false;
  const lazyState = { prevLazy: false, prevStripped: false };
  // A blank line after a stripped lazy line lands INSIDE the open paragraph
  // (as a trailing newline on the last inner line).
  function insertBlank() {
    if (collected.length > 0) {
      const last = collected[collected.length - 1];
      if (!blankLine(last)) last.t += '\n';
    }
  }
  while (j < lines.length) {
    const L = lines[j];
    const q = quotePrefix(L.t);
    if (q !== null) {
      if (lazyState.prevLazy && lazyState.prevStripped) insertBlank();
      collected.push({ t: q, nl: L.nl });
      j++;
      checkNeeded = true;
      lazyState.prevLazy = false;
      lazyState.prevStripped = false;
      continue;
    }
    if (blankLine(L)) break;
    if (!lazyAble(L.t)) break;
    if (checkNeeded) {
      const blocks = readBlocks(collected, new Map());
      const lastBlank = collected.length > 0 && blankLine(collected[collected.length - 1]);
      paraOpen = openParagraphEnd(blocks, lastBlank);
      checkNeeded = false;
      if (!paraOpen) break;
    }
    appendLazyLine(collected, L, lazyState, insertBlank);
    j++;
  }
  if (collected.length > 0) collected[collected.length - 1].nl = false;
  const children = readBlocks(collected, refs);
  return { block: { t: 'quote', children }, next: j };
}

// Do the collected item lines contain any non-blank line yet? An
// item with no content yet ends at the first blank line.
function itemHasContent(itemLines) {
  return itemLines.some((il) => !blankLine(il));
}

// While a fence is open with content, an under-indented line is fence
// content — EXCEPT when the previous item line could start a leaf
// block: 4+ columns of leading whitespace (indented code), an ATX
// heading, an HR, or an HTML block. (List/blockquote markers do not
// break it.) The previous line is checked after its own indentation
// was stripped, so the check sees what the inner parser would see.
function fenceBlocked(prev) {
  if (!prev) return false;
  const pt = prev.t;
  const [pw] = indentOf(pt);
  if (pw >= 4) return true;
  const ps = pt.slice(pw);
  if (/^#{1,6}(?:[ \t]|$)/.test(ps)) return true;
  if (/^(-{3,}|_{3,}|\*{3,})[ \t]*$/.test(ps)) return true;
  if (/^(`{3,}|~{3,})/.test(ps)) return true;
  return htmlBlockOpen(pt) !== null;
}

// Task list: if the first child is a paragraph starting with
// [x]/[ ]/[X] + space/tab + content, strip the marker and return the
// task state ('checked' or 'unchecked'). Otherwise returns null and
// leaves the children untouched.
function taskState(children) {
  if (children.length === 0) return null;
  const first = children[0];
  if (first.t !== 'p') return null;
  const tm = /^\[([ xX])\][ \t]+(\S[\s\S]*)$/.exec(first.text);
  if (!tm) return null;
  first.text = tm[2];
  return tm[1] === ' ' ? 'unchecked' : 'checked';
}

// Advance fence state for one stripped item line: open a fence when
// one starts here, close it at a matching closing fence. state is
// {ch, len, hasContent} and is updated in place. The caller sets
// hasContent when a line lands inside an open fence.
function itemFence(state, stripped) {
  if (state.ch === null) {
    const fm = fenceOpen(stripped);
    if (fm) {
      state.ch = fm.ch;
      state.len = fm.len;
      state.hasContent = false;
    }
    return;
  }
  if (fenceClose(stripped, state.ch, state.len)) {
    state.ch = null;
    state.len = 0;
    state.hasContent = false;
  }
}

// Find the index of the next non-blank line at or after k
// (lines.length when there is none).
function nextContent(lines, k) {
  while (k < lines.length && blankLine(lines[k])) k++;
  return k;
}

// Append one lazy continuation line to an item's collected lines:
// strip 4 columns when the leading width reaches 4 (like a quote's
// lazy line), else keep as-is. A lazy setext-like line never becomes
// a setext underline (noSetext is set from the stripped text).
function appendLazyItemLine(itemLines, L, t) {
  const stripped = lazyStrip(t);
  const isSetext = setextLine(stripped) !== 0;
  itemLines.push({ t: stripped, nl: L.nl, noSetext: isSetext, lazy: true });
}

// Collect one list item starting at lines[j] (marker m). Returns
// {item, next, loose}. The item gathers lines indented to its
// content indent (stripped by that indent), plus lazy continuation
// lines that may join an open paragraph inside. Blank lines join the
// item only when the next non-blank line is still indented enough;
// otherwise the item ends.
function readItem(lines, j, m, refs) {
  const contentIndent = m.contentIndent;
  const itemLines = [{ t: m.content, nl: lines[j].nl }];
  // Fence state within the item: while a fence is open AND already
  // has at least one content line, under-indented non-fence lines are
  // fence content (they stay in the item). If the first line after
  // the fence open is under-indented, the item ends and the fence is
  // empty.
  const fence = { ch: null, len: 0, hasContent: false };
  const fm0 = fenceOpen(m.content);
  if (fm0) {
    fence.ch = fm0.ch;
    fence.len = fm0.len;
  }
  let k = j + 1;
  let needCheck = false;
  let paraOpen = false;
  while (k < lines.length) {
    const L = lines[k];
    const t = L.t;
    if (blankLine(L)) {
      // A blank line uses the normal logic even inside a fence: the
      // item ends here unless the next non-blank line is indented to
      // the content indent (a blank line breaks fence-content
      // capture). An item with no content yet ends at a blank line
      // (it stays empty).
      if (!itemHasContent(itemLines)) break;
      const m2 = nextContent(lines, k + 1);
      if (m2 >= lines.length) break;
      const [w2] = indentOf(lines[m2].t);
      const resumesItem = w2 >= contentIndent && !blankText(lines[m2].t);
      if (resumesItem) {
        for (let q = k; q < m2; q++) itemLines.push({ t: '', nl: lines[q].nl });
        k = m2;
        needCheck = true;
        continue;
      }
      break;
    }
    const [w] = indentOf(t);
    const isIndented = w >= contentIndent && !blankText(t);
    if (isIndented) {
      const stripped = sliceAtCol(t, contentIndent, true);
      const fenceWasOpen = fence.ch !== null;
      itemLines.push({ t: stripped, nl: L.nl });
      itemFence(fence, stripped);
      if (fenceWasOpen && fence.ch !== null) fence.hasContent = true;
      k++;
      needCheck = true;
      continue;
    }
    // While a fence is open with content, an under-indented line that
    // is not itself a fence line is fence content (kept as-is). A
    // fence line ends the item. (See fenceBlocked for the leaf-block
    // exception.)
    const fenceCaptures = fence.ch !== null && fence.hasContent && fenceOpen(t) === null;
    if (fenceCaptures) {
      const prev = itemLines[itemLines.length - 1];
      if (!fenceBlocked(prev)) {
        itemLines.push({ t, nl: L.nl });
        k++;
        needCheck = true;
        continue;
      }
    }
    if (listMarker(t)) break;
    if (!lazyAble(t)) break;
    if (needCheck) {
      const blocks = readBlocks(itemLines, new Map(), true);
      const lastBlank = itemLines.length > 0 && blankLine(itemLines[itemLines.length - 1]);
      paraOpen = openParagraphEnd(blocks, lastBlank);
      needCheck = false;
      if (!paraOpen) break;
    }
    appendLazyItemLine(itemLines, L, t);
    k++;
  }
  if (itemLines.length > 0) itemLines[itemLines.length - 1].nl = false;
  const children = readBlocks(itemLines, refs, true);
  // Item looseness: a blank line DIRECTLY between two top-level children
  // (blank lines inside a nested block do not count).
  const itemLoose = children.hasBlankBetween === true;
  const task = taskState(children);
  return {
    item: { t: 'item', children, task, contentIndent },
    next: k,
    loose: itemLoose,
  };
}

// Does this marker belong to the list (same kind/delimiter, indent
// below the previous item's content indent)? Items need not share
// one indent — each item is judged against the previous item's
// content indent, not the first item's.
function markerFits(m, ordered, delim, prevContentIndent) {
  if (m === null) return false;
  if (m.indent >= prevContentIndent) return false;
  if (m.ordered !== ordered) return false;
  return m.delim === delim;
}

// Consume a list starting at lines[i] (first marker already matched).
// Items of the same kind and delimiter join the list; a blank line
// between items makes the list loose. The list ends at a line that is
// a thematic break, a marker of a different kind/delimiter, or a
// non-marker line that is not a blank-line separator.
function readList(lines, i, refs) {
  const first = listMarker(lines[i].t);
  const ordered = first.ordered;
  const delim = first.delim;
  const start = first.start;
  const items = [];
  let j = i;
  let loose = false;
  // A marker belongs to this list when its indent is below the previous
  // item's content indent (items need not share one indent).
  let prevContentIndent = Infinity;
  while (j < lines.length) {
    const L = lines[j];
    if (blankLine(L)) {
      const k = nextContent(lines, j + 1);
      if (k >= lines.length) break;
      const nm = listMarker(lines[k].t);
      const continues = nm !== null && !thematicBreak(lines[k].t) &&
        markerFits(nm, ordered, delim, prevContentIndent);
      if (continues) {
        loose = true;
        j = k;
        continue;
      }
      break;
    }
    // A line that is a thematic break ('* * *', '- - -') ends the list; it
    // is an <hr>, never a new item.
    if (thematicBreak(L.t)) break;
    const m = listMarker(L.t);
    if (markerFits(m, ordered, delim, prevContentIndent)) {
      const res = readItem(lines, j, m, refs);
      items.push(res.item);
      if (res.loose) loose = true;
      prevContentIndent = res.item.contentIndent;
      j = res.next;
      continue;
    }
    break;
  }
  return {
    block: { t: 'list', ordered, delim, start, items, loose },
    next: j,
  };
}

// ---------------------------------------------------------------------------
// Main block parser
// ---------------------------------------------------------------------------

// Block-start dispatch, in CommonMark's trial order. Each entry has a
// `test` (returns a match object, or a falsy value when the line does
// not start this block) and a `run` (consumes the block and returns
// {block, next}). The paragraph fallback is not an entry: it catches
// every line no entry claims. The order is load-bearing: a fence line
// wins over an ATX-looking line, HTML wins over the paragraph, and
// indented code is tried last so markers and quotes win over it.
const BLOCK_DISPATCH = [
  { test: fenceOpen, run: (rows, at, match, _defs) => readFence(rows, at, match) },
  {
    test: atxHead,
    run: (_rows, at, match, _defs) => ({ block: { t: 'h', level: match.level, text: match.text }, next: at + 1 }),
  },
  { test: htmlBlockOpen, run: (rows, at, match, _defs) => readHtml(rows, at, match) },
  {
    test: thematicBreak,
    run: (_rows, at, _match, _defs) => ({ block: { t: 'hr' }, next: at + 1 }),
  },
  {
    // quotePrefix returns '' for a bare '>' line, which is falsy — so
    // the test normalizes to a boolean instead of passing the string.
    test: (line) => (quotePrefix(line) !== null ? true : null),
    run: (rows, at, _match, refs) => readQuote(rows, at, refs),
  },
  { test: listMarker, run: (rows, at, _match, refs) => readList(rows, at, refs) },
  {
    test: (line) => (indentOf(line)[0] >= 4 ? true : null),
    run: (rows, at, _match, _defs) => readIndented(rows, at),
  },
];

// Parse a run of lines into blocks. refs collects link reference
// definitions (shared with the caller). nested is true inside a list
// item (it changes paragraph continuation and marker-interrupt rules).
// The returned array carries a hasBlankBetween flag: true when a blank
// line separated two top-level blocks (used for list looseness).
function readBlocks(lines, refs, nested) {
  const blocks = [];
  blocks.hasBlankBetween = false;
  let k = 0;
  const count = lines.length;
  let blankSeen = false;
  function emit(block) {
    if (blankSeen) blocks.hasBlankBetween = true;
    blankSeen = false;
    blocks.push(block);
  }
  // Consume a paragraph at lines[at] and push its blocks, tracking the
  // blank-between state for looseness. Returns the next line index.
  // A paragraph that produced no blocks (only definitions) still
  // records the blank separation when one was pending.
  function readPara(at) {
    const done = readParagraph(lines, at, refs, nested);
    for (const block of done.blocks) emit(block);
    if (done.blocks.length === 0 && blankSeen) {
      blocks.hasBlankBetween = true;
      blankSeen = false;
    }
    return done.next;
  }
  while (k < count) {
    const row = lines[k];
    if (blankLine(row) || blankText(row.t)) {
      if (blocks.length > 0) blankSeen = true;
      k++;
      continue;
    }
    const text = row.t;
    // A lazy continuation line is paragraph text, never a new block
    // (even if stripping made it look like a list marker or heading).
    if (row.lazy) {
      k = readPara(k);
      continue;
    }
    let matched = false;
    for (const rule of BLOCK_DISPATCH) {
      const hit = rule.test(text);
      if (!hit) continue;
      const done = rule.run(lines, k, hit, refs);
      emit(done.block);
      k = done.next;
      matched = true;
      break;
    }
    if (!matched) k = readPara(k);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline HTML and autolinks
// ---------------------------------------------------------------------------

// Skip tag whitespace (space, tab, newline) from pos; return the
// new index. Newlines count as whitespace inside inline tags.
function tagSpace(text, pos) {
  const len = text.length;
  while (pos < len) {
    const ch = text[pos];
    if (ch !== ' ' && ch !== '\t' && ch !== '\n') break;
    pos++;
  }
  return pos;
}

// Is ch a valid character in an HTML attribute name (after the first
// character, which must be a letter, '_' or ':')?
function attrChar(ch) {
  return ch === '_' || ch === '.' || ch === ':' || ch === '-' ||
    asciiLetter(ch) || asciiDigit(ch);
}

// Scan one attribute starting at text[pos] (first char of the name).
// Returns the index just past the attribute (or past the name for a
// boolean attribute), or -1 when the attribute is malformed. Values
// may be double-quoted, single-quoted, or unquoted; an unquoted value
// may not contain whitespace, '>', quotes, '=', '<' or backtick, and
// may not be empty.
function tagAttr(text, pos) {
  const len = text.length;
  const head = text[pos];
  if (!asciiLetter(head) && head !== '_' && head !== ':') return -1;
  pos++;
  while (pos < len && attrChar(text[pos])) pos++;
  const nameEnd = pos;
  pos = tagSpace(text, pos);
  if (pos >= len || text[pos] !== '=') {
    // Boolean attribute (no '='): the whitespace after the name stays
    // for the next iteration's separator check.
    return nameEnd;
  }
  pos++;
  pos = tagSpace(text, pos);
  if (pos >= len) return -1;
  const quote = text[pos];
  if (quote === '"' || quote === "'") {
    pos++;
    while (pos < len && text[pos] !== quote) pos++;
    if (pos >= len) return -1;
    return pos + 1;
  }
  const valueStart = pos;
  while (pos < len) {
    const ch = text[pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '>' || ch === '"' ||
        ch === "'" || ch === '=' || ch === '<' || ch === '`') break;
    pos++;
  }
  if (pos === valueStart) return -1;
  return pos;
}

// Scan a tag name starting at text[pos] (first letter). Returns the
// index just past the name. Names are letters, digits and '-' after
// the first letter.
function tagNameEnd(text, pos) {
  const len = text.length;
  let end = pos + 1;
  while (end < len && (asciiLetter(text[end]) || asciiDigit(text[end]) || text[end] === '-')) end++;
  return end;
}

// Match an inline HTML tag starting at text[pos] ('<'). Returns the
// index just past the tag, or -1. Covers open/close tags (attributes
// need preceding whitespace; closing tags take no attributes). A '/>'
// self-closing ending is allowed on open tags only.
function inlineTag(text, pos) {
  const len = text.length;
  let k = pos + 1;
  let isClose = false;
  if (k < len && text[k] === '/') {
    isClose = true;
    k++;
  }
  if (k >= len || !asciiLetter(text[k])) return -1;
  k = tagNameEnd(text, k);
  for (;;) {
    const gapEnd = tagSpace(text, k);
    const sawWs = gapEnd > k;
    k = gapEnd;
    if (k >= len) return -1;
    if (text[k] === '>') return k + 1;
    if (text[k] === '/' && !isClose && k + 1 < len && text[k + 1] === '>') return k + 2;
    if (isClose || !sawWs) return -1;
    k = tagAttr(text, k);
    if (k === -1) return -1;
  }
}

// Find `needle` in text from `from`; return the index just past it,
// or -1 when the needle never appears.
function terminatorAt(text, needle, from) {
  const at = text.indexOf(needle, from);
  if (at === -1) return -1;
  return at + needle.length;
}

// Match a declaration <!NAME ...> starting at text[pos]. Returns the
// index just past '>', or -1. NAME is one or more letters, followed
// by whitespace (or newline) before the rest. The body may contain
// anything except that the first '>' ends it.
function declarationAt(text, pos) {
  const len = text.length;
  let k = pos + 2;
  const nameStart = k;
  while (k < len && asciiLetter(text[k])) k++;
  if (k === nameStart) return -1;
  if (k >= len || (!blankChar(text[k]) && text[k] !== '\n')) return -1;
  return terminatorAt(text, '>', k);
}

// Match inline raw HTML starting at text[pos] ('<'): comment, PI,
// declaration, CDATA, or tag. Returns the index just past it, or -1.
function inlineHtml(text, pos) {
  const len = text.length;
  // Comment, PI and CDATA all end at a fixed terminator; the comment
  // has two short forms ('<!-->' and '<!--->') that end immediately.
  if (text.startsWith('<!--', pos)) {
    if (text.startsWith('<!-->', pos)) return pos + 5;
    if (text.startsWith('<!--->', pos)) return pos + 6;
    return terminatorAt(text, '-->', pos + 4);
  }
  for (const [open, close] of [['<?', '?>'], ['<![CDATA[', ']]>']]) {
    if (text.startsWith(open, pos)) return terminatorAt(text, close, pos + open.length);
  }
  if (pos + 2 < len && text[pos + 1] === '!') {
    return declarationAt(text, pos);
  }
  return inlineTag(text, pos);
}

// Marked quirk: an inline <a> open tag sets a document-global "in
// link" state that suppresses extended autolinks (www/http/email) in
// the rest of the document until a </a> close tag clears it. The
// state survives across blocks (paragraphs, headings, lists,
// blockquotes). The trigger is narrow: the open tag must be "<a" +
// a literal SPACE (a tab, newline, '>' or '/' after the name does
// not set it; bare <a> and <a/> do not set it), and only the exact
// 4-char tag "</a>" (any case) clears it — "</a >", "</a\t>" and
// "</a\n>" do not. Tags inside HTML blocks, code spans, or link
// text leave the state alone (a link's text is parsed in an
// isolated scope that restores the state when the link forms).
let inLinkGlobal = false;
// How many markdown links formed during the current parse() call.
// This detects a link formed inside a strikethrough's recursive
// parse: a bracket enclosing such a strikethrough can never form a
// link itself.
let linksFormed = 0;
// Extended autolinks (http/https/ftp/www) created during the current
// parse() call, as {html, text} pairs. They let the parser revert
// autolinks formed inside a strikethrough's recursive parse when
// the del ends up inside a link (an https autolink's HTML is
// identical to an angle autolink's, so only creation-time tracking
// can tell them apart).
let extAutolinks = [];

// Is ch a valid character in an email local part ([A-Za-z0-9._+-])?
// The dot is allowed anywhere, including at the ends.
function emailLocalChar(ch) {
  return ch === '.' || ch === '_' || ch === '+' || ch === '-' ||
    asciiLetter(ch) || asciiDigit(ch);
}

// Scan an email local part (the part before '@') starting at s:
// [A-Za-z0-9._+-]+. Returns the end index (the '@' position when the
// local part is well-formed).
function emailLocal(text, s) {
  const n = text.length;
  let j = s;
  while (j < n) {
    const c = text[j];
    if (!emailLocalChar(c)) break;
    j++;
  }
  return j;
}

// Is c a valid character in an email domain ([A-Za-z0-9_.-])?
function emailDomainChar(c) {
  return asciiLetter(c) || asciiDigit(c) || c === '_' || c === '-' || c === '.';
}

// Trim trailing dots (and, when trimUnderscore is set, trailing
// underscores) from the domain text[dStart..end). Trimming '_' can
// expose more '.'s, so the loop repeats until stable. Returns the
// new end index.
function trimDomain(text, dStart, end, trimUnderscore) {
  for (;;) {
    while (end > dStart && text[end - 1] === '.') end--;
    if (!trimUnderscore) return end;
    let trimmed = false;
    while (end > dStart && text[end - 1] === '_') {
      end--;
      trimmed = true;
    }
    if (!trimmed) return end;
  }
}

// Validate an email domain (the part after '@'): labels of
// [A-Za-z0-9_-]+ separated by single dots, at least two labels.
// Returns the end index of the domain within text starting at
// dStart, or -1. Trailing dots are trimmed; a domain ending in '-'
// rejects the whole match. A domain ending in '_' also rejects,
// UNLESS trimTrailingUnderscore is set (an unmatched '_' opener
// exists earlier, so the trailing '_'s are emphasis delimiters, not
// part of the domain) — then they are trimmed instead.
function emailDomain(text, dStart, trimTrailingUnderscore) {
  const n = text.length;
  let j = dStart;
  while (j < n && emailDomainChar(text[j])) j++;
  const end = trimDomain(text, dStart, j, trimTrailingUnderscore);
  if (end === dStart) return -1;
  const last = text[end - 1];
  if (last === '_' || last === '-') return -1;
  const domain = text.slice(dStart, end);
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((lab) => lab === '')) return -1;
  return end;
}

// Match a bare email with '@' at atPos. Returns {start, end} or
// null. The local part is scanned backwards from the '@'; it must
// not scan before minStart (the current text run start): a '_'
// emphasis delimiter before it is not part of the email.
function bareEmail(text, atPos, minStart, trimTrailingUnderscore) {
  const lo = minStart === undefined ? 0 : minStart;
  let s = atPos - 1;
  while (s >= lo && emailLocalChar(text[s])) s--;
  const start = s + 1;
  if (start === atPos) return null;
  const end = emailDomain(text, atPos + 1, trimTrailingUnderscore);
  if (end === -1) return null;
  return { start, end };
}

// Scan a scheme starting at text[j] (a letter): the first letter
// plus [A-Za-z0-9+.-]*. Returns the index just past the scheme.
function schemeAt(text, j) {
  const n = text.length;
  let k = j + 1;
  while (k < n) {
    const c = text[k];
    const inScheme = asciiLetter(c) || asciiDigit(c) || c === '+' || c === '.' || c === '-';
    if (inScheme) k++;
    else break;
  }
  return k;
}

// Angle autolink with a scheme (<scheme:...>): the scheme is a letter
// then [A-Za-z0-9+.-]*, length 2-32, then ':', then a run of
// non-space, non-control characters up to '>'. Returns the autolink
// or null. The URL body may not contain '<' or '>' either.
function angleSchemeUrl(text, i, n) {
  let j = i + 1;
  if (j >= n || !asciiLetter(text[j])) return null;
  const k = schemeAt(text, j);
  const schemeLen = k - j;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (k >= n || text[k] !== ':') return null;
  let e = k + 1;
  const rs = e;
  while (e < n) {
    const c = text[e];
    const isTerminator = c === ' ' || c === '\t' || c === '\n' || c === '<' || c === '>' ||
      c.charCodeAt(0) < 0x20;
    if (isTerminator) break;
    e++;
  }
  if (e === rs || e >= n || text[e] !== '>') return null;
  const url = text.slice(i + 1, e);
  return { href: url, text: url, end: e + 1 };
}

// Match an angle autolink <...> starting at text[i]. Returns
// {href, text, end} or null. A scheme URL is tried first; an email
// is the fallback (a scheme-shaped local part like "ab@cd.ef" is
// not a scheme URL because there is no ':' after the scheme).
function angleAutolink(text, i) {
  const n = text.length;
  return angleSchemeUrl(text, i, n) || angleEmail(text, i + 1);
}

// Match <email> starting right after '<' (at position s). Returns
// the autolink or null. The email must end exactly at '>'.
function angleEmail(text, s) {
  const n = text.length;
  const j = emailLocal(text, s);
  if (j === s) return null;
  if (j >= n || text[j] !== '@') return null;
  const end = emailDomain(text, j + 1);
  if (end === -1 || end >= n || text[end] !== '>') return null;
  const email = text.slice(s, end);
  return { href: 'mailto:' + email, text: email, end: end + 1 };
}

// If s ends with a named entity &\w+;, return the index of its
// '&'. Otherwise -1. The entity must have at least one word
// character between '&' and ';'.
function entityAmp(s) {
  if (!s.endsWith(';')) return -1;
  let k = s.length - 2;
  while (k >= 0 && wordChar(s[k])) k--;
  if (k < 0) return -1;
  if (s[k] !== '&') return -1;
  if (k >= s.length - 2) return -1;
  return k;
}

// Find the paren-group structure of a URL candidate: '(' opens a
// group ending at the next ')' (no nesting). A '(' with no later
// ')' cuts the URL there. Returns {cut, closers}: cut is the
// candidate length after the cut, closers the set of ')' indices
// that close a group.
function parenGroups(cand) {
  const closers = new Set();
  let cut = cand.length;
  let i = 0;
  while (i < cand.length) {
    if (cand[i] === '(') {
      const close = cand.indexOf(')', i + 1);
      if (close === -1) {
        cut = i;
        break;
      }
      closers.add(close);
      i = close + 1;
    } else i++;
  }
  return { cut, closers };
}

// Trim an extended-autolink candidate per marked's rules: paren
// groups, trailing named entities, trailing punctuation, unmatched
// trailing ')'. The trims loop until stable because one trim can
// expose another (e.g. trimming an entity exposes a '?').
function trimUrl(cand) {
  const { cut, closers } = parenGroups(cand);
  let s = cand.slice(0, cut);
  // Trailing trims, looped until stable.
  for (;;) {
    if (s === '') break;
    const amp = entityAmp(s);
    if (amp !== -1) {
      s = s.slice(0, amp);
      continue;
    }
    const last = s[s.length - 1];
    // Trailing punctuation.
    if ('?!.,:;*_~"\' '.indexOf(last) !== -1) {
      s = s.slice(0, -1);
      continue;
    }
    // Trailing ')' that is not a group closer.
    if (last === ')' && !closers.has(s.length - 1)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

// Characters that may precede a www. autolink (plus start-of-text).
// Any other preceding character blocks the autolink.
const WWW_PRECEDING_OK = new Set([' ', '\t', '\n', '(', '*', '_', '~']);

// Scan an email right after a scheme prefix ending at s (e.g. after
// 'mailto:' or 'xmpp:'). Returns the end index of the email or -1.
function schemeEmail(text, s, trimTrailingUnderscore) {
  const n = text.length;
  const j = emailLocal(text, s);
  if (j === s) return -1;
  if (j >= n || text[j] !== '@') return -1;
  return emailDomain(text, j + 1, trimTrailingUnderscore);
}

// www. autolink (lowercase only, restricted preceding char, host
// starts with a letter, digit or '-'). The href gains an http://
// prefix; the displayed text keeps the bare www. form.
function wwwAutolink(text, i) {
  const n = text.length;
  const prev = i === 0 ? '' : text[i - 1];
  if (i > 0 && !WWW_PRECEDING_OK.has(prev)) return null;
  const h = i + 4;
  if (h >= n) return null;
  const hc = text[h];
  if (!asciiLetter(hc) && !asciiDigit(hc) && hc !== '-') return null;
  const url = urlAt(text, i);
  if (!url) return null;
  return { href: 'http://' + url, text: url, end: i + url.length, extended: true };
}

// Schemes http/https/ftp (case-insensitive), no preceding
// restriction. low is the lowercased text starting at i (computed
// once by the caller so this function does not allocate).
function httpAutolink(text, i, low) {
  const n = text.length;
  let schemeLen = 0;
  for (const scheme of ['https://', 'http://', 'ftp://']) {
    if (low.startsWith(scheme)) { schemeLen = scheme.length; break; }
  }
  if (schemeLen === 0) return null;
  const h = i + schemeLen;
  if (h >= n) return null;
  const hc = text[h];
  if (!asciiLetter(hc) && !asciiDigit(hc) && hc !== '-') return null;
  const url = urlAt(text, i);
  if (!url) return null;
  return { href: url, text: url, end: i + url.length, extended: true };
}

// mailto: (lowercase only, preceding char must not be a word char).
// The email must start right after 'mailto:'.
function mailtoAutolink(text, i, trimTrailingUnderscore) {
  const prev = i === 0 ? '' : text[i - 1];
  if (i > 0 && (asciiLetter(prev) || asciiDigit(prev))) return null;
  const end = schemeEmail(text, i + 7, trimTrailingUnderscore);
  if (end === -1) return null;
  const full = 'mailto:' + text.slice(i + 7, end);
  return { href: full, text: full, end, extended: true };
}

// xmpp: (lowercase only, preceding char must not be a word char).
// Email right after, plus an optional path: '/' + [A-Za-z0-9.@]+
// with trailing '.'s trimmed. (The only other scheme+email
// autolink.) A path of only '.'s does not extend the link.
function xmppAutolink(text, i, trimTrailingUnderscore) {
  const n = text.length;
  const prev = i === 0 ? '' : text[i - 1];
  if (i > 0 && (asciiLetter(prev) || asciiDigit(prev))) return null;
  const end = schemeEmail(text, i + 5, trimTrailingUnderscore);
  if (end === -1) return null;
  let linkEnd = end;
  if (end < n && text[end] === '/') {
    let p = end + 1;
    while (p < n) {
      const c = text[p];
      if (asciiLetter(c) || asciiDigit(c) || c === '.' || c === '@') p++;
      else break;
    }
    let pe = p;
    while (pe > end + 1 && text[pe - 1] === '.') pe--;
    if (pe > end + 1) linkEnd = pe;
  }
  const full = text.slice(i, linkEnd);
  return { href: full, text: full, end: linkEnd, extended: true };
}

// Extended-autolink prefixes with exact-case matching and their
// scanners. The case-insensitive http check (which allocates a
// lowercased slice) runs last, only when no exact prefix matched.
const EXTENDED_PREFIXES = [
  ['www.', (text, i, _t) => wwwAutolink(text, i)],
  ['mailto:', (text, i, t) => mailtoAutolink(text, i, t)],
  ['xmpp:', (text, i, t) => xmppAutolink(text, i, t)],
];

// Match an extended autolink starting at text[i]. Returns
// {href, text, end, extended} or null. Handles www., http(s)://,
// ftp://, mailto:, and bare emails (via '@'). The prefixes are
// disjoint, so the check order is free.
function extendedAutolink(text, i, trimTrailingUnderscore) {
  for (const [prefix, scan] of EXTENDED_PREFIXES) {
    if (text.startsWith(prefix, i)) return scan(text, i, trimTrailingUnderscore);
  }
  const low = text.slice(i, i + 8).toLowerCase();
  if (low.startsWith('https://') || low.startsWith('http://') ||
      low.startsWith('ftp://')) {
    return httpAutolink(text, i, low);
  }
  return null;
}

// Scan a URL candidate (maximal run of non-space, non-'<') from i
// and trim it per the extended-autolink rules. Returns the trimmed
// URL, or null when nothing survives the trims.
function urlAt(text, i) {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<') break;
    j++;
  }
  const trimmed = trimUrl(text.slice(i, j));
  if (trimmed === '') return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Inline links
// ---------------------------------------------------------------------------

// Parse an inline link/image suffix starting at text[i] ('(').
// Returns {href, title, end} or null. The destination may be empty
// ([a]() is valid); the title is optional and must be followed by
// ')' (possibly after whitespace). Newlines inside the parens are
// allowed as whitespace between the parts.
function parseInlineLink(text, i) {
  const n = text.length;
  let j = tagSpace(text, i + 1);
  if (j >= n) return null;
  const d = destAt(text, j, true);
  if (!d) return null;
  const dest = d.dest;
  j = tagSpace(text, d.end);
  if (j >= n) return null;
  if (text[j] === ')') return { href: dest, title: null, end: j + 1 };
  if (!titleOpener(text[j])) return null;
  const tr = titleAt(text, j, true);
  if (!tr) return null;
  j = tagSpace(text, tr.end);
  if (j >= n || text[j] !== ')') return null;
  return { href: dest, title: tr.title, end: j + 1 };
}

// Parse a reference label starting at text[i] ('[').
// Returns {label, end} or null. A reference label uses the same
// scanner as a definition label (escapes stay raw for matching).
function parseRefLabel(text, i) {
  return defLabel(text, i + 1);
}

// Are the brackets in text[start..end) balanced (equal '[' and ']'
// counts, ignoring backslash-escaped brackets)? Link/image text
// must be balanced — an unbalanced '[' inside link text blocks the
// link from forming.
function balancedBrackets(text, start, end) {
  let depth = 0;
  let k = start;
  while (k < end) {
    const c = text[k];
    if (c === '\\' && k + 1 < end && asciiPunct(text[k + 1])) {
      k += 2;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth < 0) return false;
    }
    k++;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

// Classify one neighbor character for flanking: 'ws' for whitespace,
// 'punct' for punctuation, 'other' for everything else. The classes
// are disjoint (no whitespace character is punctuation), so one test
// settles both questions. Unicode whitespace and punctuation both
// count here, not just the ASCII sets.
function neighborClass(ch) {
  if (unicodeWs(ch)) return 'ws';
  if (punctChar(ch)) return 'punct';
  return 'other';
}

// Flanking for a delimiter run covering text[start..end): whether it
// can open (left) and/or close (right) emphasis, plus whether the
// neighbors are punctuation. Start/end of the inline text act like a
// newline (whitespace). The CommonMark rules: a run can open when the
// following char is not whitespace and is not punctuation (or the
// preceding char is whitespace/punctuation); it can close when the
// preceding char is not whitespace and is not punctuation (or the
// following char is whitespace/punctuation).
function flankInfo(text, start, end) {
  const before = start > 0 ? text[start - 1] : '\n';
  const after = end < text.length ? text[end] : '\n';
  const bClass = neighborClass(before);
  const aClass = neighborClass(after);
  const beforeWs = bClass === 'ws';
  const afterWs = aClass === 'ws';
  const beforePunct = bClass === 'punct';
  const afterPunct = aClass === 'punct';
  const canOpen = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const canClose = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left: canOpen, right: canClose, beforePunct, afterPunct };
}

// Is the '_' run starting at `start` part of a valid email's local
// part? (Such underscores stay literal text so the email can form.)
// The local part must extend from `start` to an '@' that begins a
// valid email whose start is at or before `start`.
function emailUnderscore(text, start) {
  const n = text.length;
  const j = emailLocal(text, start);
  if (j >= n || text[j] !== '@') return false;
  const em = bareEmail(text, j);
  return em !== null && em.start <= start;
}

// Length of the '~' run starting at text[i].
function tildeRun(text, i) {
  const n = text.length;
  let j = i;
  while (j < n && text[j] === '~') j++;
  return j - i;
}

// Find the closing '~' run for an opener of length len, searching
// from `from`. Stack discipline via depth counting (same-length runs
// only): a run that can close matches the nearest unmatched opener
// (depth 0 = our opener); a run that can only open increases the
// depth. This gives proper nesting (~~a ~~b~~ c~~ nests) instead of
// first-closer matching. Returns the closer's run start, or -1.
function tildeCloser(text, from, len) {
  const n = text.length;
  let depth = 0;
  let i = from;
  while (i < n) {
    if (text[i] === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (text[i] !== '~') {
      i++;
      continue;
    }
    const runLen = tildeRun(text, i);
    const j = i + runLen;
    if (runLen === len) {
      // Strikethrough uses the same flanking rules as emphasis: a run
      // preceded by punctuation (e.g. an escaped '~') and followed by
      // a letter can only open, not close.
      const { left, right } = flankInfo(text, i, j);
      if (right) {
        if (depth === 0) return i;
        depth--;
      } else if (left) {
        depth++;
      }
    }
    i = j;
  }
  return -1;
}

// Whether an emphasis delimiter run of char c can open/close, given
// its flanking info. '*' uses flanking directly; '_' cannot open or
// close intraword (it needs a punctuation neighbor on the far side
// when the run can do both).
function emphasisFlanks(c, fl) {
  if (c === '*') return { canOpen: fl.left, canClose: fl.right };
  return {
    canOpen: fl.left && (!fl.right || fl.beforePunct),
    canClose: fl.right && (!fl.left || fl.afterPunct),
  };
}

// Does a backtick run inside the del content [j, closer) have its
// first same-length closer AFTER the del closer? Then the code span
// crosses the '~~' and the del does not form. An escaped backtick
// (\`) cannot open a code span, so backslash escapes are skipped
// when scanning the content.
function codeSpanCrossesDel(text, j, closer, n) {
  let p = j;
  while (p < closer) {
    if (text[p] === '\\' && p + 1 < closer) { p += 2; continue; }
    if (text[p] === '`') {
      let e = p;
      while (e < closer && text[e] === '`') e++;
      const rLen = e - p;
      let k = e;
      while (k < n) {
        if (text[k] === '`') {
          let f = k;
          while (f < n && text[f] === '`') f++;
          if (f - k === rLen) {
            if (k >= closer) return true;
            p = f;
            break;
          }
          k = f;
        } else k++;
      }
      if (k >= n) p = e;
    } else p++;
  }
  return false;
}

// Parse inline content into HTML. With plain=true it renders plain text
// (image alt text: no tags, no-encode escaping).
function parseInline(text, refs, plain) {
  const n = text.length;
  const esc = plain ? escapeNoEncode : escapeText;
  const chunks = [];
  const chunkSrc = [];
  const delims = [];
  const brackets = [];
  const autoLinks = [];
  // Positions of every ']' seen so far. A link or image only forms when
  // its text has equal '[' and ']' counts, so these positions anchor the
  // balance check.
  const closes = [];
  // Backtick runs that never found a matching closer. An unclosed
  // backtick inside link text blocks the link from forming.
  const unclosedTicks = [];
  // [start, end] of every closed code span. The link-text backtick
  // parity exception: an odd run count is allowed when the link text
  // ends with a closed code span.
  const codeSpans = [];
  // Chunk indices of <del> elements whose content ends with a blocking
  // strong pair — a ** pair whose opener is preceded by a space and
  // whose closer sits at the end of the del content, optionally followed
  // by letters. Such a del blocks an enclosing * em match.
  const blockingDels = [];
  // Chunk indices of <del> elements whose content ends with a * em
  // (closer at the end, optionally followed by letters). Such a del
  // blocks an enclosing ** strong match.
  const blockingDelsStrong = [];
  // Extended autolinks formed inside each del's recursive parse, keyed
  // by the chunk index of the del's inner HTML chunk: [{chunk, ext}].
  // When a link forms around the del, these revert to text.
  const delExtAutolinks = [];
  // Marked quirk: after a link whose text contains an unclosed backtick
  // run, emphasis delimiters stay suppressed while any backtick remains
  // later in the text — not just until the next backtick run: a later
  // backtick keeps the suppression active.
  let suppressEmUntilTick = false;
  const lastBacktick = text.lastIndexOf('`');
  let scopeCounter = 0;
  let i = 0;
  let textStart = 0;

  // Append one output chunk, remembering where it came from in the source.
  function pushChunk(s, src) {
    chunks.push(s);
    chunkSrc.push(src);
  }
  // Flush the plain text run [textStart, upto) as one escaped chunk.
  function flushText(upto) {
    if (upto <= textStart) return;
    pushChunk(esc(text.slice(textStart, upto)), textStart);
  }
  // Rebuild a delimiter's chunk from its current tags and leftover
  // literal length. Normally the close tags come first ("**a***" ->
  // "<strong>a</strong>*"); when a recorded em span lies between this
  // closer's opener and the closer, the leftover literals render inside
  // the element ("**a *b*c***" -> "<strong>a <em>b</em>c*</strong>").
  function rebuildDelim(d) {
    const lit = d.ch.repeat(d.len);
    const close = d.closeTags.join('');
    const open = d.openTags.join('');
    if (d.leftoverInside) {
      chunks[d.chunk] = lit + close + open;
    } else {
      chunks[d.chunk] = close + lit + open;
    }
  }
  // Is there an active (unclosed) bracket? Delimiter suppression does
  // not apply inside link text, which is tokenized in its own scope.
  function activeBracket() {
    return brackets.some((b) => b.active);
  }
  // Index of the last active (unclosed) bracket, or -1 when there is none.
  function lastActiveBracketIndex() {
    let bi = brackets.length - 1;
    while (bi >= 0 && !brackets[bi].active) bi--;
    return bi;
  }
  // Record a new bracket (link or image) in the bracket stack.
  function addBracket(chunk, bangChunk, srcPos, isImage) {
    brackets.push({
      chunk, bangChunk, srcPos, isImage, active: true,
      closesAtPush: closes.length, inLinkAtPush: inLinkGlobal,
      linkBlocked: false,
    });
  }
  // Is there an unmatched '_' opener that can open emphasis? When one
  // exists, trailing '_'s in an email domain or URL are emphasis
  // delimiters (trimmed), not domain characters.
  function openUnderscore() {
    return delims.some((d) => !d.dead && d.ch === '_' && d.canOpen);
  }
  // Update the document-global in-link state for one inline HTML tag
  // spanning text[i..he): the exact tag "</a>" clears it; an "<a" open
  // tag whose name is followed by a literal space sets it.
  function trackLinkState(i, he) {
    if (he - i === 4 && text[i + 1] === '/' &&
        (text[i + 2] === 'a' || text[i + 2] === 'A') &&
        text[i + 3] === '>') {
      inLinkGlobal = false;
    } else if ((text[i + 1] === 'a' || text[i + 1] === 'A') &&
        text[i + 2] === ' ') {
      inLinkGlobal = true;
    }
  }
  // Count the spaces immediately before position i, back to textStart.
  function trailingSpaces(i) {
    let sp = 0;
    let k = i - 1;
    while (k >= textStart && text[k] === ' ') { sp++; k--; }
    return sp;
  }

  // Handle a backslash escape at i. Returns the new index: a hard
  // break (backslash-newline) or an escaped punctuation mark advances
  // past the escape; any other backslash is literal text.
  function backslash() {
    const next = i + 1 < n ? text[i + 1] : '';
    if (next === '\n') {
      // Backslash-newline is a hard break; spaces/tabs after the
      // newline are skipped too.
      flushText(i);
      if (!plain) pushChunk('<br>', i);
      let k = i + 2;
      while (k < n && blankChar(text[k])) k++;
      textStart = k;
      return k;
    }
    if (asciiPunct(next)) {
      // Backslash-punctuation is the literal punctuation.
      flushText(i);
      pushChunk(esc(next), i);
      textStart = i + 2;
      return i + 2;
    }
    // Any other backslash is literal text.
    return i + 1;
  }
  // Record an image or link bracket starting at i ('![' or '[').
  // Advances i past the bracket and resets textStart.
  function openBracket(isImage) {
    flushText(i);
    let bangChunk = -1;
    if (isImage) {
      bangChunk = chunks.length;
      pushChunk('!', i);
    }
    const brChunk = chunks.length;
    pushChunk('[', isImage ? i + 1 : i);
    addBracket(brChunk, bangChunk, isImage ? i + 1 : i, isImage);
    i += isImage ? 2 : 1;
    textStart = i;
  }
  // Handle '<' at i: an angle autolink, raw inline HTML, or a literal
  // '<'. Returns the new index.
  function angleAt() {
    const aa = angleAutolink(text, i);
    if (aa) {
      flushText(i);
      if (plain) pushChunk(esc(aa.text), i);
      else {
        pushChunk(
          `<a href="${cleanUrl(aa.href)}">${escapeNoEncode(aa.text)}</a>`, i);
      }
      textStart = aa.end;
      return aa.end;
    }
    const he = inlineHtml(text, i);
    if (he !== -1) {
      flushText(i);
      if (plain) pushChunk(escapeNoEncode(text.slice(i, he)), i);
      else pushChunk(text.slice(i, he), i);
      // An inline <a> tag sets the document-global in-link state
      // (suppresses extended autolinks); the exact tag "</a>" clears
      // it. The open tag needs a literal space after the name.
      trackLinkState(i, he);
      textStart = he;
      return he;
    }
    return i + 1;
  }
  // Handle '&' at i: a valid entity reference renders as its
  // character(s); anything else leaves the '&' as literal text.
  // Returns the new index.
  function entityBranch() {
    const ent = entityAt(text, i);
    if (!ent) return i + 1;
    flushText(i);
    pushChunk(ent.out, i);
    textStart = i + ent.len;
    return i + ent.len;
  }
  // Handle '\n' at i: a hard break (2+ trailing spaces) or a soft
  // break. Returns the new index.
  function newlineBranch() {
    const sp = trailingSpaces(i);
    if (sp < 2) return i + 1;
    flushText(i - sp);
    if (!plain) pushChunk('<br>', i);
    let k = i + 1;
    while (k < n && blankChar(text[k])) k++;
    textStart = k;
    return k;
  }
  // If the URL swallowed a ']' that closes an active bracket AND a link
  // will form from that ']', truncate the URL to before the ']'
  // (otherwise the ']' is part of the URL and no link forms). Returns
  // the (possibly truncated) autolink, or null when the truncation
  // leaves nothing.
  function truncateAutolinkAtBracket(u, i) {
    if (!u.text.includes(']')) return u;
    const bi = lastActiveBracketIndex();
    if (bi < 0) return u;
    const closePos = i + u.text.indexOf(']');
    const after = text[closePos + 1];
    let linkForms = false;
    if (after === '(') {
      linkForms = parseInlineLink(text, closePos + 1) !== null;
    } else if (after === '[') {
      const rl = parseRefLabel(text, closePos + 1);
      if (rl) linkForms = refs.has(normalizeLabel(rl.label));
    } else {
      const label = text.slice(brackets[bi].srcPos + 1, closePos);
      linkForms = refs.has(normalizeLabel(label));
    }
    if (!linkForms) return u;
    const trunc = trimUrl(text.slice(i, closePos));
    if (!trunc) return null;
    if (u.href !== u.text) u.href = 'http://' + trunc;
    else u.href = trunc;
    u.text = trunc;
    u.end = i + trunc.length;
    return u;
  }
  // Handle '@' at i: a bare email forms a mailto autolink. Returns the
  // new index, or null when no email starts here.
  function emailBranch() {
    // If an unmatched '_' opener exists, trailing '_'s in the domain
    // are emphasis delimiters (trimmed), not domain characters.
    const trimUs = openUnderscore();
    const em = bareEmail(text, i, textStart, trimUs);
    if (!em) return null;
    flushText(em.start);
    if (plain) pushChunk(esc(text.slice(em.start, em.end)), em.start);
    else {
      const chunkIdx = chunks.length;
      const email = text.slice(em.start, em.end);
      pushChunk(
        `<a href="mailto:${escapeNoEncode(email)}">${escapeNoEncode(email)}</a>`,
        em.start);
      autoLinks.push({ chunk: chunkIdx, raw: email, extended: true, reverted: false });
    }
    textStart = em.end;
    return em.end;
  }

  while (i < n) {
    const c = text[i];
    // Backslash escapes.
    if (c === '\\') {
      i = backslash();
      continue;
    }
    // Code spans.
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const runLen = j - i;
      // Find a matching run of the same length. A code span may cross a
      // ']' — but not one that closes a bracket whose text has even
      // backtick parity (a link will form there, so the ']' belongs to
      // the link, not the code span).
      let close = -1;
      let k = j;
      let depth = 0;
      while (k < n) {
        const ch = text[k];
        if (ch === '\\' && k + 1 < n) {
          // Skip escaped brackets/backslash for depth tracking, but NOT
          // escaped backticks: code spans do not process backslash escapes.
          const nx = text[k + 1];
          if (nx === '[' || nx === ']' || nx === '\\') { k += 2; continue; }
          k++;
          continue;
        }
        if (ch === '[') { depth++; k++; continue; }
        if (ch === ']' && depth === 0) {
          const bi = lastActiveBracketIndex();
          if (bi >= 0) {
            // Count backtick runs in the bracket text.
            let ticks = 0;
            let p = brackets[bi].srcPos + 1;
            while (p < k) {
              if (text[p] === '\\' && p + 1 < k) { p += 2; continue; }
              if (text[p] === '`') {
                ticks++;
                while (p < k && text[p] === '`') p++;
              } else p++;
            }
            // The code span stops at this ']' only when a link will
            // actually form from it: even parity, balanced brackets,
            // and a resolving suffix (inline, reference, or shortcut).
            // Otherwise the code span crosses the ']' (e.g. an
            // undefined reference leaves the bracket literal).
            const openCount = brackets.length - 1 - bi;
            const closeCount = closes.length - brackets[bi].closesAtPush;
            if (ticks % 2 === 0 && openCount === closeCount) {
              const after = text[k + 1];
              const label = text.slice(brackets[bi].srcPos + 1, k);
              let linkForms = false;
              if (after === '(') {
                linkForms = parseInlineLink(text, k + 1) !== null ||
                  refs.has(normalizeLabel(label));
              } else if (after === '[') {
                const rl = parseRefLabel(text, k + 1);
                if (rl) {
                  linkForms = refs.has(normalizeLabel(
                    rl.label === '' ? label : rl.label));
                }
              } else {
                linkForms = refs.has(normalizeLabel(label));
              }
              if (linkForms) break;
            }
          }
          k++;
          continue;
        }
        if (ch === ']') { depth--; k++; continue; }
        if (ch === '`') {
          let e = k;
          while (e < n && text[e] === '`') e++;
          if (e - k === runLen) { close = k; break; }
          k = e;
        } else k++;
      }
      if (close !== -1) {
        let content = text.slice(j, close).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ' &&
            content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flushText(i);
        if (plain) pushChunk(esc(content), i);
        else pushChunk('<code>' + escapeText(content) + '</code>', i);
        codeSpans.push([i, close + runLen]);
        i = close + runLen;
        textStart = i;
        continue;
      }
      unclosedTicks.push(i);
      i = j;
      continue;
    }
    // Emphasis delimiters.
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const runLen = j - i;
      const fl = flankInfo(text, i, j);
      const { canOpen, canClose } = emphasisFlanks(c, fl);
      if ((canOpen || canClose) &&
          !(c === '_' && emailUnderscore(text, i))) {
        flushText(i);
        const chunkIdx = chunks.length;
        pushChunk(text.slice(i, j), i);
        // The backtick-link emphasis suppression does not apply inside
        // a bracket (link text is tokenized in its own scope).
        const inBracket = activeBracket();
        delims.push({
          chunk: chunkIdx, ch: c, len: runLen, canOpen, canClose,
          scope: 0, openTags: [], closeTags: [],
          dead: suppressEmUntilTick && !inBracket && i < lastBacktick,
        });
        i = j;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // Strikethrough.
    if (c === '~') {
      let j = i;
      while (j < n && text[j] === '~') j++;
      const runLen = j - i;
      // The link-with-unclosed-backticks suppression (see the emphasis
      // delimiters) also blocks strikethrough: while a backtick remains
      // later in the text, a '~' run is literal. It does not apply
      // inside brackets.
      if (suppressEmUntilTick && i < lastBacktick && !activeBracket()) {
        i = j;
        continue;
      }
      if ((runLen === 1 || runLen === 2) && flankInfo(text, i, j).left) {
        const closer = tildeCloser(text, j, runLen);
        if (closer !== -1) {
          if (codeSpanCrossesDel(text, j, closer, n)) { i = j; continue; }
          flushText(i);
          const linksBefore = linksFormed;
          const extBefore = extAutolinks.length;
          const inner = parseInline(text.slice(j, closer), refs, plain);
          // A link formed inside the strikethrough blocks every
          // enclosing bracket from forming a link (links cannot
          // contain links).
          if (linksFormed > linksBefore) {
            for (const b of brackets) {
              if (b.active) b.linkBlocked = true;
            }
          }
          // Extended autolinks formed inside the del are recorded so
          // a link forming around the del can revert them to text.
          const delExt = extAutolinks.slice(extBefore);
          if (delExt.length > 0) {
            delExtAutolinks.push({ chunk: chunks.length + 1, ext: delExt });
          }
          // A del whose content ends with a blocking ** strong pair
          // (opener preceded by a space, closer at the end, optionally
          // followed by letters) blocks an enclosing * em match. A
          // __ strong does not block (different delimiter char).
          // A del whose content ends with a * em blocks an enclosing
          // ** strong match.
          if (!plain) {
            const content = text.slice(j, closer);
            if (/<\/strong>[A-Za-z0-9]*$/.test(inner) &&
                /\*\*[A-Za-z0-9]*$/.test(content)) {
              const sIdx = inner.lastIndexOf('<strong>');
              if (sIdx > 0 && inner[sIdx - 1] === ' ') {
                blockingDels.push(chunks.length);
              }
            } else if (/<\/em>$/.test(inner) &&
                       /[^\*]\*$/.test(content)) {
              blockingDelsStrong.push({ chunk: chunks.length, fails: 0 });
            }
          }
          if (!plain) pushChunk('<del>', i);
          pushChunk(inner, j);
          if (!plain) pushChunk('</del>', closer);
          i = closer + runLen;
          textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // Image start.
    if (c === '!' && i + 1 < n && text[i + 1] === '[') {
      openBracket(true);
      continue;
    }
    // Link bracket.
    if (c === '[') {
      openBracket(false);
      continue;
    }
    // Close bracket: try to form a link/image.
    if (c === ']') {
      const bi = lastActiveBracketIndex();
      if (bi >= 0) {
        const br = brackets[bi];
        // Balance check: the text must have equal '[' and ']' counts.
        // '[' count = brackets pushed after br; ']' count = closes
        // recorded since br was pushed (not counting this ']').
        // Unbalanced text means this ']' is skipped entirely: no link
        // forms AND the bracket stays active for a later ']'.
        const openCount = brackets.length - 1 - bi;
        const closeCount = closes.length - br.closesAtPush;
        // Backtick parity: count ALL unescaped backtick runs in the link
        // text (including runs inside code spans). An odd count blocks
        // the link — unless the link text ends with a closed code span
        // (its closing run immediately before this ']').
        let tickCount = 0;
        for (let tp = br.srcPos + 1; tp < i; tp++) {
          if (text[tp] === '\\') { tp++; continue; }
          if (text[tp] === '`') {
            tickCount++;
            while (tp + 1 < i && text[tp + 1] === '`') tp++;
          }
        }
        let parityOk = tickCount % 2 === 0;
        if (!parityOk) {
          const lastCs = codeSpans[codeSpans.length - 1];
          parityOk = !!lastCs && lastCs[1] === i && lastCs[0] > br.srcPos;
        }
        // A bracket containing a markdown link (formed inside a
        // strikethrough's recursive parse) can never form a link
        // itself: links cannot contain links.
        const linkBlocked = br.linkBlocked;
        if (linkBlocked) brackets[bi].active = false;
        // Marked quirk: a failed inline-link attempt (']' followed by
        // '(' with no link forming) suppresses emphasis inside the
        // bracket text. Applies to balance/parity/link-blocked
        // failures too.
        if ((linkBlocked || openCount !== closeCount || !parityOk) &&
            i + 1 < n && text[i + 1] === '(') {
          for (const d of delims) {
            if (d.chunk > br.chunk && d.scope === 0) d.dead = true;
          }
        }
        if (!linkBlocked && openCount === closeCount && parityOk) {
        const linkTextRaw = text.slice(br.srcPos + 1, i);
        let href = null;
        let title = null;
        let endPos = -1;
        let isInline = false;
        if (i + 1 < n && text[i + 1] === '(') {
          const il = parseInlineLink(text, i + 1);
          if (il) { href = il.href; title = il.title; endPos = il.end; isInline = true; }
          // A failed inline link falls back to the shortcut reference.
          if (href === null) {
            const label = normalizeLabel(linkTextRaw);
            const ref = refs.get(label);
            if (ref) { href = ref.href; title = ref.title; endPos = i + 1; }
          }
        } else if (i + 1 < n && text[i + 1] === '[') {
          const rl = parseRefLabel(text, i + 1);
          if (rl) {
            const label = rl.label === ''
              ? normalizeLabel(linkTextRaw)
              : normalizeLabel(rl.label);
            const ref = refs.get(label);
            if (ref) { href = ref.href; title = ref.title; endPos = rl.end; }
          }
          // A failed/undefined reference does NOT fall back to the
          // shortcut: the bracket stays literal (cm-571).
        } else {
          const label = normalizeLabel(linkTextRaw);
          const ref = refs.get(label);
          if (ref) { href = ref.href; title = ref.title; endPos = i + 1; }
        }
        if (href !== null) {
          // Unclosed backtick in an INLINE link's text suppresses
          // later emphasis while a backtick remains later in the
          // text. Reference/shortcut links do not suppress.
          if (!br.isImage && isInline) {
            for (const tp of unclosedTicks) {
              if (tp > br.srcPos && tp < i &&
                  text.indexOf('`', endPos) !== -1) {
                suppressEmUntilTick = true;
                break;
              }
            }
          }
          flushText(i);
          const L = chunks.length;
          if (!br.isImage) {
            linksFormed++;
            scopeCounter++;
            for (const d of delims) {
              if (!d.dead && d.chunk > br.chunk && d.chunk < L) {
                d.scope = scopeCounter;
              }
            }
            for (const a of autoLinks) {
              if (a.extended && !a.reverted && a.chunk > br.chunk && a.chunk < L) {
                chunks[a.chunk] = escapeNoEncode(a.raw);
                a.reverted = true;
              }
            }
            // Extended www autolinks formed inside a strikethrough's
            // recursive parse are not in autoLinks; revert them by
            // their distinctive HTML (href is "http://" + text, so
            // angle autolinks, whose href equals their text, never
            // match). Email autolinks are left alone: a bare email
            // and an angle email render identical HTML.
            for (let cc = br.chunk + 1; cc < L; cc++) {
              const ch = chunks[cc];
              if (ch.includes('<a href="http://')) {
                chunks[cc] = ch.replace(
                  /<a href="http:\/\/([^"<]+)">\1<\/a>/g, '$1');
              }
            }
            // Extended autolinks (incl. https) formed inside a del
            // within this link are reverted via creation-time tracking
            // (their HTML is identical to angle autolinks').
            for (const de of delExtAutolinks) {
              if (de.chunk > br.chunk && de.chunk < L) {
                for (const e of de.ext) {
                  if (chunks[de.chunk].includes(e.html)) {
                    chunks[de.chunk] =
                      chunks[de.chunk].split(e.html).join(e.text);
                  }
                }
              }
            }
            if (plain) {
              chunks[br.chunk] = '';
            } else {
              const tAttr = title != null ? ` title="${escapeNoEncode(title)}"` : '';
              chunks[br.chunk] = `<a href="${cleanUrl(href)}"${tAttr}>`;
              pushChunk('</a>', i);
            }
          } else {
            const alt = parseInline(linkTextRaw, refs, true);
            if (plain) {
              chunks[br.bangChunk] = '';
              chunks[br.chunk] = '';
              for (let cc = br.chunk + 1; cc < L; cc++) chunks[cc] = '';
              pushChunk(alt, br.srcPos);
            } else {
              const tAttr = title != null ? ` title="${escapeNoEncode(title)}"` : '';
              chunks[br.bangChunk] = '';
              chunks[br.chunk] =
                `<img src="${cleanUrl(href)}" alt="${alt}"${tAttr}>`;
              for (let cc = br.chunk + 1; cc < L; cc++) chunks[cc] = '';
            }
            for (const d of delims) {
              if (d.chunk > br.chunk && d.chunk < L) d.dead = true;
            }
            // Autolinks inside the image text are gone for good: mark them
            // so a later enclosing link cannot resurrect them as text.
            for (const a of autoLinks) {
              if (a.chunk > br.chunk && a.chunk < L) a.reverted = true;
            }
          }
          if (br.isImage) {
            // An image only consumes its own bracket; an enclosing link
            // bracket stays active so [![alt](src)](href) can still form.
            brackets[bi].active = false;
          } else {
            // A link cannot contain a link: deactivate this bracket and
            // every LINK bracket before it. Image brackets survive, so
            // an image can still form around a link in its alt text.
            for (let b2 = 0; b2 <= bi; b2++) {
              if (!brackets[b2].isImage) brackets[b2].active = false;
            }
          }
          // Link text is an isolated scope: an <a> tag inside it does
          // not leak into the document-global in-link state.
          inLinkGlobal = br.inLinkAtPush;
          closes.push(i);
          i = endPos;
          textStart = i;
          continue;
        }
        // Failure (balanced text, no usable suffix): deactivate this
        // bracket so a later ']' cannot reuse it. A failed inline-link
        // attempt suppresses emphasis inside the bracket text.
        if (i + 1 < n && text[i + 1] === '(') {
          for (const d of delims) {
            if (d.chunk > br.chunk && d.scope === 0) d.dead = true;
          }
        }
        brackets[bi].active = false;
        // Nested-adjacent-']]' rule (cm-512): if the next char is ']' and
        // the char after that starts a link suffix, and this bracket's
        // parent is not the outermost active bracket, deactivate the
        // parent too, so the next ']' pairs with the outermost bracket.
        if (i + 1 < n && text[i + 1] === ']' && i + 2 < n &&
            (text[i + 2] === '(' || text[i + 2] === '[')) {
          let pi = bi - 1;
          while (pi >= 0 && !brackets[pi].active) pi--;
          if (pi >= 0) {
            let qi = pi - 1;
            while (qi >= 0 && !brackets[qi].active) qi--;
            if (qi >= 0) brackets[pi].active = false;
          }
        }
        } // end balance check
      }
      closes.push(i);
      i++;
      continue;
    }
    // Angle autolinks and inline HTML.
    if (c === '<') {
      i = angleAt();
      continue;
    }
    // Entities: a valid entity reference renders as its character(s);
    // anything else leaves the '&' as literal text.
    if (c === '&') {
      i = entityBranch();
      continue;
    }
    // Newlines: hard breaks (2+ trailing spaces) or soft breaks.
    if (c === '\n') {
      i = newlineBranch();
      continue;
    }
    // Extended autolinks (www. / schemes / mailto: / xmpp:). Suppressed
    // while the document-global in-link state is set (an unclosed
    // inline <a> tag earlier in the document).
    if (!inLinkGlobal && (c === 'w' || c === 'h' || c === 'H' || c === 'f' ||
        c === 'F' || c === 'm' || c === 'x')) {
      const trimUs = openUnderscore();
      let u = extendedAutolink(text, i, trimUs);
      if (u) u = truncateAutolinkAtBracket(u, i);
      if (u) {
        flushText(i);
        if (plain) pushChunk(esc(u.text), i);
        else {
          const chunkIdx = chunks.length;
          const aHtml = `<a href="${cleanUrl(u.href)}">${escapeNoEncode(u.text)}</a>`;
          pushChunk(aHtml, i);
          autoLinks.push({ chunk: chunkIdx, raw: u.text, extended: true, reverted: false });
          extAutolinks.push({ html: aHtml, text: escapeNoEncode(u.text) });
        }
        i = u.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Bare emails. Suppressed while the document-global in-link state
    // is set (an unclosed inline <a> tag earlier in the document).
    if (c === '@' && !inLinkGlobal) {
      const next = emailBranch();
      if (next !== null) {
        i = next;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);

  // Emphasis resolution (delimiter stack, CommonMark rules + scope isolation).
  // Matched single-delimiter (em) spans, for the cross-pair blocking rule.
  const emSpans = [];
  // Matched strong (use-2) pairs, for the blocking rule below. Each
  // pair counts closers that failed against it; two failures lift it.
  const strongPairs = [];
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (closer.dead || closer.len === 0 || !closer.canClose) continue;
    const startLen = closer.len;
    const blockedBy = [];
    const blockedByDel = [];
    let oi = di - 1;
    while (oi >= 0 && closer.len > 0) {
      const opener = delims[oi];
      if (!opener.dead && opener.len > 0 && opener.canOpen &&
          opener.ch === closer.ch && opener.scope === closer.scope) {
        // Odd-match rule: if either delimiter can both open and close,
        // the sum of the lengths must not be a multiple of 3 unless both
        // lengths are multiples of 3.
        if (((opener.canOpen && opener.canClose) ||
             (closer.canOpen && closer.canClose)) &&
            (opener.len + closer.len) % 3 === 0 &&
            (opener.len % 3 !== 0 || closer.len % 3 !== 0)) {
          // Marked quirk: a closer that can also open STOPS its
          // look-back at an odd-rule block (it stays available as an
          // opener for a later closer instead of matching a farther
          // opener). A can-only-close closer keeps looking back.
          if (closer.canOpen) break;
          oi--;
          continue;
        }
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        // Marked quirk: a single-* closer cannot match a ** opener
        // across a matched em pair whose closer can also open.
        if (use === 1 && opener.len >= 2 && closer.ch === '*') {
          let blocked = false;
          for (const s of emSpans) {
            if (s[2] === '*' && oi < s[0] && s[1] < di) { blocked = true; break; }
          }
          if (blocked) { oi--; continue; }
        }
        // Marked quirk: a matched ** pair whose closer can open and
        // whose opener cannot close blocks matches across it — unless
        // the closer run has length >= 3 or the match uses 2 (strong).
        // Pairs already enclosed in a matched span (dead) don't block.
        // The block lifts after two closers fail against it, or once
        // the first '*' delimiter after the pair is used up.
        if (closer.ch === '*' && !(closer.len >= 3 || use === 2)) {
          let blocked = false;
          for (const p of strongPairs) {
            if (p.fails >= 2) continue;
            if (oi < p.oi && p.di < di) {
              const pop = delims[p.oi], pcl = delims[p.di];
              // A pair inside a link (different scope) does not block
              // an outer match.
              if (pop.scope !== closer.scope) continue;
              if (!pop.dead && !pcl.dead && pcl.canOpen && !pop.canClose &&
                  pop.ch === '*') {
                let firstUsed = false;
                for (let k = p.di + 1; k < di; k++) {
                  if (delims[k].ch === '*') {
                    firstUsed =
                      delims[k].len === 0 || delims[k].dead;
                    break;
                  }
                }
                if (!firstUsed) {
                  blocked = true;
                  if (!blockedBy.includes(p)) blockedBy.push(p);
                  break;
                }
              }
            }
          }
          // A blocking del (content ending in a strong pair) between
          // the opener and closer also blocks the match.
          if (!blocked) {
            for (const dc of blockingDels) {
              if (opener.chunk < dc && dc < closer.chunk) {
                blocked = true;
                break;
              }
            }
          }
          if (blocked) { oi--; continue; }
        }
        // A del ending in a * em blocks an enclosing ** strong match.
        // The block lifts after one closer fails against it.
        if (use === 2 && closer.ch === '*') {
          let blockedStrong = false;
          for (const dc of blockingDelsStrong) {
            if (dc.fails >= 1) continue;
            if (opener.chunk < dc.chunk && dc.chunk < closer.chunk) {
              blockedStrong = true;
              if (!blockedByDel.includes(dc)) blockedByDel.push(dc);
              break;
            }
          }
          if (blockedStrong) { oi--; continue; }
        }
        opener.len -= use;
        closer.len -= use;
        if (use === 1 && closer.canOpen) emSpans.push([oi, di, closer.ch]);
        if (use === 2) {
          strongPairs.push({ oi, di, fails: 0 });
          // A recorded em span between the opener and closer moves the
          // closer's leftover literals inside the strong element.
          for (const s of emSpans) {
            if (s[2] === closer.ch && oi < s[0] && s[1] < di) {
              closer.leftoverInside = true;
              break;
            }
          }
        }
        if (!plain) {
          opener.openTags.unshift(use === 2 ? '<strong>' : '<em>');
          closer.closeTags.push(use === 2 ? '</strong>' : '</em>');
        }
        rebuildDelim(opener);
        rebuildDelim(closer);
        // Emphasis spans nest properly: delimiters strictly between this
        // opener and closer can no longer match anything outside the span.
        for (let k = oi + 1; k < di; k++) delims[k].dead = true;
        continue;
      }
      oi--;
    }
    // A closer that matched nothing because strong pairs blocked it
    // counts as a failure against each blocking pair. The second
    // failure lifts the block — and a can-both closer that fails
    // this second time is dead as an opener too (it cannot open for
    // a later closer, which then matches across the pair instead).
    if (closer.len === startLen && blockedBy.length > 0) {
      let lifted = false;
      for (const p of blockedBy) {
        p.fails++;
        if (p.fails >= 2) lifted = true;
      }
      if (lifted && closer.canOpen) closer.dead = true;
    }
    // A closer that failed against a del-strong block lifts the block.
    if (closer.len === startLen) {
      for (const dc of blockedByDel) dc.fails++;
    }
  }

  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// The task-list checkbox HTML for a list item, or '' when this is
// not a task item or not the first child. A checked box carries a
// checked="" attribute; both forms are disabled (read-only).
function checkboxFor(item, first) {
  if (!first) return '';
  if (!item.task) return '';
  const mark = item.task === 'checked' ? 'checked="" ' : '';
  return `<input ${mark}disabled="" type="checkbox"> `;
}

// Render one paragraph child of a list item: task checkbox (first
// child only) + inline content, wrapped in <p> when the list is
// loose. In a tight list the paragraph's text is inlined directly
// into the <li> with no <p> wrapper.
function itemParagraph(item, idx, child, loose, refs, out) {
  const html = checkboxFor(item, idx === 0) + parseInline(child.text, refs, false);
  if (loose) {
    out.push('<p>', html, '</p>\n');
    return;
  }
  out.push(html);
}

// Render one list item: its children in order, paragraphs inline
// (with a task checkbox on the first child) and other blocks
// rendered normally. An item with no children renders as an empty
// <li></li>.
function listItem(item, loose, refs, out) {
  out.push('<li>');
  const kids = item.children;
  if (kids.length === 0) {
    out.push('</li>\n');
    return;
  }
  for (let idx = 0; idx < kids.length; idx++) {
    const child = kids[idx];
    if (child.t === 'p') {
      itemParagraph(item, idx, child, loose, refs, out);
    } else {
      renderAll([child], refs, out);
    }
  }
  out.push('</li>\n');
}

// Render one table cell (header or body): alignment attribute +
// inline content. The alignment attribute is omitted when the
// column has no alignment.
function tableCell(tag, align, text, refs, out) {
  const alignAttr = align ? ` align="${align}"` : '';
  out.push(`<${tag}${alignAttr}>`, parseInline(text, refs, false), `</${tag}>\n`);
}

// Render one table: header row, then a body section when there are
// body rows. A table with no body rows has no <tbody> at all (not
// even an empty one).
function tableOut(table, refs, out) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let idx = 0; idx < table.head.length; idx++) {
    tableCell('th', table.align[idx], table.head[idx], refs, out);
  }
  out.push('</tr>\n</thead>\n');
  if (table.body.length > 0) {
    out.push('<tbody>');
    for (const cells of table.body) {
      out.push('<tr>\n');
      for (let idx = 0; idx < cells.length; idx++) {
        tableCell('td', table.align[idx], cells[idx], refs, out);
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

// One renderer per block type. Each takes (block, refs, out) and
// appends HTML chunks to out. The renderers are plain methods so
// they can recurse through renderAll for nested blocks (quotes,
// lists) without any indirection.
const RENDERERS = {
  p(block, refs, out) {
    out.push('<p>', parseInline(block.text, refs, false), '</p>\n');
  },
  h(block, refs, out) {
    out.push(`<h${block.level}>`, parseInline(block.text, refs, false), `</h${block.level}>\n`);
  },
  code(block, refs, out) {
    out.push('<pre><code>', escapeText(block.text), '</code></pre>\n');
  },
  fence(block, refs, out) {
    let langAttr = '';
    if (block.lang !== '') {
      langAttr = ` class="language-${escapeNoEncode(block.lang)}"`;
    }
    out.push(`<pre><code${langAttr}>`, escapeText(block.text), '</code></pre>\n');
  },
  hr(block, refs, out) {
    out.push('<hr>\n');
  },
  html(block, refs, out) {
    // Raw HTML blocks are emitted verbatim, exactly as collected
    // (including any trailing newline the block carries).
    out.push(block.text);
  },
  quote(block, refs, out) {
    out.push('<blockquote>\n');
    renderAll(block.children, refs, out);
    out.push('</blockquote>\n');
  },
  list(block, refs, out) {
    const listTag = block.ordered ? 'ol' : 'ul';
    let start = '';
    if (block.ordered && block.start !== 1) {
      start = ` start="${block.start}"`;
    }
    out.push(`<${listTag}${start}>\n`);
    for (const item of block.items) listItem(item, block.loose, refs, out);
    out.push(`</${listTag}>\n`);
  },
  table(block, refs, out) {
    tableOut(block, refs, out);
  },
};

// Walk the block list and render each block through its renderer.
// Unknown block types are skipped (there are none by construction,
// but a defensive check costs nothing here).
function renderAll(blocks, refs, out) {
  for (const block of blocks) {
    const fn = RENDERERS[block.t];
    if (fn) fn(block, refs, out);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Performance tuning notes (what actually moved the numbers, in the
// order it was found — kept here so the next round does not re-learn
// them by re-measuring):
//   * The single biggest win was rendering straight into output
//     chunks instead of building an inline AST: one pass per
//     paragraph, one join at the end. An AST costs a second walk
//     and an allocation per node; chunks cost a push per span.
//   * The second win was making the block stage consume lines
//     exactly once. Early versions re-scanned lines to decide
//     where a block ended; the readers now return their end index
//     and the main loop trusts it.
//   * Character classes as range checks beat regexes on the hot
//     path by a wide margin — not because regexes are slow in
//     general, but because a one-character test compiles to a few
//     integer comparisons while a regex match pays setup costs.
//     Regexes survive only where the pattern is genuinely
//     irregular (delimiter rows, task markers, email domains).
//   * String concatenation in a loop was the classic trap: joining
//     per-character strings inside the inline scanner scaled
//     quadratically on long paragraphs. Every hot loop now pushes
//     slices into an array and joins once.
//   * Pre-compiling the module-level regexes mattered more than
//     expected: constructing a RegExp inside a per-line loop cost
//     more than the match itself on short lines. Literals are
//     cached by the engine; `new RegExp` inside a loop is not.
//   * The delimiter stack is a plain array scanned from the end.
//     A Map keyed by delimiter character was tried and was
//     slower: the stack is short (a handful of entries on typical
//     input) and a linear scan from the top finds the match in
//     one or two steps, while a Map pays a hash on every push.
//   * Measuring with interleaved rounds (not sequential passes)
//     removed the phantom speedups: sequential timing let JIT
//     warm-up and machine drift masquerade as a faster parser.
//     The headline number is always the interleaved min-vs-min.

// Parse markdown to HTML, matching marked 18.1.3's default output.
// The module-level inline state (in-link flag, link/autolink
// tracking) is reset on every call so parses are independent of
// each other — calling parse() twice on the same input yields the
// same output both times.
export function parse(markdown) {
  clearInlineState();
  const srcLines = splitSource(markdown);
  const definitions = new Map();
  const tree = readBlocks(srcLines, definitions);
  const chunks = [];
  renderAll(tree, definitions, chunks);
  return chunks.join('');
}

// Walk every node of a block tree depth-first, calling fn(node,
// depth) on each node (items count as nodes too, at the depth of
// their list + 1). The walk visits children in document order.
// Diagnostics helper, not part of the competition surface.
export function walkBlocks(nodes, fn, depth = 0) {
  for (const node of nodes) {
    fn(node, depth);
    if (node.t === 'quote') walkBlocks(node.children, fn, depth + 1);
    if (node.t === 'list') {
      for (const item of node.items) {
        fn(item, depth + 1);
        walkBlocks(item.children, fn, depth + 2);
      }
    }
  }
}

// Parse markdown and return the block tree plus the link reference
// definitions found (as a plain object keyed by normalized label),
// without rendering any HTML. Diagnostics helper, not part of the
// competition surface — useful for inspecting a document's structure.
export function parseBlocks(markdown) {
  const srcLines = splitSource(markdown);
  const definitions = new Map();
  const tree = readBlocks(srcLines, definitions);
  const refs = {};
  for (const [label, def] of definitions) refs[label] = def;
  return { blocks: tree, refs };
}

// Diagnostics helper (not part of the competition surface): parse
// the markdown and report the block tree's shape — the top-level
// block types in order, the total block count including nested
// children, and the number of link reference definitions found.
// Useful for debugging a document that renders unexpectedly.
export function inspectDocument(markdown) {
  const srcLines = splitSource(markdown);
  const definitions = new Map();
  const tree = readBlocks(srcLines, definitions);
  const topTypes = [];
  let count = 0;
  function countBlocks(nodes, isTop) {
    for (const node of nodes) {
      count++;
      if (isTop) topTypes.push(node.t);
      if (node.t === 'quote') countBlocks(node.children, false);
      if (node.t === 'list') {
        for (const item of node.items) countBlocks(item.children, false);
      }
    }
  }
  countBlocks(tree, true);
  return { types: topTypes, total: count, refs: definitions.size };
}

// Reset the module-level inline state so one parse() call cannot
// leak into the next (in-link flag, link/autolink tracking). Called
// at the start of every parse() — never between parseInline calls
// within a single parse, where the state is deliberately shared.
function clearInlineState() {
  inLinkGlobal = false;
  linksFormed = 0;
  extAutolinks = [];
}
