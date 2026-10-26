export class MockStrategy {
    id = 'mock';
    resolvedModel = 'mock-model';
    isConfigured(_config) {
        return true; // works with no credentials by design
    }
    async enhance(request, _config) {
        const lines = request.prompt
            .split('\n')
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
        const enhanced = [
            '[mock-enhanced]',
            ...lines.map((line, index) => `${index + 1}. ${line}`),
            '[Mock: rewrite concisely (≤1.5x), at most one file anchor, no boilerplate.]',
        ].join('\n');
        return { enhancedPrompt: enhanced, provider: this.id, model: this.resolvedModel };
    }
}
