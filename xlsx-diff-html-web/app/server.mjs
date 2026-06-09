import { spawn, exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiff, xlsxBufferToCsv } from '../../lib/engine.mjs';
import { csvDiffToHtml, csvDiffToHtmlSideBySide } from '../../lib/daff.mjs';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = process.env.XLSX_PUBLIC_DIR || path.join(APP_DIR, 'public');
const TOKEN = process.env.XLSX_DIFF_HTML_TOKEN || crypto.randomBytes(24).toString('hex');
const READY_FILE = process.env.XLSX_DIFF_HTML_READY_FILE || '';
const ROOT_INPUT = process.env.XLSX_DIFF_HTML_ROOT || PACKAGE_ROOT;
const SESSION_FILE = path.join(os.homedir(), '.xlsx-diff-html-session.json');
let ROOT_REAL;
let SESSION_TMP;
const diffs = new Map(); // id → { htmlPath: string|null, sbsHtmlPath: string|null }

const BASE_PATH = process.env.PATH || '';
const SETTINGS_FILE = path.join(os.homedir(), '.xlsx-diff-html-settings.json');
let SETTINGS = {};

async function loadSettings() {
  try {
    const data = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    if (data && typeof data === 'object') SETTINGS = data;
  } catch {
    SETTINGS = {};
  }
}

async function saveSettings() {
  try {
    await fsp.writeFile(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2));
  } catch {
    // non-fatal
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isXlsxPath(value) {
  return typeof value === 'string' && value.toLowerCase().endsWith('.xlsx');
}

function assertRelativePath(value, label) {
  let rel = value || '';
  if (typeof rel !== 'string') {
    throw httpError(400, `${label} must be a string`);
  }
  rel = rel.replace(/\\/g, '/');
  if (rel.includes('\0') || path.isAbsolute(rel)) {
    throw httpError(400, `${label} must be a safe relative path`);
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.includes('..')) {
    throw httpError(400, `${label} cannot contain ..`);
  }
  return rel;
}

async function resolveExistingRelative(value, label) {
  const rel = assertRelativePath(value, label);
  const candidate = path.resolve(ROOT_REAL, rel || '.');
  if (!isInside(ROOT_REAL, candidate)) {
    throw httpError(403, `${label} is outside the tool root`);
  }
  let real;
  try {
    real = await fsp.realpath(candidate);
  } catch {
    throw httpError(404, `${label} was not found`);
  }
  if (!isInside(ROOT_REAL, real)) {
    throw httpError(403, `${label} escapes the tool root`);
  }
  return real;
}

async function validateRepoRoot(repo) {
  const repoReal = await resolveExistingRelative(repo, 'repo');
  const stat = await fsp.stat(repoReal);
  if (!stat.isDirectory()) {
    throw httpError(400, 'repo must be a directory');
  }

  const top = await runCommand('git', ['-C', repoReal, 'rev-parse', '--show-toplevel'], {
    cwd: ROOT_REAL,
    env: toolEnv(),
    timeoutMs: 15000,
  });
  if (top.code !== 0) {
    throw commandHttpError(400, 'repo is not a Git repository', top);
  }

  const topPath = top.stdout.toString('utf8').trim();
  const topReal = await fsp.realpath(topPath);
  if (topReal !== repoReal) {
    throw httpError(400, 'repo must be the Git repository root');
  }
  if (!isInside(ROOT_REAL, topReal)) {
    throw httpError(403, 'repo escapes the tool root');
  }
  return repoReal;
}

async function validateRepoFile(repoReal, file) {
  const rel = assertRelativePath(file, 'file');
  if (!isXlsxPath(rel)) {
    throw httpError(400, 'file must be an .xlsx path');
  }
  const candidate = path.resolve(repoReal, rel);
  if (!isInside(repoReal, candidate) || !isInside(ROOT_REAL, candidate)) {
    throw httpError(403, 'file is outside the repository root');
  }

  try {
    const real = await fsp.realpath(candidate);
    if (!isInside(repoReal, real) || !isInside(ROOT_REAL, real)) {
      throw httpError(403, 'file escapes the tool root');
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }

  return rel;
}

function relFromRoot(absPath) {
  const rel = path.relative(ROOT_REAL, absPath);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

function toolEnv() {
  return { ...process.env, PATH: BASE_PATH };
}

function httpError(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function commandHttpError(statusCode, message, result) {
  return httpError(statusCode, message, {
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
    exitCode: result.code,
  });
}

function stripLongPathPrefix(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + p.slice(8);
  }
  if (p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}

function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT_REAL,
    env = toolEnv(),
    timeoutMs = 120000,
    maxOutputBytes = 20 * 1024 * 1024,
  } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: stripLongPathPrefix(cwd),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
      else outputExceeded = true;
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
      else outputExceeded = true;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat([Buffer.concat(stderr), Buffer.from(String(error.message))]),
        timedOut,
        outputExceeded,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        outputExceeded,
      });
    });
  });
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw httpError(413, 'request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'request body must be valid JSON');
  }
}

function json(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function validateToken(req, url) {
  const header = req.headers['x-xlsx-diff-token'];
  const supplied = Array.isArray(header) ? header[0] : header || url.searchParams.get('token') || '';
  if (supplied !== TOKEN) {
    throw httpError(401, 'invalid or missing token');
  }
}

async function openFolderDialog() {
  let command, args;
  if (process.platform === 'darwin') {
    command = 'osascript';
    args = ['-e', 'POSIX path of (choose folder)'];
  } else if (process.platform === 'win32') {
    command = 'powershell';
    args = [
      '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { exit 1 }',
    ];
  } else {
    return { path: null, supported: false };
  }
  const result = await runCommand(command, args, { timeoutMs: 120000 });
  if (result.code !== 0) return { path: null, supported: true };
  const selected = result.stdout.toString('utf8').trim();
  return { path: selected || null, supported: true };
}

async function listDirectory(url) {
  const dirReal = await resolveExistingRelative(url.searchParams.get('path') || '', 'path');
  const stat = await fsp.stat(dirReal);
  if (!stat.isDirectory()) throw httpError(400, 'path must be a directory');

  const entries = await fsp.readdir(dirReal, { withFileTypes: true });
  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const abs = path.join(dirReal, entry.name);
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch {
      continue;
    }
    if (!isInside(ROOT_REAL, real)) continue;

    if (entry.isDirectory()) {
      let hasGit = false;
      try {
        await fsp.lstat(path.join(abs, '.git'));
        hasGit = true;
      } catch {
        hasGit = false;
      }
      dirs.push({ name: entry.name, path: relFromRoot(abs), hasGit });
    } else if (entry.isFile() && isXlsxPath(entry.name)) {
      files.push({ name: entry.name, path: relFromRoot(abs) });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  let currentHasGit = false;
  try {
    await fsp.lstat(path.join(dirReal, '.git'));
    currentHasGit = true;
  } catch {
    currentHasGit = false;
  }

  return {
    path: relFromRoot(dirReal),
    parent: dirReal === ROOT_REAL ? null : relFromRoot(path.dirname(dirReal)),
    hasGit: currentHasGit,
    dirs,
    files,
  };
}

function parseGitStatus(buffer, mode) {
  const entries = buffer.toString('utf8').split('\0');
  const files = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') index += 1;
    if (!isXlsxPath(file)) continue;

    const staged = status[0] !== ' ' && status[0] !== '?';
    const include = mode === 'staged' ? staged : true;
    if (!include) continue;

    files.push({
      path: file,
      status,
      staged: status[0],
      working: status[1],
    });
  }

  return files;
}

async function repoStatus(url) {
  const mode = url.searchParams.get('mode') === 'staged' ? 'staged' : 'working';
  const repoReal = await validateRepoRoot(url.searchParams.get('repo') || '');
  const result = await runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '*.xlsx'], {
    cwd: repoReal,
    env: toolEnv(),
    timeoutMs: 30000,
  });

  if (result.code !== 0) {
    throw commandHttpError(500, 'git status failed', result);
  }

  return {
    repo: relFromRoot(repoReal),
    mode,
    files: parseGitStatus(result.stdout, mode),
  };
}

function readDiffOptions(body) {
  const sheetMode = body.sheetMode === 'all' ? 'all' : 'single';
  const sheet = Number(body.sheet || 1);
  if (sheetMode === 'single' && (!Number.isInteger(sheet) || sheet < 1)) {
    throw httpError(400, 'sheet must be a positive integer');
  }
  const dateFormat = typeof body.dateFormat === 'string' ? body.dateFormat.trim() : 'yyyy-mm-dd';
  if (dateFormat.length > 80) throw httpError(400, 'dateFormat is too long');

  return {
    sheetMode,
    sheet,
    ignoreEmpty: body.ignoreEmpty === true,
    dateFormat,
  };
}

function diffArgsFromOptions(options) {
  const args = ['--no-open'];
  if (options.sheetMode === 'all') {
    args.push('--all');
  } else {
    args.push('--sheet', String(options.sheet));
  }
  if (options.ignoreEmpty) args.push('--ignore-empty');
  if (options.dateFormat) args.push('--date-format', options.dateFormat);
  return args;
}

function createDiffRecord(htmlPath, sbsHtmlPath) {
  const id = crypto.randomBytes(16).toString('hex');
  diffs.set(id, { htmlPath, sbsHtmlPath });
  return id;
}

async function diffGit(req) {
  const body = await readJson(req);
  const mode = body.mode === 'staged' ? 'staged' : 'working';
  const repoReal = await validateRepoRoot(body.repo || '');
  const file = await validateRepoFile(repoReal, body.file || '');
  const options = readDiffOptions(body);
  const prefix = crypto.randomBytes(12).toString('hex');
  const htmlPath = path.join(SESSION_TMP, `${prefix}.html`);
  const sbsHtmlPath = path.join(SESSION_TMP, `${prefix}.sbs.html`);

  let result;
  try {
    result = await runDiff({ repoRoot: repoReal, file, mode, options, htmlPath, sbsHtmlPath });
  } catch (err) {
    throw httpError(500, `xlsx diff failed: ${err.message}`);
  }

  const id = createDiffRecord(htmlPath, sbsHtmlPath);
  return {
    id,
    htmlUrl: `/diff/${id}?token=${TOKEN}`,
    sbsUrl: `/diff/${id}/sbs?token=${TOKEN}`,
    noTableDiff: result.noTableDiff,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function diffFiles(req) {
  const body = await readJson(req);
  const oldFile = await resolveExistingRelative(body.oldFile || '', 'oldFile');
  const newFile = await resolveExistingRelative(body.newFile || '', 'newFile');
  if (!isXlsxPath(oldFile) || !isXlsxPath(newFile)) {
    throw httpError(400, 'oldFile and newFile must be .xlsx files');
  }

  const oldStat = await fsp.stat(oldFile);
  const newStat = await fsp.stat(newFile);
  if (!oldStat.isFile() || !newStat.isFile()) {
    throw httpError(400, 'oldFile and newFile must be files');
  }

  const options = readDiffOptions(body);
  const prefix = crypto.randomBytes(12).toString('hex');
  const htmlPath = path.join(SESSION_TMP, `${prefix}.html`);
  const sbsHtmlPath = path.join(SESSION_TMP, `${prefix}.sbs.html`);

  const [oldBuffer, newBuffer] = await Promise.all([fsp.readFile(oldFile), fsp.readFile(newFile)]);
  let oldCsv, newCsv;
  try {
    oldCsv = xlsxBufferToCsv(oldBuffer, options);
    newCsv = xlsxBufferToCsv(newBuffer, options);
  } catch (err) {
    throw httpError(500, `xlsx2csv failed: ${err.message}`);
  }

  const noTableDiff = oldCsv === newCsv;
  const html = csvDiffToHtml(oldCsv, newCsv);
  await fsp.writeFile(htmlPath, html);
  await fsp.writeFile(sbsHtmlPath, csvDiffToHtmlSideBySide(oldCsv, newCsv));

  const id = createDiffRecord(htmlPath, sbsHtmlPath);
  const stdout = [
    `Comparing: ${relFromRoot(oldFile)} -> ${relFromRoot(newFile)}`,
    options.sheetMode === 'all' ? 'Sheet: all' : `Sheet: ${options.sheet}`,
    noTableDiff ? 'Diff: no table diff' : '',
  ].filter(Boolean).join('\n');

  return { id, htmlUrl: `/diff/${id}?token=${TOKEN}`, sbsUrl: `/diff/${id}/sbs?token=${TOKEN}`, noTableDiff, stdout, stderr: '' };
}

async function diffExternal(req) {
  const body = await readJson(req);
  const localPath = body.localPath;
  const remotePath = body.remotePath;

  // Accept any absolute paths (git provides temp files outside ROOT_REAL)
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
    throw httpError(400, 'localPath must be an absolute path');
  }
  if (typeof remotePath !== 'string' || !path.isAbsolute(remotePath)) {
    throw httpError(400, 'remotePath must be an absolute path');
  }

  const options = body.options && typeof body.options === 'object'
    ? readDiffOptions(body.options)
    : { sheetMode: 'all', sheet: 1, ignoreEmpty: false, dateFormat: 'yyyy-mm-dd' };

  let oldBuffer, newBuffer;
  try { oldBuffer = await fsp.readFile(localPath); } catch { oldBuffer = Buffer.alloc(0); }
  try { newBuffer = await fsp.readFile(remotePath); } catch { newBuffer = Buffer.alloc(0); }

  let oldCsv, newCsv;
  try {
    oldCsv = xlsxBufferToCsv(oldBuffer, options);
    newCsv = xlsxBufferToCsv(newBuffer, options);
  } catch (err) {
    throw httpError(500, `xlsx2csv failed: ${err.message}`);
  }

  const sbsHtmlPath = path.join(SESSION_TMP, `${crypto.randomBytes(12).toString('hex')}.sbs.html`);
  await fsp.writeFile(sbsHtmlPath, csvDiffToHtmlSideBySide(oldCsv, newCsv));

  const id = createDiffRecord(null, sbsHtmlPath);
  return { id, sbsUrl: `/diff/${id}/sbs?token=${TOKEN}`, noTableDiff: oldCsv === newCsv };
}

async function fileExists(file) {
  try {
    await fsp.access(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function serveDiff(req, res, url) {
  validateToken(req, url);
  const segment = url.pathname.slice('/diff/'.length); // "id" or "id/sbs"
  const isSbs = segment.endsWith('/sbs');
  const id = isSbs ? segment.slice(0, -4) : segment;
  const record = diffs.get(id);
  if (!record) throw httpError(404, 'diff was not found');
  const htmlPath = isSbs ? record.sbsHtmlPath : record.htmlPath;
  if (!htmlPath) throw httpError(404, 'diff view not available');
  await sendFile(res, htmlPath, 'text/html; charset=utf-8');
}

async function sendStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const normalized = path.normalize(rel);
  const file = path.resolve(PUBLIC_DIR, normalized);
  if (!isInside(PUBLIC_DIR, file)) throw httpError(404, 'not found');

  const ext = path.extname(file).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
  await sendFile(res, file, type);
}

async function sendFile(res, file, contentType) {
  const data = await fsp.readFile(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

async function route(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/diff/')) {
      validateToken(req, url);
    }

    if (req.method === 'GET' && url.pathname === '/api/root') {
      return json(res, 200, {
        rootDisplayPath: ROOT_REAL,
        platform: process.platform,
        arch: process.arch,
        lang: typeof SETTINGS.lang === 'string' ? SETTINGS.lang : '',
        isTauri: !!READY_FILE,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-url') {
      const body = await readJson(req);
      const target = body.url;
      if (typeof target !== 'string') throw httpError(400, 'url required');
      const parsed = new URL(target);
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        throw httpError(400, 'only localhost URLs allowed');
      }
      if (process.platform === 'win32') {
        exec(`start "" ${JSON.stringify(target)}`).unref();
      } else {
        let command, args;
        if (process.platform === 'darwin') {
          command = 'open'; args = [target];
        } else {
          command = 'xdg-open'; args = [target];
        }
        spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
      }
      return json(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder-dialog') {
      const { path: selectedPath, supported } = await openFolderDialog();
      return json(res, 200, { path: selectedPath, supported });
    }
    if (req.method === 'POST' && url.pathname === '/api/root') {
      const body = await readJson(req);
      const newPath = body.path;
      if (typeof newPath !== 'string' || !path.isAbsolute(newPath)) {
        throw httpError(400, 'path must be an absolute path string');
      }
      let newReal;
      try {
        newReal = await fsp.realpath(newPath);
      } catch {
        throw httpError(404, 'path does not exist');
      }
      const stat = await fsp.stat(newReal);
      if (!stat.isDirectory()) {
        throw httpError(400, 'path must be a directory');
      }
      ROOT_REAL = newReal;
      SETTINGS.root = ROOT_REAL;
      await saveSettings();
      return json(res, 200, { rootDisplayPath: ROOT_REAL });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      if (body.lang === 'en' || body.lang === 'zh') {
        SETTINGS.lang = body.lang;
        await saveSettings();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/list') {
      return json(res, 200, await listDirectory(url));
    }
    if (req.method === 'GET' && url.pathname === '/api/repo/status') {
      return json(res, 200, await repoStatus(url));
    }
    if (req.method === 'POST' && url.pathname === '/api/diff/git') {
      return json(res, 200, await diffGit(req));
    }
    if (req.method === 'POST' && url.pathname === '/api/diff/files') {
      return json(res, 200, await diffFiles(req));
    }
    if (req.method === 'POST' && url.pathname === '/api/diff/external') {
      return json(res, 200, await diffExternal(req));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/diff/')) {
      return serveDiff(req, res, url);
    }
    if (req.method === 'GET') {
      return sendStatic(res, url.pathname);
    }

    throw httpError(404, 'not found');
  } catch (error) {
    const status = error?.statusCode || 500;
    json(res, status, {
      error: error?.message || 'internal server error',
      stdout: error?.stdout || '',
      stderr: error?.stderr || '',
      exitCode: error?.exitCode ?? null,
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    json(res, 500, { error: error?.message || 'internal server error' });
  });
});

function openUrlInBrowser(url) {
  let command, args;
  if (process.platform === 'darwin') { command = 'open'; args = [url]; }
  else if (process.platform === 'win32') { command = 'cmd'; args = ['/c', 'start', '', url]; }
  else { command = 'xdg-open'; args = [url]; }
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function runStartupDiff(localPath, remotePath, port) {
  let oldBuffer, newBuffer;
  try { oldBuffer = await fsp.readFile(localPath); } catch { oldBuffer = Buffer.alloc(0); }
  try { newBuffer = await fsp.readFile(remotePath); } catch { newBuffer = Buffer.alloc(0); }

  const options = { sheetMode: 'all', sheet: 1, ignoreEmpty: false, skipHidden: false, raw: false, dateFormat: 'yyyy-mm-dd' };
  const oldCsv = xlsxBufferToCsv(oldBuffer, options);
  const newCsv = xlsxBufferToCsv(newBuffer, options);

  const html = csvDiffToHtml(oldCsv, newCsv);
  const htmlPath = path.join(SESSION_TMP, 'startup.html');
  await fsp.writeFile(htmlPath, html);

  const sbsHtml = csvDiffToHtmlSideBySide(oldCsv, newCsv);
  const sbsHtmlPath = path.join(SESSION_TMP, 'startup.sbs.html');
  await fsp.writeFile(sbsHtmlPath, sbsHtml);

  const id = createDiffRecord(htmlPath, sbsHtmlPath);

  // Auto-open external browser with side-by-side view
  openUrlInBrowser(`http://127.0.0.1:${port}/diff/${id}/sbs?token=${TOKEN}`);

  return `/diff/${id}?token=${TOKEN}`;
}

async function start() {
  await loadSettings();
  let startRoot = ROOT_INPUT;
  if (SETTINGS.root && typeof SETTINGS.root === 'string') {
    try {
      const savedReal = await fsp.realpath(SETTINGS.root);
      const stat = await fsp.stat(savedReal);
      if (stat.isDirectory()) startRoot = SETTINGS.root;
    } catch {
      // saved root no longer valid, fall back to ROOT_INPUT
    }
  }
  ROOT_REAL = await fsp.realpath(startRoot);
  SESSION_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'xlsx-diff-html-web-'));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address();
  const diffLocal = process.env.XLSX_DIFF_LOCAL;
  const diffRemote = process.env.XLSX_DIFF_REMOTE;

  let startPath = `/?token=${TOKEN}`;
  if (diffLocal && diffRemote) {
    try {
      startPath = await runStartupDiff(diffLocal, diffRemote, port);
    } catch (err) {
      console.error(`[xlsx-diff-html] startup diff failed: ${err.message}`);
    }
  }

  const url = `http://127.0.0.1:${port}${startPath}`;
  if (READY_FILE) await fsp.writeFile(READY_FILE, url);

  // Write session file so CLI can route external diffs through this server
  const serverBase = `http://127.0.0.1:${port}`;
  try {
    await fsp.writeFile(SESSION_FILE, JSON.stringify({ url: serverBase, token: TOKEN, pid: process.pid }));
  } catch {
    // non-fatal: external diff fallback will handle this
  }

  console.log(`xlsx-diff-html web server listening on ${url}`);
  console.log(`root: ${ROOT_REAL}`);
}

async function shutdown() {
  server.close();
  if (SESSION_TMP) await fsp.rm(SESSION_TMP, { recursive: true, force: true }).catch(() => {});
  // Remove session file only if it belongs to this process
  try {
    const data = JSON.parse(await fsp.readFile(SESSION_FILE, 'utf8'));
    if (data?.pid === process.pid) await fsp.unlink(SESSION_FILE);
  } catch {
    // non-fatal
  }
}

process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

start().catch((err) => { console.error(err); process.exit(1); });
