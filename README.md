# zcode-plugin-prompt-enhancer

ZCode 提示词增强插件的工作区。插件源码与本地测试市场位于 `plugins/`:

- 插件源码:[plugins/prompt-enhancer](plugins/prompt-enhancer)(架构说明见其 [README.md](plugins/prompt-enhancer/README.md))
- 桌面输入框按钮(✦ 增强/预览/回退):[plugins/prompt-enhancer/desktop](plugins/prompt-enhancer/desktop/README.md)
- 测试市场清单:[plugins/marketplace.json](plugins/marketplace.json)

## 快速开始

1. 在 ZCode **插件市场 → 添加 → 添加插件市场** 中粘贴市场根目录:

   ```
   E:\JSProjects\zcode-plugin-prompt-enhancer\plugins
   ```

2. 在 **个人 → dev-zcode-plugin-prompt-enhancer-46604151** 找到 "Prompt Enhancer" 安装。

3. (可选,推荐)启用输入框按钮:完全退出 ZCode 后运行

   ```bash
   cd E:\JSProjects\zcode-plugin-prompt-enhancer\plugins\prompt-enhancer
   node desktop\patch-desktop.mjs install
   ```

   重启 ZCode,输入框工具行出现 ✦ 按钮。配置文件在
   `%USERPROFILE%\.zcode\zcode-prompt-enhancer\config.json`(provider / api_key)。

## 卸载还原官方状态

1. 完全退出 ZCode 后运行 `node desktop\patch-desktop.mjs remove --purge`。
2. ZCode **设置 → 插件** 卸载 Prompt Enhancer。

回环测试(`npm test`)按字节验证 install→remove 后 app.asar 与官方内容一致。
