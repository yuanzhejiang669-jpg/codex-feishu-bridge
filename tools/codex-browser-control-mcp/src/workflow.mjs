function pathGet(value, pathText = "") {
  if (!pathText) return value;
  let cursor = value;
  for (const part of String(pathText).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cursor == null) return undefined;
    cursor = cursor[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cursor;
}

export function toolPayload(result) {
  const text = result?.content?.find?.((item) => item?.type === "text")?.text;
  if (typeof text !== "string") return result ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function resolveWorkflowRefs(value, results) {
  if (typeof value === "string") {
    const exact = value.match(/^\$(\d+)(?:\.(.+))?$/);
    if (exact) return pathGet(results[Number(exact[1])], exact[2] || "");
    return value.replace(/\$(\d+)\.([A-Za-z0-9_$.[\]-]+)/g, (match, index, refPath) => {
      const resolved = pathGet(results[Number(index)], refPath);
      return resolved == null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveWorkflowRefs(item, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveWorkflowRefs(item, results)]));
  }
  return value;
}

export async function runBrowserWorkflow(steps, options = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("browser_workflow requires at least one step");
  const maxSteps = Math.max(1, Math.min(Number(options.maxSteps || 25), 50));
  if (steps.length > maxSteps) throw new Error(`browser_workflow accepts at most ${maxSteps} steps`);
  if (typeof options.invoke !== "function") throw new Error("browser_workflow invoke callback is required");

  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || 120000), 600000));
  const results = [];
  let stoppedAt = null;

  for (const [index, step] of steps.entries()) {
    if (!step || typeof step.tool !== "string" || !step.tool.trim()) {
      throw new Error(`browser_workflow step ${index} requires a tool name`);
    }
    const tool = step.tool.trim();
    if (tool === "browser_workflow") throw new Error("browser_workflow cannot invoke itself");
    if (Date.now() - startedAt >= timeoutMs) {
      results.push({ index, tool, ok: false, durationMs: 0, error: `Workflow timed out after ${timeoutMs}ms` });
      stoppedAt = index;
      break;
    }

    const args = resolveWorkflowRefs(step.args || {}, results);
    const stepStartedAt = Date.now();
    try {
      const raw = await options.invoke(tool, args);
      const data = toolPayload(raw);
      const ok = !raw?.isError;
      const entry = {
        index,
        tool,
        ok,
        durationMs: Date.now() - stepStartedAt,
        data,
      };
      results.push(entry);
      if (!ok && step.continueOnError !== true) {
        stoppedAt = index;
        break;
      }
    } catch (error) {
      results.push({
        index,
        tool,
        ok: false,
        durationMs: Date.now() - stepStartedAt,
        error: error.message,
      });
      if (step.continueOnError !== true) {
        stoppedAt = index;
        break;
      }
    }
  }

  return {
    ok: results.length === steps.length && results.every((item) => item.ok),
    durationMs: Date.now() - startedAt,
    completedSteps: results.filter((item) => item.ok).length,
    totalSteps: steps.length,
    stoppedAt,
    results,
  };
}
