const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function powershellPath() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("Codex inspection returned no data");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Codex inspection returned invalid JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function inspectRuntimeDirectory(runtimePath, platform = process.platform) {
  if (!runtimePath) return { runtimeDirectory: "", runtimeExecutableCount: 0 };
  const runtimeDirectory = path.dirname(runtimePath);
  let runtimeExecutableCount = 0;
  try {
    runtimeExecutableCount = fs.readdirSync(runtimeDirectory, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isFile()) return false;
        if (platform === "win32") return path.extname(entry.name).toLowerCase() === ".exe";
        try {
          fs.accessSync(path.join(runtimeDirectory, entry.name), fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
      .length;
  } catch {
    runtimeExecutableCount = 0;
  }
  return { runtimeDirectory, runtimeExecutableCount };
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}

function macCodexCandidates(home = require("node:os").homedir()) {
  const posixHome = String(home || "").replaceAll("\\", "/");
  const bundles = [
    "/Applications/ChatGPT.app",
    path.posix.join(posixHome, "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    path.posix.join(posixHome, "Applications", "Codex.app"),
  ];
  const relativeCandidates = [
    path.posix.join("Contents", "Resources", "codex"),
    path.posix.join("Contents", "Resources", "bin", "codex"),
    path.posix.join("Contents", "Resources", "codex-cli"),
  ];
  return bundles.flatMap((bundle) => relativeCandidates.map((relative) => path.posix.join(bundle, relative)));
}

function findMacBundleRuntime(bundlePath) {
  const resourcesRoot = path.posix.join(bundlePath, "Contents", "Resources");
  const matches = [];
  const visit = (directory, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const candidate = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^codex(?:-cli)?(?:-[\w.-]+)?$/.test(entry.name)) continue;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        matches.push(candidate);
      } catch {}
    }
  };
  visit(resourcesRoot, 0);
  return matches.sort((left, right) => {
    const leftExact = path.posix.basename(left) === "codex" ? 0 : 1;
    const rightExact = path.posix.basename(right) === "codex" ? 0 : 1;
    return leftExact - rightExact || left.length - right.length;
  })[0] || "";
}

async function inspectMacCodex(options = {}) {
  const candidates = options.candidates || macCodexCandidates(options.home);
  const readBundleValue = options.readBundleValue || (async (bundlePath, key) => String((await execFileAsync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", path.join(bundlePath, "Contents", "Info.plist")],
    { timeout: 5_000, encoding: "utf8" },
  )).stdout || "").trim());
  const discoveredBundles = [...new Set(candidates
    .filter((candidate) => candidate.includes(".app/"))
    .map((candidate) => `${candidate.split(".app/")[0]}.app`))]
    .filter((bundlePath) => fs.existsSync(bundlePath));
  const bundles = [];
  for (const bundlePath of discoveredBundles) {
    try {
      const bundleId = await readBundleValue(bundlePath, "CFBundleIdentifier");
      if (bundleId === "com.openai.codex") bundles.push(bundlePath);
    } catch {}
  }
  const bundleCandidates = candidates.filter((candidate) => bundles.some((bundle) => candidate.startsWith(`${bundle}/`)));
  let runtimePath = firstExecutable(bundleCandidates);
  if (!runtimePath) {
    runtimePath = bundles.map(findMacBundleRuntime).find(Boolean) || "";
  }
  if (!runtimePath) {
    try {
      runtimePath = String((await execFileAsync("/usr/bin/which", ["codex"], {
        timeout: 5_000,
        encoding: "utf8",
      })).stdout || "").trim();
    } catch {
      runtimePath = "";
    }
  }
  const bundlePath = bundles.find((bundle) => runtimePath.startsWith(`${bundle}/`)) || bundles[0] || "";
  let packageVersion = "";
  if (bundlePath && fs.existsSync(bundlePath)) {
    try {
      packageVersion = await readBundleValue(bundlePath, "CFBundleShortVersionString");
    } catch {
      packageVersion = "";
    }
  }
  const version = await runCodex(runtimePath, ["--version"], 8_000);
  const auth = await runCodex(runtimePath, ["login", "status"], 10_000);
  return {
    supported: true,
    platform: "darwin",
    packageFound: Boolean(bundlePath && fs.existsSync(bundlePath)),
    bundleIdentifier: bundlePath ? "com.openai.codex" : "",
    packageVersion,
    installLocation: bundlePath && fs.existsSync(bundlePath) ? bundlePath : "",
    sourceRuntimePath: runtimePath,
    cachedRuntimePath: "",
    runtimeFound: Boolean(runtimePath),
    runtimePath,
    ...inspectRuntimeDirectory(runtimePath, "darwin"),
    cliVersion: cleanVersion(version.output),
    loginState: loginState(auth.output, auth.ok),
    loginSummary: auth.output.split(/\r?\n/).find(Boolean) || "",
  };
}

async function runCodex(runtimePath, args, timeout) {
  if (!runtimePath) return { ok: false, output: "" };
  try {
    const result = await execFileAsync(runtimePath, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, output: `${result.stdout || ""}\n${result.stderr || ""}`.trim() };
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`.trim();
    return { ok: false, output, error: error.code === "ETIMEDOUT" ? "timeout" : "unavailable" };
  }
}

function cleanVersion(output) {
  const match = String(output || "").match(/(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i);
  return match ? match[1] : "";
}

function loginState(output, ok) {
  const text = String(output || "").toLowerCase();
  if (/not logged in|signed out|unauthenticated|no credentials/.test(text)) return "signed-out";
  if (ok && /logged in|chatgpt|api key|access token/.test(text)) return "signed-in";
  return "unknown";
}

async function inspectCodex(scriptPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "darwin") return inspectMacCodex(options);
  if (platform !== "win32") {
    return {
      supported: false,
      packageFound: false,
      runtimeFound: false,
      cliVersion: "",
      loginState: "unknown",
      error: "Windows or macOS is required",
    };
  }

  try {
    const result = await execFileAsync(powershellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      scriptPath,
    ], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const inspection = parseJsonOutput(result.stdout);
    const runtimeCandidatePath = inspection.cachedRuntimePath || "";
    const version = await runCodex(runtimeCandidatePath, ["--version"], 8_000);
    const runtimePath = version.ok ? runtimeCandidatePath : "";
    const runtimeDirectory = inspectRuntimeDirectory(runtimePath, "win32");
    const auth = await runCodex(runtimePath, ["login", "status"], 10_000);
    const runtimeError = !runtimeCandidatePath
      ? "No executable Codex runtime cache is available"
      : (!version.ok ? "The cached Codex runtime could not be executed" : "");
    return {
      supported: true,
      ...inspection,
      runtimeFound: Boolean(runtimePath),
      runtimeCandidatePath,
      runtimePath,
      ...runtimeDirectory,
      cliVersion: cleanVersion(version.output),
      loginState: loginState(auth.output, auth.ok),
      loginSummary: auth.output.split(/\r?\n/).find(Boolean) || "",
      error: runtimeError,
    };
  } catch (error) {
    return {
      supported: true,
      packageFound: false,
      runtimeFound: false,
      cliVersion: "",
      loginState: "unknown",
      error: error.code === "ETIMEDOUT" ? "Codex inspection timed out" : error.message,
    };
  }
}

module.exports = {
  cleanVersion,
  firstExecutable,
  findMacBundleRuntime,
  inspectCodex,
  inspectMacCodex,
  inspectRuntimeDirectory,
  loginState,
  macCodexCandidates,
  parseJsonOutput,
};
