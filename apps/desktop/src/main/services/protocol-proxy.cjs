const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 18788;
const DEFAULT_INNER_PORT = 19788;
const PORT_RANGE = 100;
const REGISTRY_SCHEMA_VERSION = 2;
const PROXY_VERSION = "0.5.28";
const BUILTIN_PROVIDER_KEYS = [
  "MIMO_API_KEY",
  "DS_API_KEY",
  "DEEPSEEK_API_KEY",
  "GENERIC_API_KEY",
  "QWEN_API_KEY",
  "KIMI_API_KEY",
  "GLM_API_KEY",
  "OPENAI_API_KEY",
];

function atomicWriteJson(destination, value) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
}

function registryPath(dataRoot) {
  return path.join(dataRoot, "protocol-proxy", "registry.json");
}

function normalizeModels(models, defaultModel = "") {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(models) ? models : []) {
    const id = String(typeof raw === "string" ? raw : raw?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      ownedBy: String(raw?.ownedBy || raw?.owned_by || "").trim(),
    });
  }
  const fallback = String(defaultModel || "").trim();
  if (!result.length && fallback) result.push({ id: fallback, ownedBy: "" });
  return result;
}

function readRegistry(dataRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(dataRoot), "utf8"));
    const legacyPort = Number(parsed.port) || DEFAULT_PORT;
    const providers = (Array.isArray(parsed.providers) ? parsed.providers : []).map((provider, index) => ({
      id: String(provider.id || "").trim(),
      name: String(provider.name || provider.id || "").trim(),
      upstreamBaseUrl: String(provider.upstreamBaseUrl || "").trim().replace(/\/+$/, ""),
      envKey: String(provider.envKey || "").trim(),
      defaultModel: String(provider.defaultModel || "").trim(),
      wireApi: "chat",
      port: Number(provider.port) || legacyPort + index,
      models: normalizeModels(provider.models, provider.defaultModel),
    })).filter((provider) => provider.id);
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: REGISTRY_SCHEMA_VERSION, providers: [] };
    throw new Error(`Unable to read the managed Chat Provider registry: ${error.message}`);
  }
}

function defaultModelCapabilities() {
  return { supportsReasoning: true, supportsVision: false };
}

function providersFileValue(registry, resolveModelCapabilities = defaultModelCapabilities) {
  return {
    providers: (registry.providers || []).map((provider) => ({
      id: provider.id,
      shortcut: provider.id,
      displayName: provider.name,
      baseUrl: provider.upstreamBaseUrl,
      envKey: provider.envKey,
      defaultModel: provider.defaultModel,
      wireApi: "chat",
      models: normalizeModels(provider.models, provider.defaultModel).map((model) => {
        const capabilities = resolveModelCapabilities({ provider: provider.id, model: model.id });
        return {
          id: model.id,
          supportsReasoning: capabilities.supportsReasoning !== false,
          supportsImages: capabilities.supportsImages === true || capabilities.supportsVision === true,
        };
      }),
      features: { forceParallelToolCalls: true },
    })),
  };
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try { process.kill(processId, 0); return true; } catch { return false; }
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function firstAvailablePort(host, start, used = new Set()) {
  for (let candidate = start; candidate < start + PORT_RANGE; candidate += 1) {
    if (!used.has(candidate) && await canListen(host, candidate)) return candidate;
  }
  throw new Error(`No local port is available in ${start}-${start + PORT_RANGE - 1}`);
}

async function waitForHealth(baseUrl, fetchImpl = fetch, timeoutMs = 20_000, cancelled = () => false) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (cancelled()) return false;
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`The protocol proxy was not ready within 20 seconds${lastError ? `: ${lastError}` : ""}`);
}

function parseUpstreamModels(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  return normalizeModels((Array.isArray(parsed?.data) ? parsed.data : []).map((item) => ({
    id: String(typeof item === "string" ? item : item?.id || item?.model || item?.name || "").trim(),
    ownedBy: String(item?.owned_by || item?.ownedBy || "").trim(),
  })));
}

function sameModels(left, right) {
  return JSON.stringify(normalizeModels(left).map((item) => item.id).sort())
    === JSON.stringify(normalizeModels(right).map((item) => item.id).sort());
}

function createProtocolProxyService(options) {
  const host = "127.0.0.1";
  const externalPortStart = Number(options.defaultPort) || DEFAULT_PORT;
  const innerPortStart = Number(options.defaultInnerPort) || DEFAULT_INNER_PORT;
  const runtimes = new Map();
  let shouldRun = false;
  let lifecycleGeneration = 0;
  let status = "stopped";
  let lastError = "";
  let restartAttempts = 0;

  function providerPaths(providerId) {
    const root = path.join(options.dataRoot, "protocol-proxy", "providers", providerId);
    return {
      root,
      providers: path.join(root, "providers.json"),
      stdout: path.join(root, "proxy.stdout.log"),
      stderr: path.join(root, "proxy.stderr.log"),
    };
  }

  function snapshot() {
    const registry = readRegistry(options.dataRoot);
    const details = registry.providers.map((provider) => {
      const runtime = runtimes.get(provider.id);
      return {
        id: provider.id,
        port: provider.port,
        baseUrl: `http://${host}:${provider.port}/v1`,
        modelCount: provider.models.length,
        processId: runtime?.inner && isProcessAlive(runtime.inner.child.pid) ? runtime.inner.child.pid : null,
        status: runtime?.status || "stopped",
        error: runtime?.error || "",
      };
    });
    const online = details.filter((item) => item.status === "online").length;
    return {
      supported: fs.existsSync(options.proxyCliPath) && fs.existsSync(options.nodePath),
      status: !details.length ? "unused" : online === details.length ? "online" : lastError ? "failed" : status,
      version: PROXY_VERSION,
      host,
      port: details[0]?.port || externalPortStart,
      baseUrl: details[0]?.baseUrl || `http://${host}:${externalPortStart}/v1`,
      providerCount: details.length,
      processId: details[0]?.processId || null,
      providers: details,
      error: lastError,
      restartAttempts,
      registryPath: registryPath(options.dataRoot),
      providersPath: path.join(options.dataRoot, "protocol-proxy", "providers"),
      logDir: path.join(options.dataRoot, "protocol-proxy", "providers"),
    };
  }

  async function readSecret(provider) {
    const secret = await options.readUserEnvironmentVariable(provider.envKey);
    if (!secret) throw new Error(`Chat Provider credential is unavailable: ${provider.envKey}`);
    return secret;
  }

  async function fetchUpstreamModels(provider) {
    const secret = await readSecret(provider);
    const response = await (options.fetchImpl || fetch)(`${provider.upstreamBaseUrl}/models`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(Number(options.timeoutMs || 30_000)),
    });
    const body = await response.text();
    const models = response.ok ? parseUpstreamModels(body) : [];
    return { status: response.status, ok: response.ok, body, models };
  }

  function updateRegistryProvider(providerId, patch) {
    const registry = readRegistry(options.dataRoot);
    const index = registry.providers.findIndex((provider) => provider.id === providerId);
    if (index < 0) return null;
    registry.providers[index] = { ...registry.providers[index], ...patch };
    atomicWriteJson(registryPath(options.dataRoot), registry);
    return registry.providers[index];
  }

  async function stopChild(inner) {
    if (!inner?.child) return;
    if (isProcessAlive(inner.child.pid)) {
      inner.child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { inner.child.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
        timer.unref?.();
        inner.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (inner.dataDir) {
      const ownedRoot = path.resolve(options.dataRoot, "protocol-proxy", "providers");
      const resolved = path.resolve(inner.dataDir);
      if (resolved.startsWith(`${ownedRoot}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  function retireInner(inner) {
    if (!inner) return;
    const retire = () => {
      if (inner.activeRequests > 0) {
        const timer = setTimeout(retire, 250);
        timer.unref?.();
        return;
      }
      void stopChild(inner);
    };
    retire();
  }

  async function spawnInner(provider, models, generation) {
    const used = new Set([...runtimes.values()].map((runtime) => runtime.inner?.port).filter(Boolean));
    const innerPort = await firstAvailablePort(host, innerPortStart, used);
    const runtimePaths = providerPaths(provider.id);
    const value = providersFileValue({ providers: [{ ...provider, models }] }, options.resolveModelCapabilities);
    atomicWriteJson(runtimePaths.providers, value);
    fs.mkdirSync(runtimePaths.root, { recursive: true });
    const environment = { ...process.env };
    for (const name of BUILTIN_PROVIDER_KEYS) {
      if (name !== provider.envKey) delete environment[name];
    }
    environment.MIMO2CODEX_PROVIDERS_FILE = runtimePaths.providers;
    environment.MIMO2CODEX_NO_UPDATE_CHECK = "1";
    environment[provider.envKey] = await readSecret(provider);
    const stdout = fs.openSync(runtimePaths.stdout, "a");
    const stderr = fs.openSync(runtimePaths.stderr, "a");
    const dataDir = path.join(runtimePaths.root, `runtime-${crypto.randomUUID()}`);
    const child = spawn(options.nodePath, [
      options.proxyCliPath,
      "--no-load-env",
      "--no-update-check",
      "--no-admin",
      "--auth", "off",
      "--data-dir", dataDir,
      "--model", provider.id,
      "--host", host,
      "--port", String(innerPort),
    ], {
      cwd: runtimePaths.root,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    const inner = { child, port: innerPort, activeRequests: 0, models: normalizeModels(models), dataDir };
    try {
      const ready = await waitForHealth(
        `http://${host}:${innerPort}`,
        options.fetchImpl,
        20_000,
        () => !shouldRun || generation !== lifecycleGeneration,
      );
      if (!ready || !shouldRun || generation !== lifecycleGeneration) {
        await stopChild(inner);
        return null;
      }
      return inner;
    } catch (error) {
      await stopChild(inner);
      throw error;
    }
  }

  function attachInnerExit(providerId, inner) {
    inner.child.once("exit", (code) => {
      const runtime = runtimes.get(providerId);
      if (!runtime || runtime.inner !== inner) return;
      runtime.inner = null;
      runtime.status = "failed";
      runtime.error = `Protocol converter exited (code ${code ?? "unknown"})`;
      lastError = runtime.error;
      if (shouldRun && !runtime.restartTimer) {
        restartAttempts += 1;
        const delay = Math.min(60_000, 2000 * (2 ** Math.min(restartAttempts - 1, 5)));
        runtime.restartTimer = setTimeout(() => {
          runtime.restartTimer = null;
          void restartProvider(providerId).catch(() => {});
        }, delay);
        runtime.restartTimer.unref?.();
      }
    });
  }

  async function refreshModels(providerId, models) {
    const runtime = runtimes.get(providerId);
    if (!runtime || sameModels(runtime.inner?.models, models)) return;
    const registry = readRegistry(options.dataRoot);
    const current = registry.providers.find((provider) => provider.id === providerId);
    if (!current) return;
    const provider = { ...current, models: normalizeModels(models) };
    const next = await spawnInner(provider, provider.models, lifecycleGeneration);
    if (!next) return;
    attachInnerExit(providerId, next);
    updateRegistryProvider(providerId, { models: provider.models });
    const previous = runtime.inner;
    runtime.provider = provider;
    runtime.inner = next;
    runtime.status = "online";
    runtime.error = "";
    retireInner(previous);
  }

  function sendJson(res, statusCode, value) {
    const body = `${JSON.stringify(value)}\n`;
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  async function forwardToInner(providerId, req, res) {
    const runtime = runtimes.get(providerId);
    const inner = runtime?.inner;
    if (!inner || !isProcessAlive(inner.child.pid)) {
      sendJson(res, 503, { error: { message: `Provider ${providerId} converter is not ready`, type: "proxy_unavailable" } });
      return;
    }
    inner.activeRequests += 1;
    const headers = { ...req.headers, host: `${host}:${inner.port}` };
    const outgoing = http.request({ host, port: inner.port, method: req.method, path: req.url, headers }, (incoming) => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.pipe(res);
      incoming.once("end", () => { inner.activeRequests = Math.max(0, inner.activeRequests - 1); });
      incoming.once("error", () => { inner.activeRequests = Math.max(0, inner.activeRequests - 1); });
    });
    outgoing.once("error", (error) => {
      inner.activeRequests = Math.max(0, inner.activeRequests - 1);
      if (!res.headersSent) sendJson(res, 502, { error: { message: error.message, type: "proxy_error" } });
      else res.destroy(error);
    });
    req.pipe(outgoing);
  }

  async function handleGateway(providerId, req, res) {
    const runtime = runtimes.get(providerId);
    const url = new URL(req.url || "/", `http://${host}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      sendJson(res, 200, { ok: true, provider: providerId, converterReady: Boolean(runtime?.inner) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      try {
        const result = await fetchUpstreamModels(runtime.provider);
        if (result.ok && result.models.length) await refreshModels(providerId, result.models);
        res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(result.body) });
        res.end(result.body);
      } catch (error) {
        sendJson(res, 502, { error: { message: error.message, type: "model_discovery_failed" } });
      }
      return;
    }
    await forwardToInner(providerId, req, res);
  }

  async function startProvider(provider, generation) {
    if (!await canListen(host, provider.port)) throw new Error(`Local Provider port ${provider.port} is already in use`);
    let models = normalizeModels(provider.models, provider.defaultModel);
    try {
      const discovery = await fetchUpstreamModels(provider);
      if (discovery.ok && discovery.models.length) {
        models = discovery.models;
        provider = updateRegistryProvider(provider.id, { models }) || provider;
      }
    } catch {}
    const inner = await spawnInner(provider, models, generation);
    if (!inner) return null;
    const runtime = { provider, inner, gateway: null, status: "starting", error: "", restartTimer: null };
    runtimes.set(provider.id, runtime);
    attachInnerExit(provider.id, inner);
    const gateway = http.createServer((req, res) => { void handleGateway(provider.id, req, res); });
    runtime.gateway = gateway;
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(provider.port, host, resolve);
    });
    runtime.status = "online";
    return runtime;
  }

  async function stopRuntime(runtime) {
    if (!runtime) return;
    if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
    if (runtime.gateway?.listening) {
      await new Promise((resolve) => runtime.gateway.close(resolve));
    }
    await stopChild(runtime.inner);
    runtime.status = "stopped";
  }

  async function stop() {
    lifecycleGeneration += 1;
    shouldRun = false;
    const current = [...runtimes.values()];
    runtimes.clear();
    await Promise.all(current.map((runtime) => stopRuntime(runtime)));
    status = "stopped";
  }

  async function start() {
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    const registry = readRegistry(options.dataRoot);
    if (!registry.providers.length) {
      await stop();
      lastError = "";
      status = "unused";
      return snapshot();
    }
    shouldRun = true;
    if (runtimes.size) return snapshot();
    if (!fs.existsSync(options.proxyCliPath) || !fs.existsSync(options.nodePath)) {
      lastError = "The bundled protocol conversion runtime is incomplete";
      status = "failed";
      throw new Error(lastError);
    }
    status = "starting";
    lastError = "";
    try {
      atomicWriteJson(registryPath(options.dataRoot), registry);
      for (const provider of registry.providers) {
        if (!shouldRun || generation !== lifecycleGeneration) break;
        await startProvider(provider, generation);
      }
      if (shouldRun && generation === lifecycleGeneration) {
        status = "online";
        restartAttempts = 0;
      }
      return snapshot();
    } catch (error) {
      lastError = error.message;
      status = "failed";
      await stop();
      status = "failed";
      throw error;
    }
  }

  async function restart() {
    await stop();
    return start();
  }

  async function restartProvider(providerId) {
    const id = String(providerId || "").trim();
    const provider = readRegistry(options.dataRoot).providers.find((item) => item.id === id);
    if (!provider) return snapshot();
    const previous = runtimes.get(id);
    if (previous) {
      runtimes.delete(id);
      await stopRuntime(previous);
    }
    if (shouldRun) await startProvider(provider, lifecycleGeneration);
    return snapshot();
  }

  async function prepareProvider(provider, model, discoveredModels = []) {
    const previous = readRegistry(options.dataRoot);
    if (previous.providers.some((item) => item.id === provider.id)) throw new Error(`Managed Chat Provider already exists: ${provider.id}`);
    const models = normalizeModels(discoveredModels);
    const defaultModel = String(model || "").trim() || models[0]?.id || "";
    if (!defaultModel) throw new Error("Chat Completions Provider must select a default model");
    if (models.length && !models.some((item) => item.id === defaultModel)) {
      throw new Error(`Default model is not present in the Provider model list: ${defaultModel}`);
    }
    const used = new Set(previous.providers.map((item) => item.port));
    const selectedPort = await firstAvailablePort(host, externalPortStart, used);
    const managed = {
      id: provider.id,
      name: provider.name,
      upstreamBaseUrl: provider.baseUrl,
      envKey: provider.envKey,
      defaultModel,
      wireApi: "chat",
      port: selectedPort,
      models: models.length ? models : [{ id: defaultModel, ownedBy: "" }],
    };
    const next = { ...previous, providers: [...previous.providers, managed] };
    return {
      codexProvider: {
        ...provider,
        baseUrl: `http://${host}:${selectedPort}/v1`,
        wireApi: "responses",
      },
      async commit() {
        atomicWriteJson(registryPath(options.dataRoot), next);
        try { await restart(); }
        catch (error) {
          atomicWriteJson(registryPath(options.dataRoot), previous);
          await restart().catch(() => {});
          throw error;
        }
      },
      async rollback() {
        atomicWriteJson(registryPath(options.dataRoot), previous);
        await restart().catch(() => {});
      },
    };
  }

  function prepareProviderRemoval(id) {
    const providerId = String(id || "").trim();
    const previous = readRegistry(options.dataRoot);
    if (!previous.providers.some((provider) => provider.id === providerId)) return null;
    const next = { ...previous, providers: previous.providers.filter((provider) => provider.id !== providerId) };
    return {
      async commit() {
        atomicWriteJson(registryPath(options.dataRoot), next);
        try { await restart(); }
        catch (error) {
          atomicWriteJson(registryPath(options.dataRoot), previous);
          await restart().catch(() => {});
          throw error;
        }
      },
      async rollback() {
        atomicWriteJson(registryPath(options.dataRoot), previous);
        await restart();
      },
    };
  }

  function decorateCatalog(catalog) {
    const registry = readRegistry(options.dataRoot);
    const managed = new Map(registry.providers.map((provider) => [provider.id, provider]));
    return {
      ...catalog,
      providers: (catalog.providers || []).map((provider) => {
        const proxy = managed.get(provider.id);
        return proxy ? {
          ...provider,
          baseUrl: proxy.upstreamBaseUrl,
          localBaseUrl: `http://${host}:${proxy.port}/v1`,
          wireApi: "chat -> responses",
          managedProxy: true,
          defaultModel: proxy.defaultModel,
          modelCount: proxy.models.length,
        } : provider;
      }),
    };
  }

  return {
    decorateCatalog,
    prepareProvider,
    prepareProviderRemoval,
    restart,
    restartProvider,
    snapshot,
    start,
    stop,
  };
}

module.exports = {
  DEFAULT_PORT,
  PROXY_VERSION,
  createProtocolProxyService,
  normalizeModels,
  parseUpstreamModels,
  providersFileValue,
  readRegistry,
};
