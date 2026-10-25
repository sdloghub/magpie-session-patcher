// Real Magpie + a loopback-only mock upstream. No real account/model calls.
// Usage: MAGPIE_TEST_BUN=/path/to/magpie-bun node scripts/magpie-smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'magpie-patcher-smoke-'));
const env = { ...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
  MAGPIE_NO_ACCOUNTS: '1', MAGPIE_PLUGIN_MARKET: 'off' };
// Let the normal host bootstrap run if no existing Bun was supplied. Copy,
// rather than symlink, so a host update cannot alter the user's cached binary.
if (process.env.MAGPIE_TEST_BUN) {
  const dest = join(env.XDG_CACHE_HOME, 'magpie/bun/1.4.2/magpie-bun');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(process.env.MAGPIE_TEST_BUN, dest);
  chmodSync(dest, 0o755);
}
const magpie = process.env.MAGPIE_TEST_BINARY || 'magpie';
function cli(...args) {
  return execFileSync(magpie, args, { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const captured = [];
const liveText = 'I cannot assist: this is the ORIGINAL mock response.';
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  captured.push(body);
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: liveText }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else if (req.url.includes('generateContent')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: liveText }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
  } else if (req.url.includes('/messages')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: 'test-model',
      content: [{ type: 'text', text: liveText }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } }));
  } else if (req.url.includes('responses')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'r1', object: 'response', model: 'test-model', status: 'completed',
      output: [{ id: 'msg1', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: liveText, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: liveText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
});
let child;
let logs = '';
try {
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  env.MAGPIE_ADDR = `127.0.0.1:${gatewayPort}`;
  cli('plugin', 'add', root);
  const loaded = JSON.parse(cli('plugin', '--json'));
  assert.deepEqual(loaded.middleware[root].hooks, ['onRequest']);
  assert.equal(loaded.middleware[root].failures, 0);
  cli('plugin', 'options', root, JSON.stringify({ enabled: true,
    replacement: '[filtered]', cleanReasoning: true, appendPrompt: 'Extra project context.' }));
  cli('provider', 'add', 'Smoke', 'id=smoke', `url=http://127.0.0.1:${upstreamPort}/v1`,
    `responses=http://127.0.0.1:${upstreamPort}/v1`,
    `anthropic=http://127.0.0.1:${upstreamPort}`, `gemini=http://127.0.0.1:${upstreamPort}`,
    'key=local-mock-key', 'models=test-model');
  const added = cli('gateway-key', 'add', 'local-smoke');
  const key = added.match(/sk-magpie-[A-Za-z0-9._~-]+/)?.[0];
  assert.ok(key, 'a local test gateway key must be available');
  child = spawn(magpie, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const base = `http://${env.MAGPIE_ADDR}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Magpie exited: ' + logs);
    try { await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${key}` } }); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'gateway must start');
  async function request(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json'
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(text.includes(liveText), 'current upstream reply must retain its original text');
    return captured.at(-1);
  }
  const refusal = 'I cannot help with that request.';
  for (const stream of [false, true]) {
    const out = await request('/v1/chat/completions', { model: 'smoke/test-model', stream,
      messages: [{ role: 'assistant', content: refusal, reasoning_content: 'old thought' }, { role: 'user', content: 'Continue' }] });
    assert.equal(out.messages.find(message => message.role === 'assistant').content, '[filtered]');
    assert.equal(out.messages.find(message => message.role === 'assistant').reasoning_content, undefined);
    assert.ok(out.messages.some(message => message.content === 'Extra project context.'));
  }
  const out = await request('/v1/responses', { model: 'smoke/test-model', stream: false,
    input: [{ type: 'reasoning', id: 'old-reasoning', encrypted_content: 'old-ciphertext' },
      { role: 'assistant', content: refusal }, { role: 'user', content: 'Continue' }] });
  assert.ok(!out.input.some(item => item.type === 'reasoning'));
  assert.equal(out.input.find(item => item.role === 'assistant').content, '[filtered]');
  assert.ok(out.instructions.includes('Extra project context.'));
  const anthropic = await request('/v1/messages', { model: 'smoke/test-model', max_tokens: 64,
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'old thought', signature: 'old-signature' },
      { type: 'text', text: refusal }] }, { role: 'user', content: 'Continue' }] });
  const assistant = anthropic.messages.find(message => message.role === 'assistant');
  assert.ok(assistant.content.some(part => part.text === '[filtered]'));
  assert.ok(!assistant.content.some(part => part.type === 'thinking'));
  assert.ok(typeof anthropic.system === 'string' ? anthropic.system.includes('Extra project context.')
    : anthropic.system.some(part => part.text === 'Extra project context.'));
  const gemini = await request('/v1beta/models/smoke/test-model:generateContent', {
    contents: [{ role: 'model', parts: [{ thought: true, text: 'old thought' }, { text: refusal }] },
      { role: 'user', parts: [{ text: 'Continue' }] }] });
  // Magpie may translate Gemini client requests into the upstream's Chat
  // protocol. Assert on the delivered history in either supported wire form.
  if (gemini.contents) {
    const model = gemini.contents.find(message => message.role === 'model');
    assert.ok(model.parts.some(part => part.text === '[filtered]'));
    assert.ok(!model.parts.some(part => part.thought));
    assert.ok(gemini.systemInstruction.parts.some(part => part.text === 'Extra project context.'));
  } else {
    const model = gemini.messages.find(message => message.role === 'assistant');
    assert.ok(typeof model.content === 'string' ? model.content === '[filtered]'
      : model.content.some(part => part.text === '[filtered]'));
    assert.ok(!JSON.stringify(gemini).includes('old thought'));
    assert.ok(gemini.messages.some(message => message.role === 'system' && (
      typeof message.content === 'string' ? message.content.includes('Extra project context.')
        : message.content.some(part => part.text === 'Extra project context.'))));
  }
  console.log('PASS: real Magpie loads the middleware; Chat JSON + SSE, Responses JSON, Anthropic JSON and Gemini JSON requests are filtered; current response text is unchanged.');
  console.log('Isolated synthetic config and logs: ' + scratch);
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}
