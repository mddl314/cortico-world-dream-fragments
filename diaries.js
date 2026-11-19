import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PERSONAL_DIARY = '我自己的日子.md';
const OLD_DIARY = /^日记-旧本-至(20\d{2}-\d{2}-\d{2})\.md$/u;
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
      const dated = entryDate(title, anchor);
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

export async function readDiaryWindow(workspaceDir, { now = Date.now(), timezone, memoryDays }) {
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const start = shiftDays(today, 1 - memoryDays);
  const baselineStart = shiftDays(start, -BASELINE_DAYS);
  const files = await readdir(workspaceDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const diaries = files.filter(file => file.isFile() && (file.name === PERSONAL_DIARY || OLD_DIARY.test(file.name)));
  const entries = (await Promise.all(diaries.map(async ({ name }) => {
    const anchor = OLD_DIARY.exec(name)?.[1] ?? today;
    const content = await readFile(join(workspaceDir, name), 'utf8');
    return parseDiary(content, anchor);
  }))).flat();
  const recent = [];
  const baseline = [];
  for (const entry of entries) {
    if (entry.date >= start && entry.date <= today) recent.push(entry);
    else if (entry.date >= baselineStart && entry.date < start) baseline.push(entry);
  }
  return { recent, baseline };
}
