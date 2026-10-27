/** Bounded, complete NUL records; filtered paths still count against the input limit. */
export declare class PathIndexReader {
    private readonly acceptPath;
    readonly paths: string[];
    partial: boolean;
    stopped: boolean;
    private readonly decoder;
    private bytes;
    private records;
    private pending;
    private oversized;
    constructor(acceptPath: (value: string) => boolean);
    accept(chunk: Uint8Array): void;
    finish(): void;
}
