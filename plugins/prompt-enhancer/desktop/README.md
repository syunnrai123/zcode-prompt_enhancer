# 桌面输入框增强按钮（desktop 集成层）

在 ZCode 桌面端输入框工具行注入一个 **✦ 增强按钮**：点击后读取当前草稿，直接用**当前会话选中的模型**
生成增强结果，在输入框卡片内的**独立预览面板**中展示；点「使用增强结果」才会替换草稿，
随后可随时「恢复原稿」。请求携带**项目类型、技术栈、模块/路径摘要和最近 Git 改动**（按当前草稿相关性排序），不读取源码正文，不使用编辑器选区/光标上下文。结果完整校验后才展示，失败或取消时不会替换草稿。**不需要单独的 provider / API Key**——凭据由 ZCode Host 自己持有。

补丁完全可逆：

- `out/main/index.js` 尾部追加**一行**动态 import（注入 UI）。
- `out/host/index.js` 的 zcode-agent 服务注册处包一层可逆 wrapper（暴露
  `__peGenerateWorkspaceText` / `__peCancelWorkspaceText`，其余方法原样转发）。
- `remove` 把两处恢复为官方内容（回环测试按字节验证），`--purge` 再删运行时目录。

官方更新会整体覆盖 `app.asar`，补丁随之消失。`install` 会同时装一个**更新后自动补回**的触发器
（Windows 计划任务，静默每 15 分钟执行一次 `ensure`）。计划任务不可用时仅在下次 Windows
登录时检查，详见下方降级说明。

## 组成

| 文件 | 运行位置 | 职责 |
| --- | --- | --- |
| `inject-main.cjs` | 主进程 | 向每个渲染窗口按依赖顺序注入下列四个脚本，记录 `loader.log` |
| `system-prompt.generated.js` | 渲染进程 | 由 `scripts/embed-system-prompt.mjs` 生成的唯一权威增强规则 |
| `session-context.js` | 渲染进程 | 读取已提交 composer 的当前模型选择与工作区路由（`v4-model-config` + React fiber） |
| `host-bridge.js` | 渲染进程 | 将草稿和模型/工作区路由送给 Host 项目增强接口；处理取消与旧版本协议 |
| `overlay.js` | 渲染进程 | 工具行 ✦/■ 按钮、预览面板、应用/恢复/取消；模型切换自动停止旧请求。由 `desktop/src/overlay.ts` 编译生成，勿手改 |
| `desktop/src/overlay.ts` | 源码 | overlay 的 TypeScript 源（`tsconfig.overlay.json` 编译为 `overlay.js`） |
| `host-patch.mjs` | — | Host bundle 可逆补丁的 apply/strip/检测；已知注册字面量 + 自动推导锚点 |
| `autostart.mjs` | — | 更新后自动补回的触发器：计划任务（每 15 分钟）与启动文件夹兜底 |
| `dist/desktop/workspace-enhancer.js` | Host | 采集项目摘要、组装提示词、有限网络重试和完整结果校验 |
| `dist/context/project-context.js` | Host | 有大小/时间限制的只读项目清单、目录和 Git 采集 |
| `patch-desktop.mjs` | Node CLI | `install` / `ensure` / `remove` / `check` / `doctor`，纯 Node 实现 asar 双入口读写，原子替换，幂等 |
| `install.cmd` / `uninstall.cmd` | Windows | 双击安装/卸载（自动 `cd /d`，安装器等待 ZCode 退出） |
| `asar-lib.mjs` | — | asar 头解析/重写原语（含 per-file integrity 重算与 Electron fuse 探测），与回环测试共享 |
| `scripts/release.mjs` | — | 四个版本清单的统一 bump/一致性检查（`--check` 由 smoke 强制执行） |

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

### 更新后自动补回

`install` 会注册一个 Windows 计划任务 `ZCodePromptEnhancerEnsure`，每 15 分钟静默运行一次
`ensure`。已打补丁且运行时完整时不会重写归档；发现 `app.asar` 是官方版本时，
ZCode 没运行就当场补回，正在运行就等它退出后再补。检查最多可能延迟 15 分钟，
补回完成后重新启动 ZCode 才会加载按钮；不保证更新后第一次启动前已经完成检查。

- 计划任务无法创建时（部分非提权账号）自动退化为**启动文件夹**里的静默 `.vbs`，
  **仅在下次 Windows 登录时检查一次，不做周期检查**。同一登录会话内更新后需手动运行
  `ensure` / 安装器，或等下次 Windows 登录；重启 ZCode 本身不会触发此降级入口。
- 触发器与运行时目录解耦：计划任务调用的是 `~/.zcode/zcode-prompt-enhancer/` 内自包含的
  副本（含 `patch-desktop.mjs` 等），不依赖插件缓存或源码路径。
- **任务动作必须显式写出解释器**：`"C:\Windows\System32\wscript.exe" //B //Nologo "<runtime>\ensure.vbs"`。
  把 `.vbs` 本身作为动作时，计划任务服务要靠 shell 文件关联去解析，在服务上下文里解析不到，
  会弹出 Windows「选取应用」窗口并一直阻塞，`node` 根本不会启动（曾实际发生，任务状态卡在
  「正在运行」）。`//B` 同时抑制脚本出错时的模态错误框。
- 不想启用：`install --no-autostart`，或设置环境变量 `ZCODE_PE_NO_AUTOSTART=1`。
- `remove` 会一并注销触发器，避免刚卸载就被补回。

### 锚点自动推导

ZCode 每次发版都会重新压缩 Host bundle 里的注册标识（`.register(<token>,<service>)`），
硬编码字面量可能被后续版本复用于其他服务。补丁使用随运行时分发的 Acorn 解析 JavaScript，
验证实际注册调用、token 的 `ZCodeAgent` 引用以及服务绑定和工厂的可见作用域与来源；
有结构证据时不允许旧短名覆盖正确绑定，重复、冲突或无法确认的候选会拒绝安装。
已知字面量只用于没有结构冲突的旧布局兼容，不匹配字符串或注释中的伪调用。
`remove` 按实际 wrapper 调用还原，不依赖已知字面量列表，保留原始空白与 `$` 标识符。

从源码安装：

```bash
cd /d E:\JSProjects\zcode-plugin-prompt-enhancer\plugins\prompt-enhancer
npm install && npm run build          # build 会同时生成 system-prompt.generated.js
node desktop\patch-desktop.mjs install            # 自动探测 app.asar；也可 --asar <路径>
```

安装器把脚本及 `dist/` 复制到自包含运行时目录 `~/.zcode/zcode-prompt-enhancer/`，为 `dist/` 写入 ESM 包边界（与插件缓存解耦）。
`/enhance-prompt` 命令与 MCP 工具仍可选用外部 provider（插件设置或环境变量），与按钮无关。

项目采集最多 3 秒:Git 项目建立最多 50000 条的有界路径索引,非 Git 项目最多 8 层 / 128 目录;摘要含模块概览(≤17)与按草稿/Git 改动排序的相关路径(≤24),最终最多 8000 字符。Git 仅包含状态与最近 3 次提交/文件名,不读取 diff 正文;仓库子目录工作区路径统一相对该子目录。
远程或不确定的工作区不会被误当作本地目录；无法采集时会在提示词中注明。模型 `selection` 仅指当前模型配置，不是编辑器选区。
旧版安装需重新运行安装器并重启 ZCode；若 Host 协议不是新版，按钮会提示更新而不是静默丢失项目上下文。

## 使用流程

1. 输入草稿 → 点 ✦：面板打开，面板状态栏显示当前模型，生成中显示已用秒数。
2. 生成中点 **■ 停止** / **取消** / Esc / × 立即中止；请求真正取消，而不是只停止等待。
3. 满意 → 「使用增强结果」：草稿被替换（按钮变绿，可回退）。
4. 反悔 → 「恢复原稿」；连续应用增强后仍能还原最初草稿。
5. 「重新生成」再试一次；× 关闭面板。再次点 ✦ 打开现有预览，**草稿未变则直接复用上次结果，不重复请求**；只有「重新生成」会强制重跑。
6. 生成期间切换会话模型：旧请求自动停止并提示，重新生成即用新模型。
7. 120 秒硬超时自动取消。
8. 原生输入框被清空时，预览面板同步清空，不残留旧提示词。
9. 面板「历史 N」保留最近 10 条增强记录（按会话去重，重试替换同条），每条可删除，点击回填到预览框；行内显示草稿摘要与生成时间。手工改过预览文本时标题旁显示「已编辑」，复用/重试不会静默吞掉这些修改。

## 排查

```bash
node desktop\patch-desktop.mjs doctor
```

依次输出：main 注入状态 → host 桥状态 → 当前/可推导的注册锚点 → 运行时文件与版本 →
更新后自动补回触发器的状态 → 模型来源说明 → `loader.log` 末尾 15 行。
按钮常见错误信息都会指向具体修复步骤（重装集成 / 重启 ZCode）。

想确认自动补回是否生效，看 `auto-repatch:` 一行：`scheduled task ...` 表示周期任务，
`startup ... next logon ... no periodic checks` 表示仅登录检查的降级模式；`not installed` 表示未启用。
`ensure` 会检查运行时必需文件及协议；文件缺失时从完整源副本刷新，自包含源本身损坏则明确提示重装。
安装、补回、卸载共用跨进程锁，异常退出留下锁时会报超时及锁路径，不会擅自抢占锁；
确认没有其他安装进程后再按错误提示清理陈旧锁。

## 卸载（还原 ZCode 官方状态）

```bash
node desktop\patch-desktop.mjs remove --purge     # ZCode 退出后执行
```

- `remove` 先禁用补回并取消旧安装器、注销触发器，再剥离 main 注入与 host wrapper——
  **两个入口都回到官方字节**。触发器删除失败会报告错误并停止清理，修复权限后重试，不会报告完全卸载。
- `--purge` 同时删除运行时目录；旁边保留小型 `.install-control.json` 取消标记，防止已排队的旧进程
  在目录删除后重新补回。再次手动 `install` 会创建新代次；再到 ZCode 设置 → 插件卸载 Prompt Enhancer。
- 官方 ZCode 升级会整体覆盖 `app.asar`；周期任务在下次检查/应用退出后补回，Startup 降级模式
  仅在下次 Windows 登录时检查，或手动重新运行 `install`。

## 状态检查

```bash
node desktop\patch-desktop.mjs check
```

回环保证：`test/desktop-install.test.mjs` 与 `test/desktop-patch.test.mjs` 用合成归档验证
install→remove 后 main/host 每个文件与原始一致（含 4 字节对齐边界），并校验脚本语法。
