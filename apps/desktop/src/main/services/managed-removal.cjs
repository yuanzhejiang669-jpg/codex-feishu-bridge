const fs = require("node:fs");
const path = require("node:path");
const { readManagedBots } = require("./bot-setup.cjs");
const { inspectManagedBots, managedRuntimeRoot } = require("./supervisor.cjs");

function isolatedSpaces(dataRoot) {
  const groups = new Map();
  for (const bot of readManagedBots(dataRoot)) {
    if (bot.codexHomeMode !== "isolated" || !bot.codexHome || !bot.workspaceFactory) continue;
    const key = path.resolve(bot.codexHome).toLowerCase();
    if (!groups.has(key)) groups.set(key, {
      id: path.resolve(bot.codexHome),
      codexHome: path.resolve(bot.codexHome),
      spaceName: String(bot.workspaceFactory.spaceName || bot.label || bot.name),
      slug: String(bot.workspaceFactory.slug || ""),
      bots: [],
    });
    groups.get(key).bots.push(bot);
  }
  return [...groups.values()].sort((left, right) => left.spaceName.localeCompare(right.spaceName));
}

function publicBot(bot, runtime) {
  return {
    name: bot.name,
    label: bot.label || bot.name,
    profile: bot.profile,
    workspace: bot.workspace,
    codexHome: bot.codexHome,
    online: runtime?.online === true,
    activeRunCount: Number(runtime?.activeRunCount || 0),
  };
}

function previewManagedBotRemoval(name, options) {
  const bot = readManagedBots(options.dataRoot).find((item) => item.name === String(name || "").trim());
  if (!bot) throw new Error(`找不到客户端管理的 Bot：${name}`);
  const runtime = inspectManagedBots(options.dataRoot, options.localAppData).find((item) => item.name === bot.name);
  const shared = readManagedBots(options.dataRoot).filter((item) => (
    item.name !== bot.name && path.resolve(item.codexHome || "") === path.resolve(bot.codexHome || "")
  ));
  return {
    kind: "bot",
    id: bot.name,
    title: `删除 ${bot.label || bot.name}`,
    bots: [publicBot(bot, runtime)],
    sharedCodexHomeBotCount: shared.length,
    paths: {
      workspace: bot.workspace,
      codexHome: bot.codexHome,
      managedRoot: path.dirname(bot.configPath),
      runtimeRoot: managedRuntimeRoot(options.localAppData, bot.name),
    },
    defaults: { deleteWorkspaces: false, deleteCodexHome: false, deleteRuntime: true },
    cloudApplicationPreserved: true,
  };
}

function previewManagedSpaceRemoval(id, options) {
  const requested = path.resolve(String(id || ""));
  const space = isolatedSpaces(options.dataRoot).find((item) => item.codexHome.toLowerCase() === requested.toLowerCase());
  if (!space) throw new Error("找不到客户端管理的隔离空间");
  const runtimes = new Map(inspectManagedBots(options.dataRoot, options.localAppData).map((bot) => [bot.name, bot]));
  return {
    kind: "space",
    id: space.codexHome,
    title: `删除空间 ${space.spaceName}`,
    spaceName: space.spaceName,
    bots: space.bots.map((bot) => publicBot(bot, runtimes.get(bot.name))),
    paths: {
      codexHome: space.codexHome,
      workspaces: space.bots.map((bot) => bot.workspace),
    },
    defaults: { deleteWorkspaces: false, deleteCodexHome: true, deleteRuntime: true },
    cloudApplicationPreserved: true,
  };
}

function assertOwnedChild(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 不在客户端允许删除的目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

function pruneFactoryQueue(dataRoot, removedNames) {
  const queuePath = path.join(dataRoot, "workspace-factory.json");
  try {
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    queue.bots = (queue.bots || []).filter((bot) => !removedNames.has(bot.name));
    if (!queue.bots.length) fs.rmSync(queuePath, { force: true });
    else fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`无法更新工作空间创建队列：${error.message}`);
  }
}

async function applyManagedRemoval(input, options) {
  const kind = input?.kind === "space" ? "space" : "bot";
  const preview = kind === "space"
    ? previewManagedSpaceRemoval(input?.id, options)
    : previewManagedBotRemoval(input?.id, options);
  const active = preview.bots.filter((bot) => bot.activeRunCount > 0);
  if (active.length) throw new Error(`以下 Bot 仍有活动任务，已拒绝删除：${active.map((bot) => bot.name).join("、")}`);

  const allBots = readManagedBots(options.dataRoot);
  const targets = new Set(preview.bots.map((bot) => bot.name));
  const selected = allBots.filter((bot) => targets.has(bot.name));
  if (input?.deleteWorkspaces === true) {
    for (const bot of selected) {
      assertOwnedChild(options.workspaceRoot, bot.workspace, "工作空间");
      const otherOwner = allBots.find((item) => !targets.has(item.name) && path.resolve(item.workspace) === path.resolve(bot.workspace));
      if (otherOwner) throw new Error(`工作空间仍被 ${otherOwner.name} 使用，不能删除`);
    }
  }
  if (kind === "space" && input?.deleteCodexHome === true) {
    assertOwnedChild(options.codexHomeRoot, preview.paths.codexHome, "空间 Codex Home");
    const otherOwner = allBots.find((item) => !targets.has(item.name) && path.resolve(item.codexHome) === path.resolve(preview.paths.codexHome));
    if (otherOwner) throw new Error(`Codex Home 仍被 ${otherOwner.name} 使用，不能删除`);
  }
  const stopped = [];
  try {
    for (const bot of preview.bots.filter((item) => item.online)) {
      await options.stopBot(bot.name);
      stopped.push(bot.name);
    }
  } catch (error) {
    for (const name of stopped) await options.startBot(name).catch(() => {});
    throw new Error(`删除前停止 Bot 失败：${error.message}`);
  }

  const removed = [];
  try {
    for (const bot of selected) {
      await options.removeProfile(bot);
      fs.rmSync(assertOwnedChild(path.join(options.dataRoot, "managed-bots"), path.dirname(bot.configPath), "Bot 配置"), { recursive: true, force: true });
      if (input?.deleteRuntime !== false) {
        fs.rmSync(assertOwnedChild(path.join(options.localAppData, "CodexFeishuBridge", "instances"), managedRuntimeRoot(options.localAppData, bot.name), "Bot 运行数据"), { recursive: true, force: true });
      }
      if (input?.deleteWorkspaces === true) {
        fs.rmSync(assertOwnedChild(options.workspaceRoot, bot.workspace, "工作空间"), { recursive: true, force: true });
      }
      removed.push(bot.name);
    }
    if (kind === "space" && input?.deleteCodexHome === true) {
      fs.rmSync(assertOwnedChild(options.codexHomeRoot, preview.paths.codexHome, "空间 Codex Home"), { recursive: true, force: true });
    }
    pruneFactoryQueue(options.dataRoot, new Set(removed));
    return {
      ok: true,
      kind,
      removed,
      workspacesDeleted: input?.deleteWorkspaces === true,
      codexHomeDeleted: kind === "space" && input?.deleteCodexHome === true,
      cloudApplicationsPreserved: true,
    };
  } catch (error) {
    for (const name of stopped.filter((name) => !removed.includes(name))) await options.startBot(name).catch(() => {});
    throw new Error(`删除未完成${removed.length ? `（已删除：${removed.join("、")}）` : ""}：${error.message}`);
  }
}

module.exports = {
  applyManagedRemoval,
  assertOwnedChild,
  isolatedSpaces,
  previewManagedBotRemoval,
  previewManagedSpaceRemoval,
};
