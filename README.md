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

4. 配置(可选)：输入栏增强直接复用**当前会话模型**，无需任何 Key。仅 `/enhance-prompt` 命令和 MCP 工具在需要独立服务时才配置 provider / API Key(见插件 README 的「配置」)。
   `node desktop/patch-desktop.mjs doctor` 可查看 main/host 注入状态与运行时版本。

增强时使用项目类型、技术栈、模块/路径摘要(按草稿与 Git 改动排序)和最近 Git 概要，不使用编辑器选区/光标。网络断流不会输出半截结果，可恢复失败最多重试一次。详见[项目上下文与网络边界](plugins/prompt-enhancer/README.md)。插件更新后需重新安装桌面集成并重启，以加载新的 Host 项目采集运行时。

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
