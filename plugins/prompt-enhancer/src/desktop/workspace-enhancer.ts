import { collectProjectContext } from '../context/project-context.js';
import { buildFullPrompt } from '../core/prompt-builder.js';
import { validateEnhancedOutput } from '../core/output-guard.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';

interface WorkspaceParams {
  draft: string;
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  signal: AbortSignal;
  [key: string]: unknown;
}

interface WorkspaceResult {
  text?: unknown;
  finishReason?: unknown;
  stopReason?: unknown;
  finish_reason?: unknown;
  toolCalls?: unknown;
  truncated?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface WorkspaceTextService {
  generateWorkspaceText(params: Record<string, unknown>): Promise<WorkspaceResult>;
}

function abortError(): Error {
  const error = new Error('提示词增强已取消');
  error.name = 'AbortError';
  return error;
}

function transient(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { message?: unknown; code?: unknown; name?: unknown; status?: unknown };
  if (record.name === 'AbortError') return false;
  const status = typeof record.status === 'number' ? record.status :
    Number(/\bHTTP\s+(\d{3})\b/i.exec(String(record.message))?.[1]);
  if (Number.isFinite(status)) return status === 408 || status === 429 || (status >= 500 && status <= 599);
  return /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|UND_ERR_SOCKET/i.test(String(record.code)) ||
    /fetch failed|network|socket hang up|connection (?:reset|closed)|transport.*closed|网络|连接.*(?:断开|重置)/i.test(String(record.message));
}

function validatedResult(result: WorkspaceResult): WorkspaceResult {
  const reason = result?.finishReason ?? result?.stopReason ?? result?.finish_reason;
  if (result?.error || result?.truncated ||
      (result?.toolCalls != null && (!Array.isArray(result.toolCalls) || result.toolCalls.length > 0)) ||
      (reason != null && !['stop', 'end_turn', 'stop_sequence', 'completed'].includes(String(reason)))) {
    throw new Error('模型结果未正常完成，请重新生成；未应用不完整的输出');
  }
  if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('当前会话模型返回了空结果');
  const guarded = validateEnhancedOutput(result.text);
  return { ...result, text: guarded.text };
}

export async function enhanceWorkspaceText(service: WorkspaceTextService, params: WorkspaceParams): Promise<WorkspaceResult> {
  const startedAt = performance.now();
  const { draft, signal, ...routing } = params;
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('输入框为空');
  if (signal.aborted) throw abortError();
  // The Host can route remote requests while running locally; never read a
  // similarly named local directory for an unverified remote workspace.
  const remote = !!params.remoteSessionId || (!!params.workspaceIdentity && !/^local:/i.test(params.workspaceIdentity));
  const context = remote
    ? { notes: ['Remote project context unavailable; no local filesystem was read.'] }
    : await collectProjectContext(params.workspacePath, { signal, prompt: draft });
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, 120_000 - (performance.now() - startedAt)));
  let aborted: (() => void) | undefined;
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(abortError());
      controller.signal.addEventListener('abort', aborted, { once: true });
    });
    const args = {
      ...routing,
      querySource: 'prompt_enhancer',
      signal: controller.signal,
      // Host output budgets include reasoning tokens, even for very short drafts.
      maxOutputTokens: 8192,
      messages: [
        { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
        { role: 'user', content: buildFullPrompt(draft, context) },
      ],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (controller.signal.aborted) throw abortError();
      let result: WorkspaceResult;
      try {
        result = await Promise.race([service.generateWorkspaceText({
          ...args,
          requestTimeoutMs: Math.max(1, Math.floor(120_000 - (performance.now() - startedAt))),
        }), interrupted]);
      } catch (error) {
        if (controller.signal.aborted || attempt > 0 || !transient(error)) throw error;
        continue;
      }
      if (controller.signal.aborted) throw abortError();
      return validatedResult(result);
    }
    throw new Error('提示词增强失败');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (aborted) controller.signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}
