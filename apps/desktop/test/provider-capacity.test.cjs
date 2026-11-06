const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const TOML = require("smol-toml");
const { discoverProviderCapacity, normalizeCatalog, inspectProviderCapacity, setProviderCatalogUrl } = require("../src/main/services/provider-capacity.cjs");
const { addGlobalProvider, refreshProviderCapacity, refreshProviderCapacities } = require("../src/main/services/provider-manager.cjs");
const { createManagedBot } = require("../src/main/services/bot-setup.cjs");

function model(window = 320000, percent = 88) {
  return {
    slug: "example-model", display_name: "Example", supported_reasoning_levels: [],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
    support_verbosity: false, experimental_supported_tools: [], base_instructions: "Help with coding.",
    truncation_policy: { mode: "tokens", limit: 10000 },
    context_window: window, effective_context_window_percent: percent,
  };
}
const response = (body) => new Response(JSON.stringify(body), { status: 200 });
const provider = { baseUrl: "https://capacity.example/v1", apiKey: "private-test-key", wireApi: "responses" };

function fixture(t, extra = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfb-capacity-"));
  const codexHome = path.join(root, "home");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(configPath, [
    '# Preserve comments and the selected route',
    'model_provider = "openai"', 'model = "example-model"', extra,
    '[model_providers."company.api"]', 'name = "Company"',
    'base_url = "https://capacity.example/v1"', 'wire_api = "responses"', 'env_key = "CAPACITY_KEY"',
    '[model_providers."company.api".http_headers]', 'x-client = "desktop"',
    '[mcp_servers.keep]', 'command = "keep.exe"', '',
  ].join("\r\n"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, codexHome, dataRoot, configPath,
    clientVersion: "0.166.0", env: { CAPACITY_KEY: "private-test-key" },
    readUserEnvironmentVariable: async () => "",
    fetchImpl: async () => response({ models: [model()] }),
  };
}

test("requests versioned native metadata and follows changed capacity without changing the URL", async () => {
  let current = model();
  const options = {
    clientVersion: "0.166.0-beta.1",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://capacity.example/v1/models?client_version=0.166.0");
      assert.equal(init.headers.authorization, "Bearer private-test-key");
      assert.equal(init.redirect, "error");
      return response({ models: [current] });
    },
  };
  const first = await discoverProviderCapacity(provider, options);
  assert.equal(first.status, "remote");
  assert.equal(first.models[0].usableWindow, 281600);
  current = model(640000, 92);
  const second = await discoverProviderCapacity(provider, options);
  assert.equal(second.models[0].usableWindow, 588800);
  assert.equal(first.url, second.url);
  assert.equal(JSON.stringify(second).includes(provider.apiKey), false);
});

test("supports versioned message catalogs and Codex's optional percent default", () => {
  const value = model(123456);
  delete value.effective_context_window_percent;
  delete value.base_instructions;
  value.model_messages = [{ role: "developer", content: "Help with coding." }];
  const entry = normalizeCatalog({ models: [value] })[0];
  assert.equal(entry.usableWindow, 117283);
  assert.equal(entry.percentSource, "codex-default");
});

test("does not infer capacity from an ordinary model list or an incomplete native entry", async () => {
  for (const body of [{ data: [{ id: "example-model", context_window: 999999 }] }, { models: [{ slug: "example-model", context_window: 999999 }] }]) {
    const result = await discoverProviderCapacity(provider, { clientVersion: "0.166.0", fetchImpl: async () => response(body) });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.models, []);
  }
  assert.throws(() => normalizeCatalog({ models: [model(), model()] }), /重复/);
  assert.throws(() => normalizeCatalog({ models: [model(500, 101)] }), /比例/);
});

test("keeps an undeclared window unknown instead of substituting a fixed capacity", () => {
  const value = model(null, 90);
  assert.equal(normalizeCatalog({ models: [value] })[0].usableWindow, null);
});

test("passes configured query parameters and headers with the provider identity", async () => {
  await discoverProviderCapacity({ ...provider, modelCatalogUrl: "https://capacity.example/codex/catalog", queryParams: { region: "west" }, httpHeaders: { "x-client": "desktop" }, envHttpHeaders: { "x-route": "ROUTE" } }, {
    clientVersion: "0.166.0", env: { ROUTE: "private-route" },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).searchParams.get("region"), "west");
      assert.equal(init.headers["x-client"], "desktop");
      assert.equal(init.headers["x-route"], "private-route");
      return response({ models: [model()] });
    },
  });
});

test("refuses redirects without sending credentials to the redirect target", async (t) => {
  let redirectedRequests = 0;
  const target = http.createServer((_req, res) => { redirectedRequests++; res.end("{}"); });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/stolen` }); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); target.closeAllConnections(); target.close(); });
  const result = await discoverProviderCapacity({ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, { clientVersion: "0.166.0" });
  assert.equal(result.status, "unavailable");
  assert.equal(redirectedRequests, 0);
  assert.equal(JSON.stringify(result).includes(provider.apiKey), false);
});

test("bounds response bodies and the complete body-read timeout", async (t) => {
  const tooLarge = await discoverProviderCapacity(provider, {
    clientVersion: "0.166.0", fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
  });
  assert.match(tooLarge.reason, /1 MiB/);
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write('{"models":['); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await discoverProviderCapacity({ ...provider, baseUrl: `http://127.0.0.1:${server.address().port}` }, { clientVersion: "0.166.0", catalogTimeoutMs: 100 });
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /超时/);
});

test("repairs only the named Provider table while preserving selection and all other TOML", async (t) => {
  const options = fixture(t);
  const original = fs.readFileSync(options.configPath, "utf8");
  const result = await refreshProviderCapacity({ id: "company.api" }, options);
  assert.equal(result.changed, true);
  const next = fs.readFileSync(options.configPath, "utf8");
  assert.equal(next.replace('model_catalog_url = "https://capacity.example/v1/models"\r\n', ""), original);
  const parsed = TOML.parse(next);
  assert.equal(parsed.model_provider, "openai");
  assert.equal(parsed.model_context_window, undefined);
  assert.equal(result.capacity.models[0].usableWindow, 281600);
  const repeated = await refreshProviderCapacity({ id: "company.api" }, { ...options, fetchImpl: async () => response({ models: [model(640000, 92)] }) });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.capacity.models[0].usableWindow, 588800);
});

test("manual nonstandard catalog addresses are tested and saved per Provider", async (t) => {
  const options = fixture(t);
  const url = "https://capacity.example/company/codex-models";
  const result = await refreshProviderCapacity({ id: "company.api", modelCatalogUrl: url }, options);
  assert.equal(result.capacity.configuredUrl, url);
  assert.equal(result.changed, true);
  assert.throws(() => setProviderCatalogUrl('[model_providers.other]\nname="x"\n', "company.api", url), /未找到/);
});

test("does not write a catalog URL when metadata is unavailable or the key is missing", async (t) => {
  const options = fixture(t);
  const original = fs.readFileSync(options.configPath, "utf8");
  const result = await refreshProviderCapacity({ id: "company.api" }, { ...options, fetchImpl: async () => response({ data: [{ id: "example-model" }] }) });
  assert.equal(result.changed, false);
  assert.equal(result.capacity.status, "unavailable");
  assert.equal(fs.readFileSync(options.configPath, "utf8"), original);
  const missing = await refreshProviderCapacity({ id: "company.api" }, { ...options, env: {} });
  assert.equal(missing.changed, false);
  assert.equal(missing.capacity.status, "unsupported");
});

test("retains configured directories after transient failures instead of claiming a bundled capacity", async (t) => {
  const options = fixture(t);
  await refreshProviderCapacity({ id: "company.api" }, options);
  const previous = fs.readFileSync(options.configPath, "utf8");
  const failed = await refreshProviderCapacity({ id: "company.api" }, { ...options, fetchImpl: async () => { throw new Error("request included private-test-key"); } });
  assert.equal(failed.capacity.configuredUrl, "https://capacity.example/v1/models");
  assert.equal(failed.changed, false);
  assert.equal(JSON.stringify(failed).includes("private-test-key"), false);
  assert.equal(fs.readFileSync(options.configPath, "utf8"), previous);
});

test("honors local catalogs, explicit disabled discovery and manual context overrides", async (t) => {
  for (const [setting, status] of [['model_catalog_json = "local-models.json"', "local"], ['features.api_key_model_discovery = false', "disabled"]]) {
    const options = fixture(t, setting);
    let fetched = false;
    const result = await refreshProviderCapacity({ id: "company.api" }, { ...options, fetchImpl: async () => { fetched = true; return response({ models: [model()] }); } });
    assert.equal(result.capacity.status, status);
    assert.equal(fetched, false);
  }
  const options = fixture(t, 'model_context_window = 123456');
  const result = await refreshProviderCapacity({ id: "company.api" }, options);
  assert.equal(result.capacity.status, "manual");
  assert.equal(result.capacity.configuredWindow, 123456);
});

test("does not overwrite a Provider that changes while its catalog is fetched", async (t) => {
  const options = fixture(t);
  await assert.rejects(() => refreshProviderCapacity({ id: "company.api" }, {
    ...options,
    fetchImpl: async () => {
      fs.appendFileSync(options.configPath, '\n[model_providers."company.api".query_params]\nregion="changed"\n');
      return response({ models: [model()] });
    },
  }), /配置发生变化/);
  assert.equal(fs.readFileSync(options.configPath, "utf8").includes("model_catalog_url"), false);
});

test("new Providers store the detected endpoint rather than a fixed token window", async (t) => {
  const options = fixture(t);
  const result = await addGlobalProvider({ id: "new-provider", baseUrl: provider.baseUrl, envKey: "NEW_CAPACITY_KEY", apiKey: provider.apiKey, wireApi: "responses" }, {
    ...options, setUserEnvironmentVariable: async () => {},
  });
  const config = TOML.parse(fs.readFileSync(options.configPath, "utf8"));
  assert.equal(config.model_providers["new-provider"].model_catalog_url, `${provider.baseUrl}/models`);
  assert.equal(config.model_context_window, undefined);
  assert.equal(result.capacity.models[0].usableWindow, 281600);
  assert.equal(JSON.stringify(config).includes(provider.apiKey), false);
});

test("startup repair includes isolated managed Homes and does not change their selected Providers", async (t) => {
  const options = fixture(t);
  const isolated = path.join(options.root, "isolated");
  const botRoot = path.join(options.dataRoot, "managed-bots", "assistant");
  fs.mkdirSync(botRoot, { recursive: true }); fs.mkdirSync(isolated);
  fs.copyFileSync(options.configPath, path.join(isolated, "config.toml"));
  fs.writeFileSync(path.join(botRoot, "bot.json"), JSON.stringify({ name: "assistant", codexHomeMode: "isolated", codexHome: isolated }));
  const result = await refreshProviderCapacities(options);
  assert.equal(result.changedCount, 2);
  for (const home of [options.codexHome, isolated]) {
    const config = TOML.parse(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
    assert.equal(config.model_provider, "openai");
    assert.equal(config.model_providers["company.api"].model_catalog_url, `${provider.baseUrl}/models`);
  }
});

test("custom Bot creation also detects and preserves its native catalog configuration", async (t) => {
  const options = fixture(t);
  const created = await createManagedBot({
    name: "capacity-bot", codexHomeMode: "isolated",
    provider: { mode: "custom", id: "custom-capacity", ...provider, model: "example-model" },
  }, { appId: "cli_capacity123", appSecret: "lark-private-test-key" }, {
    ...options,
    workspaceRoot: path.join(options.root, "workspaces"), codexHomeRoot: path.join(options.root, "codex-homes"),
    defaultCodexHome: options.codexHome, existingNames: [], larkCliPath: "lark-cli.exe",
    encryptSecret: (value) => Buffer.from(`encrypted:${value.length}`),
    runLarkCli: async (_tool, args) => ({ stdout: args.includes("list") ? "[]" : "", stderr: "" }),
  });
  const text = fs.readFileSync(path.join(created.codexHome, "config.toml"), "utf8");
  const config = TOML.parse(text);
  assert.equal(config.model_providers["custom-capacity"].model_catalog_url, `${provider.baseUrl}/models`);
  assert.equal(config.model_context_window, undefined);
  assert.equal(text.includes(provider.apiKey), false);
});
