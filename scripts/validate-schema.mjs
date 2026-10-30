/**
 * Optional schema validation against the REAL @deepseek-ai/dsh-tools package.
 *
 * The unit tests stub defineTool, so they never prove the parameter/output
 * schemas compile under the shipped implementation. This script does: it loads
 * the real package (when installed) and lets defineTool compile every
 * definition, then checks that malformed arguments are rejected and a real
 * result validates against its declared output schema.
 *
 *   npm i --no-save @deepseek-ai/dsh-tools
 *   node scripts/validate-schema.mjs
 *
 * Exits 0 and prints "skipped" when the peer dependency is not installed.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { makeWorkspace } from '../test/fixtures.mjs';

let tools;
try {
  tools = await import('@deepseek-ai/dsh-tools');
} catch {
  console.log('skipped: @deepseek-ai/dsh-tools is not installed (npm i --no-save @deepseek-ai/dsh-tools)');
  process.exit(0);
}

// Point the plugin's bare import at the installed copy, wherever it resolved from.
const entry = new URL(import.meta.resolve('@deepseek-ai/dsh-tools')).href;
register(
  `data:text/javascript,export async function resolve(s, c, n) {
     return s === '@deepseek-ai/dsh-tools' ? { url: ${JSON.stringify(entry)}, shortCircuit: true } : n(s, c);
   }`,
  import.meta.url,
);

const plugin = await import('../lib/index.js');

const ws = makeWorkspace();
const defs = new Map();
plugin.apply({
  tools: { register: (d) => { defs.set(d.name, d); return () => defs.delete(d.name); } },
  workingDirectory: { ensure: async () => ws.root },
}, {});

const sampleFor = (name) => (name === 'git_workspace_commit'
  ? { messages: { app: 'test: one' }, dryRun: true }
  : { maxDepth: 2, dryRun: true });

let failures = 0;
for (const [toolName, def] of defs) {
  try {
    const sample = sampleFor(toolName);
    const violations = tools.validateJsonSchemaValue(def.parameters, sample, '');
    if (violations.length) throw new Error(`sample args rejected: ${violations.join('; ')}`);

    let rejected = false;
    try {
      await def.execute({ maxDepth: 'three' }, { agent: {}, signal: new AbortController().signal });
    } catch (error) {
      rejected = error.name === 'ToolArgsError';
    }
    if (!rejected) throw new Error('malformed args were not rejected');

    const value = await def.execute(sample, { agent: {}, signal: new AbortController().signal });
    const outViolations = tools.validateJsonSchemaValue(def.output.schema, value, '');
    if (outViolations.length) throw new Error(`output rejected: ${outViolations.join('; ')}`);

    const blocks = def.output.render(sample, value);
    if (!Array.isArray(blocks) || blocks[0]?.type !== 'text' || typeof blocks[0]?.text !== 'string') {
      throw new Error('render did not return ContentBlock[]');
    }
    console.log(`ok  ${toolName}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${toolName}: ${error.message}`);
  }
}

ws.dispose();
console.log(failures === 0 ? `\nall ${defs.size} tool definitions valid` : `\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
