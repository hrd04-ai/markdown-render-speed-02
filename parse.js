// parse.js — dependency-free CommonMark 0.31.2 + GFM parser.
//
// Written from scratch for the make.fun "Make Markdown rendering faster"
// bounty. parse(markdown) returns the HTML that marked 18.1.3 produces with
// its default options (gfm, breaks off, pedantic off, async off).
//
// The implementation is a hand-written block parser (line based, recursive
// over containers) plus a single-pass inline parser built around a chunk
// list, a delimiter stack for emphasis and a bracket stack for links.
// Behaviour was pinned down by probing marked's outputs on ~400 edge cases;
// no marked source was consulted.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

// ASCII punctuation (CommonMark): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(ch) {
  return (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
    (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~');
}

// Unicode whitespace (for flanking rules): space, tab, LF, FF, CR, VT plus
// the Unicode space separators.
function isUnicodeWs(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' ||
      ch === '\r' || ch === '\v') return true;
  const c = ch.charCodeAt(0);
  return c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000;
}

// CommonMark "Unicode punctuation" for flanking = P (punctuation) or S
// (symbol) categories, so currency signs like £/€ count as punctuation.
const PUNCT_RE = /[\p{P}\p{S}]/u;
// Unicode punctuation: ASCII punct or general category P.
function isPunct(ch) {
  if (ch.charCodeAt(0) < 128) return isAsciiPunct(ch);
  return PUNCT_RE.test(ch);
}

function isSpaceOrTab(ch) { return ch === ' ' || ch === '\t'; }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isWordChar(ch) {
  return isAlpha(ch) || isDigit(ch) || ch === '_';
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Full escape for text content: & < > " ' are all escaped.
function escapeText(s) {
  if (!s) return s;
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPE_MAP[s[i]];
    if (rep !== undefined) {
      if (out === null) out = s.slice(0, i);
      else out += s.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  if (out === null) return s;
  return out + s.slice(last);
}

// No-encode escape for hrefs / titles / alt text: & is escaped only when it
// does NOT start an entity reference (&#...; or &\w+;). < > " ' always escape.
function escapeNoEncode(s) {
  if (!s) return s;
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      // Is this the start of an entity? &#...; or &\w+;
      let j = i + 1;
      if (s[j] === '#') {
        j++;
        if (s[j] === 'x' || s[j] === 'X') j++;
        const ds = j;
        while (j < s.length && /[0-9A-Fa-f]/.test(s[j])) j++;
        if (j > ds && s[j] === ';') continue; // entity: leave raw
      } else {
        const ws = j;
        while (j < s.length && isWordChar(s[j])) j++;
        if (j > ws && s[j] === ';') continue; // entity: leave raw
      }
      if (out === null) out = s.slice(0, i);
      else out += s.slice(last, i);
      out += '&amp;';
      last = i + 1;
    } else {
      const rep = ESCAPE_MAP[ch];
      if (rep !== undefined) {
        if (out === null) out = s.slice(0, i);
        else out += s.slice(last, i);
        out += rep;
        last = i + 1;
      }
    }
  }
  if (out === null) return s;
  return out + s.slice(last);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// Decode a numeric entity body (without &# and ;) to a code point, or -1 when
// the value is invalid (0, surrogate, > 0x10FFFF).
function entityCodePoint(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    if (body.length < 2 || body.length > 7) return -2;
    cp = parseInt(body.slice(1), 16);
    if (Number.isNaN(cp)) return -2;
  } else {
    if (body.length < 1 || body.length > 8) return -2;
    cp = parseInt(body, 10);
    if (Number.isNaN(cp)) return -2;
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return -1;
  return cp;
}

// Try to match an entity reference at text[i] (text[i] === '&').
// Returns {len, out} where len is the consumed length and out is the
// replacement string (already escaped for text), or null if no entity.
// Named entities pass through raw; numeric ones are decoded (invalid -> FFFD).
function matchEntity(text, i) {
  const n = text.length;
  let j = i + 1;
  if (j < n && text[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (text[j] === 'x' || text[j] === 'X')) { hex = true; j++; }
    const ds = j;
    while (j < n) {
      const c = text[j];
      if (hex ? /[0-9A-Fa-f]/.test(c) : isDigit(c)) j++;
      else break;
    }
    if (j === ds || j >= n || text[j] !== ';') return null;
    const digits = text.slice(ds, j);
    // Decimal: 1-7 digits; hex: 1-6 digits. Longer -> literal.
    if ((!hex && digits.length > 7) || (hex && digits.length > 6)) return null;
    const cp = entityCodePoint((hex ? 'x' : '') + digits);
    const ch = cp === -1 ? '\uFFFD' : String.fromCodePoint(cp);
    return { len: j + 1 - i, out: escapeText(ch) };
  }
  // Named: &\w+;
  const ws = j;
  while (j < n && isWordChar(text[j])) j++;
  if (j === ws || j >= n || text[j] !== ';') return null;
  // Pass through raw, unchanged.
  return { len: j + 1 - i, out: text.slice(i, j + 1) };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// marked's cleanUrl: encodeURI, un-encode %25 back to %, then no-encode escape.
function cleanUrl(href) {
  let u;
  try {
    u = encodeURI(href).replace(/%25/g, '%');
  } catch (_e) {
    // encodeURI throws on lone surrogates; fall back to the raw href.
    u = href;
  }
  return escapeNoEncode(u);
}

// Resolve backslash escapes in a link dest / title / label: \ + ASCII punct
// becomes the punctuation; anything else keeps the backslash.
function resolveEscapes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s.slice(last, i) + s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return out + s.slice(last);
}

// Normalize a link reference label: resolve escapes, collapse all whitespace
// runs (incl. newlines/tabs) to single spaces, trim, case-fold.
function normalizeLabel(raw) {
  // Labels match on RAW text (backslashes preserved: [foo\!] != [foo!]).
  // Unicode case folding: ß/ẞ fold to 'ss', final sigma ς folds to σ.
  return raw.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/\u00df/g, 'ss').replace(/\u03c2/g, '\u03c3');
}

// ---------------------------------------------------------------------------
// Tabs / columns
// ---------------------------------------------------------------------------

// Width of a tab at the given column.
function tabWidth(col) { return 4 - (col % 4); }

// Leading whitespace of a line: returns [widthInCols, firstNonWsIndex].
function leadingWs(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += tabWidth(col); i++; }
    else break;
  }
  return [col, i];
}

// Slice a line from a target column. A tab straddling the boundary becomes
// spaces for the part after the boundary. When expandTabs is true, leading
// tabs after the cut are expanded to spaces using original columns
// (container-prefix stripping); otherwise they are preserved (code content).
function sliceFromCol(line, targetCol, expandTabs) {
  let col = 0;
  let i = 0;
  let prefix = '';
  while (i < line.length && col < targetCol) {
    const c = line[i];
    if (c === '\t') {
      const w = tabWidth(col);
      if (col + w <= targetCol) { col += w; i++; }
      else {
        prefix = ' '.repeat(w - (targetCol - col));
        i++;
        col += w;
        break;
      }
    } else { col++; i++; }
  }
  if (!expandTabs) return prefix + line.slice(i);
  let out = prefix;
  while (i < line.length) {
    const c = line[i];
    if (c === '\t') { const w = tabWidth(col); out += ' '.repeat(w); col += w; i++; }
    else if (c === ' ') { out += ' '; col++; i++; }
    else break;
  }
  return out + line.slice(i);
}

// Is a line blank for starting a block (empty or whitespace-only)?
function isBlankStart(t) {
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ' ' && t[i] !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

// Split source into lines. Each line is {t, nl}: t is the content without
// the newline, nl is whether a newline follows it. A whitespace-only line
// counts as blank only when it is terminated (a final unterminated
// whitespace-only line is content, e.g. it joins a paragraph).
function splitLines(src) {
  src = src.replace(/\r\n?/g, '\n');
  if (src === '') return [];
  const parts = src.split('\n');
  const endsNL = src.endsWith('\n');
  if (endsNL) parts.pop();
  const lines = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    lines[i] = { t: parts[i], nl: i < parts.length - 1 || endsNL };
  }
  return lines;
}

// Blank for continuing/ending a block: empty, or whitespace-only + terminated.
function isBlankLine(L) {
  if (L.t === '') return true;
  if (!L.nl) return false;
  return isBlankStart(L.t);
}

// ---------------------------------------------------------------------------
// Block-start matchers (each takes a raw line string)
// ---------------------------------------------------------------------------

// Fenced code start. Returns {ch, len, indent, info} or null.
// Backtick fences whose info contains a backtick are not fences.
function matchFence(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i < t.length && t[i] === '\t') return null; // tab -> 4 cols, not a fence
  if (i >= t.length) return null;
  const ch = t[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < t.length && t[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = t.slice(j);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, indent: i, info };
}

// Is this line a closing fence for a fence of (ch, len)? Same char, run
// >= len, only spaces/tabs after, 0-3 leading spaces.
function isClosingFence(t, ch, len) {
  let k = 0;
  while (k < t.length && t[k] === ' ' && k < 3) k++;
  if (k < t.length && t[k] === '\t') return false;
  if (k >= t.length) return false;
  let r = k;
  while (r < t.length && t[r] === ch) r++;
  if (r - k < len) return false;
  for (let q = r; q < t.length; q++) {
    if (!isSpaceOrTab(t[q])) return false;
  }
  return true;
}

// ATX heading. Returns {level, text} or null.
function matchATX(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i < t.length && t[i] === '\t') return null;
  let j = i;
  while (j < t.length && t[j] === '#' && j - i < 6) j++;
  const level = j - i;
  if (level === 0 || level > 6) return null;
  if (j < t.length && t[j] !== ' ' && t[j] !== '\t') return null;
  // Content: skip whitespace, trim trailing whitespace, strip closing #'s.
  let s = j;
  while (s < t.length && isSpaceOrTab(t[s])) s++;
  let e = t.length;
  while (e > s && isSpaceOrTab(t[e - 1])) e--;
  // Closing sequence: trailing #'s preceded by space/tab. The preceding
  // space may be the whitespace between the opening hashes and the content
  // (e.g. "# #" -> empty heading).
  let k = e;
  while (k > s && t[k - 1] === '#') k--;
  if (k < e && k > j && isSpaceOrTab(t[k - 1])) {
    e = k;
    while (e > s && isSpaceOrTab(t[e - 1])) e--;
  }
  return { level, text: t.slice(s, e) };
}

// Thematic break: 3+ of the same marker (*, -, _) with only spaces/tabs.
function matchHR(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i < t.length && t[i] === '\t') return false;
  if (i >= t.length) return false;
  const ch = t[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// Setext underline: 1+ '=' or '-' with only trailing spaces/tabs.
// Returns 1 (=), 2 (-), or 0.
function matchSetext(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i < t.length && t[i] === '\t') return 0;
  if (i >= t.length) return 0;
  const ch = t[i];
  if (ch !== '=' && ch !== '-') return 0;
  // One or more of the char, then only spaces/tabs to EOL. No internal
  // spaces: '= =' and '--- -' are NOT setext underlines.
  let j = i;
  while (j < t.length && t[j] === ch) j++;
  for (; j < t.length; j++) {
    if (t[j] !== ' ' && t[j] !== '\t') return 0;
  }
  return ch === '=' ? 1 : 2;
}

// Blockquote prefix. Returns the rest of the line (leading tabs expanded
// using original columns) or null when the line has no quote marker.
function matchBlockquote(t) {
  let col = 0;
  let i = 0;
  while (i < t.length && col < 3) {
    const c = t[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') return null; // tab reaches col 4: not a quote
    else break;
  }
  if (i >= t.length || t[i] !== '>') return null;
  i++;
  col++;
  // Optional single space (or a tab counting as one column) after '>'.
  let prefix = '';
  if (i < t.length) {
    const c = t[i];
    if (c === ' ') { i++; col++; }
    else if (c === '\t') {
      const w = tabWidth(col);
      prefix = ' '.repeat(w - 1);
      i++;
      col += w;
    }
  }
  // Expand leading tabs in the remainder (original columns).
  let out = prefix;
  while (i < t.length) {
    const c = t[i];
    if (c === '\t') { const w = tabWidth(col); out += ' '.repeat(w); col += w; i++; }
    else if (c === ' ') { out += ' '; col++; i++; }
    else break;
  }
  return out + t.slice(i);
}

// List marker. Returns null or:
// {ordered, delim, start, indent (marker col), contentIndent (col),
//  content (string after marker+ws, tabs expanded), empty (no content)}
function matchListMarker(t) {
  let col = 0;
  let i = 0;
  while (i < t.length && col < 3) {
    const c = t[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') return null;
    else break;
  }
  if (i >= t.length) return null;
  const indent = col;
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
    start = parseInt(t.slice(i, j), 10);
    mEnd = j + 1;
  } else return null;
  const markerCol = col + (mEnd - i);
  // Whitespace after the marker.
  let wCol = markerCol;
  let wEnd = mEnd;
  while (wEnd < t.length && isSpaceOrTab(t[wEnd])) {
    if (t[wEnd] === '\t') wCol += tabWidth(wCol);
    else wCol++;
    wEnd++;
  }
  const wsWidth = wCol - markerCol;
  if (wEnd >= t.length) {
    // Empty item (or blank first line): content indent is marker + 1.
    return {
      ordered, delim, start, indent,
      contentIndent: markerCol + 1,
      content: '', empty: true,
    };
  }
  if (wsWidth === 0) return null; // marker must be followed by whitespace
  let contentIndent;
  let content;
  if (wsWidth <= 4) {
    contentIndent = wCol;
    content = t.slice(wEnd);
  } else {
    // 5+ columns of whitespace: content indent is marker + 1.
    contentIndent = markerCol + 1;
    content = sliceFromCol(t, contentIndent, true);
  }
  return { ordered, delim, start, indent, contentIndent, content, empty: false };
}

// ---------------------------------------------------------------------------
// HTML blocks (7 types)
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param',
  'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);

// Match an HTML block start. Returns {type, end} where type is 1-7 and end
// is the terminator string for types 1-5, or null.
// Type 1: <pre, <script, <style, <textarea (open tag, ends at matching close)
// Type 2: <!-- (ends at -->)
// Type 3: <? (ends at ?>)
// Type 4: <! + letter (ends at >)
// Type 5: <![CDATA[ (ends at ]]>)
// Type 6: block tag open/close alone on the line (ends at blank line)
// Type 7: any other complete open/close tag alone on the line (ends at blank)
function matchHtmlBlock(t) {
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i < t.length && t[i] === '\t') return null;
  if (i >= t.length || t[i] !== '<') return null;
  const rest = t.slice(i);
  // Type 2: comment.
  if (rest.startsWith('<!--')) return { type: 2, end: '-->' };
  // Type 3: processing instruction (block form accepts <? without ?>).
  if (rest.startsWith('<?')) return { type: 3, end: '?>' };
  // Type 5: CDATA (block form accepts lowercase too).
  if (/^<!\[CDATA\[/i.test(rest)) return { type: 5, end: ']]>' };
  // Type 4: <! + letter (block form accepts lowercase too).
  if (rest.length > 2 && rest[1] === '!' && isAlpha(rest[2])) {
    return { type: 4, end: '>' };
  }
  // Type 1: pre/script/style/textarea open tag (EOL after the name counts:
  // '<style' alone on a line starts a type-1 block).
  const m1 = /^<(pre|script|style|textarea)(\s|\/?>|$)/i.exec(rest);
  if (m1) return { type: 1, end: '</' + m1[1].toLowerCase() + '>' };
  // Type 6: a block tag name followed by whitespace, end of line, '>', or
  // '/>'. The rest of the line is irrelevant ('<table><tr><td>' and
  // '<div id="foo"' both start type-6 blocks).
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const a = m6[0].length;
    const after = rest[a];
    if (after === undefined || after === ' ' || after === '\t' ||
        after === '>' || (after === '/' && rest[a + 1] === '>')) {
      return { type: 6, end: null };
    }
  }
  // Type 7: a complete open or close tag alone on the line, with a tag
  // name that is NOT a block tag. Validated with the strict inline tag
  // matcher (attribute names/values must be well-formed: no attributes
  // on closing tags, whitespace required between attributes).
  const tagEnd = matchInlineTag(rest, 0);
  if (tagEnd !== -1) {
    const mName = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    let after = i + tagEnd;
    while (after < t.length && isSpaceOrTab(t[after])) after++;
    if (after >= t.length && mName && !BLOCK_TAGS.has(mName[1].toLowerCase())) {
      return { type: 7, end: null };
    }
  }
  return null;
}

// Strip up to n columns of leading whitespace (spaces/tabs) from a line.
// A tab straddling the boundary becomes spaces for the part after it.
// Stops at the first non-whitespace character (never eats content).
function stripIndent(t, n, tabAsOne) {
  let col = 0;
  let i = 0;
  while (i < t.length && col < n) {
    const c = t[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      // Fences count each tab as one column (marked quirk); elsewhere a
      // tab expands to its full width and may leave partial spaces.
      if (tabAsOne) { col++; i++; continue; }
      const w = tabWidth(col);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + t.slice(i + 1);
    } else break;
  }
  return t.slice(i);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

// Split a table row line into cells: split on unescaped '|', trim spaces/tabs,
// drop an empty edge cell when the line starts/ends with '|'.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Trim leading/trailing whitespace for edge detection.
  let s = 0;
  let e = n;
  while (s < n && isSpaceOrTab(line[s])) s++;
  while (e > s && isSpaceOrTab(line[e - 1])) e--;
  const startsPipe = s < e && line[s] === '|';
  const endsPipe = e > s && line[e - 1] === '|';
  for (i = s; i < e; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < e && line[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  if (startsPipe) cells.shift();
  if (endsPipe) cells.pop();
  for (let k = 0; k < cells.length; k++) {
    cells[k] = cells[k].replace(/^[ \t]+|[ \t]+$/g, '');
  }
  return cells;
}

// Match a table delimiter row. Returns the align array or null.
// Delimiter cells are :?-+:? separated by '|', optional edge pipes, and the
// row MUST contain a '|' and have exactly headerCount cells. No tabs allowed
// anywhere in the row (tabs inside cells, between cells, or trailing kill it).
function matchTableDelimiter(t, headerCount) {
  if (t.indexOf('\t') !== -1) return null;
  if (t.indexOf('|') === -1) return null;
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return null;
  if (t[i] === '\t') return null;
  // Split on '|' (no escapes in delimiter rows; a \| would break the cell).
  const parts = t.slice(i).split('|');
  // Drop empty edge parts.
  if (parts.length > 0 && parts[0].trim() === '' && t.slice(i).startsWith('|')) parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '' && t.slice(i).trimEnd().endsWith('|')) parts.pop();
  if (parts.length !== headerCount) return null;
  const aligns = [];
  for (const p of parts) {
    const cell = p.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Does this line look like a table delimiter row (ignoring cell count)?
// Used to flag lazy delimiter lines in blockquotes (they never form tables).
function looksLikeTableDelimiter(t) {
  if (t.indexOf('\t') !== -1) return false;
  if (t.indexOf('|') === -1) return false;
  let i = 0;
  while (i < t.length && t[i] === ' ' && i < 3) i++;
  if (i >= t.length) return false;
  const rest = t.slice(i);
  const parts = rest.split('|');
  if (parts.length > 0 && parts[0].trim() === '' && rest.startsWith('|')) parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '' && rest.trimEnd().endsWith('|')) parts.pop();
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (!/^:?-+:?$/.test(p.trim())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Block consumers
// ---------------------------------------------------------------------------

// Fenced code block starting at lines[i] (match m).
function consumeFence(lines, i, m) {
  // Language: first whitespace-delimited word of the info string, with
  // backslash escapes resolved first (``` foo\+bar -> language-foo+bar).
  const info = m.info.replace(/^[ \t]+|[ \t]+$/g, '');
  let lang = '';
  if (info !== '') {
    let e = 0;
    while (e < info.length && !isSpaceOrTab(info[e])) e++;
    lang = resolveEscapes(info.slice(0, e));
  }
  const content = [];
  let j = i + 1;
  while (j < lines.length) {
    const t = lines[j].t;
    // Closing fence: same char, run >= opening, only spaces/tabs after.
    let k = 0;
    while (k < t.length && t[k] === ' ' && k < 3) k++;
    if (k < t.length && t[k] !== '\t') {
      let r = k;
      while (r < t.length && t[r] === m.ch) r++;
      if (r - k >= m.len) {
        let ok = true;
        for (let q = r; q < t.length; q++) {
          if (!isSpaceOrTab(t[q])) { ok = false; break; }
        }
        if (ok) { j++; break; }
      }
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

// HTML block starting at lines[i] (match m).
function consumeHtml(lines, i, m) {
  const n = lines.length;
  let k = i;
  if (m.type <= 5) {
    // Ends at the line containing the terminator (inclusive).
    const end = m.end.toLowerCase();
    for (; k < n; k++) {
      if (lines[k].t.toLowerCase().indexOf(end) !== -1) break;
    }
    if (k >= n) k = n - 1;
  } else {
    // Types 6-7: ends at a blank line (or end of input).
    for (; k < n; k++) {
      if (k > i && isBlankLine(lines[k])) { k--; break; }
    }
    if (k >= n) k = n - 1;
  }
  let text = '';
  for (let q = i; q <= k; q++) {
    if (q > i) text += '\n';
    text += lines[q].t;
  }
  // Trailing newline rule:
  // - Types 1-5: include it iff the last line is terminated AND the next
  //   line is non-empty (or there is no next line).
  // - Types 6-7: include it iff the block runs to the end AND the last
  //   line is terminated.
  const lastNL = lines[k].nl;
  if (m.type <= 5) {
    if (lastNL && (k + 1 >= n || lines[k + 1].t !== '')) text += '\n';
  } else {
    if (lastNL && k + 1 >= n) text += '\n';
  }
  return { block: { t: 'html', text }, next: k + 1 };
}

// Indented code block starting at lines[i].
function consumeIndentedCode(lines, i) {
  const content = [];
  let j = i;
  let lastNonBlank = -1;
  let next = i;
  while (j < lines.length) {
    const L = lines[j];
    if (isBlankLine(L)) {
      // A whitespace-only line contributes the part after 4 columns
      // (e.g. 6 spaces -> 2 spaces), not an empty line.
      content.push(sliceFromCol(L.t, 4, false));
      j++;
      continue;
    }
    const [w] = leadingWs(L.t);
    if (w < 4) break;
    content.push(sliceFromCol(L.t, 4, false));
    lastNonBlank = content.length - 1;
    next = j + 1;
    j++;
  }
  // Strip trailing blank lines (they stay outside the block).
  const kept = lastNonBlank < 0 ? [] : content.slice(0, lastNonBlank + 1);
  const text = kept.length === 0 ? '' : kept.join('\n') + '\n';
  return { block: { t: 'code', text }, next };
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Parse a title starting at text[i] (", ', or (). Returns {title, end}
// (end = index after the closing delimiter) or null when unclosed/invalid.
// isInline: inline-link paren titles allow '(' inside; def paren titles do not.
function parseTitle(text, i, isInline) {
  const n = text.length;
  const q = text[i];
  let title = '';
  let j = i + 1;
  if (q === '"' || q === "'") {
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
        title += text[j + 1];
        j += 2;
      } else if (c === q) return { title, end: j + 1 };
      else { title += c; j++; }
    }
    return null;
  }
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      title += text[j + 1];
      j += 2;
    } else if (c === ')') return { title, end: j + 1 };
    else if (c === '(' && !isInline) return null;
    else { title += c; j++; }
  }
  return null;
}

// Parse a link reference definition from the start of text (joined paragraph
// text). Returns {consumed, label, href, title} or null. consumed covers the
// definition plus its trailing newline when present.
function parseLinkDef(text) {
  const n = text.length;
  let i = 0;
  let sp = 0;
  while (i < n && text[i] === ' ' && sp < 3) { i++; sp++; }
  if (i >= n || text[i] !== '[') return null;
  i++;
  let label = '';
  let closed = false;
  while (i < n) {
    const c = text[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1])) {
      // Escapes are kept RAW in the label (for matching); a \] does not
      // end the label, a \[ does not invalidate it.
      label += text[i];
      label += text[i + 1];
      i += 2;
    } else if (c === '[') return null;
    else if (c === ']') { closed = true; i++; break; }
    else { label += c; i++; }
  }
  if (!closed) return null;
  const normLabel = normalizeLabel(label);
  if (normLabel === '') return null;
  if (i >= n || text[i] !== ':') return null;
  i++;
  // Gap after ':': spaces, optionally one newline + spaces/tabs.
  while (i < n && text[i] === ' ') i++;
  if (i < n && text[i] === '\n') {
    i++;
    while (i < n && isSpaceOrTab(text[i])) i++;
    if (i < n && text[i] === '\n') return null;
  }
  if (i >= n) return null;
  // Destination.
  let dest = '';
  if (text[i] === '<') {
    i++;
    let ok = false;
    while (i < n) {
      const c = text[i];
      if (c === '\n' || c === '<') return null;
      if (c === '>') { ok = true; i++; break; }
      if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1])) {
        dest += text[i + 1];
        i += 2;
      } else { dest += c; i++; }
    }
    if (!ok) return null;
  } else {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n && isAsciiPunct(text[i + 1])) {
        dest += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '(') { depth++; dest += c; i++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; dest += c; i++; continue;
      }
      const code = c.charCodeAt(0);
      if (c === ' ' || c === '\t' || c === '\n' || code < 0x20) break;
      dest += c;
      i++;
    }
    if (dest === '' || depth !== 0) return null;
  }
  // Optional title: same line (after spaces) or next line (after newline).
  // A same-line title needs at least one space before it, and a failed
  // same-line title kills the whole definition. A failed next-line title
  // leaves the definition valid without the title.
  let p = i;
  let gapSpaces = 0;
  while (p < n && text[p] === ' ') { p++; gapSpaces++; }
  if (p < n && text[p] === '\n') {
    let q = p + 1;
    while (q < n && isSpaceOrTab(text[q])) q++;
    if (q < n && text[q] !== '\n' &&
        (text[q] === '"' || text[q] === "'" || text[q] === '(')) {
      const tr = parseTitle(text, q, false);
      if (tr) {
        let r = tr.end;
        while (r < n && isSpaceOrTab(text[r])) r++;
        if (r >= n || text[r] === '\n') {
          return {
            consumed: r < n ? r + 1 : r,
            label: normLabel, href: dest, title: tr.title,
          };
        }
      }
      // Next-line title invalid: definition without the title survives.
    }
    return {
      consumed: p < n ? p + 1 : p,
      label: normLabel, href: dest, title: null,
    };
  }
  if (gapSpaces > 0 && p < n &&
      (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
    const tr = parseTitle(text, p, false);
    if (!tr) return null;
    p = tr.end;
    while (p < n && isSpaceOrTab(text[p])) p++;
    if (p < n && text[p] !== '\n') return null;
    return {
      consumed: p < n ? p + 1 : p,
      label: normLabel, href: dest, title: tr.title,
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

// Can this line start a block that interrupts a paragraph?
function interruptsParagraph(t, inListItem) {
  if (matchFence(t) || matchATX(t) || matchHR(t)) return true;
  if (matchBlockquote(t) !== null) return true;
  const hm = matchHtmlBlock(t);
  if (hm && hm.type <= 6) return true;
  const lm = matchListMarker(t);
  // An empty list item (marker with no content) cannot interrupt a paragraph.
  // Inside a list item's content, ANY list interrupts (no start-with-1
  // restriction); elsewhere an ordered list must start with 1.
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1 || inListItem)) return true;
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
  if (lm && (!lm.ordered || lm.start === 1)) return false;
  const [w] = leadingWs(t);
  if (w >= 4) return false;
  return true;
}

// Consume a paragraph starting at lines[i]. Handles setext headings, table
// formation, and leading link reference definitions. Returns {blocks, next}.
function consumeParagraph(lines, i, refs, inListItem) {
  const paraLines = [lines[i].t];
  let j = i + 1;
  let endKind = 'blank';
  let setextLevel = 0;
  let tableAlign = null;
  while (j < lines.length) {
    const L = lines[j];
    const t = L.t;
    if (isBlankLine(L)) { endKind = 'blank'; break; }
    // Lazy lines never interrupt a paragraph or form setext/table.
    if (L.lazy) { paraLines.push(t); j++; continue; }
    const headerCells = splitTableRow(paraLines[paraLines.length - 1]);
    // A lazy delimiter line in a blockquote never forms a table, and a
    // lazy setext-like line never becomes a setext underline.
    const aligns = L.noTable ? null : matchTableDelimiter(t, headerCells.length);
    if (aligns) { endKind = 'table'; tableAlign = aligns; break; }
    const sx = L.noSetext ? 0 : matchSetext(t);
    if (sx) { endKind = 'setext'; setextLevel = sx; break; }
    if (interruptsParagraph(t, inListItem)) { endKind = 'interrupt'; break; }
    paraLines.push(t);
    j++;
  }
  // Extract leading link reference definitions.
  let text = paraLines.join('\n');
  for (;;) {
    const d = parseLinkDef(text);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { href: d.href, title: d.title });
    text = text.slice(d.consumed);
  }
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
    const body = [];
    let k = j + 1;
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
    blocks.push({ t: 'table', align: tableAlign, head: header, body });
    return { blocks, next: k };
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
  if (matchATX(t) || matchFence(t) || matchHR(t)) return false;
  if (matchBlockquote(t) !== null) return false;
  if (matchHtmlBlock(t)) return false;
  if (matchListMarker(t)) return false;
  return true;
}

// Blockquote lazy-line stripping: strip 4 columns when the leading
// whitespace is 4+ columns, else keep the line unchanged.
function lazyStripQuote(t) {
  const [w] = leadingWs(t);
  if (w < 4) return t;
  return sliceFromCol(t, 4, false);
}

// Find the last leaf block in a parsed block list (descending into the last
// child of quotes and lists).
function lastLeaf(blocks) {
  if (blocks.length === 0) return null;
  let b = blocks[blocks.length - 1];
  for (;;) {
    if (b.t === 'quote') {
      if (b.children.length === 0) return null;
      b = b.children[b.children.length - 1];
    } else if (b.t === 'list') {
      if (b.items.length === 0) return null;
      const it = b.items[b.items.length - 1];
      if (it.children.length === 0) return null;
      b = it.children[it.children.length - 1];
    } else return b;
  }
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
      // A lazy setext-like line never becomes a setext underline. After an
      // unstripped lazy line it is padded to 4 columns; after a stripped
      // lazy line it is stripped by 4; after a '>' line it is kept as-is.
      let out;
      let stripped = false;
      if (!prevLazy) out = t;
      else if (!prevStripped) out = ' '.repeat(Math.max(0, 4 - w)) + t;
      else { out = stripIndent(t, 4); stripped = true; }
      inner.push({ t: out, nl: L.nl, noSetext: true, lazy: true });
      prevLazy = true;
      prevStripped = stripped;
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
  if (fm0) { fenceCh = fm0.ch; fenceLen = fm0.len; }
  function trackFence(stripped) {
    if (fenceCh === null) {
      const fm = matchFence(stripped);
      if (fm) { fenceCh = fm.ch; fenceLen = fm.len; fenceHasContent = false; }
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
      let hasContent = false;
      for (const il of itemLines) {
        if (!isBlankLine(il)) { hasContent = true; break; }
      }
      if (!hasContent) break;
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
    // ends the item.
    if (fenceCh !== null && fenceHasContent && matchFence(t) === null) {
      itemLines.push({ t, nl: L.nl });
      k++;
      needCheck = true;
      continue;
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
  // Task list: first paragraph starting with [x]/[ ]/[X] + space/tab + content.
  let task = null;
  if (children.length > 0 && children[0].t === 'p') {
    const tm = /^\[([ xX])\][ \t]+(\S[\s\S]*)$/.exec(children[0].text);
    if (tm) {
      task = tm[1] === ' ' ? 'unchecked' : 'checked';
      children[0].text = tm[2];
    }
  }
  return {
    item: { t: 'item', children, task, contentIndent },
    next: k,
    loose: itemLoose,
  };
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
      if (nm && !matchHR(lines[k].t) && nm.indent < prevContentIndent && nm.ordered === ordered && nm.delim === delim) {
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
    if (m && m.indent < prevContentIndent && m.ordered === ordered && m.delim === delim) {
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
      const r = consumeParagraph(lines, i, refs, inListItem);
      for (const b of r.blocks) pushBlock(b);
      if (r.blocks.length === 0 && blankSinceLastBlock) {
        blocks.hasBlankBetween = true;
        blankSinceLastBlock = false;
      }
      i = r.next;
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
    const r = consumeParagraph(lines, i, refs, inListItem);
    for (const b of r.blocks) pushBlock(b);
    if (r.blocks.length === 0 && blankSinceLastBlock) {
      blocks.hasBlankBetween = true;
      blankSinceLastBlock = false;
    }
    i = r.next;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline HTML and autolinks
// ---------------------------------------------------------------------------

// Match an inline HTML tag starting at text[i] ('<'). Returns the index just
// past the tag, or -1. Covers open/close tags (attributes need preceding
// whitespace; closing tags take no attributes).
function matchInlineTag(text, i) {
  const n = text.length;
  let j = i + 1;
  let closing = false;
  if (j < n && text[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlpha(text[j])) return -1;
  j++;
  while (j < n && (isAlpha(text[j]) || isDigit(text[j]) || text[j] === '-')) j++;
  for (;;) {
    let hadWs = false;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) {
      hadWs = true;
      j++;
    }
    if (j >= n) return -1;
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && !closing && j + 1 < n && text[j + 1] === '>') return j + 2;
    if (closing || !hadWs) return -1;
    // Attribute name.
    if (!isAlpha(text[j]) && text[j] !== '_' && text[j] !== ':') return -1;
    j++;
    while (j < n) {
      const c = text[j];
      if (isAlpha(c) || isDigit(c) || c === '_' || c === '.' || c === ':' || c === '-') j++;
      else break;
    }
    const afterName = j;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j < n && text[j] === '=') {
      j++;
      while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
      if (j >= n) return -1;
      const q = text[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && text[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const vs = j;
        while (j < n) {
          const c = text[j];
          if (c === ' ' || c === '\t' || c === '\n' || c === '>' || c === '"' ||
              c === "'" || c === '=' || c === '<' || c === '`') break;
          j++;
        }
        if (j === vs) return -1;
      }
    } else {
      // Boolean attribute (no '='): restore j so the whitespace stays
      // for the next iteration's separator check.
      j = afterName;
    }
  }
}

// Match inline raw HTML starting at text[i] ('<'): comment, PI, declaration,
// CDATA, or tag. Returns the index just past it, or -1.
function matchInlineHtml(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return i + 5;
    if (text.startsWith('<!--->', i)) return i + 6;
    const e = text.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (text.startsWith('<?', i)) {
    const e = text.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (text.startsWith('<![CDATA[', i)) {
    const e = text.indexOf(']]>', i + 9);
    return e === -1 ? -1 : e + 3;
  }
  if (i + 2 < n && text[i + 1] === '!') {
    // Declaration: <! + letters + whitespace + ... + '>'.
    let j = i + 2;
    const ls = j;
    while (j < n && isAlpha(text[j])) j++;
    if (j === ls) return -1;
    if (j >= n || !isSpaceOrTab(text[j]) && text[j] !== '\n') return -1;
    const e = text.indexOf('>', j);
    return e === -1 ? -1 : e + 1;
  }
  return matchInlineTag(text, i);
}

// Marked quirk: an inline <a> open tag sets a document-global "in link"
// state that suppresses extended autolinks (www/http/email) in the rest
// of the document until a </a> close tag clears it. The state persists
// across blocks (paragraphs, headings, lists, blockquotes). The trigger
// is narrow: the open tag must be "<a" + a literal SPACE (tab/newline/
// '>'/'/' after the name do not set it; bare <a> and <a/> do not set
// it), and only the exact 4-char tag "</a>" (any case) clears it —
// "</a >", "</a\t>" and "</a\n>" do not. Tags inside HTML blocks, code
// spans, or link text do not affect the state (a link's text is parsed
// in an isolated scope that restores the state when the link forms).
let inLinkGlobal = false;

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
  for (;;) {
    while (end > dStart && text[end - 1] === '.') end--;
    if (trimTrailingUnderscore) {
      let trimmed = false;
      while (end > dStart && text[end - 1] === '_') { end--; trimmed = true; }
      if (trimmed) continue;
    }
    break;
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
  let s = atPos - 1;
  const lo = minStart === undefined ? 0 : minStart;
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
  const em = matchEmailAt(text, i + 1);
  if (em) return em;
  return null;
}

// Match <email> starting right after '<' (at position s). Returns the
// autolink or null.
function matchEmailAt(text, s) {
  const n = text.length;
  let j = s;
  while (j < n) {
    const c = text[j];
    if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  if (j === s || j >= n || text[j] !== '@') return null;
  const end = matchEmailDomain(text, j + 1);
  if (end === -1 || end >= n || text[end] !== '>') return null;
  const email = text.slice(s, end);
  return { href: 'mailto:' + email, text: email, end: end + 1 };
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
      if (close === -1) { cut = i; break; }
      closers.add(close);
      i = close + 1;
    } else i++;
  }
  let s = cand.slice(0, cut);
  // Trailing trims, looped until stable.
  for (;;) {
    if (s === '') break;
    // (a) trailing named entity &\w+;
    if (s.endsWith(';')) {
      let k = s.length - 2;
      while (k >= 0 && isWordChar(s[k])) k--;
      if (k >= 0 && s[k] === '&' && k < s.length - 2) {
        s = s.slice(0, k);
        continue;
      }
    }
    const last = s[s.length - 1];
    // (b) trailing punctuation.
    if ('?!.,:;*_~"\' '.indexOf(last) !== -1) {
      s = s.slice(0, -1);
      continue;
    }
    // (c) trailing ')' that is not a group closer.
    if (last === ')' && !closers.has(s.length - 1)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

const WWW_PRECEDING_OK = new Set([' ', '\t', '\n', '(', '*', '_', '~']);

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
      let s = i + 7;
      let j = s;
      while (j < n) {
        const c = text[j];
        if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') j++;
        else break;
      }
      if (j > s && j < n && text[j] === '@') {
        const end = matchEmailDomain(text, j + 1, trimTrailingUnderscore);
        if (end !== -1) {
          const email = text.slice(s, end);
          const full = 'mailto:' + email;
          return { href: full, text: full, end, extended: true };
        }
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
      let s = i + 5;
      let j = s;
      while (j < n) {
        const c = text[j];
        if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') j++;
        else break;
      }
      if (j > s && j < n && text[j] === '@') {
        const end = matchEmailDomain(text, j + 1, trimTrailingUnderscore);
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
  const cand = text.slice(i, j);
  const trimmed = trimUrlCandidate(cand);
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
  let dest = '';
  if (text[j] === '<') {
    j++;
    let ok = false;
    while (j < n) {
      const c = text[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') { ok = true; j++; break; }
      if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
        dest += text[j + 1];
        j += 2;
      } else { dest += c; j++; }
    }
    if (!ok) return null;
  } else {
    let depth = 0;
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
        dest += text[j + 1];
        j += 2;
        continue;
      }
      if (c === '(') { depth++; dest += c; j++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; dest += c; j++; continue;
      }
      const code = c.charCodeAt(0);
      if (c === ' ' || c === '\t' || c === '\n' || code < 0x20) break;
      dest += c;
      j++;
    }
    if (depth !== 0) return null;
  }
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
  const n = text.length;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(text[j + 1])) {
      // Escapes are kept RAW in the label (for matching).
      label += text[j];
      label += text[j + 1];
      j += 2;
    } else if (c === '[') return null;
    else if (c === ']') return { label, end: j + 1 };
    else { label += c; j++; }
  }
  return null;
}

// Are the brackets in text[start..end) balanced (equal '[' and ']' counts,
// ignoring backslash-escaped brackets)? Link/image text must be balanced.
function bracketsBalanced(text, start, end) {
  let depth = 0;
  for (let k = start; k < end; k++) {
    const c = text[k];
    if (c === '\\' && k + 1 < end && isAsciiPunct(text[k + 1])) { k++; continue; }
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

function flanking(text, start, end) {
  // Start/end of the inline text act like a newline (whitespace) for
  // flanking purposes.
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
  let j = start;
  while (j < n) {
    const c = text[j];
    if (isAlpha(c) || isDigit(c) || c === '.' || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
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
    if (text[i] === '\\' && i + 1 < n) { i += 2; continue; }
    if (text[i] === '~') {
      let j = i;
      while (j < n && text[j] === '~') j++;
      if (j - i === len) {
        // Strikethrough uses the same flanking rules as emphasis: a run
        // preceded by punctuation (e.g. an escaped '~') and followed by a
        // letter can only open, not close.
        const { left, right } = flanking(text, i, j);
        const canClose = right;
        const canOpen = left;
        if (canClose) {
          if (depth === 0) return i;
          depth--;
        } else if (canOpen) {
          depth++;
        }
      }
      i = j;
    } else i++;
  }
  return -1;
}

// Parse inline content. plain=true renders plain text (image alt text).
function parseInline(text, refs, plain) {
  const n = text.length;
  const esc = plain ? escapeNoEncode : escapeText;
  const chunks = [];
  const chunkSrc = [];
  const delims = [];
  const brackets = [];
  const autoLinks = [];
  // Positions of every ']' encountered (for the link-text balance check:
  // a link/image only forms when its text has equal '[' and ']' counts).
  const closes = [];
  // Positions of backtick runs with no matching closer (an unclosed
  // backtick inside link text blocks the link from forming).
  const unclosedTicks = [];
  // Marked quirk: after a link whose text contains an unclosed backtick
  // run, emphasis delimiters are suppressed until the next backtick run.
  let suppressEmUntilTick = false;
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
  function rebuildDelim(d) {
    chunks[d.chunk] =
      d.closeTags.join('') + d.ch.repeat(d.len) + d.openTags.join('');
  }

  while (i < n) {
    const c = text[i];
    // Backslash escapes.
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        flushText(i);
        if (!plain) pushChunk('<br>', i);
        i += 2;
        while (i < n && isSpaceOrTab(text[i])) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(text[i + 1])) {
        flushText(i);
        pushChunk(esc(text[i + 1]), i);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Code spans.
    if (c === '`') {
      suppressEmUntilTick = false;
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
            if (ticks % 2 === 0) break;
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
        delims.push({
          chunk: chunkIdx, ch: c, len: runLen, canOpen, canClose,
          scope: 0, openTags: [], closeTags: [],
          dead: suppressEmUntilTick,
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
      if ((runLen === 1 || runLen === 2) && flanking(text, i, j).left) {
        const closer = findTildeCloser(text, j, runLen);
        if (closer !== -1) {
          flushText(i);
          const inner = parseInline(text.slice(j, closer), refs, plain);
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
        // Backtick parity: an ODD number of unclosed backtick runs in the
        // link text blocks the link (the ']' is inside a code span); an
        // even number does not.
        let tickCount = 0;
        for (const tp of unclosedTicks) {
          if (tp > br.srcPos && tp < i) tickCount++;
        }
        if (openCount === closeCount && tickCount % 2 === 0) {
        const linkTextRaw = text.slice(br.srcPos + 1, i);
        let href = null;
        let title = null;
        let endPos = -1;
        if (i + 1 < n && text[i + 1] === '(') {
          const il = parseInlineLink(text, i + 1);
          if (il) { href = il.href; title = il.title; endPos = il.end; }
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
          // Unclosed backtick in link text suppresses later emphasis
          // until the next backtick run (only when one exists later).
          if (!br.isImage) {
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
        // bracket so a later ']' cannot reuse it.
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
          pushChunk(
            `<a href="${cleanUrl(u.href)}">${escapeNoEncode(u.text)}</a>`, i);
          autoLinks.push({ chunk: chunkIdx, raw: u.text, extended: true, reverted: false });
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
  // Matched strong (use-2) pairs [openerIdx, closerIdx], for the blocking
  // rule below.
  const strongPairs = [];
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (closer.dead || closer.len === 0 || !closer.canClose) continue;
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
        if (closer.ch === '*' && !(closer.len >= 3 || use === 2)) {
          let blocked = false;
          for (const p of strongPairs) {
            if (oi < p[0] && p[1] < di) {
              const pop = delims[p[0]], pcl = delims[p[1]];
              if (!pop.dead && !pcl.dead && pcl.canOpen && !pop.canClose &&
                  pop.ch === '*') { blocked = true; break; }
            }
          }
          if (blocked) { oi--; continue; }
        }
        opener.len -= use;
        closer.len -= use;
        if (use === 1 && closer.canOpen) emSpans.push([oi, di, closer.ch]);
        if (use === 2) strongPairs.push([oi, di]);
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
  }

  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderItem(item, loose, refs, out) {
  out.push('<li>');
  const children = item.children;
  if (children.length === 0) {
    out.push('</li>\n');
    return;
  }
  for (let ci = 0; ci < children.length; ci++) {
    const ch = children[ci];
    if (ch.t === 'p') {
      const checkbox = ci === 0 && item.task
        ? `<input ${item.task === 'checked' ? 'checked="" ' : ''}disabled="" type="checkbox"> `
        : '';
      if (loose) {
        out.push('<p>', checkbox, parseInline(ch.text, refs, false), '</p>\n');
      } else {
        out.push(checkbox, parseInline(ch.text, refs, false));
      }
    } else {
      renderBlocks([ch], refs, out);
    }
  }
  out.push('</li>\n');
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
      case 'table': {
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
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  inLinkGlobal = false;
  const lines = splitLines(markdown);
  const refs = new Map();
  const blocks = parseBlocks(lines, refs);
  const out = [];
  renderBlocks(blocks, refs, out);
  return out.join('');
}
