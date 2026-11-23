import describe from './describe.json' with { type: 'json' };
import { join } from 'node:path';
import { resolveMemoryFile, workspaceMemoryFiles } from './diaries.js';
import { generateDream, listDreams, readArchivedDream, readLatestDream } from './dream.js';
import { apiKeyName, LOCAL_MODEL, localModelDeployment } from './model.js';
import { BODY_LIMIT_RANGE, DEFAULT_SETTINGS, DREAM_STYLES, validateSettings } from './settings.js';

const id = 'dream-fragments';
const active = new Set();

export default {
  id,
  label: '碎片梦',
  defaults: () => ({ enabled: false, ...DEFAULT_SETTINGS, memoryFile: null, styleWeights: [...DEFAULT_SETTINGS.styleWeights], lastScheduledDate: '' }),
  describe,
  create({ dataDir, timezone = 'Asia/Shanghai', cfg, persist, secret, storeSecret }) {
    const clock = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    let timer;
    let controller;
    const workspaceDir = join(dataDir, '..', 'workspace');
    const deployment = localModelDeployment();
    const currentSettings = () => validateSettings({
      ...DEFAULT_SETTINGS, ...cfg,
      memoryFile: cfg?.memoryFile ?? (cfg?.memorySource === 'diary' ? '我自己的日子.md' : DEFAULT_SETTINGS.memoryFile),
    });
    const settingsView = async () => ({
      settings: currentSettings(),
      bodyLimitRange: BODY_LIMIT_RANGE,
      styles: DREAM_STYLES.map(style => style.name),
      memoryFiles: await workspaceMemoryFiles(workspaceDir),
      localModel: LOCAL_MODEL,
      timezone,
    });

    async function makeDream(scheduledDate) {
      if (active.has(dataDir)) throw new Error('鳍鳍正在做梦，请稍等。');
      const settings = currentSettings();
      active.add(dataDir);
      controller = new AbortController();
      try {
        if (scheduledDate) persist({ lastScheduledDate: scheduledDate });
        const apiKey = settings.modelProvider === 'api' ? secret?.(apiKeyName(settings.apiEndpoint)) : undefined;
        return await generateDream(dataDir, fetch, settings, controller.signal, timezone, apiKey);
      } finally {
        active.delete(dataDir);
        controller = undefined;
      }
    }

    function tick(host) {
      if (cfg?.trigger !== 'daily' || active.has(dataDir)) return;
      const parts = Object.fromEntries(clock.formatToParts().map(part => [part.type, part.value]));
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      if (cfg.lastScheduledDate === date || cfg.dailyTime !== `${parts.hour}:${parts.minute}`) return;
      void makeDream(date).catch(error => {
        host?.log?.warn('碎片梦定时生成失败', { error: error.message });
      });
    }

    return {
      id,
      async start(host) {
        timer = setInterval(() => tick(host), 5000);
        timer.unref();
        tick(host);
      },
      async stop() {
        clearInterval(timer);
        controller?.abort();
        deployment.stop();
      },
      tools: () => [{
        ...describe.tools[0],
        async handler() {
          try {
            const dream = await readLatestDream(dataDir);
            if (dream === null) return '【梦境存档】目前还没有已保存的碎片梦。';
            return '【虚构梦境】以下是最新的碎片梦。\n\n' + dream;
          } catch {
            return '【梦境存档】读取失败，请稍后再试。';
          }
        },
      }],
      envPromptVars: () => null,
      webUi: () => ({
        label: '碎片梦',
        panels: [
          { id: 'journal', title: '做梦' },
          { id: 'archive', title: '梦境存档' },
          { id: 'settings', title: '设置' },
        ],
        async invoke(panel, method, args = []) {
          if (panel === 'journal' && method === 'dream') return makeDream();
          if (panel === 'archive' && method === 'list') return { ...await listDreams(dataDir, args[0]), timezone };
          if (panel === 'archive' && method === 'read') return readArchivedDream(dataDir, args[0]);
          if (panel === 'settings' && method === 'get') return settingsView();
          if (panel === 'settings' && method === 'localStatus') return deployment.status();
          if (panel === 'settings' && method === 'deployLocal') return deployment.start();
          if (panel === 'settings' && method === 'save') {
            const settings = validateSettings(args[0]);
            await resolveMemoryFile(workspaceDir, settings.memoryFile);
            const key = args[0].apiKey;
            if (settings.modelProvider === 'api' && typeof key === 'string' && key.trim()) {
              if (/\s/u.test(key.trim())) throw new Error('API 密钥中不能有空白。');
              storeSecret(apiKeyName(settings.apiEndpoint), key.trim());
            }
            persist(settings);
            return settingsView();
          }
          throw new Error('未知的碎片梦操作。');
        },
      }),
    };
  },
};
