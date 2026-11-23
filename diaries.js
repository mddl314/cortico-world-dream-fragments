import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { DEFAULT_SETTINGS } from './settings.js';

const OLD_DIARY = /^日记-旧本-至(20\d{2}-\d{2}-\d{2})\.md$/u;
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const DATED_ENTRY = /^(?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?(?=\s|[·：:]|$)/u;
const BASELINE_DAYS = 30;

function dateKey(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function entryDate(text, anchor) {
  const match = DATED_ENTRY.exec(text);
  if (!match) return null;
  const [, explicitYear, month, day] = match;
  const [anchorYear, anchorMonth] = anchor.split('-').map(Number);
  const difference = Number(month) - anchorMonth;
  const year = explicitYear ? Number(explicitYear) : anchorYear - Math.round(difference / 12);
  const date = dateKey(year, Number(month), Number(day));
  if (!date) return null;
  return { date, remainder: text.slice(match[0].length).trimStart() };
}

function cleanLine(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:>+\s*|[-*+]\s+)/u, '')
    .trim();
}

export function parseDiary(content, initialAnchor) {
  const entries = [];
  let anchor = initialAnchor;
  let current;
  let fenced = false;

  function finishEntry() {
    if (current?.lines.some(line => /\p{Script=Han}/u.test(line))) {
      entries.push({ date: current.date, text: current.lines.join('\n').trim() });
    }
    current = undefined;
  }

  for (const line of content.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const [, marks, title] = heading;
      const dated = entryDate(title.replace(/^⚠\uFE0F?\s*/u, ''), anchor);
      if (dated) {
        finishEntry();
        anchor = dated.date;
        current = { date: dated.date, level: marks.length, lines: [] };
      } else if (marks.length === 1) {
        finishEntry();
        const bookDate = title.match(/20\d{2}-\d{2}-\d{2}/u)?.[0];
        if (bookDate) anchor = bookDate;
      } else if (current && /^\d{1,2}:\d{2}(?:\s|[·｜|：:]|$)/u.test(title)) {
        const date = current.date;
        finishEntry();
        current = { date, level: marks.length, lines: [] };
      } else if (current && marks.length <= current.level) {
        finishEntry();
      }
      continue;
    }

    const boldHeading = /^\*\*([^*]+)\*\*\s*[：:]?\s*(.*)$/u.exec(line);
    const boldDate = boldHeading && entryDate(boldHeading[1], anchor);
    if (boldDate) {
      const level = current?.level ?? 6;
      finishEntry();
      anchor = boldDate.date;
      current = { date: boldDate.date, level, lines: [cleanLine(boldHeading[2])] };
      continue;
    }

    const datedBullet = /^\s*[-*]\s+(20\d{2}[/.-].+)$/u.exec(line);
    const dated = datedBullet && entryDate(datedBullet[1], anchor);
    if (dated) {
      finishEntry();
      anchor = dated.date;
      current = {
        date: dated.date, level: 6,
        lines: [cleanLine(dated.remainder.replace(/^\d{1,2}:\d{2}\s*[：:｜|]?\s*/u, ''))],
      };
    } else if (current) {
      current.lines.push(cleanLine(line));
    }
  }
  finishEntry();
  return entries;
}

function shiftDays(date, days) {
  const timestamp = Date.parse(date + 'T00:00:00Z');
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

export async function workspaceMemoryFiles(workspaceDir) {
  const files = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/');
      else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(name).toLowerCase())) files.push(name);
    }
  }
  try {
    await walk(workspaceDir, '');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return files.sort((left, right) => left.localeCompare(right, 'zh'));
}

export async function resolveMemoryFile(workspaceDir, name) {
  if (typeof name !== 'string' || !TEXT_EXTENSIONS.has(extname(name).toLowerCase()) ||
      /[\\:\u0000]/u.test(name) || name.split('/').some(part => !part || part.startsWith('.'))) {
    throw new Error('请选择 workspace 里的 Markdown 或 TXT 文件。');
  }
  const root = await realpath(workspaceDir);
  const file = await realpath(join(root, name));
  const rel = relative(root, file);
  if (!rel || isAbsolute(rel) || rel.split(sep).some(part => part.startsWith('.'))) {
    throw new Error('取词文件必须位于 workspace 内。');
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error('取词来源必须是文件。');
  return { file, modifiedAt: info.mtimeMs };
}

export async function readDiaryWindow(workspaceDir, { now = Date.now(), timezone, memoryDays, memoryFile = DEFAULT_SETTINGS.memoryFile }) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = formatter.format(now);
  const start = shiftDays(today, 1 - memoryDays);
  const baselineStart = shiftDays(start, -BASELINE_DAYS);
  const { file, modifiedAt } = await resolveMemoryFile(workspaceDir, memoryFile);
  const content = await readFile(file, 'utf8');
  const entries = parseDiary(content, OLD_DIARY.exec(memoryFile.split('/').at(-1))?.[1] ?? today);
  if (!entries.length && /\p{Script=Han}/u.test(content)) {
    entries.push({ date: formatter.format(modifiedAt), text: content });
  }
  const recent = [];
  const baseline = [];
  for (const entry of entries) {
    if (entry.date >= start && entry.date <= today) recent.push(entry);
    else if (entry.date >= baselineStart && entry.date < start) baseline.push(entry);
  }
  return { recent, baseline };
}
