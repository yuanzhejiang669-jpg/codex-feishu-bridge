const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMcpServerIds, parseMcpServers } = require("../src/main/services/capabilities.cjs");

test("parseMcpServerIds lists server headers without reading secret values", () => {
  const text = `
[model]
name = "example"

[mcp_servers.browser]
command = "node"

[mcp_servers."desktop-control"]
env = { TOKEN = "secret" }

[mcp_servers.browser.tools.status]
description = "nested tool metadata"
`;
  assert.deepEqual(parseMcpServerIds(text), ["browser", "desktop-control"]);
  const servers = parseMcpServers(text, "C:\\Users\\test\\.codex\\config.toml");
  assert.equal(servers.length, 2);
  assert.equal(servers[0].configSection, "[mcp_servers.browser]");
  assert.deepEqual(servers[1].envKeys, ["TOKEN"]);
  assert.equal(JSON.stringify(servers).includes("secret"), false);
});
