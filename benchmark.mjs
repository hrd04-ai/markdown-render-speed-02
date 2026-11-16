// benchmark.mjs — timing + correctness report for parse.js vs marked.
//
// Compares this entry's parse() against the kit's vendored marked 18.1.3
// over the 720 practice cases. Correctness is checked FIRST: if any case
// differs from marked's output, the run is rejected and no timing is
// reported, because a fast wrong renderer is not a renderer.
//
// Usage (from the entry directory):
//   node benchmark.mjs [--runs N] [--warmup N] [--json] [--report FILE]
//                      [--cases PATH] [--marked PATH]
//   --runs N     timed repetitions per implementation (default 5)
//   --warmup N   untimed warmup repetitions (default 1)
//   --json       print the report as JSON instead of human text
//   --report F   also write the JSON report to file F
//   --cases P    cases file (default: the kit's practice input)
//   --marked P   vendored marked module (default: the kit's baseline)
//
// The paths default to this checkout's kit layout; override them with the
// flags (or the MAKEFUN_KIT_DIR environment variable) when the kit lives
// somewhere else.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_DIR = process.env.MAKEFUN_KIT_DIR ??
  join(HERE, '..', 'markdown-render-speed-02-kit');

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

// Read and parse a JSON file, with a readable error when it is missing.
function readJsonDocument(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return JSON.parse(raw);
}

// Median of a numeric array (the array is sorted in place).
function medianOf(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid];
  return (ordered[mid - 1] + ordered[mid]) / 2;
}

// The p-th percentile of a numeric array (nearest-rank method).
function percentileOf(values, p) {
  const ordered = values.slice().sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * ordered.length));
  return ordered[rank - 1];
}

// Summarise a list of per-run millisecond timings.
function summariseTimings(samples) {
  const rounded = samples.map((t) => Math.round(t * 100) / 100);
  return {
    runs: samples.length,
    medianMs: Math.round(medianOf(samples) * 100) / 100,
    minMs: Math.round(Math.min(...samples) * 100) / 100,
    maxMs: Math.round(Math.max(...samples) * 100) / 100,
    p95Ms: Math.round(percentileOf(samples, 95) * 100) / 100,
    samplesMs: rounded,
  };
}

// Time one full pass of `render` over every document, in milliseconds.
function timeOnePass(documents, render) {
  const started = process.hrtime.bigint();
  for (const doc of documents) render(doc);
  const finished = process.hrtime.bigint();
  return Number(finished - started) / 1e6;
}

// Run `render` over every document `reps` times and collect the timings.
function timeRepeatedly(documents, render, reps) {
  const samples = [];
  for (let rep = 0; rep < reps; rep++) samples.push(timeOnePass(documents, render));
  return samples;
}

// Parse `--flag value` / `--flag` arguments into an options object.
function parseCliArguments(argv) {
  const opts = { runs: 5, warmup: 1, json: false, report: null, cases: null, marked: null };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--json') opts.json = true;
    else if (arg === '--runs') opts.runs = Math.max(1, Number(argv[++k]) || 5);
    else if (arg === '--warmup') opts.warmup = Math.max(0, Number(argv[++k]) || 0);
    else if (arg === '--report') opts.report = argv[++k] ?? null;
    else if (arg === '--cases') opts.cases = argv[++k] ?? null;
    else if (arg === '--marked') opts.marked = argv[++k] ?? null;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node benchmark.mjs [--runs N] [--warmup N] [--json] [--report FILE] [--cases PATH] [--marked PATH]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg} (see --help)`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Correctness gate + benchmark
// ---------------------------------------------------------------------------

// Check every case against marked. Returns the list of mismatching case ids
// (empty when the entry is byte-identical on the whole set).
function findMismatches(documents, ids, renderMine, renderMarked) {
  const bad = [];
  for (let idx = 0; idx < documents.length; idx++) {
    const mine = renderMine(documents[idx]);
    const theirs = renderMarked(documents[idx]);
    if (mine !== theirs) bad.push(ids[idx]);
  }
  return bad;
}

// The slowest individual cases for our renderer: useful when a regression
// hides in one pathological document rather than the whole set.
function slowestDocuments(documents, ids, render, count) {
  const scored = [];
  for (let idx = 0; idx < documents.length; idx++) {
    const started = process.hrtime.bigint();
    render(documents[idx]);
    const finished = process.hrtime.bigint();
    scored.push({ id: ids[idx], ms: Number(finished - started) / 1e6 });
  }
  scored.sort((a, b) => b.ms - a.ms);
  return scored.slice(0, count).map((s) => ({ id: s.id, ms: Math.round(s.ms * 100) / 100 }));
}

async function runBenchmark() {
  const opts = parseCliArguments(process.argv.slice(2));
  const casesPath = opts.cases ?? join(KIT_DIR, 'practice', 'input', 'cases.json');
  const markedPath = opts.marked ?? join(KIT_DIR, 'baselines', 'vendor', 'marked', 'marked.esm.js');
  const cases = readJsonDocument(casesPath);
  const documents = cases.map((entry) => entry.markdown);
  const ids = cases.map((entry) => entry.id);
  const markedModule = await import(markedPath);
  const renderMarked = (doc) => markedModule.marked.parse(doc);

  // Gate 1: byte-identical output on every case, or the timing is void.
  const mismatches = findMismatches(documents, ids, parse, renderMarked);
  if (mismatches.length > 0) {
    const report = {
      ok: false,
      cases: documents.length,
      mismatches: mismatches.length,
      mismatchIds: mismatches.slice(0, 20),
    };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`CORRECTNESS FAIL: ${mismatches.length}/${documents.length} cases differ from marked`);
      console.log('first mismatches:', mismatches.slice(0, 20).join(', '));
    }
    process.exitCode = 1;
    return;
  }

  // Warmup (JIT + caches), then the timed repetitions.
  for (let w = 0; w < opts.warmup; w++) {
    timeOnePass(documents, parse);
    timeOnePass(documents, renderMarked);
  }
  const mineSummary = summariseTimings(timeRepeatedly(documents, parse, opts.runs));
  const markedSummary = summariseTimings(timeRepeatedly(documents, renderMarked, opts.runs));
  const speedup = markedSummary.medianMs / mineSummary.medianMs;
  const slowest = slowestDocuments(documents, ids, parse, 5);
  const totalInputBytes = documents.reduce((sum, doc) => sum + Buffer.byteLength(doc, 'utf8'), 0);

  const report = {
    ok: true,
    cases: documents.length,
    totalInputBytes,
    mine: mineSummary,
    marked: markedSummary,
    speedupMedian: Math.round(speedup * 100) / 100,
    slowestMineMs: slowest,
    node: process.version,
  };

  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`cases: ${documents.length} (${totalInputBytes} input bytes), all byte-identical to marked`);
  console.log(`mine   : median ${mineSummary.medianMs} ms (min ${mineSummary.minMs}, max ${mineSummary.maxMs}, p95 ${mineSummary.p95Ms}) over ${opts.runs} runs`);
  console.log(`marked : median ${markedSummary.medianMs} ms (min ${markedSummary.minMs}, max ${markedSummary.maxMs}, p95 ${markedSummary.p95Ms}) over ${opts.runs} runs`);
  console.log(`speedup: ${report.speedupMedian}x (median vs median)`);
  console.log('slowest cases for this parser:', slowest.map((s) => `${s.id}=${s.ms}ms`).join(', '));
}

runBenchmark().catch((err) => {
  console.error('benchmark failed:', err.message);
  process.exitCode = 1;
});
