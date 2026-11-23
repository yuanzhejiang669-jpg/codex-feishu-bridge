import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildLarkCliEnv } from "../config/env.mjs";
import {
  eventIdOf,
  isRecallEvent,
  messageIdOf,
} from "../feishu/events.mjs";
import { waitForActiveChildrenShutdown } from "./process-runner.mjs";

export function createBridgeLifecycle(deps = {}) {
  const {
    CONFIG,
    log,
    pidPath,
    stopPath,
    codexGlobalStatePath,
    desktopCodexGlobalStatePath,
    shouldMirrorDesktopCodexHome,
    rememberEvent,
    releaseSingleInstanceLock,
    shutdownCallbacks,
    activeChildren,
    terminateProcessTree,
    MIN_SIDEBAR_RECONCILE_INTERVAL_MS,
    codexReasoningLabel,
    eventReplayGuard,
    eventDispatcher,
  } = deps;

  const scheduleSidebarReconcile = (...args) => deps.scheduleSidebarReconcile(...args);

  let shuttingDown = false;

  function startConsumer() {
    log("INFO", "starting bridge", {
      workspace: CONFIG.workspace,
      codexHome: CONFIG.codexHome,
      desktopCodexHome: CONFIG.desktopCodexHome || "",
      eventKeys: CONFIG.eventKeys,
      larkProfile: CONFIG.larkProfile || "default",
      larkCli: toolLabel(CONFIG.larkCli),
      codexCli: toolLabel(CONFIG.codexCli),
      runMode: CONFIG.runMode,
      sandbox: CONFIG.codexSandbox,
      reasoning: codexReasoningLabel,
      codexTimeoutMs: CONFIG.codexTimeoutMs,
      codexIdleTimeoutMs: CONFIG.codexIdleTimeoutMs,
      appServerIdleTtlMs: CONFIG.appServerIdleTtlMs,
      appServerPoolSize: CONFIG.appServerPoolSize,
      listLimit: CONFIG.listLimit,
      disableMcp: CONFIG.disableMcp,
      maxConcurrent: CONFIG.maxConcurrent,
      cardMode: CONFIG.useCards,
      cardThrottleMs: CONFIG.cardThrottleMs,
      debugCards: CONFIG.debugCards,
      showFinalSteps: CONFIG.showFinalSteps,
      maxRunningToolDetails: CONFIG.maxRunningToolDetails,
      larkDataFileThreshold: CONFIG.larkDataFileThreshold,
      replyToMessage: CONFIG.replyToMessage,
      replyInThread: CONFIG.useThreadReply,
      eventReplayGraceMs: CONFIG.eventReplayGraceMs,
      sidebarReconcileIntervalMs: CONFIG.sidebarReconcileIntervalMs,
    });

    startSidebarReconciler();
    for (const eventKey of CONFIG.eventKeys) startEventConsumer(eventKey);

    const stopTimer = setInterval(() => {
      if (fs.existsSync(stopPath)) {
        log("INFO", "stop file detected");
        try {
          fs.rmSync(stopPath, { force: true });
        } catch {}
        shutdown(0);
      }
    }, 1000);
    stopTimer.unref?.();
    shutdownCallbacks.add(() => clearInterval(stopTimer));
  }

  function startSidebarReconciler() {
    scheduleSidebarReconcile("startup", 0);

    const intervalMs = Math.max(
      MIN_SIDEBAR_RECONCILE_INTERVAL_MS,
      Number(CONFIG.sidebarReconcileIntervalMs || 0),
    );
    if (intervalMs > 0) {
      const timer = setInterval(() => {
        scheduleSidebarReconcile("interval", 1000);
      }, intervalMs);
      timer.unref?.();
      shutdownCallbacks.add(() => clearInterval(timer));
    }

    watchCodexGlobalStateForSidebarReconcile(codexGlobalStatePath, "codex-home");
    if (shouldMirrorDesktopCodexHome) {
      watchCodexGlobalStateForSidebarReconcile(desktopCodexGlobalStatePath, "desktop-codex-home");
    }
  }

  function watchCodexGlobalStateForSidebarReconcile(globalStatePath, label) {
    if (!globalStatePath || !fs.existsSync(path.dirname(globalStatePath))) return;
    try {
      const watcher = fs.watch(globalStatePath, { persistent: false }, () => {
        scheduleSidebarReconcile(`global-state/${label}`, 500);
      });
      shutdownCallbacks.add(() => watcher.close());
    } catch (error) {
      log("WARN", "codex global state watcher unavailable", {
        label,
        globalStatePath,
        error: String(error?.stack || error),
      });
    }
  }

  function startEventConsumer(eventKey) {
    const eventArgs = [...CONFIG.larkCli.argsPrefix, "event", "consume", eventKey, "--as", "bot"];
    const child = spawn(CONFIG.larkCli.command, eventArgs, {
      cwd: CONFIG.workspace,
      env: buildLarkCliEnv(CONFIG.larkProfileHome, process.env),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.set(child.pid, { child, label: `${CONFIG.larkCli.command} ${eventArgs.join(" ")}` });

    shutdownCallbacks.add(() => {
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => terminateProcessTree(child.pid, true), 5000).unref?.();
    });

    const stdoutRl = readline.createInterface({ input: child.stdout });
    stdoutRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        const replay = eventReplayGuard.inspect(event);
        if (replay.stale && !isRecallEvent(event)) {
          const messageId = messageIdOf(event);
          const dedupeId = eventIdOf(event) || messageId;
          if (dedupeId) rememberEvent(dedupeId, messageId);
          log("INFO", "stale startup replay ignored", {
            eventKey,
            eventId: eventIdOf(event),
            messageId,
            eventTimestampMs: replay.timestampMs,
            cutoffMs: replay.cutoffMs,
            ageMs: replay.ageMs,
          });
          return;
        }
        if (!isRecallEvent(event)) {
          const messageId = messageIdOf(event);
          const dedupeId = eventIdOf(event) || messageId;
          if (dedupeId) {
            if (rememberEvent(dedupeId, messageId)) {
              log("INFO", "duplicate event ignored before enqueue", { eventKey, dedupeId, messageId });
              return;
            }
            event._alreadyRemembered = true;
          }
        }
        eventDispatcher.enqueue(event);
      } catch (error) {
        log("WARN", "failed to parse event line", { line: trimmed.slice(0, 1000), error: String(error) });
      }
    });

    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.includes("[event] ready")) {
        log("INFO", "event consumer ready", { eventKey, line: trimmed });
      } else if (trimmed.includes("[event] exited")) {
        log("INFO", "event consumer exited", { eventKey, line: trimmed });
      } else {
        log("WARN", "event consumer stderr", { eventKey, line: trimmed });
      }
    });

    child.on("error", (error) => {
      log("ERROR", "event consumer spawn failed", { eventKey, error: String(error.stack || error) });
      shutdown(1);
    });

    child.on("close", (code) => {
      activeChildren.delete(child.pid);
      if (!shuttingDown) {
        log("ERROR", "event consumer stopped unexpectedly", { eventKey, code });
        shutdown(code || 1);
      }
    });
  }

  function toolLabel(tool) {
    return [tool.command, ...tool.argsPrefix].join(" ");
  }

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log("INFO", "shutting down bridge", { code });
    for (const callback of shutdownCallbacks) {
      try { await callback(); } catch {}
    }
    await waitForActiveChildrenShutdown({
      activeChildren,
      terminate: terminateProcessTree,
      totalTimeoutMs: 5000,
      escalateMs: 2500,
      pollMs: 100,
      log,
    });
    try {
      if (fs.existsSync(pidPath) && fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
        fs.rmSync(pidPath, { force: true });
      }
    } catch {}
    try {
      fs.rmSync(stopPath, { force: true });
    } catch {}
    releaseSingleInstanceLock();
    process.exit(code);
  }

  return {
    startConsumer,
    startSidebarReconciler,
    watchCodexGlobalStateForSidebarReconcile,
    startEventConsumer,
    toolLabel,
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
