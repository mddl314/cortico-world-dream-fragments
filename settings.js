import { randomInt } from 'node:crypto';

export const DREAM_STYLES = [
  { name: '恐怖', direction: '让平常的东西出现一点不对劲，靠重复的声音、逼近的动静或反常的细节制造不安。' },
  { name: '温馨', direction: '用暖光、熟悉的气息和一个微小的照顾动作，让荒唐的场景有一点归属感。' },
  { name: '哲理', direction: '让一件怪事悄悄改变我看待某样东西的方式，用一个具体画面留下疑问。' },
  { name: '冷漠', direction: '用平淡的短句记录反常的事情，像旁观者一样留意距离、秩序和无动于衷的反应。' },
  { name: '忧郁', direction: '用迟到的声音、空着的位置或错过的动作表现失落，让场景安静地变远。' },
  { name: '快乐', direction: '用轻快的动作、突然的好运和意外的笑点，让不相干的场景越跳越有趣。' },
];

export const BODY_LIMIT_RANGE = { min: 50, max: 10_000 };

export const DEFAULT_SETTINGS = {
  keywordCount: 0,
  fragmentCount: 0,
  memoryDays: 3,
  bodyLimit: BODY_LIMIT_RANGE.max,
  trigger: 'manual',
  dailyTime: '03:00',
  styleWeights: DREAM_STYLES.map(() => 1),
};

function integerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('梦境设置无效。');
  const { keywordCount, fragmentCount, memoryDays, bodyLimit, trigger, dailyTime, styleWeights } = value;
  if (keywordCount !== 0 && !integerInRange(keywordCount, 1, 24)) throw new Error('关键词数量须为 1～24，或填 0 自动抽一半。');
  if (fragmentCount !== 0 && !integerInRange(fragmentCount, 1, 5)) throw new Error('片段数须为 1～5，或填 0 随机生成 2～3 段。');
  if (keywordCount && keywordCount < (fragmentCount || 2)) throw new Error('关键词数量至少要够每段分到一个。');
  if (!integerInRange(memoryDays, 1, 30)) throw new Error('近期日记范围须为 1～30 天。');
  if (!integerInRange(bodyLimit, BODY_LIMIT_RANGE.min, BODY_LIMIT_RANGE.max)) {
    throw new Error(`正文上限须为 ${BODY_LIMIT_RANGE.min}～${BODY_LIMIT_RANGE.max} 字。`);
  }
  if (!['manual', 'daily'].includes(trigger)) throw new Error('请选择手动或每天定时触发。');
  if (typeof dailyTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dailyTime)) throw new Error('请输入有效的每天触发时间。');
  if (!Array.isArray(styleWeights) || styleWeights.length !== DREAM_STYLES.length ||
      !Array.from(styleWeights).every(weight => integerInRange(weight, 0, 100)) ||
      !styleWeights.some(weight => weight > 0)) {
    throw new Error('各风格权重须为 0～100 的整数，至少一种风格的权重大于 0。');
  }
  return { keywordCount, fragmentCount, memoryDays, bodyLimit, trigger, dailyTime, styleWeights };
}

export function chooseStyle(weights) {
  let ticket = randomInt(weights.reduce((total, weight) => total + weight, 0));
  return DREAM_STYLES.find((_, index) => {
    ticket -= weights[index];
    return ticket < 0;
  });
}
