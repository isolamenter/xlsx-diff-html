#!/usr/bin/env node
import { runDiff, normalizeFilePath, collectChangedXlsx } from './lib/engine.mjs';
import { runDirectCompare } from './lib/direct-compare.mjs';
import { spawnGit } from './lib/git.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  xlsx-diff-html [options] FILE.xlsx [FILE2.xlsx ...]\n' +
    '  xlsx-diff-html [options] --changed\n' +
    '  xlsx-diff-html [options] --compare LOCAL.xlsx REMOTE.xlsx\n' +
    '\n' +
    'Options:\n' +
    '  --all                     Export every sheet; sheets are separated by a blank line. Default.\n' +
    '  --sheet N                 Export only sheet N (1-based).\n' +
    '  --staged                  Compare HEAD vs staged index instead of working tree.\n' +
    '  --changed                 Compare all changed .xlsx files reported by git status.\n' +
    '  --compare LOCAL REMOTE    Compare two files directly (no git). Use as external difftool:\n' +
    '                            set Arguments to "--compare $LOCAL $REMOTE" in your Git client.\n' +
    '  --ignore-empty            Drop blank rows from the exported CSV.\n' +
    '  --skip-hidden             Skip rows and columns hidden in the sheet. Default: keep them.\n' +
    '  --raw                     Emit raw cell values instead of Excel-formatted display text.\n' +
    '  --date-format FORMAT      Render date cells with an Excel number-format code,\n' +
    '                            for example "yyyy-mm-dd". Default: yyyy-mm-dd.\n' +
    '                            Pass an empty string (--date-format "") to keep each\n' +
    '                            cell\'s own displayed date format instead.\n' +
    '  --open                    Open generated HTML in the browser. Default.\n' +
    '  --no-open                 Do not open generated HTML.\n' +
    '  --output PATH             Output HTML file. For git mode with many inputs, a directory.\n' +
    '  -h, --help                Show this help.\n',
  );
}

function die(msg) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function warn(msg) {
  process.stderr.write(`Warning: ${msg}\n`);
}

function openBrowser(htmlPath) {
  let cmd;
  if (process.platform === 'darwin') cmd = `open ${JSON.stringify(htmlPath)}`;
  else if (process.platform === 'win32') {
    const safePath = htmlPath.replace(/\\/g, '/');
    cmd = `start "" "${safePath}"`;
  }
  else cmd = `xdg-open ${JSON.stringify(htmlPath)}`;
  exec(cmd, (err) => {
    if (err) warn(`failed to open browser for ${htmlPath}`);
  });
}

// Parse argv
const argv = process.argv.slice(2);
let sheetMode = 'all';
let sheet = 1;
let staged = false;
let changed = false;
let compareMode = false;
let localFile = '';
let remoteFile = '';
let ignoreEmpty = false;
let skipHidden = false;
let raw = false;
let dateFormat = 'yyyy-mm-dd';
let autoOpen = true;
let outputPath = '';
const inputFiles = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  switch (arg) {
    case '--all': sheetMode = 'all'; break;
    case '--sheet': {
      i += 1;
      const n = Number(argv[i]);
      if (!Number.isInteger(n) || n < 1) die('--sheet must be a positive integer');
      sheet = n;
      sheetMode = 'single';
      break;
    }
    case '--staged': staged = true; break;
    case '--changed': changed = true; break;
    case '--compare': {
      compareMode = true;
      i += 1;
      if (i >= argv.length) die('--compare requires two paths: LOCAL REMOTE');
      localFile = argv[i];
      i += 1;
      if (i >= argv.length) die('--compare requires two paths: LOCAL REMOTE');
      remoteFile = argv[i];
      break;
    }
    case '--ignore-empty': ignoreEmpty = true; break;
    case '--skip-hidden': skipHidden = true; break;
    case '--raw': raw = true; break;
    case '--date-format':
      i += 1;
      if (i >= argv.length) die('--date-format requires a format string');
      dateFormat = argv[i];
      break;
    case '--open': autoOpen = true; break;
    case '--no-open': autoOpen = false; break;
    case '--output':
      i += 1;
      if (i >= argv.length) die('--output requires a path');
      outputPath = argv[i];
      break;
    case '-h': case '--help': usage(); process.exit(0); break;
    case '--':
      for (i += 1; i < argv.length; i += 1) inputFiles.push(argv[i]);
      break;
    default:
      if (arg.startsWith('-')) die(`unknown option: ${arg}`);
      inputFiles.push(arg);
  }
}

const options = { sheetMode, sheet, ignoreEmpty, skipHidden, raw, dateFormat };
const invocationCwd = process.cwd();

// --compare mode: direct file-to-file diff, no git required
if (compareMode) {
  let result;
  try {
    result = await runDirectCompare({
      localFile,
      remoteFile,
      options,
      outputPath,
      invocationCwd,
    });
  } catch (error) {
    die(error.message);
  }

  process.stdout.write(result.stdout + '\n');
  if (autoOpen) openBrowser(result.htmlPath);
  process.exit(0);
}

const mode = staged ? 'staged' : 'working';

// Find git repo root
const topResult = await spawnGit(['rev-parse', '--show-toplevel'], invocationCwd);
if (topResult.code !== 0) {
  if (inputFiles.length === 2) {
    die('not a Git repository. To compare two files directly use: --compare ' + inputFiles.join(' '));
  }
  die('not a Git repository');
}
const repoRoot = topResult.stdout.toString('utf8').trim();

const gitDirResult = await spawnGit(['rev-parse', '--git-dir'], repoRoot);
if (gitDirResult.code !== 0) die('failed to get git dir');
const gitDirAbs = path.resolve(repoRoot, gitDirResult.stdout.toString('utf8').trim());

// Collect files
const files = [...inputFiles];
if (changed) {
  const changedFiles = await collectChangedXlsx(repoRoot, mode);
  for (const f of changedFiles) {
    if (!files.includes(f)) files.push(f);
  }
}

if (!files.length) {
  if (changed) die('no changed .xlsx files found');
  usage();
  process.exit(1);
}

// Resolve --output to absolute path, validate for multi-file case
let outputAbs = '';
let outputIsDir = false;
if (outputPath) {
  outputAbs = path.isAbsolute(outputPath) ? outputPath : path.join(invocationCwd, outputPath);
  try { outputIsDir = (await fsp.stat(outputAbs)).isDirectory(); } catch { outputIsDir = false; }
  if (files.length > 1) {
    const endsWithSep = outputPath.endsWith('/') || outputPath.endsWith(path.sep);
    if (!endsWithSep && !outputIsDir) die('--output must be a directory when comparing multiple files');
  }
}

// Normalize file paths to repo-relative
const normalizedFiles = await Promise.all(
  files.map((f) => normalizeFilePath(f, invocationCwd, repoRoot)),
);

// Print changed list header
if (changed) {
  process.stdout.write('Changed .xlsx files:\n');
  for (const f of normalizedFiles) process.stdout.write(`  ${f}\n`);
  process.stdout.write('\n');
}

// Compute absolute HTML output path for one file
function computeHtmlPath(file) {
  const safeName = file.replace(/[^A-Za-z0-9._-]/g, '_');
  if (outputAbs) {
    const endsWithSep = outputPath.endsWith('/') || outputPath.endsWith(path.sep);
    if (files.length === 1 && !endsWithSep && !outputIsDir) return outputAbs;
    return path.join(outputAbs, `${safeName}.diff.html`);
  }
  return path.join(gitDirAbs, 'xlsx-diff-html', `${safeName}.diff.html`);
}

// Run diffs sequentially
for (let i = 0; i < normalizedFiles.length; i += 1) {
  const file = normalizedFiles[i];
  if (!file.toLowerCase().endsWith('.xlsx')) die(`not an .xlsx file: ${files[i]}`);

  const htmlPath = computeHtmlPath(file);
  let result;
  try {
    result = await runDiff({ repoRoot, file, mode, options, htmlPath });
  } catch (err) {
    die(err.message);
  }

  process.stdout.write(result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr + '\n');

  if (autoOpen) openBrowser(result.htmlPath);

  if (normalizedFiles.length > 1) {
    process.stdout.write('\n');
  }
}
