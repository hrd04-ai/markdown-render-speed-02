// Driver for the make.fun "Make Markdown rendering faster" harness.
//
// The harness runs `node /bot/main.ts` (Node 22). The driver reads every
// case from /input/cases.json, renders each one on its own with parse()
// from parse.js, and writes /output/html.json: a JSON array of HTML
// strings, one per case, in the cases' order. Outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type InputCase = { id: string; markdown: string };

async function readCases(): Promise<InputCase[]> {
  const raw = await readFile(join(INPUT_DIR, 'cases.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return parsed as InputCase[];
}

async function writeOutputs(html: string[]): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
}

async function run(): Promise<void> {
  const cases = await readCases();
  const html: string[] = [];
  for (const c of cases) {
    // Render each case independently; parse() keeps no state between calls.
    html.push(parse(c.markdown));
  }
  await writeOutputs(html);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
