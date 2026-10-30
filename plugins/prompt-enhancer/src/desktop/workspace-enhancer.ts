import { collectProjectContext } from '../context/project-context.js';
import { buildFullPrompt } from '../core/prompt-builder.js';
import { validateEnhancedOutput } from '../core/output-guard.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';

// Host budgets include reasoning tokens. A length stop escalates once to the larger
// budget, and only when the deadline can still fit a second attempt. The larger budget
// is not sent upfront because providers cap output length differently.
const FIRST_OUTPUT_BUDGET = 8192;
const ESCALATED_OUTPUT_BUDGET = 16384;
const REASONING_LEVELS = ['high', 'low', 'max', 'enabled', 'none'] as const;

interface WorkspaceSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface WorkspaceParams {
  draft: string;
  workspacePath: string;
  selection: WorkspaceSelection;
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

function reasoningUnsupported(error: unknown, selection: WorkspaceSelection, level: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { message?: unknown; name?: unknown; status?: unknown; data?: { message?: unknown } };
  if (record.name === 'AbortError') return false;
  const message = [record.message, record.data?.message].filter((value) => typeof value === 'string').join('\n');
  const status = typeof record.status === 'number' ? record.status :
    Number(/\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]);
  if (Number.isFinite(status) && status !== 400 && status !== 422) return false;
  const model = `${selection.providerId}/${selection.modelId}`;
  // The Host removes unsupported options before validation, so a rejected level
  // can surface as a missing-level error without making a provider request.
  if (message.split('\n').some((line) => line.endsWith(`Reasoning level is required for ${model}`) ||
      line.endsWith(`Reasoning effort "${level}" is not supported by ${model}`))) return true;
  return (status === 400 || status === 422) &&
    /reasoning[_ .-]*(?:effort|level)|\beffort\b/i.test(message) &&
    /unsupported|not supported|not allowed|invalid (?:value|enum)|must be (?:one of|in)|supported (?:values|levels)/i.test(message);
}

function finishReasonOf(result: WorkspaceResult): unknown {
  return result?.finishReason ?? result?.stopReason ?? result?.finish_reason;
}

function validatedResult(result: WorkspaceResult): WorkspaceResult {
  const reason = finishReasonOf(result);
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
  const { draft, signal, selection, ...routing } = params;
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('输入框为空');
  if (signal.aborted) throw abortError();
  if (!selection || typeof selection.providerId !== 'string' || !selection.providerId.trim() ||
      typeof selection.modelId !== 'string' || !selection.modelId.trim()) throw new Error('当前会话模型配置无效');
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
      messages: [
        { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
        { role: 'user', content: buildFullPrompt(draft, context) },
      ],
    };
    let reasoningIndex = 0;
    const send = async (maxOutputTokens: number): Promise<WorkspaceResult> => {
      for (;;) {
        if (controller.signal.aborted) throw abortError();
        const reasoningLevel = REASONING_LEVELS[reasoningIndex]!;
        const requestSelection = {
          ...selection,
          options: { ...selection.options, reasoningLevel },
        };
        try {
          return await Promise.race([service.generateWorkspaceText({
            ...args,
            selection: requestSelection,
            maxOutputTokens,
            requestTimeoutMs: Math.max(1, Math.floor(120_000 - (performance.now() - startedAt))),
          }), interrupted]);
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          if (!reasoningUnsupported(error, selection, reasoningLevel)) throw error;
          if (reasoningIndex === REASONING_LEVELS.length - 1) {
            throw new Error('当前模型不支持提示词增强使用的推理档位（high → low → max → enabled → none）');
          }
          reasoningIndex++;
        }
      }
    };
    const sendWithRetry = async (maxOutputTokens: number): Promise<WorkspaceResult> => {
      if (controller.signal.aborted) throw abortError();
      try {
        return await send(maxOutputTokens);
      } catch (error) {
        if (controller.signal.aborted || !transient(error)) throw error;
      }
      return send(maxOutputTokens);
    };
    const firstStartedAt = performance.now();
    const first = await sendWithRetry(FIRST_OUTPUT_BUDGET);
    if (controller.signal.aborted) throw abortError();
    // Reaching the cap took about `elapsed`; the larger budget needs about that times its ratio.
    const elapsed = performance.now() - firstStartedAt;
    const remaining = 120_000 - (performance.now() - startedAt);
    const escalate = String(finishReasonOf(first)) === 'length' &&
      remaining >= (ESCALATED_OUTPUT_BUDGET / FIRST_OUTPUT_BUDGET) * elapsed;
    if (!escalate) return validatedResult(first);
    let second: WorkspaceResult;
    try {
      second = await sendWithRetry(ESCALATED_OUTPUT_BUDGET);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // The larger attempt failed; report the truncation that triggered it.
      return validatedResult(first);
    }
    if (controller.signal.aborted) throw abortError();
    return validatedResult(second);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (aborted) controller.signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}
