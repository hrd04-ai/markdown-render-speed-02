// benchmark.mjs — time parse.js against the kit's vendored marked.
//
// The entry's renderer and marked 18.1.3 both render the kit's 720
// practice cases; this tool reports how much faster the entry is. A
// correctness gate runs first: if any case renders differently, the run
// stops before timing anything, because a fast renderer that disagrees
// with the baseline is not a renderer at all.
//
// Two measurement styles are available:
//   * sequential (--runs): each engine runs its passes in one block;
//   * interleaved (--interleaved): the engines alternate round by round,
//     so a slow drift of a shared machine hits both sides near-equally.
// On a contended box the interleaved min-vs-min speedup is the number to
// trust; sequential medians can swing by 2x between runs.
//
// Usage (from the entry directory):
//   node benchmark.mjs [--runs N] [--warmup N] [--interleaved N]
//                      [--json] [--report FILE] [--cases PATH] [--marked PATH]
//
//   --runs N        sequential timed passes per engine (default 5)
//   --warmup N      untimed warmup passes per engine (default 1)
//   --interleaved N interleaved rounds in place of sequential passes
//   --json          print the report as JSON instead of prose
//   --report F      also write the JSON report to file F
//   --cases P       cases file (default: the kit's practice input)
//   --marked P      vendored marked module (default: the kit's baseline)
//
// The kit directory comes from MAKEFUN_KIT_DIR when set, otherwise from
// ../markdown-render-speed-02-kit relative to this file.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parse.js';

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = process.env.MAKEFUN_KIT_DIR ??
  join(ENTRY_DIR, '..', 'markdown-render-speed-02-kit');

const USAGE_TEXT =
  'usage: node benchmark.mjs [--runs N] [--warmup N] [--interleaved N] ' +
  '[--json] [--report FILE] [--cases PATH] [--marked PATH]';

// ---------------------------------------------------------------------------
// Timing statistics: every summary reads from one ascending order.
// ---------------------------------------------------------------------------

// Round to two decimals for display. Raw samples stay unrounded upstream.
function roundHundredths(value) {
  return Math.round(value * 100) / 100;
}

// A sorted copy of the sample, ascending.
function ascending(values) {
  return values.slice().sort((left, right) => left - right);
}

// Median of an already-sorted sample.
function medianOf(ordered) {
  const count = ordered.length;
  const middle = Math.floor(count / 2);
  if (count % 2 === 1) return ordered[middle];
  return (ordered[middle - 1] + ordered[middle]) / 2;
}

// The p-th percentile of an already-sorted sample, nearest-rank rule.
function nearestRank(ordered, p) {
  const rank = Math.max(1, Math.ceil((p / 100) * ordered.length));
  return ordered[rank - 1];
}

// Full summary of a timing sample: count, min, max, mean, median, p95,
// standard deviation, and the rounded samples themselves.
function summarizeSamples(samples) {
  const ordered = ascending(samples);
  const count = ordered.length;
  const total = samples.reduce((sum, t) => sum + t, 0);
  const mean = total / count;
  const spread = samples.reduce((sum, t) => sum + (t - mean) ** 2, 0) / count;
  return {
    runs: count,
    minMs: roundHundredths(ordered[0]),
    maxMs: roundHundredths(ordered[count - 1]),
    meanMs: roundHundredths(mean),
    medianMs: roundHundredths(medianOf(ordered)),
    p95Ms: roundHundredths(nearestRank(ordered, 95)),
    stddevMs: roundHundredths(Math.sqrt(spread)),
    samplesMs: samples.map(roundHundredths),
  };
}

// ---------------------------------------------------------------------------
// CLI parsing: a small flag table drives the whole parser.
// ---------------------------------------------------------------------------

// Each flag maps to its option key, whether it takes a value, whether the
// value is numeric, and the fallback a numeric flag uses on garbage.
const CLI_FLAGS = {
  '--runs': { key: 'runs', takesValue: true, numeric: true, fallback: 5 },
  '--warmup': { key: 'warmup', takesValue: true, numeric: true, fallback: 1 },
  '--interleaved': { key: 'interleaved', takesValue: true, numeric: true, fallback: 0 },
  '--report': { key: 'report', takesValue: true, numeric: false },
  '--cases': { key: 'cases', takesValue: true, numeric: false },
  '--marked': { key: 'marked', takesValue: true, numeric: false },
  '--json': { key: 'json', takesValue: false },
  '--help': { key: 'help', takesValue: false },
  '-h': { key: 'help', takesValue: false },
};

function readOptions(argv) {
  const opts = {
    runs: 5, warmup: 1, interleaved: 0,
    json: false, report: null, cases: null, marked: null,
  };
  for (let pos = 0; pos < argv.length; pos++) {
    const spec = CLI_FLAGS[argv[pos]];
    if (spec === undefined) {
      throw new Error(`unknown argument: ${argv[pos]} (see --help)`);
    }
    if (spec.key === 'help') {
      console.log(USAGE_TEXT);
      process.exit(0);
    }
    if (!spec.takesValue) {
      opts[spec.key] = true;
      continue;
    }
    const raw = argv[++pos];
    if (raw === undefined) throw new Error(`missing value for ${argv[pos - 1]}`);
    opts[spec.key] = spec.numeric
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
function readJsonFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return JSON.parse(raw);
}

// Dynamically import the marked module and return its parse function.
async function importMarked(path) {
  const mod = await import(path);
  const fn = mod.marked?.parse ?? mod.parse ?? mod.default;
  if (typeof fn !== 'function') throw new Error(`no parse function in ${path}`);
  return (doc) => fn(doc);
}

// ---------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------

// Wall-clock milliseconds for one full pass of `render` over `docs`.
function timeOnePass(docs, render) {
  const started = process.hrtime.bigint();
  for (const doc of docs) render(doc);
  const finished = process.hrtime.bigint();
  return Number(finished - started) / 1e6;
}

// `reps` sequential passes; returns the list of per-pass timings.
function runSequential(docs, render, reps) {
  const samples = [];
  for (let rep = 0; rep < reps; rep++) samples.push(timeOnePass(docs, render));
  return samples;
}

// `rounds` interleaved rounds: each round times both engines once, mine
// first, so a slow drift of the machine hits both sides near-equally.
// Returns {mine, marked} sample lists.
function runInterleaved(docs, mine, marked, rounds) {
  const mineSamples = [];
  const markedSamples = [];
  for (let round = 0; round < rounds; round++) {
    mineSamples.push(timeOnePass(docs, mine));
    markedSamples.push(timeOnePass(docs, marked));
  }
  return { mine: mineSamples, marked: markedSamples };
}

// ---------------------------------------------------------------------------
// Correctness gate + slowest-case probe
// ---------------------------------------------------------------------------

// Ids of every case whose two renderings differ (empty = identical).
function findMismatches(docs, ids, mine, marked) {
  const bad = [];
  for (let idx = 0; idx < docs.length; idx++) {
    if (mine(docs[idx]) !== marked(docs[idx])) bad.push(ids[idx]);
  }
  return bad;
}

// The `count` slowest individual documents for `render`, slowest first.
function slowestDocs(docs, ids, render, count) {
  const scored = docs.map((doc, idx) => {
    const started = process.hrtime.bigint();
    render(doc);
    const finished = process.hrtime.bigint();
    return { id: ids[idx], ms: Number(finished - started) / 1e6 };
  });
  scored.sort((a, b) => b.ms - a.ms);
  return scored.slice(0, count).map((s) => ({ id: s.id, ms: roundHundredths(s.ms) }));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// One engine's summary line for the prose report.
function engineLine(tag, summary, mode) {
  const passes = summary.runs === 1 ? 'pass' : 'passes';
  return (
    `${tag} : median ${summary.medianMs} ms (min ${summary.minMs}, ` +
    `max ${summary.maxMs}, p95 ${summary.p95Ms}, mean ${summary.meanMs}) ` +
    `over ${summary.runs} ${mode} ${passes}`
  );
}

// Human-readable report lines for a completed run.
function renderReport(report) {
  const lines = [];
  lines.push(
    `cases: ${report.cases} (${report.totalInputBytes} input bytes), ` +
    'all byte-identical to marked',
  );
  lines.push(engineLine('mine  ', report.mine, report.mode));
  lines.push(engineLine('marked', report.marked, report.mode));
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

// The JSON object printed (or written) when the gate fails.
function failureReport(docCount, badIds) {
  return {
    ok: false,
    cases: docCount,
    mismatches: badIds.length,
    mismatchIds: badIds.slice(0, 20),
  };
}

async function run() {
  const opts = readOptions(process.argv.slice(2));
  const casesPath = opts.cases ?? join(KIT_ROOT, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_ROOT, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = readJsonFile(casesPath);
  const docs = cases.map((entry) => entry.markdown);
  const ids = cases.map((entry) => entry.id);
  const renderMarked = await importMarked(markedPath);

  // Gate: byte-identical output on every case, or the timing is void.
  const bad = findMismatches(docs, ids, parse, renderMarked);
  if (bad.length > 0) {
    if (opts.json) {
      console.log(JSON.stringify(failureReport(docs.length, bad), null, 2));
    } else {
      console.log(`CORRECTNESS FAIL: ${bad.length}/${docs.length} cases differ from marked`);
      console.log('first mismatches:', bad.slice(0, 20).join(', '));
    }
    process.exitCode = 1;
    return;
  }

  // Warmup (JIT + caches) before any timed pass.
  for (let w = 0; w < opts.warmup; w++) {
    timeOnePass(docs, parse);
    timeOnePass(docs, renderMarked);
  }

  let mineSamples;
  let markedSamples;
  let mode;
  if (opts.interleaved > 0) {
    const both = runInterleaved(docs, parse, renderMarked, opts.interleaved);
    mineSamples = both.mine;
    markedSamples = both.marked;
    mode = 'interleaved';
  } else {
    mineSamples = runSequential(docs, parse, opts.runs);
    markedSamples = runSequential(docs, renderMarked, opts.runs);
    mode = 'sequential';
  }
  const mineSummary = summarizeSamples(mineSamples);
  const markedSummary = summarizeSamples(markedSamples);
  const totalInputBytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc, 'utf8'), 0);

  const report = {
    ok: true,
    mode,
    cases: docs.length,
    totalInputBytes,
    mine: mineSummary,
    marked: markedSummary,
    speedupMedian: roundHundredths(markedSummary.medianMs / mineSummary.medianMs),
    slowestMineMs: slowestDocs(docs, ids, parse, 5),
    node: process.version,
  };
  if (mode === 'interleaved') {
    report.speedupMin = roundHundredths(markedSummary.minMs / mineSummary.minMs);
  }

  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderReport(report));
}

run().catch((err) => {
  console.error('benchmark failed:', err.message);
  process.exitCode = 1;
});
