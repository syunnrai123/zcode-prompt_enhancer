import type { PromptEnhancerService } from '../core/enhancer.js';
import type { JsonRpcRequest, JsonRpcResponse } from './stdio.js';
export interface McpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
}
export declare const TOOLS: readonly McpTool[];
export interface McpDeps {
    readonly enhancer: PromptEnhancerService;
    readonly serverName?: string;
    /** Plugin version; index.ts resolves it from package.json (single source). */
    readonly serverVersion?: string;
}
export declare function handleMessage(msg: JsonRpcRequest, deps: McpDeps): Promise<JsonRpcResponse | null>;
/** Process entry wiring: stdio transport + dispatch, errors to stderr. */
export declare function runMcpServer(deps: McpDeps): void;
