// benchmark.mjs — how fast is parse.js next to the kit's marked?
//
// Both engines render the kit's 720 practice cases and this tool
// reports the speedup. Nothing is timed until a correctness gate has
// passed: every case must render byte-identical to marked, because a
// fast renderer that disagrees with the baseline is not a renderer.
//
// Two measurement styles:
//   * sequential (--runs): each engine runs its passes back to back;
//   * interleaved (--interleaved): the engines alternate round by
//     round, so a slow drift of a shared machine lands on both sides
//     near-equally. On a contended box the interleaved min-vs-min
//     speedup is the number to trust; sequential medians can swing
//     by 2x between runs on the same code.
//
// Extra reporting beyond the headline speedup: the slowest individual
// cases for each engine (--slowest N), overall throughput in
// cases/second and MiB/second, and the heap growth across the timed
// passes (a parser that leaks shows up here before it shows up in
// wall-clock time).
//
// Usage (from the entry directory):
//   node benchmark.mjs [--runs N] [--warmup N] [--interleaved N]
//                      [--slowest N] [--per-case N] [--json] [--report FILE]
//                      [--cases PATH] [--marked PATH]
//
//   --runs N        sequential timed passes per engine (default 5)
//   --warmup N      untimed warmup passes per engine (default 1)
//   --interleaved N interleaved rounds instead of sequential passes
//   --slowest N     slowest cases to list per engine (default 5)
//   --per-case N    also list the N cases where this parser is
//                   slowest RELATIVE to marked (lowest speedup first);
//                   0 disables (default 0)
//   --json          print the report as JSON instead of prose
//   --report F      also write the JSON report to file F
//   --cases P       cases file (default: the kit's practice input)
//   --marked P      vendored marked module (default: the kit's baseline)
//
// The kit directory comes from MAKEFUN_KIT_DIR when set, otherwise from
// ../markdown-render-speed-02-kit relative to this file.
//
// Reading the report: the headline is the speedup line — median
// vs median in sequential mode, plus min vs min in interleaved mode.
// The min-vs-min number is the one the competition cares about,
// because the grader's timing is a single timed run per engine and
// the minimum observed time is the closest thing to the engine's
// true speed on a quiet machine. A median/min gap of more than ~20%
// on either engine means the box was noisy during the run; re-run
// with more interleaved rounds before trusting the number.
//   * The per-engine summary lines carry the full distribution
//     (median, min, max, p95, mean, trimmed mean) so a single
//     lucky or unlucky pass cannot hide behind an average.
//   * The throughput lines translate the medians into cases per
//     second and MiB per second, which is the form that makes
//     sense when the question is "how long would a million
//     documents take?" rather than "how much faster is it?".
//   * The slowest-cases lines name the individual documents each
//     engine finds hardest; when the two lists share a case, that
//     case is genuinely hard for both, and when they diverge, the
//     divergence points at an algorithmic difference worth
//     understanding (a pathological nesting depth, a huge table).
//   * The per-case comparison (--per-case) inverts the question:
//     instead of the slowest absolute cases, it lists the cases
//     where this parser's advantage is smallest. A ratio under 1
//     means marked won that case outright — the first place to
//     look when the headline speedup needs to grow.
//   * Heap growth is the canary: a few hundred KiB across the
//     timed passes is normal (the output strings are retained by
//     the timing loop), but growth in the megabytes means the
//     parser is retaining state between calls, which would also
//     show up as nondeterminism in the fuzzer.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parse.js';

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = process.env.MAKEFUN_KIT_DIR ??
  join(ENTRY_DIR, '..', 'markdown-render-speed-02-kit');

const HELP_TEXT =
  'usage: node benchmark.mjs [--runs N] [--warmup N] [--interleaved N] ' +
  '[--slowest N] [--per-case N] [--json] [--report FILE] [--cases PATH] [--marked PATH]';

// ---------------------------------------------------------------------------
// Sample statistics. Every summary derives from one ascending sort.
// ---------------------------------------------------------------------------

// Two-decimal rounding for display; raw samples stay unrounded upstream.
function toHundredths(value) {
  return Math.round(value * 100) / 100;
}

// An ascending copy of the sample.
function sortAscending(values) {
  return [...values].sort((a, b) => a - b);
}

// Median of a sample that is already sorted ascending.
function medianSorted(ordered) {
  const n = ordered.length;
  const mid = n >> 1;
  return n % 2 === 1 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
}

// Nearest-rank percentile of an already-sorted sample.
function percentileSorted(ordered, pct) {
  const rank = Math.max(1, Math.ceil((pct / 100) * ordered.length));
  return ordered[rank - 1];
}

// Interquartile range of an already-sorted sample.
function iqrSorted(ordered) {
  return percentileSorted(ordered, 75) - percentileSorted(ordered, 25);
}

// Trimmed mean: drop the lowest and highest 10% (at least one value
// each side when the sample is big enough), then average the rest.
function trimmedMean(ordered) {
  const n = ordered.length;
  const trim = n >= 10 ? Math.floor(n * 0.1) : 0;
  const kept = ordered.slice(trim, n - trim);
  return kept.reduce((sum, t) => sum + t, 0) / kept.length;
}

// Full description of a timing sample: count, extremes, mean, median,
// trimmed mean, p95, IQR, standard deviation, and the rounded samples.
function describeSample(samples) {
  const ordered = sortAscending(samples);
  const n = ordered.length;
  const total = samples.reduce((sum, t) => sum + t, 0);
  const mean = total / n;
  const variance = samples.reduce((sum, t) => sum + (t - mean) ** 2, 0) / n;
  return {
    runs: n,
    minMs: toHundredths(ordered[0]),
    maxMs: toHundredths(ordered[n - 1]),
    meanMs: toHundredths(mean),
    trimmedMeanMs: toHundredths(trimmedMean(ordered)),
    medianMs: toHundredths(medianSorted(ordered)),
    p95Ms: toHundredths(percentileSorted(ordered, 95)),
    iqrMs: toHundredths(iqrSorted(ordered)),
    stddevMs: toHundredths(Math.sqrt(variance)),
    samplesMs: samples.map(toHundredths),
  };
}

// ---------------------------------------------------------------------------
// CLI parsing. Each entry describes one flag: the option it fills,
// whether it consumes the next argument, and how to coerce that value.
// ---------------------------------------------------------------------------

const FLAG_SPECS = [
  { flag: '--runs', key: 'runs', value: true, parse: (s) => Math.max(1, Number(s) || 5) },
  { flag: '--warmup', key: 'warmup', value: true, parse: (s) => Math.max(0, Number(s) || 1) },
  { flag: '--interleaved', key: 'interleaved', value: true, parse: (s) => Math.max(0, Number(s) || 0) },
  { flag: '--slowest', key: 'slowest', value: true, parse: (s) => Math.max(0, Number(s) || 5) },
  { flag: '--per-case', key: 'perCase', value: true, parse: (s) => Math.max(0, Number(s) || 0) },
  { flag: '--report', key: 'report', value: true, parse: (s) => s },
  { flag: '--cases', key: 'cases', value: true, parse: (s) => s },
  { flag: '--marked', key: 'marked', value: true, parse: (s) => s },
  { flag: '--json', key: 'json', value: false },
  { flag: '--help', key: 'help', value: false },
  { flag: '-h', key: 'help', value: false },
];

function parseCli(argv) {
  const opts = {
    runs: 5, warmup: 1, interleaved: 0, slowest: 5, perCase: 0,
    json: false, report: null, cases: null, marked: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const spec = FLAG_SPECS.find((entry) => entry.flag === argv[i]);
    if (spec === undefined) {
      throw new Error(`unknown argument: ${argv[i]} (see --help)`);
    }
    if (spec.key === 'help') {
      console.log(HELP_TEXT);
      process.exit(0);
    }
    if (!spec.value) {
      opts[spec.key] = true;
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`missing value for ${argv[i]}`);
    opts[spec.key] = spec.parse(raw);
    i++;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// Load a JSON document; the error names the file that failed.
function loadJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return JSON.parse(text);
}

// Import the marked module and return a (doc) => html function.
async function loadMarked(path) {
  const mod = await import(path);
  const render = mod.marked?.parse ?? mod.parse ?? mod.default;
  if (typeof render !== 'function') {
    throw new Error(`no parse function in ${path}`);
  }
  return (doc) => render(doc);
}

// ---------------------------------------------------------------------------
// Timing primitives
// ---------------------------------------------------------------------------

// Wall-clock milliseconds for one full pass of `render` over `docs`.
function timePass(docs, render) {
  const start = process.hrtime.bigint();
  for (const doc of docs) render(doc);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// `reps` sequential passes; returns the per-pass timings.
function sequentialPasses(docs, render, reps) {
  const samples = [];
  for (let rep = 0; rep < reps; rep++) samples.push(timePass(docs, render));
  return samples;
}

// `rounds` interleaved rounds: each round times both engines once,
// mine first, so machine drift hits both sides near-equally.
function interleavedRounds(docs, mine, marked, rounds) {
  const mineSamples = [];
  const markedSamples = [];
  for (let round = 0; round < rounds; round++) {
    mineSamples.push(timePass(docs, mine));
    markedSamples.push(timePass(docs, marked));
  }
  return { mine: mineSamples, marked: markedSamples };
}

// Heap bytes in use right now (heapUsed from the process report).
function heapNow() {
  return process.memoryUsage().heapUsed;
}

// ---------------------------------------------------------------------------
// Correctness gate + slowest-case probe
// ---------------------------------------------------------------------------

// Ids of every case whose two renderings differ (empty = identical).
function collectMismatches(docs, ids, mine, marked) {
  const bad = [];
  for (let i = 0; i < docs.length; i++) {
    if (mine(docs[i]) !== marked(docs[i])) bad.push(ids[i]);
  }
  return bad;
}

// The `count` slowest individual documents for `render`, slowest first.
function slowestDocuments(docs, ids, render, count) {
  const timed = docs.map((doc, i) => {
    const start = process.hrtime.bigint();
    render(doc);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { id: ids[i], ms: toHundredths(ms) };
  });
  timed.sort((a, b) => b.ms - a.ms);
  return timed.slice(0, count);
}

// Time one document three times and keep the fastest run (the min is
// the least noisy estimate for a single tiny render).
function timeOneMin(doc, render) {
  let best = Infinity;
  for (let rep = 0; rep < 3; rep++) {
    const start = process.hrtime.bigint();
    render(doc);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

// The `count` cases where this parser is slowest RELATIVE to marked:
// per-case min times for both engines, sorted by speedup ascending
// (worst cases first). A ratio below 1 means marked wins that case —
// those are the cases worth profiling when the headline speedup
// needs to grow.
function perCaseComparison(docs, ids, mine, marked, count) {
  const rows = docs.map((doc, i) => {
    const mineMs = timeOneMin(doc, mine);
    const markedMs = timeOneMin(doc, marked);
    return {
      id: ids[i],
      mineMs: toHundredths(mineMs),
      markedMs: toHundredths(markedMs),
      speedup: toHundredths(markedMs / mineMs),
    };
  });
  rows.sort((a, b) => a.speedup - b.speedup);
  return rows.slice(0, count);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// One engine's summary line for the prose report.
function summaryLine(tag, summary, mode) {
  const noun = summary.runs === 1 ? 'pass' : 'passes';
  return (
    `${tag} : median ${summary.medianMs} ms (min ${summary.minMs}, ` +
    `max ${summary.maxMs}, p95 ${summary.p95Ms}, mean ${summary.meanMs}, ` +
    `trimmed ${summary.trimmedMeanMs}) over ${summary.runs} ${mode} ${noun}`
  );
}

// Cases per second and MiB per second at the median pass time.
function throughputLine(tag, summary, caseCount, inputBytes) {
  const seconds = summary.medianMs / 1000;
  const casesPerSec = Math.round(caseCount / seconds);
  const mibPerSec = toHundredths(inputBytes / 1048576 / seconds);
  return `${tag} : ${casesPerSec} cases/s, ${mibPerSec} MiB/s at median`;
}

// Human-readable report lines for a completed run.
function proseReport(report) {
  const lines = [];
  lines.push(
    `cases: ${report.cases} (${report.totalInputBytes} input bytes), ` +
    'all byte-identical to marked',
  );
  lines.push(summaryLine('mine  ', report.mine, report.mode));
  lines.push(summaryLine('marked', report.marked, report.mode));
  lines.push(throughputLine('mine  ', report.mine, report.cases, report.totalInputBytes));
  lines.push(throughputLine('marked', report.marked, report.cases, report.totalInputBytes));
  lines.push(`speedup: ${report.speedupMedian}x (median vs median)`);
  if (report.speedupMin !== undefined) {
    lines.push(`speedup: ${report.speedupMin}x (min vs min)`);
  }
  lines.push(`heap growth over timed passes: ${report.heapGrowthKiB} KiB`);
  const slowMine = report.slowestMine.map((s) => `${s.id}=${s.ms}ms`).join(', ');
  const slowMarked = report.slowestMarked.map((s) => `${s.id}=${s.ms}ms`).join(', ');
  lines.push(`slowest cases for this parser: ${slowMine}`);
  lines.push(`slowest cases for marked: ${slowMarked}`);
  if (report.perCase && report.perCase.length > 0) {
    const rows = report.perCase.map(
      (r) => `${r.id}: ${r.mineMs}ms vs ${r.markedMs}ms (${r.speedup}x)`,
    );
    lines.push('worst relative cases (lowest speedup first):');
    for (const row of rows) lines.push(`  ${row}`);
  }
  return lines.join('\n');
}

// The JSON object printed (or written) when the gate fails.
function gateFailureReport(docCount, badIds) {
  return {
    ok: false,
    cases: docCount,
    mismatches: badIds.length,
    mismatchIds: badIds.slice(0, 20),
  };
}

async function run() {
  const opts = parseCli(process.argv.slice(2));
  const casesPath = opts.cases ?? join(KIT_ROOT, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_ROOT, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = loadJson(casesPath);
  const docs = cases.map((entry) => entry.markdown);
  const ids = cases.map((entry) => entry.id);
  const renderMarked = await loadMarked(markedPath);

  // Gate: byte-identical output on every case, or the timing is void.
  const bad = collectMismatches(docs, ids, parse, renderMarked);
  if (bad.length > 0) {
    if (opts.json) {
      console.log(JSON.stringify(gateFailureReport(docs.length, bad), null, 2));
    } else {
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

  const heapBefore = heapNow();
  let mineSamples;
  let markedSamples;
  let mode;
  if (opts.interleaved > 0) {
    const both = interleavedRounds(docs, parse, renderMarked, opts.interleaved);
    mineSamples = both.mine;
    markedSamples = both.marked;
    mode = 'interleaved';
  } else {
    mineSamples = sequentialPasses(docs, parse, opts.runs);
    markedSamples = sequentialPasses(docs, renderMarked, opts.runs);
    mode = 'sequential';
  }
  const heapGrowthKiB = Math.round((heapNow() - heapBefore) / 1024);
  const mineSummary = describeSample(mineSamples);
  const markedSummary = describeSample(markedSamples);
  const totalInputBytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc, 'utf8'), 0);

  const report = {
    ok: true,
    mode,
    cases: docs.length,
    totalInputBytes,
    mine: mineSummary,
    marked: markedSummary,
    speedupMedian: toHundredths(markedSummary.medianMs / mineSummary.medianMs),
    slowestMine: slowestDocuments(docs, ids, parse, opts.slowest),
    slowestMarked: slowestDocuments(docs, ids, renderMarked, opts.slowest),
    heapGrowthKiB,
    node: process.version,
  };
  if (mode === 'interleaved') {
    report.speedupMin = toHundredths(markedSummary.minMs / mineSummary.minMs);
  }
  if (opts.perCase > 0) {
    report.perCase = perCaseComparison(docs, ids, parse, renderMarked, opts.perCase);
  }

  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(proseReport(report));
}

run().catch((err) => {
  console.error('benchmark failed:', err.message);
  process.exitCode = 1;
});
