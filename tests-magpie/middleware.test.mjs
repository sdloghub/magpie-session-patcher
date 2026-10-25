import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as middleware from '../session-patcher.middleware.js';

const options = { enabled: true, replacement: '[filtered]' };
const refusal = "I'm sorry, but I cannot help with that request.";
function run(body, protocol = 'chat', extra = {}, ctx = {}) {
  const snapshot = structuredClone(body);
  const result = middleware.onRequest(body, { protocol, options: { ...options, ...extra }, ...ctx });
  assert.deepEqual(body, snapshot, 'must not mutate the object supplied by Magpie');
  return result ?? body;
}
function chat(text) { return { model: 'demo/model', messages: [{ role: 'assistant', content: text }] }; }

test('only request hook exported; current streamed/non-streamed output cannot be changed', () => {
  assert.deepEqual(Object.keys(middleware), ['onRequest']);
});
test('empty settings, disabled, and unsupported protocols pass through', () => {
  const body = chat(refusal);
  assert.equal(middleware.onRequest(body, { protocol: 'chat' }), undefined);
  assert.equal(middleware.onRequest(body, { protocol: 'chat', options: {} }), undefined);
  assert.deepEqual(run(body, 'chat', { enabled: false }), body);
  assert.deepEqual(run(body, 'unknown'), body);
});
test('assistant refusal replaced; user, system, tool results and routing settings preserved', () => {
  const body = { ...chat(refusal), stream: true, temperature: 0.2, reasoning: { effort: 'high' },
    tools: [{ type: 'function', function: { name: 'x' } }], tool_choice: 'auto' };
  body.messages.unshift({ role: 'system', content: refusal }, { role: 'user', content: refusal },
    { role: 'tool', tool_call_id: 'c1', content: refusal });
  const result = run(body);
  assert.deepEqual(result, { ...body, messages: [...body.messages.slice(0, -1), { role: 'assistant', content: '[filtered]' }] });
});
test('Chinese apologies with refusal qualify, apologies alone do not', () => {
  assert.equal(run(chat('很抱歉，我无法协助完成该请求。')).messages[0].content, '[filtered]');
  assert.equal(run(chat('抱歉，刚才有笔误。修正如下。')).messages[0].content, '抱歉，刚才有笔误。修正如下。');
});
test('conservative detection leaves quoted/example/embedded refusal alone', () => {
  for (const text of ['The log says "I cannot help".', '"我不能帮助你" 是示例。', '```\nI cannot assist\n```', 'As an AI system, this module validates requests.']) {
    assert.equal(run(chat(text)).messages[0].content, text);
  }
});
test('legacy rules and custom keywords remain opt-in', () => {
  assert.equal(run(chat('The log says I cannot help.'), 'chat', { detection: 'legacy' }).messages[0].content, '[filtered]');
  assert.equal(run(chat('Status: CUSTOM_MARK'), 'chat', { customKeywords: ['custom_mark', '', 1] }).messages[0].content, '[filtered]');
});
test('agent and model filters apply together; missing identity does not match', () => {
  const body = chat(refusal);
  const extra = { agents: ['codex'], models: ['demo/'] };
  assert.deepEqual(run(body, 'chat', extra), body);
  assert.equal(run(body, 'chat', extra, { agent: 'codex' }).messages[0].content, '[filtered]');
  assert.deepEqual(run(body, 'chat', { ...extra, models: ['other/'] }, { agent: 'codex' }), body);
});
test('split text blocks detected, image and tool blocks and IDs preserved', () => {
  const body = chat([{ type: 'text', text: 'I can' }, { type: 'text', text: 'not help with that.' },
    { type: 'image_url', image_url: { url: 'data:example' } }]);
  body.messages[0].tool_calls = [{ id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } }];
  const out = run(body);
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: '[filtered]' }, body.messages[0].content[2]]);
  assert.deepEqual(out.messages[0].tool_calls, body.messages[0].tool_calls);
});
test('Responses plain assistant history replaced; IDs and user input preserved', () => {
  const body = { model: 'p/m', include: ['reasoning.encrypted_content'], input: [
    { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: refusal, annotations: [{ type: 'url_citation', start_index: 0 }] }] },
    { role: 'user', content: [{ type: 'input_text', text: refusal }] }
  ] };
  const out = run(body, 'responses');
  assert.deepEqual(out.input[0], { ...body.input[0], content: [{ type: 'output_text', text: '[filtered]', annotations: [] }] });
  assert.deepEqual(out.input[1], body.input[1]);
  assert.deepEqual(out.include, body.include);
});
test('Responses cleanReasoning off by default; removes it only from plain message history', () => {
  const body = { input: [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque' }, { role: 'assistant', content: 'Answer' }] };
  assert.deepEqual(run(body, 'responses'), body);
  assert.deepEqual(run(body, 'responses', { cleanReasoning: true }).input, body.input.slice(1));
});
test('Responses native tool dependencies preserve reasoning and call/result pairing', () => {
  for (const type of ['function_call', 'custom_tool_call', 'web_search_call', 'tool_search_call', 'future_tool_call']) {
    const body = { input: [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque' },
      { type, id: 'i1', call_id: 'c1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: refusal },
      { role: 'assistant', content: refusal }] };
    const out = run(body, 'responses', { cleanReasoning: true });
    assert.deepEqual(out.input.slice(0, 3), body.input.slice(0, 3));
    assert.equal(out.input[3].content, '[filtered]');
  }
});
test('opaque Responses references and compaction pass through whole request', () => {
  const tail = [{ role: 'assistant', content: refusal }];
  for (const body of [
    { previous_response_id: 'resp1', input: tail }, { conversation: { id: 'c' }, input: tail },
    { input: [{ type: 'item_reference', id: 'i' }, ...tail] },
    { input: [{ type: 'compaction', encrypted_content: 'opaque' }, ...tail] },
    { input: [{ type: 'unknown', encrypted_content: 'opaque' }, ...tail] },
    { input: tail, context_management: [{ type: 'compaction' }] }
  ]) assert.deepEqual(run(body, 'responses', { cleanReasoning: true, appendPrompt: 'extra' }), body);
  const body = { input: tail };
  assert.deepEqual(run(body, 'responses', { appendPrompt: 'extra' }, { path: '/v1/responses/compact' }), body);
});
test('Responses string input can receive prompt without changing user text', () => {
  assert.deepEqual(run({ input: refusal }, 'responses', { appendPrompt: 'extra' }), { input: refusal, instructions: 'extra' });
});
test('Anthropic reasoning stripped optionally; user/tool blocks unchanged', () => {
  const body = { system: 'base', messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: refusal }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private', signature: 'signed' },
      { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: refusal }] }
  ] };
  const out = run(body, 'anthropic', { cleanReasoning: true });
  assert.deepEqual(out.messages[0], body.messages[0]);
  assert.deepEqual(out.messages[1].content, [{ type: 'text', text: '[filtered]' }]);
});
test('Anthropic tool-use turn retains signed reasoning', () => {
  const body = { messages: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'private', signature: 'signed' },
    { type: 'server_tool_use', id: 't1', name: 'web_search', input: { query: refusal } },
    { type: 'text', text: 'Searching' }
  ] }] };
  assert.deepEqual(run(body, 'anthropic', { cleanReasoning: true }), body);
});
test('thinking-only messages are retained instead of becoming invalid empty messages', () => {
  const body = { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }] }] };
  assert.deepEqual(run(body, 'anthropic', { cleanReasoning: true }), body);
});
test('Chat reasoning fields removed only when nonempty content exists and no tool calls', () => {
  const body = chat('answer');
  Object.assign(body.messages[0], { reasoning: 'private', reasoning_content: 'private' });
  assert.deepEqual(run(body, 'chat', { cleanReasoning: true }), chat('answer'));
  body.messages[0].tool_calls = [{ id: 'c1' }];
  assert.deepEqual(run(body, 'chat', { cleanReasoning: true }), body);
  delete body.messages[0].tool_calls;
  body.messages[0].content = null;
  assert.deepEqual(run(body, 'chat', { cleanReasoning: true }), body);
});
test('Gemini removes text thoughts, not tool results or signed function calls', () => {
  const body = { contents: [
    { role: 'user', parts: [{ text: refusal }, { functionResponse: { name: 'x', response: { text: refusal } } }] },
    { role: 'model', parts: [{ thought: true, text: 'private', thoughtSignature: 'sig' }, { text: refusal }] }
  ] };
  const out = run(body, 'gemini', { cleanReasoning: true });
  assert.deepEqual(out.contents[0], body.contents[0]);
  assert.deepEqual(out.contents[1].parts, [{ text: '[filtered]' }]);
  body.contents[1].parts.push({ functionCall: { name: 'x', args: {} }, thoughtSignature: 'sig' });
  const tools = run(body, 'gemini', { cleanReasoning: true });
  assert.deepEqual(tools.contents[1].parts[0], body.contents[1].parts[0]);
  assert.deepEqual(tools.contents[1].parts[2], body.contents[1].parts[2]);
});
test('signed Gemini text is not rewritten; current generation settings preserved', () => {
  const body = { contents: [{ role: 'model', parts: [{ text: refusal, thoughtSignature: 'sig' }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 5000 } } };
  assert.deepEqual(run(body, 'gemini'), body);
});
test('replacement and independent toggles are idempotent', () => {
  const body = chat(refusal);
  assert.deepEqual(run(body, 'chat', { replaceRefusals: false }), body);
  const extra = { replacement: '我不能帮助（用户自定义替换）', appendPrompt: 'extra' };
  const out = run(body, 'chat', extra);
  assert.deepEqual(run(out, 'chat', extra), out);
  assert.match(run(body, 'chat', { replacement: '' }).messages[0].content, /^\[History filter:/);
});
for (const [protocol, body, expected] of [
  ['responses', { input: [], instructions: 'base' }, { input: [], instructions: 'base\n\nextra' }],
  ['anthropic', { messages: [], system: 'base' }, { messages: [], system: 'base\n\nextra' }],
  ['anthropic', { messages: [], system: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }] },
    { messages: [], system: [{ type: 'text', text: 'base', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'extra' }] }],
  ['chat', { messages: [{ role: 'developer', content: 'base' }, { role: 'user', content: 'hi' }] },
    { messages: [{ role: 'developer', content: 'base' }, { role: 'system', content: 'extra' }, { role: 'user', content: 'hi' }] }],
  ['gemini', { contents: [], system_instruction: { parts: [{ text: 'base' }] } },
    { contents: [], system_instruction: { parts: [{ text: 'base' }, { text: 'extra' }] } }]
]) test(`prompt append preserves original and is idempotent (${protocol}, ${typeof body.system})`, () => {
  const out = run(body, protocol, { appendPrompt: 'extra' });
  assert.deepEqual(out, expected);
  assert.deepEqual(run(out, protocol, { appendPrompt: 'extra' }), expected);
});
test('unknown payloads and ordinary nested data are not recursively scrubbed', () => {
  const body = { messages: [null, { role: 'user', content: { thinking: refusal } },
    { role: 'assistant', content: [{ type: 'future_block', text: refusal, reasoning: 'business data' }] }] };
  assert.deepEqual(run(body, 'chat', { cleanReasoning: true }), body);
  assert.equal(middleware.onRequest(null, { protocol: 'chat', options }), undefined);
});

test('ordinary English idioms and word prefixes are not refusals', () => {
  for (const text of ['I cannot help but notice a typo.', "I can't help but agree.", 'I cannot assistive-test this stub.']) {
    assert.deepEqual(run(chat(text)), chat(text));
  }
  assert.equal(run(chat('I can’t help with that request.')).messages[0].content, '[filtered]');
});
test('invalid option types cannot accidentally enable processing or broaden scope', () => {
  const body = chat(refusal);
  for (const extra of [{ agents: 'codex' }, { models: 'demo/' }, { models: [null] },
    { agents: [''] }, { cleanReasoning: 'false' }, { replaceRefusals: 'false' },
    { appendPrompt: 123 }, { detection: 'typo' }, { customKeywords: 'sorry' }]) {
    assert.deepEqual(run(body, 'chat', extra), body);
  }
});
test('reasoning-only Responses input cannot be reduced to an empty history', () => {
  const body = { input: [{ type: 'reasoning', encrypted_content: 'opaque' }] };
  assert.deepEqual(run(body, 'responses', { cleanReasoning: true }), body);
});
test('signed text blocks in any protocol remain untouched', () => {
  const body = { messages: [{ role: 'assistant', content: [{ type: 'text', text: refusal, signature: 'signed' }] }] };
  assert.deepEqual(run(body, 'anthropic'), body);
});
