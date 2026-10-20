# 卡顿守卫 · dsh-stall-guard

**下载卡住了？自动掐掉，然后告诉智能体「换个源重试」。**

GitHub 在国内时通时不通，`git clone` 挂在那儿几分钟不动，智能体就一直干等。
这个插件盯着下载类命令，超过阈值直接中止，并把一句**智能体能读懂的换源提示**写进工具结果里。

> 注意：这是给**智能体**看的，不是给人看的。你看到的 UI（监督员形象）只是顺便。

---

## 它到底做了什么

一条命令超时后，智能体收到的**不是**一句干巴巴的 `timeout`，而是：

```
下载卡住了：git repository github.com/nodejs/node.git 在 30 秒内没完成（已经跑了 30 秒，已中止）。

这条命令被终止了。原因多半是到这个源的网络不通，而不是命令本身写错。
换一个源重试，不要用同一个源继续硬等：
1. 在 GitHub 地址前加代理前缀，例如 https://gh-proxy.com/https://github.com/<owner>/<repo>.git
2. 备选前缀：https://ghfast.top/  https://kkgithub.com/  https://gitclone.com/github.com/
3. 不改全局配置的一次性写法：git -c url."https://gh-proxy.com/https://github.com/".insteadOf="https://github.com/" clone <owner>/<repo>
4. 如果只需要源码不需要提交历史，改用下载 tarball 通常更快：curl -L https://gh-proxy.com/https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/main

上面这些镜像只是候选，没有验证过能不能用 —— 一个不行就换下一个。

注意：被中止的 git clone 可能留下半成品目录，重试前先删掉它（或在新的空目录里重试）。

卡住的命令：git clone https://github.com/nodejs/node.git
```

四个关键点，每个都有用：

1. **说明了是「网络到源不通」，不是命令写错** —— 否则智能体会去改命令，白费时间。
2. **给了候选源** —— 但**明确说是没验证过的候选**。镜像可用性每小时都在变，写一份「已验证可用」的清单只会骗到智能体。
3. **提醒清理半成品** —— 被掐掉的 `git clone` 会留下半个目录，直接重试会报 `already exists` 然后卡第二轮。
4. **附上原始命令** —— 智能体不用回翻上下文找它刚才跑的是什么。

## 覆盖哪些下载

| 渠道 | 认得出的命令 | 换源提示 |
|---|---|---|
| `git` | `git clone` `git fetch` `git pull` `git submodule update` `git remote add` | 代理前缀 / insteadOf / tarball |
| `npm` | `pnpm install|add` `npm i|install` `yarn add` `bun` | `--registry https://registry.npmmirror.com` |
| `pip` | `pip install` `pip download` `uv sync` | `-i https://pypi.tuna.tsinghua.edu.cn/simple` |
| `cargo` | `cargo install|fetch|build` | tsinghua / ustc crates 镜像 |
| `go` | `go get` `go mod download` | `GOPROXY=https://goproxy.cn,direct` |
| `http` | `curl` `wget` `Invoke-WebRequest` `aria2c` `Start-BitsTransfer` | 换主机 / gh-proxy / 断点续传 |

**不误报**：`curl --version`、`wget --help`、`git status`、`git log`、`ls`、`node -v` 都不会被当成下载。

## 快速开始

```bash
dsh plugin --profile <你的profile> add dsh-stall-guard
```

不知道 profile 叫什么：

```powershell
$env:DSH_PROFILE   # 桌面版一般是 desktop
```

装完**刷新页面**即可。默认就生效，不用额外配置。

## 默认超时

| 类型 | 默认 | 卡住后 |
|---|---|---|
| **下载** | **30 秒** | **中止 + 给智能体换源提示** |
| 抓取 `web_fetch` | 15 秒 | 中止 + 改用搜索 |
| 搜索 `web_search` | 15 秒 | 中止 + 重试一次 |
| 读取 | 20 秒 | 只提示 |
| 写入 | 30 秒 | 只提示，**不中止**（防写坏文件） |
| 执行 | 30 秒 | 只提示（除非判定为下载） |
| 长任务 | 120 秒 | 只提示 |
| 其他 | 30 秒 | 只提示 |

下载有**独立预算**（`downloadSeconds`，默认 30 秒），不占用 `exec` 的 30 秒。
原因很直接：等一个死掉的镜像 30 秒和等一个慢编译 30 秒，代价完全不同。

## 为什么只掐下载，不掐写文件

| 操作 | 中止后的后果 | 策略 |
|---|---|---|
| `git clone` / `curl` | 留下半个文件/目录，**删掉重来就行** | ✅ 中止 |
| `write` / `edit` 写文件 | 可能写坏用户的文件 | ❌ 绝不中止 |
| 普通 `bash` 命令 | 可能跑到一半改了状态 | ❌ 不中止 |

中止下载是安全的，因为它没有副作用——重新下就是了。写文件不是。

## 配置

面板里点监督员形象打开，或直接编辑 `$DSH_HOME/stall-guard/config.json`：

```json
{
  "version": 1,
  "enabled": true,
  "watchDownloads": true,
  "downloadSeconds": 30,
  "timers": { "fetch": 15, "search": 15, "read": 20, "write": 30, "exec": 30, "long": 120, "other": 30 },
  "overrides": { "web_fetch": 45 },
  "autoSwitch": true,
  "scenes": {
    "download": { "enabled": true, "seconds": 30 },
    "fetch": { "enabled": true, "seconds": 15 },
    "search": { "enabled": true, "seconds": 15 }
  },
  "supervisor": { "show": true, "display": "avatar" }
}
```

- `downloadSeconds` —— 下载预算。GitHub 慢就调大，急着换源就调小。
- `watchDownloads: false` —— 完全关掉下载检测，下载命令就按 `exec` 类处理（只提示不中止）。
- `overrides` —— 给单个工具单独设秒数。

## 监督员（次要功能）

三种形态，面板里切换：

| 形态 | 平时 | 卡住时 |
|---|---|---|
| `dot` | 状态栏 6px 半透明点 | 变红脉冲 |
| `icon` | 静止图标 | 弹跳 + 发光 |
| `avatar` | 闭眼小鲸鱼 | 弹跳 + 气泡说出原因 |

### 显示开关

面板里「显示监督员」一勾即关，**关掉后守卫照常工作**（下载一样会被掐断、提示一样会写进工具结果），
只是不再画那个形象。右下角会留一个 14px 的半透明小点，点它随时能打开面板重新打开。

### 图标外观（仅本浏览器）

| 项目 | 范围 | 说明 |
|---|---|---|
| 大小 | 14–64px | 滑块，带数值回显 |
| 透明度 | 20%–100% | 下限 20% 是为了它仍然可见、可点 |
| 位置 | 标题栏 / 浮动 | 浮动模式下**可以拖到任何地方**，位置会记住 |

外观存在 `localStorage`（键 `dsh-stall-guard.appearance.v1`），不写进 Host 配置：
这是"这个浏览器上我喜欢多大"的个人偏好，不该同步给所有人，也省掉一次往返。
拖动位置会自动夹在视口内，窗口变小也不会跑到屏幕外。

那句提示来自**内置的中英文案表**，不调用模型，零 token。

例如：`下载 30s 没完成，已中止，换源提示已交给智能体。`

文案按工具类型、动作、结果三个维度挑选，中英双语，切换界面语言时已在屏幕上的提示也会跟着改写。

## 自定义预设（完全不碰模型）

面板里可以直接写**你要发给智能体看的原文**，插件只做占位符替换，一个模型都不叫。

三个场景各一份，中英各一份：

| 场景 | 什么时候用 |
|---|---|
| 下载 | `git clone` / `pnpm install` / `curl` 超时 |
| 抓取 | `web_fetch` 超时改搜索 |
| 搜索 | `web_search` 超时重试 |

### 占位符

写进文本框，发送时自动替换：

| 占位符 | 含义 |
|---|---|
| `{{label}}` | 在下载什么（如 `git repository github.com/a/b.git`） |
| `{{channel}}` | 渠道（`git`/`npm`/`pip`/`cargo`/`go`/`http`） |
| `{{target}}` | 目标地址或仓库 |
| `{{host}}` | 主机名 |
| `{{command}}` | 原始命令（超 240 字会截断） |
| `{{seconds}}` | 超时阈值 |
| `{{elapsed}}` | 实际耗时 |
| `{{hints}}` | 内置的镜像候选清单（**最省事的用法**） |
| `{{query}}` / `{{sources}}` | 搜索词 / 结果数（抓取、搜索场景） |

面板里每个占位符都是一个可点的按钮，点一下追加到末尾。

### 例子

最简写法（完全自己控制）：

```
{{label}} 卡了 {{seconds}} 秒。换源，别重试同一个地址。
```

想保留内置的镜像清单但换掉措辞：

```
下载超时了（{{seconds}}s），源：{{host}}
请从下面挑一个换：
{{hints}}
```

### 几个行为约定

- **空着 = 用内置文案**。不会变成"什么都不发"——清空不会让插件失声。
- **"用内置文案"按钮**等同于清空；"恢复默认"会把内置全文填进文本框供你改。
- **占位符拼错会原样保留**（比如写成 `{{labl}}`），不会静默变成空字符串——否则你永远发现不了。
- 上限 4000 字，超了截断并提示。
- **预设是唯一的文案来源**：这个插件从不调用模型，所以预设就是发给智能体的最终文本。
- 清理半成品的那句提醒会**始终追加**（即使是自定义预设），因为少了它重试会撞上 `already exists`。
- 占位符不是代码，`${...}` 之类原样输出，不执行任何东西。

## Token 成本

**这个插件在任何情况下都不调用模型。**

| 行为 | 成本 |
|---|---|
| 守卫逻辑、计时、下载检测 | **0** |
| 每秒轮询 `state.json` | **0**（本机 127.0.0.1 HTTP，不经模型） |
| 状态栏那句提示 | **0**（内置文案表，写死的） |
| 换源提示（发给智能体） | 占上下文 ~195–325 token，**只在真卡住时产生** |

唯一进入智能体上下文的是换源提示，平均约 240 token/次卡顿。平顺时是 0。

这笔通常还是**省钱的**——它替代了「智能体干等几分钟后放弃、再乱猜源」。

### 为什么没有「用模型生成提示」这个选项

之前有过，已删除。理由是它不该存在：
- 提示要传达的事实（哪个工具、跑了多久、阈值多少、做了什么）守卫**已经完全知道**；
- 模型只能换个说法，不能更准，却每次卡顿都要花约 300 token；
- 而且那句提示是**给你看的**，不是给智能体看的——花钱美化给人看的一句话，不值。

内置文案已经足够具体，例如：

```
下载卡住了：git repository github.com/nodejs/node.git 在 30 秒内没完成（已经跑了 30 秒，已中止）。
```

## 隐私

- 除了监督模型那一次调用，**不联网**。
- 卡顿记录只在内存，最多 10 条，重启清空。
- 配置只写在你自己 `~/.dsh` 下。

## 兼容性

- 需要 `tools/execute` waterfall 和 `webServer`；没有 `webServer` 的组合照常工作，只是没面板。
- 不注册任何工具，不占用工具名。
- 只用一个 slot：`conversation.session.header.utilities`。

## 和类似插件的区别

| 插件 | 它做什么 |
|---|---|
| `dsh-turn-doctor` | 解释**已失败**的一轮是哪层杀的（事后） |
| `dsh-llm-fallbacks` | 模型请求失败换 provider（LLM 层） |
| `dsh-repeat-tool-breaker` | 拦重复调同一工具（防循环） |
| `@lolkda/dsh-retry` | 改 provider 重试参数 |
| **本插件** | **下载卡住 → 掐掉 → 把换源提示写给智能体（工具层，事中）** |

## 开发

```bash
node --test test/*.test.mjs        # 182 个用例
```

## 许可

MIT，见 [LICENSE](LICENSE)。素材来源见 [PROVENANCE.md](PROVENANCE.md)。
