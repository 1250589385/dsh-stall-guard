/**
 * Report locale keys that exist in one dictionary but not the other.
 *
 * Run by hand while editing; `test/check-locale.mjs` is the assertion version. This one
 * prints the exact key names so a missing translation can be added without diffing two
 * large object literals by eye.
 */

import fs from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const file = process.argv[2] ?? 'client.js';
const src = fs.readFileSync(file, 'utf8');

function objectAfter(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  let inString = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (inString !== null) {
      if (ch === BACKSLASH) { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced object after ${marker}`);
}

/* eslint-disable no-eval */
const en = eval(`(${objectAfter('const en = {')})`);
const zh = eval(`(${objectAfter('const zh = {')})`);

const onlyEn = Object.keys(en).filter((key) => !(key in zh));
const onlyZh = Object.keys(zh).filter((key) => !(key in en));

console.log(`en: ${Object.keys(en).length} keys, zh: ${Object.keys(zh).length} keys`);
if (onlyEn.length === 0 && onlyZh.length === 0) {
  console.log('in parity');
  process.exit(0);
}

if (onlyEn.length > 0) {
  console.log('\nmissing in zh:');
  for (const key of onlyEn) console.log(`  ${key}: ${JSON.stringify(en[key])}`);
}
if (onlyZh.length > 0) {
  console.log('\nmissing in en:');
  for (const key of onlyZh) console.log(`  ${key}: ${JSON.stringify(zh[key])}`);
}
process.exit(1);
