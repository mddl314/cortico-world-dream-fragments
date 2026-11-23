function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(text) {
  const button = element('button', text, 'btn');
  button.type = 'button';
  return button;
}

function statusLine() {
  const status = element('p');
  status.setAttribute('role', 'status');
  return status;
}

function keywordSection() {
  const details = element('details', '', 'fragmentdream-keywords');
  const summary = element('summary', '本次关键词');
  const content = element('div');
  details.append(summary, content);
  details.hidden = true;

  return {
    details,
    clear() {
      details.hidden = true;
      details.open = false;
      content.replaceChildren();
    },
    show(batches) {
      details.hidden = false;
      if (!batches?.length) {
        summary.textContent = '本次关键词';
        content.replaceChildren(element('p', '这篇梦生成时没有记录关键词。'));
        return;
      }
      summary.textContent = `本次关键词 · ${batches.flat().length} 个`;
      content.replaceChildren(...batches.map((words, index) => {
        const row = element('p');
        row.append(element('strong', `第 ${index + 1} 段`), ' ', words.join('、'));
        return row;
      }));
    },
  };
}

function mountArchive({ root, invoke, signal }) {
  const refresh = action('刷新存档');
  const more = action('加载更早的梦');
  more.hidden = true;
  const status = statusLine();
  const layout = element('div', '', 'fragmentdream-archive');
  const sidebar = element('div');
  const list = element('ul', '', 'fragmentdream-list');
  const reader = element('article', '', 'fragmentdream-reader');
  const title = element('h3', '选择一篇梦境');
  const prose = element('p', '', 'fragmentdream-prose');
  const keywords = keywordSection();
  reader.append(title, keywords.details, prose);
  sidebar.append(list, more);
  layout.append(sidebar, reader);
  root.append(refresh, status, layout);

  let next;
  let selection = 0;

  async function open(dream, label) {
    const current = ++selection;
    title.textContent = label;
    prose.textContent = '正在读取…';
    keywords.clear();
    try {
      const result = await invoke('read', [dream.name]);
      if (current === selection && !signal.aborted) {
        prose.textContent = result.body;
        keywords.show(result.keywordBatches);
      }
    } catch (error) {
      if (current === selection && !signal.aborted) prose.textContent = error.message;
    }
  }

  async function load(older) {
    refresh.disabled = more.disabled = true;
    status.textContent = '正在读取存档…';
    try {
      const result = await invoke('list', older ? [next] : []);
      if (signal.aborted) return;
      if (!older) list.replaceChildren();
      next = result.next;
      more.hidden = !next;
      const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: result.timezone, dateStyle: 'medium', timeStyle: 'short',
      });
      for (const dream of result.dreams) {
        const date = new Date(dream.createdAt);
        const time = Number.isNaN(date.getTime()) ? dream.name : formatter.format(date);
        const label = dream.style ? `${time} · ${dream.style}` : time;
        const item = element('li');
        const button = action(label);
        button.addEventListener('click', () => void open(dream, label), { signal });
        item.append(button);
        list.append(item);
      }
      status.textContent = list.childElementCount ? '' : '还没有保存过梦境。';
      if (!older && list.childElementCount) list.querySelector('button').click();
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message;
    } finally {
      refresh.disabled = more.disabled = false;
    }
  }

  refresh.addEventListener('click', () => void load(false), { signal });
  more.addEventListener('click', () => void load(true), { signal });
  void load(false);
}

function numberInput(value, min, max) {
  const input = element('input');
  Object.assign(input, { type: 'number', min, max, step: 1, required: true, value });
  return input;
}

function field(label, input, hint) {
  const row = element('label', label, 'fragmentdream-field');
  row.append(input);
  if (hint) row.append(element('small', hint));
  return row;
}

async function mountSettings({ root, invoke, signal, interval }) {
  const status = statusLine();
  status.textContent = '正在读取设置…';
  root.append(status);
  let view;
  try {
    view = await invoke('get');
  } catch (error) {
    if (!signal.aborted) status.textContent = error.message;
    return;
  }
  if (signal.aborted) return;
  const { settings, bodyLimitRange, styles, memoryFiles, timezone } = view;
  const form = element('form', '', 'fragmentdream-settings');
  const generation = element('fieldset');
  generation.append(element('legend', '生成'));
  const keywordCount = numberInput(settings.keywordCount, 0, 24);
  const fragmentCount = numberInput(settings.fragmentCount, 0, 5);
  const memoryDays = numberInput(settings.memoryDays, 1, 30);
  const memoryFile = element('select');
  memoryFile.required = true;
  if (!memoryFiles.includes(settings.memoryFile)) {
    const placeholder = element('option', '当前文件不可用，请重新选择');
    placeholder.value = '';
    placeholder.disabled = true;
    memoryFile.append(placeholder);
  }
  for (const path of memoryFiles) {
    const option = element('option', path);
    option.value = path;
    memoryFile.append(option);
  }
  memoryFile.value = memoryFiles.includes(settings.memoryFile) ? settings.memoryFile : '';
  const bodyLimit = numberInput(settings.bodyLimit, bodyLimitRange.min, bodyLimitRange.max);
  const fields = element('div', '', 'fragmentdream-fields');
  fields.append(
    field('关键词数量', keywordCount, '0 表示加权随机抽取一半，排名靠前的词更容易入选。'),
    field('片段数', fragmentCount, '0 表示随机生成两到三段。'),
    field('取词文件', memoryFile, '可选 workspace 及子文件夹中的 Markdown、TXT。无日期条目时按文件修改日计算。'),
    field('回看天数', memoryDays, '从近期重点句取词，并和同一来源此前 30 天的条目比较。'),
    field('正文上限（字）', bodyLimit),
  );
  generation.append(fields);

  const model = element('fieldset');
  const provider = element('select');
  for (const [value, label] of [['ollama', '本地 Ollama'], ['api', '兼容 OpenAI 的 API']]) {
    const option = element('option', label);
    option.value = value;
    provider.append(option);
  }
  provider.value = settings.modelProvider;
  const local = element('div');
  const deploy = action('一键部署本地小模型');
  const modelStatus = statusLine();
  local.append(element('p', view.localModel), deploy, modelStatus);
  let deploying = false;
  function showModelStatus(result) {
    if (signal.aborted) return;
    deploying = result.state === 'running';
    deploy.disabled = deploying;
    modelStatus.textContent = result.message;
  }
  async function checkModel(method = 'localStatus') {
    try {
      showModelStatus(await invoke(method));
    } catch (error) {
      showModelStatus({ state: 'error', message: error.message });
    }
  }
  deploy.addEventListener('click', () => {
    deploy.disabled = true;
    void checkModel('deployLocal');
  }, { signal });
  interval(() => { if (deploying) void checkModel(); }, 1500);
  const remote = element('div', '', 'fragmentdream-fields');
  const endpoint = element('input');
  Object.assign(endpoint, { type: 'url', value: settings.apiEndpoint, placeholder: 'https://example.com/v1/chat/completions' });
  const modelName = element('input');
  modelName.value = settings.apiModel;
  const apiKey = element('input');
  Object.assign(apiKey, { type: 'password', autocomplete: 'new-password' });
  remote.append(
    field('API 地址', endpoint),
    field('模型名', modelName),
    field('API 密钥', apiKey, '留空沿用该地址已保存的密钥。'),
    element('p', '使用 API 时，选出的关键词会发给所填的服务。'),
  );
  function updateProvider() {
    const useApi = provider.value === 'api';
    local.hidden = useApi;
    remote.hidden = !useApi;
    endpoint.disabled = modelName.disabled = apiKey.disabled = !useApi;
    endpoint.required = modelName.required = useApi;
    if (!useApi) void checkModel();
  }
  provider.addEventListener('change', updateProvider, { signal });
  model.append(element('legend', '模型'), field('模型来源', provider), local, remote);
  updateProvider();

  const distribution = element('fieldset');
  const count = element('p');
  const weights = styles.map((style, index) => {
    const input = numberInput(settings.styleWeights[index], 0, 100);
    const probability = element('output');
    const row = field(style, input);
    row.append(probability);
    return { input, probability, row };
  });
  const weightGrid = element('div', '', 'fragmentdream-fields');
  weightGrid.append(...weights.map(({ row }) => row));
  distribution.append(element('legend', '梦境风格'), element('p', '权重越高越容易抽到。填 0 关闭该风格。'), count, weightGrid);
  function updateProbabilities() {
    const values = weights.map(({ input }) => Number(input.value));
    const total = values.reduce((sum, weight) => sum + weight, 0);
    count.textContent = `已启用 ${values.filter(weight => weight > 0).length} 种风格`;
    weights.forEach(({ probability }, index) => {
      probability.textContent = total ? `抽中概率 ${(100 * values[index] / total).toFixed(1)}%` : '抽中概率 0%';
    });
  }
  distribution.addEventListener('input', updateProbabilities, { signal });
  updateProbabilities();

  const schedule = element('fieldset');
  const trigger = element('select');
  for (const [value, label] of [['manual', '仅手动'], ['daily', '每天定时，也可手动']]) {
    const option = element('option', label);
    option.value = value;
    trigger.append(option);
  }
  trigger.value = settings.trigger;
  const dailyTime = element('input');
  Object.assign(dailyTime, { type: 'time', required: true, value: settings.dailyTime });
  const timeField = field('每天触发时间', dailyTime, `时区 ${timezone}。鳍鳍在线时触发，错过当天时间会等到次日。`);
  function updateSchedule() {
    dailyTime.disabled = trigger.value !== 'daily';
    timeField.hidden = dailyTime.disabled;
  }
  schedule.append(element('legend', '触发'), field('触发方式', trigger), timeField);
  trigger.addEventListener('change', updateSchedule, { signal });
  updateSchedule();

  const save = action('保存设置');
  save.type = 'submit';
  form.append(generation, model, distribution, schedule, save, status);
  root.append(form);
  status.textContent = '';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = '正在保存…';
    try {
      await invoke('save', [{
        keywordCount: Number(keywordCount.value),
        fragmentCount: Number(fragmentCount.value),
        memoryDays: Number(memoryDays.value),
        memoryFile: memoryFile.value,
        modelProvider: provider.value,
        apiEndpoint: endpoint.value,
        apiModel: modelName.value,
        apiKey: apiKey.value,
        bodyLimit: Number(bodyLimit.value),
        styleWeights: weights.map(({ input }) => Number(input.value)),
        trigger: trigger.value,
        dailyTime: dailyTime.value,
      }]);
      apiKey.value = '';
      if (!signal.aborted) status.textContent = '已保存，下次做梦生效。';
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  }, { signal });
}

export default {
  panels: {
    archive: { mount(context) { mountArchive(context); return { dispose() {} }; } },
    settings: { mount(context) { void mountSettings(context); return { dispose() {} }; } },
    journal: {
      mount({ root, invoke, signal }) {
        const button = document.createElement('button');
        button.className = 'btn';
        button.type = 'button';
        button.textContent = '让鳍鳍做个梦';
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        const dream = document.createElement('div');
        dream.style.whiteSpace = 'pre-wrap';
        const keywords = keywordSection();
        const path = document.createElement('p');
        path.style.overflowWrap = 'anywhere';
        root.append(button, status, keywords.details, dream, path);

        button.addEventListener('click', async () => {
          button.disabled = true;
          status.textContent = '鳍鳍正在做梦…';
          dream.textContent = '';
          path.textContent = '';
          keywords.clear();
          try {
            const result = await invoke('dream');
            status.textContent = `${result.style ?? '梦境'} · ${result.fragments} 个片段 · ${result.characters} 字`;
            keywords.show(result.keywordBatches);
            dream.textContent = result.body;
            path.textContent = `已保存到 ${result.path}`;
          } catch (error) {
            if (!signal.aborted) status.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        }, { signal });
        return { dispose() {} };
      },
    },
  },
};
