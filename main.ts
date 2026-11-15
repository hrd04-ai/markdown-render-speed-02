// Driver for the make.fun "Make Markdown rendering faster" harness.
// The harness runs `node /bot/main.ts` (Node 22): read every case from
// /input/cases.json, render each alone with parse() from parse.js, and
// write /output/html.json — a JSON array of HTML strings, one per case,
// in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'),
) as Case[];

// Render each case independently; parse() keeps no state between calls.
const html = new Array<string>(cases.length);
for (let k = 0; k < cases.length; k++) html[k] = parse(cases[k].markdown);

writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
