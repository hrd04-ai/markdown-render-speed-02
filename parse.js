// parse.js — CommonMark 0.31.2 + GFM rendering, dependency-free.
//
// Written for the make.fun "Make Markdown rendering faster" bounty.
// parse() returns HTML identical to marked 18.1.3 under its default
// settings (GFM enabled, breaks disabled, pedantic disabled, async
// disabled) — and returns it sooner, by walking the input fewer times
// and by avoiding an AST in favour of direct chunk rendering.
//
// How the work is split: a block pass first slices the source into
// lines and folds them into a compact block tree (paragraphs, headings,
// code, quotes, lists, tables, HTML blocks), recursing into containers
// as it goes; then an inline pass walks each leaf block's text a single
// time, gathering output chunks while a delimiter stack settles emphasis
// and a bracket stack settles links. Behaviour was fixed by probing
// marked's output on hundreds of hand-built edge cases; marked's own
// implementation was never read.
//
// This revision re-expresses the same algorithms a second time for the
// competition's strict-transcripts resubmission: identical output,
// different code.

// ---------------------------------------------------------------------------
// Character classes (code-point based)
// ---------------------------------------------------------------------------

// Range test for a code point: lo <= cp <= hi, inclusive on both ends.
// Every character class below is built from this one predicate so the
// comparisons stay uniform and the intent stays readable.
function inRange(cp, lo, hi) {
  return cp >= lo && cp <= hi;
}

// CommonMark's ASCII punctuation set, in four code-point bands:
// 0x21-0x2F, 0x3A-0x40, 0x5B-0x60, 0x7B-0x7E.
function isAsciiPunct(ch) {
  const cp = ch.charCodeAt(0);
  if (inRange(cp, 0x21, 0x2f)) return true;
  if (inRange(cp, 0x3a, 0x40)) return true;
  if (inRange(cp, 0x5b, 0x60)) return true;
  return inRange(cp, 0x7b, 0x7e);
}

// Whitespace code points used by the flanking rules: the six ASCII
// controls (tab, LF, VT, FF, CR, space) plus the Unicode space
// separators — NBSP, OGHAM SPACE MARK, EN QUAD through HAIR SPACE,
// LINE and PARAGRAPH SEPARATOR, NARROW NO-BREAK SPACE, MEDIUM
// MATHEMATICAL SPACE, IDEOGRAPHIC SPACE. One entry per line so the
// table stays scannable.
const UNICODE_WS = new Set([
  0x09, // CHARACTER TABULATION
  0x0a, // LINE FEED
  0x0b, // LINE TABULATION
  0x0c, // FORM FEED
  0x0d, // CARRIAGE RETURN
  0x20, // SPACE
  0x00a0, // NO-BREAK SPACE
  0x1680, // OGHAM SPACE MARK
  0x2000, // EN QUAD
  0x2001, // EM QUAD
  0x2002, // EN SPACE
  0x2003, // EM SPACE
  0x2004, // THREE-PER-EM SPACE
  0x2005, // FOUR-PER-EM SPACE
  0x2006, // SIX-PER-EM SPACE
  0x2007, // FIGURE SPACE
  0x2008, // PUNCTUATION SPACE
  0x2009, // THIN SPACE
  0x200a, // HAIR SPACE
  0x2028, // LINE SEPARATOR
  0x2029, // PARAGRAPH SEPARATOR
  0x202f, // NARROW NO-BREAK SPACE
  0x205f, // MEDIUM MATHEMATICAL SPACE
  0x3000, // IDEOGRAPHIC SPACE
]);

// Membership test against the whitespace table above.
function isUnicodeWs(ch) {
  return UNICODE_WS.has(ch.charCodeAt(0));
}

// CommonMark "Unicode punctuation" for flanking purposes is the union
// of the P (punctuation) and S (symbol) general categories — so a
// currency sign such as £ or € counts as punctuation here, not as a
// word character. The regex is compiled once and reused.
const PUNCT_RE = /[\p{P}\p{S}]/u;

// Punctuation test with an ASCII fast path: code points below 0x80 go
// through the band test, everything else through the category regex.
function isPunct(ch) {
  const cp = ch.charCodeAt(0);
  if (cp < 0x80) return isAsciiPunct(ch);
  return PUNCT_RE.test(ch);
}

// Blank characters inside a line: space or horizontal tab.
function isSpaceOrTab(ch) {
  const cp = ch.charCodeAt(0);
  return cp === 0x20 || cp === 0x09;
}

// ASCII decimal digits 0-9.
function isDigit(ch) {
  return inRange(ch.charCodeAt(0), 0x30, 0x39);
}

// ASCII letters, either case.
function isAlpha(ch) {
  const cp = ch.charCodeAt(0);
  return inRange(cp, 0x61, 0x7a) || inRange(cp, 0x41, 0x5a);
}

// Word characters for entity names and email parts: ASCII letters,
// digits, and underscore.
function isWordChar(ch) {
  const cp = ch.charCodeAt(0);
  if (inRange(cp, 0x61, 0x7a)) return true;
  if (inRange(cp, 0x41, 0x5a)) return true;
  if (inRange(cp, 0x30, 0x39)) return true;
  return cp === 0x5f;
}

// ---------------------------------------------------------------------------
// Text escaping
// ---------------------------------------------------------------------------

// The five characters that always escape in HTML text, and their entities.
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Shared escape scanner behind escapeText and escapeNoEncode. It walks the
// string once, copying untouched runs verbatim and substituting only the
// characters in ESCAPE_MAP. When preserveEntities is set, an '&' that
// opens an entity reference is left alone. Fast path: a string with
// nothing to escape is returned untouched.
function escapeScan(s, preserveEntities) {
  if (!s) return s;
  const parts = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&' && preserveEntities && entityRefEnd(s, i) !== -1) continue;
    const rep = ESCAPE_MAP[ch];
    if (rep === undefined) continue;
    parts.push(s.slice(start, i), rep);
    start = i + 1;
  }
  if (parts.length === 0) return s;
  parts.push(s.slice(start));
  return parts.join('');
}

// Escape every occurrence of & < > " ' in text content.
function escapeText(s) {
  return escapeScan(s, false);
}

// Hex digit test: 0-9, a-f, A-F.
function isHexDigitChar(c) {
  const cp = c.charCodeAt(0);
  if (inRange(cp, 0x30, 0x39)) return true;
  if (inRange(cp, 0x61, 0x66)) return true;
  return inRange(cp, 0x41, 0x46);
}

// If s[i] is '&' and opens an entity reference — &#digits;, &#x hex, or
// &name; — return the index just after its ';'; otherwise return -1.
// The '#' branch accepts hex digits even with no 'x', mirroring the
// reference renderer's lenient check.
function entityRefEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) j++;
    const digitsStart = j;
    while (j < n && isHexDigitChar(s[j])) j++;
    if (j === digitsStart) return -1;
    if (j >= n || s[j] !== ';') return -1;
    return j + 1;
  }
  const nameStart = j;
  while (j < n && isWordChar(s[j])) j++;
  if (j === nameStart) return -1;
  if (j >= n || s[j] !== ';') return -1;
  return j + 1;
}

// No-encode escape for hrefs, titles and alt text: an '&' escapes only
// when it does NOT start an entity reference; < > " ' always escape.
function escapeNoEncode(s) {
  return escapeScan(s, true);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// Numeric value of one hex digit character, or -1 when the character
// is not a hex digit.
function hexDigitValue(c) {
  const cp = c.charCodeAt(0);
  if (inRange(cp, 0x30, 0x39)) return cp - 0x30;
  if (inRange(cp, 0x61, 0x66)) return cp - 0x61 + 10;
  if (inRange(cp, 0x41, 0x46)) return cp - 0x41 + 10;
  return -1;
}

// Turn an entity body (the part between &# and ;, with an optional
// leading x for hex) into a code point. -2 means malformed (empty, too
// long, or holding a non-digit character); -1 means well-formed but
// unusable (zero, a surrogate, or above U+10FFFF).
function entityCodePoint(body) {
  const hex = body[0] === 'x' || body[0] === 'X';
  const digits = hex ? body.slice(1) : body;
  if (digits.length === 0) return -2;
  const maxLen = hex ? 6 : 8;
  if (digits.length > maxLen) return -2;
  const base = hex ? 16 : 10;
  let cp = 0;
  for (let k = 0; k < digits.length; k++) {
    const d = hexDigitValue(digits[k]);
    if (d < 0 || d >= base) return -2;
    cp = cp * base + d;
  }
  if (cp === 0) return -1;
  if (cp > 0x10ffff) return -1;
  if (cp >= 0xd800 && cp <= 0xdfff) return -1;
  return cp;
}

// Try to match an entity reference at text[i] (which must be '&'). On
// success returns {len, out}: the consumed length and the replacement
// text, already escaped for text output. Named entities pass through
// untouched; numeric ones decode, and an unusable code point becomes
// U+FFFD. Returns null when no entity starts here.
function matchEntity(text, i) {
  const n = text.length;
  let j = i + 1;
  if (j < n && text[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (text[j] === 'x' || text[j] === 'X')) { hex = true; j++; }
    const digitsStart = j;
    while (j < n) {
      const c = text[j];
      const ok = hex ? isHexDigitChar(c) : isDigit(c);
      if (!ok) break;
      j++;
    }
    if (j === digitsStart) return null;
    if (j >= n || text[j] !== ';') return null;
    const digits = text.slice(digitsStart, j);
    const limit = hex ? 6 : 7;
    if (digits.length > limit) return null;
    const cp = entityCodePoint((hex ? 'x' : '') + digits);
    const decoded = cp === -1 ? '\uFFFD' : String.fromCodePoint(cp);
    return { len: j + 1 - i, out: escapeText(decoded) };
  }
  const nameStart = j;
  while (j < n && isWordChar(text[j])) j++;
  if (j === nameStart) return null;
  if (j >= n || text[j] !== ';') return null;
  return { len: j + 1 - i, out: text.slice(i, j + 1) };
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

// Resolve backslash escapes inside a link destination, title or label:
// a backslash before ASCII punctuation loses the backslash; every other
// backslash survives.
function resolveEscapes(s) {
  if (!s.includes('\\')) return s;
  const parts = [];
  let start = 0;
  let i = 0;
  while (i + 1 < s.length) {
    if (s[i] === '\\' && isAsciiPunct(s[i + 1])) {
      parts.push(s.slice(start, i), s[i + 1]);
      i += 2;
      start = i;
    } else {
      i++;
    }
  }
  if (parts.length === 0) return s;
  parts.push(s.slice(start));
  return parts.join('');
}

// Normalize a link reference label for matching: fold every whitespace
// run (spaces, tabs, newlines) into one space, trim both ends, and
// case-fold. Backslashes stay raw, so [foo\!] and [foo!] are different
// labels. Unicode folding: ß becomes 'ss' and final sigma ς becomes σ.
function normalizeLabel(raw) {
  const folded = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  const noSharpS = folded.replace(/\u00df/g, 'ss');
  return noSharpS.replace(/\u03c2/g, '\u03c3');
}

// ---------------------------------------------------------------------------
// Tabs, columns and lines
// ---------------------------------------------------------------------------

// Width in columns of a tab that starts at column `col`: tabs stop
// every 4 columns, so the width is the distance to the next stop.
function tabWidth(col) {
  return 4 - (col & 3);
}

// Measure a line's leading whitespace: [its width in columns, the index
// of the first character that is not a space or tab].
function leadingWs(line) {
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col += 1;
    else if (c === '\t') col += tabWidth(col);
    else break;
  }
  return [col, i];
}

// Expand the leading whitespace of a string into spaces, starting at
// column startCol: each tab becomes the spaces it would occupy, and the
// rest of the string comes back unchanged.
function expandLeadingWs(s, startCol) {
  let col = startCol;
  let i = 0;
  const spaces = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\t') {
      const w = tabWidth(col);
      spaces.push(' '.repeat(w));
      col += w;
      i++;
    } else if (c === ' ') {
      spaces.push(' ');
      col += 1;
      i++;
    } else break;
  }
  return spaces.join('') + s.slice(i);
}

// Slice a line from a target column. A tab straddling the boundary
// becomes spaces for the part past it. With expandTabs set, tabs in the
// leading whitespace after the cut expand to spaces using the original
// columns (container-prefix stripping); otherwise they stay verbatim
// (code content).
function sliceFromCol(line, targetCol, expandTabs) {
  let col = 0;
  let i = 0;
  let prefix = '';
  while (i < line.length && col < targetCol) {
    const c = line[i];
    if (c === '\t') {
      const w = tabWidth(col);
      if (col + w <= targetCol) {
        col += w;
        i++;
        continue;
      }
      prefix = ' '.repeat(col + w - targetCol);
      col += w;
      i++;
      break;
    }
    col++;
    i++;
  }
  const rest = line.slice(i);
  if (!expandTabs) return prefix + rest;
  return prefix + expandLeadingWs(rest, col);
}

// Is this string empty or whitespace-only (spaces/tabs)?
function isBlankStart(t) {
  for (let i = 0; i < t.length; i++) {
    const cp = t.charCodeAt(i);
    if (cp !== 0x20 && cp !== 0x09) return false;
  }
  return true;
}

// Split the source into lines. Each line is {t, nl}: t holds the content
// without its newline, nl records whether a newline followed it. A
// whitespace-only line counts as blank only when terminated — a final
// unterminated whitespace-only line is content (it joins a paragraph).
function splitLines(src) {
  const unified = src.replace(/\r\n?/g, '\n');
  if (unified === '') return [];
  const terminated = unified.endsWith('\n');
  const parts = unified.split('\n');
  if (terminated) parts.pop();
  const lastIdx = parts.length - 1;
  const lines = [];
  for (let i = 0; i < parts.length; i++) {
    lines.push({ t: parts[i], nl: i < lastIdx || terminated });
  }
  return lines;
}

// Blank for continuing or ending a block: an empty line, or a
// whitespace-only line that is terminated.
function isBlankLine(L) {
  if (L.t === '') return true;
  return L.nl && isBlankStart(L.t);
}

// ---------------------------------------------------------------------------
// Block-start matchers (each takes a raw line string)
// ---------------------------------------------------------------------------

// Skip up to 3 leading spaces and return the index after them. Returns
// -1 when the next character is a tab: a tab reaches column 4, so the
// line cannot open a block that allows at most 3 leading spaces.
function skipUpTo3Spaces(t) {
  let i = 0;
  while (i < 3 && i < t.length && t[i] === ' ') i++;
  if (i < t.length && t[i] === '\t') return -1;
  return i;
}

// Fenced code start. Returns {ch, len, indent, info} or null. A backtick
// fence whose info string holds a backtick is not a fence at all.
function matchFence(t) {
  const i = skipUpTo3Spaces(t);
  if (i === -1) return null;
  if (i >= t.length) return null;
  const ch = t[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i + 1;
  while (j < t.length && t[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = t.slice(j);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, indent: i, info };
}

// Is this line a closing fence for a fence of (ch, len)? Same character,
// a run at least len long, only spaces/tabs after it, 0-3 leading spaces.
function isClosingFence(t, ch, len) {
  const k = skipUpTo3Spaces(t);
  if (k === -1 || k >= t.length) return false;
  let r = k;
  while (r < t.length && t[r] === ch) r++;
  if (r - k < len) return false;
  for (let q = r; q < t.length; q++) {
    if (t[q] !== ' ' && t[q] !== '\t') return false;
  }
  return true;
}

// ATX heading. Returns {level, text} or null. The scan itself caps the
// level at 6; a '#' run must be followed by space/tab or end of line.
function matchATX(t) {
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length) return null;
  let openEnd = i;
  while (openEnd < t.length && t[openEnd] === '#' && openEnd - i < 6) openEnd++;
  const level = openEnd - i;
  if (level === 0) return null;
  if (openEnd < t.length && !isSpaceOrTab(t[openEnd])) return null;
  // Content: skip the whitespace, trim trailing whitespace, then strip
  // a closing run of '#'s when a space/tab precedes it. That preceding
  // space may be the gap between the opening hashes and the content
  // (so "# #" is an empty heading).
  let contentStart = openEnd;
  while (contentStart < t.length && isSpaceOrTab(t[contentStart])) contentStart++;
  let contentEnd = t.length;
  while (contentEnd > contentStart && isSpaceOrTab(t[contentEnd - 1])) contentEnd--;
  let hashStart = contentEnd;
  while (hashStart > contentStart && t[hashStart - 1] === '#') hashStart--;
  if (hashStart < contentEnd && hashStart > openEnd && isSpaceOrTab(t[hashStart - 1])) {
    contentEnd = hashStart;
    while (contentEnd > contentStart && isSpaceOrTab(t[contentEnd - 1])) contentEnd--;
  }
  return { level, text: t.slice(contentStart, contentEnd) };
}

// Thematic break: three or more of one marker (*, -, _) with nothing
// but spaces and tabs around them.
function matchHR(t) {
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length) return false;
  const ch = t[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let markers = 0;
  for (let j = i + 1; j < t.length; j++) {
    const c = t[j];
    if (c === ch) markers++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return markers + 1 >= 3;
}

// Setext underline: one or more '=' or '-' with only trailing
// spaces/tabs. Returns 1 for '=', 2 for '-', 0 otherwise. No internal
// spaces are allowed: '= =' and '--- -' are NOT setext underlines.
function matchSetext(t) {
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length) return 0;
  const ch = t[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i + 1;
  while (j < t.length && t[j] === ch) j++;
  while (j < t.length) {
    if (!isSpaceOrTab(t[j])) return 0;
    j++;
  }
  return ch === '=' ? 1 : 2;
}

// Scan up to 3 columns of leading spaces. Returns [col, i] (the column
// reached and the index after the spaces), or null when a tab appears
// first: a tab reaches column 4, so the line cannot open a block that
// allows at most 3 leading spaces. Shared by the blockquote and list
// matchers, which scan their indent the same way.
function scanIndent3(t) {
  let col = 0;
  let i = 0;
  while (i < t.length && col < 3) {
    const c = t[i];
    if (c === ' ') {
      col++;
      i++;
    } else if (c === '\t') {
      return null;
    } else {
      break;
    }
  }
  return [col, i];
}

// Blockquote prefix. Returns the rest of the line (leading tabs expanded
// using the original columns), or null when the line has no quote marker.
function matchBlockquote(t) {
  const scanned = scanIndent3(t);
  if (scanned === null) return null;
  let [col, i] = scanned;
  if (i >= t.length || t[i] !== '>') return null;
  i++;
  col++;
  // One optional space after '>'; a tab there counts as one column and
  // the rest of its width turns into spaces.
  let prefix = '';
  if (i < t.length) {
    const c = t[i];
    if (c === ' ') {
      i++;
      col++;
    } else if (c === '\t') {
      const w = tabWidth(col);
      prefix = ' '.repeat(w - 1);
      i++;
      col += w;
    }
  }
  return prefix + expandLeadingWs(t.slice(i), col);
}

// List marker. Returns null or:
// {ordered, delim, start, indent (leading-space columns),
//  contentIndent (column where the item content starts),
//  content (string after marker + whitespace, tabs expanded),
//  empty (no content on this line)}
function matchListMarker(t) {
  const scanned = scanIndent3(t);
  if (scanned === null) return null;
  const [indent, i] = scanned;
  if (i >= t.length) return null;
  let ordered = false;
  let delim = '';
  let start = 0;
  let mEnd;
  const c0 = t[i];
  if (c0 === '*' || c0 === '-' || c0 === '+') {
    delim = c0;
    mEnd = i + 1;
  } else if (isDigit(c0)) {
    let j = i;
    while (j < t.length && isDigit(t[j])) j++;
    if (j - i > 9) return null;
    if (j >= t.length || (t[j] !== '.' && t[j] !== ')')) return null;
    ordered = true;
    delim = t[j];
    start = Number(t.slice(i, j));
    mEnd = j + 1;
  } else {
    return null;
  }
  const markerCol = indent + (mEnd - i);
  // Whitespace after the marker, measured in columns.
  let wCol = markerCol;
  let wEnd = mEnd;
  while (wEnd < t.length && isSpaceOrTab(t[wEnd])) {
    if (t[wEnd] === '\t') wCol += tabWidth(wCol);
    else wCol++;
    wEnd++;
  }
  const wsWidth = wCol - markerCol;
  if (wEnd >= t.length) {
    // Empty item (or a blank first line): content indent is marker + 1.
    return {
      ordered, delim, start, indent,
      contentIndent: markerCol + 1,
      content: '', empty: true,
    };
  }
  if (wsWidth === 0) return null; // a marker needs whitespace after it
  if (wsWidth <= 4) {
    return {
      ordered, delim, start, indent,
      contentIndent: wCol, content: t.slice(wEnd), empty: false,
    };
  }
  // Five or more columns of whitespace: the content indent is marker + 1,
  // and the content is the line sliced from there with tabs expanded.
  return {
    ordered, delim, start, indent,
    contentIndent: markerCol + 1,
    content: sliceFromCol(t, markerCol + 1, true),
    empty: false,
  };
}

// ---------------------------------------------------------------------------
// HTML blocks (7 types)
// ---------------------------------------------------------------------------

// Tag names that can open a type-6 HTML block (CommonMark's list).
// One name per line, in alphabetical order.
const BLOCK_TAG_NAMES = [
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'meta',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
];
const BLOCK_TAGS = new Set(BLOCK_TAG_NAMES);

// Match an HTML block start. Returns {type, end}: type is 1-7 and end
// is the terminator string for types 1-5, or null when no HTML block
// starts here.
//   Type 1: <pre, <script, <style, <textarea open tag; ends at the
//     matching closing tag.
//   Type 2: <!-- ; ends at -->.
//   Type 3: <? ; ends at ?>.
//   Type 4: <! + letter; ends at >.
//   Type 5: <![CDATA[ ; ends at ]]>.
//   Type 6: a block tag open/close, enough on its own; ends at a blank.
//   Type 7: any other complete open/close tag alone on the line; ends
//     at a blank.
function matchHtmlBlock(t) {
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length || t[i] !== '<') return null;
  const rest = t.slice(i);
  // Type 2: comment.
  if (rest.startsWith('<!--')) return { type: 2, end: '-->' };
  // Type 3: processing instruction (the block form accepts <? with no ?>).
  if (rest.startsWith('<?')) return { type: 3, end: '?>' };
  // Type 5: CDATA (the block form accepts lowercase too).
  if (/^<!\[CDATA\[/i.test(rest)) return { type: 5, end: ']]>' };
  // Type 4: <! + letter (the block form accepts lowercase too).
  if (rest.length > 2 && rest[1] === '!' && isAlpha(rest[2])) {
    return { type: 4, end: '>' };
  }
  // Type 1: a pre/script/style/textarea open tag. End of line right
  // after the name counts: '<style' alone on a line opens a type-1 block.
  const type1 = /^<(pre|script|style|textarea)(\s|\/?>|$)/i.exec(rest);
  if (type1) return { type: 1, end: '</' + type1[1].toLowerCase() + '>' };
  const nameMatch = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  const tagName = nameMatch ? nameMatch[1].toLowerCase() : null;
  // Type 6: a block tag name followed by whitespace, end of line, '>',
  // or '/>'. What follows on the line is irrelevant ('<table><tr><td>'
  // and '<div id="foo"' both open type-6 blocks).
  if (tagName !== null && BLOCK_TAGS.has(tagName)) {
    const afterIdx = nameMatch[0].length;
    const after = rest[afterIdx];
    const okAfter = after === undefined || after === ' ' || after === '\t' ||
      after === '>' || (after === '/' && rest[afterIdx + 1] === '>');
    if (okAfter) return { type: 6, end: null };
  }
  // Type 7: a complete open or close tag alone on the line, with a tag
  // name that is NOT a block tag. Validated with the strict inline tag
  // matcher (attribute names/values must be well-formed: no attributes
  // on closing tags, whitespace required between attributes).
  const tagEnd = matchInlineTag(rest, 0);
  if (tagEnd !== -1 && tagName !== null && !BLOCK_TAGS.has(tagName)) {
    let after = i + tagEnd;
    while (after < t.length && isSpaceOrTab(t[after])) after++;
    if (after >= t.length) return { type: 7, end: null };
  }
  return null;
}

// Remove up to n columns of leading whitespace (spaces/tabs) from a
// line. A tab straddling the boundary turns into spaces for the part
// after it. Stops at the first non-whitespace character: content is
// never eaten.
function stripIndent(t, n, tabAsOne) {
  let col = 0;
  let i = 0;
  while (i < t.length && col < n) {
    const c = t[i];
    if (c === ' ') {
      col += 1;
      i += 1;
      continue;
    }
    if (c !== '\t') break;
    // Fences count each tab as one column (a marked quirk); elsewhere a
    // tab expands to its full width and may leave partial spaces.
    if (tabAsOne) {
      col += 1;
      i += 1;
      continue;
    }
    const w = tabWidth(col);
    if (col + w <= n) {
      col += w;
      i += 1;
      continue;
    }
    return ' '.repeat(col + w - n) + t.slice(i + 1);
  }
  return t.slice(i);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Split a table row line into cells: split on unescaped '|', trim
// spaces/tabs, and drop an empty edge cell when the line starts or ends
// with '|'.
function splitTableRow(line) {
  const n = line.length;
  let start = 0;
  let end = n;
  while (start < n && isSpaceOrTab(line[start])) start++;
  while (end > start && isSpaceOrTab(line[end - 1])) end--;
  const startsPipe = start < end && line[start] === '|';
  const endsPipe = end > start && line[end - 1] === '|';
  const cells = [];
  // Finish one cell: unescape \|, then trim spaces/tabs from both ends.
  function finishCell(from, to) {
    const raw = line.slice(from, to).replace(/\\\|/g, '|');
    cells.push(raw.replace(/^[ \t]+|[ \t]+$/g, ''));
  }
  let cellStart = start;
  let i = start;
  while (i < end) {
    const c = line[i];
    if (c === '\\' && i + 1 < end && line[i + 1] === '|') {
      i += 2; // escaped pipe: part of the cell, unescaped by finishCell
      continue;
    }
    if (c === '|') {
      finishCell(cellStart, i);
      i++;
      cellStart = i;
      continue;
    }
    i++;
  }
  finishCell(cellStart, end);
  if (startsPipe) cells.shift();
  if (endsPipe) cells.pop();
  return cells;
}

// Split a delimiter-row candidate on '|' and drop empty edge parts.
function splitDelimiterCells(rest) {
  const parts = rest.split('|');
  const firstEmpty = parts.length > 0 && parts[0].trim() === '';
  if (firstEmpty && rest.startsWith('|')) parts.shift();
  const lastEmpty = parts.length > 0 && parts[parts.length - 1].trim() === '';
  if (lastEmpty && rest.trimEnd().endsWith('|')) parts.pop();
  return parts;
}

// Alignment of one delimiter cell: ':--' left, '--:' right, ':-:' center,
// '---' none. Returns undefined when the cell is not a delimiter cell.
function delimiterCellAlign(cell) {
  const trimmed = cell.trim();
  if (!/^:?-+:?$/.test(trimmed)) return undefined;
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

// Match a table delimiter row. Returns the align array or null. Delimiter
// cells are :?-+:? separated by '|', with optional edge pipes; the row
// MUST contain a '|' and hold exactly headerCount cells. No tabs
// anywhere in the row — a tab inside a cell, between cells, or trailing
// kills it.
function matchTableDelimiter(t, headerCount) {
  if (t.includes('\t')) return null;
  if (!t.includes('|')) return null;
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length) return null;
  const parts = splitDelimiterCells(t.slice(i));
  if (parts.length !== headerCount) return null;
  const aligns = [];
  for (const p of parts) {
    const align = delimiterCellAlign(p);
    if (align === undefined) return null;
    aligns.push(align);
  }
  return aligns;
}

// Does this line look like a table delimiter row (ignoring cell count)?
// Used to flag lazy delimiter lines in blockquotes (they never form tables).
function looksLikeTableDelimiter(t) {
  if (t.includes('\t') || !t.includes('|')) return false;
  const i = skipUpTo3Spaces(t);
  if (i === -1 || i >= t.length) return false;
  const parts = splitDelimiterCells(t.slice(i));
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (delimiterCellAlign(p) === undefined) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Block consumers
// ---------------------------------------------------------------------------

// Language of a fenced code block: the first whitespace-delimited word
// of the info string, with backslash escapes resolved first
// (``` foo\+bar -> language-foo+bar).
function fenceLanguage(info) {
  const trimmed = info.replace(/^[ \t]+|[ \t]+$/g, '');
  if (trimmed === '') return '';
  let end = 0;
  while (end < trimmed.length && !isSpaceOrTab(trimmed[end])) end++;
  return resolveEscapes(trimmed.slice(0, end));
}

// Fenced code block starting at lines[i] (match m).
function consumeFence(lines, i, m) {
  const lang = fenceLanguage(m.info);
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const t = lines[j].t;
    if (isClosingFence(t, m.ch, m.len)) {
      j++;
      break;
    }
    // Marked quirk: only backtick fences strip the opening indent from
    // content lines; tilde fences keep content verbatim. Tabs count as
    // one column when stripping.
    content.push(m.ch === '`' ? stripIndent(t, m.indent, true) : t);
    j++;
  }
  // A trailing blank content line is dropped (exactly one).
  if (content.length > 0 && content[content.length - 1] === '') content.pop();
  const text = content.length === 0 ? '' : content.join('\n') + '\n';
  return { block: { t: 'fence', lang, text }, next: j };
}

// Find the last line index of an HTML block starting at lines[i]:
// types 1-5 run to the line holding the terminator (inclusive);
// types 6-7 run to the line before the next blank line.
function htmlBlockEnd(lines, i, m) {
  const n = lines.length;
  if (m.type <= 5) {
    const end = m.end.toLowerCase();
    let k = i;
    while (k < n && lines[k].t.toLowerCase().indexOf(end) === -1) k++;
    return k >= n ? n - 1 : k;
  }
  let k = i + 1;
  while (k < n && !isBlankLine(lines[k])) k++;
  return k - 1;
}

// HTML block starting at lines[i] (match m).
function consumeHtml(lines, i, m) {
  const n = lines.length;
  const k = htmlBlockEnd(lines, i, m);
  const parts = [];
  for (let q = i; q <= k; q++) parts.push(lines[q].t);
  let text = parts.join('\n');
  // Trailing newline rule:
  // - Types 1-5: include it iff the last line is terminated AND the next
  //   line is non-empty (or there is no next line).
  // - Types 6-7: include it iff the block runs to the end AND the last
  //   line is terminated.
  const lastNL = lines[k].nl;
  if (m.type <= 5) {
    if (lastNL && (k + 1 >= n || lines[k + 1].t !== '')) text += '\n';
  } else if (lastNL && k + 1 >= n) {
    text += '\n';
  }
  return { block: { t: 'html', text }, next: k + 1 };
}

// Indented code block starting at lines[i].
function consumeIndentedCode(lines, i) {
  const content = [];
  let pendingBlanks = [];
  let j = i;
  let next = i;
  // Move the pending blank lines into the content (they only join the
  // block when a non-blank line follows them).
  function flushBlanks() {
    for (const b of pendingBlanks) content.push(b);
    pendingBlanks = [];
  }
  while (j < lines.length) {
    const L = lines[j];
    if (isBlankLine(L)) {
      // A whitespace-only line contributes the part after 4 columns
      // (e.g. 6 spaces -> 2 spaces), not an empty line.
      pendingBlanks.push(sliceFromCol(L.t, 4, false));
      j++;
      continue;
    }
    const [w] = leadingWs(L.t);
    if (w < 4) break;
    flushBlanks();
    content.push(sliceFromCol(L.t, 4, false));
    next = j + 1;
    j++;
  }
  const text = content.length === 0 ? '' : content.join('\n') + '\n';
  return { block: { t: 'code', text }, next };
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Parse a title starting at text[i] (", ', or (). Returns {title, end}
// (end = the index after the closing delimiter) or null when the title
// is unclosed or invalid. isInline: inline-link paren titles allow '('
// inside; definition paren titles do not.
function parseTitle(text, i, isInline) {
  const n = text.length;
  const q = text[i];
  const closer = q === '(' ? ')' : q;
  const allowOpen = q !== '(' || isInline;
  const parts = [];
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      parts.push(text[j + 1]);
      j += 2;
      continue;
    }
    if (c === closer) return { title: parts.join(''), end: j + 1 };
    if (c === '(' && !allowOpen) return null;
    parts.push(c);
    j++;
  }
  return null;
}

// Scan a link-definition label starting just after '['. Escapes stay RAW
// in the label (for matching): an escaped \] does not end it, and an
// escaped \[ does not invalidate it. Returns {label, end} (end = the
// index after ']') or null.
function scanDefLabel(text, i) {
  const n = text.length;
  const parts = [];
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1])) {
      parts.push(text[i], text[i + 1]);
      i += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') return { label: parts.join(''), end: i + 1 };
    parts.push(c);
    i++;
  }
  return null;
}

// Skip the gap after ':' in a link definition: spaces, then optionally
// one newline plus spaces/tabs. Returns the index after the gap, or -1
// when a second newline follows.
function skipDefGap(text, i) {
  const n = text.length;
  while (i < n && text[i] === ' ') i++;
  if (i >= n || text[i] !== '\n') return i;
  i++;
  while (i < n && isSpaceOrTab(text[i])) i++;
  if (i < n && text[i] === '\n') return -1;
  return i;
}

// Scan an angle-form destination <...> starting at text[i] ('<'): no
// newlines, no '<' inside, escapes resolved. Returns {dest, end} or null.
function scanAngleDest(text, i) {
  const n = text.length;
  const parts = [];
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === '\n' || c === '<') return null;
    if (c === '>') return { dest: parts.join(''), end: j + 1 };
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      parts.push(text[j + 1]);
      j += 2;
    } else {
      parts.push(c);
      j++;
    }
  }
  return null;
}

// Scan a bare-form destination starting at text[i]: balanced parens, no
// spaces or control characters, escapes resolved. Returns {dest, end} or
// null. An empty destination is invalid unless allowEmpty is set
// (inline links allow [a]()).
function scanBareDest(text, i, allowEmpty) {
  const n = text.length;
  const parts = [];
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      parts.push(text[j + 1]);
      j += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      parts.push(c);
      j++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      parts.push(c);
      j++;
      continue;
    }
    const code = c.charCodeAt(0);
    if (c === ' ' || c === '\t' || c === '\n' || code < 0x20) break;
    parts.push(c);
    j++;
  }
  const dest = parts.join('');
  if ((dest === '' && !allowEmpty) || depth !== 0) return null;
  return { dest, end: j };
}

// Scan a link destination starting at text[i]: angle form <...> or bare
// form. Returns {dest, end} or null.
function scanLinkDest(text, i, allowEmpty) {
  if (text[i] === '<') return scanAngleDest(text, i);
  return scanBareDest(text, i, allowEmpty);
}

// Is this character a title opener (double quote, single quote, or paren)?
function isTitleOpener(c) {
  return c === '"' || c === "'" || c === '(';
}

// Parse a definition title at text[q], which must hold ", ' or (.
// Returns {title, end} (end = the index after the title plus its trailing
// spaces/tabs), or null when the title is unclosed or junk follows it.
function parseDefTitleAt(text, q) {
  const tr = parseTitle(text, q, false);
  if (!tr) return null;
  const n = text.length;
  let r = tr.end;
  while (r < n && isSpaceOrTab(text[r])) r++;
  if (r < n && text[r] !== '\n') return null;
  return { title: tr.title, end: r };
}

// Parse a link reference definition from the start of text (joined
// paragraph text). Returns {consumed, label, href, title} or null.
// consumed covers the definition plus its trailing newline when present.
function parseLinkDef(text) {
  const n = text.length;
  let i = 0;
  let sp = 0;
  while (i < n && text[i] === ' ' && sp < 3) { i++; sp++; }
  if (i >= n || text[i] !== '[') return null;
  const lab = scanDefLabel(text, i + 1);
  if (!lab) return null;
  const normLabel = normalizeLabel(lab.label);
  if (normLabel === '') return null;
  i = lab.end;
  if (i >= n || text[i] !== ':') return null;
  i = skipDefGap(text, i + 1);
  if (i === -1 || i >= n) return null;
  const d = scanLinkDest(text, i);
  if (!d) return null;
  const dest = d.dest;
  i = d.end;
  // Optional title: same line (after spaces) or next line (after a
  // newline). A same-line title needs at least one space before it, and
  // a failed same-line title kills the whole definition. A failed
  // next-line title leaves the definition valid without the title.
  let p = i;
  let gapSpaces = 0;
  while (p < n && text[p] === ' ') { p++; gapSpaces++; }
  if (p < n && text[p] === '\n') {
    const consumedNoTitle = p + 1;
    let q = p + 1;
    while (q < n && isSpaceOrTab(text[q])) q++;
    if (q < n && text[q] !== '\n' && isTitleOpener(text[q])) {
      const titled = parseDefTitleAt(text, q);
      if (titled) {
        const r = titled.end;
        return {
          consumed: r < n ? r + 1 : r,
          label: normLabel, href: dest, title: titled.title,
        };
      }
      // Next-line title invalid: the definition survives without it.
    }
    return {
      consumed: consumedNoTitle,
      label: normLabel, href: dest, title: null,
    };
  }
  if (gapSpaces > 0 && p < n && isTitleOpener(text[p])) {
    const titled = parseDefTitleAt(text, p);
    if (!titled) return null;
    const r = titled.end;
    return {
      consumed: r < n ? r + 1 : r,
      label: normLabel, href: dest, title: titled.title,
    };
  }
  if (p < n && text[p] !== '\n') return null;
  return {
    consumed: p < n ? p + 1 : p,
    label: normLabel, href: dest, title: null,
  };
}

// ---------------------------------------------------------------------------
// Paragraphs, setext headings, tables
// ---------------------------------------------------------------------------

// Does this list marker interrupt the current context? An unordered marker
// always does; an ordered one only when it starts at 1 — unless we are
// inside a list item, where any ordered marker interrupts.
function listMarkerInterrupts(lm, inListItem) {
  return !lm.ordered || lm.start === 1 || inListItem;
}

// Can this line start a block that interrupts a paragraph?
function interruptsParagraph(t, inListItem) {
  if (matchFence(t) || matchATX(t) || matchHR(t)) return true;
  if (matchBlockquote(t) !== null) return true;
  const hm = matchHtmlBlock(t);
  if (hm && hm.type <= 6) return true;
  const lm = matchListMarker(t);
  // An empty list item (marker with no content) cannot interrupt a paragraph.
  if (lm && !lm.empty && listMarkerInterrupts(lm, inListItem)) return true;
  return false;
}

// Can this line be a table body row (i.e. does it NOT start a new block)?
// Body rows end at: blank lines, blockquote, ATX, fence, HTML block, hr,
// interrupting lists, and indented code.
function isTableBodyRow(t) {
  if (matchBlockquote(t) !== null) return false;
  if (matchATX(t) || matchFence(t) || matchHR(t)) return false;
  if (matchHtmlBlock(t)) return false;
  const lm = matchListMarker(t);
  if (lm && listMarkerInterrupts(lm, false)) return false;
  const [w] = leadingWs(t);
  if (w >= 4) return false;
  return true;
}

// Extract leading link reference definitions from paragraph text,
// recording them in refs (first definition wins). Returns the text
// that remains after the definitions.
function extractLinkDefs(text, refs) {
  for (;;) {
    const d = parseLinkDef(text);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    text = text.slice(d.consumed);
  }
  return text;
}

// Collect table body rows starting at lines[k]. Returns {body, next}.
function collectTableBody(lines, k, header) {
  const body = [];
  while (k < lines.length) {
    const L = lines[k];
    // Marked quirk: a terminated line of 0-3 spaces + a single tab is a
    // body row (empty cells), not a blank line ending the table.
    const tabRow = L.nl && /^ {0,3}\t$/.test(L.t);
    if (!tabRow) {
      if (isBlankLine(L)) break;
      if (!isTableBodyRow(L.t)) break;
    }
    const cells = splitTableRow(L.t);
    while (cells.length < header.length) cells.push('');
    body.push(cells.slice(0, header.length));
    k++;
  }
  return { body, next: k };
}

// Consume a paragraph starting at lines[i]. Handles setext headings, table
// formation, and leading link reference definitions. Returns {blocks, next}.
function consumeParagraph(lines, i, refs, inListItem) {
  const paraLines = [lines[i].t];
  let j = i + 1;
  let endKind = 'blank';
  let setextLevel = 0;
  let tableAlign = null;
  // Whether the previous continuation line was stripped (4+ leading
  // columns removed by the list-item rule below).
  let prevStripped = false;
  while (j < lines.length) {
    const L = lines[j];
    const t = L.t;
    if (isBlankLine(L)) {
      endKind = 'blank';
      break;
    }
    // Lazy lines never interrupt a paragraph or form setext/table.
    if (L.lazy) {
      paraLines.push(t);
      prevStripped = false;
      j++;
      continue;
    }
    const headerCells = splitTableRow(paraLines[paraLines.length - 1]);
    // A lazy delimiter line in a blockquote never forms a table, and a
    // lazy setext-like line never becomes a setext underline.
    const aligns = L.noTable ? null : matchTableDelimiter(t, headerCells.length);
    if (aligns) {
      endKind = 'table';
      tableAlign = aligns;
      break;
    }
    const sx = L.noSetext ? 0 : matchSetext(t);
    if (sx) {
      endKind = 'setext';
      setextLevel = sx;
      break;
    }
    if (interruptsParagraph(t, inListItem)) {
      endKind = 'interrupt';
      break;
    }
    // Marked quirk: inside a list item, a paragraph continuation line
    // with 4+ columns of leading whitespace loses 4 columns (top-level
    // paragraphs keep their leading whitespace as-is). A non-stripped
    // continuation line following a stripped one is preceded by a
    // blank line inside the paragraph.
    if (inListItem) {
      const [w] = leadingWs(t);
      if (w >= 4) {
        paraLines.push(stripIndent(t, 4));
        prevStripped = true;
        j++;
        continue;
      }
      if (prevStripped) paraLines.push('');
    }
    prevStripped = false;
    paraLines.push(t);
    j++;
  }
  const text = extractLinkDefs(paraLines.join('\n'), refs);
  const blocks = [];
  if (text === '') {
    // Only definitions: no paragraph. A setext/table line after definitions
    // is not consumed (it starts a new block).
    return { blocks, next: j };
  }
  const restLines = text.split('\n');
  if (endKind === 'setext') {
    // Setext heading text is trimmed (leading/trailing spaces/tabs).
    const trimmed = text.replace(/^[ \t]+|[ \t]+$/g, '');
    blocks.push({ t: 'h', level: setextLevel, text: trimmed });
    return { blocks, next: j + 1 };
  }
  if (endKind === 'table') {
    const headerLine = restLines[restLines.length - 1];
    const header = splitTableRow(headerLine);
    if (restLines.length > 1) {
      blocks.push({ t: 'p', text: restLines.slice(0, -1).join('\n') });
    }
    const tb = collectTableBody(lines, j + 1, header);
    blocks.push({ t: 'table', align: tableAlign, head: header, body: tb.body });
    return { blocks, next: tb.next };
  }
  blocks.push({ t: 'p', text });
  return { blocks, next: j };
}

// ---------------------------------------------------------------------------
// Lazy continuation lines
// ---------------------------------------------------------------------------

// Can this line be a lazy paragraph continuation? It must not start a block
// (ATX, fence, HTML, hr, blockquote, any list marker). Indented-code-looking
// lines and '=' setext lines ARE lazy-able; '-' setext lines are caught by
// the hr/list checks ('--' alone is lazy-able).
function isLazyAble(t) {
  return !matchATX(t) && !matchFence(t) && !matchHR(t) &&
    matchBlockquote(t) === null && !matchHtmlBlock(t) &&
    !matchListMarker(t);
}

// Blockquote lazy-line stripping: strip 4 columns when the leading
// whitespace is 4+ columns, else keep the line unchanged.
function lazyStripQuote(t) {
  const [w] = leadingWs(t);
  if (w < 4) return t;
  return sliceFromCol(t, 4, false);
}

// The last leaf block under b (b itself unless it is a quote or list).
function lastLeafOf(b) {
  if (b.t === 'quote') {
    if (b.children.length === 0) return null;
    return lastLeafOf(b.children[b.children.length - 1]);
  }
  if (b.t === 'list') {
    if (b.items.length === 0) return null;
    const it = b.items[b.items.length - 1];
    if (it.children.length === 0) return null;
    return lastLeafOf(it.children[it.children.length - 1]);
  }
  return b;
}

// Find the last leaf block in a parsed block list (descending into the last
// child of quotes and lists).
function lastLeaf(blocks) {
  if (blocks.length === 0) return null;
  return lastLeafOf(blocks[blocks.length - 1]);
}

// Does the parsed content end with an open paragraph? lastLineBlank says
// whether the last collected line was blank (which closes a paragraph).
function endsWithOpenParagraph(blocks, lastLineBlank) {
  if (lastLineBlank) return false;
  const leaf = lastLeaf(blocks);
  return leaf !== null && leaf.t === 'p';
}

// ---------------------------------------------------------------------------
// Blockquotes and lists
// ---------------------------------------------------------------------------

// How a lazy setext-like line is transformed inside a blockquote:
// after a '>' line it is kept as-is; after an unstripped lazy line it
// is padded to 4 columns; after a stripped lazy line it is stripped
// by 4. Returns {text, stripped}.
function lazySetextLine(t, prevLazy, prevStripped) {
  if (!prevLazy) return { text: t, stripped: false };
  if (!prevStripped) {
    const [w] = leadingWs(t);
    return { text: ' '.repeat(Math.max(0, 4 - w)) + t, stripped: false };
  }
  return { text: stripIndent(t, 4), stripped: true };
}

// Consume a blockquote starting at lines[i].
function consumeQuote(lines, i, refs) {
  const inner = [];
  let j = i;
  let needCheck = true;
  let paraOpen = false;
  let prevLazy = false;
  let prevStripped = false;
  // A blank line after a stripped lazy line lands INSIDE the open paragraph
  // (as a trailing newline on the last inner line).
  function insertBlank() {
    if (inner.length > 0) {
      const last = inner[inner.length - 1];
      if (!isBlankLine(last)) last.t += '\n';
    }
  }
  while (j < lines.length) {
    const L = lines[j];
    const q = matchBlockquote(L.t);
    if (q !== null) {
      if (prevLazy && prevStripped) insertBlank();
      inner.push({ t: q, nl: L.nl });
      j++;
      needCheck = true;
      prevLazy = false;
      prevStripped = false;
      continue;
    }
    if (isBlankLine(L)) break;
    if (!isLazyAble(L.t)) break;
    if (needCheck) {
      const blocks = parseBlocks(inner, new Map());
      const lastBlank = inner.length > 0 && isBlankLine(inner[inner.length - 1]);
      paraOpen = endsWithOpenParagraph(blocks, lastBlank);
      needCheck = false;
      if (!paraOpen) break;
    }
    const t = L.t;
    const [w] = leadingWs(t);
    if (matchSetext(t)) {
      // A lazy setext-like line never becomes a setext underline.
      const sl = lazySetextLine(t, prevLazy, prevStripped);
      inner.push({ t: sl.text, nl: L.nl, noSetext: true, lazy: true });
      prevLazy = true;
      prevStripped = sl.stripped;
    } else if (prevLazy && prevStripped && w < 4) {
      // A short lazy line after a stripped one: blank line first, kept as-is.
      insertBlank();
      inner.push({ t, nl: L.nl, noTable: looksLikeTableDelimiter(t), lazy: true });
      prevLazy = true;
      prevStripped = false;
    } else if (w >= 4) {
      inner.push({ t: lazyStripQuote(t), nl: L.nl, noTable: looksLikeTableDelimiter(t), lazy: true });
      prevLazy = true;
      prevStripped = true;
    } else {
      inner.push({ t, nl: L.nl, noTable: looksLikeTableDelimiter(t), lazy: true });
      prevLazy = true;
      prevStripped = false;
    }
    j++;
  }
  if (inner.length > 0) inner[inner.length - 1].nl = false;
  const children = parseBlocks(inner, refs);
  return { block: { t: 'quote', children }, next: j };
}

// Do the collected item lines contain any non-blank line yet?
function itemLinesHaveContent(itemLines) {
  return itemLines.some((il) => !isBlankLine(il));
}

// While a fence is open with content, an under-indented line is fence
// content — EXCEPT when the previous item line could start a leaf block:
// 4+ columns of leading whitespace (indented code), an ATX heading, an
// HR, or an HTML block. (List/blockquote markers do not break it.)
function fenceCaptureBlocked(prev) {
  if (!prev) return false;
  const pt = prev.t;
  const [pw] = leadingWs(pt);
  if (pw >= 4) return true;
  const ps = pt.slice(pw);
  if (/^#{1,6}(?:[ \t]|$)/.test(ps)) return true;
  if (/^(-{3,}|_{3,}|\*{3,})[ \t]*$/.test(ps)) return true;
  if (/^(`{3,}|~{3,})/.test(ps)) return true;
  if (matchHtmlBlock(pt) !== null) return true;
  return false;
}

// Task list: if the first child is a paragraph starting with [x]/[ ]/[X]
// + space/tab + content, strip the marker and return the task state.
function extractTask(children) {
  if (children.length === 0 || children[0].t !== 'p') return null;
  const tm = /^\[([ xX])\][ \t]+(\S[\s\S]*)$/.exec(children[0].text);
  if (!tm) return null;
  children[0].text = tm[2];
  return tm[1] === ' ' ? 'unchecked' : 'checked';
}

// Collect one list item starting at lines[j] (marker m). Returns
// {item, next, loose}.
function collectItem(lines, j, m, refs) {
  const contentIndent = m.contentIndent;
  const itemLines = [{ t: m.content, nl: lines[j].nl }];
  // Fence state within the item: while a fence is open AND already has
  // at least one content line, under-indented non-fence lines are fence
  // content (they stay in the item). If the first line after the fence
  // open is under-indented, the item ends and the fence is empty.
  let fenceCh = null;
  let fenceLen = 0;
  let fenceHasContent = false;
  const fm0 = matchFence(m.content);
  if (fm0) {
    fenceCh = fm0.ch;
    fenceLen = fm0.len;
  }
  function trackFence(stripped) {
    if (fenceCh === null) {
      const fm = matchFence(stripped);
      if (fm) {
        fenceCh = fm.ch;
        fenceLen = fm.len;
        fenceHasContent = false;
      }
    } else if (isClosingFence(stripped, fenceCh, fenceLen)) {
      fenceCh = null;
      fenceLen = 0;
      fenceHasContent = false;
    }
  }
  let k = j + 1;
  let needCheck = false;
  let paraOpen = false;
  while (k < lines.length) {
    const L = lines[k];
    const t = L.t;
    if (isBlankLine(L)) {
      // A blank line uses the normal logic even inside a fence: the item
      // ends here unless the next non-blank line is indented to the
      // content indent (a blank line breaks fence-content capture).
      // An item with no content yet ends at a blank line (it stays empty).
      if (!itemLinesHaveContent(itemLines)) break;
      let m2 = k + 1;
      while (m2 < lines.length && isBlankLine(lines[m2])) m2++;
      if (m2 >= lines.length) break;
      const [w2] = leadingWs(lines[m2].t);
      if (w2 >= contentIndent && !isBlankStart(lines[m2].t)) {
        for (let q = k; q < m2; q++) itemLines.push({ t: '', nl: lines[q].nl });
        k = m2;
        needCheck = true;
        continue;
      }
      break;
    }
    const [w] = leadingWs(t);
    if (w >= contentIndent && !isBlankStart(t)) {
      const stripped = sliceFromCol(t, contentIndent, true);
      const fenceWasOpen = fenceCh !== null;
      itemLines.push({ t: stripped, nl: L.nl });
      trackFence(stripped);
      if (fenceWasOpen && fenceCh !== null) fenceHasContent = true;
      k++;
      needCheck = true;
      continue;
    }
    // While a fence is open with content, an under-indented line that is
    // not itself a fence line is fence content (kept as-is). A fence line
    // ends the item. (See fenceCaptureBlocked for the leaf-block exception.)
    if (fenceCh !== null && fenceHasContent && matchFence(t) === null) {
      const prev = itemLines[itemLines.length - 1];
      if (!fenceCaptureBlocked(prev)) {
        itemLines.push({ t, nl: L.nl });
        k++;
        needCheck = true;
        continue;
      }
    }
    if (matchListMarker(t)) break;
    if (!isLazyAble(t)) break;
    if (needCheck) {
      const blocks = parseBlocks(itemLines, new Map(), true);
      const lastBlank = itemLines.length > 0 && isBlankLine(itemLines[itemLines.length - 1]);
      paraOpen = endsWithOpenParagraph(blocks, lastBlank);
      needCheck = false;
      if (!paraOpen) break;
    }
    // Lazy line: strip 4 columns when the leading width reaches 4
    // (like a quote's lazy line), else keep as-is. A lazy setext-like
    // line never becomes a setext underline.
    const strippedLazy = lazyStripQuote(t);
    itemLines.push({ t: strippedLazy, nl: L.nl, noSetext: matchSetext(strippedLazy) !== 0, lazy: true });
    k++;
  }
  if (itemLines.length > 0) itemLines[itemLines.length - 1].nl = false;
  const children = parseBlocks(itemLines, refs, true);
  // Item looseness: a blank line DIRECTLY between two top-level children
  // (blank lines inside a nested block do not count).
  const itemLoose = children.hasBlankBetween === true;
  const task = extractTask(children);
  return {
    item: { t: 'item', children, task, contentIndent },
    next: k,
    loose: itemLoose,
  };
}

// Does this marker belong to the list (same kind/delimiter, indent below
// the previous item's content indent)? Items need not share one indent.
function markerBelongsToList(m, ordered, delim, prevContentIndent) {
  return m !== null && m.indent < prevContentIndent &&
    m.ordered === ordered && m.delim === delim;
}

// Consume a list starting at lines[i] (first marker already matched).
function consumeList(lines, i, refs) {
  const first = matchListMarker(lines[i].t);
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
    if (isBlankLine(L)) {
      let k = j + 1;
      while (k < lines.length && isBlankLine(lines[k])) k++;
      if (k >= lines.length) break;
      const nm = matchListMarker(lines[k].t);
      if (nm && !matchHR(lines[k].t) &&
          markerBelongsToList(nm, ordered, delim, prevContentIndent)) {
        loose = true;
        j = k;
        continue;
      }
      break;
    }
    // A line that is a thematic break ('* * *', '- - -') ends the list; it
    // is an <hr>, never a new item.
    if (matchHR(L.t)) break;
    const m = matchListMarker(L.t);
    if (markerBelongsToList(m, ordered, delim, prevContentIndent)) {
      const res = collectItem(lines, j, m, refs);
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

function parseBlocks(lines, refs, inListItem) {
  const blocks = [];
  blocks.hasBlankBetween = false;
  let i = 0;
  const n = lines.length;
  let blankSinceLastBlock = false;
  function pushBlock(b) {
    if (blankSinceLastBlock) blocks.hasBlankBetween = true;
    blankSinceLastBlock = false;
    blocks.push(b);
  }
  // Consume a paragraph at lines[at] and push its blocks, tracking the
  // blank-between state for looseness. Returns the next line index.
  function consumeParaAt(at) {
    const r = consumeParagraph(lines, at, refs, inListItem);
    for (const b of r.blocks) pushBlock(b);
    if (r.blocks.length === 0 && blankSinceLastBlock) {
      blocks.hasBlankBetween = true;
      blankSinceLastBlock = false;
    }
    return r.next;
  }
  while (i < n) {
    const L = lines[i];
    if (isBlankLine(L) || isBlankStart(L.t)) {
      if (blocks.length > 0) blankSinceLastBlock = true;
      i++;
      continue;
    }
    const t = L.t;
    // A lazy continuation line is paragraph text, never a new block
    // (even if stripping made it look like a list marker or heading).
    if (L.lazy) {
      i = consumeParaAt(i);
      continue;
    }
    let m = matchFence(t);
    if (m) {
      const r = consumeFence(lines, i, m);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    m = matchATX(t);
    if (m) {
      pushBlock({ t: 'h', level: m.level, text: m.text });
      i++;
      continue;
    }
    m = matchHtmlBlock(t);
    if (m) {
      const r = consumeHtml(lines, i, m);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    if (matchHR(t)) {
      pushBlock({ t: 'hr' });
      i++;
      continue;
    }
    if (matchBlockquote(t) !== null) {
      const r = consumeQuote(lines, i, refs);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    m = matchListMarker(t);
    if (m) {
      const r = consumeList(lines, i, refs);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    const [w] = leadingWs(t);
    if (w >= 4) {
      const r = consumeIndentedCode(lines, i);
      pushBlock(r.block);
      i = r.next;
      continue;
    }
    i = consumeParaAt(i);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline HTML and autolinks
// ---------------------------------------------------------------------------

// Skip tag whitespace (space, tab, newline) from j; return the new index.
function skipTagWs(text, j) {
  const n = text.length;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  return j;
}

// Scan one attribute starting at text[j] (first char of the name).
// Returns the index just past the attribute (or past the name for a
// boolean attribute), or -1 when the attribute is malformed.
function scanTagAttribute(text, j) {
  const n = text.length;
  if (!isAlpha(text[j]) && text[j] !== '_' && text[j] !== ':') return -1;
  j++;
  while (j < n) {
    const c = text[j];
    if (isAlpha(c) || isDigit(c) || c === '_' || c === '.' || c === ':' || c === '-') j++;
    else break;
  }
  const afterName = j;
  j = skipTagWs(text, j);
  if (j < n && text[j] === '=') {
    j++;
    j = skipTagWs(text, j);
    if (j >= n) return -1;
    const q = text[j];
    if (q === '"' || q === "'") {
      j++;
      while (j < n && text[j] !== q) j++;
      if (j >= n) return -1;
      return j + 1;
    }
    const vs = j;
    while (j < n) {
      const c = text[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '>' || c === '"' ||
          c === "'" || c === '=' || c === '<' || c === '`') break;
      j++;
    }
    if (j === vs) return -1;
    return j;
  }
  // Boolean attribute (no '='): the whitespace after the name stays for
  // the next iteration's separator check.
  return afterName;
}

// Match an inline HTML tag starting at text[i] ('<'). Returns the index just
// past the tag, or -1. Covers open/close tags (attributes need preceding
// whitespace; closing tags take no attributes).
function matchInlineTag(text, i) {
  const n = text.length;
  let j = i + 1;
  let closing = false;
  if (j < n && text[j] === '/') {
    closing = true;
    j++;
  }
  if (j >= n || !isAlpha(text[j])) return -1;
  j++;
  while (j < n && (isAlpha(text[j]) || isDigit(text[j]) || text[j] === '-')) j++;
  for (;;) {
    const wsEnd = skipTagWs(text, j);
    const hadWs = wsEnd > j;
    j = wsEnd;
    if (j >= n) return -1;
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && !closing && j + 1 < n && text[j + 1] === '>') return j + 2;
    if (closing || !hadWs) return -1;
    j = scanTagAttribute(text, j);
    if (j === -1) return -1;
  }
}

// Find `needle` in text from `from`; return the index just past it, or -1.
function findTerminator(text, needle, from) {
  const e = text.indexOf(needle, from);
  return e === -1 ? -1 : e + needle.length;
}

// Match inline raw HTML starting at text[i] ('<'): comment, PI, declaration,
// CDATA, or tag. Returns the index just past it, or -1.
function matchInlineHtml(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return i + 5;
    if (text.startsWith('<!--->', i)) return i + 6;
    return findTerminator(text, '-->', i + 4);
  }
  if (text.startsWith('<?', i)) {
    return findTerminator(text, '?>', i + 2);
  }
  if (text.startsWith('<![CDATA[', i)) {
    return findTerminator(text, ']]>', i + 9);
  }
  if (i + 2 < n && text[i + 1] === '!') {
    // Declaration: <! + letters + whitespace + ... + '>'.
    let j = i + 2;
    const ls = j;
    while (j < n && isAlpha(text[j])) j++;
    if (j === ls) return -1;
    if (j >= n || (!isSpaceOrTab(text[j]) && text[j] !== '\n')) return -1;
    return findTerminator(text, '>', j);
  }
  return matchInlineTag(text, i);
}

// Marked quirk: an inline <a> open tag sets a document-global "in link"
// state that suppresses extended autolinks (www/http/email) in the rest
// of the document until a </a> close tag clears it. The state persists
// across blocks (paragraphs, headings, lists, blockquotes). The trigger
// is narrow: the open tag must be "<a" + a literal SPACE (a tab, newline,
// '>' or '/' after the name does not set it; bare <a> and <a/> do not set
// it), and only the exact 4-char tag "</a>" (any case) clears it —
// "</a >", "</a\t>" and "</a\n>" do not. Tags inside HTML blocks, code
// spans, or link text do not affect the state (a link's text is parsed
// in an isolated scope that restores the state when the link forms).
let inLinkGlobal = false;
// How many markdown links formed during the current parse() call. Used
// to detect a link formed inside a strikethrough's recursive parse: a
// bracket enclosing such a strikethrough can never form a link itself.
let linksFormed = 0;
// Extended autolinks (http/https/ftp/www) created during the current
// parse() call, as {html, text} pairs. Used to revert autolinks formed
// inside a strikethrough's recursive parse when the del ends up inside
// a link (an https autolink's HTML is identical to an angle autolink's,
// so only creation-time tracking can distinguish them).
let extAutolinks = [];

// Scan an email local part (the part before '@') starting at s:
// [A-Za-z0-9._+-]+. Returns the end index.
function scanEmailLocal(text, s) {
  const n = text.length;
  let j = s;
  while (j < n) {
    const c = text[j];
    if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  return j;
}

// Validate an email domain (the part after '@'): labels of [A-Za-z0-9_-]+
// separated by single dots, at least two labels. Returns the end index of
// the domain within text starting at dStart, or -1. Trailing dots are
// trimmed; a domain ending in '-' rejects the whole match. A domain ending
// in '_' also rejects, UNLESS trimTrailingUnderscore is set (an unmatched
// '_' opener exists earlier, so the trailing '_'s are emphasis delimiters,
// not part of the domain) — then they are trimmed instead.
function matchEmailDomain(text, dStart, trimTrailingUnderscore) {
  const n = text.length;
  let j = dStart;
  while (j < n) {
    const c = text[j];
    if (isAlpha(c) || isDigit(c) || c === '_' || c === '-' || c === '.') j++;
    else break;
  }
  let end = j;
  // Trim trailing dots, and (when trimTrailingUnderscore is set) trailing
  // underscores; repeat, because trimming '_' can expose more '.'s.
  for (;;) {
    while (end > dStart && text[end - 1] === '.') end--;
    if (!trimTrailingUnderscore) break;
    let trimmed = false;
    while (end > dStart && text[end - 1] === '_') {
      end--;
      trimmed = true;
    }
    if (!trimmed) break;
  }
  if (end === dStart) return -1;
  const last = text[end - 1];
  if (last === '_' || last === '-') return -1;
  const domain = text.slice(dStart, end);
  const labels = domain.split('.');
  if (labels.length < 2) return -1;
  for (const lab of labels) {
    if (lab === '') return -1;
  }
  return end;
}

// Match a bare email with '@' at atPos. Returns {start, end} or null.
function matchEmail(text, atPos, minStart, trimTrailingUnderscore) {
  // The local part must not scan before minStart (the current text run
  // start): a '_' emphasis delimiter before it is not part of the email.
  const lo = minStart === undefined ? 0 : minStart;
  let s = atPos - 1;
  while (s >= lo) {
    const c = text[s];
    if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') s--;
    else break;
  }
  const start = s + 1;
  if (start === atPos) return null;
  const end = matchEmailDomain(text, atPos + 1, trimTrailingUnderscore);
  if (end === -1) return null;
  return { start, end };
}

// Match an angle autolink <...> starting at text[i]. Returns
// {href, text, end} or null.
function matchAngleAutolink(text, i) {
  const n = text.length;
  // Scheme: letter, then [A-Za-z0-9+.-]*, length 2-32, then ':'.
  let j = i + 1;
  if (j < n && isAlpha(text[j])) {
    let k = j + 1;
    while (k < n) {
      const c = text[k];
      if (isAlpha(c) || isDigit(c) || c === '+' || c === '.' || c === '-') k++;
      else break;
    }
    const schemeLen = k - j;
    if (schemeLen >= 2 && schemeLen <= 32 && k < n && text[k] === ':') {
      let e = k + 1;
      const rs = e;
      while (e < n) {
        const c = text[e];
        if (c === ' ' || c === '\t' || c === '\n' || c === '<' || c === '>' ||
            c.charCodeAt(0) < 0x20) break;
        e++;
      }
      if (e > rs && e < n && text[e] === '>') {
        const url = text.slice(i + 1, e);
        return { href: url, text: url, end: e + 1 };
      }
    }
  }
  // Email in angles.
  return matchEmailAt(text, i + 1);
}

// Match <email> starting right after '<' (at position s). Returns the
// autolink or null.
function matchEmailAt(text, s) {
  const n = text.length;
  const j = scanEmailLocal(text, s);
  if (j === s || j >= n || text[j] !== '@') return null;
  const end = matchEmailDomain(text, j + 1);
  if (end === -1 || end >= n || text[end] !== '>') return null;
  const email = text.slice(s, end);
  return { href: 'mailto:' + email, text: email, end: end + 1 };
}

// If s ends with a named entity &\w+;, return the index of its '&'.
// Otherwise -1.
function trailingEntityAmp(s) {
  if (!s.endsWith(';')) return -1;
  let k = s.length - 2;
  while (k >= 0 && isWordChar(s[k])) k--;
  if (k >= 0 && s[k] === '&' && k < s.length - 2) return k;
  return -1;
}

// Trim an extended-autolink candidate per marked's rules: paren groups,
// trailing named entities, trailing punctuation, unmatched trailing ')'.
function trimUrlCandidate(cand) {
  // Paren groups: '(' opens a group ending at the next ')' (no nesting).
  // A '(' with no later ')' cuts the URL there.
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
  let s = cand.slice(0, cut);
  // Trailing trims, looped until stable.
  for (;;) {
    if (s === '') break;
    const amp = trailingEntityAmp(s);
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

const WWW_PRECEDING_OK = new Set([' ', '\t', '\n', '(', '*', '_', '~']);

// Scan an email right after a scheme prefix ending at s (e.g. after
// 'mailto:' or 'xmpp:'). Returns the end index of the email or -1.
function scanSchemeEmail(text, s, trimTrailingUnderscore) {
  const n = text.length;
  const j = scanEmailLocal(text, s);
  if (j === s || j >= n || text[j] !== '@') return -1;
  return matchEmailDomain(text, j + 1, trimTrailingUnderscore);
}

// Match an extended autolink starting at text[i]. Returns
// {href, text, end, extended} or null. Handles www., http(s)://, ftp://,
// mailto:, and bare emails (via '@').
function matchExtendedUrl(text, i, trimTrailingUnderscore) {
  const n = text.length;
  // www. (lowercase only, restricted preceding char, host starts alnum/-).
  if (text.startsWith('www.', i)) {
    const prev = i === 0 ? '' : text[i - 1];
    if (i === 0 || WWW_PRECEDING_OK.has(prev)) {
      const h = i + 4;
      if (h < n && (isAlpha(text[h]) || isDigit(text[h]) || text[h] === '-')) {
        const url = scanUrl(text, i);
        if (url) return { href: 'http://' + url, text: url, end: i + url.length, extended: true };
      }
    }
    return null;
  }
  // Schemes http/https/ftp (case-insensitive), no preceding restriction.
  const low = text.slice(i, i + 8).toLowerCase();
  let schemeLen = 0;
  if (low.startsWith('https://')) schemeLen = 8;
  else if (low.startsWith('http://')) schemeLen = 7;
  else if (low.startsWith('ftp://')) schemeLen = 6;
  if (schemeLen > 0) {
    const h = i + schemeLen;
    if (h < n && (isAlpha(text[h]) || isDigit(text[h]) || text[h] === '-')) {
      const url = scanUrl(text, i);
      if (url) return { href: url, text: url, end: i + url.length, extended: true };
    }
    return null;
  }
  // mailto: (lowercase only, preceding char must not be a word char).
  if (text.startsWith('mailto:', i)) {
    const prev = i === 0 ? '' : text[i - 1];
    if (i === 0 || !(isAlpha(prev) || isDigit(prev))) {
      // The email must start right after 'mailto:'.
      const end = scanSchemeEmail(text, i + 7, trimTrailingUnderscore);
      if (end !== -1) {
        const full = 'mailto:' + text.slice(i + 7, end);
        return { href: full, text: full, end, extended: true };
      }
    }
    return null;
  }
  // xmpp: (lowercase only, preceding char must not be a word char).
  // Email right after, plus an optional path: '/' + [A-Za-z0-9.@]+
  // with trailing '.'s trimmed. (The only other scheme+email autolink.)
  if (text.startsWith('xmpp:', i)) {
    const prev = i === 0 ? '' : text[i - 1];
    if (i === 0 || !(isAlpha(prev) || isDigit(prev))) {
      const end = scanSchemeEmail(text, i + 5, trimTrailingUnderscore);
      if (end !== -1) {
        let linkEnd = end;
        if (end < n && text[end] === '/') {
          let p = end + 1;
          while (p < n) {
            const c = text[p];
            if (isAlpha(c) || isDigit(c) || c === '.' || c === '@') p++;
            else break;
          }
          let pe = p;
          while (pe > end + 1 && text[pe - 1] === '.') pe--;
          if (pe > end + 1) linkEnd = pe;
        }
        const full = text.slice(i, linkEnd);
        return { href: full, text: full, end: linkEnd, extended: true };
      }
    }
    return null;
  }
  return null;
}

// Scan a URL candidate (maximal run of non-space, non-'<') from i and trim it.
function scanUrl(text, i) {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<') break;
    j++;
  }
  const trimmed = trimUrlCandidate(text.slice(i, j));
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Inline links
// ---------------------------------------------------------------------------

// Parse an inline link/image suffix starting at text[i] ('(').
// Returns {href, title, end} or null.
function parseInlineLink(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  const d = scanLinkDest(text, j, true);
  if (!d) return null;
  const dest = d.dest;
  j = d.end;
  while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= n) return null;
  if (text[j] === ')') return { href: dest, title: null, end: j + 1 };
  if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
    const tr = parseTitle(text, j, true);
    if (!tr) return null;
    j = tr.end;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j >= n || text[j] !== ')') return null;
    return { href: dest, title: tr.title, end: j + 1 };
  }
  return null;
}

// Parse a reference label starting at text[i] ('[').
// Returns {label, end} or null.
function parseRefLabel(text, i) {
  return scanDefLabel(text, i + 1);
}

// Are the brackets in text[start..end) balanced (equal '[' and ']' counts,
// ignoring backslash-escaped brackets)? Link/image text must be balanced.
function bracketsBalanced(text, start, end) {
  let depth = 0;
  for (let k = start; k < end; k++) {
    const c = text[k];
    if (c === '\\' && k + 1 < end && isAsciiPunct(text[k + 1])) {
      k++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

// Flanking for a delimiter run covering text[start..end): whether it can
// open (left-flanking) and/or close (right-flanking) emphasis, plus
// whether the neighbors are punctuation. Start/end of the inline text
// act like a newline (whitespace).
function flanking(text, start, end) {
  const before = start > 0 ? text[start - 1] : '\n';
  const after = end < text.length ? text[end] : '\n';
  const beforeWs = isUnicodeWs(before);
  const afterWs = isUnicodeWs(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, beforePunct, afterPunct };
}

// Is the '_' run starting at `start` part of a valid email's local part?
// (Such underscores stay literal text so the email can form.)
function underscoreInEmail(text, start) {
  const n = text.length;
  const j = scanEmailLocal(text, start);
  if (j >= n || text[j] !== '@') return false;
  const em = matchEmail(text, j);
  return em !== null && em.start <= start;
}

// Find the closing '~' run for an opener of length len, searching from `from`.
// Stack discipline via depth counting (same-length runs only): a run that
// can close matches the nearest unmatched opener (depth 0 = our opener);
// a run that can only open increases the depth. This gives proper nesting
// (~~a ~~b~~ c~~ nests) instead of first-closer matching.
// Returns the closer's run start, or -1.
function findTildeCloser(text, from, len) {
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
    let j = i;
    while (j < n && text[j] === '~') j++;
    if (j - i === len) {
      // Strikethrough uses the same flanking rules as emphasis: a run
      // preceded by punctuation (e.g. an escaped '~') and followed by a
      // letter can only open, not close.
      const { left, right } = flanking(text, i, j);
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
  // Every ']' position (link-text balance: a link/image only forms when
  // its text has equal '[' and ']' counts).
  const closes = [];
  // Backtick runs with no matching closer (an unclosed backtick inside
  // link text blocks the link from forming).
  const unclosedTicks = [];
  // [start, end] of every closed code span (link-text backtick parity
  // exception: an odd run count is allowed when the link text ends with
  // a closed code span).
  const codeSpans = [];
  // Chunk indices of <del> elements whose content ends with a blocking
  // strong pair (a ** pair whose opener is preceded by a space and whose
  // closer is at the end of the del content, optionally followed by
  // letters). Such a del blocks an enclosing * em match.
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

  function pushChunk(s, src) {
    chunks.push(s);
    chunkSrc.push(src);
  }
  function flushText(upto) {
    if (upto > textStart) {
      pushChunk(esc(text.slice(textStart, upto)), textStart);
    }
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
    chunks[d.chunk] = d.leftoverInside
      ? lit + close + open
      : close + lit + open;
  }

  while (i < n) {
    const c = text[i];
    // Backslash escapes: \<newline> is a hard break (spaces/tabs after
    // the newline are skipped too); \<punct> is the literal punctuation.
    // Any other backslash is literal text.
    if (c === '\\') {
      const next = i + 1 < n ? text[i + 1] : '';
      if (next === '\n') {
        flushText(i);
        if (!plain) pushChunk('<br>', i);
        i += 2;
        while (i < n && isSpaceOrTab(text[i])) i++;
        textStart = i;
      } else if (isAsciiPunct(next)) {
        flushText(i);
        pushChunk(esc(next), i);
        i += 2;
        textStart = i;
      } else {
        i++;
      }
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
          let bi = brackets.length - 1;
          while (bi >= 0 && !brackets[bi].active) bi--;
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
      const fl = flanking(text, i, j);
      let canOpen;
      let canClose;
      if (c === '*') {
        canOpen = fl.left;
        canClose = fl.right;
      } else {
        canOpen = fl.left && (!fl.right || fl.beforePunct);
        canClose = fl.right && (!fl.left || fl.afterPunct);
      }
      if ((canOpen || canClose) &&
          !(c === '_' && underscoreInEmail(text, i))) {
        flushText(i);
        const chunkIdx = chunks.length;
        pushChunk(text.slice(i, j), i);
        // The backtick-link emphasis suppression does not apply inside
        // a bracket (link text is tokenized in its own scope).
        let inBracket = false;
        for (let b = brackets.length - 1; b >= 0; b--) {
          if (brackets[b].active) { inBracket = true; break; }
        }
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
      let inBr = false;
      if (suppressEmUntilTick && i < lastBacktick) {
        for (let bi = brackets.length - 1; bi >= 0; bi--) {
          if (brackets[bi].active) { inBr = true; break; }
        }
        if (!inBr) { i = j; continue; }
      }
      if ((runLen === 1 || runLen === 2) && flanking(text, i, j).left) {
        const closer = findTildeCloser(text, j, runLen);
        if (closer !== -1) {
          // A backtick run inside the del content whose first
          // same-length closer lies AFTER the del closer means the
          // code span crosses the '~~' — the del does not form.
          // An escaped backtick (\`) cannot open a code span, so
          // backslash escapes are skipped when scanning the content.
          let crosses = false;
          let p = j;
          while (p < closer && !crosses) {
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
                    if (k >= closer) crosses = true;
                    else p = f;
                    break;
                  }
                  k = f;
                } else k++;
              }
              if (k >= n) p = e;
            } else p++;
          }
          if (crosses) { i = j; continue; }
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
      flushText(i);
      const bangChunk = chunks.length;
      pushChunk('!', i);
      const brChunk = chunks.length;
      pushChunk('[', i + 1);
      brackets.push({
        chunk: brChunk, bangChunk, srcPos: i + 1, isImage: true, active: true,
        closesAtPush: closes.length, inLinkAtPush: inLinkGlobal,
        linkBlocked: false,
      });
      i += 2;
      textStart = i;
      continue;
    }
    // Link bracket.
    if (c === '[') {
      flushText(i);
      const brChunk = chunks.length;
      pushChunk('[', i);
      brackets.push({
        chunk: brChunk, bangChunk: -1, srcPos: i, isImage: false, active: true,
        closesAtPush: closes.length, inLinkAtPush: inLinkGlobal,
        linkBlocked: false,
      });
      i++;
      textStart = i;
      continue;
    }
    // Close bracket: try to form a link/image.
    if (c === ']') {
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
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
      const aa = matchAngleAutolink(text, i);
      if (aa) {
        flushText(i);
        if (plain) pushChunk(esc(aa.text), i);
        else {
          pushChunk(
            `<a href="${cleanUrl(aa.href)}">${escapeNoEncode(aa.text)}</a>`, i);
        }
        i = aa.end;
        textStart = i;
        continue;
      }
      const he = matchInlineHtml(text, i);
      if (he !== -1) {
        flushText(i);
        if (plain) pushChunk(escapeNoEncode(text.slice(i, he)), i);
        else pushChunk(text.slice(i, he), i);
        // An inline <a> tag sets the document-global in-link state
        // (suppresses extended autolinks); the exact tag "</a>" clears
        // it. The open tag needs a literal space after the name.
        if (he - i === 4 && text[i + 1] === '/' &&
            (text[i + 2] === 'a' || text[i + 2] === 'A') &&
            text[i + 3] === '>') {
          inLinkGlobal = false;
        } else if ((text[i + 1] === 'a' || text[i + 1] === 'A') &&
            text[i + 2] === ' ') {
          inLinkGlobal = true;
        }
        i = he;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Entities.
    if (c === '&') {
      const ent = matchEntity(text, i);
      if (ent) {
        flushText(i);
        pushChunk(ent.out, i);
        i += ent.len;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Newlines: hard breaks (2+ trailing spaces) or soft breaks.
    if (c === '\n') {
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && text[k] === ' ') { sp++; k--; }
      if (sp >= 2) {
        flushText(i - sp);
        if (!plain) pushChunk('<br>', i);
        i++;
        while (i < n && isSpaceOrTab(text[i])) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Extended autolinks (www. / schemes / mailto: / xmpp:). Suppressed
    // while the document-global in-link state is set (an unclosed
    // inline <a> tag earlier in the document).
    if (!inLinkGlobal && (c === 'w' || c === 'h' || c === 'H' || c === 'f' ||
        c === 'F' || c === 'm' || c === 'x')) {
      let trimUs = false;
      for (const d of delims) {
        if (!d.dead && d.ch === '_' && d.canOpen) { trimUs = true; break; }
      }
      let u = matchExtendedUrl(text, i, trimUs);
      // If the URL swallowed a ']' that closes an active bracket AND a link
      // will form from that ']', truncate the URL to before the ']'
      // (otherwise the ']' is part of the URL and no link forms).
      if (u && u.text.includes(']')) {
        let bi = brackets.length - 1;
        while (bi >= 0 && !brackets[bi].active) bi--;
        if (bi >= 0) {
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
          if (linkForms) {
            const trunc = trimUrlCandidate(text.slice(i, closePos));
            if (trunc) {
              if (u.href !== u.text) u.href = 'http://' + trunc;
              else u.href = trunc;
              u.text = trunc;
              u.end = i + trunc.length;
            } else {
              u = null;
            }
          }
        }
      }
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
      // If an unmatched '_' opener exists, trailing '_'s in the domain
      // are emphasis delimiters (trimmed), not domain characters.
      let trimUs = false;
      for (const d of delims) {
        if (!d.dead && d.ch === '_' && d.canOpen) { trimUs = true; break; }
      }
      const em = matchEmail(text, i, textStart, trimUs);
      if (em) {
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
        i = em.end;
        textStart = i;
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

// The task-list checkbox HTML for a list item, or '' when this is not a
// task item or not the first child.
function taskCheckbox(item, isFirst) {
  if (!isFirst || !item.task) return '';
  const checked = item.task === 'checked' ? 'checked="" ' : '';
  return `<input ${checked}disabled="" type="checkbox"> `;
}

function renderItem(item, loose, refs, out) {
  out.push('<li>');
  const children = item.children;
  if (children.length === 0) {
    out.push('</li>\n');
    return;
  }
  for (let ci = 0; ci < children.length; ci++) {
    const ch = children[ci];
    if (ch.t !== 'p') {
      renderBlocks([ch], refs, out);
      continue;
    }
    const inner = taskCheckbox(item, ci === 0) + parseInline(ch.text, refs, false);
    if (loose) out.push('<p>', inner, '</p>\n');
    else out.push(inner);
  }
  out.push('</li>\n');
}

function renderTable(b, refs, out) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let ci = 0; ci < b.head.length; ci++) {
    const al = b.align[ci];
    out.push(
      `<th${al ? ` align="${al}"` : ''}>`,
      parseInline(b.head[ci], refs, false),
      '</th>\n',
    );
  }
  out.push('</tr>\n</thead>\n');
  if (b.body.length > 0) {
    out.push('<tbody>');
    for (const row of b.body) {
      out.push('<tr>\n');
      for (let ci = 0; ci < row.length; ci++) {
        const al = b.align[ci];
        out.push(
          `<td${al ? ` align="${al}"` : ''}>`,
          parseInline(row[ci], refs, false),
          '</td>\n',
        );
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

function renderBlocks(blocks, refs, out) {
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        out.push('<p>', parseInline(b.text, refs, false), '</p>\n');
        break;
      case 'h':
        out.push(`<h${b.level}>`, parseInline(b.text, refs, false), `</h${b.level}>\n`);
        break;
      case 'code':
        out.push('<pre><code>', escapeText(b.text), '</code></pre>\n');
        break;
      case 'fence': {
        const cls = b.lang !== ''
          ? ` class="language-${escapeNoEncode(b.lang)}"`
          : '';
        out.push(`<pre><code${cls}>`, escapeText(b.text), '</code></pre>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(b.text);
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(b.children, refs, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        out.push(`<${tag}${startAttr}>\n`);
        for (const it of b.items) renderItem(it, b.loose, refs, out);
        out.push(`</${tag}>\n`);
        break;
      }
      case 'table':
        renderTable(b, refs, out);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Parse markdown to HTML, matching marked 18.1.3's default output. The
// module-level inline state (in-link flag, link/autolink tracking) is
// reset on every call so parses are independent.
export function parse(markdown) {
  inLinkGlobal = false;
  linksFormed = 0;
  extAutolinks = [];
  const lines = splitLines(markdown);
  const refs = new Map();
  const blocks = parseBlocks(lines, refs);
  const out = [];
  renderBlocks(blocks, refs, out);
  return out.join('');
}
