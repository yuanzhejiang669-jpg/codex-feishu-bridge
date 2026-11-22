import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeBridge } from '../src/claude/bridge-runner.mjs';
import { createClaudeSessionDeletion } from '../src/claude/session-deletion.mjs';
import { createSessionStore } from '../src/sessions/store.mjs';

function fixture(t, count = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-claude-delete-'));
  const home = path.join(root, 'home');
  const project = path.join(home, 'projects', 'workspace');
  const stateDir = path.join(root, 'state');
  const workspaceFile = path.join(root, 'workspace', 'keep.txt');
  for (const dir of [project, stateDir, path.dirname(workspaceFile)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(workspaceFile, 'user work');
  const sessionsPath = path.join(stateDir, 'sessions.json');
  const sessions = Array.from({ length: count }, (_, i) => ({ id: `s-${i + 1}`, title: `Session ${i + 1}`,
    engine: 'claude', claudeSessionId: crypto.randomUUID() }));
  const chats = { chat: { currentSessionId: sessions[0].id, sessions } };
  const files = sessions.map((session) => {
    const file = path.join(project, `${session.claudeSessionId}.jsonl`);
    fs.writeFileSync(file, `transcript ${session.id}`); return file;
  });
  const activeJobs = new Map(); const replies = []; let clock = 1000;
  const config = { claudeHome: home, stateDir, deleteConfirmTtlMs: 100 };
  const saveSessions = () => fs.writeFileSync(sessionsPath, JSON.stringify({ chats }));
  saveSessions();
  const options = { config, getChatState: (id) => chats[id], getChats: () => chats, saveSessions, activeJobs };
  const deletion = createClaudeSessionDeletion({ ...options, now: () => clock });
  const event = { chat_id: 'chat', sender_id: 'user', message_id: 'message' };
  const send = async (name, rest = '', override = {}) => {
    const handled = await deletion.handle({ ...event, ...override }, { name, rest }, async (text) => replies.push(text));
    return { handled, text: replies.at(-1) };
  };
  t.after(() => {
    deletion.close();
    if (process.env.CFB_TEST_FILE_AUDIT) {
      const audit = [];
      function visit(dir) {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, item.name);
          if (item.isDirectory() && !item.isSymbolicLink()) visit(file); else audit.push(file);
        }
      }
      visit(root);
      fs.appendFileSync(process.env.CFB_TEST_FILE_AUDIT, JSON.stringify({ temporaryRoot: root,
        filesBeforeCleanup: audit, fixtureTranscripts: files, cleanedUp: true }) + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, project, stateDir, workspaceFile, sessionsPath, sessions, chats, activeJobs,
    config, options, event, deletion, files, send, replies, setClock: (value) => { clock = value; } };
}

test('Claude delete preview is read-only and confirmation deletes exact native records and bindings', async (t) => {
  const f = fixture(t, 12);
  const native = f.sessions[1].claudeSessionId;
  const data = path.join(f.project, native, 'subagents');
  const environment = path.join(f.home, 'session-env', native);
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(environment, { recursive: true });
  fs.writeFileSync(path.join(data, 'agent.jsonl'), 'subagent');
  fs.writeFileSync(path.join(environment, 'state'), 'environment');
  const before = fs.readFileSync(f.sessionsPath, 'utf8');
  f.deletion.rememberList(f.event, f.sessions);
  assert.match((await f.send('/delete', '2-9')).text, /待删除：8 条/);
  assert.equal(fs.readFileSync(f.sessionsPath, 'utf8'), before);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
  // Reordering after preview must not change which sessions will be deleted.
  f.chats.chat.sessions.reverse();
  assert.match((await f.send('/confirm', 'delete 2-9')).text, /已删除 8 条/);
  assert.deepEqual(f.chats.chat.sessions.map((item) => item.id).sort(), ['s-1', 's-10', 's-11', 's-12']);
  assert.ok(fs.existsSync(f.files[0]));
  assert.ok(f.files.slice(1, 9).every((file) => !fs.existsSync(file)));
  assert.equal(fs.existsSync(path.dirname(data)), false);
  assert.equal(fs.existsSync(environment), false);
  assert.equal(fs.readFileSync(f.workspaceFile, 'utf8'), 'user work');
  assert.equal(JSON.parse(fs.readFileSync(f.sessionsPath)).chats.chat.sessions.length, 4);
  assert.match((await f.send('/confirm', 'delete 2-9')).text, /不存在/);
});

test('Claude delete uses the displayed list snapshot and accepts IDs, aliases and deduplicated ranges', async (t) => {
  const f = fixture(t);
  f.deletion.rememberList(f.event, f.sessions);
  f.chats.chat.sessions.reverse();
  await f.send('/del', '1 1,2-2');
  assert.match(f.replies.at(-1), /待删除：2 条/);
  await f.send('/confirm', 'delete 1-2');
  assert.equal(fs.existsSync(f.files[0]), false); assert.equal(fs.existsSync(f.files[1]), false);
  await f.send('/rm', f.sessions[0].claudeSessionId);
  assert.match(f.replies.at(-1), /Claude 会话删除确认/);
  const index = f.chats.chat.sessions.findIndex((item) => item.claudeSessionId === f.sessions[0].claudeSessionId) + 1;
  await f.send('/confirm', `delete ${index}`);
  assert.equal(f.chats.chat.sessions.length, 1);
  await f.send('/delete', f.chats.chat.sessions[0].id);
  assert.match(f.replies.at(-1), /Claude 会话删除确认/);
});

test('Claude deletion confirmation is bound to the sender, chat, selection, TTL and native identity', async (t) => {
  const f = fixture(t);
  f.chats.other = { currentSessionId: '', sessions: [] };
  await f.send('/delete', '1');
  assert.match((await f.send('/confirm', 'delete 1', { sender_id: 'other' })).text, /不存在/);
  assert.match((await f.send('/confirm', 'delete 1', { chat_id: 'other' })).text, /不存在/);
  assert.match((await f.send('/confirm', 'delete 2')).text, /不一致/);
  f.setClock(1101);
  assert.match((await f.send('/confirm', 'delete 1')).text, /已过期/);
  await f.send('/delete', '1');
  f.sessions[0].claudeSessionId = crypto.randomUUID();
  assert.match((await f.send('/confirm', 'delete 1')).text, /绑定已变化/);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
});

test('Claude deletion rejects running sessions at preview and confirm, including persisted pre-start runs', async (t) => {
  const f = fixture(t);
  f.activeJobs.set('chat', { sessionId: 's-1' });
  assert.match((await f.send('/delete', '1 2')).text, /正在运行/);
  f.activeJobs.clear(); await f.send('/delete', '1 2');
  fs.writeFileSync(path.join(f.stateDir, 'active-runs.json'), JSON.stringify({ runs: { message: { sessionId: 's-2' } } }));
  assert.match((await f.send('/confirm', 'delete 1 2')).text, /正在运行/);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
  assert.equal(f.chats.chat.sessions.length, 4);
  fs.writeFileSync(path.join(f.stateDir, 'active-runs.json'), '{broken');
  await f.send('/delete', '1');
  assert.ok(f.files.every((file) => fs.existsSync(file)));
  assert.doesNotMatch(f.replies.at(-1), /确认删除请输入/);
});

test('Claude deletion rejects shared native identities and sessions belonging to another engine', async (t) => {
  const f = fixture(t);
  f.chats.other = { sessions: [{ ...f.sessions[0], id: 'other-binding' }] };
  assert.match((await f.send('/delete', '1')).text, /其他会话绑定/);
  delete f.chats.other;
  f.sessions[0].engine = 'codex';
  assert.match((await f.send('/delete', '1')).text, /不属于 Claude/);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
});

test('Claude deletion rejects invalid selections and cannot reuse an older preview after another delete request', async (t) => {
  const f = fixture(t);
  for (const rest of ['0', '9', '3-1', '1 s-2', '1-999999999999999', '../../outside']) {
    assert.doesNotMatch((await f.send('/delete', rest)).text, /确认删除请输入/);
  }
  await f.send('/delete', '1'); await f.send('/delete', 'unknown');
  assert.match((await f.send('/confirm', 'delete 1')).text, /不存在/);
  assert.match((await f.send('/delete', '')).text, /用法/);
  assert.match((await f.send('/confirm', 'something')).text, /用法/);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
});

test('Claude deletion removes empty bindings, keeps a valid current session, and handles missing native records', async (t) => {
  const f = fixture(t);
  f.sessions[0].claudeSessionId = '';
  fs.unlinkSync(f.files[1]);
  await f.send('/delete', '1 2'); await f.send('/confirm', 'delete 1-2');
  assert.equal(f.chats.chat.currentSessionId, 's-3');
  await f.send('/delete', '1-2'); await f.send('/confirm', 'delete 1-2');
  assert.equal(f.chats.chat.sessions.length, 0);
  assert.equal(f.chats.chat.currentSessionId, '');
});

test('Claude deletion refuses escaped UUIDs and linked native directories without affecting targets', async (t) => {
  const f = fixture(t);
  const oldNative = f.sessions[0].claudeSessionId;
  f.sessions[0].claudeSessionId = '../../workspace';
  assert.match((await f.send('/delete', '1')).text, /ID 无效/);
  f.sessions[0].claudeSessionId = oldNative;
  const link = path.join(f.project, oldNative);
  fs.symlinkSync(path.dirname(f.workspaceFile), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.send('/delete', '1')).text, /包含链接/);
  assert.ok(fs.existsSync(f.files[0]));
  assert.equal(fs.readFileSync(f.workspaceFile, 'utf8'), 'user work');
  fs.unlinkSync(link);
  const parentLink = path.join(f.home, 'session-env');
  fs.mkdirSync(path.join(f.root, 'workspace', oldNative));
  fs.symlinkSync(path.dirname(f.workspaceFile), parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.send('/delete', '1')).text, /包含链接/);
  assert.ok(fs.existsSync(f.files[0]));
});

test('Claude deletion rechecks path changes on confirmation before deleting any selected transcript', async (t) => {
  const f = fixture(t);
  await f.send('/delete', '1 2');
  fs.symlinkSync(path.dirname(f.workspaceFile), path.join(f.project, f.sessions[1].claudeSessionId),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await f.send('/confirm', 'delete 1-2')).text, /包含链接/);
  assert.ok(f.files.every((file) => fs.existsSync(file)));
  assert.equal(f.chats.chat.sessions.length, 4);
});

test('Claude Bridge exposes delete help/list controls and creates a fresh session after deleting all bindings', async (t) => {
  const f = fixture(t, 2);
  let nextId = 0;
  const store = createSessionStore({ sessionsPath: f.sessionsPath, preserveSessionIdentity: true,
    createSessionData: (title) => ({ id: `new-${++nextId}`, title, engine: 'claude', claudeSessionId: '' }),
    normalizeSessionData: (item) => ({ ...item }), dedupeSessions: (items) => items, sessionListLimit: () => 100 });
  const replies = [];
  const bridge = createClaudeBridge({ config: f.config, ...store, getChats: () => store.sessions.chats,
    activeJobs: f.activeJobs, sendMarkdown: async (_chat, text) => replies.push(text) });
  t.after(() => bridge.close());
  const command = (name, rest = '') => bridge.handleCommand(f.event, { name, rest });
  await command('/help'); assert.match(replies.at(-1), /\/delete 序号或ID/);
  await command('/list'); assert.match(replies.at(-1), /\/confirm delete/);
  await command('/delete', '1 2'); assert.match(replies.at(-1), /待删除：2 条/);
  assert.equal(store.sessions.chats.chat.sessions.length, 2);
  await command('/confirm', 'delete 1 2'); assert.match(replies.at(-1), /已删除 2 条/);
  assert.equal(store.sessions.chats.chat.sessions.length, 0);
  const fresh = store.getSession('chat');
  assert.match(fresh.id, /^new-/); assert.equal(fresh.claudeSessionId, '');
  assert.equal(JSON.parse(fs.readFileSync(f.sessionsPath)).chats.chat.currentSessionId, fresh.id);
});
