# 桌面输入框增强按钮（desktop 集成层）

在 ZCode 桌面端输入框工具行注入一个 **✦ 增强按钮**：点击后读取当前草稿，直接用**当前会话选中的模型**
生成增强结果，在输入框卡片内的**独立预览面板**中展示；点「使用增强结果」才会替换草稿，
随后可随时「恢复原稿」。请求携带**项目类型、技术栈、模块/路径摘要和最近 Git 改动**（按当前草稿相关性排序），不读取源码正文，不使用编辑器选区/光标上下文。结果完整校验后才展示，失败或取消时不会替换草稿。**不需要单独的 provider / API Key**——凭据由 ZCode Host 自己持有。

补丁完全可逆：

- `out/main/index.js` 尾部追加**一行**动态 import（注入 UI）。
- `out/host/index.js` 的 zcode-agent 服务注册处包一层可逆 wrapper（暴露
  `__peGenerateWorkspaceText` / `__peCancelWorkspaceText`，其余方法原样转发）。
- `remove` 把两处恢复为官方内容（回环测试按字节验证），`--purge` 再删运行时目录。

## 组成

| 文件 | 运行位置 | 职责 |
| --- | --- | --- |
| `inject-main.cjs` | 主进程 | 向每个渲染窗口按依赖顺序注入下列四个脚本，记录 `loader.log` |
| `system-prompt.generated.js` | 渲染进程 | 由 `scripts/embed-system-prompt.mjs` 生成的唯一权威增强规则 |
| `session-context.js` | 渲染进程 | 读取已提交 composer 的当前模型选择与工作区路由（`v4-model-config` + React fiber） |
| `host-bridge.js` | 渲染进程 | 将草稿和模型/工作区路由送给 Host 项目增强接口；处理取消与旧版本协议 |
| `overlay.js` | 渲染进程 | 工具行 ✦/■ 按钮、预览面板、应用/恢复/取消；模型切换自动停止旧请求 |
| `host-patch.mjs` | — | Host bundle 可逆补丁的 apply/strip/检测，按文件 URL 导入项目增强运行时 |
| `dist/desktop/workspace-enhancer.js` | Host | 采集项目摘要、组装提示词、有限网络重试和完整结果校验 |
| `dist/context/project-context.js` | Host | 有大小/时间限制的只读项目清单、目录和 Git 采集 |
| `patch-desktop.mjs` | Node CLI | `install` / `remove` / `check` / `doctor`，纯 Node 实现 asar 双入口读写，原子替换，幂等 |
| `install.cmd` / `uninstall.cmd` | Windows | 双击安装/卸载（自动 `cd /d`，安装器等待 ZCode 退出） |
| `asar-lib.mjs` | — | asar 头解析/重写原语，与回环测试共享 |

## 安装（本机需有 Node ≥ 18）

> **插件市场安装 ≠ 桌面按钮已启用。** 市场只安装命令/MCP；按钮还需要下面的桌面集成步骤。
> 双击 `desktop\install.cmd` 后，安装器会等待所有 ZCode 进程退出再写入；不会强制关闭应用。
> 已从市场安装时脚本已随插件分发，无需 npm install / build。
> Windows 的 `cmd` 里 `cd` 不切换盘符，请使用 `cd /d` 或直接双击脚本。

也可以在 ZCode 仍运行时提交后台安装：

```bash
node desktop\patch-desktop.mjs install --after-exit
```

此命令立即返回；后台进程等待 ZCode 完全退出（含托盘）后安装，完成后手动启动 ZCode。
等待期间不会写入 `app.asar`。状态写入运行目录 `install-status.json`，日志在 `install.log`。
官方更新覆盖集成后需再次安装。

从源码安装：

```bash
cd /d E:\JSProjects\zcode-plugin-prompt-enhancer\plugins\prompt-enhancer
npm install && npm run build          # build 会同时生成 system-prompt.generated.js
node desktop\patch-desktop.mjs install            # 自动探测 app.asar；也可 --asar <路径>
```

安装器把脚本及 `dist/` 复制到自包含运行时目录 `~/.zcode/zcode-prompt-enhancer/`，为 `dist/` 写入 ESM 包边界（与插件缓存解耦）。
`/enhance-prompt` 命令与 MCP 工具仍可选用外部 provider（插件设置或环境变量），与按钮无关。

项目采集最多 3 秒:Git 项目建立最多 50000 条的有界路径索引,非 Git 项目最多 8 层 / 128 目录;摘要含模块概览(≤17)与按草稿/Git 改动排序的相关路径(≤24),最终最多 6000 字符。Git 仅包含状态与最近 3 次提交/文件名,不读取 diff 正文;仓库子目录工作区路径统一相对该子目录。
远程或不确定的工作区不会被误当作本地目录；无法采集时会在提示词中注明。模型 `selection` 仅指当前模型配置，不是编辑器选区。
旧版安装需重新运行安装器并重启 ZCode；若 Host 协议不是新版，按钮会提示更新而不是静默丢失项目上下文。

## 使用流程

1. 输入草稿 → 点 ✦：面板打开，面板状态栏显示当前模型，生成中显示已用秒数。
2. 生成中点 **■ 停止** / **取消** / Esc / × 立即中止；请求真正取消，而不是只停止等待。
3. 满意 → 「使用增强结果」：草稿被替换（按钮变绿，可回退）。
4. 反悔 → 「恢复原稿」；连续应用增强后仍能还原最初草稿。
5. 「重新生成」再试一次；× 关闭面板。再次点 ✦ 打开现有预览，不会自动重新生成。
6. 生成期间切换会话模型：旧请求自动停止并提示，重新生成即用新模型。
7. 120 秒硬超时自动取消。

## 排查

```bash
node desktop\patch-desktop.mjs doctor
```

依次输出：main 注入状态 → host 桥状态 → 运行时文件与版本 → 模型来源说明 →
`loader.log` 末尾 15 行。按钮常见错误信息都会指向具体修复步骤（重装集成 / 重启 ZCode）。

## 卸载（还原 ZCode 官方状态）

```bash
node desktop\patch-desktop.mjs remove --purge     # ZCode 退出后执行
```

- `remove` 剥离 main 注入行与 host wrapper 并重写归档——**两个入口都回到官方字节**。
- `--purge` 同时删除运行时目录；再到 ZCode 设置 → 插件卸载 Prompt Enhancer 即完全未安装。
- 官方 ZCode 升级会用官方 app.asar 整体覆盖，补丁自动消失（升级后需重新 install）。

## 状态检查

```bash
node desktop\patch-desktop.mjs check
```

回环保证：`test/desktop-install.test.mjs` 与 `test/desktop-patch.test.mjs` 用合成归档验证
install→remove 后 main/host 每个文件与原始一致（含 4 字节对齐边界），并校验脚本语法。
