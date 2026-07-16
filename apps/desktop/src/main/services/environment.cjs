const { execFile } = require("node:child_process");
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

async function inspectCodex(scriptPath) {
  if (process.platform !== "win32") {
    return {
      supported: false,
      packageFound: false,
      runtimeFound: false,
      cliVersion: "",
      loginState: "unknown",
      error: "Windows is required",
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
    const runtimePath = inspection.cachedRuntimePath || inspection.sourceRuntimePath || "";
    const version = await runCodex(runtimePath, ["--version"], 8_000);
    const auth = await runCodex(runtimePath, ["login", "status"], 10_000);
    return {
      supported: true,
      ...inspection,
      runtimePath,
      cliVersion: cleanVersion(version.output),
      loginState: loginState(auth.output, auth.ok),
      loginSummary: auth.output.split(/\r?\n/).find(Boolean) || "",
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
  inspectCodex,
  loginState,
  parseJsonOutput,
};

