import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiff, xlsxBufferToCsv } from '../../lib/engine.mjs';
import { csvDiffToHtml } from '../../lib/daff.mjs';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = process.env.XLSX_PUBLIC_DIR || path.join(APP_DIR, 'public');
const TOKEN = process.env.XLSX_DIFF_HTML_TOKEN || crypto.randomBytes(24).toString('hex');
const READY_FILE = process.env.XLSX_DIFF_HTML_READY_FILE || '';
const ROOT_INPUT = process.env.XLSX_DIFF_HTML_ROOT || PACKAGE_ROOT;
let ROOT_REAL;
let SESSION_TMP;
const diffs = new Map();

const BASE_PATH = process.env.PATH || '';

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isXlsxPath(value) {
  return typeof value === 'string' && value.toLowerCase().endsWith('.xlsx');
}

function assertRelativePath(value, label) {
  const rel = value || '';
  if (typeof rel !== 'string') {
    throw httpError(400, `${label} must be a string`);
  }
  if (rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel)) {
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
      cwd,
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

function createDiffRecord(htmlPath) {
  const id = crypto.randomBytes(16).toString('hex');
  diffs.set(id, htmlPath);
  return id;
}

async function diffGit(req) {
  const body = await readJson(req);
  const mode = body.mode === 'staged' ? 'staged' : 'working';
  const repoReal = await validateRepoRoot(body.repo || '');
  const file = await validateRepoFile(repoReal, body.file || '');
  const options = readDiffOptions(body);
  const htmlPath = path.join(SESSION_TMP, `${crypto.randomBytes(12).toString('hex')}.html`);

  let result;
  try {
    result = await runDiff({ repoRoot: repoReal, file, mode, options, htmlPath });
  } catch (err) {
    throw httpError(500, `xlsx diff failed: ${err.message}`);
  }

  const id = createDiffRecord(htmlPath);
  return {
    id,
    htmlUrl: `/diff/${id}?token=${TOKEN}`,
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
  const htmlPath = path.join(SESSION_TMP, `${crypto.randomBytes(12).toString('hex')}.html`);

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

  const id = createDiffRecord(htmlPath);
  const stdout = [
    `Comparing: ${relFromRoot(oldFile)} -> ${relFromRoot(newFile)}`,
    options.sheetMode === 'all' ? 'Sheet: all' : `Sheet: ${options.sheet}`,
    noTableDiff ? 'Diff: no table diff' : '',
  ].filter(Boolean).join('\n');

  return { id, htmlUrl: `/diff/${id}?token=${TOKEN}`, noTableDiff, stdout, stderr: '' };
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
  const id = url.pathname.slice('/diff/'.length);
  const htmlPath = diffs.get(id);
  if (!htmlPath) throw httpError(404, 'diff was not found');
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
      });
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

async function start() {
  ROOT_REAL = await fsp.realpath(ROOT_INPUT);
  SESSION_TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'xlsx-diff-html-web-'));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/?token=${TOKEN}`;
  if (READY_FILE) await fsp.writeFile(READY_FILE, url);
  console.log(`xlsx-diff-html web server listening on ${url}`);
  console.log(`root: ${ROOT_REAL}`);
}

async function shutdown() {
  server.close();
  if (SESSION_TMP) await fsp.rm(SESSION_TMP, { recursive: true, force: true }).catch(() => {});
}

process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

start().catch((err) => { console.error(err); process.exit(1); });
