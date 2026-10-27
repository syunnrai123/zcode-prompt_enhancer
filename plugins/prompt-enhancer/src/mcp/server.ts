/**
 * MCP server: dispatch layer.
 *
 * `handleMessage` is a pure async function of (message, deps) so tests drive
 * it without spawning a process; `runMcpServer` only adds stdio plumbing.
 * Tool results use MCP content blocks; failures inside a tool set `isError`
 * rather than a protocol error, matching how ZCode surfaces tool failures.
 */
import type { EnhanceRequest } from '../core/types.js';
import { resolveProjectContext } from '../context/project-context.js';
import { EnhancerError } from '../core/types.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import type { PromptEnhancerService } from '../core/enhancer.js';
import {
  errorResponse,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  response,
  startStdio,
} from './stdio.js';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from './stdio.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'prompt-enhancer';
/**
 * Version reported in `initialize`. The composition root (index.ts) reads it
 * from package.json at runtime; this fallback only shows when a caller wires
 * runMcpServer by hand without passing the version (tests).
 */
const SERVER_VERSION_FALLBACK = '0.0.0';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TOOLS: readonly McpTool[] = [
  {
    name: 'enhance_prompt',
    description:
      'Rewrite a draft prompt into a clear, CONCISE, unambiguous instruction (≤1.5x the original length, at most one file/symbol anchor). Uses bounded project basics and recent Git changes from workspacePath when supplied, or explicit project metadata. Returns the enhanced prompt in the same language as the draft; never executes the task described in it.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The raw draft prompt typed by the user.' },
        workspacePath: {
          type: 'string',
          description: 'Explicit project root; the plugin reads manifests, bounded path indexes/module summaries, and Git metadata. Omit when the project is not accessible to this server.',
        },
        context: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional project metadata, never editor state or file bodies.',
          properties: {
            projectType: { type: 'string' },
            techStack: { type: 'array', items: { type: 'string' } },
            projectOverview: { type: 'string' },
            modules: { type: 'array', items: { type: 'string' } },
            relevantPaths: { type: 'array', items: { type: 'string' } },
            directoryStructure: { type: 'array', items: { type: 'string' } },
            gitChanges: {
              type: 'object',
              additionalProperties: false,
              properties: {
                branch: { type: 'string' },
                workingTree: { type: 'array', items: { type: 'string' } },
                recentCommits: { type: 'array', items: { type: 'string' } },
              },
            },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_project_context',
    description: 'Read-only bounded project overview: type, tech stack, module distribution, representative directories, draft/change-relevant paths and recent Git changes. Reads no source bodies or secret files; works without a provider API key.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Explicit project directory accessible to this server.' },
        prompt: { type: 'string', description: 'Optional draft used to prioritize matching modules and paths.' },
      },
      required: ['workspacePath'],
    },
  },
  {
    name: 'get_enhancer_info',
    description:
      'Diagnostics: resolved provider, model, timeouts and which providers have keys configured. API keys are never returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_enhancement_rules',
    description:
      'Returns the canonical prompt-enhancement system prompt (rules, output format, boundary constraints) so the agent can perform agent-side enhancement with the exact same rule set when no provider API key is configured.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface McpDeps {
  readonly enhancer: PromptEnhancerService;
  readonly serverName?: string;
  /** Plugin version; index.ts resolves it from package.json (single source). */
  readonly serverVersion?: string;
}

export async function handleMessage(msg: JsonRpcRequest, deps: McpDeps): Promise<JsonRpcResponse | null> {
  // Notifications (no id) never get a response.
  if (msg.id === null || msg.id === undefined) return null;

  switch (msg.method) {
    case 'initialize':
      return response(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: deps.serverName ?? SERVER_NAME,
          version: deps.serverVersion ?? SERVER_VERSION_FALLBACK,
        },
      });

    case 'ping':
      return response(msg.id, {});

    case 'tools/list':
      return response(msg.id, { tools: TOOLS });

    case 'tools/call':
      return response(msg.id, await handleToolCall(msg.params, deps));

    default:
      return errorResponse(msg.id, METHOD_NOT_FOUND, `Unknown method: ${msg.method}`);
  }
}

async function handleToolCall(params: unknown, deps: McpDeps): Promise<unknown> {
  const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  try {
    switch (name) {
      case 'enhance_prompt': {
        const request = await parseEnhanceArgs(args);
        const result = await deps.enhancer.enhance(request);
        return {
          content: [
            {
              type: 'text',
              text: result.enhancedPrompt,
            },
            {
              type: 'text',
              text: `\n[provider=${result.provider}${result.model ? ` model=${result.model}` : ''}]`,
            },
          ],
        };
      }
      case 'get_project_context': {
        const workspacePath = typeof args?.workspacePath === 'string' ? args.workspacePath.trim() : '';
        if (!workspacePath) return toolError('workspacePath is required; no directory was read.');
        const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
        const context = await resolveProjectContext(workspacePath, undefined, prompt);
        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
      }
      case 'get_enhancer_info':
        return { content: [{ type: 'text', text: JSON.stringify(deps.enhancer.describe(), null, 2) }] };
      case 'get_enhancement_rules':
        return { content: [{ type: 'text', text: ENHANCE_SYSTEM_PROMPT }] };
      default:
        return toolError(`Unknown tool: ${String(name)}`);
    }
  } catch (error) {
    return toolError(error instanceof EnhancerError ? `${error.code}: ${error.message}` : String(error));
  }
}

async function parseEnhanceArgs(args: Record<string, unknown> | undefined): Promise<EnhanceRequest> {
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const workspacePath = typeof args?.workspacePath === 'string' ? args.workspacePath : undefined;
  const context = prompt.trim() ? await resolveProjectContext(workspacePath, args?.context, prompt) : undefined;
  return { prompt, context };
}

function toolError(text: string): unknown {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Process entry wiring: stdio transport + dispatch, errors to stderr. */
export function runMcpServer(deps: McpDeps): void {
  startStdio({
    onMessage: (msg) => {
      handleMessage(msg, deps)
        .then((reply) => {
          if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
        })
        .catch((error: unknown) => {
          const reply = errorResponse(
            msg.id ?? null,
            INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
          );
          process.stdout.write(`${JSON.stringify(reply)}\n`);
        });
    },
    onInvalidLine: (error) => {
      process.stderr.write(`[prompt-enhancer] ${error.message}\n`);
    },
  });
}
