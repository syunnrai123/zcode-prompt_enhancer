/**
 * Composition root.
 *
 * The only file that knows how the pieces fit together: builds the DI
 * container, wires strategies into the registry, and starts the MCP stdio
 * server. Every module above is constructor-injected and framework-free.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config/config.js';
import { Container, createToken } from './di/container.js';
import { PromptEnhancerService } from './core/enhancer.js';
import { ProviderStrategyRegistry } from './strategies/provider-strategy.js';
import { OpenAiCompatibleStrategy } from './strategies/openai-compatible.js';
import { AnthropicStrategy } from './strategies/anthropic.js';
import { MockStrategy } from './strategies/mock.js';
import { runMcpServer } from './mcp/server.js';
// ---- DI tokens (swap any of these in tests via container.register) ----
export const Tokens = {
    Config: createToken('EnhancerConfig'),
    StrategyRegistry: createToken('ProviderStrategyRegistry'),
    Enhancer: createToken('PromptEnhancerService'),
};
function logEvent(event) {
    // Diagnostics go to stderr; stdout is the MCP protocol channel.
    const line = `[prompt-enhancer] ${JSON.stringify(event)}`;
    process.stderr.write(`${line}\n`);
}
export function buildContainer(env = process.env) {
    const container = new Container();
    container.register(Tokens.Config, () => resolveConfig(env));
    container.register(Tokens.StrategyRegistry, () => new ProviderStrategyRegistry()
        .register(new OpenAiCompatibleStrategy({ id: 'glm' }))
        .register(new OpenAiCompatibleStrategy({ id: 'openai-compatible' }))
        .register(new AnthropicStrategy())
        .register(new MockStrategy()));
    container.register(Tokens.Enhancer, (c) => new PromptEnhancerService(c.resolve(Tokens.StrategyRegistry), c.resolve(Tokens.Config), logEvent));
    return container;
}
/**
 * Plugin version, read from package.json at runtime so the reported version
 * can never drift from the manifest. dist/index.js sits one level below the
 * plugin root; dist-test/src/index.js (test builds) sits two — probe both and
 * match on the package name to avoid picking up an unrelated ancestor.
 */
function pluginVersion() {
    for (const rel of ['../package.json', '../../package.json']) {
        try {
            const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
            if (pkg.name === 'zcode-plugin-prompt-enhancer' && typeof pkg.version === 'string') {
                return pkg.version;
            }
        }
        catch {
            /* try the next candidate */
        }
    }
    return '0.0.0-unknown';
}
function main() {
    const container = buildContainer();
    const enhancer = container.resolve(Tokens.Enhancer);
    process.stderr.write('[prompt-enhancer] MCP stdio server starting\n');
    runMcpServer({ enhancer, serverVersion: pluginVersion() });
}
// Only auto-start when executed as the MCP entry (`node dist/index.js`);
// test and CLI imports must not spin up the stdio transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
