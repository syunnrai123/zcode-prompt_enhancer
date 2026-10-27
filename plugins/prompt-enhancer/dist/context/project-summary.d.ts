/** Metadata-only selection: broad module coverage plus draft/change relevance. */
export declare const PATH_INDEX_LIMITS: {
    readonly paths: 50000;
    readonly bytes: number;
    readonly pathChars: 1024;
};
export declare function moduleOf(file: string): string;
/** Build the scoring function once per collection; calling it is cheap. */
export declare function createRelevanceMatcher(prompt: string): (file: string) => number;
export declare function relevanceScore(file: string, prompt: string): number;
export declare function selectPaths(paths: readonly string[], prompt: string, changes?: readonly string[], recent?: readonly string[]): string[];
export declare function summarizePaths(paths: readonly string[], prompt: string, changes: readonly string[], recent: readonly string[], partial: boolean, source: string): {
    projectOverview: string;
    modules: string[];
    directoryStructure: string[];
    relevantPaths: string[];
    techStack: string[];
};
