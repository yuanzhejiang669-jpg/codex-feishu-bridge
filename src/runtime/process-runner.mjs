import { spawn } from "node:child_process";

export function createProcessRunner({
  activeChildren,
  workspace,
} = {}) {
  function runTool(tool, args, options = {}) {
    const finalArgs = [...tool.argsPrefix, ...args];
    const child = spawn(tool.command, finalArgs, {
      cwd: options.cwd || workspace,
      env: { ...process.env, ...(options.env || {}) },
      ...(process.platform !== "win32" ? { detached: true } : {}),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.set(child.pid, { child, label: `${tool.command} ${finalArgs.join(" ")}` });
    options.onSpawn?.(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdinError = null;
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.stdin.on("error", (error) => {
      stdinError = error;
    });

    try {
      child.stdin.end(options.stdin || "");
    } catch (error) {
      stdinError = error;
    }

    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child.pid, false);
            setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
          }, options.timeoutMs)
        : null;

      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        activeChildren.delete(child.pid);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = [
          Buffer.concat(stderrChunks).toString("utf8"),
          stdinError ? `stdin error: ${stdinError.message}` : "",
        ].filter(Boolean).join("\n");
        resolve({ code, stdout, stderr, timedOut, pid: child.pid });
      });
    });
  }

  return {
    isProcessAlive,
    runTool,
    terminateProcessTree,
  };
}

export function isProcessAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function terminateProcessTree(pid, force) {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const killer = spawn("taskkill.exe", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export async function waitForActiveChildrenShutdown({
  activeChildren,
  terminate = terminateProcessTree,
  totalTimeoutMs = 5000,
  escalateMs = 2500,
  pollMs = 100,
  log = () => {},
} = {}) {
  if (!activeChildren || activeChildren.size === 0) return { remaining: 0, escalated: false };
  for (const [pid, info] of activeChildren) {
    log("INFO", "terminating child process", { pid, label: String(info?.label || "").slice(0, 300) });
    terminate(pid, false);
  }
  const startedAt = Date.now();
  let escalated = false;
  while (activeChildren.size > 0 && Date.now() - startedAt < totalTimeoutMs) {
    if (!escalated && Date.now() - startedAt >= escalateMs) {
      escalated = true;
      for (const [pid, info] of activeChildren) {
        log("WARN", "force terminating remaining child process tree", { pid, label: String(info?.label || "").slice(0, 300) });
        terminate(pid, true);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (activeChildren.size > 0 && !escalated) {
    escalated = true;
    for (const [pid] of activeChildren) terminate(pid, true);
  }
  return { remaining: activeChildren.size, escalated };
}
