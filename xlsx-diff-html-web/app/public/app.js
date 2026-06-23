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
  branchRow: document.querySelector('#branchRow'),
  baseBranch: document.querySelector('#baseBranch'),
  headBranch: document.querySelector('#headBranch'),
  swapBranches: document.querySelector('#swapBranches'),
  loadStatus: document.querySelector('#loadStatus'),
  allSheets: document.querySelector('#allSheets'),
  sheet: document.querySelector('#sheet'),
  ignoreEmpty: document.querySelector('#ignoreEmpty'),
  dateFormat: document.querySelector('#dateFormat'),
  statusMeta: document.querySelector('#statusMeta'),
  changedFiles: document.querySelector('#changedFiles'),
  diffMeta: document.querySelector('#diffMeta'),
  sheetList: document.querySelector('#sheetList'),
  message: document.querySelector('#message'),
  localFileOld: document.querySelector('#localFileOld'),
  pickLocalFileOld: document.querySelector('#pickLocalFileOld'),
  localFileNew: document.querySelector('#localFileNew'),
  pickLocalFileNew: document.querySelector('#pickLocalFileNew'),
  runLocalDiff: document.querySelector('#runLocalDiff'),
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
    modeBranch: 'Branch vs branch',
    baseBranch: 'Base (old)',
    headBranch: 'Compare (new)',
    swapBranches: 'Swap',
    selectBranches: 'Select base and compare branches first.',
    load: 'Load',
    allSheets: 'All sheets',
    sheet: 'Sheet',
    ignoreEmpty: 'Ignore empty rows',
    dateFormat: 'Date format',
    changedXlsx: 'Changed xlsx',
    noRepoSelected: 'No repo selected',
    selectRepoThenLoad: 'Select a repo, then load changed files.',
    diff: 'Sheet Diff',
    noDiffGenerated: 'No diff generated',
    openDir: 'Open',
    noEntries: 'No directories or xlsx files.',
    repoSelected: 'Repo selected',
    selectRepoFirst: 'Select a repo directory first.',
    loading: 'Loading...',
    changedCount: (count, modeLabel) => `${count} changed xlsx file${count === 1 ? '' : 's'} - ${modeLabel}`,
    noChangedFiles: 'No changed xlsx files.',
    diffButton: 'Diff',
    generatingDiff: 'Generating diff...',
    noTableDiff: 'No table diff.',
    missingToken: 'Missing launch token. Start this page from XlsxDiffHtml.app.',
    changeRoot: 'Change',
    singlePage: 'Single Page',
    dualPage: 'Side-by-side',
    noDiff: 'No Diff',
    hasDiff: 'Changed',
    localDiff: 'Local Diff',
    localDiffDesc: 'Compare two local xlsx files',
    selectFileOld: 'Select file A (old)',
    selectFileNew: 'Select file B (new)',
    browse: 'Browse',
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
    modeBranch: '分支对比分支',
    baseBranch: '基准分支（旧）',
    headBranch: '对比分支（新）',
    swapBranches: '交换',
    selectBranches: '请先选择基准分支和对比分支。',
    load: '加载',
    allSheets: '全部工作表',
    sheet: '工作表',
    ignoreEmpty: '忽略空行',
    dateFormat: '日期格式',
    changedXlsx: '变更的 xlsx',
    noRepoSelected: '未选择仓库',
    selectRepoThenLoad: '先选择仓库，然后加载变更文件。',
    diff: 'sheet差异',
    noDiffGenerated: '尚未生成差异',
    openDir: '打开',
    noEntries: '没有目录或 xlsx 文件。',
    repoSelected: '已选择仓库',
    selectRepoFirst: '请先选择一个仓库目录。',
    loading: '加载中...',
    changedCount: (count, modeLabel) => `${count} 个变更的 xlsx 文件 - ${modeLabel}`,
    noChangedFiles: '没有变更的 xlsx 文件。',
    diffButton: '差异',
    generatingDiff: '正在生成差异...',
    noTableDiff: '表格内容无差异。',
    missingToken: '缺少启动 token。请从 XlsxDiffHtml.app 启动页面。',
    changeRoot: '更改',
    singlePage: '单页',
    dualPage: '双页',
    noDiff: '无差异',
    hasDiff: '有差异',
    localDiff: '本地对比',
    localDiffDesc: '对比本地两个 xlsx 文件',
    selectFileOld: '选择文件 A（旧）',
    selectFileNew: '选择文件 B（新）',
    browse: '浏览',
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
  if (el.sheetList.classList.contains('empty')) {
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
  el.rootPath.title = root.rootDisplayPath;
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
  el.rootPath.title = result.rootDisplayPath;
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
  const selectedPath = await pickNativePath('folder');
  if (selectedPath) {
    await applyNewRoot(selectedPath);
  }
}

async function pickNativePath(kind) {
  if (state.isTauri) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) {
      throw new Error('Tauri native API is unavailable.');
    }
    return invoke('pick_native_path', { kind });
  }

  const endpoint = kind === 'folder'
    ? '/api/open-folder-dialog'
    : '/api/open-file-dialog';
  const result = await api(endpoint, { method: 'POST' });
  return result.path || null;
}

async function openDir(path) {
  setMessage('');
  const data = await api(`/api/list?path=${encodeQuery(path)}`);
  state.currentPath = data.path;
  state.currentHasGit = data.hasGit;
  el.currentPath.textContent = data.path || '.';
  el.currentPath.title = data.path || '.';
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
    name.title = dir.name;
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
    name.title = file.name;
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
  // Drop any branch list cached from a previously selected repo so branch mode
  // re-fetches refs instead of querying the new repo with stale branch names.
  state.refs = null;
  el.baseBranch.textContent = '';
  el.headBranch.textContent = '';
  if (el.repoMode.value === 'branch') {
    loadRefs().then(() => loadStatus()).catch(showError);
  } else {
    loadStatus().catch(showError);
  }
}

function updateModeUI() {
  el.branchRow.style.display = el.repoMode.value === 'branch' ? '' : 'none';
}

function populateBranchSelect(select, refs, selected) {
  select.textContent = '';
  for (const ref of refs) {
    const option = document.createElement('option');
    option.value = ref;
    option.textContent = ref;
    if (ref === selected) option.selected = true;
    select.append(option);
  }
}

function defaultBaseRef(refs, current) {
  const preferred = refs.find((r) => (r === 'main' || r === 'master') && r !== current);
  if (preferred) return preferred;
  const other = refs.find((r) => r !== current);
  return other || current || refs[0] || '';
}

async function loadRefs() {
  if (!state.repo) return;
  const data = await api(`/api/repo/refs?repo=${encodeQuery(state.repo)}`);
  const refs = data.refs || [];
  state.refs = refs;
  const current = data.current || '';
  populateBranchSelect(el.baseBranch, refs, defaultBaseRef(refs, current));
  populateBranchSelect(el.headBranch, refs, current || refs[0] || '');
}

async function loadStatus() {
  if (!state.repo) {
    setMessage(t('selectRepoFirst'), true);
    return;
  }
  const mode = el.repoMode.value;
  let query = `/api/repo/status?repo=${encodeQuery(state.repo)}&mode=${encodeQuery(mode)}`;
  let modeLabel = mode === 'staged' ? t('modeStaged') : t('modeWorking');
  if (mode === 'branch') {
    const base = el.baseBranch.value;
    const head = el.headBranch.value;
    if (!base || !head) {
      setMessage(t('selectBranches'), true);
      return;
    }
    query += `&base=${encodeQuery(base)}&head=${encodeQuery(head)}`;
    modeLabel = `${base} → ${head}`;
  }
  setMessage('');
  el.changedFiles.className = 'list empty';
  el.changedFiles.textContent = t('loading');
  const data = await api(query);
  renderChangedFiles(data.files);
  el.statusMeta.textContent = t('changedCount', data.files.length, modeLabel);
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
    button.addEventListener('click', () => runGitDiff(file).catch(showError));
    row.append(name, status, button);
    el.changedFiles.append(row);
  }
}

async function runGitDiff(file) {
  setMessage(t('generatingDiff'));
  const mode = el.repoMode.value;
  const path = typeof file === 'string' ? file : file.path;
  const oldPath = typeof file === 'string' ? path : (file.oldPath || path);
  const payload = {
    repo: state.repo,
    file: path,
    mode,
    ...diffOptions(),
  };
  let label = path;
  if (mode === 'branch') {
    payload.base = el.baseBranch.value;
    payload.head = el.headBranch.value;
    payload.oldFile = oldPath;
    label = oldPath !== path
      ? `${payload.base} → ${payload.head} · ${oldPath} → ${path}`
      : `${payload.base} → ${payload.head} · ${path}`;
  }
  const result = await api('/api/diff/git', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  showDiff(result, label);
}

function openUrl(url, event) {
  if (event) {
    event.preventDefault();
  }
  if (!state.isTauri) {
    window.open(url, '_blank', 'noreferrer');
    return;
  }
  let targetUrl = url;
  if (url.startsWith('/')) {
    targetUrl = `${window.location.origin}${url}`;
  }
  api('/api/open-url', { method: 'POST', body: JSON.stringify({ url: targetUrl }) }).catch(showError);
}

function showDiff(result, label) {
  setMessage('');
  el.diffMeta.textContent = label;
  renderSheetList(result.sheets);
}

function renderSheetList(sheets) {
  el.sheetList.textContent = '';
  el.sheetList.classList.remove('empty');

  if (!sheets || sheets.length === 0) {
    el.sheetList.classList.add('empty');
    el.sheetList.textContent = t('noTableDiff');
    return;
  }

  const hasAnyDiff = sheets.some(s => s.hasDiff);
  if (!hasAnyDiff) {
    setMessage(t('noTableDiff'));
  }

  for (const sheet of sheets) {
    const row = document.createElement('div');
    row.className = 'sheet-row';

    const name = document.createElement('div');
    name.className = 'sheet-name';
    name.textContent = sheet.name;
    name.title = sheet.name;

    const badge = document.createElement('span');
    badge.className = `status-badge ${sheet.hasDiff ? 'has-diff' : 'no-diff'}`;
    badge.textContent = sheet.hasDiff ? t('hasDiff') : t('noDiff');

    row.append(name, badge);

    if (sheet.hasDiff) {
      const singleBtn = document.createElement('button');
      singleBtn.type = 'button';
      singleBtn.className = 'sheet-btn';
      singleBtn.textContent = t('singlePage');
      singleBtn.addEventListener('click', (e) => openUrl(sheet.htmlUrl, e));

      const dualBtn = document.createElement('button');
      dualBtn.type = 'button';
      dualBtn.className = 'sheet-btn primary';
      dualBtn.textContent = t('dualPage');
      dualBtn.addEventListener('click', (e) => openUrl(sheet.sbsUrl, e));

      row.append(singleBtn, dualBtn);
    } else {
      const spacer1 = document.createElement('div');
      const spacer2 = document.createElement('div');
      row.append(spacer1, spacer2);
    }

    el.sheetList.append(row);
  }
}

function showError(error) {
  setMessage(error.message || String(error), true);
}

async function pickLocalFile(inputEl) {
  setMessage('');
  const selectedPath = await pickNativePath('file');
  if (selectedPath) {
    inputEl.value = selectedPath;
  }
}

async function runLocalDiff() {
  const oldFile = el.localFileOld.value;
  const newFile = el.localFileNew.value;
  if (!oldFile || !newFile) {
    setMessage(state.lang === 'zh' ? '请先选择两个本地文件。' : 'Please select both local files first.', true);
    return;
  }

  setMessage(t('generatingDiff'));
  try {
    const result = await api('/api/diff/local', {
      method: 'POST',
      body: JSON.stringify({
        oldFile,
        newFile,
        ...diffOptions(),
      }),
    });
    
    showDiff(result, `${getFileName(oldFile)} vs ${getFileName(newFile)}`);
  } catch (err) {
    showError(err);
  }
}

function getFileName(filePath) {
  if (!filePath) return '';
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1];
}

el.changeRoot.addEventListener('click', () => pickRootFolder().catch(showError));
el.refreshTree.addEventListener('click', () => openDir(state.currentPath).catch(showError));
el.upDir.addEventListener('click', () => openDir(el.upDir.dataset.path || '').catch(showError));
el.useCurrentRepo.addEventListener('click', () => useRepo(state.currentPath));
el.loadStatus.addEventListener('click', () => loadStatus().catch(showError));
el.repoMode.addEventListener('change', () => {
  updateModeUI();
  if (el.repoMode.value === 'branch') {
    if (!state.repo) return;
    const needRefs = !state.refs || !state.refs.length;
    (needRefs ? loadRefs() : Promise.resolve()).then(() => loadStatus()).catch(showError);
  } else if (state.repo) {
    loadStatus().catch(showError);
  }
});
el.baseBranch.addEventListener('change', () => {
  if (state.repo && el.repoMode.value === 'branch') loadStatus().catch(showError);
});
el.headBranch.addEventListener('change', () => {
  if (state.repo && el.repoMode.value === 'branch') loadStatus().catch(showError);
});
el.swapBranches.addEventListener('click', () => {
  const base = el.baseBranch.value;
  el.baseBranch.value = el.headBranch.value;
  el.headBranch.value = base;
  if (state.repo && el.repoMode.value === 'branch') loadStatus().catch(showError);
});
el.language.addEventListener('change', () => {
  state.lang = el.language.value === 'zh' ? 'zh' : 'en';
  localStorage.setItem('xlsx-diff-html-lang', state.lang);
  api('/api/settings', { method: 'POST', body: JSON.stringify({ lang: state.lang }) }).catch(() => {});
  applyLanguage();
  openDir(state.currentPath).catch(showError);
  if (state.repo) loadStatus().catch(showError);
});
el.pickLocalFileOld.addEventListener('click', () => pickLocalFile(el.localFileOld).catch(showError));
el.pickLocalFileNew.addEventListener('click', () => pickLocalFile(el.localFileNew).catch(showError));
el.runLocalDiff.addEventListener('click', () => runLocalDiff());

applyLanguage();
updateModeUI();

if (!state.token) {
  setMessage(t('missingToken'), true);
} else {
  loadRoot()
    .then(() => openDir(''))
    .catch(showError);
}
