/**
 * Appearance storage rules, extracted from the Client module.
 *
 * The Client dictionaries and helpers live inside a `require`-style browser module, so the
 * clamp rules are mirrored here as data and checked against the source: a drift between
 * this table and `client.js` fails the check rather than silently allowing a 0-opacity
 * icon (invisible and unclickable) or a position off-screen.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Read one `const NAME = <number>;` from the source. */
function numericConst(name) {
  const match = new RegExp(`const ${name} = (-?[0-9.]+);`).exec(src);
  assert.ok(match, `client.js must declare ${name}`);
  return Number(match[1]);
}

/** Read one numeric field from APPEARANCE_DEFAULTS. */
function defaultField(name) {
  const block = /const APPEARANCE_DEFAULTS = \{([\s\S]*?)\};/.exec(src);
  assert.ok(block, 'client.js must declare APPEARANCE_DEFAULTS');
  const match = new RegExp(`${name}:\\s*(-?[0-9.]+)`).exec(block[1]);
  assert.ok(match, `APPEARANCE_DEFAULTS must declare ${name}`);
  return Number(match[1]);
}

const clamp = (value, fallback, min, max) => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

test('the size bounds are sane for an icon', () => {
  const min = numericConst('SIZE_MIN');
  const max = numericConst('SIZE_MAX');
  assert.ok(min >= 10 && min <= 20, `SIZE_MIN ${min} is too small or too large`);
  assert.ok(max >= 48 && max <= 128, `SIZE_MAX ${max} is out of range`);
  assert.ok(min < max);
});

test('the opacity floor keeps the icon visible and clickable', () => {
  const floor = numericConst('OPACITY_MIN');
  // Fully transparent would make the control invisible AND unclickable, which is the
  // failure this floor exists to prevent.
  assert.ok(floor > 0, 'the opacity floor must be greater than zero');
  assert.ok(floor <= 0.5, `the floor ${floor} is so high that low opacity is unreachable`);
});

test('clamping keeps a requested size inside the bounds', () => {
  const min = numericConst('SIZE_MIN');
  const max = numericConst('SIZE_MAX');
  const fallback = defaultField('size');
  assert.equal(clamp(1, fallback, min, max), min);
  assert.equal(clamp(9999, fallback, min, max), max);
  assert.equal(clamp(32, fallback, min, max), 32);
});

test('clamping a corrupt value falls back to the default', () => {
  const min = numericConst('SIZE_MIN');
  const max = numericConst('SIZE_MAX');
  const fallback = defaultField('size');
  assert.equal(clamp(undefined, fallback, min, max), fallback);
  assert.equal(clamp('abc', fallback, min, max), fallback);
  assert.equal(clamp(NaN, fallback, min, max), fallback);
});

test('opacity clamps within its own range', () => {
  const floor = numericConst('OPACITY_MIN');
  const fallback = defaultField('opacity');
  assert.equal(clamp(0, fallback, floor, 1), floor);
  assert.equal(clamp(5, fallback, floor, 1), 1);
  assert.equal(clamp(0.6, fallback, floor, 1), 0.6);
});

test('the default appearance is visible and in the header', () => {
  assert.equal(defaultField('opacity'), 1);
  const block = /const APPEARANCE_DEFAULTS = \{([\s\S]*?)\};/.exec(src)[1];
  assert.match(block, /place:\s*'header'/, 'the default placement must be the header');
  assert.match(block, /x:\s*-1/, 'the default float position must be "unset"');
  assert.match(block, /y:\s*-1/);
});

test('the appearance record has its own storage key so it cannot collide', () => {
  assert.match(src, /const APPEARANCE_KEY = 'dsh-stall-guard\.appearance\.v1'/);
});

test('a hidden supervisor still has a reachable way back', () => {
  // The header seat returns null when hidden, so a second seat must provide the tab.
  assert.match(src, /id: 'stall-guard-restore'/, 'a restore seat must be registered');
  assert.match(src, /function RestoreSeat/, 'the restore seat must exist');
  assert.match(src, /snapshot\.config\.supervisor\.show !== false\) return null/s, 'the restore tab renders only while hidden');
  assert.match(src, /dsg-restoreTab/, 'the restore tab needs its style');
});

test('the hidden state keeps the guard running', () => {
  // Hiding is presentation only: the Host keeps polling and the config stays enabled.
  const configDefault = /supervisor: \{\s*show: true,/.test(src);
  assert.ok(configDefault, 'the Client default must show the supervisor');
});

test('float placement clamps to the viewport so a resize cannot strand it', () => {
  assert.match(src, /window\.innerWidth - rect\.width/, 'the drag must clamp horizontally');
  assert.match(src, /window\.innerHeight - rect\.height/, 'the drag must clamp vertically');
});

test('a seven-character CJK label cannot collapse a number field to one digit', () => {
  // The real defect: "模型超时（毫秒）" in a 118px grid column squeezed the field until
  // 8000 rendered as "8", which reads as a wrong value rather than a narrow box.
  assert.match(src, /minmax\(150px,1fr\)/, 'the grid columns must be wide enough for a CJK label');
  assert.match(src, /\.dsg-field>input\[type="number"\]\{[^}]*min-width:74px/, 'number fields need a digit-width floor');
});

test('the number fields keep their full value readable', () => {
  const gridMatch = /\.dsg-grid\{[^}]*minmax\((\d+)px/.exec(src);
  assert.ok(gridMatch, 'the grid must declare a minimum column width');
  const column = Number(gridMatch[1]);
  // A 7-char CJK label at 12px is roughly 84px; the field needs ~74px beside it.
  assert.ok(column >= 150, `column ${column}px leaves no room for label + field`);
});

test('no model controls remain: the plugin never calls a model', () => {
  // They used to exist and did nothing when disabled, which is worse than not existing.
  assert.doesNotMatch(src, /dsg-modelFields/, 'the model block must be gone');
  assert.doesNotMatch(src, /draft\.supervisor\.useModel/, 'the use-model switch must be gone');
  assert.doesNotMatch(src, /t\('useModel'\)/, 'the use-model label must be gone');
});

test('placeholders are readable against the host input background', () => {
  assert.match(src, /\.dsg-input::placeholder\{/, 'placeholders need an explicit colour');
});

test('the save bar is pinned outside the scrolling body', () => {
  // Reported: after editing the timeout table, Save was at the bottom of a long scroll.
  assert.match(src, /className: 'dsg-body'/, 'the panel needs a scrolling body');
  assert.match(src, /className: 'dsg-foot-wrap'/, 'the action bar needs its own non-scrolling wrapper');
  const panelRule = /\.dsg-panel\{[^}]*\}/.exec(src);
  assert.ok(panelRule, 'the panel needs a rule');
  assert.match(panelRule[0], /overflow:hidden/, 'the panel itself must not scroll; only the body does');
  const bodyRule = /\.dsg-body\{[^}]*\}/.exec(src);
  assert.ok(bodyRule, 'the body needs a rule');
  assert.match(bodyRule[0], /overflow-y:auto/, 'the body is the scrolling element');
  const footRule = /\.dsg-foot\{[^}]*\}/.exec(src);
  assert.ok(footRule, 'the action bar needs a rule');
  assert.match(footRule[0], /flex:0 0 auto/, 'the action bar must not shrink away');
});

test('unsaved edits cannot be discarded by accident', () => {
  // Reported: closing with pending edits dropped them without a word.
  assert.match(src, /discardConfirm/, 'the discard confirmation must exist');
  assert.match(src, /const requestClose = useCallback/, 'the Close button must route through a guarded close');
  assert.match(src, /const requestDismiss = useCallback/, 'Escape and outside-press must be guarded too');
  // The store refuses to close while dirty, so a path that forgets to ask cannot win.
  assert.match(src, /if \(snapshot\.dirty === true\) \{/, 'closePanel must branch while dirty');
  assert.match(src, /patch\(\{ confirming: true \}\)/, 'closePanel must raise the confirmation instead of closing');
  assert.match(src, /forceClose\(\)/, 'an explicit discard path must exist');
  // A native dialog is unreliable in this shell; the confirmation must be in-panel.
  assert.doesNotMatch(src, /window\.confirm\(/, 'the confirmation must not rely on a native dialog');
  assert.match(src, /dsg-confirm/, 'an in-panel confirmation bar must exist');
  assert.match(src, /cancelClose\(\)/, 'the confirmation must be cancellable');
});

test('the bubble is clickable so the panel opens from it', () => {
  // Reported: pressing the bubble did nothing because it let the press fall through.
  const bubbleRule = /\.dsg-bubble\{[^}]*\}/.exec(src);
  assert.ok(bubbleRule, 'the bubble needs a rule');
  assert.match(bubbleRule[0], /pointer-events:auto/, 'the bubble must accept pointer events');
  assert.doesNotMatch(bubbleRule[0], /pointer-events:none/, 'a click-through bubble cannot be dismissed');
});

test('pressing the bubble dismisses it instead of opening the panel', () => {
  // The notice behaves like a toast: the press makes it go away. Opening settings is the
  // figure's job, so the two affordances never compete.
  assert.match(src, /void store\.acknowledge\(\)/, 'the bubble must acknowledge on press');
  assert.match(src, /t\('dismissBubble'\)/, 'the bubble needs its own accessible label');
  const bubbleBlock = src.slice(src.indexOf("className: 'dsg-bubble'"), src.indexOf("}, message)"));
  assert.doesNotMatch(bubbleBlock, /store\.activate\(\)/, 'a press on the bubble must not open the panel');
});

test('the bubble has its own switch', () => {
  assert.match(src, /supervisor\.bubble !== false/, 'the client must read the bubble setting');
  assert.match(src, /t\('showBubble'\)/, 'the panel must expose the toggle');
});

test('the floating figure renders from the overlay, not the header slot', () => {
  // Reported: dragging the figure pushed the header row around. A flow item in the header
  // cannot be moved freely; the floating posture has to live outside that layout.
  assert.match(src, /function FloatingSeat/, 'a dedicated overlay seat must exist');
  assert.match(src, /id: 'stall-guard-floating'/, 'the overlay seat must be registered');
  // The header seat must stand down when the overlay owns the figure, while the overlay
  // seat must NOT stand down for the same reason — that mistake hid the figure entirely.
  assert.match(src, /if \(wantsFloat && !forcedFloat\) return null/, 'the header seat must render nothing while floating');
  assert.doesNotMatch(src, /if \(supervisorOff \|\| floating\) return null/, 'the guard must not fire for the overlay seat');
});

test('the overlay draws the figure only in the floating posture', () => {
  // Without this the header and the overlay would both draw it, showing two figures.
  assert.match(src, /if \(appearance\.place !== 'float'\) return null/, 'the overlay seat must check the posture');
});

test('the settings panel does not cover the figure', () => {
  // Reported: resizing showed no live preview because the panel sat on top of the icon.
  const panelRule = /\.dsg-panel\{[^}]*\}/.exec(src);
  assert.ok(panelRule, 'the panel needs a rule');
  const top = /top:(\d+)px/.exec(panelRule[0]);
  assert.ok(top, 'the panel must declare a top offset');
  assert.ok(Number(top[1]) >= 100, `top ${top[1]}px still overlaps the header figure`);
});

test('a floating figure stays above the panel so it can be watched while adjusting', () => {
  const floatRule = /\.dsg-seat\[data-floating="yes"\]\{[^}]*\}/.exec(src);
  assert.ok(floatRule, 'the floating seat needs a rule');
  const z = /z-index:(\d+)/.exec(floatRule[0]);
  assert.ok(z, 'the floating seat needs a stacking order');
  const panelRule = /\.dsg-panel\{[^}]*\}/.exec(src);
  const pz = /z-index:(\d+)/.exec(panelRule[0]);
  assert.ok(Number(z[1]) > Number(pz[1]), 'the figure must be above the panel');
});
