const { spawnSync } = require("node:child_process");

function macApplicationPath(executablePath) {
  const normalized = String(executablePath || "").replaceAll("\\", "/");
  const marker = "/Contents/MacOS/";
  const index = normalized.indexOf(marker);
  return index > 0 ? normalized.slice(0, index) : "";
}

function run(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: "utf8" });
  return {
    ok: result?.status === 0,
    output: `${result?.stdout || ""}\n${result?.stderr || ""}`,
  };
}

function assessUpdateSupport(options = {}) {
  if (!options.packaged) return { supported: false, reason: "开发模式不连接更新服务" };
  if (options.smokeTest || options.captureMode) return { supported: false, reason: "测试或截图模式不连接更新服务" };
  if (options.platform === "win32") return { supported: true, reason: "" };
  if (options.platform !== "darwin") return { supported: false, reason: "当前操作系统暂不支持客户端内更新" };

  const appPath = macApplicationPath(options.executablePath);
  if (!appPath) return { supported: false, reason: "无法定位 macOS 应用包，客户端内更新已停用" };
  const signature = run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], options.spawn);
  if (!signature.ok || !/Authority=Developer ID Application:/u.test(signature.output)) {
    return { supported: false, reason: "当前 macOS 客户端不是正式 Developer ID 签名版本，暂不能安全自动更新" };
  }
  const gatekeeper = run("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], options.spawn);
  if (!gatekeeper.ok) {
    return { supported: false, reason: "当前 macOS 客户端尚未通过 Apple 公证或 Gatekeeper 校验，暂不能安全自动更新" };
  }
  return { supported: true, reason: "" };
}

module.exports = { assessUpdateSupport, macApplicationPath };
