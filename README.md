# zcode-plugin-prompt-enhancer

ZCode 提示词增强插件。仓库根目录本身即插件市场(Git 源只识别仓库根部的
`marketplace.json` 或 `.claude-plugin/marketplace.json`):

- 市场清单:[marketplace.json](marketplace.json)
- 插件源码:[plugins/prompt-enhancer](plugins/prompt-enhancer)(架构说明见其 [README.md](plugins/prompt-enhancer/README.md))
- 桌面输入框按钮(✦ 增强/预览/回退):[plugins/prompt-enhancer/desktop](plugins/prompt-enhancer/desktop/README.md)

## 快速开始

1. 在 ZCode **插件市场 → 添加 → 添加插件市场** 中粘贴仓库地址:

   ```
   https://github.com/syunnrai123/zcode-prompt_enhancer.git
   ```

   本地测试也可粘贴目录 `E:\JSProjects\zcode-plugin-prompt-enhancer`。

2. 添加后在 **个人 → zcode-prompt-enhancer** 找到 "Prompt Enhancer" 安装。

3. 启用输入框按钮：**市场安装只安装命令/MCP，不会自动启用桌面按钮**。
   双击 `plugins\prompt-enhancer\desktop\install.cmd`，再完全退出 ZCode（含托盘）；
   安装器会等待退出后自动安装。也可在当前会话运行：

   ```
   cd /d E:\JSProjects\zcode-plugin-prompt-enhancer\plugins\prompt-enhancer
   node desktop\patch-desktop.mjs install --after-exit
   ```

   后台安装不会强制关闭或重启 ZCode，等待期间不会改写 `app.asar`。
   已从插件市场安装时无需 npm install/build，`dist/` 已随插件分发。
   安装结束后启动 ZCode，模型和上下文容量左边会出现 **✦ 增强**，生成时显示 **■ 停止**。
   官方的圆圈不是增强按钮。

4. 配置（可选）：输入栏增强直接复用**当前会话模型**，无需任何 Key。仅 `/enhance-prompt` 命令和 MCP 工具在需要独立服务时才配置 provider / API Key。
   `node desktop\patch-desktop.mjs doctor` 可查看 main/host 注入状态与运行时版本。

## 卸载还原官方状态

1. 完全退出 ZCode 后双击 `plugins\prompt-enhancer\desktop\uninstall.cmd`
   (或 `cd /d ... && node desktop\patch-desktop.mjs remove --purge`)。
2. ZCode **设置 → 插件** 卸载 Prompt Enhancer。

回环测试(`npm test`)按字节验证 install→remove 后 app.asar 与官方内容一致。
