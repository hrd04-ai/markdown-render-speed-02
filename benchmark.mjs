// benchmark.mjs — correctness-first timing of parse.js against marked.
//
// Renders the kit's 720 practice cases with this entry's parse() and with
// the kit's vendored marked 18.1.3, then compares wall-clock totals. The
// correctness gate runs before any timing: a single byte difference voids
// the whole run, because a fast wrong renderer is not a renderer.
//
// Two timing styles are supported. Sequential (--runs) measures each engine
// in its own block of passes; interleaved (--interleaved) alternates the
// engines round by round, which cancels the slow drift of a shared,
// contended machine — on such a box the interleaved min-vs-min speedup is
// the number to trust, while sequential medians can swing by 2x between
// runs. Both styles report min/median/mean/p95 and the five slowest cases.
//
// Usage (from the entry directory):
//   node benchmark.mjs [--runs N] [--warmup N] [--interleaved N]
//                      [--json] [--report FILE] [--cases PATH] [--marked PATH]
//   --runs N        sequential timed passes per engine (default 5)
//   --warmup N      untimed warmup passes per engine (default 1)
//   --interleaved N interleaved rounds instead of sequential passes
//                   (each round times both engines once, back to back)
//   --json          print the report as JSON instead of prose
//   --report F      also write the JSON report to file F
//   --cases P       cases file (default: the kit's practice input)
//   --marked P      vendored marked module (default: the kit's baseline)
//
// The kit directory comes from MAKEFUN_KIT_DIR when set, else
// ../markdown-render-speed-02-kit relative to this file.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = process.env.MAKEFUN_KIT_DIR ??
  join(HERE, '..', 'markdown-render-speed-02-kit');

const USAGE =
  'usage: node benchmark.mjs [--runs N] [--warmup N] [--interleaved N] ' +
  '[--json] [--report FILE] [--cases PATH] [--marked PATH]';

// ---------------------------------------------------------------------------
// CLI parsing: a small flag table drives the whole parser.
// ---------------------------------------------------------------------------

// Each flag maps to its option key, whether it takes a value, and how to
// coerce that value (number flags fall back to their default on garbage).
const FLAG_TABLE = {
  '--runs': { key: 'runs', value: true, num: true, fallback: 5 },
  '--warmup': { key: 'warmup', value: true, num: true, fallback: 1 },
  '--interleaved': { key: 'interleaved', value: true, num: true, fallback: 0 },
  '--report': { key: 'report', value: true, num: false },
  '--cases': { key: 'cases', value: true, num: false },
  '--marked': { key: 'marked', value: true, num: false },
  '--json': { key: 'json', value: false },
  '--help': { key: 'help', value: false },
  '-h': { key: 'help', value: false },
};

function parseArgs(argv) {
  const opts = {
    runs: 5, warmup: 1, interleaved: 0,
    json: false, report: null, cases: null, marked: null,
  };
  for (let k = 0; k < argv.length; k++) {
    const spec = FLAG_TABLE[argv[k]];
    if (spec === undefined) throw new Error(`unknown argument: ${argv[k]} (see --help)`);
    if (spec.key === 'help') {
      console.log(USAGE);
      process.exit(0);
    }
    if (!spec.value) {
      opts[spec.key] = true;
      continue;
    }
    const raw = argv[++k];
    if (raw === undefined) throw new Error(`missing value for ${argv[k - 1]}`);
    opts[spec.key] = spec.num
      ? Math.max(0, Number(raw) || spec.fallback)
      : raw;
  }
  if (opts.runs < 1) opts.runs = 1;
  return opts;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// Load a JSON document, failing with a message that names the file.
function loadJson(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return JSON.parse(raw);
}

// Dynamically import the marked module and return its parse function.
async function loadMarked(path) {
  const mod = await import(path);
  const fn = mod.marked?.parse ?? mod.parse ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`no parse function in ${path}`);
  return (doc) => fn(doc);
}

// ---------------------------------------------------------------------------
// Statistics over a sample of millisecond timings.
// ---------------------------------------------------------------------------

// Sorted copy, ascending — every summary below reads from this one order.
function sortedCopy(values) {
  return values.slice().sort((a, b) => a - b);
}

// The p-th percentile by the nearest-rank rule.
function percentile(ordered, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ordered.length));
  return ordered[rank - 1];
}

// Round to two decimals for display; raw samples stay unrounded upstream.
function round2(x) {
  return Math.round(x * 100) / 100;
}

// Full summary of a timing sample: count, min, max, mean, median, p95,
// standard deviation, and the rounded samples themselves.
function summarize(samples) {
  const ordered = sortedCopy(samples);
  const count = ordered.length;
  const mid = Math.floor(count / 2);
  const median = count % 2 === 1
    ? ordered[mid]
    : (ordered[mid - 1] + ordered[mid]) / 2;
  const mean = samples.reduce((sum, t) => sum + t, 0) / count;
  const variance = samples.reduce((sum, t) => sum + (t - mean) ** 2, 0) / count;
  return {
    runs: count,
    minMs: round2(ordered[0]),
    maxMs: round2(ordered[count - 1]),
    meanMs: round2(mean),
    medianMs: round2(median),
    p95Ms: round2(percentile(ordered, 95)),
    stddevMs: round2(Math.sqrt(variance)),
    samplesMs: samples.map(round2),
  };
}

// ---------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------

// Wall-clock milliseconds for one full pass of `render` over `docs`.
function timePass(docs, render) {
  const started = process.hrtime.bigint();
  for (const doc of docs) render(doc);
  const finished = process.hrtime.bigint();
  return Number(finished - started) / 1e6;
}

// `reps` sequential passes; returns the list of per-pass timings.
function timeSequential(docs, render, reps) {
  const samples = [];
  for (let rep = 0; rep < reps; rep++) samples.push(timePass(docs, render));
  return samples;
}

// `rounds` interleaved rounds: each round times both engines once, mine
// first, so a slow drift of the machine hits both sides near-equally.
// Returns {mine, marked} sample lists.
function timeInterleaved(docs, mine, marked, rounds) {
  const mineSamples = [];
  const markedSamples = [];
  for (let round = 0; round < rounds; round++) {
    mineSamples.push(timePass(docs, mine));
    markedSamples.push(timePass(docs, marked));
  }
  return { mine: mineSamples, marked: markedSamples };
}

// ---------------------------------------------------------------------------
// Correctness gate + slowest-case probe
// ---------------------------------------------------------------------------

// Ids of every case whose two renderings differ (empty = identical).
function collectMismatches(docs, ids, mine, marked) {
  const bad = [];
  for (let idx = 0; idx < docs.length; idx++) {
    if (mine(docs[idx]) !== marked(docs[idx])) bad.push(ids[idx]);
  }
  return bad;
}

// The `count` slowest individual documents for `render`, slowest first.
function slowestCases(docs, ids, render, count) {
  const scored = docs.map((doc, idx) => {
    const started = process.hrtime.bigint();
    render(doc);
    const finished = process.hrtime.bigint();
    return { id: ids[idx], ms: Number(finished - started) / 1e6 };
  });
  scored.sort((a, b) => b.ms - a.ms);
  return scored.slice(0, count).map((s) => ({ id: s.id, ms: round2(s.ms) }));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// Human-readable report lines for a completed run.
function formatReport(report) {
  const lines = [];
  lines.push(
    `cases: ${report.cases} (${report.totalInputBytes} input bytes), ` +
    'all byte-identical to marked',
  );
  const mine = report.mine;
  const marked = report.marked;
  lines.push(
    `mine   : median ${mine.medianMs} ms (min ${mine.minMs}, ` +
    `max ${mine.maxMs}, p95 ${mine.p95Ms}, mean ${mine.meanMs}) ` +
    `over ${mine.runs} ${report.mode} ${mine.runs === 1 ? 'pass' : 'passes'}`,
  );
  lines.push(
    `marked : median ${marked.medianMs} ms (min ${marked.minMs}, ` +
    `max ${marked.maxMs}, p95 ${marked.p95Ms}, mean ${marked.meanMs}) ` +
    `over ${marked.runs} ${report.mode} ${marked.runs === 1 ? 'pass' : 'passes'}`,
  );
  lines.push(`speedup: ${report.speedupMedian}x (median vs median)`);
  if (report.speedupMin !== undefined) {
    lines.push(`speedup: ${report.speedupMin}x (min vs min)`);
  }
  lines.push(
    'slowest cases for this parser: ' +
    report.slowestMineMs.map((s) => `${s.id}=${s.ms}ms`).join(', '),
  );
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const casesPath = opts.cases ?? join(KIT_DIR, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = loadJson(casesPath);
  const docs = cases.map((entry) => entry.markdown);
  const ids = cases.map((entry) => entry.id);
  const renderMarked = await loadMarked(markedPath);

  // Gate: byte-identical output on every case, or the timing is void.
  const bad = collectMismatches(docs, ids, parse, renderMarked);
  if (bad.length > 0) {
    const failure = {
      ok: false,
      cases: docs.length,
      mismatches: bad.length,
      mismatchIds: bad.slice(0, 20),
    };
    if (opts.json) console.log(JSON.stringify(failure, null, 2));
    else {
      console.log(`CORRECTNESS FAIL: ${bad.length}/${docs.length} cases differ from marked`);
      console.log('first mismatches:', bad.slice(0, 20).join(', '));
    }
    process.exitCode = 1;
    return;
  }

  // Warmup (JIT + caches) before any timed pass.
  for (let w = 0; w < opts.warmup; w++) {
    timePass(docs, parse);
    timePass(docs, renderMarked);
  }

  let mineSamples;
  let markedSamples;
  let mode;
  if (opts.interleaved > 0) {
    const both = timeInterleaved(docs, parse, renderMarked, opts.interleaved);
    mineSamples = both.mine;
    markedSamples = both.marked;
    mode = 'interleaved';
  } else {
    mineSamples = timeSequential(docs, parse, opts.runs);
    markedSamples = timeSequential(docs, renderMarked, opts.runs);
    mode = 'sequential';
  }
  const mineSummary = summarize(mineSamples);
  const markedSummary = summarize(markedSamples);
  const totalInputBytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc, 'utf8'), 0);

  const report = {
    ok: true,
    mode,
    cases: docs.length,
    totalInputBytes,
    mine: mineSummary,
    marked: markedSummary,
    speedupMedian: round2(markedSummary.medianMs / mineSummary.medianMs),
    slowestMineMs: slowestCases(docs, ids, parse, 5),
    node: process.version,
  };
  if (mode === 'interleaved') {
    report.speedupMin = round2(markedSummary.minMs / mineSummary.minMs);
  }

  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatReport(report));
}

main().catch((err) => {
  console.error('benchmark failed:', err.message);
  process.exitCode = 1;
});
