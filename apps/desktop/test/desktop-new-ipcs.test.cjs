const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readBotLogs, redactLogText } = require("../src/main/services/bot-logs.cjs");
const { probeMcpHealth } = require("../src/main/services/mcp-health.cjs");
const { readDesktopSettings, setOwnerOpenId } = require("../src/main/services/desktop-settings.cjs");
const { updateManagedBotConfig } = require("../src/main/services/bot-config-editor.cjs");
const { retryFactoryBot, discardFactoryQueue } = require("../src/main/services/workspace-factory.cjs");

test("bot-logs: reads bounded tail, redacts all secret formats, rejects invalid streams & traversal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-bot-logs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const localAppData = path.join(root, "local");
  const botDir = path.join(dataRoot, "managed-bots", "bot-1");
  const logsDir = path.join(localAppData, "CodexFeishuBridge", "instances", "bot-1", "logs");
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(botDir, "bot.json"), JSON.stringify({
    name: "bot-1", label: "Bot 1", profile: "bot-1", engine: "codex", workspace: root,
  }));

  const stdoutFile = path.join(logsDir, "bridge.stdout.log");
  const lines = [
    "line-1 key=sk-secret1234567890",
    "line-2 fc=fc-firecrawl987654321",
    "line-3 tvly=tvly-tavilyabcdefghij",
    "line-4 Authorization: Bearer eyJhbGciOi.payload.sig",
    'line-5 {"app_secret":"very_secret_app_value"}',
    ...Array.from({ length: 25 }, (_, i) => `normal-line-${i + 6}`),
  ];
  fs.writeFileSync(stdoutFile, lines.join("\n") + "\n", "utf8");

  const res = readBotLogs({ name: "bot-1", stream: "stdout", lines: 20 }, { dataRoot, localAppData });
  assert.equal(res.exists, true);
  assert.equal(res.truncated, true);
  assert.equal(res.text.split("\n").length, 20);

  const full = readBotLogs({ name: "bot-1", stream: "stdout", lines: 200 }, { dataRoot, localAppData });
  assert.equal(full.text.includes("sk-secret1234567890"), false);
  assert.equal(full.text.includes("fc-firecrawl987654321"), false);
  assert.equal(full.text.includes("tvly-tavilyabcdefghij"), false);
  assert.equal(full.text.includes("eyJhbGciOi.payload.sig"), false);
  assert.equal(full.text.includes("very_secret_app_value"), false);
  assert.match(full.text, /\[REDACTED\]/);

  // Missing acp log returns exists: false cleanly
  const missing = readBotLogs({ name: "bot-1", stream: "acp" }, { dataRoot, localAppData });
  assert.equal(missing.exists, false);
  assert.equal(missing.text, "");

  // Invalid stream / traversal attempts rejected
  assert.throws(() => readBotLogs({ name: "bot-1", stream: "../secret.txt" }, { dataRoot, localAppData }), /不支持的日志流/);
  assert.throws(() => readBotLogs({ name: "unknown", stream: "stdout" }, { dataRoot, localAppData }), /找不到/);
  assert.equal(redactLogText("Bearer abcdef123456"), "Bearer [REDACTED]");
});

test("mcp-health: classifies disabled MCPs, probes loopback 18795 only (zero external requests), checks CloakBrowser and MinerU read-only", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-mcp-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const claudeTools = path.join(dataRoot, "claude-tools");
  const agyTools = path.join(dataRoot, "antigravity-tools");
  const mineruRoot = path.join(root, "tools", "mineru");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeTools, { recursive: true });
  fs.mkdirSync(agyTools, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "skills", "mineru-document-parser"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "skills", "mineru-document-parser", "SKILL.md"), "# mineru");
  fs.mkdirSync(path.join(mineruRoot, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(mineruRoot, ".venv", "Scripts", "python.exe"), "fake");
  fs.writeFileSync(path.join(mineruRoot, "cli.py"), "print('ok')");

  const fakeRouter = path.join(root, "tavily_server.py");
  fs.writeFileSync(fakeRouter, "x = 1\n");

  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.codex_browser_control]",
    `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
    "[mcp_servers.cloakbrowser]",
    `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
    "[mcp_servers.tavily]",
    `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
    `args = ["${fakeRouter.replace(/\\/g, "\\\\")}"]`,
    "[mcp_servers.external_https]",
    'url = "https://external.example.invalid/mcp"',
    "",
  ].join("\n"));

  fs.writeFileSync(path.join(claudeTools, ".mcp.json"), JSON.stringify({
    mcpServers: {
      disabled_tool: { command: "missing-cmd", disabled: true },
      cloakbrowser: { command: process.execPath, env: { PLAYWRIGHT_MCP_USER_DATA_DIR: "C:\\x\\cloakbrowser\\default" } },
    },
  }));

  const fetchedUrls = [];
  const report = await probeMcpHealth({
    userHome: root,
    codexHome,
    dataRoot,
    env: { ...process.env, MINERU_ROOT: mineruRoot },
    platform: "win32",
    skipPythonCompile: true,
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      if (url.startsWith("http://127.0.0.1:18795/")) return { ok: true, status: 200 };
      throw new Error("unexpected external fetch: " + url);
    },
  });

  // Only loopback 127.0.0.1:18795 fetched; zero external URLs contacted!
  assert.ok(fetchedUrls.every((u) => u.startsWith("http://127.0.0.1:18795/")));
  assert.equal(report.servers.find((s) => s.name === "disabled_tool").status, "disabled");
  assert.equal(report.servers.find((s) => s.name === "disabled_tool").active, false);
  assert.equal(report.servers.find((s) => s.name === "codex_browser_control").status, "ok");
  assert.equal(report.servers.find((s) => s.name === "cloakbrowser").status, "ok");
  assert.equal(report.servers.find((s) => s.name === "tavily").status, "ok");
  assert.equal(report.servers.find((s) => s.name === "external_https").status, "ok");
  assert.equal(report.documentToolchain.mineru.status, "ok");
  assert.equal(report.documentToolchain.mineru.skillFound, true);
});

test("setOwnerOpenId validates format, updates desktop-settings and shared owner.json, and queues bots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-owner-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => setOwnerOpenId({ ownerOpenId: "bad_id" }, { dataRoot: root }), /格式无效/);

  const queued = [];
  const bots = [
    { name: "codex-1", engine: "codex" },
    { name: "claude-1", engine: "claude" },
    { name: "agy-1", engine: "antigravity" },
  ];
  const res = setOwnerOpenId(
    { ownerOpenId: "ou_owner999" },
    {
      dataRoot: root,
      readManagedBots: () => bots,
      queueClaude: (_r, names, engine) => queued.push({ engine, names }),
      queueCodexBotReload: (_r, names) => queued.push({ engine: "codex", names }),
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.ownerOpenId, "ou_owner999");
  assert.equal(readDesktopSettings(root).ownerOpenId, "ou_owner999");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "claude-shared-sessions", "owner.json"), "utf8")).primaryOwnerOpenId, "ou_owner999");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "antigravity-shared-sessions", "owner.json"), "utf8")).primaryOwnerOpenId, "ou_owner999");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "codex-shared-sessions", "owner.json"), "utf8")).primaryOwnerOpenId, "ou_owner999");
  assert.deepEqual(res.queuedBots, { codex: ["codex-1"], claude: ["claude-1"], antigravity: ["agy-1"] });

  // Union ID (on_...) writes schemaVersion 2 primaryOwnerUnionId across all 3 engines
  const resUnion = setOwnerOpenId(
    { ownerOpenId: "on_unionCrossBot888" },
    {
      dataRoot: root,
      readManagedBots: () => bots,
      queueClaude: (_r, names, engine) => queued.push({ engine, names }),
      queueCodexBotReload: (_r, names) => queued.push({ engine: "codex", names }),
    },
  );
  assert.equal(resUnion.ok, true);
  assert.equal(resUnion.ownerOpenId, "on_unionCrossBot888");
  for (const dir of ["claude-shared-sessions", "antigravity-shared-sessions", "codex-shared-sessions"]) {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, dir, "owner.json"), "utf8"));
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.primaryOwnerUnionId, "on_unionCrossBot888");
  }
});

test("preload/index.cjs and main/index.cjs expose all 6 V2 §5.4 IPC channels cleanly", () => {
  const preloadSrc = fs.readFileSync(path.join(__dirname, "..", "src", "preload", "index.cjs"), "utf8");
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "index.cjs"), "utf8");
  const required = [
    ["updateBotConfig", "desktop:update-bot-config"],
    ["readBotLogs", "desktop:read-bot-logs"],
    ["retryWorkspaceFactoryBot", "desktop:retry-workspace-factory-bot"],
    ["discardWorkspaceFactoryQueue", "desktop:discard-workspace-factory-queue"],
    ["probeMcpHealth", "desktop:probe-mcp-health"],
    ["setOwnerOpenId", "desktop:set-owner-open-id"],
  ];
  for (const [method, channel] of required) {
    assert.ok(preloadSrc.includes(`${method}:`), `preload missing ${method}`);
    assert.ok(preloadSrc.includes(channel), `preload missing ${channel}`);
    assert.ok(mainSrc.includes(`"${channel}"`), `main missing ${channel}`);
  }
  assert.match(preloadSrc, /getState:\s*\(options\)\s*=>\s*ipcRenderer\.invoke\("desktop:get-state",\s*options\s*\|\|\s*\{\}\)/);
  assert.equal(typeof updateManagedBotConfig, "function");
  assert.equal(typeof retryFactoryBot, "function");
  assert.equal(typeof discardFactoryQueue, "function");
});
