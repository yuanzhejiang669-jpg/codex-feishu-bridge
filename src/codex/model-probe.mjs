// Health checks run on an isolated ephemeral native thread, never on user history.
export async function probeAppServerModel(client, { provider, model, cwd, timeoutMs = 30000 }) {
  client.denyServerRequests = true;
  const started = await client.request('thread/start', {
    modelProvider: provider, model, allowProviderModelFallback: false, ephemeral: true, cwd,
    approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [],
    config: { mcp_servers: {}, features: { shell_tool: false }, web_search: 'disabled' },
    developerInstructions: 'This is a model availability check. Do not use tools, skills, files, network or delegation. Reply only OK.',
  }, timeoutMs);
  if (started.model !== model || started.modelProvider !== provider) throw new Error('模型验证发生了模型或 Provider 回退，未接受此结果');
  const turn = await client.request('turn/start', {
    threadId: started.thread.id, model, effort: 'low',
    input: [{ type: 'text', text: 'Reply only OK.', text_elements: [] }],
  }, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const message = await client.nextNotification(Math.min(1000, deadline - Date.now()));
    if (!message || message.params?.threadId !== started.thread.id) continue;
    const item = message.params.item;
    if (item && /toolcall|commandexecution|filechange|websearch|collab/i.test(item.type || '')) {
      await client.stop(); throw new Error('模型验证尝试调用工具，验证已停止');
    }
    if (message.method === 'item/completed' && item?.type === 'agentMessage') text += item.text || '';
    if (message.method === 'turn/completed' && message.params.turn.id === turn.turn.id) {
      if (message.params.turn.status !== 'completed') {
        const failure = message.params.turn.error || {};
        throw Object.assign(new Error(failure.message || '模型验证未完成'), { data: failure });
      }
      if (!text.trim()) throw new Error('模型验证完成但没有返回文本');
      return { model, provider, status: 'completed', text: text.trim(), verifiedAt: Date.now() };
    }
  }
  throw new Error('模型验证等待回复超时，未记录为可用');
}
