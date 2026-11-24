import crypto from "node:crypto";
import path from "node:path";
import {
  cardMarkdownContent,
  markdown,
  noteMd,
  truncateCardText,
} from "./primitives.mjs";
import {
  appServerToolStatus,
  createRunActivity,
  markCodexEvent,
  markModelEvent,
  markRunPhase,
  markToolCompleted,
  markToolProgress,
  markToolStarted,
  renderRunActivityMarkdown,
} from "../../runtime/run-activity.mjs";
import {
  normalizeContextUsage,
  normalizeGoal,
} from "../../sessions/normalize.mjs";
import {
  classifyCodexFailure,
  errorText,
  failureDetailText,
  nativeRetryExhaustedFailure,
  normalizeFailure,
  safeJson,
  shouldWaitForNativeRetry,
} from "../../logging/errors.mjs";

export function createRunCardRenderer(deps = {}) {
  const {
    CONFIG,
    log,
    activeRuns,
    saveActiveRuns,
    larkJsonWithData,
    codexModelLabel,
  } = deps;

  const userTextFromContent = (...args) => deps.userTextFromContent(...args);
  const effectiveSessionSettings = (...args) => deps.effectiveSessionSettings(...args);
  const updateSessionTokenUsage = (...args) => deps.updateSessionTokenUsage(...args);
  const updateSessionThreadStatus = (...args) => deps.updateSessionThreadStatus(...args);
  const updateSessionGoal = (...args) => deps.updateSessionGoal(...args);
  const updateSessionFailure = (...args) => deps.updateSessionFailure(...args);
  const clearSessionFailure = (...args) => deps.clearSessionFailure(...args);
  const markSessionCompacted = (...args) => deps.markSessionCompacted(...args);
  const resultTextFromState = (...args) => deps.resultTextFromState(...args);
  const goalStatusLabel = (...args) => deps.goalStatusLabel(...args);
  const formatDuration = (...args) => deps.formatDuration(...args);
  const formatNumber = (...args) => deps.formatNumber(...args);
  const formatTime = (...args) => deps.formatTime(...args);

  function createRunState(session, event, userContent) {
    const settings = effectiveSessionSettings(session);
    const startedAt = Date.now();
    return {
      blocks: [],
      footer: "thinking",
      terminal: "running",
      startedAt,
      activity: createRunActivity(startedAt),
      session,
      event,
      userContent,
      threadId: "",
      goalMode: false,
      goal: null,
      goalSteerCount: 0,
      errorMsg: "",
      failure: null,
      formulaRenderComplete: false,
      formulaRenderPromise: null,
      formulaSources: [],
      formulaRenderStats: null,
      meta: {
        engine: session.engine || 'codex',
        durationMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        model: settings.model || codexModelLabel,
        contextUsage: session.lastContextUsage || null,
        contextPeakUsage: session.lastContextPeakUsage || null,
        compactedAt: session.lastCompactedAt || null,
      },
    };
  }

  function appendRunText(state, text) {
    const content = String(text || "");
    if (!content) return false;
    const last = state.blocks[state.blocks.length - 1];
    if (last?.kind === "text" && last.streaming) {
      last.content += content;
    } else {
      state.blocks.push({ kind: "text", content, streaming: true });
    }
    state.footer = "streaming";
    return true;
  }

  function closeStreamingBlocks(state) {
    for (const block of state.blocks) {
      if (block.kind === "text") block.streaming = false;
    }
  }

  function ensureToolBlock(state, item) {
    if (!item?.id) return null;
    let block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
    if (!block) {
      closeStreamingBlocks(state);
      block = {
        kind: "tool",
        tool: {
          id: item.id,
          source: toolSourceFromAppServerItem(item),
          name: toolNameFromAppServerItem(item),
          input: toolInputFromAppServerItem(item),
          output: "",
          status: "running",
        },
      };
      state.blocks.push(block);
    }
    return block;
  }

  function updateToolFromAppServerItem(state, item, { completed = false } = {}) {
    const block = ensureToolBlock(state, item);
    if (!block) return false;
    block.tool.source = toolSourceFromAppServerItem(item);
    block.tool.name = toolNameFromAppServerItem(item);
    block.tool.input = toolInputFromAppServerItem(item);
    block.tool.status = appServerToolStatus(item, { completed });
    const output = toolOutputFromAppServerItem(item);
    if (output) block.tool.output = output;
    state.footer = block.tool.status === "running" ? "tool_running" : "thinking";
    return true;
  }

  function appendToolOutputDelta(state, itemId, delta) {
    if (!itemId || !delta) return false;
    const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === itemId);
    if (!block) return false;
    block.tool.output = `${block.tool.output || ""}${delta}`;
    state.footer = "tool_running";
    markToolProgress(state, block.tool);
    return true;
  }

  function reduceCodexJsonEvent(state, raw) {
    if (!raw || typeof raw !== "object") return false;
    const type = raw.type;
    markCodexEvent(state);

    if (type === "thread.started") {
      state.threadId = raw.thread_id || state.threadId;
      markRunPhase(state, "initializing", { connection: "connected" });
      return true;
    }

    if (type === "turn.started") {
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }

    if (type === "item.started") {
      const item = raw.item || {};
      const name = item.name || item.type || "tool";
      if (item.type && item.type !== "agent_message") {
        closeStreamingBlocks(state);
        const block = {
          kind: "tool",
          tool: {
            id: item.id || crypto.randomUUID(),
            source: toolSourceFromItem(item),
            name,
            input: toolInputFromItem(item),
            status: "running",
          },
        };
        state.blocks.push(block);
        state.footer = "tool_running";
        markToolStarted(state, block.tool);
        return true;
      }
    }

    if (type === "item.completed") {
      const item = raw.item || {};
      if (item.type === "agent_message" && typeof item.text === "string") {
        markModelEvent(state, "model_streaming");
        return appendRunText(state, item.text);
      }
      if (item.id) {
        for (const block of state.blocks) {
          if (block.kind === "tool" && block.tool.id === item.id) {
            block.tool.status = toolStatusFromItem(item);
            block.tool.output = toolOutputFromItem(item);
            state.footer = "thinking";
            markToolCompleted(state, block.tool);
            return true;
          }
        }
      }
      if (item.type && item.type !== "agent_message") {
        closeStreamingBlocks(state);
        const block = {
          kind: "tool",
          tool: {
            id: item.id || crypto.randomUUID(),
            source: toolSourceFromItem(item),
            name: item.name || item.type || "tool",
            input: toolInputFromItem(item),
            output: toolOutputFromItem(item),
            status: toolStatusFromItem(item),
          },
        };
        state.blocks.push(block);
        state.footer = "thinking";
        markToolCompleted(state, block.tool);
        return true;
      }
    }

    if (type === "turn.completed") {
      closeStreamingBlocks(state);
      // Keep the card open until --output-last-message has been read. Codex can
      // emit turn.completed before the bridge has loaded the final answer file.
      state.footer = "streaming";
      state.meta.durationMs = Date.now() - state.startedAt;
      markModelEvent(state, "finalizing");
      if (raw.usage) {
        state.meta.inputTokens = raw.usage.input_tokens;
        state.meta.outputTokens = raw.usage.output_tokens;
      }
      return true;
    }

    if (type === "turn.failed" || type === "error") {
      closeStreamingBlocks(state);
      state.terminal = "error";
      state.footer = null;
      const engineName = state.meta?.engine === "antigravity" ? "Antigravity" : state.meta?.engine === "claude" ? "Claude Code" : "Codex";
      state.errorMsg = raw.message || raw.error || `${engineName} 运行失败`;
      state.meta.durationMs = Date.now() - state.startedAt;
      markRunPhase(state, "error", { connection: "connected" });
      return true;
    }

    return false;
  }

  function reduceAppServerEvent(state, raw) {
    if (!raw || typeof raw !== "object") return false;
    const method = raw.method;
    const params = raw.params || {};
    markCodexEvent(state);

    if (method === "thread/started") {
      state.threadId = params.thread?.id || state.threadId;
      markRunPhase(state, "initializing", { connection: "connected" });
      return true;
    }

    if (method === "thread/status/changed") {
      if (params.threadId) state.threadId = params.threadId;
      const statusType = params.status?.type;
      updateSessionThreadStatus(state.session, statusType || "");
      if (statusType === "active") state.footer = state.footer || "thinking";
      markRunPhase(state, state.activity?.phase || "initializing", {
        connection: statusType === "active" ? "connected" : undefined,
        progress: false,
      });
      return true;
    }

    if (method === "thread/goal/updated") {
      if (params.threadId) state.threadId = params.threadId;
      updateSessionGoal(state.session, params.goal || null);
      return true;
    }

    if (method === "thread/goal/cleared") {
      if (params.threadId) state.threadId = params.threadId;
      updateSessionGoal(state.session, null);
      return true;
    }

    if (method === "turn/started") {
      if (params.threadId) state.threadId = params.threadId;
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }

    if (method === "item/started") {
      const item = params.item || {};
      if (item.type === "agentMessage") {
        state.footer = "streaming";
        markModelEvent(state, "model_streaming");
        return true;
      }
      if (item.type === "contextCompaction") {
        state.footer = "compacting";
        markModelEvent(state, "compacting");
        return true;
      }
      if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
        state.footer = "thinking";
        markModelEvent(state, "model_thinking");
        return true;
      }
      const changed = updateToolFromAppServerItem(state, item);
      const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
      if (block) markToolStarted(state, block.tool);
      return changed;
    }

    if (method === "item/completed") {
      const item = params.item || {};
      if (item.type === "agentMessage" && typeof item.text === "string") {
        closeStreamingBlocks(state);
        const tools = state.blocks.filter((block) => block.kind === "tool");
        state.blocks = item.text.trim()
          ? [{ kind: "text", content: item.text, streaming: false }, ...tools]
          : tools;
        state.footer = "streaming";
        markModelEvent(state, "model_streaming");
        return true;
      }
      if (item.type === "contextCompaction") {
        markSessionCompacted(state.session);
        state.meta.compactedAt = state.session.lastCompactedAt;
        state.meta.contextUsage = null;
        state.footer = "thinking";
        markModelEvent(state, "model_thinking");
        return true;
      }
      if (item.type === "userMessage" || item.type === "hookPrompt" || item.type === "reasoning") {
        state.footer = "thinking";
        markModelEvent(state, "model_thinking");
        return true;
      }
      const changed = updateToolFromAppServerItem(state, item, { completed: true });
      const block = state.blocks.find((entry) => entry.kind === "tool" && entry.tool.id === item.id);
      if (block) markToolCompleted(state, block.tool);
      return changed;
    }

    if (method === "item/agentMessage/delta") {
      markModelEvent(state, "model_streaming");
      return appendRunText(state, params.delta || "");
    }

    if (
      method === "item/commandExecution/outputDelta"
      || method === "command/exec/outputDelta"
      || method === "process/outputDelta"
      || method === "item/fileChange/outputDelta"
    ) {
      return appendToolOutputDelta(state, params.itemId || params.processId, params.delta || "");
    }

    if (method === "item/plan/delta") {
      return appendToolOutputDelta(state, params.itemId, params.delta || "");
    }

    if (method === "item/mcpToolCall/progress") {
      return appendToolOutputDelta(state, params.itemId, params.message ? `${params.message}\n` : "");
    }

    if (method === "thread/tokenUsage/updated") {
      const last = params.tokenUsage?.last || params.tokenUsage?.total || {};
      const total = params.tokenUsage?.total || {};
      state.meta.inputTokens = last.inputTokens;
      state.meta.outputTokens = last.outputTokens;
      state.meta.reasoningOutputTokens = last.reasoningOutputTokens;
      state.meta.totalTokens = total.totalTokens;
      updateSessionTokenUsage(state.session, params.tokenUsage);
      state.meta.contextUsage = state.session.lastContextUsage || null;
      state.meta.contextPeakUsage = state.session.lastContextPeakUsage || null;
      return true;
    }

    if (method === "thread/compacted") {
      markSessionCompacted(state.session);
      state.meta.compactedAt = state.session.lastCompactedAt;
      state.meta.contextUsage = null;
      state.meta.contextPeakUsage = null;
      state.footer = "thinking";
      markModelEvent(state, "model_thinking");
      return true;
    }

    if (method === "turn/completed") {
      closeStreamingBlocks(state);
      state.footer = "streaming";
      state.meta.durationMs = params.turn?.durationMs ?? Date.now() - state.startedAt;
      markModelEvent(state, "finalizing");
      return true;
    }

    if (method === "error") {
      const failure = nativeRetryExhaustedFailure(
        classifyCodexFailure(params, "Codex app-server 运行失败"),
        params.willRetry,
      );
      state.failure = failure;
      state.errorMsg = failureDetailText(failure);
      if (shouldWaitForNativeRetry(failure, params.willRetry)) {
        closeStreamingBlocks(state);
        state.footer = "reconnecting";
        state.meta.durationMs = Date.now() - state.startedAt;
        markRunPhase(state, "reconnecting", {
          connection: "recovering",
          retryAttempt: Number(state.activity?.retryAttempt || 0) + 1,
        });
        return true;
      }
      closeStreamingBlocks(state);
      state.terminal = "error";
      state.footer = null;
      updateSessionFailure(state.session, failure);
      state.meta.durationMs = Date.now() - state.startedAt;
      markRunPhase(state, "error", { connection: "connected" });
      return true;
    }

    return false;
  }

  function markRunError(state, error) {
    if (error && typeof error === "object" && !error.engine && state?.meta?.engine) {
      try { error.engine = state.meta.engine; } catch {}
    }
    const failure = classifyCodexFailure(error);
    const disconnected = /app-server\s+(?:exited|ended before)|broken pipe|write after end/i.test(errorText(error));
    closeStreamingBlocks(state);
    state.terminal = "error";
    state.footer = null;
    state.failure = failure;
    state.errorMsg = failureDetailText(failure).slice(0, 1500);
    state.meta.durationMs = Date.now() - state.startedAt;
    updateSessionFailure(state.session, failure);
    markRunPhase(state, "error", {
      connection: disconnected ? "disconnected" : (state.activity?.connection || "connected"),
    });
    return state;
  }

  function markRunRecovering(state, failure, attempt) {
    closeStreamingBlocks(state);
    state.terminal = "running";
    state.footer = "recovering";
    state.failure = normalizeFailure(failure);
    state.errorMsg = failureDetailText(failure).slice(0, 1500);
    state.meta.durationMs = Date.now() - state.startedAt;
    state.meta.recoveryAttempt = attempt;
    markRunPhase(state, failure?.kind === "stream_disconnect" ? "recovering" : "reconnecting", {
      connection: "recovering",
      retryAttempt: attempt,
    });
    return state;
  }

  function markRunInterrupted(state) {
    closeStreamingBlocks(state);
    state.terminal = "interrupted";
    state.footer = null;
    state.meta.durationMs = Date.now() - state.startedAt;
    updateSessionFailure(state.session, {
      kind: "user_stop",
      label: "用户停止",
      recoverable: false,
      message: "任务已被用户停止。",
      suggestion: "",
      detail: "",
      at: Date.now(),
    });
    markRunPhase(state, "interrupted", { connection: "disconnected" });
    return state;
  }

  function ensureRunDone(state, finalText = "") {
    if (state.terminal === "error" || state.terminal === "interrupted") return state;
    const answer = String(finalText || "").trim();
    if (answer) {
      const tools = state.blocks.filter((block) => block.kind === "tool");
      state.blocks = [{ kind: "text", content: answer, streaming: false }, ...tools];
    } else if (state.blocks.length === 0) {
      appendRunText(state, state.meta.engine === 'antigravity' ? '(Antigravity 没有返回内容)' : state.meta.engine === 'claude' ? '(Claude 没有返回内容)' : '(Codex 没有返回内容)');
    }
    closeStreamingBlocks(state);
    state.terminal = "done";
    state.footer = null;
    state.meta.durationMs = Date.now() - state.startedAt;
    clearSessionFailure(state.session);
    markRunPhase(state, "done", { connection: "connected" });
    return state;
  }

  function shouldRecoverCodexRun(failure, attempt) {
    const item = normalizeFailure(failure) || classifyCodexFailure(failure);
    if (!CONFIG.streamRecoveryEnabled) return false;
    if (!item.recoverable || item.kind !== "stream_disconnect") return false;
    const maxAttempts = Math.max(0, Number(CONFIG.streamRecoveryMaxAttempts) || 0);
    return Number(attempt || 0) < maxAttempts;
  }

  function recoveryEventFromFailure(event, state, failure, attempt) {
    const original = String(state.userContent || userTextFromContent(event.content) || "").trim();
    const partial = resultTextFromState(state);
    const partialBlock = partial
      ? [
        "",
        "上一轮已经输出过以下内容摘要/片段，请不要重复：",
        "",
        partial.slice(-3000),
      ].join("\n")
      : "";
    const prompt = [
      `上一轮 Codex 因「${failure.label}」在完成前中断。现在进行第 ${attempt} 次断点续跑。`,
      "",
      "请先根据当前 thread、工作区和已经完成的操作判断进度，然后从断点继续。",
      "不要重复已经完成的文件修改、网页操作或已输出内容；如果无法安全继续，请直接说明原因并停止。",
      partialBlock,
      "",
      "原始用户请求：",
      "",
      original || "(原始请求为空或只有附件)",
    ].filter(Boolean).join("\n");
    return {
      ...event,
      content: JSON.stringify({ text: prompt }),
      attachments: [],
    };
  }

  function renderRunCard(state) {
    const elements = [];
    const elapsed = formatDuration(Date.now() - state.startedAt);
    const goal = state.goalMode ? normalizeGoal(state.goal || state.session.lastGoal) : null;

    if (CONFIG.debugCards) {
      elements.push(noteMd(`会话：${state.session.title} (${state.session.id})`));
      elements.push(noteMd(`工作区：${CONFIG.workspace}`));
      if (state.threadId) elements.push(noteMd(`Codex 线程：${state.threadId}`));
    }

    if (goal) {
      elements.push(markdown(goalRunHeaderMarkdown(state, goal, elapsed)));
    }

    if (state.blocks.length === 0 && state.terminal === "running") {
      elements.push(markdown(state.goalMode
        ? "**正在推进目标**\n\nCodex goal 已进入运行态，后续普通消息会作为当前目标的补充指令处理。"
        : "**正在处理**\n\n我已经收到消息，正在整理回复。"));
    }

    const liveStatusElements = state.terminal === "running"
      ? [markdown(renderRunActivityMarkdown(state, Date.now(), displayToolName))]
      : [];
    const finalized = state.terminal !== "running";
    elements.push(...renderRunBlocks(state.blocks, finalized, liveStatusElements));
    if (finalized && state.formulaSources?.length) {
      elements.push(formulaSourcePanel(state.formulaSources));
    }

    if (state.terminal === "running") {
      elements.push(noteMd(renderFooterText(state.footer, elapsed)));
    } else if (state.terminal === "interrupted") {
      elements.push(noteMd(`已停止 · ${elapsed}`));
    } else if (state.terminal === "error") {
      const failure = state.failure || classifyCodexFailure(state.errorMsg);
      elements.push(noteMd(`${failure.label} · ${elapsed}`));
      elements.push(markdown(`**${failure.message}**${failure.suggestion ? `\n\n${failure.suggestion}` : ""}`));
      if (state.errorMsg) elements.push(markdown(`\`\`\`\n${truncateCardText(state.errorMsg, 1500)}\n\`\`\``));
    } else {
      elements.push(noteMd(renderDoneMeta(state)));
    }

    return {
      schema: "2.0",
      config: {
        streaming_mode: state.terminal === "running",
        summary: { content: cardSummary(state) },
      },
      header: {
        title: { tag: "plain_text", content: cardTitle(state) },
        template: state.terminal === "error" ? "red" : state.terminal === "running" ? "blue" : "default",
      },
      body: { elements },
    };
  }

  function goalRunHeaderMarkdown(state, goal, elapsed) {
    const parts = [`状态：${goalStatusLabel(goal.status)}`, `运行：${elapsed}`];
    if (goal.tokensUsed) parts.push(`已用 ${formatNumber(goal.tokensUsed)} tokens`);
    if (goal.tokenBudget) parts.push(`预算 ${formatNumber(goal.tokenBudget)} tokens`);
    if (state.goalSteerCount) parts.push(`补充指令 ${formatNumber(state.goalSteerCount)} 条`);
    return [
      `**Codex goal：${goalStatusLabel(goal.status)}**`,
      "",
      truncateCardText(goal.objective, 800),
      "",
      parts.join(" · "),
      "操作：/goal pause · /goal resume · /goal clear · /stop",
    ].join("\n");
  }

  function staleCardUpdateSequence(record) {
    const recorded = Math.floor(Number(record?.sequence || 0));
    const epochSeconds = Math.floor(Date.now() / 1000);
    return Math.max(1, recorded + 1, epochSeconds);
  }

  function renderStaleRunCard(record) {
    const startedAt = Number(record?.startedAt || 0);
    const updatedAt = Number(record?.updatedAt || 0);
    return {
      schema: "2.0",
      config: {
        streaming_mode: false,
        summary: { content: "Bridge 已重启，上一轮状态已失效" },
      },
      header: {
        title: { tag: "plain_text", content: "Bridge 已重启" },
        template: "red",
      },
      body: {
        elements: [
          markdown(`**上一轮 ${CONFIG.engine === 'antigravity' ? 'Antigravity' : CONFIG.engine === 'claude' ? 'Claude Code' : 'Codex'} 任务状态已丢失**\n\nBridge 启动时发现这张卡片仍处于运行状态，但原进程已经不在当前 Bridge 内。为避免误判为仍在执行，已将它标记为中断。`),
          noteMd(`原始消息：${record?.messageId || ""}`),
          noteMd(`会话：${record?.sessionId || ""}`),
          startedAt ? noteMd(`开始时间：${formatTime(startedAt)}`) : null,
          updatedAt ? noteMd(`最后记录：${formatTime(updatedAt)}`) : null,
        ].filter(Boolean),
      },
    };
  }

  async function updateCardById(cardId, card, { sequence } = {}) {
    if (!cardId) return false;
    const nextSequence = Math.max(1, Math.floor(Number(sequence || 0)));
    await larkJsonWithData([
      "api",
      "PUT",
      `/open-apis/cardkit/v1/cards/${cardId}`,
      "--as",
      "bot",
    ], { card: { type: "card_json", data: JSON.stringify(card) }, sequence: nextSequence }, { timeoutMs: 60_000, attempts: 2 });
    return true;
  }

  async function repairStaleActiveRunsOnStartup() {
    const entries = Object.values(activeRuns.runs || {});
    if (!entries.length) return;
    log("INFO", "repairing stale active runs", { count: entries.length });
    let repaired = 0;
    const remaining = {};
    for (const record of entries) {
      try {
        if (record?.cardId) {
          await updateCardById(record.cardId, renderStaleRunCard(record), {
            sequence: staleCardUpdateSequence(record),
          });
        }
        repaired += 1;
      } catch (error) {
        const key = String(record?.messageId || "").trim();
        if (key) {
          remaining[key] = {
            ...record,
            repairAttempts: Number(record?.repairAttempts || 0) + 1,
            lastRepairAt: Date.now(),
            lastRepairError: String(error.message || error).slice(0, 1000),
          };
        }
        log("WARN", "stale active run card update failed", {
          messageId: record?.messageId || "",
          cardId: record?.cardId || "",
          error: String(error.message || error).slice(0, 1000),
        });
      }
    }
    activeRuns.runs = remaining;
    saveActiveRuns();
    log("INFO", "stale active runs repaired", { repaired, remaining: Object.keys(remaining).length });
  }

  function renderRunBlocks(blocks, finalized, beforeFirstTool = []) {
    if (finalized && !CONFIG.debugCards) {
      const elements = [];
      const tools = [];
      for (const block of blocks) {
        if (block.kind === "tool") {
          tools.push(block.tool);
        } else if (block.kind === "formula_image") {
          elements.push(formulaImageElement(block));
        } else if (block.content.trim()) {
          elements.push(markdown(truncateCardText(block.content, 18_000)));
        }
      }
      if ((CONFIG.debugCards || CONFIG.showFinalSteps) && tools.length > 0) {
        elements.push(...renderToolGroup(tools, true));
      }
      return elements;
    }

    const elements = [];
    let toolBuffer = [];
    let statusInserted = false;
    const flushTools = () => {
      if (toolBuffer.length > 0) {
        if (!statusInserted) {
          elements.push(...beforeFirstTool);
          statusInserted = true;
        }
        elements.push(...renderToolGroup(toolBuffer, finalized));
        toolBuffer = [];
      }
    };

    for (const block of blocks) {
      if (block.kind === "tool") {
        toolBuffer.push(block.tool);
        continue;
      }
      flushTools();
      if (block.kind === "formula_image") {
        elements.push(formulaImageElement(block));
        continue;
      }
      if (block.content.trim()) {
        elements.push(markdown(truncateCardText(block.content, 18_000)));
      }
    }
    flushTools();
    if (!statusInserted) elements.push(...beforeFirstTool);
    return elements;
  }

  function formulaImageElement(block) {
    return {
      tag: "img",
      img_key: block.imgKey,
      alt: { tag: "plain_text", content: block.alt || "数学公式" },
      title: { tag: "plain_text", content: block.title || "公式" },
      scale_type: "fit_horizontal",
      corner_radius: "8px",
      preview: true,
      margin: "0px 0px 8px 0px",
    };
  }

  function formulaSourcePanel(sources) {
    const body = [...new Set(sources.map((source) => String(source || "").trim()).filter(Boolean))]
      .map((source, index) => `${index + 1}. ${source}`)
      .join("\n\n");
    return {
      tag: "collapsible_panel",
      expanded: false,
      background_color: "grey-50",
      border: { color: "blue-100", corner_radius: "8px" },
      padding: "8px",
      header: {
        title: { tag: "plain_text", content: "查看可复制的 LaTeX 源码" },
        width: "fill",
        icon: {
          tag: "standard_icon",
          token: "code_outlined",
          color: "blue",
          size: "16px",
        },
        icon_position: "left",
      },
      elements: [{
        tag: "markdown",
        content: cardMarkdownContent(`\`\`\`latex\n${truncateCardText(body, 8000)}\n\`\`\``),
        text_size: "notation",
      }],
    };
  }

  function renderToolGroup(tools, finalized) {
    const visibleTools = CONFIG.debugCards ? tools : tools.filter(shouldShowToolInCard);
    if (visibleTools.length === 0) return [];
    if (CONFIG.debugCards) {
      return visibleTools.map((tool) => toolCardPanel(tool, tool.status === "running" || tool.status === "error"));
    }
    if (finalized) {
      const detailTools = visibleTools.filter((tool) => tool.status === "error");
      return [
        toolSummaryPanel(visibleTools, true),
        ...detailTools.map((tool) => toolCardPanel(tool, true)),
      ];
    }
    const prior = visibleTools.slice(0, -1);
    const latest = visibleTools[visibleTools.length - 1];
    const elements = [];
    if (prior.length > 0) elements.push(toolSummaryPanel(prior, false, {
      total: visibleTools.length,
      followedByLatest: Boolean(latest),
    }));
    if (latest) elements.push(toolCardPanel(latest, true));
    return elements;
  }

  function toolSummaryPanel(tools, finalized, options = {}) {
    const counts = toolStatusCounts(tools);
    const total = Number.isFinite(Number(options.total)) ? Number(options.total) : tools.length;
    const visibleRunningTools = finalized ? tools : limitRunningToolDetails(tools);
    const body = finalized
      ? toolSummaryFinalBody(tools, counts)
      : toolSummaryRunningBody(visibleRunningTools, {
          omitted: Math.max(0, tools.length - visibleRunningTools.length),
          followedByLatest: Boolean(options.followedByLatest),
        });
    return {
      tag: "collapsible_panel",
      expanded: !finalized,
      header: panelHeader(`**${toolSummaryTitle(total, counts, finalized)}**`),
      border: { color: counts.error ? "red" : "blue", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [{ tag: "markdown", content: cardMarkdownContent(body || "_暂无步骤_"), text_size: "notation" }],
    };
  }

  function limitRunningToolDetails(tools) {
    const limit = Math.max(1, Math.floor(Number(CONFIG.maxRunningToolDetails || 20)));
    if (tools.length <= limit) return tools;
    return tools.slice(-limit);
  }

  function toolSummaryRunningBody(tools, { omitted = 0, followedByLatest = false } = {}) {
    const lines = [];
    if (omitted > 0) {
      lines.push(`只显示最近 ${tools.length} 个历史步骤；更早 ${omitted} 个已折叠，完整过程仍在本机日志中。`);
      lines.push("");
    }
    if (followedByLatest) {
      lines.push("当前步骤在下方展开。");
      lines.push("");
    }
    lines.push(...tools.map((tool) => `- ${toolHeaderText(tool, false)}`));
    return lines.join("\n");
  }

  function toolStatusCounts(tools) {
    return tools.reduce((counts, tool) => {
      if (tool.status === "error") counts.error += 1;
      else if (tool.status === "running") counts.running += 1;
      else counts.done += 1;
      return counts;
    }, { done: 0, error: 0, running: 0 });
  }

  function toolSummaryTitle(total, counts, finalized) {
    if (!finalized) return `${total} 个步骤已记录`;
    const parts = [`${total} 个步骤已完成`];
    if (counts.error) parts.push(`${counts.error} 个需查看`);
    return parts.join(" · ");
  }

  function toolSummaryFinalBody(tools, counts) {
    const lines = [`完成 ${counts.done} 个，失败 ${counts.error} 个，运行中 ${counts.running} 个。`];
    const visibleTools = limitRunningToolDetails(tools);
    const omitted = Math.max(0, tools.length - visibleTools.length);
    if (counts.error) {
      lines.push("");
      lines.push("失败步骤已在下方展开；多数探索命令未命中不一定影响最终结论。");
    } else {
      lines.push("");
      lines.push("成功步骤已折叠，保留最终结果和必要元信息。");
    }
    const names = [...new Set(tools.map((tool) => displayToolName(tool)).filter(Boolean))].slice(0, 6);
    if (names.length) lines.push(`工具：${names.join(" · ")}`);
    if (omitted > 0) {
      lines.push(`只显示最近 ${visibleTools.length} 个调用明细；更早 ${omitted} 个已折叠，完整过程仍在本机日志中。`);
    }
    const auditLines = visibleTools.map((tool, index) => `${omitted + index + 1}. ${toolHeaderText(tool, false)}`);
    if (auditLines.length) {
      lines.push("");
      lines.push("调用明细：");
      lines.push(truncateCardText(auditLines.join("\n"), 6000));
    }
    return lines.join("\n");
  }

  function toolCardPanel(tool, expanded = false) {
    const input = typeof tool.input === "string" ? tool.input : safeJson(tool.input);
    const body = toolBodyMarkdown(tool, input);
    return {
      tag: "collapsible_panel",
      expanded,
      header: panelHeader(toolHeaderText(tool, true)),
      border: { color: tool.status === "error" ? "red" : "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [{ tag: "markdown", content: cardMarkdownContent(body), text_size: "notation" }],
    };
  }

  function panelHeader(content) {
    return {
      title: { tag: "markdown", content: cardMarkdownContent(content) },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    };
  }

  function toolHeaderText(tool, includeSummary) {
    const status = tool.status === "done" ? "完成" : tool.status === "error" ? "失败" : "运行中";
    const summary = includeSummary ? summarizeToolInput(tool) : "";
    return summary
      ? `**${displayToolName(tool)}** · ${status} · ${summary}`
      : `**${displayToolName(tool)}** · ${status}`;
  }

  function toolBodyMarkdown(tool, input) {
    if (!CONFIG.debugCards) {
      const summary = summarizeToolInput(tool);
      const visibleOutput = visibleToolOutput(tool);
      const output = visibleOutput ? `\n\n**输出**\n\`\`\`\n${truncateCardText(visibleOutput, 1200)}\n\`\`\`` : "";
      const emptyNote = tool.output ? "\n\n_输出已隐藏，以保持卡片简洁_" : "\n\n_无输出_";
      if (tool.status === "running") {
        return summary ? `正在执行：\`${summary}\`` : "_正在执行_";
      }
      if (tool.status === "error") {
        return tool.output
          ? `**错误**\n\`\`\`\n${truncateCardText(tool.output, 1200)}\n\`\`\``
          : "_执行失败，详情已写入本机日志_";
      }
      if (summary) return `已执行：\`${summary}\`${output || emptyNote}`;
      return output ? `已完成${output}` : `已完成${emptyNote}`;
    }

    const output = tool.output ? `\n\n**输出**\n\`\`\`\n${truncateCardText(tool.output, 1200)}\n\`\`\`` : "";
    return input ? `**输入**\n\`\`\`\n${truncateCardText(input, 1200)}\n\`\`\`${output}` : (output || "_运行中_");
  }

  function shouldShowToolInCard(tool) {
    return !isBridgeInternalTool(tool);
  }

  function visibleToolOutput(tool) {
    if (!tool?.output) return "";
    if (isBridgeInternalTool(tool) || looksLikeBridgePrompt(tool.output)) return "";
    const command = commandTextFromInput(tool?.input);
    const output = String(tool.output);
    if (!shouldShowSuccessfulToolOutput(command, output)) return "";
    if (isVerboseCommand(command) || isVerboseOutput(output)) return "";
    return output;
  }

  function isBridgeInternalTool(tool) {
    const inputText = [
      commandTextFromInput(tool?.input),
      typeof tool?.input === "string" ? tool.input : safeJson(tool?.input),
    ].join("\n").toLowerCase().replace(/\\/g, "/");
    return inputText.includes(".codex-feishu-runtime/codex-prompts")
      || inputText.includes(".codex-feishu-runtime/codex-output")
      || inputText.includes("/codex-prompts/")
      || inputText.includes("/codex-output/");
  }

  function looksLikeBridgePrompt(output) {
    const text = String(output || "");
    return text.includes("你是通过飞书消息被唤起的本机 Codex")
      || text.includes("飞书事件信息:")
      || text.includes("当前会话:")
      || text.includes("最近上下文:")
      || text.includes("Local image attachments:");
  }

  function isVerboseCommand(command) {
    const text = String(command || "").toLowerCase();
    return /\bget-content\b/.test(text)
      || /\bselect-string\b/.test(text)
      || /\brg\b/.test(text)
      || /\btype\b/.test(text)
      || /\bcat\b/.test(text)
      || text.includes("codex-feishu-bridge.mjs")
      || text.includes("start-codex-feishu-bridge.ps1")
      || text.includes("stop-codex-feishu-bridge.ps1")
      || text.includes("watch-codex-feishu-bridge.ps1")
      || text.includes("readme-codex-feishu-bridge.md");
  }

  function isVerboseOutput(output) {
    const text = String(output || "");
    if (text.length > 900) return true;
    const lines = text.split(/\r?\n/).length;
    if (lines > 18) return true;
    return looksLikeBridgePrompt(text);
  }

  function shouldShowSuccessfulToolOutput(command, output) {
    const cmd = String(command || "").toLowerCase();
    const text = String(output || "").trim();
    if (!text) return false;
    if (cmd.includes("lark-cli event status")) return true;
    if (cmd.includes("node --check")) return true;
    if (cmd.includes("git status") || cmd.includes("git diff --stat")) return true;
    if (cmd.includes("get-process") || cmd.includes("test-path") || cmd.includes("resolve-path")) return true;
    return text.length <= 360 && text.split(/\r?\n/).length <= 8;
  }

  function displayToolName(toolOrName) {
    const raw = typeof toolOrName === "object"
      ? String(toolOrName?.name || "tool")
      : String(toolOrName || "tool");
    const source = typeof toolOrName === "object" ? String(toolOrName?.source || "") : "";
    const lower = raw.toLowerCase();
    if (lower === "app_server_fallback") return "Bridge · app_server_fallback";
    if (lower === "command_execution" || lower === "exec_command" || lower === "bash") {
      return `${classifyCommandToolName(commandTextFromInput(toolOrName?.input))} · ${raw}`;
    }
    if (source === "mcp") return `MCP · ${raw}`;
    if (source === "dynamic") return `${dynamicToolDisplayCategory(raw)} · ${raw}`;
    if (source === "collab_agent") return `Agent · ${raw}`;
    if (lower === "read" || lower === "file_read") return `File · ${raw}`;
    if (lower === "write" || lower === "file_write") return `File · ${raw}`;
    if (lower === "edit" || lower === "apply_patch") return `File · ${raw}`;
    if (lower === "plan") return `Plan · ${raw}`;
    if (lower === "web_search") return `Web · ${raw}`;
    if (lower === "image_view") return `Image · ${raw}`;
    if (lower === "image_generation") return `Image · ${raw}`;
    if (lower.includes("mcp") || lower.startsWith("mcp__")) return `MCP · ${raw}`;
    if (lower.startsWith("skill:") || lower.startsWith("skill.")) return `Skill · ${raw}`;
    if (lower.startsWith("plugin:") || lower.startsWith("plugin.")) return `Plugin · ${raw}`;
    if (looksLikeNamespacedTool(raw)) return `${dynamicToolDisplayCategory(raw)} · ${raw}`;
    if (lower.includes("search") || lower === "grep" || lower === "rg") return `Search · ${raw}`;
    return `Tool · ${raw}`;
  }

  function dynamicToolDisplayCategory(name) {
    const raw = String(name || "tool");
    const lower = raw.toLowerCase();
    const namespace = lower.split(".")[0];
    if (lower.startsWith("mcp__") || namespace.startsWith("mcp__")) return "MCP";
    if (namespace === "web") return "Web";
    if (namespace === "image_gen" || namespace === "imagegen" || namespace === "image") return "Image";
    if (namespace === "functions") return "Developer Tool";
    if (namespace === "multi_tool_use") return "Tool";
    if (namespace === "tool_search") return "Tool Search";
    if (lower.includes("browser")) return "Browser";
    if (lower.includes("desktop")) return "Desktop";
    if (lower.includes("android")) return "Android";
    if (lower.includes("tavily") || lower.includes("context7") || lower.includes("discord")) return "MCP";
    return "Tool";
  }

  function looksLikeNamespacedTool(name) {
    return /^[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)?\.[A-Za-z0-9_-]+$/.test(String(name || ""));
  }

  function summarizeToolInput(tool) {
    const input = tool.input;
    if (!input) return "";
    const command = commandTextFromInput(input);
    if (command) return summarizeCommand(command);
    if (typeof input === "string") return summarizeCommand(input);
    if (typeof input !== "object") return "";

    const record = input;
    for (const key of ["cmd", "command", "query", "pattern", "path", "file_path", "url"]) {
      if (typeof record[key] === "string" && record[key].trim()) {
        return key === "cmd" || key === "command"
          ? summarizeCommand(record[key])
          : truncateOneLine(record[key], 80);
      }
    }
    return "";
  }

  function toolInputFromItem(item) {
    if (item.input !== undefined) return item.input;
    if (item.arguments !== undefined) return item.arguments;
    if (item.command !== undefined) return item.command;
    return "";
  }

  function toolStatusFromItem(item) {
    const code = Number(item.exit_code);
    if (Number.isFinite(code) && code !== 0) return "error";
    const status = String(item.status || "").toLowerCase();
    if (["error", "failed", "failure"].includes(status)) return "error";
    return "done";
  }

  function toolOutputFromItem(item) {
    for (const key of ["aggregated_output", "output", "result", "text"]) {
      if (item[key] !== undefined && item[key] !== null && String(item[key]).trim()) {
        return typeof item[key] === "string" ? item[key] : safeJson(item[key]);
      }
    }
    return "";
  }

  function toolSourceFromItem(item) {
    const type = String(item?.type || "").toLowerCase();
    const name = String(item?.name || "").toLowerCase();
    if (type.includes("mcp") || name.includes("mcp")) return "mcp";
    if (type.includes("command") || type === "bash" || name === "bash") return "command";
    if (type.includes("file") || ["read", "write", "edit", "apply_patch"].includes(name)) return "file";
    if (type.includes("web") || name.startsWith("web_")) return "web";
    if (type.includes("image") || name.startsWith("image_")) return "image";
    if (type.includes("plan") || name === "plan") return "plan";
    if (type.includes("agent")) return "collab_agent";
    return "";
  }

  function toolSourceFromAppServerItem(item) {
    switch (item?.type) {
      case "commandExecution":
        return "command";
      case "fileChange":
        return "file";
      case "mcpToolCall":
        return "mcp";
      case "dynamicToolCall":
        return "dynamic";
      case "collabAgentToolCall":
        return "collab_agent";
      case "webSearch":
        return "web";
      case "imageView":
      case "imageGeneration":
        return "image";
      case "plan":
        return "plan";
      default:
        return toolSourceFromItem(item || {});
    }
  }

  function toolNameFromAppServerItem(item) {
    switch (item?.type) {
      case "commandExecution":
        return "command_execution";
      case "fileChange":
        return "apply_patch";
      case "mcpToolCall":
        return [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool_call";
      case "dynamicToolCall":
        return [item.namespace, item.tool].filter(Boolean).join(".") || "dynamic_tool_call";
      case "collabAgentToolCall":
        return item.tool || "collab_agent";
      case "webSearch":
        return "web_search";
      case "imageView":
        return "image_view";
      case "imageGeneration":
        return "image_generation";
      case "plan":
        return "plan";
      default:
        return item?.type || "tool";
    }
  }

  function toolInputFromAppServerItem(item) {
    switch (item?.type) {
      case "commandExecution":
        return item.command || "";
      case "fileChange":
        return { changes: item.changes || [] };
      case "mcpToolCall":
        return item.arguments ?? "";
      case "dynamicToolCall":
        return item.arguments ?? "";
      case "collabAgentToolCall":
        return item.prompt || item.tool || "";
      case "webSearch":
        return item.query || "";
      case "imageView":
        return item.path || "";
      case "imageGeneration":
        return item.revisedPrompt || item.result || "";
      case "plan":
        return item.text || "";
      default:
        return toolInputFromItem(item || {});
    }
  }

  function toolOutputFromAppServerItem(item) {
    if (!item || typeof item !== "object") return "";
    if (item.type === "commandExecution") return item.aggregatedOutput || "";
    if (item.type === "mcpToolCall") {
      if (item.error?.message) return item.error.message;
      if (item.result) return mcpResultToText(item.result);
    }
    if (item.type === "dynamicToolCall" && Array.isArray(item.contentItems)) {
      return item.contentItems.map(dynamicToolContentToText).filter(Boolean).join("\n");
    }
    if (item.type === "fileChange") return summarizeFileChanges(item.changes || []);
    if (item.type === "imageGeneration") return item.savedPath || item.result || "";
    return toolOutputFromItem(item);
  }

  function mcpResultToText(result) {
    if (!result) return "";
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((item) => {
          if (typeof item === "string") return item;
          if (item?.type === "text" && typeof item.text === "string") return item.text;
          return safeJson(item);
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
    if (result.structuredContent) return safeJson(result.structuredContent);
    return "";
  }

  function dynamicToolContentToText(item) {
    if (!item) return "";
    if (typeof item === "string") return item;
    if (item.type === "inputText") return item.text || "";
    if (item.type === "inputImage") return item.imageUrl || "";
    return safeJson(item);
  }

  function summarizeFileChanges(changes) {
    if (!Array.isArray(changes) || !changes.length) return "";
    return changes
      .slice(0, 12)
      .map((change) => {
        const pathText = change.path || change.filePath || change.absolutePath || safeJson(change).slice(0, 120);
        const action = change.type || change.kind || "change";
        return `${action}: ${pathText}`;
      })
      .join("\n");
  }

  function commandTextFromInput(input) {
    if (!input) return "";
    if (Array.isArray(input)) return input.map((part) => String(part)).join(" ");
    if (typeof input === "string") return input;
    if (typeof input !== "object") return "";
    for (const key of ["cmd", "command", "script"]) {
      const value = input[key];
      if (Array.isArray(value)) return value.map((part) => String(part)).join(" ");
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  }

  function classifyCommandToolName(command) {
    const text = normalizeCommandForDisplay(command);
    const lower = text.toLowerCase();
    if (/^lark-cli\b/.test(lower)) return "飞书 CLI";
    if (/^node\s+--check\b/.test(lower)) return "Node 检查";
    if (/^node\b/.test(lower)) return "Node.js";
    if (/^git\b/.test(lower)) return "Git";
    if (/^(?:rg\s+--files|fd\b|dir\b|ls\b|get-childitem\b)/i.test(text)) return "Glob";
    if (/^(?:rg|grep|findstr|select-string)\b/i.test(text)) return "搜索";
    if (/^get-content\b/i.test(text)) {
      return lower.includes(".log") || lower.includes("-tail") ? "读取日志" : "读取文件";
    }
    if (/^(?:test-path|resolve-path)\b/i.test(text)) return "路径检查";
    if (/^get-process\b/i.test(text)) return "进程检查";
    if (/\b(?:powershell|pwsh)(?:\.exe)?\b|Set-Content|Remove-Item|New-Item|Start-Process|\$env:/i.test(text)) {
      return "PowerShell";
    }
    return "Shell";
  }

  function summarizeCommand(command) {
    const text = normalizeCommandForDisplay(command);
    return truncateOneLine(text || "PowerShell 命令", 90);
  }

  function normalizeCommandForDisplay(command) {
    let text = String(command || "").replace(/\s+/g, " ").trim();
    text = text.replace(/^["']?(?:[A-Z]:)?[\\/]+Windows[\\/]+System32[\\/]+WindowsPowerShell[\\/]+v1\.0[\\/]+powershell(?:\.exe)?["']?\s*/i, "");
    text = text.replace(/^["']?(?:powershell|pwsh)(?:\.exe)?["']?\s*/i, "");
    text = text.replace(/^-NoProfile\s+/i, "");
    text = text.replace(/^-ExecutionPolicy\s+\S+\s+/i, "");
    text = text.replace(/^-Command\s+/i, "");
    text = text.trim();
    const quoted = text.match(/^(['"])([\s\S]*)\1$/);
    return quoted ? quoted[2].trim() : text;
  }

  function truncateOneLine(text, max) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max)}...` : value;
  }

  function renderFooterText(footer, elapsed) {
    if (footer === "compacting") return `正在压缩上下文 · ${elapsed}`;
    if (footer === "recovering") return `正在从断流处继续 · ${elapsed}`;
    if (footer === "reconnecting") return `Codex 连接中断，正在重连 · ${elapsed}`;
    if (footer === "waiting") return `Codex 仍在处理，暂无新输出 · ${elapsed}`;
    if (footer === "tool_running") return `正在调用工具 · ${elapsed}`;
    if (footer === "streaming") return `正在输出 · ${elapsed}`;
    return `正在思考 · ${elapsed}`;
  }

  function renderDoneMeta(state) {
    if (state.meta.engine === 'claude') {
      const used = state.meta.contextUsage?.usedTokens;
      return [used == null ? '当前上下文未知' : `当前请求上下文 ${formatNumber(used)} tokens`,
        '容量未提供', state.meta.compactedAt ? `上次压缩 ${formatTime(state.meta.compactedAt)}` : '未观察到压缩'].join(' · ');
    }
    const parts = [];
    const context = renderContextUsage(state.meta.contextUsage, "当前窗口");
    if (context) parts.push(context);
    const peak = renderContextUsage(state.meta.contextPeakUsage, "曾达");
    if (peak && isContextUsageHigher(state.meta.contextPeakUsage, state.meta.contextUsage)) parts.push(peak);
    parts.push(state.meta.compactedAt ? `上次压缩 ${formatTime(state.meta.compactedAt)}` : "未压缩");
    return parts.length ? parts.join(" · ") : "已完成";
  }

  function renderContextUsage(usage, label = "context") {
    const context = normalizeContextUsage(usage);
    if (!context) return "";
    const parts = [];
    if (context.percent !== null && context.percent !== undefined) parts.push(`${context.percent}%`);
    if (context.usedTokens !== null && context.contextWindow) {
      parts.push(`${formatNumber(context.usedTokens)}/${formatNumber(context.contextWindow)} tokens`);
    } else if (context.usedTokens !== null) {
      parts.push(`${formatNumber(context.usedTokens)} tokens`);
    }
    return parts.length ? `${label} ${parts.join(" / ")}` : "";
  }

  function contextUsageScore(usage) {
    const context = normalizeContextUsage(usage);
    if (!context) return null;
    const percent = Number(context.percent);
    if (Number.isFinite(percent)) return percent;
    const usedTokens = Number(context.usedTokens);
    return Number.isFinite(usedTokens) ? usedTokens : null;
  }

  function isContextUsageHigher(candidate, baseline) {
    const candidateScore = contextUsageScore(candidate);
    if (candidateScore === null) return false;
    const baselineScore = contextUsageScore(baseline);
    return baselineScore === null || candidateScore > baselineScore;
  }

  function nativeGoalCardTitle(state) {
    const goal = normalizeGoal(state.goal || state.session.lastGoal);
    if (state.terminal === "error") return "Codex goal 失败";
    if (goal?.status === "complete") return "Codex goal 已完成";
    if (goal?.status === "paused") return "Codex goal 已暂停";
    if (goal?.status === "blocked") return "Codex goal 受阻";
    if (goal?.status === "usageLimited") return "Codex goal 使用量受限";
    if (goal?.status === "budgetLimited") return "Codex goal 预算受限";
    if (goal?.status === "active") return "Codex goal 进行中";
    if (state.terminal === "interrupted") return "Codex goal 已停止";
    if (state.terminal === "done") return "Codex goal 已结束";
    return "Codex goal 进行中";
  }

  function cardTitle(state) {
    if (state.goalMode) return nativeGoalCardTitle(state);
    if (state.goalMode) {
      const goal = normalizeGoal(state.goal || state.session.lastGoal);
      if (state.terminal === "error") return "Codex goal 失败";
      if (state.terminal === "interrupted") return "Codex goal 已停止";
      if (goal?.status === "complete") return "Codex goal 已完成";
      if (goal?.status === "paused") return "Codex goal 已暂停";
      if (goal?.status === "blocked") return "Codex goal 受阻";
      if (goal?.status === "usageLimited") return "Codex goal 使用量受限";
      if (goal?.status === "budgetLimited") return "Codex goal 预算受限";
      if (state.terminal === "done") return "Codex goal 已结束";
      return "Codex goal 进行中";
    }
    const engine = state.meta?.engine === 'antigravity' ? 'Antigravity' : state.meta?.engine === 'claude' ? 'Claude Code' : 'Codex';
    if (state.terminal === "error") return state.failure?.label || `${engine} 处理失败`;
    if (state.terminal === "interrupted") return `${engine} 已停止`;
    if (state.terminal === "done") return `${engine} 已完成`;
    if (state.footer === "recovering") return `${engine} 正在续跑`;
    if (state.footer === "reconnecting") return `${engine} 正在重连`;
    if (state.footer === "tool_running") return `${engine} 正在执行`;
    if (state.footer === "streaming") return `${engine} 正在回复`;
    return `${engine} 正在思考`;
  }

  function cardSummary(state) {
    if (state.goalMode) {
      const goal = normalizeGoal(state.goal || state.session.lastGoal);
      if (state.terminal === "error") return "goal 失败";
      if (state.terminal === "interrupted") return "goal 已停止";
      if (goal?.status) return `goal ${goalStatusLabel(goal.status)}`;
      return state.terminal === "done" ? "goal 已结束" : "goal 进行中";
    }
    if (state.terminal === "interrupted") return "已停止";
    if (state.terminal === "error") return state.failure?.label || "处理失败";
    if (state.terminal === "done") return "已完成";
    if (state.footer === "recovering") return "正在续跑";
    if (state.footer === "reconnecting") return "正在重连";
    if (state.footer === "tool_running") return "正在调用工具";
    if (state.footer === "streaming") return "正在输出";
    return "正在处理";
  }

  return {
    createRunState,
    appendRunText,
    closeStreamingBlocks,
    ensureToolBlock,
    updateToolFromAppServerItem,
    appendToolOutputDelta,
    reduceCodexJsonEvent,
    reduceAppServerEvent,
    markRunError,
    markRunRecovering,
    markRunInterrupted,
    ensureRunDone,
    shouldRecoverCodexRun,
    recoveryEventFromFailure,
    renderRunCard,
    goalRunHeaderMarkdown,
    staleCardUpdateSequence,
    renderStaleRunCard,
    updateCardById,
    repairStaleActiveRunsOnStartup,
    renderRunBlocks,
    formulaImageElement,
    formulaSourcePanel,
    renderToolGroup,
    toolSummaryPanel,
    limitRunningToolDetails,
    toolSummaryRunningBody,
    toolStatusCounts,
    toolSummaryTitle,
    toolSummaryFinalBody,
    toolCardPanel,
    panelHeader,
    toolHeaderText,
    toolBodyMarkdown,
    shouldShowToolInCard,
    visibleToolOutput,
    isBridgeInternalTool,
    looksLikeBridgePrompt,
    isVerboseCommand,
    isVerboseOutput,
    shouldShowSuccessfulToolOutput,
    displayToolName,
    dynamicToolDisplayCategory,
    looksLikeNamespacedTool,
    summarizeToolInput,
    toolInputFromItem,
    toolStatusFromItem,
    toolOutputFromItem,
    toolSourceFromItem,
    toolSourceFromAppServerItem,
    toolNameFromAppServerItem,
    toolInputFromAppServerItem,
    toolOutputFromAppServerItem,
    mcpResultToText,
    dynamicToolContentToText,
    summarizeFileChanges,
    commandTextFromInput,
    classifyCommandToolName,
    summarizeCommand,
    normalizeCommandForDisplay,
    truncateOneLine,
    renderFooterText,
    renderDoneMeta,
    renderContextUsage,
    contextUsageScore,
    isContextUsageHigher,
    nativeGoalCardTitle,
    cardTitle,
    cardSummary,
  };
}
