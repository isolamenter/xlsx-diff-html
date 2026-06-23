import { spawn } from 'node:child_process';

export function stripLongPathPrefix(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + p.slice(8);
  }
  if (p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}

export async function spawnGit(args, cwd) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    const proc = spawn('git', args, { cwd: stripLongPathPrefix(cwd), stdio: 'pipe' });
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    proc.on('error', (e) => {
      resolve({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(e.message) });
    });
  });
}

export function parseGitStatus(buffer, mode) {
  const entries = buffer.toString('utf8').split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i += 1;
    if (!file.toLowerCase().endsWith('.xlsx')) continue;
    const isStaged = status[0] !== ' ' && status[0] !== '?';
    if (mode === 'staged' && !isStaged) continue;
    files.push({ path: file, status, staged: status[0], working: status[1] });
  }
  return files;
}

// Parse the NUL-delimited output of `git diff --name-status -z <base> <head>`.
// Each record is a status token followed by one path (or two paths for
// renames/copies: the source path then the destination path). For renames/
// copies `path` is the destination and `oldPath` is the source, so callers can
// read the base side of the diff from the path the blob actually had there.
export function parseGitDiffNameStatus(buffer) {
  const tokens = buffer.toString('utf8').split('\0');
  const files = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) { i += 1; continue; }
    const code = status[0];
    let file;
    let oldPath;
    if (code === 'R' || code === 'C') {
      oldPath = tokens[i + 1]; // source path
      file = tokens[i + 2]; // destination path
      i += 3;
    } else {
      file = tokens[i + 1];
      i += 2;
    }
    if (!file || !file.toLowerCase().endsWith('.xlsx')) continue;
    files.push({ path: file, oldPath: oldPath || file, status, staged: code, working: ' ' });
  }
  return files;
}
