import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xlsxBufferToCsv, xlsxSheetToCsv, XLSX_READ_OPTIONS } from '../../lib/engine.mjs';
import { parseDirectCompareArgs, runDirectCompare } from '../../lib/direct-compare.mjs';
import { csvDiffToHtml, csvDiffToHtmlSideBySide } from '../../lib/daff.mjs';
import { spawnGit, parseGitStatus, parseGitDiffNameStatus, stripLongPathPrefix } from '../../lib/git.mjs';
import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = process.env.XLSX_PUBLIC_DIR || path.join(APP_DIR, 'public');
const TOKEN = process.env.XLSX_DIFF_HTML_TOKEN || crypto.randomBytes(24).toString('hex');
const READY_FILE = process.env.XLSX_DIFF_HTML_READY_FILE || '';
const ROOT_INPUT = process.env.XLSX_DIFF_HTML_ROOT || PACKAGE_ROOT;
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

// kind: 'folder' selects a directory; 'file' selects a single .xlsx file.
async function openNativeDialog(kind) {
  let command, args;
  if (process.platform === 'darwin') {
    command = 'osascript';
    const expr = kind === 'folder'
      ? 'POSIX path of (choose folder)'
      : 'POSIX path of (choose file of type {"org.openxmlformats.spreadsheetml.sheet"})';
    args = ['-e', expr];
  } else if (process.platform === 'win32') {
    command = 'powershell';
    const ps = kind === 'folder'
      ? 'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { exit 1 }'
      : 'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = "Excel Files (*.xlsx)|*.xlsx"; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileName } else { exit 1 }';
    args = ['-NoProfile', '-Command', ps];
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

function normalizeRepoMode(value) {
  if (value === 'staged') return 'staged';
  if (value === 'branch') return 'branch';
  return 'working';
}

// Validate that a ref name is safe to embed in a git command and resolves to a
// commit in the given repository. Returns the trimmed ref.
async function validateRef(repoReal, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, `${label} ref is required`);
  }
  const ref = value.trim();
  if (ref.length > 200 || ref.startsWith('-') || /[\0\n\r]/.test(ref)) {
    throw httpError(400, `${label} ref is invalid`);
  }
  const verify = await runCommand('git', ['-C', repoReal, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: ROOT_REAL,
    env: toolEnv(),
    timeoutMs: 15000,
  });
  if (verify.code !== 0) {
    throw httpError(400, `${label} ref was not found: ${ref}`);
  }
  return ref;
}

async function repoRefs(url) {
  const repoReal = await validateRepoRoot(url.searchParams.get('repo') || '');
  const result = await runCommand('git', [
    'for-each-ref',
    '--format=%(refname:short)%00%(symref)',
    '--sort=-committerdate',
    'refs/heads', 'refs/remotes', 'refs/tags',
  ], { cwd: repoReal, env: toolEnv(), timeoutMs: 15000 });

  if (result.code !== 0) {
    throw commandHttpError(500, 'git for-each-ref failed', result);
  }

  const refs = result.stdout.toString('utf8')
    .split('\n')
    .map((line) => line.split('\0'))
    .filter(([name, symref]) => name && name.trim() && !symref) // drop symbolic refs (e.g. origin/HEAD)
    .map(([name]) => name.trim());

  const headResult = await runCommand('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd: repoReal,
    env: toolEnv(),
    timeoutMs: 15000,
  });
  const current = headResult.code === 0 ? headResult.stdout.toString('utf8').trim() : '';

  return { repo: relFromRoot(repoReal), current, refs };
}

async function repoStatus(url) {
  const mode = normalizeRepoMode(url.searchParams.get('mode'));
  const repoReal = await validateRepoRoot(url.searchParams.get('repo') || '');

  if (mode === 'branch') {
    const base = await validateRef(repoReal, url.searchParams.get('base'), 'base');
    const head = await validateRef(repoReal, url.searchParams.get('head'), 'head');
    const result = await runCommand('git', ['diff', '--name-status', '-z', base, head, '--', '*.xlsx'], {
      cwd: repoReal,
      env: toolEnv(),
      timeoutMs: 30000,
    });
    if (result.code !== 0) {
      throw commandHttpError(500, 'git diff failed', result);
    }
    return {
      repo: relFromRoot(repoReal),
      mode,
      base,
      head,
      files: parseGitDiffNameStatus(result.stdout),
    };
  }

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

function createDiffRecord(htmlPath, sbsHtmlPath) {
  const id = crypto.randomBytes(16).toString('hex');
  diffs.set(id, { htmlPath, sbsHtmlPath });
  return id;
}

function readWorkbook(buffer) {
  if (!buffer.length) return null;
  try {
    return XLSX.read(buffer, XLSX_READ_OPTIONS);
  } catch {
    return null;
  }
}

// Pair up the sheets of two workbooks for diffing. Sheets sharing a name are
// matched by name; the remaining sheets are matched positionally (in workbook
// order) so a renamed sheet still diffs against its counterpart instead of
// showing up as one fully-deleted sheet plus one fully-added "new" sheet.
// Returns [{ oldName, newName }] where either side may be null (added/deleted).
function pairSheets(oldNames, newNames) {
  const oldSet = new Set(oldNames);
  const newSet = new Set(newNames);
  const remainingOld = oldNames.filter((n) => !newSet.has(n));
  const pairs = [];
  let ri = 0; // index into remainingOld for positional matching

  // Walk the new workbook's sheets in order to keep the output natural.
  for (const name of newNames) {
    if (oldSet.has(name)) {
      pairs.push({ oldName: name, newName: name });
    } else {
      pairs.push({ oldName: ri < remainingOld.length ? remainingOld[ri] : null, newName: name });
      ri += 1;
    }
  }
  // Old sheets with no positional counterpart are deletions.
  for (let j = ri; j < remainingOld.length; j += 1) {
    pairs.push({ oldName: remainingOld[j], newName: null });
  }
  return pairs;
}

// Diff every sheet across two xlsx buffers, writing per-sheet HTML views to
// SESSION_TMP and returning { sheets: [{ name, hasDiff, htmlUrl, sbsUrl }] }.
async function buildSheetDiffs(oldBuffer, newBuffer, options, beforeLabel, afterLabel) {
  const oldWb = readWorkbook(oldBuffer);
  const newWb = readWorkbook(newBuffer);

  const oldSheets = oldWb ? oldWb.SheetNames : [];
  const newSheets = newWb ? newWb.SheetNames : [];
  const pairs = pairSheets(oldSheets, newSheets);

  const sheets = [];
  for (const { oldName, newName } of pairs) {
    const displayName = oldName && newName && oldName !== newName
      ? `${oldName} → ${newName}`
      : (newName || oldName);

    let oldCsv = '';
    let newCsv = '';
    if (oldWb && oldName) {
      try { oldCsv = xlsxSheetToCsv(oldWb, oldName, options); } catch { /* empty CSV fallback */ }
    }
    if (newWb && newName) {
      try { newCsv = xlsxSheetToCsv(newWb, newName, options); } catch { /* empty CSV fallback */ }
    }

    const hasDiff = oldCsv !== newCsv;
    let htmlUrl = '';
    let sbsUrl = '';

    if (hasDiff) {
      const prefix = crypto.randomBytes(12).toString('hex');
      const htmlPath = path.join(SESSION_TMP, `${prefix}.html`);
      const sbsHtmlPath = path.join(SESSION_TMP, `${prefix}.sbs.html`);

      const htmlContent = csvDiffToHtml(oldCsv, newCsv, beforeLabel, afterLabel, displayName);
      const sbsHtmlContent = csvDiffToHtmlSideBySide(oldCsv, newCsv, beforeLabel, afterLabel, displayName);

      await fsp.mkdir(path.dirname(htmlPath), { recursive: true });
      await fsp.writeFile(htmlPath, htmlContent);
      await fsp.writeFile(sbsHtmlPath, sbsHtmlContent);

      const id = createDiffRecord(htmlPath, sbsHtmlPath);
      htmlUrl = `/diff/${id}?token=${TOKEN}`;
      sbsUrl = `/diff/${id}/sbs?token=${TOKEN}`;
    }

    sheets.push({ name: displayName, hasDiff, htmlUrl, sbsUrl });
  }

  return { sheets };
}

// A non-zero `git show <ref>:<path>` simply means the blob is absent from that
// ref (an added or deleted file) — a legitimate empty side, not a failure. The
// last two patterns cover an unborn HEAD (a repo with no commits yet), where
// `git show HEAD:<path>` cannot resolve HEAD — there the empty side is correct.
function isMissingBlobError(result) {
  const stderr = result.stderr.toString('utf8');
  return /does not exist in|exists on disk, but not in|invalid object name|unknown revision/.test(stderr);
}

// Read an xlsx blob via `git show <spec>` (e.g. `main:file`, `HEAD:file`,
// `:file` for the index). Returns an empty buffer when the blob is genuinely
// absent from the ref, but surfaces any other git failure instead of silently
// degrading to an "everything is new" diff.
async function gitShowBuffer(spec, repoReal, label) {
  const result = await spawnGit(['show', spec], repoReal);
  if (result.code === 0) {
    console.error(`[diff/git] ${label} ${spec} -> ${result.stdout.length} bytes`);
    return result.stdout;
  }
  if (isMissingBlobError(result)) {
    console.error(`[diff/git] ${label} ${spec} absent in ref (empty side)`);
    return Buffer.alloc(0);
  }
  const stderr = result.stderr.toString('utf8').trim();
  console.error(`[diff/git] ${label} git show ${spec} failed (code ${result.code}): ${stderr}`);
  throw commandHttpError(500, `git show failed for ${spec}`, result);
}

async function diffGit(req) {
  const body = await readJson(req);
  const mode = normalizeRepoMode(body.mode);
  const repoReal = await validateRepoRoot(body.repo || '');
  const file = await validateRepoFile(repoReal, body.file || '');
  const options = readDiffOptions(body);

  if (mode === 'branch') {
    const base = await validateRef(repoReal, body.base, 'base');
    const head = await validateRef(repoReal, body.head, 'head');
    // For renames/copies the blob lived under a different path in `base`.
    const oldFile = body.oldFile ? await validateRepoFile(repoReal, body.oldFile) : file;
    const oldBuffer = await gitShowBuffer(`${base}:${oldFile}`, repoReal, 'base');
    const newBuffer = await gitShowBuffer(`${head}:${file}`, repoReal, 'head');
    return buildSheetDiffs(oldBuffer, newBuffer, options, `${base}:${oldFile}`, `${head}:${file}`);
  }

  // Get old xlsx from HEAD
  const oldBuffer = await gitShowBuffer(`HEAD:${file}`, repoReal, 'HEAD');

  // Get new xlsx from working tree or staged index
  let newBuffer;
  if (mode === 'staged') {
    newBuffer = await gitShowBuffer(`:${file}`, repoReal, 'index');
  } else {
    try {
      newBuffer = await fsp.readFile(path.join(repoReal, file));
    } catch {
      newBuffer = Buffer.alloc(0);
    }
  }

  const beforeLabel = `HEAD:${file}`;
  const afterLabel = mode === 'staged' ? `Index:${file}` : file;
  return buildSheetDiffs(oldBuffer, newBuffer, options, beforeLabel, afterLabel);
}

async function diffLocal(req) {
  const body = await readJson(req);
  const oldFile = body.oldFile;
  const newFile = body.newFile;

  if (typeof oldFile !== 'string' || typeof newFile !== 'string') {
    throw httpError(400, 'oldFile and newFile must be strings');
  }

  const oldPath = path.isAbsolute(oldFile) ? oldFile : path.resolve(ROOT_REAL, oldFile);
  const newPath = path.isAbsolute(newFile) ? newFile : path.resolve(ROOT_REAL, newFile);

  if (!(await fileExists(oldPath))) {
    throw httpError(404, `oldFile not found: ${oldFile}`);
  }
  if (!(await fileExists(newPath))) {
    throw httpError(404, `newFile not found: ${newFile}`);
  }

  const options = readDiffOptions(body);
  const [oldBuffer, newBuffer] = await Promise.all([
    fsp.readFile(oldPath),
    fsp.readFile(newPath),
  ]);

  return buildSheetDiffs(oldBuffer, newBuffer, options, oldFile, newFile);
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
      openUrlInBrowser(target);
      return json(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder-dialog') {
      const { path: selectedPath, supported } = await openNativeDialog('folder');
      return json(res, 200, { path: selectedPath, supported });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-file-dialog') {
      const { path: selectedPath, supported } = await openNativeDialog('file');
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
    if (req.method === 'GET' && url.pathname === '/api/repo/refs') {
      return json(res, 200, await repoRefs(url));
    }
    if (req.method === 'GET' && url.pathname === '/api/repo/status') {
      return json(res, 200, await repoStatus(url));
    }
    if (req.method === 'POST' && url.pathname === '/api/diff/git') {
      return json(res, 200, await diffGit(req));
    }
    if (req.method === 'POST' && url.pathname === '/api/diff/local') {
      return json(res, 200, await diffLocal(req));
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

  const beforeLabel = relFromRoot(localPath);
  const afterLabel = relFromRoot(remotePath);

  const html = csvDiffToHtml(oldCsv, newCsv, beforeLabel, afterLabel, 'all');
  const htmlPath = path.join(SESSION_TMP, 'startup.html');
  await fsp.writeFile(htmlPath, html);

  const sbsHtml = csvDiffToHtmlSideBySide(oldCsv, newCsv, beforeLabel, afterLabel, 'all');
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

  console.log(`xlsx-diff-html web server listening on ${url}`);
  console.log(`root: ${ROOT_REAL}`);
}

async function shutdown() {
  server.close();
  if (SESSION_TMP) await fsp.rm(SESSION_TMP, { recursive: true, force: true }).catch(() => {});
}

async function runOneShotCompare() {
  const parsed = parseDirectCompareArgs(process.argv.slice(2));
  const result = await runDirectCompare({
    ...parsed,
    invocationCwd: process.env.XLSX_DIFF_INVOCATION_CWD || process.cwd(),
  });
  console.log(result.stdout);
  if (parsed.autoOpen) openUrlInBrowser(result.htmlPath);
}

if (process.env.XLSX_DIFF_HTML_ONESHOT === '1') {
  runOneShotCompare().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
} else {
  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  start().catch((err) => { console.error(err); process.exit(1); });
}
