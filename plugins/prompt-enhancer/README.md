# ZCode 提示词增强插件(prompt-enhancer)

将草稿提示词改写为**清晰、精炼、无歧义**指令的 ZCode 插件。增强规范以「精炼优先、
少引用具体文件」为核心契约:输出目标 ≤ 原文 1.5 倍,最多一个文件/符号锚点。
按 ZCode 插件规范(`.zcode-plugin/plugin.json`)实现,零 npm 运行时依赖。

## 激活方式

| 方式 | 入口 | 说明 |
| --- | --- | --- |
| **输入框按钮** | 输入框工具行 ✦ | 桌面集成层(`desktop/`):独立预览面板流式展示,确认后才替换草稿,可一键回退。需运行一次补丁器,见 `desktop/README.md` |
| 斜杠命令 | `/enhance-prompt <草稿>` | 见 `commands/enhance-prompt.md`。优先调用 MCP 工具,未配置 API Key 时按同一规则就地增强 |
| 技能 | composer 技能选择器 | `skills/prompt-enhancer/SKILL.md` |
| MCP 工具 | `enhance_prompt` | 供任意会话/技能直接调用的核心能力 |
| CLI | `node dist/cli.js` | stdin/stdout 标记协议,桌面按钮与外部宿主共用 |

## 目录结构

```text
plugins/prompt-enhancer/
├── .zcode-plugin/plugin.json      # 清单:commands + skills + mcpServers + userConfig
├── commands/enhance-prompt.md     # /enhance-prompt 斜杠命令(用户可见层)
├── skills/prompt-enhancer/SKILL.md# 技能入口(composer 选择器)
├── desktop/                       # 桌面输入框按钮(注入层 + asar 补丁器,见 desktop/README.md)
│   ├── inject-main.cjs            #   主进程 loader:注入 overlay + 拉起增强 CLI
│   ├── overlay.js                 #   渲染进程 overlay:按钮/预览/应用/回退
│   ├── patch-desktop.mjs          #   install / remove / check
│   └── asar-lib.mjs               #   asar 读写原语(与回环测试共享)
├── src/                           # TypeScript 源码(见下节)
├── dist/                          # 编译产物(零运行时依赖,随插件分发)
├── test/                          # 单元测试(node:test)+ 桌面补丁回环测试
└── scripts/smoke-test.mjs         # 端到端冒烟(MCP 握手 + CLI 协议)
```

## 架构与模块划分

分层依赖方向自上而下,`core` 不依赖任何基础设施:

```text
desktop/overlay.js + commands/enhance-prompt.md   用户层:输入框按钮 / 命令面板
        │
desktop/inject-main.cjs → dist/cli.js (标记协议)  接入层:流式桥接
mcp/server.ts                                     接入层:MCP 工具注册与 JSON-RPC 分发
        │
core/enhancer.ts             编排层:校验→组装→选策略→调用→守卫输出
        ├─ core/prompt-builder.ts   纯函数:草稿+上下文 → 完整提示词(分段预算,紧凑化)
        ├─ core/output-guard.ts     纯函数:清洗围栏/前缀/解释尾巴
        └─ core/system-prompt.ts    规范单一来源(精炼契约/文件引用政策/输出规则)
        │
strategies/*                 策略层:glm | openai-compatible | anthropic | mock
config/config.ts             配置层:env + ZCode userConfig / config.json 解析
index.ts                     组合根:唯一知道拼装方式的文件
```

### 关键决策

- **精炼契约**:`system-prompt.ts` 强制 ≤1.5x 长度、最多一个文件锚点、禁止填充话术;
  上下文预算同步收紧(选区 1500 / 光标 800 / 当前文件 2000 / 关联文件 1200,
  关联文件超 300 字符只传路径),更少输入 token、更快的首 token、更精炼的输出。
- **max_tokens 按输入伸缩**:`min(8192, max(1024, len*0.8))`——按 CJK 最坏情形覆盖
  「轻度润色不改写」的输出上限,同时防止模型越写越长。
- **流式体验**:CLI `[CONTENT_DELTA]` 标记逐段回传,桌面预览面板边生成边显示,
  用户感知延迟 ≈ 首 token 时间。
- **超时为真·墙钟预算**:15–180s 钳位,覆盖建连、响应头与**流式 body 全程**——provider 停发数据也会被中止并报 `PROVIDER_TIMEOUT`,不会挂死。
- **冷启动单次重试**:已有内容落地后不再重试,避免重复输出;**超时不重试**(重试会使等待翻倍,超出墙钟语义)。
- **Anthropic 关闭 thinking**:防止推理模型把 token 预算花在 thinking 块上导致正文为空。
- **桌面层可逆**:app.asar 只追加/剥离一行注入;`remove` 后归档内容与官方一致,
  回环测试按字节验证。

## 开发

```bash
cd plugins/prompt-enhancer
npm install        # 仅 devDependencies(typescript、@types/node)
npm run build      # tsc → dist/,并同步 system-prompt.generated.js 与 overlay 版本号
npm test           # 71 个测试:管线单测 + 超时回归 + asar 补丁回环
npm run smoke      # 进程级端到端:MCP 握手 + CLI 标记协议 + 版本/生成物一致性校验
```

版本号以 `package.json` 为单一来源:MCP `serverInfo.version` 运行时读取 manifest;
`overlay.js` 的 `VERSION` 由构建脚本盖章;`smoke` 校验三者与
`system-prompt.generated.js` 一致,可在发布前拦截「改了源码忘记 build」的漂移。

本地无密钥冒烟:设置 `PROMPT_ENHANCER_PROVIDER=mock`。

## 配置(ZCode userConfig,装后可改;桌面按钮另读 config.json)

| 键 | 默认 | 说明 |
| --- | --- | --- |
| provider | `glm` | `glm` / `openai-compatible` / `anthropic` / `mock`;留空自动探测可用密钥 |
| api_key | 空 | 留空则读环境变量 `ZAI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` |
| base_url | 空 | 各提供方官方默认 |
| model | 空 | glm→`glm-4.6`,openai→`gpt-4o-mini`,anthropic→`claude-sonnet-4-5` |
| timeout_seconds | 60 | 单次增强墙钟超时(15–180 钳位,覆盖建连到流式结束) |

未配置任何密钥时,`/enhance-prompt` 自动降级为**就地增强**:命令 Markdown 内嵌与
`system-prompt.ts` 完全一致的规则(也可通过 `get_enhancement_rules` 工具取原文),
保证功能永不因缺配置而不可用。

## 卸载还原

1. `node desktop/patch-desktop.mjs remove --purge`(ZCode 退出后执行)→ app.asar 回到官方内容。
2. ZCode **设置 → 插件** 卸载本插件。官方升级 ZCode 也会自动覆盖为官方 app.asar。
