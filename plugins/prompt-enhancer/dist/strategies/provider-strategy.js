/**
 * Registry with resolution precedence:
 *  1. the explicitly configured provider id,
 *  2. auto-detection: first registered strategy that reports itself configured.
 */
export class ProviderStrategyRegistry {
    strategies = [];
    register(strategy) {
        this.strategies.push(strategy);
        return this;
    }
    list() {
        return this.strategies;
    }
    resolve(config) {
        const explicit = config.provider ? this.strategies.find((s) => s.id === config.provider) : undefined;
        if (explicit) {
            if (!explicit.isConfigured(config)) {
                throw new EnhancerSelectionError(`Provider "${config.provider}" is selected but not configured (missing API key or base URL).`);
            }
            return explicit;
        }
        const detected = this.strategies.find((s) => s.id !== 'mock' && s.isConfigured(config));
        if (detected)
            return detected;
        throw new EnhancerSelectionError('No enhancement provider is configured. Set an API key in plugin settings (Settings → Plugins → prompt-enhancer) or via environment variables (ZAI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).');
    }
}
/** Selection failure surfaced to the MCP layer with an actionable message. */
export class EnhancerSelectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EnhancerSelectionError';
    }
}
