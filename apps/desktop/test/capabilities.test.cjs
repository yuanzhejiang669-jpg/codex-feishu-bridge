const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectCapabilityHomes, listSkills, parseMcpServerIds, parseMcpServers } = require("../src/main/services/capabilities.cjs");

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

test("listSkills follows valid directory symlinks and reports their real source", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-capabilities-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "writing");
  const skills = path.join(root, "skills");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(source, "SKILL.md"), "# Writing\n", "utf8");
  const alias = path.join(skills, "writing");
  fs.symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");

  assert.deepEqual(listSkills(skills), [{
    name: "writing",
    path: alias,
    realPath: fs.realpathSync(alias),
    sourceType: "symlink",
    skillFile: path.join(alias, "SKILL.md"),
  }]);
});

test("listSkills ignores broken symlinks and non-directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-capabilities-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "file"), "not a skill", "utf8");
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "broken"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(listSkills(root), []);
});

test("inspectCapabilityHomes reports each shared Codex Home once", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-capability-homes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const result = inspectCapabilityHomes([first, second, first]);
  assert.deepEqual(result.map((item) => item.codexHome), [first, second]);
});
