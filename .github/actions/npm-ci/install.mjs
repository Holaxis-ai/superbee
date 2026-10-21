import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN = /^[A-Za-z0-9_-]{8,512}$/;

export async function installDependencies(env = process.env) {
  if (process.platform === 'win32') throw new Error('This action requires a Linux or macOS runner.');
  const npmToken = env.NPM_CI_TOKEN ?? '';
  const githubToken = env.NPM_CI_GITHUB_TOKEN ?? '';
  const githubScope = env.NPM_CI_GITHUB_SCOPE ?? '';
  const ignoreScripts = env.NPM_CI_IGNORE_SCRIPTS ?? 'true';
  const preflight = env.NPM_CI_PREFLIGHT_SCRIPT ?? '';
  if (!TOKEN.test(npmToken)) throw new Error('npm-token is missing or malformed; grant this repository a read-only npm package secret.');
  if (githubToken || githubScope) {
    if (!TOKEN.test(githubToken) || !/^@[a-z0-9][a-z0-9-]{0,99}$/.test(githubScope)) {
      throw new Error('GitHub Packages requires both github-token and a valid github-scope.');
    }
  }
  if (!['true', 'false'].includes(ignoreScripts)) throw new Error('ignore-scripts must be true or false.');
  if (preflight && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/.test(preflight)) throw new Error('preflight-script must name one npm script.');

  const tokens = [npmToken, githubToken].filter(Boolean);
  const redact = text => tokens.reduce((value, token) => value.split(token).join('***'), text ?? '');
  if (env.GITHUB_ACTIONS === 'true') for (const token of tokens) console.log(`::add-mask::${token}`);
  const directory = await mkdtemp(path.join(env.RUNNER_TEMP || tmpdir(), 'npm-ci-'));
  try {
    const config = path.join(directory, 'npmrc');
    const lines = ['registry=https://registry.npmjs.org/', '//registry.npmjs.org/:_authToken=${CI_NPM_READ_TOKEN}'];
    if (githubScope) lines.push(`${githubScope}:registry=https://npm.pkg.github.com/`, '//npm.pkg.github.com/:_authToken=${CI_GITHUB_PACKAGES_TOKEN}');
    await writeFile(config, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    const childEnv = {
      ...env, npm_config_userconfig: config, NPM_CONFIG_USERCONFIG: config,
      CI_NPM_READ_TOKEN: npmToken, CI_GITHUB_PACKAGES_TOKEN: githubToken,
      NPM_READ_TOKEN: npmToken, NODE_AUTH_TOKEN: githubToken || npmToken,
    };
    function run(args, phase) {
      const result = spawnSync('npm', args, {
        env: childEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      process.stdout.write(redact(result.stdout));
      process.stderr.write(redact(result.stderr));
      if (result.error || result.status !== 0) throw new Error(`${phase} failed${Number.isInteger(result.status) ? ` (exit ${result.status})` : ''}; inspect the redacted npm output and registry read grants.`);
    }
    if (preflight) run(['--ignore-scripts', 'run', preflight], 'Dependency preflight');
    run(['ci', '--no-audit', '--no-fund', `--ignore-scripts=${ignoreScripts}`], 'Dependency installation');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installDependencies().catch(error => { console.error(error.message); process.exitCode = 1; });
}
