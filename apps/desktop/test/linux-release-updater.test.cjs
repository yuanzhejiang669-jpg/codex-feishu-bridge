const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareDesktopVersions,
  createLinuxReleaseUpdater,
  parseExpectedChecksum,
  pruneVersionCache,
  releaseCandidates,
  selectLinuxRelease,
} = require("../src/main/services/linux-release-updater.cjs");

function asset(name, url, digest = "") {
  return { name, browser_download_url: url, digest };
}

function release(version, options = {}) {
  const packageName = `Codex-Feishu-Bridge-${version}-linux-amd64.deb`;
  return {
    draft: Boolean(options.draft),
    prerelease: Boolean(options.prerelease),
    body: options.body || "",
    assets: [
      asset(packageName, `https://example.test/${packageName}`, options.digest),
      asset("checksums-linux.txt", "https://example.test/checksums-linux.txt"),
    ],
  };
}

test("orders stable and Linux revision versions without mixing invalid assets", () => {
  assert.equal(compareDesktopVersions("0.8.20-linux.1", "0.8.19-linux.99"), 1);
  assert.equal(compareDesktopVersions("0.8.19-linux.2", "0.8.19-linux.1"), 1);
  assert.equal(compareDesktopVersions("0.8.19", "0.8.19-linux.99"), 1);
  assert.equal(compareDesktopVersions("not-a-version", "0.8.19"), null);
  const candidates = releaseCandidates([
    release("0.8.19-linux.2", { prerelease: true }),
    release("0.8.20-linux.1"),
    release("0.9.0-linux.1", { draft: true }),
    { draft: false, assets: [asset("Codex-Feishu-Bridge-Setup-9.0.0.exe", "https://example.test/win")] },
  ]);
  assert.deepEqual(candidates.map((item) => item.version), ["0.8.20-linux.1", "0.8.19-linux.2"]);
  assert.equal(selectLinuxRelease(candidates.map(() => null), "0.8.19-linux.1"), null);
});

test("selects prerelease Linux updates by their package asset version", () => {
  const selected = selectLinuxRelease([release("0.8.19-linux.2", { prerelease: true })], "0.8.19-linux.1");
  assert.equal(selected.version, "0.8.19-linux.2");
  assert.equal(selectLinuxRelease([release("0.8.19-linux.1")], "0.8.19-linux.1"), null);
});

test("requires an exact package entry in checksums-linux.txt", () => {
  const digest = "a".repeat(64);
  assert.equal(parseExpectedChecksum(`${digest}  package.deb\n`, "package.deb"), digest);
  assert.throws(() => parseExpectedChecksum(`${digest}  other.deb\n`, "package.deb"), /未包含/);
});

test("prunes only old version cache directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-cache-"));
  fs.mkdirSync(path.join(root, "0.8.19-linux.1"));
  fs.mkdirSync(path.join(root, "0.8.19-linux.2"));
  fs.mkdirSync(path.join(root, "unrelated"));
  try {
    pruneVersionCache(root, "0.8.19-linux.2");
    assert.equal(fs.existsSync(path.join(root, "0.8.19-linux.1")), false);
    assert.equal(fs.existsSync(path.join(root, "0.8.19-linux.2")), true);
    assert.equal(fs.existsSync(path.join(root, "unrelated")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("downloads, verifies, and launches the trusted Linux update helper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-updater-"));
  const helperPath = path.join(root, "install-linux-update.sh");
  fs.writeFileSync(helperPath, "#!/bin/bash\n", "utf8");
  const bytes = Buffer.from("verified deb package");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const version = "0.8.19-linux.2";
  const packageName = `Codex-Feishu-Bridge-${version}-linux-amd64.deb`;
  const releases = [release(version, { prerelease: true, digest: `sha256:${digest}` })];
  const calls = [];
  const fetch = async (url) => {
    if (String(url).includes("releases?")) return new Response(JSON.stringify(releases), { status: 200 });
    if (String(url).endsWith("checksums-linux.txt")) return new Response(`${digest}  ${packageName}\n`, { status: 200 });
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  let quit = false;
  const updater = createLinuxReleaseUpdater({
    currentVersion: "0.8.19-linux.1",
    cacheRoot: path.join(root, "updates"),
    helperPath,
    executablePath: "/opt/Codex Feishu Bridge/codex-feishu-bridge",
    logPath: path.join(root, "update.log"),
    fetch,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
    quit: () => { quit = true; },
  });
  const events = [];
  updater.on("update-available", (info) => events.push(`available:${info.version}`));
  updater.on("update-downloaded", (info) => events.push(`downloaded:${info.version}`));
  try {
    await updater.checkForUpdates();
    assert.deepEqual(events, [`available:${version}`, `downloaded:${version}`]);
    assert.equal(fs.readFileSync(updater.downloaded.packagePath, "utf8"), bytes.toString());
    updater.quitAndInstall();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/bin/bash");
    assert.equal(calls[0].args[0], helperPath);
    assert.equal(calls[0].args[2], digest);
    await new Promise((resolve) => setTimeout(resolve, 175));
    assert.equal(quit, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a Release whose API digest disagrees with its checksum manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-linux-updater-"));
  const version = "0.8.19-linux.2";
  const packageName = `Codex-Feishu-Bridge-${version}-linux-amd64.deb`;
  const releases = [release(version, { digest: `sha256:${"b".repeat(64)}` })];
  const fetch = async (url) => {
    if (String(url).includes("releases?")) return new Response(JSON.stringify(releases), { status: 200 });
    return new Response(`${"a".repeat(64)}  ${packageName}\n`, { status: 200 });
  };
  const updater = createLinuxReleaseUpdater({
    currentVersion: "0.8.19-linux.1",
    cacheRoot: root,
    helperPath: path.join(root, "helper.sh"),
    executablePath: "/opt/Codex Feishu Bridge/codex-feishu-bridge",
    fetch,
  });
  updater.on("error", () => {});
  try {
    await assert.rejects(updater.checkForUpdates(), /摘要.*不一致/);
    assert.equal(updater.downloaded, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses automatic installation when GitHub omits the asset digest", async () => {
  const version = "0.8.19-linux.2";
  const packageName = `Codex-Feishu-Bridge-${version}-linux-amd64.deb`;
  const fetch = async (url) => {
    if (String(url).includes("releases?")) return new Response(JSON.stringify([release(version)]), { status: 200 });
    return new Response(`${"a".repeat(64)}  ${packageName}\n`, { status: 200 });
  };
  const updater = createLinuxReleaseUpdater({
    currentVersion: "0.8.19-linux.1",
    cacheRoot: os.tmpdir(),
    helperPath: "/tmp/helper.sh",
    executablePath: "/opt/Codex Feishu Bridge/codex-feishu-bridge",
    fetch,
  });
  updater.on("error", () => {});
  await assert.rejects(updater.checkForUpdates(), /未提供.*摘要/);
});
