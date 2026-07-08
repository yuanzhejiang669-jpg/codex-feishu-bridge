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
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {}
}
