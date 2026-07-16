const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 18788;
const REGISTRY_SCHEMA_VERSION = 1;
const PROXY_VERSION = "0.5.28";

function atomicWriteJson(destination, value) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
}

function registryPath(dataRoot) {
  return path.join(dataRoot, "protocol-proxy", "registry.json");
}

function readRegistry(dataRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(dataRoot), "utf8"));
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      port: Number(parsed.port) || DEFAULT_PORT,
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: REGISTRY_SCHEMA_VERSION, port: DEFAULT_PORT, providers: [] };
    throw new Error(`无法读取托管协议代理配置：${error.message}`);
  }
}

function providersFileValue(registry) {
  return {
    providers: registry.providers.map((provider) => ({
      id: provider.id,
      shortcut: provider.id,
      displayName: provider.name,
      baseUrl: provider.upstreamBaseUrl,
      envKey: provider.envKey,
      defaultModel: provider.defaultModel,
      wireApi: "chat",
      models: [{ id: provider.defaultModel, supportsReasoning: true }],
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
  throw new Error(`托管协议代理未能在 20 秒内就绪${lastError ? `：${lastError}` : ""}`);
}

function createProtocolProxyService(options) {
  const host = "127.0.0.1";
  let child = null;
  let lastError = "";
  let status = "stopped";
  let shouldRun = false;
  let restartTimer = null;
  let restartAttempts = 0;
  let lifecycleGeneration = 0;

  function paths() {
    const root = path.join(options.dataRoot, "protocol-proxy");
    return {
      root,
      providers: path.join(root, "providers.json"),
      stdout: path.join(root, "proxy.stdout.log"),
      stderr: path.join(root, "proxy.stderr.log"),
      cli: options.proxyCliPath,
    };
  }

  function snapshot() {
    const registry = readRegistry(options.dataRoot);
    const running = Boolean(child && isProcessAlive(child.pid));
    return {
      supported: fs.existsSync(options.proxyCliPath) && fs.existsSync(options.nodePath),
      status: running ? "online" : registry.providers.length ? (lastError ? "failed" : status) : "unused",
      version: PROXY_VERSION,
      host,
      port: registry.port,
      baseUrl: `http://${host}:${registry.port}/v1`,
      providerCount: registry.providers.length,
      processId: running ? child.pid : null,
      error: lastError,
      restartAttempts,
      registryPath: registryPath(options.dataRoot),
      providersPath: paths().providers,
      logDir: paths().root,
    };
  }

  async function stop() {
    lifecycleGeneration += 1;
    shouldRun = false;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const running = child;
    child = null;
    if (!running || !isProcessAlive(running.pid)) {
      status = "stopped";
      return;
    }
    running.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { running.kill("SIGKILL"); } catch {}
        resolve();
      }, 5000);
      timer.unref?.();
      running.once("exit", () => { clearTimeout(timer); resolve(); });
    });
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
    if (child && isProcessAlive(child.pid)) return snapshot();
    if (!fs.existsSync(options.proxyCliPath) || !fs.existsSync(options.nodePath)) {
      lastError = "客户端托管协议代理运行时不完整，请重新安装客户端";
      status = "failed";
      throw new Error(lastError);
    }
    if (!await canListen(host, registry.port)) {
      lastError = `本地端口 ${registry.port} 已被其他程序占用`;
      status = "failed";
      throw new Error(lastError);
    }

    const value = providersFileValue(registry);
    const runtimePaths = paths();
    atomicWriteJson(runtimePaths.providers, value);
    const environment = {
      ...process.env,
      MIMO2CODEX_PROVIDERS_FILE: runtimePaths.providers,
      MIMO2CODEX_NO_UPDATE_CHECK: "1",
    };
    const readSecret = options.readUserEnvironmentVariable;
    for (const provider of registry.providers) {
      const secret = await readSecret(provider.envKey);
      if (!secret) throw new Error(`Chat Provider 环境变量不可用：${provider.envKey}`);
      environment[provider.envKey] = secret;
    }
    if (!shouldRun || generation !== lifecycleGeneration) return snapshot();
    fs.mkdirSync(runtimePaths.root, { recursive: true });
    const stdout = fs.openSync(runtimePaths.stdout, "a");
    const stderr = fs.openSync(runtimePaths.stderr, "a");
    status = "starting";
    lastError = "";
    const launched = spawn(options.nodePath, [
      options.proxyCliPath,
      "--no-load-env",
      "--no-update-check",
      "--no-admin",
      "--auth", "off",
      "--data-dir", runtimePaths.root,
      "--model", registry.providers[0].id,
      "--host", host,
      "--port", String(registry.port),
    ], {
      cwd: runtimePaths.root,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    child = launched;
    launched.once("exit", (code) => {
      if (child !== launched) return;
      child = null;
      if (status !== "stopped") {
        status = "failed";
        lastError = `托管协议代理已退出（code ${code ?? "unknown"}）`;
      }
      if (shouldRun && !restartTimer) {
        restartAttempts += 1;
        const delay = Math.min(60_000, 2000 * (2 ** Math.min(restartAttempts - 1, 5)));
        restartTimer = setTimeout(() => {
          restartTimer = null;
          void start().catch(() => {});
        }, delay);
        restartTimer.unref?.();
      }
    });
    try {
      const ready = await waitForHealth(
        `http://${host}:${registry.port}`,
        options.fetchImpl,
        20_000,
        () => !shouldRun || generation !== lifecycleGeneration,
      );
      if (!ready || !shouldRun || generation !== lifecycleGeneration) return snapshot();
      status = "online";
      restartAttempts = 0;
      return snapshot();
    } catch (error) {
      if (!shouldRun || generation !== lifecycleGeneration) return snapshot();
      lastError = error.message;
      status = "failed";
      await stop();
      status = "failed";
      throw error;
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
  }

  async function restart() {
    await stop();
    return start();
  }

  async function prepareProvider(provider, model) {
    const defaultModel = String(model || "").trim();
    if (!defaultModel) throw new Error("Chat Completions Provider 必须填写测试模型");
    const previous = readRegistry(options.dataRoot);
    if (previous.providers.some((item) => item.id === provider.id)) throw new Error(`托管 Chat Provider 已存在：${provider.id}`);
    const modelOwner = previous.providers.find((item) => item.defaultModel === defaultModel);
    if (modelOwner) {
      throw new Error(`模型 ${defaultModel} 已由 Chat Provider ${modelOwner.id} 托管；当前版本要求每个托管 Provider 使用不同的模型 ID，以避免路由到错误上游`);
    }
    let selectedPort = previous.port;
    if (!previous.providers.length) {
      selectedPort = 0;
      for (let candidate = DEFAULT_PORT; candidate < DEFAULT_PORT + 20; candidate += 1) {
        if (await canListen(host, candidate)) {
          selectedPort = candidate;
          break;
        }
      }
      if (!selectedPort) throw new Error(`本地端口 ${DEFAULT_PORT}-${DEFAULT_PORT + 19} 均被占用，无法启动协议代理`);
    }
    const next = {
      ...previous,
      port: selectedPort,
      providers: [...previous.providers, {
        id: provider.id,
        name: provider.name,
        upstreamBaseUrl: provider.baseUrl,
        envKey: provider.envKey,
        defaultModel,
        wireApi: "chat",
      }],
    };
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
          localBaseUrl: `http://${host}:${registry.port}/v1`,
          wireApi: "chat → responses",
          managedProxy: true,
          defaultModel: proxy.defaultModel,
        } : provider;
      }),
    };
  }

  return { decorateCatalog, prepareProvider, restart, snapshot, start, stop };
}

module.exports = {
  DEFAULT_PORT,
  PROXY_VERSION,
  createProtocolProxyService,
  providersFileValue,
  readRegistry,
};
