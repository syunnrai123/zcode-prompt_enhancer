/**
 * Domain types shared across the plugin.
 * Kept free of infrastructure concerns (no fetch / MCP / Node specifics) so the
 * core enhancement pipeline is unit-testable in isolation.
 */
/** Structured error carrying a stable machine-readable code. */
export class EnhancerError extends Error {
    code;
    cause;
    constructor(code, message, cause) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.name = 'EnhancerError';
    }
}
