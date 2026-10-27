import { PATH_INDEX_LIMITS } from './project-summary.js';
/** Bounded, complete NUL records; filtered paths still count against the input limit. */
export class PathIndexReader {
    acceptPath;
    paths = [];
    partial = false;
    stopped = false;
    decoder = new TextDecoder('utf-8', { fatal: true });
    bytes = 0;
    records = 0;
    pending = '';
    oversized = false;
    constructor(acceptPath) {
        this.acceptPath = acceptPath;
    }
    accept(chunk) {
        if (this.stopped)
            return;
        const remaining = PATH_INDEX_LIMITS.bytes - this.bytes;
        const prefix = chunk.subarray(0, remaining);
        this.bytes += prefix.byteLength;
        let text;
        try {
            text = this.decoder.decode(prefix, { stream: true });
        }
        catch {
            this.partial = this.stopped = true;
            return;
        }
        let start = 0;
        while (start < text.length && !this.stopped) {
            const end = text.indexOf('\0', start);
            const fragment = text.slice(start, end < 0 ? text.length : end);
            if (!this.oversized) {
                if (this.pending.length + fragment.length > PATH_INDEX_LIMITS.pathChars) {
                    this.pending = '';
                    this.oversized = this.partial = true;
                }
                else
                    this.pending += fragment;
            }
            if (end < 0)
                break;
            this.records++;
            if (!this.oversized && this.acceptPath(this.pending))
                this.paths.push(this.pending);
            this.pending = '';
            this.oversized = false;
            if (this.records >= PATH_INDEX_LIMITS.paths)
                this.partial = this.stopped = true;
            start = end + 1;
        }
        if (chunk.byteLength > remaining)
            this.partial = this.stopped = true;
    }
    finish() {
        try {
            this.decoder.decode();
        }
        catch {
            this.partial = true;
        }
        if (this.pending || this.oversized)
            this.partial = true;
    }
}
