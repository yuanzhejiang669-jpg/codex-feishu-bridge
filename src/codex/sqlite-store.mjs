import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

function openDb(dbPath, { readOnly = false } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec("PRAGMA busy_timeout = 10000;");
  return db;
}

function normalizeCellValue(value) {
  if (value instanceof Uint8Array) {
    try {
      return Buffer.from(value).toString("utf8");
    } catch {
      return Buffer.from(value).toString("hex");
    }
  }
  return value;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeCellValue(value);
  }
  return out;
}

function quoteIdentifier(name) {
  return `"${String(name || "").replace(/"/g, "\"\"")}"`;
}

export function sqliteQueryAll(dbPath, sql, params = []) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const db = openDb(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(sql);
    return stmt.all(...params).map(normalizeRow);
  } finally {
    db.close();
  }
}

export function sqliteExecTransaction(dbPath, statementsWithParams = []) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`SQLite database not found: ${dbPath}`);
  }
  const db = openDb(dbPath, { readOnly: false });
  let inTx = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    inTx = true;
    const results = [];
    for (const item of statementsWithParams) {
      const sql = typeof item === "string" ? item : item?.sql;
      const params = Array.isArray(item?.params) ? item.params : [];
      if (!sql || !String(sql).trim()) continue;
      if (params.length) {
        results.push(db.prepare(sql).run(...params));
      } else {
        results.push(db.prepare(sql).run());
      }
    }
    db.exec("COMMIT;");
    inTx = false;
    return results;
  } catch (error) {
    if (inTx) {
      try { db.exec("ROLLBACK;"); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}

export function sqliteTableSet(dbPath) {
  const rows = sqliteQueryAll(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table';");
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

export function sqliteTableColumns(dbPath, tableName) {
  const safeName = quoteIdentifier(tableName);
  const rows = sqliteQueryAll(dbPath, `PRAGMA table_info(${safeName});`);
  return new Set(rows.map((row) => String(row.name || "")).filter(Boolean));
}

export function upsertCodexThreadRow(dbPath, record) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`SQLite database not found: ${dbPath}`);
  }
  const tableColumns = sqliteTableColumns(dbPath, "threads");
  let columns;
  let values;
  if (Array.isArray(record?.columns) && Array.isArray(record?.values)) {
    columns = [];
    values = [];
    for (let i = 0; i < record.columns.length; i += 1) {
      const col = String(record.columns[i] || "");
      if (!tableColumns.has(col)) continue;
      columns.push(col);
      values.push(record.values[i] ?? null);
    }
  } else if (record && typeof record === "object") {
    columns = Object.keys(record).filter((col) => tableColumns.has(col));
    values = columns.map((col) => record[col] ?? null);
  } else {
    throw new Error("Invalid thread record for upsert");
  }

  if (!columns.length || !columns.includes("id")) {
    throw new Error("invalid columns: id column is required for threads upsert");
  }

  const safeValues = values.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value ?? null;
  });

  const quotedCols = columns.map(quoteIdentifier);
  const placeholders = columns.map(() => "?").join(", ");
  const updates = quotedCols
    .filter((name) => name !== '"id"')
    .map((name) => `${name} = excluded.${name}`)
    .join(", ");
  const sql = updates
    ? `INSERT INTO threads (${quotedCols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`
    : `INSERT INTO threads (${quotedCols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`;

  sqliteExecTransaction(dbPath, [{ sql, params: safeValues }]);
}

export function deleteCodexThreadRows(dbPath, threadId) {
  const id = String(threadId || "").trim();
  if (!id) throw new Error("thread id is required");
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`Codex state database not found: ${dbPath}`);
  }

  const db = openDb(dbPath, { readOnly: false });
  let inTx = false;
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table';").all()
        .map((row) => String(row.name || ""))
        .filter(Boolean),
    );
    if (!tables.has("threads")) {
      throw new Error("Unsupported local storage schema: missing threads table");
    }

    const columnsOf = (tableName) => new Set(
      db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)});`).all()
        .map((row) => String(row.name || ""))
        .filter(Boolean),
    );

    const statements = [];
    const addByThreadIdIfPossible = (tableName) => {
      if (!tables.has(tableName)) return;
      const cols = columnsOf(tableName);
      if (cols.has("thread_id")) {
        statements.push({ sql: `DELETE FROM ${quoteIdentifier(tableName)} WHERE thread_id = ?`, params: [id] });
      } else if (cols.has("id")) {
        statements.push({ sql: `DELETE FROM ${quoteIdentifier(tableName)} WHERE id = ?`, params: [id] });
      }
    };

    if (tables.has("thread_dynamic_tools")) {
      statements.push({ sql: 'DELETE FROM "thread_dynamic_tools" WHERE thread_id = ?', params: [id] });
    }
    addByThreadIdIfPossible("thread_goals");
    addByThreadIdIfPossible("thread_goal");
    if (tables.has("thread_spawn_edges")) {
      statements.push({
        sql: 'DELETE FROM "thread_spawn_edges" WHERE parent_thread_id = ? OR child_thread_id = ?',
        params: [id, id],
      });
    }
    addByThreadIdIfPossible("stage1_outputs");
    if (tables.has("agent_job_items")) {
      statements.push({
        sql: 'UPDATE "agent_job_items" SET assigned_thread_id = NULL WHERE assigned_thread_id = ?',
        params: [id],
      });
    }
    if (tables.has("messages")) {
      statements.push({ sql: 'DELETE FROM "messages" WHERE session_id = ?', params: [id] });
    }
    if (tables.has("sessions")) {
      statements.push({ sql: 'DELETE FROM "sessions" WHERE id = ?', params: [id] });
    }
    statements.push({ sql: 'DELETE FROM "threads" WHERE id = ?', params: [id] });

    db.exec("BEGIN IMMEDIATE;");
    inTx = true;
    for (const stmt of statements) {
      db.prepare(stmt.sql).run(...stmt.params);
    }
    db.exec("COMMIT;");
    inTx = false;
  } catch (error) {
    if (inTx) {
      try { db.exec("ROLLBACK;"); } catch {}
    }
    throw error;
  } finally {
    db.close();
  }
}
