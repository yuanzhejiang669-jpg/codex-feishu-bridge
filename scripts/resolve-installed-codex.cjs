const { resolveInstalledRuntime } = require('../src/codex/installed-runtime.cjs');
const result = resolveInstalledRuntime();
if (result.runtimeFound) process.stdout.write(result.runtimePath);
else if (result.explicit) { process.stderr.write(result.error); process.exitCode = 2; }
