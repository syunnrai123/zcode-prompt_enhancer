/**
 * Composition root.
 *
 * The only file that knows how the pieces fit together: builds the DI
 * container, wires strategies into the registry, and starts the MCP stdio
 * server. Every module above is constructor-injected and framework-free.
 */
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config/config.js';
import { Container, createToken } from './di/container.js';
import { PromptEnhancerService } from './core/enhancer.js';
import type { EnhancerEvent } from './core/enhancer.js';
import type { EnhancerConfig } from './core/types.js';
import { ProviderStrategyRegistry } from './strategies/provider-strategy.js';
import { OpenAiCompatibleStrategy } from './strategies/openai-compatible.js';
import { AnthropicStrategy } from './strategies/anthropic.js';
import { MockStrategy } from './strategies/mock.js';
import { runMcpServer } from './mcp/server.js';

// ---- DI tokens (swap any of these in tests via container.register) ----
export const Tokens = {
  Config: createToken<EnhancerConfig>('EnhancerConfig'),
  StrategyRegistry: createToken<ProviderStrategyRegistry>('ProviderStrategyRegistry'),
  Enhancer: createToken<PromptEnhancerService>('PromptEnhancerService'),
};

function logEvent(event: EnhancerEvent): void {
  // Diagnostics go to stderr; stdout is the MCP protocol channel.
  const line = `[prompt-enhancer] ${JSON.stringify(event)}`;
  process.stderr.write(`${line}\n`);
}

export function buildContainer(env: NodeJS.ProcessEnv = process.env): Container {
  const container = new Container();

  container.register(Tokens.Config, () => resolveConfig(env));

  container.register(
    Tokens.StrategyRegistry,
    () =>
      new ProviderStrategyRegistry()
        .register(new OpenAiCompatibleStrategy({ id: 'glm' }))
        .register(new OpenAiCompatibleStrategy({ id: 'openai-compatible' }))
        .register(new AnthropicStrategy())
        .register(new MockStrategy()),
  );

  container.register(
    Tokens.Enhancer,
    (c) => new PromptEnhancerService(c.resolve(Tokens.StrategyRegistry), c.resolve(Tokens.Config), logEvent),
  );

  return container;
}

function main(): void {
  const container = buildContainer();
  const enhancer = container.resolve(Tokens.Enhancer);
  process.stderr.write('[prompt-enhancer] MCP stdio server starting\n');
  runMcpServer({ enhancer });
}

// Only auto-start when executed as the MCP entry (`node dist/index.js`);
// test and CLI imports must not spin up the stdio transport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
