import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const LOCAL_URL = 'http://127.0.0.1:11434';
export const LOCAL_MODEL = 'qwen2.5:1.5b';

export function apiKeyName(endpoint) {
  return 'CORTICO_DREAM_API_KEY_' + createHash('sha256').update(endpoint).digest('hex').slice(0, 24).toUpperCase();
}

async function* lines(response) {
  if (!response.body) throw new Error('模型接口没有返回内容。');
  let pending = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const rows = (pending + chunk).split('\n');
    pending = rows.pop();
    for (const row of rows) if (row.trim()) yield row.trim();
  }
  if (pending.trim()) yield pending.trim();
}

export async function requestFragment(prompt, limit, settings, request, signal, apiKey) {
  const remote = settings.modelProvider === 'api';
  const stream = limit > 512;
  const tokens = stream ? limit * 2 + 64 : limit + 16;
  const timeout = AbortSignal.timeout(Math.max(120_000, 30_000 + tokens * 150));
  const messages = [{ role: 'user', content: prompt }];
  const headers = { 'Content-Type': 'application/json' };
  if (remote && apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const body = remote
    ? { model: settings.apiModel, messages, stream, max_tokens: tokens }
    : {
      model: LOCAL_MODEL, messages, stream,
      options: {
        temperature: 1.15, top_p: 0.92, num_predict: tokens, seed: randomInt(2 ** 31),
        num_ctx: stream ? 2 ** Math.ceil(Math.log2(tokens + 512)) : 1024,
      },
    };
  const name = remote ? '兼容 API' : '本机 Ollama';
  let response;
  try {
    response = await request(remote ? settings.apiEndpoint : LOCAL_URL + '/api/chat', {
      method: 'POST', headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`连接${name}失败或生成超时。`, { cause: error });
  }
  if (!response.ok) throw new Error(`${name}返回 HTTP ${response.status}，请检查模型或连接配置。`);
  if (!stream) {
    const result = await response.json();
    return remote ? result.choices?.[0]?.message?.content : result.message?.content;
  }
  let text = '';
  let done = false;
  for await (const row of lines(response)) {
    if (remote && !row.startsWith('data:')) continue;
    const data = remote ? row.slice(5).trim() : row;
    if (data === '[DONE]') { done = true; break; }
    const item = JSON.parse(data);
    if (item.error) throw new Error(`${name}未能完成长篇梦境。`);
    text += (remote ? item.choices?.[0]?.delta?.content : item.message?.content) ?? '';
    if (item.done || item.choices?.[0]?.finish_reason) done = true;
  }
  if (!done) throw new Error(`${name}的长篇输出提前中断。`);
  return text;
}

export function localModelDeployment(request = fetch, launch = startOllama) {
  let task;
  let current;
  async function probe(signal) {
    try {
      const timeout = AbortSignal.timeout(2000);
      const response = await request(LOCAL_URL + '/api/tags', {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return null;
      const result = await response.json();
      return Array.isArray(result.models) ? result.models : null;
    } catch { return null; }
  }
  const installed = models => models?.some(model => (model.name ?? model.model) === LOCAL_MODEL);
  async function deploy(signal) {
    let models = await probe(signal);
    if (!models) {
      signal.throwIfAborted();
      await launch();
      for (let i = 0; i < 12 && !models; i++) {
        await delay(750, undefined, { signal });
        models = await probe(signal);
      }
    }
    if (!models) throw new Error('Ollama 服务未能启动，请检查本机 Ollama。');
    if (!installed(models)) {
      current = { state: 'running', message: '正在下载本地模型…' };
      const response = await request(LOCAL_URL + '/api/pull', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: LOCAL_MODEL, stream: true }), signal,
      });
      if (!response.ok) throw new Error(`Ollama 下载失败（HTTP ${response.status}）。`);
      for await (const row of lines(response)) {
        const update = JSON.parse(row);
        if (update.error) throw new Error('Ollama 下载失败，请检查网络和可用磁盘空间。');
        if (update.total > 0 && Number.isFinite(update.completed)) {
          current = { state: 'running', message: `正在下载模型文件…${Math.floor(100 * update.completed / update.total)}%` };
        }
      }
      if (!installed(await probe(signal))) throw new Error('下载结束后没有找到模型，请重试。');
    }
    current = { state: 'ready', message: `${LOCAL_MODEL} 已就绪。` };
  }
  return {
    async status() {
      if (task || current?.state === 'error') return current;
      const models = await probe();
      if (installed(models)) return { state: 'ready', message: `${LOCAL_MODEL} 已就绪。` };
      return { state: 'idle', message: models ? '默认模型尚未下载。' : '本机 Ollama 尚未运行。' };
    },
    start() {
      if (task) return current;
      const controller = new AbortController();
      task = controller;
      current = { state: 'running', message: '正在检查本机 Ollama…' };
      void deploy(AbortSignal.any([controller.signal, AbortSignal.timeout(1_800_000)]))
        .catch(error => { current = { state: 'error', message: error.message }; })
        .finally(() => { task = undefined; });
      return current;
    },
    stop() { task?.abort(); },
  };
}

function startOllama() {
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', ['serve'], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' },
    });
    child.once('error', error => reject(new Error(
      error.code === 'ENOENT' ? '找不到 Ollama，请先安装 Ollama。' : '无法启动本机 Ollama。',
      { cause: error },
    )));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
