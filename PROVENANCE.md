# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 MIT 许可（见 [`LICENSE`](LICENSE)），覆盖
`index.js`、`lib/**`、`client.js`、`cordis.patch.yml`、`package.json`、
`locale/**`、文档与测试。

## 许可范围

| 范围 | 许可 |
|---|---|
| `index.js`、`lib/**`、`client.js`、`cordis.patch.yml`、`package.json`、文档、测试 | **MIT**（见 `LICENSE`） |
| `locale/en.json`、`locale/zh.json`（文案） | **MIT**（随代码一并授权） |
| `icon.svg`（插件列表图标） | **原创作品**，作者为本仓库维护者，按 **MIT** 一并授权 |

## 逐项来源

| 文件 | 来源 / 说明 |
|---|---|
| `icon.svg` | 维护者手写的原创 SVG（盾牌 + 秒表意象），无第三方素材、无嵌入元数据。 |
| `client.js` 里的监督员形象 | 维护者用内联 SVG / CSS 手绘的蓝色鲸鱼轮廓，**未引用任何图片文件**，不含第三方美术素材。 |
| `locale/en.json`、`locale/zh.json` | 维护者撰写，仅含插件标题与描述。 |
| `index.js`、`lib/**` | 维护者原创；仅使用 DeepSeek Harness 公开的插件接口（`tools/execute` 事件、`webServer.register`、`web` / `llm` / `agentDefaultModel` 服务、slot 与 locale 注册），未复制任何宿主组件源码。 |
| 监督员的兜底文案（中英对照表） | 维护者撰写。 |

## 无第三方素材

本仓库**不包含**任何第三方图片、动图、音频或字体文件，
因此不存在素材授权范围的划分问题；整仓内容统一为 MIT。

## 权利主张 / Takedown

如果你认为本仓库的内容侵犯了你的权利，请在本仓库开一条 issue，
说明**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。
