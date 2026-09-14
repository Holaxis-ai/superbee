import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, readdir, lstat, readFile } from 'node:fs/promises';

export async function isolatedEnvironment(root) {
  const home = path.join(root, 'home');
  const env = {};
  // An allowlist prevents inherited NODE_OPTIONS, credentials, remote selection and host overrides.
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CODEX_HOME: path.join(root, 'codex'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: path.join(root, 'opencode'), TMPDIR: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    SUPERBEE_NO_UPDATE_CHECK: '1', SUPERBEE_NO_AUTOPULL: '1', ASLITE_NO_UPDATE_CHECK: '1',
    AGENTSTATE_LITE_NO_AUTOPULL: '1', NO_UPDATE_NOTIFIER: '1', CI: '1',
    npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_globalconfig: path.join(root, 'npm-globalrc'), npm_config_offline: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
  });
  for (const dir of [home, env.LOCALAPPDATA, env.APPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME,
    env.XDG_CONFIG_HOME, env.OPENCODE_CONFIG_DIR, env.TMPDIR, env.npm_config_cache]) await mkdir(dir, { recursive: true });
  return env;
}

export function run(command, args, { cwd, env, input = '', dialogue, notifications = {}, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure = null, killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      if (process.platform === 'win32') {
        // taskkill /T owns descendants; no shell interpolation of artifact paths.
        const killer = spawn(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => { failure = 'timeout'; kill(); }, timeout);
    const collect = (which, chunk) => {
      if (which === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 8 * 1024 * 1024) { failure = 'output-limit'; kill(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let pending = '', step = 0;
    child.stdout.on('data', (s) => {
      collect('stdout', s);
      if (!dialogue) return;
      pending += s;
      while (pending.includes('\n')) {
        const boundary = pending.indexOf('\n'), line = pending.slice(0,boundary); pending = pending.slice(boundary+1);
        try {
          const response = JSON.parse(line);
          if (response.id === dialogue[step]?.id) {
            step++;
            if (step < dialogue.length) {
              for (const message of notifications[step] || []) child.stdin.write(JSON.stringify(message)+'\n');
              child.stdin.write(JSON.stringify(dialogue[step])+'\n');
            }
            else child.stdin.end();
          }
        } catch { failure = 'invalid-json-rpc'; kill(); }
      }
    }); child.stderr.on('data', (s) => collect('stderr', s));
    child.stdin.on('error', () => {});
    if (dialogue) child.stdin.write(JSON.stringify(dialogue[0])+'\n'); else child.stdin.end(input);
    child.on('error', (e) => { failure = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Clear any surviving members of our private process group, including inherited pipe holders.
      if (process.platform !== 'win32') kill();
      resolve({ code, signal, failure, stdout, stderr });
    });
  });
}

export async function snapshot(root) {
  const files = {};
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const absolute = path.join(dir, name), relative = prefix + name, info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Unexpected symlink in fixture: ${relative}`);
      if (info.isDirectory()) await walk(absolute, `${relative}/`);
      else if (info.isFile()) files[relative] = { bytes: (await readFile(absolute)).toString('base64'), mode: info.mode & 0o777 };
      else throw new Error(`Unexpected special fixture file: ${relative}`);
    }
  }
  await walk(root); return files;
}
