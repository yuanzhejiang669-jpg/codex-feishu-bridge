const path = require("node:path");
const { spawn } = require("node:child_process");

const RETRYABLE_NETWORK_ERROR = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ENOTFOUND)\b|socket hang up/i;

function isRetryableNetworkError(output) {
  return RETRYABLE_NETWORK_ERROR.test(String(output || ""));
}

function runBuilder(args, { spawnProcess = spawn } = {}) {
  const executable = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  );

  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawnProcess(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", (chunk) => {
        destination.write(chunk);
        output = `${output}${chunk}`.slice(-1024 * 1024);
      });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runBuilder(args);
    if (result.code === 0) return;
    if (attempt === attempts || !isRetryableNetworkError(result.output)) {
      process.exitCode = result.code || 1;
      return;
    }
    const delaySeconds = attempt * 5;
    process.stderr.write(`electron-builder network failure; retrying in ${delaySeconds}s (${attempt}/${attempts})\n`);
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { isRetryableNetworkError, runBuilder };
