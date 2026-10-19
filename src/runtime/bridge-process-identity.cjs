const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function windowsProcesses(pids, run = execFileSync) {
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!ids.length) return [];
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const script = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$rows=@(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object {`,
    "[pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;commandLine=$_.CommandLine;createdAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}",
    "}); ConvertTo-Json -InputObject $rows -Compress",
  ].join("\n");
  const output = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
  const values = JSON.parse(String(output).replace(/^\uFEFF/, "").trim());
  return Array.isArray(values) ? values : [values];
}

function matchesBridgeOwner(info, owner) {
  if (!info || Number(info.pid) !== Number(owner?.pid)) return false;
  if (!/^node(?:\.exe)?$/i.test(String(info.name || ""))) return false;
  const args = /^\s*(?:"[^"]*"|\S+)\s+(?:"([^"]+)"|(\S+))/.exec(String(info.commandLine || ""));
  const entry = args?.[1] || args?.[2] || "";
  if (path.win32.basename(entry).toLowerCase() !== "codex-feishu-bridge.mjs") return false;
  if (owner.entryPath && path.win32.resolve(entry).toLowerCase() !== path.win32.resolve(owner.entryPath).toLowerCase()) return false;
  const createdAt = Number(info.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  if (owner.processStartTime) return createdAt === Number(owner.processStartTime);
  // Older locks have only the time at which the running Bridge acquired them.
  return Number(owner.startedAt) > 0 && createdAt <= Number(owner.startedAt);
}

function inspectBridgeOwners(owners, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return owners.map((owner) => ({ pid: Number(owner.pid), status: processAlive(Number(owner.pid)) ? "alive" : "stale" }));
  let processes;
  try { processes = windowsProcesses(owners.map((owner) => Number(owner.pid)), options.execFileSync); }
  catch (error) { return owners.map((owner) => ({ pid: Number(owner.pid), status: "unknown", error: `Unable to verify Bridge process identity: ${error.message}` })); }
  return owners.map((owner) => {
    const info = processes.find((item) => Number(item.pid) === Number(owner.pid));
    if (info && /^node(?:\.exe)?$/i.test(String(info.name || "")) && !info.commandLine) {
      return { pid: Number(owner.pid), status: "unknown", error: "Bridge process command line is unavailable" };
    }
    return { pid: Number(owner.pid), status: matchesBridgeOwner(info, owner) ? "alive" : "stale", createdAt: info?.createdAt || 0 };
  });
}

function isBridgeOwnerAlive(pid, owner) {
  if (process.platform !== "win32") return processAlive(Number(pid));
  // An inspection failure must never permit a second consumer or a destructive stop.
  return inspectBridgeOwners([{ ...owner, pid: Number(pid) }])[0].status !== "stale";
}

function ownProcessStartTime() {
  if (process.platform !== "win32") return undefined;
  return windowsProcesses([process.pid])[0]?.createdAt;
}

function inspectBridgeState(stateDir) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(path.join(stateDir, "bridge.lock.json"), "utf8").replace(/^\uFEFF/, "")); }
  catch (error) {
    if (error.code !== "ENOENT") return { status: "unknown", error: "Bridge lock is incomplete or unreadable; no process was stopped" };
  }
  let pid = Number(owner?.pid);
  if (!pid) {
    try { pid = Number(fs.readFileSync(path.join(stateDir, "bridge.pid"), "utf8").replace(/^\uFEFF/, "").trim()); } catch {}
    if (!processAlive(pid)) return { pid, status: "stale" };
    return { pid, status: "unknown", error: "Live PID has no Bridge ownership record; no process was stopped" };
  }
  return inspectBridgeOwners([owner])[0];
}

module.exports = { inspectBridgeOwners, inspectBridgeState, isBridgeOwnerAlive, matchesBridgeOwner, ownProcessStartTime, windowsProcesses };

if (require.main === module) {
  try {
    if (process.argv[2] !== "--state" || !process.argv[3]) throw new Error("Expected --state <Bridge state directory>");
    const result = inspectBridgeState(process.argv[3]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "alive" ? 0 : result.status === "stale" ? 3 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "unknown", error: error.message })}\n`);
    process.exitCode = 2;
  }
}
