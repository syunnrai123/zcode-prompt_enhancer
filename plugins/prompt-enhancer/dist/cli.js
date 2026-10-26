/**
 * CLI entry — stdin/stdout marker protocol for out-of-process hosts:
 *
 *   echo '{"prompt":"...", "context":{...}}' | node dist/cli.js
 *
 *   [CONTENT_DELTA] <json-string>  — progressive chunk (one per SSE delta)
 *   [ENHANCED]<text>               — final success (newlines as {{NEWLINE}})
 *   [ENHANCED_ERROR]<msg>          — final failure
 *
 * The desktop input-box integration drives this protocol, streaming results
 * back into its preview panel as the provider responds.
 */
import { buildContainer, Tokens } from './index.js';
async function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}
function emitContentDelta(text) {
    if (!text)
        return;
    process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}
/** Stream the enhanced text in ~80-char chunks to emulate progressive output. */
function streamResult(text) {
    const chunkSize = 80;
    for (let i = 0; i < text.length; i += chunkSize) {
        emitContentDelta(text.slice(i, i + chunkSize));
    }
}
async function main() {
    try {
        const raw = await readStdin();
        const input = (raw.trim() ? JSON.parse(raw) : {});
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        if (!prompt.trim()) {
            process.stdout.write('[ENHANCED]\n');
            process.exit(0);
        }
        const container = buildContainer();
        const enhancer = container.resolve(Tokens.Enhancer);
        const result = await enhancer.enhance({
            prompt,
            context: (typeof input.context === 'object' && input.context !== null
                ? input.context
                : undefined),
        });
        streamResult(result.enhancedPrompt);
        process.stdout.write(`[ENHANCED]${result.enhancedPrompt.replace(/\n/g, '{{NEWLINE}}')}\n`);
        process.exit(0);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[prompt-enhancer] Error: ${message}\n`);
        process.stdout.write(`[ENHANCED_ERROR]${message.replace(/\n/g, ' ')}\n`);
        process.exit(1);
    }
}
main();
