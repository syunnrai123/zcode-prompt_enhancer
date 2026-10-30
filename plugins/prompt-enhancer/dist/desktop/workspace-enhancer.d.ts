interface WorkspaceSelection {
    providerId: string;
    modelId: string;
    options?: {
        reasoningLevel?: string;
        [key: string]: unknown;
    };
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
export declare function enhanceWorkspaceText(service: WorkspaceTextService, params: WorkspaceParams): Promise<WorkspaceResult>;
export {};
