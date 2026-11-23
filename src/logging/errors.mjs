export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorText(value, fallback = "Codex 运行失败") {
  if (value instanceof Error) {
    return [value.message || fallback, value.data ? safeJson(value.data) : ""].filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value || fallback;
  if (!value || typeof value !== "object") return String(value || fallback);

  const parts = [];
  const message = value.message;
  if (typeof message === "string") parts.push(message);
  else if (message && typeof message === "object") parts.push(errorText(message, ""));

  const error = value.error;
  if (typeof error === "string") parts.push(error);
  else if (error && typeof error === "object") parts.push(errorText(error, ""));

  if (typeof value.additionalDetails === "string") parts.push(value.additionalDetails);
  if (value.codexErrorInfo) parts.push(`codexErrorInfo: ${safeJson(value.codexErrorInfo)}`);
  if (value.threadId) parts.push(`threadId: ${value.threadId}`);
  if (value.turnId) parts.push(`turnId: ${value.turnId}`);
  if (value.willRetry !== undefined) parts.push(`willRetry: ${value.willRetry}`);

  const text = parts.filter(Boolean).join("\n");
  return text || safeJson(value) || fallback;
}

export function normalizeFailure(value) {
  if (!value || typeof value !== "object") return null;
  const kind = String(value.kind || "").trim();
  if (!kind) return null;
  return {
    kind,
    label: String(value.label || kind),
    recoverable: Boolean(value.recoverable),
    message: String(value.message || ""),
    suggestion: String(value.suggestion || ""),
    detail: String(value.detail || ""),
    at: Number(value.at) || Date.now(),
  };
}

export function bridgeTimeoutFailure(reason = "", timeoutType = "total") {
  const idle = timeoutType === "idle";
  return {
    kind: "timeout",
    label: "Bridge 超时",
    recoverable: false,
    message: idle
      ? "Bridge 等待 Codex 任务期间超过无进展时限。"
      : "Bridge 等待 Codex 任务超过总时长配置时限。",
    suggestion: idle
      ? "检查 Codex 是否卡住，或按任务特征调整无进展超时。"
      : "仅当任务确实需要更长总时长时调整总时长超时。",
    detail: String(reason || ""),
    at: Date.now(),
  };
}

export function bridgeTimeoutError(reason = "", timeoutType = "total") {
  return errorFromFailure(bridgeTimeoutFailure(reason, timeoutType));
}

export function shouldWaitForNativeRetry(failure, willRetry) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  return item.recoverable && willRetry === true;
}

export function nativeRetryExhaustedFailure(failure, willRetry) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  if (item.kind !== "stream_disconnect" || willRetry !== false) return item;
  return {
    ...item,
    label: "Codex 响应流重连失败",
    message: "Codex 原生响应流已耗尽重连尝试，仍未恢复。",
    suggestion: "Bridge 将仅对此类断流尝试一次断点续跑；若仍失败，再报告任务失败。",
  };
}

export function httpStatusFromText(text) {
  const value = String(text || "");
  const match = value.match(/httpStatusCode["']?\s*[:=]\s*(\d{3})/i)
    || value.match(/(?:API Error:|\bHTTP)\s*(\d{3})\b/i)
    || value.match(/\b(\d{3})\s+(?:Unauthorized|Too Many Requests|Forbidden|Payment Required)\b/i);
  return match ? Number(match[1]) : null;
}

export function classifyCodexFailure(value, fallback = "Codex 运行失败") {
  if (value?.codexFailure) return normalizeFailure(value.codexFailure);

  const detail = errorText(value, fallback);
  const lower = detail.toLowerCase();
  const errorCode = String(value?.code || value?.cause?.code || "").toUpperCase();
  const httpStatus = httpStatusFromText(detail);
  const base = {
    kind: "unknown",
    label: "未知错误",
    recoverable: false,
    message: `${value?.engine === 'antigravity' ? 'Antigravity' : value?.engine === 'claude' ? 'Claude Code' : 'Codex'} 运行失败，但 Bridge 无法明确判断原因。`,
    suggestion: "查看日志中的原始错误；如果是偶发问题，可以手动重试。",
    detail,
    at: Date.now(),
  };

  if (errorCode === 'CLAUDE_UPSTREAM_TIMEOUT') {
    return { ...base, kind: 'upstream_timeout', label: '上游响应超时',
      message: 'Claude Code 等待上游响应超过连续无进展时限，本轮已结束。',
      suggestion: '原会话和工作区已保留。服务恢复后可继续；本轮不会无限等待或自动重放已执行的工具。' };
  }

  if (httpStatus >= 500 && httpStatus <= 599) {
    return { ...base, kind: 'upstream_http', label: `上游服务异常（HTTP ${httpStatus}）`,
      message: `模型服务商返回 HTTP ${httpStatus}，本轮请求未能完成。`,
      suggestion: '原会话和工作区已保留。请在渠道恢复后继续；如果反复发生，需要服务商检查网关和后端。' };
  }

  if (
    ["EACCES", "EBUSY", "EPERM"].includes(errorCode)
    || /\b(?:eacces|ebusy|eperm):/.test(lower)
  ) {
    return {
      ...base,
      kind: "local_io",
      label: "Bridge 本地文件占用",
      message: "Bridge 读写本地状态文件时被 Windows 暂时阻止。",
      suggestion: "这不是 Provider 错误，不应通过切换 service_tier 或重跑模型任务处理。",
    };
  }

  const structured = safeJson(value?.data || value?.codexErrorInfo || value?.cause?.data || "").toLowerCase();
  if (structured.includes("modelprovidermismatch") || /cannot change this thread.s model provider.+on resume/.test(lower)) {
    return { ...base, kind: "model_provider_mismatch", label: "Provider 与原生会话不匹配",
      message: "目标 Provider 与当前原生 thread 的 Provider 不同，不能直接恢复。",
      suggestion: "Bridge 需要从当前最新历史创建目标 Provider 的接续分支；原会话绑定与历史已保留，不自动重放任务。" };
  }
  if (/modelprovidernotfound|modelprovidernotconfigured/.test(structured) || /model provider.+(?:not found|not configured)|provider.+未(?:配置|在 config)/.test(lower)) {
    return { ...base, kind: "provider_not_configured", label: "Provider 未配置", message: "当前配置中找不到目标 Provider。",
      suggestion: "先添加或同步对应 Codex Home 的 Provider 定义；原会话已保留。" };
  }
  if (/providerpolicyconflict|modelproviderpolicy/.test(structured) || /(?:model provider|model_provider).+(?:not allowed|disallowed|policy|requirement)/.test(lower)) {
    return { ...base, kind: "provider_policy", label: "Provider 策略冲突", message: "目标 Provider 与当前运行策略不兼容。",
      suggestion: "检查 Provider 与组织策略配置；不会改用其他渠道或重跑任务。" };
  }
  if (structured.includes('cloudconfigtimeout') || lower.includes("cloud config") && /timed?\s*out|timeout|deadline/.test(lower)) {
    return {
      ...base,
      kind: "cloud_config",
      label: "Codex cloud config timeout",
      recoverable: false,
      message: "Codex cloud config 加载超时，当前无法开始这一轮。",
      suggestion: "这通常是临时服务或网络问题；Bridge 会保留原 thread 绑定，请稍后重试同一个会话。",
    };
  }

  if (lower.includes("failed to load configuration") || /toml parse error|invalid configuration/.test(lower)) {
    return { ...base, kind: "configuration", label: "Codex 配置错误", message: "Codex 无法加载当前配置。",
      suggestion: "查看具体配置错误并修正；原 thread 绑定保留，不自动重试任务。" };
  }
  if (errorCode === "PROVIDER_HANDOFF_UNCERTAIN") {
    return { ...base, kind: "provider_handoff_pending", label: "Provider 接续状态待核实",
      message: "接续请求未返回确定结果，原绑定仍然保留。", suggestion: "再次发送相同切换命令会核对已有分支，不会盲目创建新分支。" };
  }

  if (lower.includes("no rollout found for thread id")) {
    return {
      ...base,
      kind: "missing_rollout",
      label: "Codex 会话文件缺失",
      recoverable: false,
      message: "当前会话绑定的 Codex 原生 thread 已经找不到 rollout 文件，无法继续续接。",
      suggestion: "发送 /list 查看该会话状态；如果它显示异常，请用 /delete <序号> 清理坏绑定后重新发送普通消息创建新会话。",
    };
  }

  if (lower.includes("stopped by user") || lower.includes("已停止") || lower.includes("interrupted")) {
    return { ...base, kind: "user_stop", label: "用户停止", message: "任务已被用户停止。", suggestion: "" };
  }

  if (
    httpStatus === 401
    || lower.includes("invalid_api_key")
    || lower.includes("invalid api key")
    || lower.includes("unauthorized")
    || lower.includes("not logged in")
    || lower.includes("authentication")
  ) {
    return {
      ...base,
      kind: "auth",
      label: "Codex 鉴权失败",
      message: "Codex 登录或 API Key 鉴权失败。",
      suggestion: "这类失败不自动续跑；需要先修复 Codex 登录/API Key。",
    };
  }

  if (
    lower.includes("insufficient_quota")
    || lower.includes("quota")
    || lower.includes("billing")
    || lower.includes("credit")
    || lower.includes("usage limit")
    || lower.includes("budget")
  ) {
    return {
      ...base,
      kind: "quota",
      label: "Codex 额度不足",
      message: "Codex 额度、账单或预算限制导致任务停止。",
      suggestion: "这类失败不自动续跑；需要补充额度或调整账号限制后再继续。",
    };
  }

  if (httpStatus === 429 || lower.includes("rate limit") || lower.includes("rate_limit") || lower.includes("too many requests")) {
    return {
      ...base,
      kind: "rate_limit",
      label: "Codex 限流",
      message: "Codex 上游限流，当前不适合立即自动续跑。",
      suggestion: "稍后手动重试，或降低并发。",
    };
  }

  if (lower.includes("card update failed") || lower.includes("cardkit") || lower.includes("lark-cli failed")) {
    return {
      ...base,
      kind: "feishu_card",
      label: "飞书卡片更新失败",
      message: "Codex 可能仍在运行，但飞书动态卡片刷新失败。",
      suggestion: "这类问题应重试发卡或看日志，不应该重跑 Codex 任务。",
    };
  }

  if (
    lower.includes("responsestreamdisconnected")
    || lower.includes("responsesstreamdisconnected")
    || lower.includes("stream disconnected before completion")
    || lower.includes("transport error")
    || lower.includes("network error")
    || lower.includes("error decoding response body")
  ) {
    return {
      ...base,
      kind: "stream_disconnect",
      label: "Codex 流式连接断开",
      recoverable: true,
      message: "Codex 原生输出流在完成前断开。",
      suggestion: "Bridge 会等待原生重连；如果最终仍失败，仅对这类断流尝试一次断点续跑。",
    };
  }

  if (lower.includes("stdout line exceeded") && lower.includes("bytes limit")) {
    return {
      ...base,
      kind: "app_server_line_limit",
      label: "Codex 单行输出超限",
      recoverable: false,
      message: "Codex app-server 返回的单行 JSON 超过安全内存上限，本轮已中止。",
      suggestion: "若当前历史会话体积过大，可发送 /new 开启新会话，或升级后使用轻量恢复（excludeTurns）。",
    };
  }

  if (lower.includes("ended before turn completed") || lower.includes("app-server exited")) {
    return {
      ...base,
      kind: "app_server",
      label: "Codex app-server 提前结束",
      message: "Codex app-server 在 turn 完成前结束。",
      suggestion: "查看 app-server stderr；如果前面出现过断流，可尝试手动继续。",
    };
  }

  return base;
}

export function isNoGoalExistsError(value) {
  const lower = errorText(value, "").toLowerCase();
  return lower.includes("no goal exists")
    || lower.includes("goal does not exist")
    || lower.includes("no current goal");
}

export function failureDetailText(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  const parts = [
    `类型：${item.label}`,
    item.message,
    item.suggestion ? `建议：${item.suggestion}` : "",
    "",
    item.detail,
  ].filter((line) => line !== "");
  return parts.join("\n");
}

export function failureShortText(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  if (item.kind === "missing_rollout") {
    return [
      `${item.label}：${item.message}`,
      "",
      "这通常表示 /list 里的当前会话已经变成异常绑定：Bridge 还记着 threadId，但 Codex 原生 DB 或 rollout 文件已经不完整。",
      "处理方式：先发 /list 找到标记为异常的当前会话，再用 /delete <序号> 预览并 /confirm delete <序号> 清理；清理后重新发普通消息会创建新会话。",
    ].join("\n");
  }
  return item.suggestion ? `${item.label}：${item.message} ${item.suggestion}` : `${item.label}：${item.message}`;
}

export function errorFromFailure(failure) {
  const item = normalizeFailure(failure) || classifyCodexFailure(failure);
  const error = new Error(failureDetailText(item));
  error.codexFailure = item;
  return error;
}

export function emptyCompletionFailure({
  messageId = "",
  sessionId = "",
  threadId = "",
  turnId = "",
  durationMs = 0,
  tokens = "",
} = {}) {
  return {
    kind: "empty_completion",
    label: "Codex empty completion",
    recoverable: true,
    message: "Codex app-server completed the turn without any assistant output.",
    suggestion: "Bridge will clear this app-server thread and fall back to codex exec.",
    detail: [
      messageId ? `messageId: ${messageId}` : "",
      sessionId ? `sessionId: ${sessionId}` : "",
      threadId ? `threadId: ${threadId}` : "",
      turnId ? `turnId: ${turnId}` : "",
      durationMs ? `durationMs: ${durationMs}` : "",
      tokens ? `tokens: ${tokens}` : "",
    ].filter(Boolean).join("\n"),
    at: Date.now(),
  };
}

export function emptyCompletionError(context = {}) {
  return errorFromFailure(emptyCompletionFailure(context));
}
