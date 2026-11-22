const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function writeJsonFileAtomicSync(file, value) { const temp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }

function lockDirectory(directory, owner, waitMs = 0) {
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true });
  const prefix = `${path.basename(directory)}.recovery-`;
  function age() {
    try { return Date.now() - fs.statSync(directory).mtimeMs; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  }
  function recovering() {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(prefix.length);
      if (!/^\d+-[a-f0-9-]{36}$/i.test(suffix)) continue;
      if (alive(Number(suffix.split('-')[0]))) return true;
      try { fs.unlinkSync(path.join(parent, entry.name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
  }
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (recovering()) {
      if (Date.now() >= deadline) throw new Error('共享会话正在恢复异常进程留下的锁，请稍后重试。');
      Atomics.wait(sleepBuffer, 0, 0, 20); continue;
    }
    try {
      fs.mkdirSync(directory);
      writeJsonFileAtomicSync(path.join(directory, 'owner.json'), { ...owner, pid: process.pid, token, at: Date.now() });
      // A stale-lock recovery may have started between the first check and
      // mkdir. Never enter protected work until recovery is over and we still
      // own the exact lock directory.
      if (recovering() || read(path.join(directory, 'owner.json'), null)?.token !== token) {
        if (read(path.join(directory, 'owner.json'), null)?.token === token) fs.rmSync(directory, { recursive: true, force: true });
        continue;
      }
      return () => {
        if (read(path.join(directory, 'owner.json'), null)?.token === token) fs.rmSync(directory, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'EEXIST') throw error;
      const previous = read(path.join(directory, 'owner.json'), null);
      const abandoned = previous ? !alive(previous.pid) : age() > 5_000;
      if (abandoned) {
        const marker = path.join(parent, `${prefix}${process.pid}-${crypto.randomUUID()}`);
        fs.writeFileSync(marker, '', { flag: 'wx' });
        try {
          const latest = read(path.join(directory, 'owner.json'), null);
          const unchanged = previous ? latest?.token === previous.token && latest?.pid === previous.pid
            : !latest && age() > 5_000;
          if (unchanged && (!latest || !alive(latest.pid))) fs.rmSync(directory, { recursive: true, force: true });
        } finally { fs.unlinkSync(marker); }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`共享会话正在 ${previous?.bot || '其他进程'} 中${previous?.purpose === 'delete' ? '删除' : '使用'}，请等待本轮结束后重试。`);
      Atomics.wait(sleepBuffer, 0, 0, 20);
    }
  }
}
module.exports = { lockDirectory };
