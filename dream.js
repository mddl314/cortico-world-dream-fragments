import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiaryWindow } from './diaries.js';
import { chooseStyle, DEFAULT_SETTINGS } from './settings.js';

const MODEL = 'qwen2.5:1.5b';
const FRAGMENT_ATTEMPTS = 3;
const CANDIDATE_LIMIT = 24;
const ARCHIVE_DIRECTORY = 'dream-fragments';
const DREAM_FILE = /^梦境-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.md$/u;
const DREAM_HEADER = /^# 碎片梦\r?\n\r?\n生成时间 (?<createdAt>[^\r\n]+)(?:\r?\n\r?\n风格 (?<style>[^\r\n]+)(?<keywordLine>\r?\n关键词分组 (?<keywords>[^\r\n]+))?)?/u;
const OUTPUT_ARTIFACT = /\p{Script=Latin}|字幕|[\[【]\s*(?:图片|图像|视频|附件)\s*[\]】]/u;
const nounCounter = fileURLToPath(new URL('./count-nouns.py', import.meta.url));
const speechPython = fileURLToPath(new URL('../../../GPT-SoVITS/runtime/python.exe', import.meta.url));
const stopWords = new Set(
  '自己 你们 我们 他们 她们 它们 这个 那个 这些 那些 什么 怎么 为什么 哪个 这样 那样 这里 那里 一个 一些 一下 时候 还有 已经 可以 觉得 还是 但是 而且 然后 之后 之前 因为 所以 如果 可能 不能 不会 不要 没有 不是 就是 也是 比较 现在 今天 昨天 明天 一直 一起 真的 非常 其实 需要 实际 一次 一段 只留 用户 助手 消息 回复 内容 表情 图片 图像 视频 附件 字幕'.split(' '),
);

function scoreDiaryWords(diary, signal) {
  const python = process.env.CORTICO_DREAM_PYTHON || (existsSync(speechPython) ? speechPython : 'python');
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-X', 'utf8', nounCounter], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true, signal,
    }, (error, stdout) => {
      if (error) {
        reject(new Error('中文词性标注失败，请确认本机 Python 可以加载结巴分词。', { cause: error }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error('无法读取名词统计结果。', { cause: error }));
      }
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(JSON.stringify(diary));
  });
}

export async function rankDiaryKeywords(workspaceDir, { now, timezone, memoryDays, signal }) {
  let diary;
  try {
    diary = await readDiaryWindow(workspaceDir, { now, timezone, memoryDays });
  } catch (error) {
    throw new Error('无法读取鳍鳍的日记。', { cause: error });
  }
  if (!diary.recent.length) throw new Error(`最近 ${memoryDays} 天没有可用的日记条目，可以扩大近期日记范围。`);
  signal?.throwIfAborted();
  return scoreDiaryWords({
    ...diary, exclude: [...stopWords], candidateLimit: CANDIDATE_LIMIT,
  }, signal);
}

export function sampleBatches(candidates, { keywordCount, fragmentCount } = DEFAULT_SETTINGS) {
  const pool = candidates.map((word, index) => ({ word, weight: candidates.length - index }));
  const sampleSize = keywordCount || Math.floor(pool.length / 2);
  if (sampleSize > pool.length) throw new Error(`本次只有 ${pool.length} 个候选名词，请减少关键词数量或扩大日记范围。`);
  const batchCount = fragmentCount || (sampleSize >= 3 ? randomInt(2, 4) : 2);
  if (sampleSize < batchCount) throw new Error('候选名词不足以分给每个片段，请减少片段数或扩大日记范围。');
  const batches = Array.from({ length: batchCount }, () => []);
  for (let i = 0; i < sampleSize; i += 1) {
    let ticket = randomInt(pool.reduce((total, candidate) => total + candidate.weight, 0));
    const chosen = pool.findIndex(candidate => {
      ticket -= candidate.weight;
      return ticket < 0;
    });
    batches[i % batchCount].push(pool.splice(chosen, 1)[0].word);
  }
  return batches;
}

function limitFragment(text, limit) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  const head = chars.slice(0, limit - 1).join('');
  const sentence = head.match(/^.*[。！？…]/u)?.[0];
  return sentence && Array.from(sentence).length >= limit / 2 ? sentence : head.trimEnd() + '…';
}

async function readStreamedText(response) {
  if (!response.body) throw new Error('本机 Ollama 没有返回梦境正文。');
  let pending = '';
  let text = '';
  let done = false;

  function readLine(line) {
    if (!line.trim()) return;
    const item = JSON.parse(line);
    if (item.error) throw new Error('本机 Ollama 未能完成长篇梦境。');
    text += item.message?.content ?? '';
    if (item.done === true) done = true;
  }

  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) readLine(line);
  }
  readLine(pending);
  if (!done) throw new Error('本机 Ollama 的长篇输出提前中断。');
  return text;
}

async function generateFragment(words, limit, style, request, signal) {
  const prompt = [
    `写一个最多 ${limit} 字的第一人称中文梦境片段，只输出正文。`,
    `梦的风格：${style.name}。${style.direction}让这种感觉来自画面和动作，不要把风格名称写进正文。`,
    '下面这些是意象线索，不是要写进句子的词。把线索变成我在梦里看到、听到或摸到的事物，也可以跳过难用的线索。不要照抄或逐个解释线索。',
    '把不相干的画面混在一起，可以突变地点、物体或身份。只写中文正文，不写标题、英文、文件后缀或媒体标记。',
    `意象线索：${words.join('、')}`,
  ].join('\n');

  const stream = limit > 512;
  const numPredict = stream ? limit * 2 + 64 : limit + 16;
  // 中文字符可能占多个词元。为生成预算和提示保留完整的上下文。
  const numCtx = stream ? 2 ** Math.ceil(Math.log2(numPredict + 512)) : 1024;
  const timeoutMs = Math.max(120_000, 30_000 + numPredict * 150);

  for (let attempt = 0; attempt < FRAGMENT_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await request('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        body: JSON.stringify({
          model: MODEL,
          stream,
          messages: [{ role: 'user', content: prompt }],
          options: { temperature: 1.15, top_p: 0.92, num_ctx: numCtx, num_predict: numPredict, seed: randomInt(2 ** 31) },
        }),
      });
    } catch (error) {
      throw new Error('连接本机 Ollama 失败或生成超时。', { cause: error });
    }
    if (!response.ok) throw new Error(`本机 Ollama 返回错误（${response.status}），请确认 ${MODEL} 可用。`);
    const raw = stream ? await readStreamedText(response) : (await response.json()).message?.content;
    if (typeof raw !== 'string') continue;
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\s+/g, ' ').trim();
    if (/\p{Script=Han}/u.test(text) && !OUTPUT_ARTIFACT.test(text.normalize('NFKC'))) {
      return limitFragment(text, limit);
    }
  }
  throw new Error('有梦境片段连续 3 次未通过检查（空稿或含英文、媒体标记），本次梦境未保存。');
}

async function archiveNames(dataDir) {
  const archive = join(dataDir, ARCHIVE_DIRECTORY);
  const entries = await readdir(archive, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && DREAM_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export async function readLatestDream(dataDir) {
  const archive = join(dataDir, ARCHIVE_DIRECTORY);
  for (const name of await archiveNames(dataDir)) {
    try {
      const content = await readFile(join(archive, name), 'utf8');
      const header = DREAM_HEADER.exec(content);
      const keywordLine = header?.groups.keywordLine;
      if (!keywordLine) return content;
      const end = header[0].length;
      return content.slice(0, end - keywordLine.length) + content.slice(end);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function readArchivedDream(dataDir, name) {
  if (typeof name !== 'string' || !DREAM_FILE.test(name) || !(await archiveNames(dataDir)).includes(name)) {
    throw new Error('找不到这篇梦境，请刷新存档。');
  }
  const content = await readFile(join(dataDir, ARCHIVE_DIRECTORY, name), 'utf8');
  const header = DREAM_HEADER.exec(content);
  return {
    body: content.slice(header?.[0].length ?? 0).trim(),
    createdAt: header?.groups.createdAt,
    style: header?.groups.style,
    keywordBatches: header?.groups.keywords?.split('｜').map(batch => batch.split('、')) ?? null,
  };
}

export async function listDreams(dataDir, before) {
  if (before !== undefined && (typeof before !== 'string' || !DREAM_FILE.test(before))) throw new Error('存档分页位置无效。');
  const names = (await archiveNames(dataDir)).filter(name => before === undefined || name < before);
  const page = names.slice(0, 25);
  const dreams = await Promise.all(page.map(async name => {
    const content = await readFile(join(dataDir, ARCHIVE_DIRECTORY, name), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const header = DREAM_HEADER.exec(content);
    return { name, createdAt: header?.groups.createdAt, style: header?.groups.style };
  }));
  return { dreams, next: names.length > page.length ? page.at(-1) : null };
}

export async function generateDream(dataDir, request = fetch, settings = DEFAULT_SETTINGS, signal, timezone = 'Asia/Shanghai') {
  const { keywords } = await rankDiaryKeywords(join(dataDir, '..', 'workspace'), {
    timezone, memoryDays: settings.memoryDays, signal,
  });
  const batches = sampleBatches(keywords, settings);
  const style = chooseStyle(settings.styleWeights);
  const limit = Math.floor((settings.bodyLimit - 2 * (batches.length - 1)) / batches.length);
  const fragments = [];
  for (const words of batches) {
    fragments.push(await generateFragment(words, limit, style, request, signal));
  }

  const body = fragments.join('\n\n');
  const keywordLine = batches.map(words => words.join('、')).join('｜');
  const createdAt = new Date().toISOString();
  const archive = join(dataDir, ARCHIVE_DIRECTORY);
  const name = `梦境-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`;
  const path = join(archive, name);
  const temporary = path + '.tmp';
  await mkdir(archive, { recursive: true });
  try {
    signal?.throwIfAborted();
    await writeFile(temporary, `# 碎片梦\n\n生成时间 ${createdAt}\n\n风格 ${style.name}\n关键词分组 ${keywordLine}\n\n${body}\n`, { flag: 'wx' });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return {
    path, body, style: style.name, fragments: fragments.length,
    characters: Array.from(body).length, keywordBatches: batches,
  };
}
