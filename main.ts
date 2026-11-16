// Driver for the make.fun "Make Markdown rendering faster" harness.
//
// The harness runs `node /bot/main.ts` under Node 22. This driver loads
// every case from /input/cases.json, renders each one independently with
// parse() from parse.js, and writes /output/html.json: a JSON array of
// HTML strings, one per case, in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.
//
// parse() keeps no state between calls, so the cases can be rendered in
// any order; the driver keeps the input order anyway, because the output
// array is positional.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface CaseInput {
  id: string;
  markdown: string;
}

// Load the case list. The shape is the harness's contract: an array of
// {id, markdown} objects. Anything else fails loudly here, before any
// rendering starts, instead of midway through the output.
async function loadCases(): Promise<CaseInput[]> {
  const raw = await readFile(join(INPUT_DIR, 'cases.json'), 'utf8');
  const decoded: unknown = JSON.parse(raw);
  if (!Array.isArray(decoded)) {
    throw new Error('cases.json is not an array');
  }
  return decoded as CaseInput[];
}

// Render every case to its HTML string, preserving input order.
function renderAll(cases: CaseInput[]): string[] {
  return cases.map((entry) => parse(entry.markdown));
}

// Write the rendered HTML array, creating the output directory first.
async function saveOutputs(html: string[]): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

async function main(): Promise<void> {
  const cases = await loadCases();
  const html = renderAll(cases);
  await saveOutputs(html);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
