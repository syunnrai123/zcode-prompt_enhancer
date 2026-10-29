# zcode-plugin-prompt-enhancer

ZCode 提示词增强插件。仓库根目录本身即插件市场(Git 源只识别仓库根部的
`marketplace.json` 或 `.claude-plugin/marketplace.json`):

- 市场清单:[marketplace.json](marketplace.json)
- 插件源码:[plugins/prompt-enhancer](plugins/prompt-enhancer)(架构与配置详见其 [README.md](plugins/prompt-enhancer/README.md))
- 桌面输入框按钮(✦ 增强/预览/回退):[plugins/prompt-enhancer/desktop](plugins/prompt-enhancer/desktop/README.md)

## 安装

1. 在 ZCode **插件市场 → 添加 → 添加插件市场** 中粘贴本仓库的 Git 地址(即 GitHub 仓库克隆 URL)。

2. 添加后在 **个人 → zcode-prompt-enhancer** 找到 "Prompt Enhancer" 安装。

3. 启用输入框按钮(可选)：**市场安装只安装命令/MCP，不会自动启用桌面按钮**。
   完全退出 ZCode(含托盘)后，双击 `plugins\prompt-enhancer\desktop\install.cmd`;
   或在任意终端运行 `node desktop/patch-desktop.mjs install --after-exit` 提交后台安装，
   安装器会等待 ZCode 退出后自动写入，不强制关闭应用，等待期间不改写 `app.asar`。
   已从插件市场安装时无需 npm install/build，`dist/` 已随插件分发。
   安装结束后启动 ZCode，模型和上下文容量左边会出现 **✦ 增强**，生成时显示 **■ 停止**。

4. 配置(可选)：输入栏增强直接复用**当前会话模型，不复用会话/聊天历史**，无需任何 Key。仅 `/enhance-prompt` 命令和 MCP 工具在需要独立服务时才配置 provider / API Key(见插件 README 的「配置」)。
   `node desktop/patch-desktop.mjs doctor` 可查看 main/host 注入状态与运行时版本。

增强时只采集项目清单、项目类型/技术栈、模块/路径摘要和最近 Git 元数据(按草稿与改动排序)，不扫描源码或 diff 正文，不获取聊天历史、编辑器选区/光标/当前文件。网络断流不会输出半截结果，可恢复失败最多重试一次。详见[项目上下文与网络边界](plugins/prompt-enhancer/README.md)。仓库修改不会热更新已安装的 Host 副本；更新插件后，需重新安装桌面集成并重启 ZCode，以加载新的编译规则与上下文采集运行时。

## 增强质量

先忠实保留用户意图与显式细节，再精炼表达：保留任务类型、原稿中指定的全部文件、数字/版本、范围和排除项，不把分析升级为实施。不设固定扩写倍数或单文件锚点限制；复合草稿可用短列表，清楚草稿只轻度润色，不套模板、不新增功能/要求/验收标准。

**内部上下文只作静默依据，绝不写入输出**：采集到的项目类型、技术栈、目录/文件路径和最近 Git 摘要仅用于在内部识别任务领域，**绝不当作用户输入复述进增强后的提示词**（原稿未提及时，输出不带元数据中的路径、技术栈标签、Git 分支/改动或元语言说明）。命令/技能在调用工具前，仅用用户明确提供或确认、仍适用且相关的对话意图做最小消歧，不塞入仓库概况、不传整段历史。公开 `prompt` / `workspacePath` / `context` 入参不变；内部 JSON 分开 `draft` 与可选 `projectMetadata`，元数据仍限 **6000 字符**，不因该预算截断草稿，也不扩展采集能力。

增强结果只包含提示词，不附改写说明、不回答或执行草稿、不为增强另行追问，但保留用户原有问题。MCP 会在独立内容块附带 provider/model 诊断，命令/技能的最终输出不包含这段诊断。规则要求移除改写结果中的实际秘密值，而非技术术语、配置名或占位符；接口没有通用的请求前脱敏器，不应提交真实凭据。

质量样例和语义评估标准见 [evals/prompt-quality.md](plugins/prompt-enhancer/evals/prompt-quality.md)。自动化检查覆盖组装、规则同步、传输和确定性输出边界；mock、字符串断言和格式检查不能证明模型语义质量。语义效果需另行样例审查或真实模型对比，不代表已完成模型评测。详见插件 [README.md](plugins/prompt-enhancer/README.md#增强质量)。

## 卸载还原官方状态

1. 完全退出 ZCode 后双击 `plugins\prompt-enhancer\desktop\uninstall.cmd`
   (或在插件目录运行 `node desktop/patch-desktop.mjs remove --purge`)。
2. ZCode **设置 → 插件** 卸载 Prompt Enhancer。

回环测试(`npm test`)按字节验证 install→remove 后 app.asar 与官方内容一致。

## 开发

```bash
cd plugins/prompt-enhancer
npm install
npm run build
npm test
npm run smoke
```

`dist/` 与 `desktop/overlay.js`（由 `desktop/src/overlay.ts` 编译）随插件分发并入库，修改源码后必须重新构建。发版用 `node scripts/release.mjs --version X.Y.Z` 统一更新四处版本号，`node scripts/release.mjs` 校验一致性（smoke 会强制执行）。桌面集成相关细节见
[plugins/prompt-enhancer/desktop/README.md](plugins/prompt-enhancer/desktop/README.md)。
