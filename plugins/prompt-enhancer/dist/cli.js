/**
 * CLI entry — stdin/stdout marker protocol for out-of-process hosts:
 *
 *   echo '{"prompt":"...", "context":{...}}' | node dist/cli.js
 *
 *   [CONTENT_DELTA] <json-string>  — chunks of the validated final result
 *   [ENHANCED]<text>               — final success (newlines as {{NEWLINE}})
 *   [ENHANCED_ERROR]<msg>          — final failure
 *
 * Optional workspacePath collects bounded project/Git metadata. Unvalidated
 * provider chunks are never emitted; desktop generation uses the Host instead.
 */
import { buildContainer, Tokens } from './index.js';
import { resolveProjectContext } from './context/project-context.js';
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
/**
 * Exit only after stdout has flushed. Writing a marker to a pipe and calling
 * process.exit() immediately can drop the final line on Windows, which would
 * leave the desktop bridge waiting forever.
 */
function flushExit(code) {
    let exited = false;
    const finish = () => {
        if (exited)
            return;
        exited = true;
        process.exit(code);
    };
    const fallback = setTimeout(finish, 400);
    try {
        process.stdout.write('', () => {
            clearTimeout(fallback);
            finish();
        });
    }
    catch {
        clearTimeout(fallback);
        finish();
    }
}
async function main() {
    try {
        const raw = await readStdin();
        const input = (raw.trim() ? JSON.parse(raw) : {});
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        if (!prompt.trim()) {
            process.stdout.write('[ENHANCED]\n');
            flushExit(0);
            return;
        }
        const container = buildContainer();
        const enhancer = container.resolve(Tokens.Enhancer);
        const workspacePath = typeof input.workspacePath === 'string' ? input.workspacePath : undefined;
        const result = await enhancer.enhance({
            prompt,
            context: await resolveProjectContext(workspacePath, input.context, prompt),
        });
        streamResult(result.enhancedPrompt);
        process.stdout.write(`[ENHANCED]${result.enhancedPrompt.replace(/\n/g, '{{NEWLINE}}')}\n`);
        flushExit(0);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[prompt-enhancer] Error: ${message}\n`);
        process.stdout.write(`[ENHANCED_ERROR]${message.replace(/\n/g, ' ')}\n`);
        flushExit(1);
    }
}
main();
