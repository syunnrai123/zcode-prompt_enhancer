# ZCode 提示词增强插件(prompt-enhancer)

把草稿改写为清晰、精炼、无歧义的指令，结合项目基本情况与最近 Git 改动。按 ZCode 插件规范(`.zcode-plugin/plugin.json`)实现，零 npm 运行时依赖。

## 入口

- **桌面 ✦ 按钮**：使用当前会话模型，自动采集项目摘要，结果校验完成后在独立面板展示。用户确认后才写入草稿；支持停止、恢复原稿和模型切换取消。草稿未变时再次点击直接复用上次结果(仅面板内「重新生成」会重新请求)；输入栏清空后面板同步清空；面板保留最近 10 条增强历史，可单条删除或点击回填。需安装桌面集成(见 `desktop/README.md`)。
- **`/enhance-prompt` 与技能**：优先调用 `enhance_prompt`，无独立 provider Key 时按同一规则就地改写。可先用 `get_project_context` 获取摘要，无 Key 也可用。
- **MCP 工具**：`enhance_prompt`、`get_project_context`、`get_enhancer_info`、`get_enhancement_rules`。
- **CLI**：`node dist/cli.js`，stdin JSON 支持 `prompt`、`workspacePath`、`context`；stdout 为标记协议。

## 项目上下文

不使用选区、光标、当前编辑文件或源码片段。`selection` 在桌面代码中仅指**模型选择**。

自动采集需要明确的项目目录：桌面从当前会话读取；MCP/CLI 通过 `workspacePath` 传入。不得使用插件安装目录或进程工作目录猜测项目。

采集内容(大项目优先,按当前草稿与 Git 改动排序):

- **路径索引**:Git 项目建立有界索引(`ls-files`,最多 50000 条记录 / 4 MiB / 单条 1024 字符,保留完整前缀并注明截断);非 Git 项目用公平的文件系统遍历(最多 8 层 / 128 个目录 / 2048 待遍历项)。深层文件不会被浅层截断丢弃。
- **项目概况与模块概览**:索引文件数、模块数,以及每个模块的文件数与语言分布(最多 17 个模块行,兼顾广度与热点)。
- **相关路径**:与草稿(精确路径 > 文件名关键词,含中英映射如 登录→login)和 Git 改动最相关的最多 24 条路径。
- **技术栈与项目类型**:从最多 16 个项目清单采样推断(根目录与改动模块优先),包括 Node.js、TypeScript、React、Vue、Python、Rust、Go、JVM、PHP 等;不是权威依赖清单。
- **Git**:分支、工作区改动(按相关性排序,最多 40 条),最近 3 次提交标题与改动文件名。仓库子目录工作区时路径统一相对该子目录,不混入仓库根其他内容。只读元数据,不读取 diff 正文、不执行项目脚本、不拉取远程仓库。

总采集预算为 **3 秒**。清单单文件不超过 16 KiB;敏感路径(`.env`、SSH 密钥、凭据文件、`dist`/`node_modules` 等)与符号链接在索引与摘要中一律排除。最终上下文最多 **6000 字符**,各段(概况 / 技术栈 / 相关路径 / 模块 / 目录 / Git / 说明)有独立预算并按槽位分配,避免长路径挤掉说明与提交摘要。缺失或截断会注明,模型不得据此虚构事实。

大项目基准(`node scripts/benchmark-context.mjs`,2 万+ 文件合成索引):采集约 0.7–1.4 秒、摘要约 3.4k 字符、8 层深目标文件保留;路径选择耗时 <100ms。

远程或无法确认与本地主机对应的工作区不读取同名本地目录;目前没有已验证的远程文件采集接口,会注明上下文不可用。

示例(MCP / CLI 的 stdin JSON):

```json
{
  "prompt": "修复登录后没有跳转的问题",
  "workspacePath": "/path/to/your/project"
}
```

也可直接提供已知摘要(不与 workspacePath 同时重复采集):

```json
{
  "prompt": "修复登录后没有跳转的问题",
  "context": {
    "projectType": "web application",
    "techStack": ["React", "TypeScript"],
    "directoryStructure": ["src/", "src/auth/"],
    "gitChanges": { "workingTree": ["M src/auth/session.ts"] }
  }
}
```

## 网络与输出安全

- 正确按 SSE 事件组装多行数据,兼容换行与 UTF-8 字节拆分;按显式事件 ID 去重,不删除正常重复文字。
- 外部 OpenAI/GLM 流要求 `finish_reason: "stop"` 与 `[DONE]`;Anthropic 要求正常 `stop_reason` 和 `message_stop`。未结束、截断、错误事件、工具调用及畸形数据不会当成成功提示词。
- 网络重置、提前断流、HTTP 408/429/5xx 等可恢复失败最多重试一次。失败批次文本全部丢弃;重试、退避与流读取共享原始墙钟预算。认证/请求错误、超时、长度截断及非法输出不重试。
- 完成后立即关闭流,不等连接自然断开;限制事件、响应与输出体积。统一拒绝异常 Unicode、控制字符和清理后为空的结果。
- CLI 只在完整成功后输出 `[CONTENT_DELTA]` 分块与唯一 `[ENHANCED]`;失败只输出 `[ENHANCED_ERROR]`。桌面预览同样不展示未经验证的部分结果。
- 桌面路径由 ZCode Host 管理底层网络;插件处理可识别的 RPC 网络错误和返回的结束/异常字段。Host 未返回结束原因时,无法从最终文本独立证明底层流的完整性。

默认外部请求超时 60 秒,可设为 15–180 秒;桌面请求上界 120 秒。输出预算为 `min(8192, max(1024, ceil(len * 0.8)))`,封顶 **8192 tokens**。精炼契约为原稿约 1.5 倍、最多一个文件/符号锚点。

## 结构与构建

```text
plugins/prompt-enhancer/
├── .zcode-plugin/plugin.json     插件/MCP/配置清单
├── commands/ + skills/          命令与技能规则
├── src/context/                 只读项目/Git 采集(路径索引、模块与相关性摘要)
├── src/core/                    类型、组装、规则与输出校验
├── src/desktop/                 Host 项目增强编排
├── src/strategies/              GLM/OpenAI/Anthropic/mock + SSE
├── src/mcp/                     JSON-RPC 分发与 stdio
├── desktop/                     注入脚本与可逆 asar 安装器(见 desktop/README.md)
├── dist/                        随插件分发的编译产物
└── test/ + scripts/             回归、冒烟与大项目采集基准
```

```bash
cd plugins/prompt-enhancer
npm install
npm run build
npm test
npm run smoke
```

构建同步系统规则与 overlay 版本。`dist/` 入库分发,源码修改后必须重建。测试覆盖项目采集、网络故障、原子输出、取消和 asar 双入口回环;网络测试只连接本机回环模拟服务,不调用真实付费模型。

## 配置

外部 provider 在 ZCode 插件设置或环境变量中配置(键见 `.zcode-plugin/plugin.json` 的 `userConfig`):`provider` 默认 `glm`,可选 `openai-compatible` / `anthropic` / `mock`;Key 可回退到 `ZAI_API_KEY`、`OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`;支持自定义 `base_url`、`model` 和 `timeout_seconds`。桌面按钮复用当前会话模型,不读独立 Key。

桌面集成安装/卸载/排查见 [desktop/README.md](desktop/README.md):在 ZCode 退出后运行 `desktop/install.cmd`(或 `node desktop/patch-desktop.mjs install --after-exit` 后台安装),卸载用 `remove --purge`。安装器与卸载器用合成归档测试,不会在测试时改写实际应用。
