import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import service from '../apps/desktop/src/main/services/antigravity.cjs';

const output = process.argv[2];
if (!output || !process.env.ANTIGRAVITY_CLI_BIN) throw new Error('Set ANTIGRAVITY_CLI_BIN and pass an output directory');
const root = path.resolve(output); fs.mkdirSync(root, { recursive: true });
const requests = []; const fakeKey = 'local-native-compatibility-test';
const server = http.createServer((request, response) => {
  request.resume();
  requests.push({ url: request.url, apiKeyMatched: request.headers['x-goog-api-key'] === fakeKey });
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ANTIGRAVITY_PROVIDER_OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const input = { id: 'local-native-test', mode: 'gemini-api', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: fakeKey };
const options = { dataRoot: path.join(root, 'api-native-smoke-home'), antigravityPath: process.env.ANTIGRAVITY_CLI_BIN,
  engineRoot: fileURLToPath(new URL('..', import.meta.url)), environment: process.env };
const report = { startedAt: new Date().toISOString() };
try {
  const listing = await service.listAntigravityModels(input, options);
  const selected = listing.models.find((item) => item.modelId.includes('gemini-3.8-flash'));
  assert.ok(selected, 'Native API directory lacks the expected Gemini model');
  const result = await service.probeAntigravityProvider({ ...input, model: selected.modelId }, options);
  assert.equal(result.verified, true); assert.ok(requests.length > 0); assert.ok(requests.every((item) => item.apiKeyMatched));
  Object.assign(report, { passed: true, model: selected.modelId, elapsedMs: result.elapsedMs, requests });
} catch (error) { Object.assign(report, { passed: false, error: error.message, requests }); process.exitCode = 1; }
finally {
  await new Promise((resolve) => server.close(resolve)); report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'native-api-integration.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
