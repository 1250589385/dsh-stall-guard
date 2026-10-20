/**
 * Download detection and the advisory a stalled download returns to the model.
 *
 * This module exists for one purpose: when a network download command overruns its
 * budget, the agent that issued it must be told — in the tool result it is about to
 * read — that the source is the problem and it should try a different one.
 *
 * It deliberately does NOT maintain a verified mirror catalogue. Mirror health changes
 * hourly and differs per network; baking in a "working" list would produce confidently
 * wrong advice. Instead the advisory names what was being fetched, states the timeout,
 * and lists commonly used mirrors *as candidates to try*, explicitly marked unverified.
 * The decision stays with the agent, which is the only party that knows the project.
 */

import { renderPreset } from './presets.js';

/** Download channels, in the order `detect` tries to match them. */
export const CHANNELS = ['git', 'npm', 'pip', 'cargo', 'go', 'http'];

/** A command longer than this is not worth echoing back to the model. */
const MAX_COMMAND_CHARS = 240;

/**
 * Per-channel patterns. Each entry maps a command shape to the channel plus a capture
 * for the target (repository, package, URL) so the advisory can be specific.
 */
const CHANNEL_PATTERNS = [
  {
    channel: 'git',
    // `git clone <url>`, `git -c … clone <url>`, `git remote add … <url>`, `git fetch`.
    // The URL is optional because `git submodule update` and a bare `git fetch` reach the
    // network through an already-configured remote, with no URL on the command line.
    test: /\bgit\b[^\n]*?\b(?:clone|fetch|pull|submodule\s+update|remote\s+add)\b(?:[^\n]*?(?<target>(?:https?|git|ssh):\/\/[^\s'"]+|[^\s'"]+@[^\s'"]+:[^\s'"]+))?/i,
    describe: (target) => (target ? `git repository ${shortenUrl(target, true)}` : 'a git repository'),
  },
  {
    channel: 'npm',
    test: /\b(?:pnpm|npm|yarn|bun)\b[^\n]*?\b(?:install|i|add|ci|create|dlx|exec)\b[^\n]*/i,
    describe: () => 'npm packages',
  },
  {
    channel: 'pip',
    test: /\b(?:pip|pip3|uv)\b[^\n]*?\b(?:install|download|sync)\b[^\n]*/i,
    describe: () => 'Python packages',
  },
  {
    channel: 'cargo',
    test: /\bcargo\b[^\n]*?\b(?:install|fetch|build|add)\b[^\n]*/i,
    describe: () => 'Rust crates',
  },
  {
    channel: 'go',
    test: /\bgo\b[^\n]*?\b(?:get|mod\s+download|install)\b[^\n]*/i,
    describe: () => 'Go modules',
  },
  {
    channel: 'http',
    // Direct file transfer needs a transfer verb AND something to transfer. A bare
    // `curl --version` or `wget --help` only prints local information and never touches
    // the network, so a URL (or an output destination) must be present.
    //
    // The URL is matched before the destination flags, because a `-o` written inside a
    // lookahead would otherwise win the named group and the advisory would name "-o" as
    // the source instead of the host.
    test: /\b(?:curl|wget|Invoke-WebRequest|iwr|aria2c|Start-BitsTransfer)\b[^\n]*?(?<target>https?:\/\/[^\s'"|;)]+)|(?:curl|wget|Invoke-WebRequest|iwr|aria2c|Start-BitsTransfer)\b[^\n]*?(?:^|\s)(?:-o|-O|--output|-OutFile)\b/i,
    describe: (target) => (target ? `file ${shortenUrl(target)}` : 'a file'),
  },
];

/** Trim a URL for display without losing the part that identifies the source. */
function shortenUrl(url, stripScheme = false) {
  let value = String(url ?? '').trim();
  if (stripScheme) value = value.replace(/^(?:https?|git|ssh):\/\//i, '');
  if (value.length <= 120) return value;
  return `${value.slice(0, 117)}…`;
}

/** Host of a URL, or empty when it cannot be parsed. */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/** The command text a shell-ish tool carries, across the argument shapes in use. */
export function commandOf(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'script', 'cmd', 'input', 'commandline']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * Decide whether one dispatched call is a network download.
 *
 * Returns `undefined` for anything that is not a download. Only shell-ish tools can be
 * downloads: `read`/`write` carry paths, and `web_fetch` is handled by its own class.
 */
export function detectDownload(exec, classify) {
  const name = String(exec?.name ?? '');
  if (classify) {
    const kind = classify(name);
    if (kind !== 'exec' && kind !== 'other') return undefined;
  }
  const command = commandOf(exec?.arguments);
  if (!command) return undefined;

  for (const pattern of CHANNEL_PATTERNS) {
    const match = pattern.test.exec(command);
    if (!match) continue;
    const target = match.groups?.target ?? '';
    const url = /^https?:\/\//i.test(target) ? target : '';
    return {
      channel: pattern.channel,
      target: target ? shortenUrl(target, pattern.channel === 'git') : '',
      host: hostOf(url),
      label: pattern.describe(target),
      command: command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS - 1)}…` : command,
    };
  }
  return undefined;
}

/**
 * Mirror candidates per channel.
 *
 * These are *suggestions*, not a supported list. The advisory says so, because a stale
 * mirror is worse than no suggestion: it sends the agent chasing a second failure.
 */
const MIRROR_HINTS = {
  zh: {
    git: [
      '在 GitHub 地址前加代理前缀，例如 https://gh-proxy.com/https://github.com/<owner>/<repo>.git',
      '备选前缀：https://ghfast.top/  https://kkgithub.com/  https://gitclone.com/github.com/',
      '不改全局配置的一次性写法：git -c url."https://gh-proxy.com/https://github.com/".insteadOf="https://github.com/" clone <owner>/<repo>',
      '如果只需要源码不需要提交历史，改用下载 tarball 通常更快：curl -L https://gh-proxy.com/https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main',
    ],
    npm: [
      '加镜像参数：--registry https://registry.npmmirror.com',
      '或整条命令前设环境变量：npm_config_registry=https://registry.npmmirror.com',
      'pnpm 同样适用：pnpm add <pkg> --registry https://registry.npmmirror.com',
    ],
    pip: [
      '加镜像参数：-i https://pypi.tuna.tsinghua.edu.cn/simple',
      '或：-i https://mirrors.aliyun.com/pypi/simple',
      '或设环境变量：PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple',
    ],
    cargo: [
      '在 ~/.cargo/config.toml 里把 crates-io 换成镜像源 https://mirrors.tuna.tsinghua.edu.cn/crates.io-index',
      '或 https://mirrors.ustc.edu.cn/crates.io-index',
    ],
    go: [
      '设 GOPROXY=https://goproxy.cn,direct',
      '或 GOPROXY=https://mirrors.aliyun.com/goproxy/,direct',
    ],
    http: [
      '换一个主机，或换同一个文件的镜像地址',
      '如果是 GitHub Release 资源，在地址前加 https://gh-proxy.com/',
      '大文件优先用可断点续传的方式（curl -C - / wget -c），避免每次都从头下',
    ],
  },
  en: {
    git: [
      'prefix the GitHub URL with a proxy, e.g. https://gh-proxy.com/https://github.com/<owner>/<repo>.git',
      'also try https://ghfast.top/ or https://kkgithub.com/ or https://gitclone.com/github.com/',
      'one-off without touching global config: git -c url."https://gh-proxy.com/https://github.com/".insteadOf="https://github.com/" clone <owner>/<repo>',
      'if you only need the source and not the history, a tarball is usually faster: curl -L https://gh-proxy.com/https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main',
    ],
    npm: [
      'add --registry https://registry.npmmirror.com',
      'or set it for one command: npm_config_registry=https://registry.npmmirror.com',
      'pnpm takes the same flag: pnpm add <pkg> --registry https://registry.npmmirror.com',
    ],
    pip: [
      'add -i https://pypi.tuna.tsinghua.edu.cn/simple',
      'or -i https://mirrors.aliyun.com/pypi/simple',
      'or set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple',
    ],
    cargo: [
      'point crates-io at a mirror in ~/.cargo/config.toml: https://mirrors.tuna.tsinghua.edu.cn/crates.io-index',
      'or https://mirrors.ustc.edu.cn/crates.io-index',
    ],
    go: [
      'set GOPROXY=https://goproxy.cn,direct',
      'or GOPROXY=https://mirrors.aliyun.com/goproxy/,direct',
    ],
    http: [
      'try a different host or a mirror of the same file',
      'if it is a GitHub release asset, prefix the URL with https://gh-proxy.com/',
      'for large files prefer a resumable transfer (curl -C - / wget -c)',
    ],
  },
};

/**
 * Build the text the model reads in place of the stalled result.
 *
 * Written as an instruction, not a status report: the agent is mid-task and needs to
 * know what to do next, plus the exact facts (what, how long, which budget) so it does
 * not retry the same dead source.
 *
 * A user preset, when present, replaces the whole text. That is the point of a preset:
 * the user has already decided what the agent should be told, so nothing here composes
 * prose on their behalf. Only the placeholder values are filled in.
 */
export function buildAdvisory({ detection, timeoutMs, elapsedMs, locale = 'zh', leftover, preset = '' }) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const ran = Math.max(1, Math.round(elapsedMs / 1000));
  const language = locale === 'en' ? 'en' : 'zh';
  const hints = MIRROR_HINTS[language][detection.channel] ?? MIRROR_HINTS[language].http;
  // The cleanup note is this function's responsibility, not the caller's: a retry against
  // a half-written directory otherwise fails for a reason nothing in the text explains.
  const cleanup = leftover === undefined ? cleanupHint(detection.channel, language) : leftover;

  if (typeof preset === 'string' && preset.trim() !== '') {
    const numbered = hints.map((hint, index) => `${index + 1}. ${hint}`).join('\n');
    const rendered = renderPreset(preset, {
      label: detection.label,
      channel: detection.channel,
      target: detection.target || '',
      host: detection.host || '',
      command: detection.command,
      seconds,
      elapsed: ran,
      hints: numbered,
    });
    // The cleanup note is part of what makes a retry succeed, so it stays appended even
    // with a custom preset. A user who does not want it can simply not stall.
    const parts = [rendered];
    if (cleanup && !rendered.includes(cleanup)) parts.push('', cleanup);
    return parts.join('\n');
  }

  const lines = [];
  if (locale === 'en') {
    lines.push(`Download stalled: ${detection.label} did not finish within ${seconds}s (stopped after ${ran}s).`);
    lines.push('');
    lines.push('The command was killed. The network path to this source is the likely cause, not the command itself.');
    lines.push('Retry against a different source before trying the same one again:');
    hints.forEach((hint, index) => lines.push(`${index + 1}. ${hint}`));
    lines.push('');
    lines.push('Those mirrors are suggestions, not a verified list — if one fails, try the next.');
    if (cleanup) lines.push('', cleanup);
    lines.push('');
    lines.push(`Command that stalled: ${detection.command}`);
  } else {
    lines.push(`下载卡住了：${detection.label} 在 ${seconds} 秒内没完成（已经跑了 ${ran} 秒，已中止）。`);
    lines.push('');
    lines.push('这条命令被终止了。原因多半是到这个源的网络不通，而不是命令本身写错。');
    lines.push('换一个源重试，不要用同一个源继续硬等：');
    hints.forEach((hint, index) => lines.push(`${index + 1}. ${hint}`));
    lines.push('');
    lines.push('上面这些镜像只是候选，没有验证过能不能用 —— 一个不行就换下一个。');
    if (cleanup) lines.push('', cleanup);
    lines.push('');
    lines.push(`卡住的命令：${detection.command}`);
  }
  return lines.join('\n');
}

/**
 * Cleanup advice for a killed command, per channel.
 *
 * An aborted `git clone` leaves a partial directory that makes the retry fail with
 * "already exists"; an aborted `pnpm install` can leave a broken `node_modules`. Naming
 * that is the difference between a retry that works and one that fails confusingly.
 */
export function cleanupHint(channel, locale = 'zh') {
  const zh = {
    git: '注意：被中止的 git clone 可能留下半成品目录，重试前先删掉它（或在新的空目录里重试）。',
    npm: '注意：被中止的安装可能留下不完整的 node_modules，必要时先删掉再装。',
    pip: '注意：被中止的安装可能装了半个包，必要时 pip uninstall 后重装。',
    cargo: '注意：被中止的构建可能留下不完整的 target 目录，必要时 cargo clean。',
    go: '注意：被中止的下载可能留下不完整的模块缓存，必要时 go clean -modcache。',
    http: '注意：被中止的下载会留下不完整的文件，重试前删掉它，或用可断点续传的下载。',
  };
  const en = {
    git: 'Note: an aborted git clone can leave a partial directory; remove it before retrying.',
    npm: 'Note: an aborted install can leave an incomplete node_modules; remove it if the retry misbehaves.',
    pip: 'Note: an aborted install may have half-installed a package; uninstall and reinstall if needed.',
    cargo: 'Note: an aborted build can leave an incomplete target directory; cargo clean if needed.',
    go: 'Note: an aborted download can leave an incomplete module cache; go clean -modcache if needed.',
    http: 'Note: an aborted download leaves a partial file; delete it or resume the transfer.',
  };
  const table = locale === 'en' ? en : zh;
  return table[channel] ?? table.http;
}

/** Build the failure result a download timeout returns to the agent. */
export function downloadTimeoutResult({ detection, timeoutMs, elapsedMs, locale = 'zh', preset = '' }) {
  const adapter = locale === 'en' ? 'en' : 'zh';
  const text = buildAdvisory({
    detection,
    timeoutMs,
    elapsedMs,
    locale: adapter,
    leftover: cleanupHint(detection.channel, adapter),
    preset,
  });
  return {
    isError: true,
    content: [{ type: 'text', text }],
    value: {
      ok: false,
      stalled: 'download',
      channel: detection.channel,
      target: detection.target || null,
      host: detection.host || null,
      timeoutMs,
      elapsedMs: Math.round(elapsedMs),
      reason: 'download-timeout',
      advice: 'switch-source',
    },
  };
}
