// Entry driver for the make.fun "Make Markdown rendering faster" bounty.
//
// The grading harness launches `node /bot/main.ts` inside a container
// running Node 22. The driver pulls the case list out of the input
// directory, renders each case in isolation through parse(), and drops
// the resulting HTML strings — one per case, in input order — into the
// output directory as a JSON array. When the driver runs outside a
// container (local development, end-to-end checks), the environment
// variables MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for the
// container paths /input and /output.
//
// A deliberate property of the parser makes this driver trivially
// parallel-safe: parse() carries no state from one call to the next, so
// the cases may be rendered in any order and the output still lines up
// with the input. This driver renders them in input order regardless,
// because the output array is positional and there is no reason to
// shuffle work that is already fast.
//
// Diagnostics: `node main.ts --stats` (local runs only — the harness
// never passes flags) adds a stderr summary after the normal note:
// total input/output bytes, the output-to-input ratio, and the
// slowest single case with its render time. The stats path renders
// through a timed variant of the loop; the default path is untouched,
// so grading runs see exactly the same code as before.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

// Where the cases live and where the HTML goes. The harness mounts
// /input and /output; local runs point these elsewhere via the env.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// One case from the harness: an identifier plus the raw Markdown text.
interface CaseInput {
  id: string;
  markdown: string;
}

// The harness contract for a single case: both fields present, both
// strings. A malformed case fails the whole run up front, before any
// rendering starts, instead of producing a short or shifted output.
function isWellFormedCase(value: unknown): value is CaseInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; markdown?: unknown };
  return typeof candidate.id === 'string' &&
    typeof candidate.markdown === 'string';
}

// Load and validate the case list. The file must decode to an array,
// and every element must be a well-formed case; anything else is a
// loud failure at the door rather than a silent skew later.
async function loadCases(): Promise<CaseInput[]> {
  const raw = await readFile(join(INPUT_DIR, 'cases.json'), 'utf8');
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) {
    throw new Error('cases.json does not hold an array at the top level');
  }
  for (let i = 0; i < decoded.length; i++) {
    if (!isWellFormedCase(decoded[i])) {
      throw new Error(`cases.json entry ${i} is not a {id, markdown} case`);
    }
  }
  return decoded;
}

// Render the whole list. The map preserves input order, and each
// parse() call is independent, so a failure in one case aborts the
// run with the case's id attached to the error for triage.
function renderAll(cases: CaseInput[]): string[] {
  const html: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    try {
      html[i] = parse(cases[i].markdown);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`rendering case ${cases[i].id} failed: ${detail}`);
    }
  }
  return html;
}

// The slowest case of a timed run: its id and its render time in ms.
interface SlowestCase {
  id: string;
  ms: number;
}

// Timed variant of renderAll, used only in --stats mode: renders each
// case and records its wall time, returning the HTML plus the slowest
// case and the total render time. The error behaviour matches
// renderAll exactly (same message, same abort).
function renderTimed(cases: CaseInput[]): { html: string[]; slowest: SlowestCase; totalMs: number } {
  const html: string[] = new Array(cases.length);
  let slowest: SlowestCase = { id: '', ms: -1 };
  let totalMs = 0;
  for (let i = 0; i < cases.length; i++) {
    const started = process.hrtime.bigint();
    try {
      html[i] = parse(cases[i].markdown);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`rendering case ${cases[i].id} failed: ${detail}`);
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    totalMs += ms;
    if (ms > slowest.ms) slowest = { id: cases[i].id, ms };
  }
  return { html, slowest, totalMs };
}

// Total UTF-8 bytes of a string array.
function totalBytes(strings: string[]): number {
  let sum = 0;
  for (const s of strings) sum += Buffer.byteLength(s, 'utf8');
  return sum;
}

// Persist the rendered array, creating the output directory first so
// the write never fails on a missing folder. The file is exactly the
// JSON encoding of the string array — no trailing newline, no pretty
// printing — because the grader reads it back as JSON.
async function saveHtml(html: string[]): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

// How long the run took, in whole milliseconds, for the stderr note.
function elapsedMs(started: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6);
}

// --stats is a local-diagnostics flag; the harness never passes it,
// so the default path below is the grading path.
const STATS_MODE = process.argv.includes('--stats');

async function runDriver(): Promise<void> {
  const started = process.hrtime.bigint();
  const cases = await loadCases();
  if (STATS_MODE) {
    const { html, slowest, totalMs } = renderTimed(cases);
    await saveHtml(html);
    const inBytes = totalBytes(cases.map((c) => c.markdown));
    const outBytes = totalBytes(html);
    console.error(
      `main.ts: rendered ${cases.length} cases in ${elapsedMs(started)} ms`,
    );
    console.error(
      `main.ts stats: input ${inBytes} bytes, output ${outBytes} bytes ` +
      `(ratio ${(outBytes / Math.max(1, inBytes)).toFixed(2)}x), ` +
      `render ${totalMs.toFixed(1)} ms total, slowest case ` +
      `${slowest.id} at ${slowest.ms.toFixed(2)} ms`,
    );
    return;
  }
  const html = renderAll(cases);
  await saveHtml(html);
  console.error(
    `main.ts: rendered ${cases.length} cases in ${elapsedMs(started)} ms`,
  );
}

runDriver().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
