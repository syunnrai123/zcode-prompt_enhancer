import { EnhancerError } from '../core/types.js';
import { ENHANCE_SYSTEM_PROMPT } from '../core/system-prompt.js';
import { errorResponse, INTERNAL_ERROR, METHOD_NOT_FOUND, response, startStdio, } from './stdio.js';
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'prompt-enhancer';
const SERVER_VERSION = '0.2.0';
export const TOOLS = [
    {
        name: 'enhance_prompt',
        description: 'Rewrite a draft prompt into a clear, CONCISE, unambiguous instruction (≤1.5x the original length, at most one file/symbol anchor), optionally using editor context (selected code, current file, related files, project type). Returns ONLY the enhanced prompt text, in the same language as the draft. Pure text transformation — never executes tools.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The raw draft prompt typed by the user.' },
                context: {
                    type: 'object',
                    description: 'Optional editor context for resolving vague references.',
                    properties: {
                        selectedCode: { type: 'string' },
                        cursorContext: { type: 'string' },
                        currentFile: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                language: { type: 'string' },
                                content: { type: 'string' },
                            },
                        },
                        relatedFiles: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { path: { type: 'string' }, language: { type: 'string' }, content: { type: 'string' } },
                            },
                        },
                        projectType: { type: 'string' },
                    },
                },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'get_enhancer_info',
        description: 'Diagnostics: resolved provider, model, timeouts and which providers have keys configured. API keys are never returned.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'get_enhancement_rules',
        description: 'Returns the canonical prompt-enhancement system prompt (rules, output format, boundary constraints) so the agent can perform agent-side enhancement with the exact same rule set when no provider API key is configured.',
        inputSchema: { type: 'object', properties: {} },
    },
];
export async function handleMessage(msg, deps) {
    // Notifications (no id) never get a response.
    if (msg.id === null || msg.id === undefined)
        return null;
    switch (msg.method) {
        case 'initialize':
            return response(msg.id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: deps.serverName ?? SERVER_NAME, version: deps.serverVersion ?? SERVER_VERSION },
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
async function handleToolCall(params, deps) {
    const { name, arguments: args } = (params ?? {});
    try {
        switch (name) {
            case 'enhance_prompt': {
                const request = parseEnhanceArgs(args);
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
            case 'get_enhancer_info':
                return { content: [{ type: 'text', text: JSON.stringify(deps.enhancer.describe(), null, 2) }] };
            case 'get_enhancement_rules':
                return { content: [{ type: 'text', text: ENHANCE_SYSTEM_PROMPT }] };
            default:
                return toolError(`Unknown tool: ${String(name)}`);
        }
    }
    catch (error) {
        return toolError(error instanceof EnhancerError ? `${error.code}: ${error.message}` : String(error));
    }
}
function parseEnhanceArgs(args) {
    const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
    const rawContext = args?.context;
    const context = typeof rawContext === 'object' && rawContext !== null
        ? sanitizeEditorContext(rawContext)
        : undefined;
    return { prompt, context };
}
function sanitizeEditorContext(raw) {
    const file = (value) => {
        if (typeof value !== 'object' || value === null)
            return undefined;
        const record = value;
        if (typeof record.path !== 'string')
            return undefined;
        return {
            path: record.path,
            language: typeof record.language === 'string' ? record.language : undefined,
            content: typeof record.content === 'string' ? record.content : undefined,
        };
    };
    return {
        selectedCode: optString(raw.selectedCode),
        cursorContext: optString(raw.cursorContext),
        currentFile: file(raw.currentFile),
        relatedFiles: Array.isArray(raw.relatedFiles)
            ? raw.relatedFiles.map(file).filter((f) => !!f)
            : undefined,
        projectType: optString(raw.projectType),
    };
}
function optString(value) {
    return typeof value === 'string' ? value : undefined;
}
function toolError(text) {
    return { content: [{ type: 'text', text }], isError: true };
}
/** Process entry wiring: stdio transport + dispatch, errors to stderr. */
export function runMcpServer(deps) {
    startStdio({
        onMessage: (msg) => {
            handleMessage(msg, deps)
                .then((reply) => {
                if (reply)
                    process.stdout.write(`${JSON.stringify(reply)}\n`);
            })
                .catch((error) => {
                const reply = errorResponse(msg.id ?? null, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
                process.stdout.write(`${JSON.stringify(reply)}\n`);
            });
        },
        onInvalidLine: (error) => {
            process.stderr.write(`[prompt-enhancer] ${error.message}\n`);
        },
    });
}
