# 碎片梦

作者：末地凋零

碎片梦是一个 Cortico World。它从 Bot 最近的中文日记里找出相对短促、重复或语气鲜明的句子，用前 30 天有记录的日记估算名词是否近期变得突出。它把抽中的名词分组交给本地 Ollama，分别生成梦境片段，再将片段拼接存档。

## 安装与准备

1. 使用支持 World API 6 的 Cortico 或 Coopanion，以及 Node.js 22 或更高版本。在扩展市场搜索 `cortico-world-dream-fragments`，安装并启用。也可以在「手动安装」中选择本项目目录。
2. 安装 Python 3，并在对应环境运行 `python -m pip install jieba`。如果 Cortico 启动时的默认 `python` 指向别的环境，把 `CORTICO_DREAM_PYTHON` 设为带有 jieba 的 Python 可执行文件绝对路径，再重启 Cortico。
3. 启动本地 Ollama，在命令行运行 `ollama pull qwen2.5:1.5b`。扩展通过本机默认端口 `127.0.0.1:11434` 调用该模型。
4. 在「碎片梦 → 设置 → 取词文件」选择 Bot 部署的 `workspace` 或其子文件夹中的 Markdown 或 TXT。默认读取 `近况.md`。文件可以包含多个日期段，无日期条目时按文件修改日计算。

```markdown
# 我自己的日子

## 2026-01-02

我坐在车站旁边看雨。钥匙还在手里。
```

示例日期用于说明格式，请换成实际日期。近期日记中的候选名词太少时，可扩大近期范围或调低关键词与片段数。

## 使用

在「设置 → 模型」选择本地 Ollama 或兼容 OpenAI 的 API。本机装好 Ollama 后，一键部署会启动 Ollama（如有需要）并下载默认模型，已安装时直接显示就绪。API 模式填写完整的 `/chat/completions` 地址、模型名及所需密钥。密钥存放在 Cortico 部署的 `.env`，按接口地址区分。

外部程序集成可使用 Cortico 的现有面板接口。以下请求使用已保存的设置生成并归档一篇梦，返回正文、风格、关键词和存档位置。若 WebUI 开启了认证，请使用该部署的认证方式。

```sh
curl -X POST http://127.0.0.1:17889/api/webui/providers/world%3Adream-fragments/panels/journal/dream \
  -H 'Content-Type: application/json' -d '{"args":[]}'
```

- **做梦**：手动生成一篇梦，展开「本次关键词」查看模型实际收到的分组。
- **梦境存档**：翻阅历史梦境，查看正文、风格和已保存的关键词。
- **设置**：调整日记范围、关键词数量、片段数、50～10,000 字的正文上限、风格权重和定时触发。定时按 Bot 的时区执行，Bot 在线时每天最多尝试一次。

## 数据

日记在本机读取，抽中的关键词提交给所选择的本地模型或 API。梦境和关键词会保存到 Bot 部署的 `data/dream-fragments/`，与日常记忆目录分开。Bot 调用 `dreamfragments_read_latest` 时会收到标注为虚构梦境的正文，正文可能随该次对话提交给 Bot 配置的模型服务。可在 Cortico 中隐藏该 World 来撤下 Bot 的工具访问。

源码采用 MIT 许可证，详见 [LICENSE](LICENSE)。
