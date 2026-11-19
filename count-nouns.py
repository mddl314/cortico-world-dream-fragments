import json
import logging
import re
import sys
from collections import Counter, defaultdict
from math import log2
from statistics import median

import jieba
from jieba import posseg


NOUN_TAGS = {"n", "nr", "nrfg", "nrt", "ns", "nt", "nz"}
NAME_TAGS = {"nr", "nrfg", "nrt", "ns", "nt"}
NONSPECIFIC_NOUNS = {
    "实际", "一次", "一段", "只留", "回家", "东西", "事情", "情况", "方面",
    "过会儿", "起码", "时时", "立马", "摸头", "重点", "附图", "力度", "程度", "阶段",
    "心动", "开花", "小时", "分钟", "秒钟",
    "人", "事", "话", "天", "日", "点", "次", "段", "件", "位", "成", "问",
}
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af]")
SENTENCE_BOUNDARY = re.compile(r"(?<=[。！？!?；;])\s*|\n")
PARAGRAPH_BOUNDARY = re.compile(r"\n[ \t]*\n+")
ARTIFACT = re.compile(r"https?://\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\[(?:CQ|segment):[^\]]*\]", re.I)
MARKDOWN_PREFIX = re.compile(r"^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)")
EMPHASIS = re.compile(
    r"又来了|怎么又|偏偏|凭什么|受够|到底|再也|非要|一直没|还是没|忘不了|到现在|"
    r"攥着|发抖|压不住|忍不住|舍不得|心疼|委屈|烦死|气死|着急|生气|火大|难受|"
    r"咽不下|撑不住|心里一紧|松了口气|笑出了声|开心极了"
)


def noun_tags(text, exclude):
    return {
        word: tag
        for word, tag in posseg.cut(text, HMM=False)
        if tag in NOUN_TAGS and word not in exclude and 1 <= len(word) <= 8
        and all(HAN.fullmatch(char) for char in word)
    }


def grouped_days(entries):
    days = defaultdict(list)
    for entry in entries:
        date = entry.get("date")
        text = ARTIFACT.sub(" ", entry.get("text", "")).replace("\r\n", "\n").strip()
        if isinstance(date, str) and text and text not in days[date]:
            days[date].append(text)
    return days


def diary_sections(entries, exclude):
    sections = []
    for entry in entries:
        for paragraph in PARAGRAPH_BOUNDARY.split(entry):
            sentences = []
            for part in SENTENCE_BOUNDARY.split(paragraph):
                text = MARKDOWN_PREFIX.sub("", part).strip()
                signature = "".join(HAN.findall(text))
                if signature:
                    sentences.append((text, signature, noun_tags(text, exclude)))
            if sentences:
                sections.append(sentences)
    return sections


def highlight_windows(sections):
    sizes = [len(signature) for section in sections for _, signature, _ in section]
    if not sizes:
        return []
    usual_length = median(sizes)
    candidates = []
    for section_index, section in enumerate(sections):
        for index, (text, signature, nouns) in enumerate(section):
            window = section[max(0, index - 1):index + 2]
            if not any(tags for _, _, tags in window):
                continue
            previous_length = len(section[index - 1][1]) if index else usual_length
            length = len(signature)
            shortness = max(0, (usual_length - length) / max(usual_length, 6))
            shortening = max(0, (previous_length - length) / max(previous_length, 6))
            nearby = section[max(0, index - 2):index] + section[index + 1:index + 3]
            neighboring_nouns = set().union(*(tags for _, _, tags in nearby))
            repetition = min(2, len(nouns.keys() & neighboring_nouns)) * 0.95
            if 0 < index < len(section) - 1 and section[index - 1][2].keys() & section[index + 1][2].keys():
                repetition = max(repetition, 0.7)
            emphasis = 1.1 if EMPHASIS.search(text) else 0
            emphatic_mark = 0.25 if (emphasis or repetition or shortness > 0.35) and re.search(r"[！!？?]", text) else 0
            score = 1.65 * shortness + 0.7 * shortening + repetition + emphasis + emphatic_mark
            candidates.append((score, section_index, index, window))

    max_windows = 3 if len(sizes) >= 9 else 2
    picked = []
    for candidate in sorted(candidates, key=lambda item: -item[0]):
        score, section_index, index, _ = candidate
        if picked and score <= 0.35:
            break
        if any(other_section == section_index and abs(index - other_index) <= 2
               for _, other_section, other_index, _ in picked):
            continue
        picked.append(candidate)
        if len(picked) == max_windows:
            break
    return picked


def score_diaries(payload):
    exclude = NONSPECIFIC_NOUNS | set(payload.get("exclude", ()))
    recent = grouped_days(payload["recent"])
    baseline = grouped_days(payload["baseline"])
    baseline_counts = Counter()
    for entries in baseline.values():
        baseline_counts.update(set().union(*(noun_tags(entry, exclude) for entry in entries)))

    recent_counts = Counter()
    evidence = defaultdict(dict)
    recent_mentions = defaultdict(set)
    selected_mentions = defaultdict(set)
    highlight_count = 0
    for day, entries in recent.items():
        sections = diary_sections(entries, exclude)
        day_nouns = set()
        for section in sections:
            for _, signature, nouns in section:
                day_nouns.update(nouns)
                for word in nouns:
                    recent_mentions[word].add((day, signature))
        recent_counts.update(day_nouns)

        windows = highlight_windows(sections)
        highlight_count += len(windows)
        for strength, section_index, center_index, window in windows:
            center = sections[section_index][center_index][2]
            for _, signature, nouns in window:
                for word, tag in nouns.items():
                    selected_mentions[word].add((day, signature))
                    proximity = 1.0 if word in center else 0.55
                    name_bonus = 0.22 if tag in NAME_TAGS else 0
                    weight = (0.9 + strength) * proximity + name_bonus
                    evidence[word][day] = max(evidence[word].get(day, 0), weight)

    scores = {}
    singletons = []
    for word, by_day in evidence.items():
        mentions = len(selected_mentions[word])
        if len(word) == 1 and mentions < 2:
            continue
        recent_rate = (recent_counts[word] + 0.5) / (len(recent) + 1)
        baseline_rate = (baseline_counts[word] + 0.5) / (len(baseline) + 1)
        novelty = max(-1.5, min(1.5, log2(recent_rate / baseline_rate)))
        novelty *= min(1, len(baseline) / 7)
        scores[word] = max(by_day.values()) + 1.25 * novelty + 1.0 * (len(by_day) - 1) + 0.6 * min(2, mentions - 1)
        if len(recent_mentions[word]) == 1 and max(by_day.values()) >= 2:
            singletons.append(word)

    keywords = sorted(scores, key=lambda word: (-scores[word], word))
    limit = payload.get("candidateLimit", 24)
    if singletons and limit:
        singleton = max(singletons, key=scores.get)
        reserve = min(4, limit - 1)
        if keywords.index(singleton) > reserve:
            keywords.remove(singleton)
            keywords.insert(reserve, singleton)
    return {
        "keywords": keywords[:limit],
        "recentDays": len(recent),
        "baselineDays": len(baseline),
        "highlightCount": highlight_count,
    }


def main():
    jieba.setLogLevel(logging.ERROR)
    payload = json.load(sys.stdin)
    if isinstance(payload, dict):
        json.dump(score_diaries(payload), sys.stdout)
        return
    counts = Counter()
    for text in payload:
        nouns = {word for word, tag in posseg.cut(text, HMM=False) if tag in NOUN_TAGS}
        counts.update(nouns)
    json.dump(counts, sys.stdout)


if __name__ == "__main__":
    main()
