import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverCodexHomeRegistry,
  loadRegisteredBridgeBindings,
} from "../src/sessions/codex-home-registry.mjs";

test("discovers unique Codex homes from config and persisted launch configs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-registry-"));
  try {
    const engineRoot = path.join(root, "engine");
    const instancesRoot = path.join(root, "runtime", "instances");
    const currentHome = path.join(root, "homes", "default");
    const writingHome = path.join(root, "homes", "writing");
    const drawingHome = path.join(root, "homes", "drawing");
    const stateDir = path.join(instancesRoot, "bot-1", "state");
    fs.mkdirSync(engineRoot, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(instancesRoot, "bot-2", "state"), { recursive: true });
    fs.writeFileSync(path.join(engineRoot, "bridge.instances.local.json"), JSON.stringify({
      defaults: { codexHome: currentHome },
      instances: [{
        name: "writer-1",
        codexHome: writingHome,
        desktopCodexHome: currentHome,
        runtimeRoot: path.join(instancesRoot, "bot-1"),
      }],
    }), "utf8");
    fs.writeFileSync(path.join(instancesRoot, "bot-2", "state", "launch-config.json"), JSON.stringify({
      codexHome: drawingHome,
      desktopCodexHome: currentHome,
    }), "utf8");

    const registry = discoverCodexHomeRegistry({
      currentCodexHome: currentHome,
      desktopCodexHome: currentHome,
      stateDir,
      engineRoot,
      defaultDataRoot: path.join(root, "unused"),
      localAppData: path.join(root, "local"),
      extraInstancesRoots: [instancesRoot],
    });
    const homes = registry.homes.map((item) => item.codexHome).sort();
    assert.deepEqual(homes, [currentHome, drawingHome, writingHome].map((item) => path.resolve(item)).sort());
    assert.ok(registry.stateDirs.includes(path.join(instancesRoot, "bot-2", "state")));
    assert.ok(registry.instancesRoots.every((item) => path.basename(item).toLowerCase() === "instances"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loads thread bindings from every registered instance state without empty sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-bindings-"));
  try {
    const first = path.join(root, "instances", "first", "state");
    const second = path.join(root, "instances", "second", "state");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    fs.writeFileSync(path.join(first, "sessions.json"), JSON.stringify({
      chats: {
        chat1: {
          currentSessionId: "session-1",
          sessions: [
            { id: "session-1", codexThreadId: "thread-1", title: "first" },
            { id: "empty", codexThreadId: "", title: "empty" },
          ],
        },
      },
    }), "utf8");
    fs.writeFileSync(path.join(second, "sessions.json"), JSON.stringify({
      chats: {
        chat2: {
          currentSessionId: "session-2",
          sessions: [{ id: "session-2", codexThreadId: "thread-2", title: "second" }],
        },
      },
    }), "utf8");

    const bindings = loadRegisteredBridgeBindings([first, second, first]);
    assert.deepEqual(bindings.map((item) => item.threadId).sort(), ["thread-1", "thread-2"]);
    assert.equal(bindings.find((item) => item.threadId === "thread-1").currentSessionId, "session-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
