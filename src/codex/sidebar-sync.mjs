import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sameResolvedPath,
  stripWindowsLongPathPrefix,
} from "../config/paths.mjs";
import {
  deleteCodexThreadRows,
  sqliteExecTransaction,
  sqliteQueryAll,
  sqliteTableColumns as querySqliteTableColumns,
  sqliteTableSet as querySqliteTableSet,
  upsertCodexThreadRow,
} from "./sqlite-store.mjs";
import { discoverCodexHomeRegistry } from "../sessions/codex-home-registry.mjs";
import {
  readJsonFile,
  recordsMatchColumns,
  writeJsonFileAtomicSync,
} from "../utils/json.mjs";
import { safeJson } from "../logging/errors.mjs";

export function createCodexSidebarSync(deps = {}) {
  const {
    ROOT,
    DEFAULT_DATA_ROOT,
    CONFIG,
    log,
    lockPath,
    codexStateDbPath,
    codexSessionIndexPath,
    codexGlobalStatePath,
    codexSidebarLockPath,
    desktopCodexStateDbPath,
    desktopCodexSessionIndexPath,
    desktopCodexGlobalStatePath,
    desktopCodexSidebarLockPath,
    deletedThreadsFileName,
    shouldMirrorDesktopCodexHome,
    activeCodexJobs,
    sessions,
  } = deps;

  const userTextFromContent = (...args) => deps.userTextFromContent(...args);
  const normalizeRenameTitle = (...args) => deps.normalizeRenameTitle(...args);
  const cleanCodexThreadTitle = (...args) => deps.cleanCodexThreadTitle(...args);
  const codexThreadTime = (...args) => deps.codexThreadTime(...args);
  const listRolloutFiles = (...args) => deps.listRolloutFiles(...args);
  const loadGlobalStateThreadEntries = (...args) => deps.loadGlobalStateThreadEntries(...args);
  const removeDeletedThreadsFromBridgeSessions = (...args) => deps.removeDeletedThreadsFromBridgeSessions(...args);
  const delay = (...args) => deps.delay(...args);

  let sidebarReconcileInFlight = false;
  let sidebarReconcileQueuedReason = "";
  let sidebarReconcileTimer = null;
  let sidebarReconcilePendingReason = "";

  function replaceWindowsLongPathPrefix(value) {
    const text = String(value || "");
    if (process.platform !== "win32") return text;
    if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
    if (/^\\\\\?\\/i.test(text)) return text.slice(4);
    return text;
  }

  function normalizeSpaces(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function shorten(value, max = 120) {
    const text = normalizeSpaces(value);
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
  }

  function feishuSidebarTitle(event, session) {
    const content = userTextFromContent(event.content);
    const body = content || (event.attachments?.length ? "附件消息" : "飞书消息");
    return shorten(`飞书：${session.id} · ${body}`, 120);
  }

  function extractCodexThreadId(stdoutRaw) {
    for (const line of String(stdoutRaw || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const value = parsed?.thread_id || parsed?.threadId || parsed?.thread?.id || parsed?.conversation_id;
        if (typeof value === "string" && value) return value;
      } catch {}
    }
    return "";
  }

  async function sqliteJson(dbPath, sql, params = []) {
    if (!fs.existsSync(dbPath)) return [];
    try {
      return sqliteQueryAll(dbPath, sql, params);
    } catch (error) {
      log("WARN", "sqlite json query failed", { dbPath, error: String(error?.message || error).slice(0, 500) });
      return [];
    }
  }

  async function sqliteExec(dbPath, statementsWithParams) {
    try {
      sqliteExecTransaction(dbPath, statementsWithParams);
      return true;
    } catch (error) {
      log("WARN", "sqlite exec failed", { dbPath, error: String(error?.message || error).slice(0, 500) });
      return false;
    }
  }

  async function sqliteExecChecked(dbPath, statementsWithParams) {
    return sqliteExecTransaction(dbPath, statementsWithParams);
  }

  async function loadCodexThreadRecord(threadId) {
    return await loadCodexThreadRecordFromDb(threadId, codexStateDbPath);
  }

  async function loadCodexThreadRecordFromDb(threadId, dbPath = codexStateDbPath) {
    const rows = await sqliteJson(
      dbPath,
      "select * from threads where id = ? limit 1;",
      [String(threadId || "")],
    );
    return rows[0] || null;
  }

  async function updateCodexThreadTitleInDb(threadId, title, dbPath = codexStateDbPath) {
    const id = String(threadId || "").trim();
    const nextTitle = normalizeRenameTitle(title);
    if (!id || !nextTitle || !fs.existsSync(dbPath)) return false;
    const record = await loadCodexThreadRecordFromDb(id, dbPath);
    if (!record) return false;
    const columns = await sqliteTableColumns("threads", dbPath);
    if (!columns.has("title")) return false;
    await sqliteExecChecked(dbPath, [
      { sql: "UPDATE threads SET title = ? WHERE id = ?;", params: [nextTitle, id] },
    ]);
    return true;
  }

  function codexThreadBelongsToThisBridge(record) {
    if (!record) return false;
    const cwd = stripWindowsLongPathPrefix(record.cwd || "");
    const workspace = stripWindowsLongPathPrefix(CONFIG.workspace || "");
    if (!cwd || !workspace) return false;
    const cwdResolved = path.resolve(cwd).toLowerCase();
    const workspaceResolved = path.resolve(workspace).toLowerCase();
    return cwdResolved === workspaceResolved;
  }

  function codexThreadHasVisibleText(record) {
    return Boolean(String(record?.preview || record?.title || "").trim());
  }

  function codexThreadTitleForIndex(record, preferredTitle = "") {
    return cleanCodexThreadTitle(preferredTitle)
      || cleanCodexThreadTitle(record?.title)
      || cleanCodexThreadTitle(record?.first_user_message)
      || cleanCodexThreadTitle(record?.preview)
      || "Untitled";
  }

  function codexThreadUpdatedIso(record) {
    const ms = codexThreadTime(record, "updated") || codexThreadTime(record, "created") || Date.now();
    return new Date(ms).toISOString();
  }

  function codexWorkspaceRootHint() {
    const workspace = stripWindowsLongPathPrefix(CONFIG.workspace || "");
    const documentsCodex = path.join(os.homedir(), "Documents", "Codex");
    const workspaceRoot = path.join(documentsCodex, "workspaces");
    const resolvedWorkspace = path.resolve(workspace || CONFIG.workspace);
    const relativeToWorkspaceRoot = path.relative(workspaceRoot, resolvedWorkspace);
    if (relativeToWorkspaceRoot && !relativeToWorkspaceRoot.startsWith("..") && !path.isAbsolute(relativeToWorkspaceRoot)) {
      return documentsCodex;
    }
    return path.dirname(resolvedWorkspace);
  }

  async function withCodexSidebarLock(fn, codexHome = CONFIG.codexHome, lockPath = codexSidebarLockPath) {
    fs.mkdirSync(codexHome, { recursive: true });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let fd = null;
      try {
        fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
        return await fn();
      } catch (error) {
        if (!["EEXIST", "EACCES", "EPERM"].includes(error?.code)) throw error;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) fs.rmSync(lockPath, { force: true });
        } catch {}
        await delay(100);
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {}
        }
      }
    }
    throw new Error(`timed out waiting for Codex sidebar sync lock: ${lockPath}`);
  }

  function registeredCodexHomeRegistry() {
    return discoverCodexHomeRegistry({
      currentCodexHome: CONFIG.codexHome,
      desktopCodexHome: CONFIG.desktopCodexHome,
      stateDir: CONFIG.stateDir,
      engineRoot: ROOT,
      defaultDataRoot: DEFAULT_DATA_ROOT,
    });
  }

  function codexHomeResourcePaths(codexHome) {
    const home = path.resolve(codexHome);
    return {
      codexHome: home,
      stateDbPath: path.join(home, "state_5.sqlite"),
      sessionIndexPath: path.join(home, "session_index.jsonl"),
      globalStatePath: path.join(home, ".codex-global-state.json"),
      sidebarLockPath: path.join(home, ".codex-feishu-sidebar-sync.lock"),
      deletedThreadsPath: path.join(home, deletedThreadsFileName),
    };
  }

  function loadDeletedThreadIds(codexHome = CONFIG.codexHome) {
    const filePath = path.join(codexHome, deletedThreadsFileName);
    const parsed = readJsonFile(filePath, null);
    const entries = parsed?.threads && typeof parsed.threads === "object" ? parsed.threads : {};
    return new Set(Object.keys(entries).filter(Boolean));
  }

  function isCodexThreadDeleted(threadId, codexHome = CONFIG.codexHome) {
    const id = String(threadId || "").trim();
    return Boolean(id && loadDeletedThreadIds(codexHome).has(id));
  }

  function isCodexThreadDeletedForBridge(threadId) {
    return isCodexThreadDeleted(threadId, CONFIG.codexHome)
      || Boolean(CONFIG.desktopCodexHome && isCodexThreadDeleted(threadId, CONFIG.desktopCodexHome));
  }

  function writeCodexThreadTombstone(threadId, codexHome) {
    const id = String(threadId || "").trim();
    if (!id) return false;
    const filePath = path.join(codexHome, deletedThreadsFileName);
    const parsed = readJsonFile(filePath, {});
    const state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    if (!state.threads || typeof state.threads !== "object" || Array.isArray(state.threads)) state.threads = {};
    if (state.threads[id]) return false;
    state.version = 1;
    state.threads[id] = {
      deletedAt: new Date().toISOString(),
      deletedByInstance: process.env.CODEX_FEISHU_INSTANCE_NAME || "default",
    };
    writeJsonFileAtomicSync(filePath, state, { space: 2 });
    return true;
  }

  async function markCodexThreadDeletedAcrossHomes(threadId, homes) {
    const markedHomes = [];
    for (const codexHome of homes) {
      const paths = codexHomeResourcePaths(codexHome);
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await withCodexSidebarLock(
            async () => {
              if (writeCodexThreadTombstone(threadId, paths.codexHome)) markedHomes.push(paths.codexHome);
            },
            paths.codexHome,
            paths.sidebarLockPath,
          );
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await delay(attempt * 250);
        }
      }
      if (lastError) throw lastError;
    }
    return markedHomes;
  }

  function readCodexSessionIndexTitle(threadId, sessionIndexPath = codexSessionIndexPath) {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(sessionIndexPath)) return "";

    const lines = fs.readFileSync(sessionIndexPath, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.id === id) return cleanCodexThreadTitle(parsed.thread_name);
      } catch {}
    }
    return "";
  }

  function syncCodexSessionIndex(record, sessionIndexPath = codexSessionIndexPath, options = {}) {
    const id = String(record?.id || "").trim();
    if (!id) return false;

    const entry = JSON.stringify({
      id,
      thread_name: codexThreadTitleForIndex(record, options.threadName || ""),
      updated_at: codexThreadUpdatedIso(record),
    });

    let lines = [];
    if (fs.existsSync(sessionIndexPath)) {
      lines = fs.readFileSync(sessionIndexPath, "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n");
      if (lines.at(-1) === "") lines.pop();
    }

    let replaced = false;
    const nextLines = [];
    for (const line of lines) {
      if (!line.trim()) {
        nextLines.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed?.id === id) {
          if (!replaced) {
            nextLines.push(entry);
            replaced = true;
          }
          continue;
        }
      } catch {}
      nextLines.push(line);
    }
    if (!replaced) nextLines.push(entry);

    const next = `${nextLines.join("\n")}\n`;
    const previous = fs.existsSync(sessionIndexPath) ? fs.readFileSync(sessionIndexPath, "utf8") : "";
    if (previous === next) return false;
    fs.writeFileSync(sessionIndexPath, next, "utf8");
    return true;
  }

  function hasCodexSessionIndexEntry(threadId, sessionIndexPath = codexSessionIndexPath) {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(sessionIndexPath)) return false;
    const lines = fs.readFileSync(sessionIndexPath, "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line)?.id === id) return true;
      } catch {}
    }
    return false;
  }

  function removeCodexSessionIndexEntry(threadId, sessionIndexPath = codexSessionIndexPath) {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(sessionIndexPath)) return false;

    const previous = fs.readFileSync(sessionIndexPath, "utf8");
    const lines = previous.replace(/\r\n/g, "\n").split("\n");
    const hadTrailingNewline = lines.at(-1) === "";
    if (hadTrailingNewline) lines.pop();

    let changed = false;
    const nextLines = [];
    for (const line of lines) {
      if (!line.trim()) {
        nextLines.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed?.id === id) {
          changed = true;
          continue;
        }
      } catch {}
      nextLines.push(line);
    }

    if (!changed) return false;
    const next = `${nextLines.join("\n")}${hadTrailingNewline || nextLines.length ? "\n" : ""}`;
    fs.writeFileSync(sessionIndexPath, next, "utf8");
    return true;
  }

  function syncCodexGlobalState(record, globalStatePath = codexGlobalStatePath) {
    const id = String(record?.id || "").trim();
    if (!id) return false;

    let state = {};
    if (fs.existsSync(globalStatePath)) {
      const raw = fs.readFileSync(globalStatePath, "utf8").trim();
      if (raw) state = JSON.parse(raw);
    }

    let changed = false;
    if (!Array.isArray(state["projectless-thread-ids"])) {
      state["projectless-thread-ids"] = [];
      changed = true;
    }
    if (!state["projectless-thread-ids"].includes(id)) {
      state["projectless-thread-ids"].push(id);
      changed = true;
    }

    const rootHint = codexWorkspaceRootHint();
    if (!state["thread-workspace-root-hints"] || typeof state["thread-workspace-root-hints"] !== "object") {
      state["thread-workspace-root-hints"] = {};
      changed = true;
    }
    if (state["thread-workspace-root-hints"][id] !== rootHint) {
      state["thread-workspace-root-hints"][id] = rootHint;
      changed = true;
    }

    const outputPath = path.join(stripWindowsLongPathPrefix(CONFIG.workspace), "outputs");
    if (!state["thread-projectless-output-directories"] || typeof state["thread-projectless-output-directories"] !== "object") {
      state["thread-projectless-output-directories"] = {};
      changed = true;
    }
    if (state["thread-projectless-output-directories"][id] !== outputPath) {
      state["thread-projectless-output-directories"][id] = outputPath;
      changed = true;
    }

    if (!changed) return false;
    writeJsonFileAtomicSync(globalStatePath, state, { space: 0 });
    return true;
  }

  function removeCodexGlobalStateThread(threadId, globalStatePath = codexGlobalStatePath) {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(globalStatePath)) return false;

    const raw = fs.readFileSync(globalStatePath, "utf8").trim();
    if (!raw) return false;
    const state = JSON.parse(raw);
    let changed = false;

    for (const key of ["projectless-thread-ids", "pinned-thread-ids"]) {
      if (!Array.isArray(state[key])) continue;
      const next = state[key].filter((value) => value !== id);
      if (next.length !== state[key].length) {
        state[key] = next;
        changed = true;
      }
    }

    for (const key of ["thread-workspace-root-hints", "thread-projectless-output-directories"]) {
      if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) continue;
      if (Object.prototype.hasOwnProperty.call(state[key], id)) {
        delete state[key][id];
        changed = true;
      }
    }

    if (!changed) return false;
    writeJsonFileAtomicSync(globalStatePath, state, { space: 0 });
    return true;
  }

  async function mirrorCodexThreadRecordToDesktopHome(record) {
    if (!shouldMirrorDesktopCodexHome) return false;
    if (!record?.id || !fs.existsSync(desktopCodexStateDbPath)) return false;

    const desktopRecord = {
      ...record,
      rollout_path: mirrorCodexRolloutToDesktopHome(record),
    };
    const sourceColumns = Object.keys(record);
    const targetColumns = await sqliteTableColumns("threads", desktopCodexStateDbPath);
    const columns = sourceColumns.filter((name) => targetColumns.has(name));
    if (!columns.includes("id") || !columns.includes("rollout_path")) return false;

    const current = await loadCodexThreadRecordFromDb(record.id, desktopCodexStateDbPath);
    if (recordsMatchColumns(current, desktopRecord, columns)) return false;

    try {
      upsertCodexThreadRow(desktopCodexStateDbPath, {
        columns,
        values: columns.map((name) => desktopRecord[name] ?? null),
      });
    } catch (error) {
      log("WARN", "desktop Codex home thread mirror failed", {
        threadId: record.id,
        sourceCodexHome: CONFIG.codexHome,
        desktopCodexHome: CONFIG.desktopCodexHome,
        desktopCodexStateDbPath,
        error: String(error?.message || error).slice(0, 500),
      });
      return false;
    }
    return true;
  }

  function mirrorCodexRolloutToDesktopHome(record) {
    const sourcePath = replaceWindowsLongPathPrefix(record?.rollout_path || "");
    if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) return record?.rollout_path || "";

    const sourceSessionsRoot = path.join(CONFIG.codexHome, "sessions");
    const sourceRootResolved = fs.existsSync(sourceSessionsRoot)
      ? fs.realpathSync.native(sourceSessionsRoot)
      : path.resolve(sourceSessionsRoot);
    const sourceResolved = fs.realpathSync.native(sourcePath);
    const relative = path.relative(sourceRootResolved, sourceResolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      log("WARN", "desktop Codex home rollout mirror skipped; source rollout outside source sessions", {
        threadId: record?.id || "",
        rolloutPath: sourcePath,
        sourceSessionsRoot,
      });
      return record?.rollout_path || "";
    }

    const targetPath = path.join(CONFIG.desktopCodexHome, "sessions", relative);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const sourceStat = fs.statSync(sourceResolved);
    const targetStat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
    if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) {
      fs.copyFileSync(sourceResolved, targetPath);
    }
    return targetPath;
  }

  async function mirrorCodexDesktopSidebarIndexed(record, reason = "app-server") {
    if (!shouldMirrorDesktopCodexHome) return false;
    if (!record?.id) return false;
    if (isCodexThreadDeletedForBridge(record.id)) {
      return false;
    }
    if (!fs.existsSync(desktopCodexStateDbPath)) {
      log("WARN", "desktop Codex home mirror skipped; target state database not found", {
        threadId: record.id,
        desktopCodexHome: CONFIG.desktopCodexHome,
        desktopCodexStateDbPath,
      });
      return false;
    }

    try {
      const changed = await withCodexSidebarLock(async () => {
        const threadRecordChanged = await mirrorCodexThreadRecordToDesktopHome(record);
        const desktopRecord = await loadCodexThreadRecordFromDb(record.id, desktopCodexStateDbPath) || record;
        const sourceThreadName = readCodexSessionIndexTitle(record.id, codexSessionIndexPath);
        const sessionIndexChanged = syncCodexSessionIndex(desktopRecord, desktopCodexSessionIndexPath, {
          threadName: sourceThreadName,
        });
        const globalStateChanged = syncCodexGlobalState(desktopRecord, desktopCodexGlobalStatePath);
        return { threadRecordChanged, sessionIndexChanged, globalStateChanged };
      }, CONFIG.desktopCodexHome, desktopCodexSidebarLockPath);

      if (changed.threadRecordChanged || changed.sessionIndexChanged || changed.globalStateChanged) {
        log("INFO", "desktop Codex home sidebar mirror synced", {
          threadId: record.id,
          reason,
          sourceCodexHome: CONFIG.codexHome,
          desktopCodexHome: CONFIG.desktopCodexHome,
          workspace: CONFIG.workspace,
          threadRecordChanged: changed.threadRecordChanged,
          sessionIndexChanged: changed.sessionIndexChanged,
          globalStateChanged: changed.globalStateChanged,
        });
        return true;
      }
    } catch (error) {
      log("WARN", "desktop Codex home sidebar mirror failed", {
        threadId: record.id,
        reason,
        sourceCodexHome: CONFIG.codexHome,
        desktopCodexHome: CONFIG.desktopCodexHome,
        error: String(error?.stack || error),
      });
    }
    return false;
  }

  async function ensureCodexDesktopSidebarIndexed(threadId, reason = "app-server") {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(codexStateDbPath)) return false;
    if (isCodexThreadDeletedForBridge(id)) {
      return false;
    }

    const record = await loadCodexThreadRecord(id);
    if (!record) return false;
    if (!codexThreadBelongsToThisBridge(record)) return false;
    if (Number(record.archived || 0) !== 0) return false;
    if (!codexThreadHasVisibleText(record)) return false;

    try {
      const changed = await withCodexSidebarLock(async () => {
        const sessionIndexChanged = syncCodexSessionIndex(record);
        const globalStateChanged = syncCodexGlobalState(record);
        return { sessionIndexChanged, globalStateChanged };
      });
      const mirrored = await mirrorCodexDesktopSidebarIndexed(record, reason);
      if (changed.sessionIndexChanged || changed.globalStateChanged) {
        log("INFO", "codex desktop sidebar index synced", {
          threadId: id,
          reason,
          codexHome: CONFIG.codexHome,
          workspace: CONFIG.workspace,
          sessionIndexChanged: changed.sessionIndexChanged,
          globalStateChanged: changed.globalStateChanged,
        });
        return true;
      }
      if (mirrored) return true;
    } catch (error) {
      log("WARN", "codex desktop sidebar index sync failed", {
        threadId: id,
        reason,
        codexHome: CONFIG.codexHome,
        error: String(error?.stack || error),
      });
    }
    return await mirrorCodexDesktopSidebarIndexed(record, reason);
  }

  async function ensureAppServerThreadVisible(threadId, reason = "app-server") {
    const id = String(threadId || "").trim();
    if (!id || !fs.existsSync(codexStateDbPath)) return false;
    if (isCodexThreadDeletedForBridge(id)) return false;

    const record = await loadCodexThreadRecord(id);
    if (!record) return false;
    if (!codexThreadBelongsToThisBridge(record)) return false;
    if (Number(record.archived || 0) !== 0) return false;
    if (!codexThreadHasVisibleText(record)) return false;

    const source = String(record.source || "");
    const threadSource = String(record.thread_source || "");

    let changed = false;
    if (Number(record.has_user_event || 0) !== 1 || source !== "vscode" || threadSource !== "user") {
      const statements = [{
        sql: [
          "UPDATE threads SET",
          "  has_user_event = 1,",
          "  source = 'vscode',",
          "  thread_source = 'user'",
          "WHERE id = ?",
          "  AND archived = 0",
          "  AND (preview <> '' OR title <> '')",
          "  AND cwd = ?;",
        ].join("\n"),
        params: [id, record.cwd || ""],
      }];

      if (await sqliteExec(codexStateDbPath, statements)) {
        changed = true;
        log("INFO", "codex app-server thread visibility repaired", {
          threadId: id,
          reason,
          codexHome: CONFIG.codexHome,
          codexStateDbPath,
          workspace: CONFIG.workspace,
          cwd: record.cwd || "",
          previousHasUserEvent: record.has_user_event ?? "",
        });
      }
    }

    const indexChanged = await ensureCodexDesktopSidebarIndexed(id, reason);
    return changed || indexChanged;
  }

  async function verifyAppServerThreadRegistration(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return;

    const record = await loadCodexThreadRecord(id);
    if (!record) {
      log("WARN", "codex thread missing from target Codex home", {
        threadId: id,
        codexHome: CONFIG.codexHome,
        codexStateDbPath,
        workspace: CONFIG.workspace,
      });
      return;
    }

    const rolloutPath = String(record.rollout_path || "");
    log("INFO", "codex thread registered in target Codex home", {
      threadId: id,
      codexHome: CONFIG.codexHome,
      codexStateDbPath,
      workspace: CONFIG.workspace,
      cwd: record.cwd || "",
      rolloutPath,
      rolloutExists: rolloutPath ? fs.existsSync(stripWindowsLongPathPrefix(rolloutPath)) : false,
      archived: record.archived ?? "",
      hasUserEvent: record.has_user_event ?? "",
      previewLength: String(record.preview || "").length,
    });
  }

  function scheduleAppServerThreadMaintenance(threadId, reason, delayMs = 0) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const timer = setTimeout(async () => {
      try {
        await verifyAppServerThreadRegistration(id);
        await ensureAppServerThreadVisible(id, reason);
      } catch (error) {
        log("WARN", "deferred codex app-server thread maintenance failed", {
          threadId: id,
          reason,
          error: String(error?.stack || error),
        });
      }
    }, Math.max(0, Number(delayMs || 0)));
    timer.unref?.();
  }

  async function listVisibleCodexThreadRecordsForBridge() {
    if (!fs.existsSync(codexStateDbPath)) return [];

    const cwd = stripWindowsLongPathPrefix(CONFIG.workspace || "");
    if (!cwd) return [];
    const dbCwd = process.platform === "win32" ? `\\\\?\\${cwd}` : cwd;
    const rows = await sqliteJson(
      codexStateDbPath,
      [
        "select *",
        "from threads",
        "where archived = 0",
        "  and (preview <> '' or title <> '')",
        "  and (cwd = ? or cwd = ?)",
        "order by coalesce(updated_at_ms, created_at_ms, 0) desc, updated_at desc",
        "limit ?;",
      ].join(" "),
      [cwd, dbCwd, Math.max(1, CONFIG.listLimit)],
    );

    const deletedThreadIds = loadDeletedThreadIds(CONFIG.codexHome);
    if (CONFIG.desktopCodexHome) {
      for (const id of loadDeletedThreadIds(CONFIG.desktopCodexHome)) deletedThreadIds.add(id);
    }
    return rows.filter((record) =>
      codexThreadBelongsToThisBridge(record)
      && Number(record.archived || 0) === 0
      && codexThreadHasVisibleText(record)
      && !deletedThreadIds.has(String(record.id || "").trim())
    );
  }

  async function reconcileCodexDesktopSidebarIndexes(reason = "startup") {
    removeDeletedThreadsFromBridgeSessions();
    if (!fs.existsSync(codexStateDbPath)) return false;
    if (sidebarReconcileInFlight) {
      sidebarReconcileQueuedReason = reason;
      return false;
    }

    sidebarReconcileInFlight = true;
    try {
      const records = await listVisibleCodexThreadRecordsForBridge();
      let changed = false;
      for (const record of records) {
        changed = await ensureCodexDesktopSidebarIndexed(record.id, reason) || changed;
      }
      if (changed || reason === "startup") {
        log("INFO", "codex desktop sidebar indexes reconciled", {
          reason,
          codexHome: CONFIG.codexHome,
          workspace: CONFIG.workspace,
          checked: records.length,
          changed,
        });
      }
      return changed;
    } catch (error) {
      log("WARN", "codex desktop sidebar reconcile failed", {
        reason,
        codexHome: CONFIG.codexHome,
        workspace: CONFIG.workspace,
        error: String(error?.stack || error),
      });
      return false;
    } finally {
      sidebarReconcileInFlight = false;
      const queuedReason = sidebarReconcileQueuedReason;
      sidebarReconcileQueuedReason = "";
      if (queuedReason) {
        scheduleSidebarReconcile(`${queuedReason}/queued`, 1000);
      }
    }
  }

  function scheduleSidebarReconcile(reason, delayMs = 500) {
    sidebarReconcilePendingReason = String(reason || "scheduled");
    if (sidebarReconcileTimer) clearTimeout(sidebarReconcileTimer);
    const delay = activeCodexJobs.size > 0
      ? Math.max(5000, Number(delayMs || 0))
      : Math.max(0, Number(delayMs || 0));
    sidebarReconcileTimer = setTimeout(() => {
      sidebarReconcileTimer = null;
      const pendingReason = sidebarReconcilePendingReason || "scheduled";
      sidebarReconcilePendingReason = "";
      if (activeCodexJobs.size > 0) {
        scheduleSidebarReconcile(`${pendingReason}/active-deferred`, 5000);
        return;
      }
      reconcileCodexDesktopSidebarIndexes(pendingReason).catch((error) => {
        log("WARN", "scheduled codex desktop sidebar reconcile failed", {
          reason: pendingReason,
          error: String(error?.stack || error),
        });
      });
    }, delay);
    sidebarReconcileTimer.unref?.();
  }

  async function codexTableSet(dbPath = codexStateDbPath) {
    return querySqliteTableSet(dbPath);
  }

  async function sqliteTableColumns(tableName, dbPath = codexStateDbPath) {
    return querySqliteTableColumns(dbPath, tableName);
  }

  function resolveSafeCodexRolloutPath(rolloutPath, threadId, codexHome = CONFIG.codexHome) {
    const raw = stripWindowsLongPathPrefix(rolloutPath);
    if (!raw || !path.isAbsolute(raw)) throw new Error(`invalid rollout_path: ${rolloutPath || ""}`);

    const sessionsRoot = fs.realpathSync.native(path.join(codexHome, "sessions"));
    const resolved = fs.existsSync(raw) ? fs.realpathSync.native(raw) : path.resolve(raw);
    const relative = path.relative(sessionsRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to delete rollout outside Codex sessions: ${resolved}`);
    }
    if (!path.basename(resolved).includes(threadId)) {
      throw new Error(`refusing to delete rollout without matching thread id: ${resolved}`);
    }
    return resolved;
  }

  function findRolloutFilesForThread(threadId, codexHome = CONFIG.codexHome) {
    const id = String(threadId || "").trim();
    if (!id) return [];
    return listRolloutFiles(codexHome).filter((filePath) => path.basename(filePath).includes(id));
  }

  async function deleteCodexThreadRowsFromDb(threadId, dbPath = codexStateDbPath) {
    deleteCodexThreadRows(dbPath, threadId);
  }

  async function deleteCodexThreadFromHome(threadId, codexHome) {
    const id = String(threadId || "").trim();
    const paths = codexHomeResourcePaths(codexHome);
    const result = {
      codexHome: paths.codexHome,
      title: "",
      dbChanged: false,
      rolloutDeleted: false,
      rolloutPaths: [],
      sessionIndexChanged: false,
      globalStateChanged: false,
    };

    await withCodexSidebarLock(async () => {
      let record = null;
      if (fs.existsSync(paths.stateDbPath)) {
        record = await loadCodexThreadRecordFromDb(id, paths.stateDbPath);
        if (record) {
          result.title = record.title || "";
          await deleteCodexThreadRowsFromDb(id, paths.stateDbPath);
          const afterDelete = await loadCodexThreadRecordFromDb(id, paths.stateDbPath);
          if (afterDelete) throw new Error(`Thread delete did not remove local row from ${paths.stateDbPath}: ${id}`);
          result.dbChanged = true;
        }
      }

      const rolloutCandidates = Array.from(new Set([
        record?.rollout_path || "",
        ...findRolloutFilesForThread(id, paths.codexHome),
      ].filter(Boolean)));
      for (const candidate of rolloutCandidates) {
        const safePath = resolveSafeCodexRolloutPath(candidate, id, paths.codexHome);
        if (!fs.existsSync(safePath)) continue;
        fs.rmSync(safePath, { force: true });
        if (fs.existsSync(safePath)) throw new Error(`Rollout still exists after delete: ${safePath}`);
        result.rolloutDeleted = true;
        result.rolloutPaths.push(safePath);
      }

      result.sessionIndexChanged = removeCodexSessionIndexEntry(id, paths.sessionIndexPath);
      result.globalStateChanged = removeCodexGlobalStateThread(id, paths.globalStatePath);
    }, paths.codexHome, paths.sidebarLockPath);

    return result;
  }

  async function deleteCodexThreadFromHomeWithRetry(threadId, codexHome) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await deleteCodexThreadFromHome(threadId, codexHome);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(attempt * 250);
      }
    }
    throw lastError;
  }

  async function inspectCodexThreadResidue(threadId, codexHome) {
    const id = String(threadId || "").trim();
    const paths = codexHomeResourcePaths(codexHome);
    const dbRecord = fs.existsSync(paths.stateDbPath)
      ? await loadCodexThreadRecordFromDb(id, paths.stateDbPath)
      : null;
    const rolloutPaths = findRolloutFilesForThread(id, paths.codexHome);
    return {
      codexHome: paths.codexHome,
      db: Boolean(dbRecord),
      rolloutPaths,
      sessionIndex: hasCodexSessionIndexEntry(id, paths.sessionIndexPath),
      globalState: loadGlobalStateThreadEntries(paths.globalStatePath).some((entry) => entry.id === id),
    };
  }

  function codexThreadResidueExists(residue) {
    return Boolean(
      residue?.db
      || residue?.rolloutPaths?.length
      || residue?.sessionIndex
      || residue?.globalState
    );
  }

  async function deleteCodexLocalThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("thread id is required");

    const homes = [path.resolve(CONFIG.codexHome)];
    if (shouldMirrorDesktopCodexHome && CONFIG.desktopCodexHome) {
      const desktopHome = path.resolve(CONFIG.desktopCodexHome);
      if (!sameResolvedPath(desktopHome, homes[0])) homes.push(desktopHome);
    }
    await markCodexThreadDeletedAcrossHomes(id, homes);

    const homeResults = [];
    const failures = [];
    for (const codexHome of homes) {
      try {
        homeResults.push(await deleteCodexThreadFromHomeWithRetry(id, codexHome));
      } catch (error) {
        failures.push({ codexHome, error: String(error?.message || error) });
      }
    }

    const residues = [];
    for (const codexHome of homes) {
      try {
        const residue = await inspectCodexThreadResidue(id, codexHome);
        if (codexThreadResidueExists(residue)) residues.push(residue);
      } catch (error) {
        failures.push({ codexHome, error: `verification failed: ${String(error?.message || error)}` });
      }
    }
    if (failures.length || residues.length) {
      throw new Error(`Codex Home thread delete incomplete: ${safeJson({ threadId: id, failures, residues })}`);
    }

    const firstWithTitle = homeResults.find((item) => item.title);
    const desktopResult = homes.length > 1 ? homeResults[1] : null;
    return {
      threadId: id,
      title: firstWithTitle?.title || "",
      dbChanged: homeResults.some((item) => item.dbChanged),
      rolloutPath: homeResults.flatMap((item) => item.rolloutPaths)[0] || "",
      rolloutDeleted: homeResults.some((item) => item.rolloutDeleted),
      rolloutMissing: false,
      rolloutError: "",
      sidebarIndexChanged: homeResults.some((item) => item.sessionIndexChanged),
      globalStateChanged: homeResults.some((item) => item.globalStateChanged),
      sidebarIndexError: "",
      desktopMirror: desktopResult
        ? {
            enabled: true,
            dbChanged: Boolean(desktopResult.dbChanged),
            sessionIndexChanged: Boolean(desktopResult.sessionIndexChanged),
            globalStateChanged: Boolean(desktopResult.globalStateChanged),
            rolloutDeleted: Boolean(desktopResult.rolloutDeleted),
            rolloutMissing: !desktopResult.rolloutDeleted && !desktopResult.rolloutPaths?.length,
            rolloutPath: desktopResult.rolloutPaths?.[0] || "",
          }
        : { enabled: Boolean(CONFIG.desktopCodexHome) },
      codexHomesChecked: homes,
      homeResults,
    };
  }

  async function findCodexThreadIdForPrompt(promptFile, stdoutRaw) {
    const direct = extractCodexThreadId(stdoutRaw);
    if (direct) return direct;
    if (!promptFile || !fs.existsSync(codexStateDbPath)) return "";
    const rows = await sqliteJson(
      codexStateDbPath,
      "select id from threads where title like ? order by updated_at_ms desc limit 1;",
      [`%${promptFile}%`],
    );
    return rows[0]?.id || "";
  }

  function shouldReplacePromptText(text, promptFile) {
    if (typeof text !== "string") return false;
    if (promptFile && text.includes(promptFile)) return true;
    return text.startsWith("读取这个 UTF-8 任务文件");
  }

  async function patchCodexRolloutForSidebar(threadId, promptFile, title) {
    if (!threadId || !fs.existsSync(codexStateDbPath)) return false;
    const rows = await sqliteJson(
      codexStateDbPath,
      "select rollout_path from threads where id = ? limit 1;",
      [String(threadId)],
    );
    const rolloutPath = rows[0]?.rollout_path;
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;

    const original = fs.readFileSync(rolloutPath, "utf8");
    const hasTrailingNewline = original.endsWith("\n");
    const normalized = original.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (hasTrailingNewline && lines.at(-1) === "") lines.pop();

    let changed = false;
    const patchedLines = lines.map((line) => {
      if (!line.trim()) return line;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }

      let lineChanged = false;
      if (parsed?.type === "session_meta" && parsed.payload?.id === threadId) {
        if (parsed.payload.source !== "vscode") {
          parsed.payload.source = "vscode";
          lineChanged = true;
        }
        if (parsed.payload.thread_source !== "user") {
          parsed.payload.thread_source = "user";
          lineChanged = true;
        }
      }

      if (parsed?.type === "response_item" && parsed.payload?.type === "message" && parsed.payload?.role === "user") {
        const content = parsed.payload.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === "input_text" && shouldReplacePromptText(part.text, promptFile)) {
              part.text = title;
              lineChanged = true;
            }
          }
        }
      }

      if (parsed?.type === "event_msg" && parsed.payload?.type === "user_message") {
        if (shouldReplacePromptText(parsed.payload.message, promptFile)) {
          parsed.payload.message = title;
          lineChanged = true;
        }
      }

      if (!lineChanged) return line;
      changed = true;
      return JSON.stringify(parsed);
    });

    if (changed) {
      fs.writeFileSync(rolloutPath, `${patchedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}`, "utf8");
    }
    return changed;
  }

  async function syncCodexSidebarThread({ event, session, promptFile, outFile, stdoutRaw }) {
    const threadId = await findCodexThreadIdForPrompt(promptFile, stdoutRaw);
    if (!threadId) {
      log("WARN", "sidebar sync skipped; codex thread not found", { messageId: event.message_id || event.id, sessionId: session.id, promptFile });
      return;
    }

    if (!CONFIG.syncSidebar) {
      await ensureAppServerThreadVisible(threadId, "exec/completed");
      return;
    }

    const title = feishuSidebarTitle(event, session);
    const firstUserMessage = userTextFromContent(event.content) || title;
    const preview = [
      `feishuSession=${session.id}`,
      `messageId=${event.message_id || event.id || ""}`,
      `prompt=${promptFile}`,
      `output=${outFile}`,
    ].join(" | ");

    const statements = [{
      sql: [
        "UPDATE threads SET",
        "  title = ?,",
        "  first_user_message = ?,",
        "  preview = ?,",
        "  source = 'vscode',",
        "  thread_source = 'user'",
        "WHERE id = ?;",
      ].join("\n"),
      params: [title, firstUserMessage, preview, threadId],
    }];

    if (await sqliteExec(codexStateDbPath, statements)) {
      log("INFO", "sidebar thread synced", { threadId, sessionId: session.id, title, promptFile });
    } else {
      log("WARN", "sidebar sync failed", { threadId, sessionId: session.id, promptFile });
    }

    try {
      const patchedRollout = await patchCodexRolloutForSidebar(threadId, promptFile, title);
      log("INFO", "sidebar rollout patch checked", { threadId, sessionId: session.id, patchedRollout });
    } catch (error) {
      log("WARN", "sidebar rollout patch failed", { threadId, sessionId: session.id, error: String(error?.stack || error) });
    }
    await ensureAppServerThreadVisible(threadId, "exec/completed");
  }

  return {
    replaceWindowsLongPathPrefix,
    normalizeSpaces,
    shorten,
    feishuSidebarTitle,
    extractCodexThreadId,
    sqliteJson,
    sqliteExec,
    sqliteExecChecked,
    loadCodexThreadRecord,
    loadCodexThreadRecordFromDb,
    updateCodexThreadTitleInDb,
    codexThreadBelongsToThisBridge,
    codexThreadHasVisibleText,
    codexThreadTitleForIndex,
    codexThreadUpdatedIso,
    codexWorkspaceRootHint,
    withCodexSidebarLock,
    registeredCodexHomeRegistry,
    codexHomeResourcePaths,
    loadDeletedThreadIds,
    isCodexThreadDeleted,
    isCodexThreadDeletedForBridge,
    writeCodexThreadTombstone,
    markCodexThreadDeletedAcrossHomes,
    readCodexSessionIndexTitle,
    syncCodexSessionIndex,
    hasCodexSessionIndexEntry,
    removeCodexSessionIndexEntry,
    syncCodexGlobalState,
    removeCodexGlobalStateThread,
    mirrorCodexThreadRecordToDesktopHome,
    mirrorCodexRolloutToDesktopHome,
    mirrorCodexDesktopSidebarIndexed,
    ensureCodexDesktopSidebarIndexed,
    ensureAppServerThreadVisible,
    verifyAppServerThreadRegistration,
    scheduleAppServerThreadMaintenance,
    listVisibleCodexThreadRecordsForBridge,
    reconcileCodexDesktopSidebarIndexes,
    scheduleSidebarReconcile,
    codexTableSet,
    sqliteTableColumns,
    resolveSafeCodexRolloutPath,
    findRolloutFilesForThread,
    deleteCodexThreadRowsFromDb,
    deleteCodexThreadFromHome,
    deleteCodexThreadFromHomeWithRetry,
    inspectCodexThreadResidue,
    codexThreadResidueExists,
    deleteCodexLocalThread,
    findCodexThreadIdForPrompt,
    shouldReplacePromptText,
    patchCodexRolloutForSidebar,
    syncCodexSidebarThread,
  };
}
