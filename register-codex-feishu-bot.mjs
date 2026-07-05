#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_SECONDS = 10 * 60;

const HELP = `
Usage:
  node register-codex-feishu-bot.mjs --name codex-assistant-1 [options]

Options:
  --name <name>                 Instance/profile name. Required.
  --profile <name>              lark-cli profile name. Defaults to --name.
  --display-name <name>         Feishu app/bot display name shown during QR registration.
  --description <text>          Feishu app description shown during QR registration.
  --avatar-url <url>            Feishu app avatar URL. Can be repeated, max 6.
  --avatar-urls <urls>          Comma-separated Feishu app avatar URLs, max 6.
  --workspace <path>            Bridge workspace. Defaults to Documents\\Codex\\workspaces\\feishu-bridge-<name>.
  --codex-home <path>           Codex home used by this bot. Defaults to the normal user Codex home.
  --desktop-codex-home <path>   Desktop Codex home used for sidebar mirror.
  --source <source>             Lark registerApp source. Defaults to codex.
  --brand <feishu|lark>         lark-cli profile brand. Defaults to feishu.
  --timeout-seconds <seconds>   Registration timeout. Defaults to 600.
  --no-open-qr                  Do not open the QR HTML page automatically.
  --no-start                    Register and add profile only; do not start bridge.
  --install-startup             Install a per-instance scheduled-task watchdog.
  --force-profile               Remove an existing lark-cli profile with the same name first.
  --sandbox <value>             Passed to start script.
  --run-mode <app-server|auto|exec>
  --reasoning <value>           Passed to start script.
  --event-keys <keys>           Comma-separated EventKeys passed to start script.
  --codex-timeout-seconds <n>   Passed to start script.
  --codex-idle-timeout-seconds <n>
                                Passed to start script.
  --max-concurrent <n>          Passed to start script.
  --disable-mcp                 Passed to start script.
  --enable-mcp                  Passed to start script.
  --help                        Show this help.
`.trim();

main().catch((error) => {
  console.error(`\nERROR: ${error?.message || String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const name = safeName(options.name || "");
  const profile = String(options.profile || name).trim();
  if (!profile) throw new Error("missing --profile");
  const workspace = path.resolve(options.workspace || defaultWorkspace(name));
  const codexHomeRaw = String(options.codexHome || "").trim();
  const codexHome = codexHomeRaw ? path.resolve(codexHomeRaw) : "";
  const desktopCodexHomeRaw = String(options.desktopCodexHome || "").trim();
  const desktopCodexHome = desktopCodexHomeRaw ? path.resolve(desktopCodexHomeRaw) : "";
  const brand = String(options.brand || "feishu").trim().toLowerCase();
  if (!["feishu", "lark"].includes(brand)) throw new Error("--brand must be feishu or lark");

  const source = String(options.source || process.env.CODEX_FEISHU_REGISTER_SOURCE || "codex").trim();
  if (!source) throw new Error("missing --source");

  const larkCli = resolveLarkCliTool();
  await assertProfileAvailable(larkCli, profile, options.forceProfile);

  fs.mkdirSync(workspace, { recursive: true });
  if (codexHome) fs.mkdirSync(codexHome, { recursive: true });
  if (desktopCodexHome) fs.mkdirSync(desktopCodexHome, { recursive: true });

  console.log(`Instance: ${name}`);
  console.log(`Lark profile: ${profile}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Codex home: ${codexHome || "default"}`);
  console.log(`Desktop Codex home: ${desktopCodexHome || "none"}`);
  console.log(`Register source: ${source}`);
  console.log("");

  const app = await registerFeishuApp({
    name,
    source,
    displayName: options.displayName,
    description: options.description,
    avatarUrls: normalizeAvatarUrls(options.avatarUrl, options.avatarUrls),
    timeoutSeconds: options.timeoutSeconds,
    openQr: !options.noOpenQr,
  });
  console.log("");
  console.log(`Registered Feishu app: ${app.appId}`);
  if (app.tenantBrand) console.log(`Tenant: ${app.tenantBrand}`);
  if (app.operatorOpenId) console.log(`Operator: ${app.operatorOpenId}`);

  await addLarkProfile(larkCli, { profile, appId: app.appId, appSecret: app.appSecret, brand });
  console.log(`Created lark-cli profile: ${profile}`);

  if (!options.noStart) {
    await startBridge({ name, profile, workspace, codexHome, desktopCodexHome, options });
  }

  if (options.installStartup) {
    await installStartup({ name, profile, workspace, codexHome, desktopCodexHome, options });
  }

  console.log("");
  console.log("Done.");
  console.log(`Try in Feishu: /status`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if ([
      "noOpenQr",
      "noStart",
      "installStartup",
      "forceProfile",
      "disableMcp",
      "enableMcp",
    ].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    if (key === "avatarUrl") {
      options.avatarUrl = [...toArray(options.avatarUrl), value];
    } else {
      options[key] = value;
    }
  }
  return options;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeAvatarUrls(repeatedValues, csvValues) {
  const values = [
    ...toArray(repeatedValues),
    ...String(csvValues || "").split(","),
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const unique = [];
  for (const value of values) {
    if (!/^https?:\/\//i.test(value)) throw new Error(`--avatar-url must be http(s): ${value}`);
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.length > 6) throw new Error("--avatar-url supports at most 6 URLs");
  return unique;
}

function safeName(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("missing --name");
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`instance name contains no usable characters: ${raw}`);
  return safe;
}

function defaultWorkspace(name) {
  return path.join(os.homedir(), "Documents", "Codex", "workspaces", `feishu-bridge-${name}`);
}

function dataRootForRegistration(name) {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexFeishuBridge")
    : path.join(os.homedir(), ".codex-feishu-bridge");
  return path.join(base, "registrations", name);
}

async function registerFeishuApp({ name, source, displayName, description, avatarUrls, timeoutSeconds, openQr }) {
  const lark = await import("@larksuiteoapi/node-sdk");
  const registerApp = lark.registerApp || lark.default?.registerApp;
  if (typeof registerApp !== "function") {
    throw new Error("@larksuiteoapi/node-sdk does not expose registerApp; run npm install in this tool directory and ensure the SDK is current");
  }
  const QRCode = (await import("qrcode")).default;
  const timeoutNumber = Number(timeoutSeconds || DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(timeoutNumber)) throw new Error(`invalid --timeout-seconds: ${timeoutSeconds}`);
  const timeoutMs = Math.max(30, timeoutNumber) * 1000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();

  try {
    console.log("Requesting Feishu QR code...");
    const appPreset = {};
    if (String(displayName || "").trim()) appPreset.name = String(displayName).trim();
    if (String(description || "").trim()) appPreset.desc = String(description).trim();
    if (avatarUrls?.length) appPreset.avatar = avatarUrls.length === 1 ? avatarUrls[0] : avatarUrls;

    const result = await registerApp({
      source,
      signal: abort.signal,
      ...(Object.keys(appPreset).length ? { appPreset } : {}),
      onQRCodeReady: async (info) => {
        await showQrCode({ name, info, QRCode, openQr });
      },
      onStatusChange: (info) => {
        const status = info?.status || "unknown";
        if (status === "polling") return;
        console.log(`Registration status: ${status}`);
      },
    });

    const appId = result?.client_id || result?.appId;
    const appSecret = result?.client_secret || result?.appSecret;
    if (!appId || !appSecret) throw new Error("registration completed but app id/secret was missing");
    return {
      appId,
      appSecret,
      tenantBrand: result?.user_info?.tenant_brand,
      operatorOpenId: result?.user_info?.open_id,
    };
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`registration timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function showQrCode({ name, info, QRCode, openQr }) {
  const url = info?.url;
  if (!url) throw new Error("registerApp returned an empty QR URL");

  const dir = dataRootForRegistration(name);
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, "register-qr.png");
  const htmlPath = path.join(dir, "register-qr.html");
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M" });
  await QRCode.toFile(pngPath, url, { width: 320, margin: 2, errorCorrectionLevel: "M" });
  const terminalQr = await QRCode.toString(url, { type: "terminal", small: true });
  fs.writeFileSync(htmlPath, qrHtml({ dataUrl, url, expireIn: info.expireIn }), "utf8");

  console.log(terminalQr);
  console.log("Scan this QR code with Feishu.");
  console.log(`QR page: ${htmlPath}`);
  console.log(`QR image: ${pngPath}`);
  if (info.expireIn) console.log(`Expires in: ${info.expireIn}s`);
  if (openQr) openPath(htmlPath);
}

function qrHtml({ dataUrl, url, expireIn }) {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Codex Feishu Bot Registration</title>
<body style="font-family: system-ui, sans-serif; margin: 40px; line-height: 1.5;">
  <h1>Codex Feishu Bot Registration</h1>
  <p>Scan with Feishu and follow the prompts to create the bot app.</p>
  <img src="${dataUrl}" alt="registration QR" width="320" height="320">
  <p>Fallback link: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
  ${expireIn ? `<p>Expires in about ${Number(expireIn)} seconds.</p>` : ""}
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function openPath(target) {
  if (process.platform === "win32") {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Start-Process -LiteralPath $args[0]",
      target,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [target], { detached: true, stdio: "ignore" });
  child.unref();
}

async function assertProfileAvailable(larkCli, profile, forceProfile) {
  const profiles = await readProfiles(larkCli);
  const existing = profiles.find((item) => item?.name === profile);
  if (!existing) return;
  if (!forceProfile) {
    throw new Error(`lark-cli profile already exists: ${profile}. Use --force-profile to replace it.`);
  }
  console.log(`Removing existing lark-cli profile: ${profile}`);
  await runTool(larkCli, ["profile", "remove", profile], { timeoutMs: 30_000 });
}

async function readProfiles(larkCli) {
  const result = await runTool(larkCli, ["profile", "list"], { timeoutMs: 30_000 });
  const text = result.stdout.trim();
  if (!text) return [];
  return JSON.parse(text);
}

async function addLarkProfile(larkCli, { profile, appId, appSecret, brand }) {
  await runTool(larkCli, [
    "profile",
    "add",
    "--name",
    profile,
    "--app-id",
    appId,
    "--brand",
    brand,
    "--app-secret-stdin",
  ], {
    input: appSecret,
    timeoutMs: 60_000,
  });
}

async function startBridge({ name, profile, workspace, codexHome, desktopCodexHome, options }) {
  const script = path.join(ROOT, "start-codex-feishu-bridge.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Name",
    name,
    "-LarkProfile",
    profile,
    "-Workspace",
    workspace,
  ];
  addOptionalPowerShellArg(args, "-CodexHome", codexHome);
  addOptionalPowerShellArg(args, "-DesktopCodexHome", desktopCodexHome);
  addOptionalPowerShellArg(args, "-Sandbox", options.sandbox);
  addOptionalPowerShellArg(args, "-RunMode", options.runMode);
  addOptionalPowerShellArg(args, "-Reasoning", options.reasoning);
  addOptionalPowerShellArg(args, "-EventKeys", options.eventKeys);
  addOptionalPowerShellArg(args, "-CodexTimeoutSeconds", options.codexTimeoutSeconds);
  addOptionalPowerShellArg(args, "-CodexIdleTimeoutSeconds", options.codexIdleTimeoutSeconds);
  addOptionalPowerShellArg(args, "-MaxConcurrent", options.maxConcurrent);
  if (options.disableMcp) args.push("-DisableMcp");
  if (options.enableMcp) args.push("-EnableMcp");

  console.log("Starting bridge...");
  const result = await runRaw("powershell.exe", args, { timeoutMs: 60_000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  await waitForBridgeRunning(name, 30_000);
  console.log(`Bridge started: ${name}`);
}

async function installStartup({ name, profile, workspace, codexHome, desktopCodexHome, options }) {
  const script = path.join(ROOT, "install-codex-feishu-watchdog.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Name",
    name,
    "-LarkProfile",
    profile,
    "-Workspace",
    workspace,
  ];
  addOptionalPowerShellArg(args, "-CodexHome", codexHome);
  addOptionalPowerShellArg(args, "-DesktopCodexHome", desktopCodexHome);
  addOptionalPowerShellArg(args, "-CodexTimeoutSeconds", options.codexTimeoutSeconds);
  addOptionalPowerShellArg(args, "-CodexIdleTimeoutSeconds", options.codexIdleTimeoutSeconds);
  addOptionalPowerShellArg(args, "-EventKeys", options.eventKeys);
  console.log("Installing startup watchdog...");
  const result = await runRaw("powershell.exe", args, { timeoutMs: 60_000 });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function addOptionalPowerShellArg(args, name, value) {
  if (value == null || String(value).trim() === "") return;
  args.push(name, String(value));
}

async function waitForBridgeRunning(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPid = "";
  while (Date.now() < deadline) {
    const pid = readBridgePid(name);
    if (pid) {
      lastPid = pid;
      if (await isProcessRunning(pid)) return true;
    }
    await sleep(500);
  }
  throw new Error(`bridge did not start within ${Math.round(timeoutMs / 1000)}s${lastPid ? `; last pid=${lastPid}` : ""}`);
}

function readBridgePid(name) {
  const pidPath = path.join(instanceDataRoot(name), "state", "bridge.pid");
  try {
    const pid = fs.readFileSync(pidPath, "utf8").trim();
    return /^\d+$/.test(pid) ? pid : "";
  } catch {
    return "";
  }
}

function instanceDataRoot(name) {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexFeishuBridge")
    : path.join(os.homedir(), ".codex-feishu-bridge");
  return path.join(base, "instances", name);
}

function isProcessRunning(pid) {
  return new Promise((resolve) => {
    const checker = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-Command", `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`], { windowsHide: true })
      : spawn("sh", ["-c", `kill -0 ${Number(pid)}`]);
    checker.on("close", (code) => resolve(code === 0));
    checker.on("error", () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveLarkCliTool() {
  if (process.platform !== "win32") return { command: "lark-cli", argsPrefix: [] };
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "lark-cli.cmd"),
    path.join(appData, "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.cmd"),
  ];
  const cmd = candidates.find((item) => fs.existsSync(item)) || "lark-cli.cmd";
  return { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c", cmd] };
}

async function runTool(tool, args, options = {}) {
  return runRaw(tool.command, [...tool.argsPrefix, ...args], options);
}

function runRaw(command, args, { input = "", timeoutMs = 60_000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal}: ${stderr || stdout}`.trim()));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
