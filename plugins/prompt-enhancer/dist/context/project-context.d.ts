import type { ProjectContext } from '../core/types.js';
/** Parse and rank changes with a precomputed matcher — never rebuild it inside the comparator. */
export declare function rankedStatusChanges(raw: string, prefix: string, matcher: (file: string) => number): Array<{
    file: string;
    status: string;
    previous?: string;
}>;
export interface CommitSummary {
    readonly title: string;
    readonly files: string[];
}
/** Commit records are strictly "\x1e<hash> <subject>"; other records are file names. */
export declare function parseLog(raw: string, matcher: (file: string) => number): {
    commits: CommitSummary[];
    recentPaths: string[];
};
export declare function collectProjectContext(workspacePath: string, { signal, prompt }?: {
    signal?: AbortSignal;
    prompt?: string;
}): Promise<ProjectContext>;
export declare function resolveProjectContext(workspacePath: string | undefined, supplied: unknown, prompt?: string): Promise<ProjectContext | undefined>;
