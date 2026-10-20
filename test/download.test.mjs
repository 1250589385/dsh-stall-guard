/**
 * Download detection and the switch-source advisory.
 *
 * The advisory is the deliverable: when a download stalls, the agent reads this text and
 * must come away knowing (a) the source is the problem, (b) which source was being used,
 * and (c) that it should try another one. These tests pin the text's content, not just its
 * existence, because a vague message would leave the agent retrying the same dead host.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHANNELS,
  buildAdvisory,
  cleanupHint,
  commandOf,
  detectDownload,
  downloadTimeoutResult,
} from '../lib/download.js';
import { classify } from '../lib/classify.js';

const bash = (command) => ({ name: 'ops_bash', arguments: { command } });
const classifyKind = (name) => classify(name);

test('a git clone over https is detected with its repository target', () => {
  const detection = detectDownload(bash('git clone https://github.com/nodejs/node.git'), classifyKind);
  assert.ok(detection, 'a git clone must be detected');
  assert.equal(detection.channel, 'git');
  assert.match(detection.target, /github\.com\/nodejs\/node\.git/);
  assert.equal(detection.host, 'github.com');
});

test('a git clone without the scheme is still detected', () => {
  const detection = detectDownload(bash('git clone git@github.com:user/repo.git'), classifyKind);
  assert.ok(detection);
  assert.equal(detection.channel, 'git');
  assert.match(detection.target, /github\.com:user\/repo\.git/);
});

test('a git clone with flags in front is detected', () => {
  const detection = detectDownload(bash('git clone --depth 1 --branch main https://github.com/a/b.git'), classifyKind);
  assert.ok(detection);
  assert.equal(detection.channel, 'git');
});

test('git submodule update counts as a network fetch', () => {
  const detection = detectDownload(bash('git submodule update --init --recursive'), classifyKind);
  assert.ok(detection, 'submodule update reaches the network and can stall');
  assert.equal(detection.channel, 'git');
});

test('package manager installs are detected per ecosystem', () => {
  const cases = [
    ['pnpm install', 'npm'],
    ['npm install express', 'npm'],
    ['pnpm add -D typescript', 'npm'],
    ['yarn add react', 'npm'],
    ['pip install pytest', 'pip'],
    ['python -m pip install -r requirements.txt', 'pip'],
    ['uv sync', 'pip'],
    ['cargo install ripgrep', 'cargo'],
    ['go get github.com/gin-gonic/gin', 'go'],
    ['go mod download', 'go'],
  ];
  for (const [command, expected] of cases) {
    const detection = detectDownload(bash(command), classifyKind);
    assert.ok(detection, `${command} must be detected as a download`);
    assert.equal(detection.channel, expected, `${command} classified as ${detection.channel}`);
  }
});

test('direct file transfers are detected with the URL', () => {
  const curl = detectDownload(bash('curl -L https://example.com/big.zip -o big.zip'), classifyKind);
  assert.ok(curl);
  assert.equal(curl.channel, 'http');
  assert.equal(curl.host, 'example.com');
  assert.match(curl.target, /big\.zip/);

  assert.ok(detectDownload(bash('wget https://example.com/f.tar.gz'), classifyKind));
  assert.ok(detectDownload(bash('Invoke-WebRequest -Uri https://example.com/x -OutFile x'), classifyKind));
});

test('ordinary commands are not downloads', () => {
  const notDownloads = [
    'ls -la',
    'echo hello',
    'node --version',
    'git status',
    'git log --oneline',
    'git diff HEAD',
    'cat package.json',
    'mkdir -p src',
    'pytest -q',
    'curl --version',
  ];
  for (const command of notDownloads) {
    assert.equal(detectDownload(bash(command), classifyKind), undefined, `${command} must not be a download`);
  }
});

test('non-shell tools are not treated as downloads', () => {
  // A read tool carrying a "command"-looking argument is still a read.
  assert.equal(detectDownload({ name: 'read', arguments: { command: 'git clone https://github.com/a/b' } }, classifyKind), undefined);
  assert.equal(detectDownload({ name: 'write', arguments: { command: 'curl x' } }, classifyKind), undefined);
  assert.equal(detectDownload({ name: 'web_fetch', arguments: { url: 'https://github.com/a/b' } }, classifyKind), undefined);
});

test('commandOf reads the argument shapes in use', () => {
  assert.equal(commandOf({ command: 'curl x' }), 'curl x');
  assert.equal(commandOf({ script: 'curl x' }), 'curl x');
  assert.equal(commandOf({ cmd: 'curl x' }), 'curl x');
  assert.equal(commandOf({ input: 'curl x' }), 'curl x');
  assert.equal(commandOf({ command: '   ' }), '');
  assert.equal(commandOf({}), '');
  assert.equal(commandOf(undefined), '');
  assert.equal(commandOf('a string'), '');
});

test('every channel has at least one mirror hint', () => {
  assert.deepEqual(CHANNELS, ['git', 'npm', 'pip', 'cargo', 'go', 'http']);
  for (const channel of CHANNELS) {
    const detection = { channel, target: 'example', label: 'a thing', command: 'cmd' };
    const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 31000, locale: 'zh' });
    assert.ok(text.length > 40, `channel ${channel} produced no advisory`);
  }
});

test('the Chinese advisory tells the agent to switch source, not to wait', () => {
  const detection = detectDownload(bash('git clone https://github.com/user/repo.git'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh' });

  assert.match(text, /下载卡住/, 'must state that the download stalled');
  assert.match(text, /已中止/, 'must state that the command was killed');
  assert.match(text, /换一个源/, 'must instruct the agent to change source');
  assert.match(text, /不要用同一个源/, 'must explicitly warn against retrying the same source');
  assert.match(text, /没有验证过/, 'must not claim the mirrors are verified');
  assert.match(text, /30 秒/, 'must name the budget so the agent can reason about it');
  assert.match(text, /github\.com/, 'must name the source that failed');
});

test('the English advisory carries the same instructions', () => {
  const detection = detectDownload(bash('git clone https://github.com/user/repo.git'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'en' });

  assert.match(text, /Download stalled/);
  assert.match(text, /killed/);
  assert.match(text, /different source/);
  assert.match(text, /not a verified list/);
  assert.match(text, /github\.com/);
});

test('a git advisory suggests transferable mirror forms', () => {
  const detection = detectDownload(bash('git clone https://github.com/user/repo.git'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh' });
  assert.match(text, /gh-proxy|ghfast|kkgithub|gitclone/, 'must name at least one concrete mirror');
  assert.match(text, /insteadOf/, 'must show the one-off git rewrite, which needs no global config change');
});

test('an npm advisory names a registry flag', () => {
  const detection = detectDownload(bash('pnpm install'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh' });
  assert.match(text, /--registry/);
  assert.match(text, /npmmirror/);
});

test('a pip advisory names an index URL', () => {
  const detection = detectDownload(bash('pip install pytest'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh' });
  assert.match(text, /-i https:\/\//);
  assert.match(text, /tuna|aliyun/);
});

test('a go advisory names GOPROXY', () => {
  const detection = detectDownload(bash('go get github.com/a/b'), classifyKind);
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 30000, locale: 'zh' });
  assert.match(text, /GOPROXY/);
  assert.match(text, /goproxy\.cn/);
});

test('cleanup advice warns about the partial artefact per channel', () => {
  assert.match(cleanupHint('git', 'zh'), /半成品目录/);
  assert.match(cleanupHint('npm', 'zh'), /node_modules/);
  assert.match(cleanupHint('http', 'zh'), /不完整的文件|断点续传/);
  assert.match(cleanupHint('git', 'en'), /partial directory/);
});

test('the failure result is shaped for the agent to act on', () => {
  const detection = detectDownload(bash('git clone https://github.com/user/repo.git'), classifyKind);
  const result = downloadTimeoutResult({ detection, timeoutMs: 30000, elapsedMs: 30100, locale: 'zh' });

  assert.equal(result.isError, true, 'a killed download must be an error result');
  assert.equal(result.value.stalled, 'download');
  assert.equal(result.value.channel, 'git');
  assert.equal(result.value.host, 'github.com');
  assert.equal(result.value.timeoutMs, 30000);
  assert.equal(result.value.reason, 'download-timeout');
  assert.equal(result.value.advice, 'switch-source');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /换一个源/);
  // The cleanup warning must be in the same result, not a second message the agent may skip.
  assert.match(result.content[0].text, /半成品目录/);
});

test('a very long command is truncated in the advisory', () => {
  const long = `git clone https://github.com/a/b.git ${'--x '.repeat(200)}`;
  const detection = detectDownload(bash(long), classifyKind);
  assert.ok(detection);
  assert.ok(detection.command.length <= 240, `command not truncated: ${detection.command.length}`);
  assert.ok(detection.command.endsWith('…'));
});

test('an unknown channel still yields usable advice', () => {
  const detection = { channel: 'mystery', target: '', label: 'a thing', command: 'cmd' };
  const text = buildAdvisory({ detection, timeoutMs: 30000, elapsedMs: 31000, locale: 'zh' });
  assert.match(text, /换一个源/);
});
