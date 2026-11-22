const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function alive(pid) { if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false; try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function assertLoginClosed(root) {
  const file = path.join(root, 'antigravity-login-session.json');
  let login; try { login = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (alive(login.pid)) throw new Error('官方账号登录窗口仍在使用，请关闭窗口后再使用 Bot 或保存账号');
  fs.rmSync(file, { force: true });
}
function withAccountMutex(root, operation) {
  const release = require('../sessions/native-lock.cjs').lockDirectory(path.join(root, 'antigravity-login.lock'), { purpose: 'account' }, 2000);
  try { return operation(); } finally { release(); }
}

function liveLeases(root) {
  const directory = path.join(root, 'antigravity-account-usage');
  let files; try { files = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const full = path.join(directory, file); let lease;
    try { lease = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { throw new Error('无法核对 Antigravity 活动账号，已拒绝切换'); }
    if (alive(lease.pid)) results.push(lease); else fs.rmSync(full, { force: true });
  }
  return results;
}
function acquireOfficialLease(root, provider) {
  if (provider.mode !== 'official') return () => {};
  let file;
  withAccountMutex(root, () => {
    assertLoginClosed(root);
    require('./configuration.cjs').assertOfficialAccount(root, provider);
    const directory = path.join(root, 'antigravity-account-usage'); fs.mkdirSync(directory, { recursive: true });
    file = path.join(directory, `${process.pid}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, accountId: provider.accountId || 'current', at: Date.now() }), { flag: 'wx', mode: 0o600 });
  });
  return () => fs.rmSync(file, { force: true });
}
module.exports = { withAccountMutex, liveLeases, acquireOfficialLease, assertLoginClosed };
