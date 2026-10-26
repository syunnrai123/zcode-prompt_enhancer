/* Renderer-side generation bridge.
 *
 * Calls the Host's own `workspace/generateText` service through the exact
 * zcodeAgentService instance that is already connected for this window. The
 * Host resolves the selected provider/model and its credentials, so no extra
 * API key is needed and a model switch is picked up on the next click.
 *
 * A tiny reversible Host patch adds:
 *   __peGenerateWorkspaceText({ operationId, ...generateText params })
 *   __peCancelWorkspaceText({ operationId })
 * The cancel RPC aborts the matching AbortController inside the Host, which
 * propagates to the underlying model request.
 */
(function () {
  "use strict";

  var current = null;

  function hostService(input) {
    if (typeof window.__peGetHostService !== "function") throw new Error("会话服务桥未就绪，请重载 ZCode");
    return window.__peGetHostService(input);
  }

  function systemPrompt() {
    var prompt = window.__PE_SYSTEM_PROMPT;
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("增强规则未加载，请重新安装桌面集成");
    return prompt;
  }

  /* Mirrors computeMaxTokens in src/core/prompt-builder.ts — keep the two in
   * sync (floor 1024, 0.8 chars→tokens, ceiling 8192). */
  function maxTokensFor(text) {
    var len = Number.isFinite(text.length) && text.length > 0 ? Math.ceil(text.length) : 0;
    return Math.min(8192, Math.max(1024, Math.ceil(len * 0.8)));
  }

  function operationId() {
    return "pe-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  window.__peHostBridge = {
    available: function (input) {
      try {
        var services = hostService(input);
        return !!(services && services.zcodeAgentService &&
          typeof services.zcodeAgentService.__peGenerateWorkspaceText === "function" &&
          typeof services.zcodeAgentService.__peCancelWorkspaceText === "function");
      } catch (e) { return false; }
    },

    reasonUnavailable: function (input) {
      try {
        var services = hostService(input);
        if (!services || !services.zcodeAgentService) return "当前会话服务连接不可用，请重试或重启 ZCode";
        return "桌面集成版本不匹配（Host 增强接口未启用），请重新运行 desktop/install.cmd 并重启 ZCode";
      } catch (e) { return String(e && e.message || e); }
    },

    generate: function (input, draft, context) {
      if (current) return Promise.reject(new Error("已有增强正在进行"));
      var services;
      try { services = hostService(input); } catch (e) { return Promise.reject(e); }
      var agent = services && services.zcodeAgentService;
      if (!agent || typeof agent.__peGenerateWorkspaceText !== "function") {
        return Promise.reject(new Error("桌面集成版本不匹配（Host 增强接口未启用），请重新运行 desktop/install.cmd 并重启 ZCode"));
      }
      var id = operationId();
      var fullPrompt = "Please optimize the following prompt:\n\n" + draft;
      current = { id: id, agent: agent, cancelled: false };
      var args = {
        operationId: id,
        workspacePath: context.workspacePath,
        selection: context.selection,
        querySource: "prompt_enhancer",
        maxOutputTokens: maxTokensFor(draft)
      };
      if (context.workspaceIdentity) args.workspaceIdentity = context.workspaceIdentity;
      if (context.remoteSessionId) args.remoteSessionId = context.remoteSessionId;
      args.messages = [
        { role: "system", content: systemPrompt() },
        { role: "user", content: fullPrompt }
      ];
      return agent.__peGenerateWorkspaceText(args).then(function (result) {
        if (current && current.id === id) current = null;
        if (!result || typeof result.text !== "string" || !result.text.trim()) {
          throw new Error("当前会话模型返回了空结果");
        }
        return {
          text: result.text.trim(),
          provider: context.selection.providerId,
          model: context.selection.modelId,
          selection: result.selection || context.selection
        };
      }, function (error) {
        if (current && current.id === id) current = null;
        throw error;
      });
    },

    cancel: function () {
      var run = current;
      if (!run) return Promise.resolve(false);
      current = null;
      run.cancelled = true;
      try { run.agent.__peCancelWorkspaceText({ operationId: run.id }).catch(function () { }); } catch (e) { }
      return Promise.resolve(true);
    }
  };
})();
