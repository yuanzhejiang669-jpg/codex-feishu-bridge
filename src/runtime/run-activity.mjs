const PHASE_LABELS = Object.freeze({
  initializing: "正在初始化 Codex",
  model_thinking: "等待模型响应",
  model_streaming: "正在接收模型响应",
  tool_running: "工具执行中",
  waiting_model: "等待模型处理工具结果",
  compacting: "正在压缩上下文",
  recovering: "自动恢复中",
  reconnecting: "上游 API 重试中",
  finalizing: "正在生成最终结果",
  done: "已完成",
  error: "已失败",
  interrupted: "已停止",
});

export function createRunActivity(startedAt = Date.now()) {
  const timestamp = finiteTimestamp(startedAt) || Date.now();
  return {
    phase: "initializing",
    phaseStartedAt: timestamp,
    lastProgressAt: timestamp,
    lastCodexEventAt: 0,
    lastModelEventAt: 0,
    lastToolEventAt: 0,
    connection: "starting",
    retryAttempt: 0,
  };
}

export function markRunPhase(state, phase, options = {}, now = Date.now()) {
  const activity = ensureRunActivity(state, now);
  const timestamp = finiteTimestamp(now) || Date.now();
  if (phase && activity.phase !== phase) {
    activity.phase = phase;
    activity.phaseStartedAt = timestamp;
  }
  if (options.connection) activity.connection = options.connection;
  if (options.retryAttempt !== undefined) {
    activity.retryAttempt = Math.max(0, Number(options.retryAttempt) || 0);
  }
  if (options.progress !== false) activity.lastProgressAt = timestamp;
  return activity;
}

export function markCodexEvent(state, now = Date.now()) {
  const activity = ensureRunActivity(state, now);
  const timestamp = finiteTimestamp(now) || Date.now();
  activity.lastCodexEventAt = timestamp;
  if (activity.connection === "starting" || activity.connection === "disconnected") {
    activity.connection = "connected";
  }
  return activity;
}

export function markModelEvent(state, phase, now = Date.now()) {
  const activity = markRunPhase(state, phase, { progress: true, connection: "connected" }, now);
  activity.lastCodexEventAt = finiteTimestamp(now) || Date.now();
  activity.lastModelEventAt = activity.lastCodexEventAt;
  return activity;
}

export function markToolStarted(state, tool, now = Date.now()) {
  const timestamp = finiteTimestamp(now) || Date.now();
  const activity = markRunPhase(state, "tool_running", { progress: true, connection: "connected" }, timestamp);
  activity.lastCodexEventAt = timestamp;
  activity.lastModelEventAt = timestamp;
  activity.lastToolEventAt = timestamp;
  if (tool) {
    tool.startedAt = finiteTimestamp(tool.startedAt) || timestamp;
    tool.updatedAt = timestamp;
  }
  return activity;
}

export function markToolProgress(state, tool, now = Date.now()) {
  const timestamp = finiteTimestamp(now) || Date.now();
  const activity = markRunPhase(state, "tool_running", { progress: true, connection: "connected" }, timestamp);
  activity.lastCodexEventAt = timestamp;
  activity.lastToolEventAt = timestamp;
  if (tool) {
    tool.startedAt = finiteTimestamp(tool.startedAt) || timestamp;
    tool.updatedAt = timestamp;
    tool.lastOutputAt = timestamp;
  }
  return activity;
}

export function markToolCompleted(state, tool, now = Date.now()) {
  const timestamp = finiteTimestamp(now) || Date.now();
  const activity = markRunPhase(state, "waiting_model", { progress: true, connection: "connected" }, timestamp);
  activity.lastCodexEventAt = timestamp;
  activity.lastToolEventAt = timestamp;
  if (tool) {
    tool.startedAt = finiteTimestamp(tool.startedAt) || timestamp;
    tool.updatedAt = timestamp;
    tool.completedAt = timestamp;
  }
  return activity;
}

export function renderRunActivityMarkdown(state, now = Date.now(), formatToolName = toolDisplayName) {
  const view = runActivityView(state, now, formatToolName);
  const lines = [
    "**当前状态**",
    `运行状态：${view.healthLabel}`,
    `当前阶段：${view.phaseLabel}`,
  ];
  if (view.currentTool) lines.push(`当前工具：${view.currentTool}`);
  lines.push(`最近进展：${view.recentProgress}`);
  lines.push(`Codex 连接：${view.connectionLabel}`);
  lines.push(`上游模型：${view.upstreamLabel}`);
  lines.push(`本阶段：${view.phaseElapsed} · 任务总时长：${view.totalElapsed}`);
  return lines.join("\n");
}

export function runActivityView(state, now = Date.now(), formatToolName = toolDisplayName) {
  const timestamp = finiteTimestamp(now) || Date.now();
  const activity = ensureRunActivity(state, timestamp);
  const tools = Array.isArray(state?.blocks)
    ? state.blocks.filter((block) => block?.kind === "tool" && block.tool).map((block) => block.tool)
    : [];
  const runningTools = tools.filter((tool) => tool.status === "running");
  const currentTool = latestTool(runningTools) || latestTool(tools);
  const effectivePhase = runningTools.length ? "tool_running" : activity.phase;
  const progressAt = Math.max(
    finiteTimestamp(activity.lastProgressAt),
    finiteTimestamp(currentTool?.updatedAt),
    finiteTimestamp(currentTool?.completedAt),
  );
  const silenceMs = Math.max(0, timestamp - (progressAt || finiteTimestamp(state?.startedAt) || timestamp));

  return {
    healthLabel: healthLabel(activity, silenceMs, effectivePhase),
    phaseLabel: PHASE_LABELS[effectivePhase] || "正在处理",
    currentTool: effectivePhase === "tool_running" ? formatToolName(currentTool) : "",
    recentProgress: recentProgressText(activity, currentTool, effectivePhase, timestamp, formatToolName),
    connectionLabel: connectionLabel(activity.connection),
    upstreamLabel: upstreamLabel(effectivePhase, activity),
    phaseElapsed: formatDurationShort(timestamp - (
      effectivePhase === "tool_running" && currentTool
        ? finiteTimestamp(currentTool.startedAt)
        : finiteTimestamp(activity.phaseStartedAt)
    )),
    totalElapsed: formatDurationShort(timestamp - finiteTimestamp(state?.startedAt)),
    silenceMs,
    phase: effectivePhase,
  };
}

export function appServerToolStatus(item, { completed = false } = {}) {
  const status = String(item?.status || "").toLowerCase();
  if (["failed", "declined", "error", "cancelled", "canceled"].includes(status)) return "error";
  if (item?.exitCode !== undefined && item.exitCode !== null && Number(item.exitCode) !== 0) return "error";
  if (item?.success === false) return "error";
  if (completed) return "done";
  if (!status || status === "inprogress" || status === "pending") return "running";
  return "done";
}

function ensureRunActivity(state, now) {
  if (!state.activity || typeof state.activity !== "object") {
    state.activity = createRunActivity(state.startedAt || now);
  }
  return state.activity;
}

function latestTool(tools) {
  return [...tools].sort((left, right) => toolTimestamp(right) - toolTimestamp(left))[0] || null;
}

function toolTimestamp(tool) {
  return Math.max(
    finiteTimestamp(tool?.updatedAt),
    finiteTimestamp(tool?.completedAt),
    finiteTimestamp(tool?.startedAt),
  );
}

function toolDisplayName(tool) {
  if (!tool) return "未知工具";
  const source = String(tool.source || "").trim();
  const name = String(tool.name || "").trim();
  if (source && name && source !== name) return `${source} · ${name}`;
  return source || name || "未知工具";
}

function recentProgressText(activity, tool, phase, now, formatToolName) {
  if (phase === "tool_running" && tool) {
    if (finiteTimestamp(tool.lastOutputAt)) {
      return `${agoText(now, tool.lastOutputAt)} · ${formatToolName(tool)} 有新输出`;
    }
    return `${agoText(now, tool.startedAt || tool.updatedAt)} · ${formatToolName(tool)} 开始执行`;
  }
  if (tool && finiteTimestamp(tool.completedAt) >= finiteTimestamp(activity.lastModelEventAt)) {
    return `${agoText(now, tool.completedAt)} · ${formatToolName(tool)} ${toolCompletionLabel(tool)}`;
  }
  if (finiteTimestamp(activity.lastModelEventAt)) {
    return `${agoText(now, activity.lastModelEventAt)} · 收到模型事件`;
  }
  if (finiteTimestamp(activity.lastCodexEventAt)) {
    return `${agoText(now, activity.lastCodexEventAt)} · 收到 Codex 事件`;
  }
  return `${agoText(now, activity.lastProgressAt)} · 任务已启动`;
}

function toolCompletionLabel(tool) {
  if (tool?.status === "failed" || tool?.status === "error") return "执行失败";
  if (tool?.status === "cancelled" || tool?.status === "canceled") return "已取消";
  return "执行完成";
}

function healthLabel(activity, silenceMs, phase) {
  if (activity.connection === "disconnected") return "连接中断";
  if (activity.phase === "recovering" || activity.phase === "reconnecting") return "恢复中";
  if (phase === "tool_running") {
    if (silenceMs >= 10 * 60_000) return "工具长时间无输出";
    if (silenceMs >= 2 * 60_000) return "工具暂无新输出";
    return "正常";
  }
  if (phase === "compacting") {
    return silenceMs >= 10 * 60_000 ? "压缩耗时较长" : "正常";
  }
  if (silenceMs >= 10 * 60_000) return "长时间无新事件";
  if (silenceMs >= 2 * 60_000) return "响应较慢";
  return "正常";
}

function connectionLabel(value) {
  if (value === "connected") return "正常";
  if (value === "disconnected") return "已断开";
  if (value === "recovering") return "恢复中";
  return "正在建立";
}

function upstreamLabel(phase, activity) {
  if (phase === "tool_running") return "等待工具结果";
  if (phase === "model_streaming") return "正在接收响应";
  if (phase === "compacting") return "正在压缩上下文";
  if (phase === "reconnecting") return `自动重试中${activity.retryAttempt ? `（第 ${activity.retryAttempt} 次）` : ""}`;
  if (phase === "recovering") return `等待断点续跑${activity.retryAttempt ? `（第 ${activity.retryAttempt} 次）` : ""}`;
  if (phase === "finalizing") return "本轮响应已完成";
  return "等待模型响应";
}

function agoText(now, value) {
  const elapsed = Math.max(0, finiteTimestamp(now) - finiteTimestamp(value));
  if (elapsed < 1000) return "刚刚";
  return `${formatDurationShort(elapsed)}前`;
}

function formatDurationShort(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}小时${minutes}分${seconds}秒`;
  if (minutes) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
