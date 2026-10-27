/* Renderer-side access to the ZCode services object that owns the active Host
 * connection. The Host (not this plugin) holds the selected provider/model and
 * its credentials, so generation reuses them instead of asking for a key.
 *
 * Exposed:
 *   window.__peGetSessionContext(input)  -> committed composer routing/model ids
 *   window.__peGetHostService(input)     -> { zcodeAgentService, workspace... }
 */
(function () {
  "use strict";

  /* All ZCode anchors in one place — when a ZCode update renames a testid,
   * committed composer prop or React internals marker, adapt here only.
   * Nothing else in the file hardcodes an anchor name. */
  var ANCHORS = {
    inputId: "v4-composer-input",
    composerId: "v4-composer",
    configId: "v4-model-config",
    configAttrs: { source: "data-source", provider: "data-provider", model: "data-model", thought: "data-thought" },
    /* Props that identify the committed composer routing fiber. */
    composerProps: ["workspacePath", "sessionId", "draftConfig", "composerDraftScopeToken", "snapshot"],
    fiberPrefix: "__reactFiber$",
    /* Where the services object may live on an ancestor: containers hold
     * { zcodeAgentService, ... }; the last name is a direct prop. */
    serviceContainers: ["services", "value"],
    serviceDirect: "zcodeAgentService",
  };
  var own = Object.prototype.hasOwnProperty;

  function fail(message) {
    throw new Error("[prompt-enhancer session] " + message);
  }

  function has(object, key) {
    return object != null && own.call(object, key);
  }

  function attr(node, name) {
    return node && typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
  }

  function closestId(node, id) {
    for (var p = node; p; p = p.parentElement) {
      if (attr(p, "data-testid") === id) return p;
    }
    return null;
  }

  function active(node) {
    if (!node || !document.body || !document.body.contains(node)) return false;
    for (var p = node; p; p = p.parentElement) {
      if (p.inert || p.hidden || attr(p, "inert") !== null ||
          attr(p, "hidden") !== null || attr(p, "aria-hidden") === "true") return false;
    }
    return true;
  }

  /* Walk the actual committed FiberRoot rather than the DOM node's possibly
   * stale __reactFiber$ pointer. The returned path is root -> input. */
  function committedPath(input) {
    var keys = Object.getOwnPropertyNames(input).filter(function (key) {
      return key.indexOf(ANCHORS.fiberPrefix) === 0;
    });
    if (keys.length !== 1) fail("无法唯一定位输入框的 React fiber，请重试或更新桌面适配器");
    var attached = input[keys[0]];
    if (!attached || attached.stateNode !== input) fail("输入框 React fiber 绑定无效");

    var ancestors = new Set();
    var pending = [attached];
    var roots = new Set();
    while (pending.length) {
      var fiber = pending.pop();
      if (!fiber || ancestors.has(fiber)) continue;
      ancestors.add(fiber);
      if (ancestors.size > 512) fail("React 会话祖先结构超出支持范围");
      if (fiber.tag === 3 && fiber.stateNode && fiber.stateNode.current) roots.add(fiber.stateNode);
      if (fiber.return) pending.push(fiber.return);
      if (fiber.alternate) pending.push(fiber.alternate);
    }
    if (roots.size !== 1) fail("无法确认输入框所属的已提交 React root");
    var root = roots.values().next().value;
    var current = root.current;
    if (!current || current.tag !== 3 || current.stateNode !== root) fail("React root 尚未提交");

    var stack = [{ fiber: current, path: [] }];
    var visited = new Set();
    var found = null;
    var steps = 0;
    while (stack.length) {
      var entry = stack.pop();
      var node = entry.fiber;
      if (visited.has(node)) fail("React 已提交树存在重复节点，无法确认会话");
      visited.add(node);
      var path = entry.path.concat(node);
      if (node.stateNode === input) {
        if (node !== attached && node !== attached.alternate) fail("输入框 React 身份不一致");
        if (found) fail("输入框对应多个已提交 React 分支");
        found = path;
        continue;
      }
      for (var child = node.child; child; child = child.sibling) {
        if (++steps > 20000) fail("React 会话树遍历超出支持范围");
        if (ancestors.has(child)) stack.push({ fiber: child, path: path });
      }
    }
    if (!found) fail("输入框不在当前已提交 React 树中，请等待会话切换完成");
    return { path: found, root: root, current: current };
  }

  function requiredString(value, name) {
    if (typeof value !== "string" || !value.trim()) fail(name + "缺失，无法复用当前会话");
    return value;
  }

  function optionalString(props, name, result) {
    var value = props[name];
    if (value == null) return;
    result[name] = requiredString(value, name);
  }

  function composerIndexPath(input) {
    var committed = committedPath(input);
    var composer = closestId(input, ANCHORS.composerId);
    if (!composer) fail("无法定位输入框所属的 " + ANCHORS.composerId);
    var composerIndex = -1;
    for (var i = committed.path.length - 1; i >= 0; i--) {
      if (committed.path[i].stateNode === composer) { composerIndex = i; break; }
    }
    if (composerIndex < 0) fail("输入框和 composer 不属于同一已提交 React 分支");
    return { committed: committed, composer: composer, index: composerIndex };
  }

  function readCommittedProps(input) {
    var located = composerIndexPath(input);
    var props = null;
    for (var j = located.index - 1; j >= 0; j--) {
      var candidate = located.committed.path[j].memoizedProps;
      var matchesAll = true;
      for (var pi = 0; pi < ANCHORS.composerProps.length; pi++) {
        if (!has(candidate, ANCHORS.composerProps[pi])) { matchesAll = false; break; }
      }
      if (matchesAll) {
        props = candidate;
        break;
      }
    }
    if (!props) fail("无法从当前输入框的已提交 composer 读取工作区上下文");
    return { props: props, committed: located.committed, composer: located.composer };
  }

  window.__peGetSessionContext = function (input) {
    if (attr(input, "data-testid") !== ANCHORS.inputId || !active(input)) {
      fail("请传入当前可用的 " + ANCHORS.inputId + " 输入框");
    }
    var composer = closestId(input, ANCHORS.composerId);
    if (!composer) fail("无法定位输入框所属的 " + ANCHORS.composerId);
    var configs = Array.prototype.filter.call(
      composer.querySelectorAll('[data-testid="' + ANCHORS.configId + '"]'),
      function (node) { return closestId(node, ANCHORS.composerId) === composer && active(node); }
    );
    if (configs.length !== 1) fail("当前输入栏模型配置缺失或不唯一，请等待模型选择完成");
    var config = configs[0];
    if (attr(config, ANCHORS.configAttrs.source) !== "composer") fail("当前输入栏模型配置尚未就绪");
    var providerId = requiredString(attr(config, ANCHORS.configAttrs.provider), "当前模型 providerId");
    var modelId = requiredString(attr(config, ANCHORS.configAttrs.model), "当前模型 modelId");
    var thought = attr(config, ANCHORS.configAttrs.thought);
    if (thought === null) fail("当前模型 reasoning level 字段缺失");

    var read = readCommittedProps(input);
    var props = read.props;
    var selection = props.draftConfig && props.draftConfig.modelSelection;
    if (!selection || selection.providerId !== providerId || selection.modelId !== modelId) {
      fail("输入栏模型与已提交会话配置尚未同步，请等待模型切换完成后重试");
    }
    var reasoning = selection.options && selection.options.reasoningLevel;
    if (reasoning != null && (typeof reasoning !== "string" || !reasoning.trim())) {
      fail("当前模型 reasoning level 配置无效");
    }
    if ((reasoning || "") !== thought) fail("输入栏 reasoning level 与会话配置尚未同步，请重试");

    var result = {
      selection: { providerId: providerId, modelId: modelId },
      workspacePath: requiredString(props.workspacePath, "workspacePath")
    };
    if (thought) result.selection.options = { reasoningLevel: thought };
    optionalString(props, "workspaceIdentity", result);
    optionalString(props, "remoteSessionId", result);
    if (props.sessionId !== null) result.sessionId = requiredString(props.sessionId, "sessionId");

    for (var pane = composer; pane; pane = pane.parentElement) {
      var sessionId = attr(pane, "data-session-id");
      if (sessionId !== null) {
        if (sessionId !== (props.sessionId === null ? "draft" : props.sessionId)) {
          fail("输入栏所属会话已变化，请等待会话切换完成后重试");
        }
        break;
      }
    }
    if (!active(input) || read.committed.root.current !== read.committed.current) {
      fail("读取期间输入栏会话已切换，请重试");
    }
    return result;
  };

  /* Find the service collection passed down by the app. The React context
   * provider owns `{ zcodeAgentService, ... }`; an adjacent provider component
   * holds the same object in its `services` prop. Both shapes are covered. */
  window.__peGetHostService = function (input) {
    if (attr(input, "data-testid") !== ANCHORS.inputId || !active(input)) {
      fail("请传入当前可用的 " + ANCHORS.inputId + " 输入框");
    }
    var located = composerIndexPath(input);
    var path = located.committed.path;
    for (var i = located.index; i >= 0; i--) {
      var props = path[i].memoizedProps;
      if (!props || typeof props !== "object") continue;
      var candidates = [];
      for (var si = 0; si < ANCHORS.serviceContainers.length; si++) candidates.push(props[ANCHORS.serviceContainers[si]]);
      for (var c = 0; c < candidates.length; c++) {
        var services = candidates[c];
        if (services && typeof services === "object" &&
            services.zcodeAgentService && typeof services.zcodeAgentService === "object") {
          return services;
        }
      }
      if (props[ANCHORS.serviceDirect] && typeof props[ANCHORS.serviceDirect] === "object") {
        return { zcodeAgentService: props[ANCHORS.serviceDirect] };
      }
    }
    fail("无法定位当前会话的服务连接，请重试或重启 ZCode");
  };
})();
