import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AntigravityAcpClient } from '../src/antigravity/acp-client.mjs';

// Explicit opt-in integration test. Uses the current native official login.
const output = process.argv[2];
if (!output || !process.env.ANTIGRAVITY_CLI_BIN) throw new Error('Usage: ANTIGRAVITY_CLI_BIN=agy node scripts/smoke-antigravity.mjs <output-directory>');
const root = path.resolve(output); fs.mkdirSync(root, { recursive: true });
const model = process.env.ANTIGRAVITY_SMOKE_MODEL || 'gemini-3.8-flash-medium';
const geminiDir = path.join(root, 'native-smoke-home'); fs.mkdirSync(geminiDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), model, geminiDir, tools: [], permissions: [], results: [] };
const server = fileURLToPath(new URL('../src/claude/feishu-tools.mjs', import.meta.url));
const mcpServers = [{ name: 'feishu_bridge', command: process.execPath, args: [server], env: [{ name: 'CFB_FEISHU_TOOL_CONTEXT', value: JSON.stringify({ chatId: 'oc_native_smoke', profile: 'native-smoke', workspace: root }) }] }];
function client() {
  return new AntigravityAcpClient({ command: process.env.ANTIGRAVITY_CLI_BIN, cwd: root, geminiDir,
    logFile: path.join(root, 'native-integration.log'), idleTimeoutMs: 60_000,
    onEvent: ({ type, update }) => { if (type === 'tool_call') report.tools.push({ name: update.name, title: update.title, kind: update.kind }); },
    onPermission: async (request) => {
      const title = `${request.toolCall?.title || ''} ${request.toolCall?.name || ''}`;
      const allowed = /current_conversation/.test(title); report.permissions.push({ title, allowed }); return allowed;
    } });
}
let current;
try {
  current = client();
  const opened = await current.openSession({ model, mcpServers }); report.sessionId = opened.sessionId;
  const first = await current.prompt([{ type: 'text', text: 'Connection verification. Call the feishu_bridge current_conversation MCP tool exactly once. Do not use any other tool. If it returns chat_id oc_native_smoke, reply exactly ANTIGRAVITY_NATIVE_TOOLS_OK. Otherwise explain the failure.' }]);
  assert.equal(first.text.trim(), 'ANTIGRAVITY_NATIVE_TOOLS_OK');
  assert.ok(report.tools.some((tool) => /current_conversation/.test(`${tool.name} ${tool.title}`)), 'Native CLI did not report the MCP invocation');
  report.results.push({ test: 'native-mcp', passed: true, context: first.runtime.context });
  await current.close();
  current = client(); await current.openSession({ sessionId: opened.sessionId, model, mcpServers, effort: 'medium' });
  const second = await current.prompt([{ type: 'text', text: 'Do not use any tools. What was the chat_id returned by the current_conversation tool in the previous turn? Reply with only that exact ID.' }]);
  assert.equal(second.text.trim(), 'oc_native_smoke'); report.results.push({ test: 'native-resume', passed: true, context: second.runtime.context });
  await current.close();
  current = client(); await current.openSession({ sessionId: opened.sessionId, model, mcpServers });
  const pending = current.prompt([{ type: 'text', text: 'Do not use tools. Reply with STOP_TEST.' }]);
  current.interrupt(); await assert.rejects(pending, { code: 'USER_STOP' });
  report.results.push({ test: 'native-stop', passed: true }); report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.message || error); process.exitCode = 1; }
finally {
  await current?.close(); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'native-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
