# 桌面输入框增强按钮(desktop 集成层)

在 ZCode 桌面端输入框工具行注入一个 **✦ 增强按钮**:点击后读取当前草稿,调用增强管线,
在输入框卡片内的**独立预览面板**里流式展示结果;用户点「使用增强结果」才会替换输入框草稿,
之后可随时点「恢复原稿」回退。全程不改 ZCode 官方代码,只向 `app.asar` 的
`out/main/index.js` 尾部追加**一行**动态 import。

## 组成

| 文件 | 运行位置 | 职责 |
| --- | --- | --- |
| `inject-main.cjs` | 主进程 | 向每个窗口注入 overlay;轮询渲染进程的增强请求,以 `ELECTRON_RUN_AS_NODE=1` 拉起 `dist/cli.js`,把 `[CONTENT_DELTA]` 流回预览面板 |
| `overlay.js` | 渲染进程 | 找到输入框(`data-testid="v4-composer-input"`)与工具行(`group/toolbar`),挂按钮与预览面板;用官方 `__zcodeLexicalInputE2E` 桥读写草稿;主题全部跟随 `--color-*` 变量 |
| `patch-desktop.mjs` | Node CLI | `install` / `remove` / `check` / `doctor`,纯 Node 实现 asar 读写,原子替换,幂等 |
| `install.cmd` / `uninstall.cmd` | Windows | 双击安装/卸载(自动 `cd /d`,无需手敲命令) |
| `asar-lib.mjs` | — | asar 头解析/重写原语,与回环测试共享 |
| `config.example.json` | — | 运行时配置模板(provider/api_key 等) |

## 安装(需本机有 Node ≥ 18,且 ZCode 已完全退出)

> 已从插件市场安装的用户,`dist/` 已随插件分发,无需 npm install / build,直接双击
> `desktop\install.cmd` 即可(等价于下面的 `node desktop/patch-desktop.mjs install`)。
> Windows 的 `cmd` 里 `cd` 不切换盘符,请务必先 `cd /d` 或直接双击脚本。

从源码安装时:

```bash
cd /d E:\JSProjects\zcode-plugin-prompt-enhancer\plugins\prompt-enhancer
npm install && npm run build
node desktop\patch-desktop.mjs install            # 自动探测 app.asar;也可 --asar <路径>
```

或直接双击 `desktop\install.cmd`。安装器会把 loader、overlay 与 `dist/` 复制到自包含的运行时目录
`~/.zcode/zcode-prompt-enhancer/`(与 ZCode 插件缓存解耦,插件更新不影响按钮),
并在该目录的 `config.json` 里保留/合并你的配置:

```json
{ "provider": "", "api_key": "", "base_url": "", "model": "", "timeout_seconds": "45", "lang": "zh" }
```

- `provider` 留空时自动探测环境变量密钥(`ZAI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`);
  也可直接填 `glm` / `openai-compatible` / `anthropic` / `mock`。
- **也可以直接复用插件设置**:ZCode **设置 → 插件 → 提示词增强器** 里填写的 provider / API Key
  会自动被按钮读取(存于 `~/.zcode/cli/config.json` 的 `plugins.options`),无需重复配置。
- 未配置密钥时点击按钮会**立即**弹出明确错误(不会一直转圈);`/enhance-prompt` 命令路径仍可就地增强。

重启 ZCode 后,输入框工具行会出现 ✦ 按钮(位于**模型选择/上下文容量控件的左侧**)。

## 使用流程

1. 在输入框写草稿 → 点 ✦:面板打开,流式生成增强结果(可随时直接修改文本)。
2. 生成中可点 **取消**(或再点一次 ✦、按 Esc)立即停止,进程会被杀掉。
3. 满意 → 「使用增强结果」:草稿被替换(按钮变绿,面板提示可回退)。
4. 反悔 → 「恢复原稿」:一键还原原始草稿。
5. 「重新生成」再试一次;× 关闭面板。**不点确认就绝不会动输入框。**
6. 若主进程桥接失效,面板会在 3 秒内显示「主进程桥接未响应」,90 秒硬超时自动取消。

## 排查

```bash
node desktop\patch-desktop.mjs doctor
```

依次输出:asar 注入状态 → 运行时文件 → provider/key 来源(不显示密钥)→
`~/.zcode/zcode-prompt-enhancer/loader.log` 末尾 15 行。

## 卸载(还原 ZCode 官方状态)

```bash
node desktop/patch-desktop.mjs remove --purge     # ZCode 退出后执行
```

- `remove` 从 `out/main/index.js` 剥离本项目的注入行并重写归档——**归档内容回到官方状态**;
  未打过补丁时是空操作。`--purge` 同时删除运行时目录。
- 再到 ZCode **设置 → 插件** 卸载 "Prompt Enhancer",即完全回到未安装状态。
- 官方 ZCode 升级会用官方 app.asar 整体覆盖,注入自动消失(升级后需重新 install)。
- 容错:若只删了运行时目录而忘记 remove,残留注入行加载失败只会在日志打印一条错误,
  不影响 ZCode 运行;随后 `remove` 仍可清理。

## 状态检查

```bash
node desktop/patch-desktop.mjs check
```

回环保证:`test/desktop-patch.test.mjs` 用合成归档验证 install→remove 后每个文件字节
与原始一致(含 4 字节对齐边界),并校验 loader/overlay 语法。
