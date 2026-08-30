const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const RELEASES_URL = "https://api.github.com/repos/yuanzhejiang669-jpg/codex-feishu-bridge/releases?per_page=30";
const LINUX_ASSET_PATTERN = /^Codex-Feishu-Bridge-(.+)-linux-amd64\.deb$/;

function parseDesktopVersion(value) {
  const match = String(value || "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-linux\.(\d+))?$/);
  if (!match) return null;
  return {
    raw: match[0],
    parts: match.slice(1, 4).map(Number),
    linuxRevision: match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]),
  };
}

function compareDesktopVersions(left, right) {
  const a = parseDesktopVersion(left);
  const b = parseDesktopVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.parts.length; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.linuxRevision === b.linuxRevision) return 0;
  return a.linuxRevision > b.linuxRevision ? 1 : -1;
}

function releaseCandidates(releases) {
  const values = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const checksum = assets.find((asset) => asset?.name === "checksums-linux.txt");
    if (!checksum?.browser_download_url) continue;
    for (const asset of assets) {
      const match = String(asset?.name || "").match(LINUX_ASSET_PATTERN);
      if (!match || !asset?.browser_download_url || !parseDesktopVersion(match[1])) continue;
      values.push({
        version: match[1],
        releaseNotes: String(release.body || ""),
        packageAsset: asset,
        checksumAsset: checksum,
      });
    }
  }
  return values.sort((a, b) => compareDesktopVersions(b.version, a.version) || 0);
}

function selectLinuxRelease(releases, currentVersion) {
  return releaseCandidates(releases).find((candidate) => compareDesktopVersions(candidate.version, currentVersion) === 1) || null;
}

function parseExpectedChecksum(text, assetName) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`Linux 更新校验文件未包含 ${assetName}`);
}

function githubAssetDigest(asset) {
  const match = String(asset?.digest || "").match(/^sha256:([a-fA-F0-9]{64})$/);
  return match ? match[1].toLowerCase() : "";
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function responseError(response, label) {
  return new Error(`${label}失败：HTTP ${response?.status || "unknown"}`);
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Codex-Feishu-Bridge-Linux-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw responseError(response, "查询 GitHub Release");
  return response.json();
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Codex-Feishu-Bridge-Linux-Updater" },
  });
  if (!response.ok) throw responseError(response, "下载 Linux 校验文件");
  return response.text();
}

async function downloadFile(fetchImpl, url, destination, onProgress, timeoutMs) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Codex-Feishu-Bridge-Linux-Updater" },
  });
  if (!response.ok || !response.body) throw responseError(response, "下载 Ubuntu 安装包");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  const total = Number(response.headers?.get?.("content-length") || 0);
  let transferred = 0;
  const source = Readable.fromWeb(response.body);
  source.on("data", (chunk) => {
    transferred += chunk.length;
    if (total > 0) onProgress?.((transferred / total) * 100);
  });
  try {
    await pipeline(source, fs.createWriteStream(temporary, { flags: "wx" }));
    fs.rmSync(destination, { force: true });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function safeAssetName(name) {
  const value = path.basename(String(name || ""));
  if (!LINUX_ASSET_PATTERN.test(value)) throw new Error("Linux 更新包名称无效");
  return value;
}

function pruneVersionCache(cacheRoot, keepVersion) {
  if (!fs.existsSync(cacheRoot)) return;
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== keepVersion && parseDesktopVersion(entry.name)) {
      fs.rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
    }
  }
}

class LinuxReleaseUpdater extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentVersion = String(options.currentVersion || "");
    this.cacheRoot = path.resolve(String(options.cacheRoot || ""));
    this.helperPath = path.resolve(String(options.helperPath || ""));
    this.executablePath = path.resolve(String(options.executablePath || ""));
    this.logPath = path.resolve(String(options.logPath || path.join(this.cacheRoot, "install.log")));
    this.fetch = options.fetch || globalThis.fetch;
    this.spawn = options.spawn || spawn;
    this.quit = options.quit || (() => {});
    this.releasesUrl = options.releasesUrl || RELEASES_URL;
    this.metadataTimeoutMs = Math.max(1_000, Number(options.metadataTimeoutMs || 20_000));
    this.downloadTimeoutMs = Math.max(60_000, Number(options.downloadTimeoutMs || 30 * 60_000));
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = true;
    this.downloaded = null;
    this.checkPromise = null;
  }

  async checkForUpdates() {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.#check().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async #check() {
    this.emit("checking-for-update");
    try {
      const releases = await fetchJson(this.fetch, this.releasesUrl, this.metadataTimeoutMs);
      const candidate = selectLinuxRelease(releases, this.currentVersion);
      if (!candidate) {
        this.emit("update-not-available", { version: releaseCandidates(releases)[0]?.version || this.currentVersion });
        return null;
      }
      const info = { version: candidate.version, releaseNotes: candidate.releaseNotes };
      this.emit("update-available", info);
      if (!this.autoDownload) return info;
      await this.#download(candidate);
      this.emit("update-downloaded", info);
      return info;
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  async #download(candidate) {
    const assetName = safeAssetName(candidate.packageAsset.name);
    const checksumText = await fetchText(this.fetch, candidate.checksumAsset.browser_download_url, this.metadataTimeoutMs);
    const expected = parseExpectedChecksum(checksumText, assetName);
    const apiDigest = githubAssetDigest(candidate.packageAsset);
    if (!apiDigest) throw new Error("GitHub Release 未提供 Ubuntu 安装包摘要，已拒绝自动更新");
    if (apiDigest !== expected) throw new Error("GitHub Release 摘要与 checksums-linux.txt 不一致");
    const destination = path.join(this.cacheRoot, candidate.version, assetName);
    let actual = fs.existsSync(destination) ? await sha256File(destination) : "";
    if (actual !== expected) {
      fs.rmSync(destination, { force: true });
      await downloadFile(this.fetch, candidate.packageAsset.browser_download_url, destination, (percent) => {
        this.emit("download-progress", { percent });
      }, this.downloadTimeoutMs);
      actual = await sha256File(destination);
    }
    if (actual !== expected) {
      fs.rmSync(destination, { force: true });
      throw new Error("Ubuntu 安装包 SHA-256 校验失败，已删除损坏文件");
    }
    pruneVersionCache(this.cacheRoot, candidate.version);
    this.downloaded = { packagePath: destination, digest: expected, version: candidate.version };
  }

  quitAndInstall() {
    if (!this.downloaded) throw new Error("Ubuntu 更新尚未下载完成");
    if (!fs.existsSync(this.helperPath)) throw new Error("Ubuntu 更新安装助手缺失");
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const child = this.spawn("/bin/bash", [
      this.helperPath,
      this.downloaded.packagePath,
      this.downloaded.digest,
      this.executablePath,
      String(process.pid),
      this.logPath,
    ], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref?.();
    setTimeout(() => this.quit(), 150);
  }
}

function createLinuxReleaseUpdater(options) {
  return new LinuxReleaseUpdater(options);
}

module.exports = {
  LINUX_ASSET_PATTERN,
  LinuxReleaseUpdater,
  compareDesktopVersions,
  createLinuxReleaseUpdater,
  parseDesktopVersion,
  parseExpectedChecksum,
  pruneVersionCache,
  releaseCandidates,
  selectLinuxRelease,
};
