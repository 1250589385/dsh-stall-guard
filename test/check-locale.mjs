/**
 * Locale parity check for the Client half.
 *
 * The dictionaries live inside a `require`-style browser module, so they cannot be
 * imported by Node. This script cuts them out by brace matching and compares them, which
 * is the only way to catch a key that exists in one language but not the other before a
 * user sees a raw key on screen.
 */

import fs from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const src = fs.readFileSync(process.argv[2] ?? 'client.js', 'utf8');

/** Cut a balanced object literal starting at the first `{` after `marker`. */
function objectAfter(marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  let inString = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (inString !== null) {
      if (ch === BACKSLASH) {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced object after ${marker}`);
}

const enSource = objectAfter('const en = {');
const zhSource = objectAfter('const zh = {');

/* eslint-disable no-eval */
const en = eval(`(${enSource})`);
const zh = eval(`(${zhSource})`);

const enKeys = Object.keys(en);
const zhKeys = Object.keys(zh);
const onlyEn = enKeys.filter((key) => !(key in zh));
const onlyZh = zhKeys.filter((key) => !(key in en));

const used = new Set();
for (const match of src.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)) used.add(match[1]);

/**
 * Prefixes that are completed at call time (`t('kind' + Kind)`, `t('display' + Name)`).
 * Their concrete keys are checked separately, so the bare prefix is not a missing key.
 */
const PREFIXES = new Set(['kind', 'display', 'presetScene']);
const prefixed = [...used].filter((key) => PREFIXES.has(key));
const concrete = [...used].filter((key) => !PREFIXES.has(key));

/** Every kind and display must resolve in both dictionaries. */
const KINDS = ['Fetch', 'Search', 'Read', 'Write', 'Exec', 'Long', 'Other'];
const DISPLAYS = ['Dot', 'Icon', 'Avatar'];
const SCENES = ['Download', 'Fetch', 'Search'];
const dynamic = [
  ...KINDS.map((name) => `kind${name}`),
  ...DISPLAYS.map((name) => `display${name}`),
  ...SCENES.map((name) => `presetScene${name}`),
];
const dynamicMissingEn = dynamic.filter((key) => !(key in en));
const dynamicMissingZh = dynamic.filter((key) => !(key in zh));

const missingEn = [...concrete].filter((key) => !(key in en));
const missingZh = [...concrete].filter((key) => !(key in zh));

console.log(`en keys: ${enKeys.length}   zh keys: ${zhKeys.length}`);
console.log(`only in en: ${onlyEn.length === 0 ? 'none' : onlyEn.join(', ')}`);
console.log(`only in zh: ${onlyZh.length === 0 ? 'none' : onlyZh.join(', ')}`);
console.log(`used literal keys: ${used.size} (${prefixed.length} prefix + ${concrete.length} concrete + ${dynamic.length} dynamic)`);
console.log(`used but missing in en: ${missingEn.length === 0 ? 'none' : missingEn.join(', ')}`);
console.log(`used but missing in zh: ${missingZh.length === 0 ? 'none' : missingZh.join(', ')}`);
console.log(`dynamic keys missing in en: ${dynamicMissingEn.length === 0 ? 'none' : dynamicMissingEn.join(', ')}`);
console.log(`dynamic keys missing in zh: ${dynamicMissingZh.length === 0 ? 'none' : dynamicMissingZh.join(', ')}`);

const ok = onlyEn.length === 0 && onlyZh.length === 0
  && missingEn.length === 0 && missingZh.length === 0
  && dynamicMissingEn.length === 0 && dynamicMissingZh.length === 0;
console.log(ok ? '\nPASS: dictionaries are in parity' : '\nFAIL: dictionary drift detected');
process.exit(ok ? 0 : 1);
