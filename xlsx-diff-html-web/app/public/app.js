const state = {
  token: new URLSearchParams(window.location.search).get('token') || '',
  currentPath: '',
  currentHasGit: false,
  repo: '',
  rootLoaded: false,
  lang: initialLanguage(),
};

const el = {
  language: document.querySelector('#language'),
  rootPath: document.querySelector('#rootPath'),
  changeRoot: document.querySelector('#changeRoot'),
  runtimeInfo: document.querySelector('#runtimeInfo'),
  currentPath: document.querySelector('#currentPath'),
  refreshTree: document.querySelector('#refreshTree'),
  upDir: document.querySelector('#upDir'),
  useCurrentRepo: document.querySelector('#useCurrentRepo'),
  tree: document.querySelector('#tree'),
  repoPath: document.querySelector('#repoPath'),
  repoMode: document.querySelector('#repoMode'),
  loadStatus: document.querySelector('#loadStatus'),
  allSheets: document.querySelector('#allSheets'),
  sheet: document.querySelector('#sheet'),
  ignoreEmpty: document.querySelector('#ignoreEmpty'),
  dateFormat: document.querySelector('#dateFormat'),
  statusMeta: document.querySelector('#statusMeta'),
  changedFiles: document.querySelector('#changedFiles'),
  diffMeta: document.querySelector('#diffMeta'),
  openDiff: document.querySelector('#openDiff'),
  diffFrame: document.querySelector('#diffFrame'),
  message: document.querySelector('#message'),
};

const i18n = {
  en: {
    language: 'Language',
    loadingRoot: 'Loading root...',
    files: 'Files',
    refresh: 'Refresh',
    up: 'Up',
    useRepo: 'Use Repo',
    repo: 'Repo',
    selectRepo: 'Select a repo directory',
    mode: 'Mode',
    modeWorking: 'HEAD vs working tree',
    modeStaged: 'HEAD vs staged index',
    load: 'Load',
    allSheets: 'All sheets',
    sheet: 'Sheet',
    ignoreEmpty: 'Ignore empty rows',
    dateFormat: 'Date format',
    changedXlsx: 'Changed xlsx',
    noRepoSelected: 'No repo selected',
    selectRepoThenLoad: 'Select a repo, then load changed files.',
    diff: 'Diff',
    noDiffGenerated: 'No diff generated',
    open: 'Open',
    openDir: 'Open',
    noEntries: 'No directories or xlsx files.',
    repoSelected: 'Repo selected',
    selectRepoFirst: 'Select a repo directory first.',
    loading: 'Loading...',
    changedCount: (count, mode) => `${count} changed xlsx file${count === 1 ? '' : 's'} - ${mode}`,
    noChangedFiles: 'No changed xlsx files.',
    diffButton: 'Diff',
    generatingDiff: 'Generating diff...',
    noTableDiff: 'No table diff.',
    missingToken: 'Missing launch token. Start this page from XlsxDiffHtml.app.',
    changeRoot: 'Change',
    rootChangeFailed: 'Failed to change root',
  },
  zh: {
    language: '语言',
    loadingRoot: '正在读取根目录...',
    files: '文件',
    refresh: '刷新',
    up: '上级',
    useRepo: '使用仓库',
    repo: '仓库',
    selectRepo: '选择一个仓库目录',
    mode: '模式',
    modeWorking: 'HEAD vs 工作区',
    modeStaged: 'HEAD vs 暂存区',
    load: '加载',
    allSheets: '全部工作表',
    sheet: '工作表',
    ignoreEmpty: '忽略空行',
    dateFormat: '日期格式',
    changedXlsx: '变更的 xlsx',
    noRepoSelected: '未选择仓库',
    selectRepoThenLoad: '先选择仓库，然后加载变更文件。',
    diff: '差异',
    noDiffGenerated: '尚未生成差异',
    open: '打开',
    openDir: '打开',
    noEntries: '没有目录或 xlsx 文件。',
    repoSelected: '已选择仓库',
    selectRepoFirst: '请先选择一个仓库目录。',
    loading: '加载中...',
    changedCount: (count, mode) => `${count} 个变更的 xlsx 文件 - ${mode === 'staged' ? '暂存区' : '工作区'}`,
    noChangedFiles: '没有变更的 xlsx 文件。',
    diffButton: '差异',
    generatingDiff: '正在生成差异...',
    noTableDiff: '表格内容无差异。',
    missingToken: '缺少启动 token。请从 XlsxDiffHtml.app 启动页面。',
    changeRoot: '更改',
    rootChangeFailed: '更改根目录失败',
  },
};

function initialLanguage() {
  const saved = localStorage.getItem('xlsx-diff-html-lang');
  if (saved === 'en' || saved === 'zh') return saved;
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function t(key, ...args) {
  const value = i18n[state.lang]?.[key] ?? i18n.en[key] ?? key;
  return typeof value === 'function' ? value(...args) : value;
}

function applyLanguage() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  el.language.value = state.lang;

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
  });

  if (!state.repo && el.changedFiles.classList.contains('empty')) {
    el.statusMeta.textContent = t('noRepoSelected');
    el.changedFiles.textContent = t('selectRepoThenLoad');
  }
  if (!state.rootLoaded) {
    el.rootPath.textContent = t('loadingRoot');
  }
  if (!el.diffFrame.getAttribute('src')) {
    el.diffMeta.textContent = t('noDiffGenerated');
  }
}

function setMessage(text, isError = false) {
  if (!text) {
    el.message.hidden = true;
    el.message.textContent = '';
    return;
  }
  el.message.hidden = false;
  el.message.textContent = text;
  el.message.style.borderColor = isError ? '#e5c8c8' : '#bcd7c9';
  el.message.style.background = isError ? '#fff4f2' : '#f2faf6';
  el.message.style.color = isError ? '#9d2d2d' : '#176b5b';
}

async function api(path, options = {}) {
  const headers = {
    'x-xlsx-diff-token': state.token,
    ...(options.headers || {}),
  };
  if (options.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json();
  if (!response.ok) {
    const details = [data.error, data.stderr].filter(Boolean).join('\n');
    throw new Error(details || `Request failed: ${response.status}`);
  }
  return data;
}

function encodeQuery(value) {
  return encodeURIComponent(value || '');
}

function diffOptions() {
  return {
    sheetMode: el.allSheets.checked ? 'all' : 'single',
    sheet: Number(el.sheet.value || 1),
    ignoreEmpty: el.ignoreEmpty.checked,
    dateFormat: el.dateFormat.value.trim(),
  };
}

async function loadRoot() {
  const root = await api('/api/root');
  state.rootLoaded = true;
  state.isTauri = !!root.isTauri;
  el.rootPath.textContent = root.rootDisplayPath;
  el.runtimeInfo.textContent = `${root.platform} ${root.arch}`;
  if (root.lang === 'en' || root.lang === 'zh') {
    state.lang = root.lang;
    localStorage.setItem('xlsx-diff-html-lang', state.lang);
    applyLanguage();
  }
}

async function applyNewRoot(newPath) {
  if (!newPath) return;
  const result = await api('/api/root', {
    method: 'POST',
    body: JSON.stringify({ path: newPath }),
  });
  el.rootPath.textContent = result.rootDisplayPath;
  state.currentPath = '';
  state.currentHasGit = false;
  state.repo = '';
  el.repoPath.value = '';
  el.statusMeta.textContent = t('noRepoSelected');
  el.changedFiles.className = 'list empty';
  el.changedFiles.textContent = t('selectRepoThenLoad');
  await openDir('');
}

async function pickRootFolder() {
  const result = await api('/api/open-folder-dialog', { method: 'POST' });
  if (result.path) {
    await applyNewRoot(result.path);
  }
}

async function openDir(path) {
  setMessage('');
  const data = await api(`/api/list?path=${encodeQuery(path)}`);
  state.currentPath = data.path;
  state.currentHasGit = data.hasGit;
  el.currentPath.textContent = data.path || '.';
  el.upDir.disabled = data.parent === null;
  el.upDir.dataset.path = data.parent || '';
  el.useCurrentRepo.disabled = !data.hasGit;
  renderTree(data);
}

function renderTree(data) {
  el.tree.textContent = '';
  const rows = [];

  for (const dir of data.dirs) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = dir.name;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = t('openDir');
    open.addEventListener('click', () => openDir(dir.path).catch(showError));
    row.append(name, open);
    if (dir.hasGit) {
      const use = document.createElement('button');
      use.type = 'button';
      use.textContent = t('useRepo');
      use.addEventListener('click', () => useRepo(dir.path));
      row.append(use);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'muted';
      spacer.textContent = '';
      row.append(spacer);
    }
    rows.push(row);
  }

  for (const file of data.files) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = file.name;
    row.append(name);
    rows.push(row);
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('noEntries');
    el.tree.append(empty);
    return;
  }

  rows.forEach((row) => el.tree.append(row));
}

function useRepo(path) {
  state.repo = path;
  el.repoPath.value = path || '.';
  el.statusMeta.textContent = t('repoSelected');
  loadStatus().catch(showError);
}

async function loadStatus() {
  if (!state.repo) {
    setMessage(t('selectRepoFirst'), true);
    return;
  }
  setMessage('');
  el.changedFiles.className = 'list empty';
  el.changedFiles.textContent = t('loading');
  const mode = el.repoMode.value;
  const data = await api(`/api/repo/status?repo=${encodeQuery(state.repo)}&mode=${encodeQuery(mode)}`);
  renderChangedFiles(data.files);
  el.statusMeta.textContent = t('changedCount', data.files.length, mode);
}

function renderChangedFiles(files) {
  el.changedFiles.textContent = '';
  el.changedFiles.className = 'list';
  if (files.length === 0) {
    el.changedFiles.className = 'list empty';
    el.changedFiles.textContent = t('noChangedFiles');
    return;
  }

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'changed-row';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = file.path;
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = file.status;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('diffButton');
    button.addEventListener('click', () => runGitDiff(file.path).catch(showError));
    row.append(name, status, button);
    el.changedFiles.append(row);
  }
}

async function runGitDiff(file) {
  setMessage(t('generatingDiff'));
  const result = await api('/api/diff/git', {
    method: 'POST',
    body: JSON.stringify({
      repo: state.repo,
      file,
      mode: el.repoMode.value,
      ...diffOptions(),
    }),
  });
  showDiff(result, file);
}

function showDiff(result, label) {
  setMessage(result.noTableDiff ? t('noTableDiff') : '');
  el.diffMeta.textContent = label;
  el.diffFrame.src = result.htmlUrl;
  el.openDiff.href = result.htmlUrl;
  el.openDiff.classList.remove('disabled');
}

function showError(error) {
  setMessage(error.message || String(error), true);
}

el.openDiff.addEventListener('click', e => {
  if (!state.isTauri) return;
  e.preventDefault();
  api('/api/open-url', { method: 'POST', body: JSON.stringify({ url: el.openDiff.href }) }).catch(showError);
});
el.changeRoot.addEventListener('click', () => pickRootFolder().catch(showError));
el.refreshTree.addEventListener('click', () => openDir(state.currentPath).catch(showError));
el.upDir.addEventListener('click', () => openDir(el.upDir.dataset.path || '').catch(showError));
el.useCurrentRepo.addEventListener('click', () => useRepo(state.currentPath));
el.loadStatus.addEventListener('click', () => loadStatus().catch(showError));
el.repoMode.addEventListener('change', () => {
  if (state.repo) loadStatus().catch(showError);
});
el.language.addEventListener('change', () => {
  state.lang = el.language.value === 'zh' ? 'zh' : 'en';
  localStorage.setItem('xlsx-diff-html-lang', state.lang);
  api('/api/settings', { method: 'POST', body: JSON.stringify({ lang: state.lang }) }).catch(() => {});
  applyLanguage();
  openDir(state.currentPath).catch(showError);
  if (state.repo) loadStatus().catch(showError);
});

applyLanguage();

if (!state.token) {
  setMessage(t('missingToken'), true);
} else {
  loadRoot()
    .then(() => openDir(''))
    .catch(showError);
}
