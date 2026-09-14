import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { run, snapshot } from './process.mjs';
import { digest } from './artifact.mjs';
import { canonicalCommand, normalizeDocument, exactKeys } from './compare.mjs';

export const scenarioNames = ['knowledge', 'integrations', 'private-state', 'process'];
const timestamp = '2020-01-01T00:00:00Z';
const body = 'Preserve user timestamp: 2024-01-01T00:00:00Z, sha256:deadbeef and C:\\Windows\\notes.\n';
export async function executeScenario(name, artifact, root, env, raw) {
  const project = path.join(root, name); await mkdir(project);
  const bundle = path.join(project, 'bundle');
  raw.commands = []; raw.snapshots = {}; const versions = {};
  async function command(label, args, code = 0, options = {}) {
    const result = await run(process.execPath, [artifact.executable, ...args], { cwd: project, env, ...options });
    raw.commands.push({ label, args, result });
    assert.equal(result.failure, null, `${label}: ${result.failure}`); assert.equal(result.code, code, `${label}: ${result.stdout} ${result.stderr}`);
    return result;
  }
  const json = (r) => JSON.parse(r.stdout);
  async function init() {
    const output = json(await command('init', ['init', '--create-only', '--recipe', 'none', '--dir', bundle, '--json']));
    assert.equal(output.root, bundle);
  }
  async function captureDoc(id, token, alias) {
    const bytes = await readFile(path.join(bundle, `${id}.md`), 'utf8');
    assert.equal(token, `sha256:${digest(bytes)}`, 'version must hash persisted bytes');
    versions[token] = alias; raw.snapshots[alias] = bytes; return bytes;
  }
  let semantic;
  if (name === 'knowledge') {
    await init();
    const write = json(await command('write-a', ['doc','write','notes/a','--type','Note','--body',body,'--timestamp',timestamp,'--actor','process:parity','--dir',bundle,'--json']));
    await captureDoc('notes/a', write.version, '<a-created>');
    const read = json(await command('read-a', ['doc','read','notes/a','--dir',bundle,'--json']));
    assert.equal(read.head_version, write.version); assert.equal(read.body, body); assert.equal(read.timestamp, timestamp);
    // Unknown frontmatter survives a field-only patch; deliberately resembles volatile metadata.
    const docPath = path.join(bundle, 'notes/a.md');
    const seeded = (await readFile(docPath, 'utf8')).replace('---\n', '---\nuser_clock: "2024-01-01T00:00:00.000Z"\n');
    await writeFile(docPath, seeded); const old = `sha256:${digest(seeded)}`; versions[old] = '<a-seeded>'; raw.snapshots['<a-seeded>'] = seeded;
    const update = json(await command('update-a', ['doc','update','notes/a','--title','Updated','--expected-version',old,'--actor','process:parity','--dir',bundle,'--json']));
    const updated = await captureDoc('notes/a', update.version, '<a-updated>');
    assert.match(updated, /user_clock: ["']2024-01-01T00:00:00\.000Z["']/); assert.ok(updated.endsWith(body));
    const readUpdated = json(await command('read-updated', ['doc','read','notes/a','--dir',bundle,'--json']));
    assert.equal(readUpdated.head_version, update.version); assert.equal(readUpdated.title, 'Updated'); assert.equal(readUpdated.user_clock, '2024-01-01T00:00:00.000Z');
    const stale = await command('stale-cas', ['doc','update','notes/a','--title','LOST UPDATE','--expected-version',old,'--actor','process:parity','--dir',bundle,'--json'], 5);
    assert.match(stale.stdout + stale.stderr, /STALE_HEAD/); assert.equal(await readFile(docPath,'utf8'), updated, 'stale write must preserve bytes');
    const b = json(await command('write-b', ['doc','write','notes/b','--type','Note','--body','Target\n','--timestamp',timestamp,'--actor','process:parity','--dir',bundle,'--json']));
    await captureDoc('notes/b', b.version, '<b-created>');
    await command('link', ['link','add','notes/a','notes/b','--actor','process:parity','--dir',bundle,'--json']);
    const linked = json(await command('read-linked', ['doc','read','notes/a','--dir',bundle,'--json']));
    await captureDoc('notes/a', linked.head_version, '<a-linked>'); assert.match(linked.body, /b\.md/); assert.ok(linked.body.includes(body.trim()));
    const listed = json(await command('list', ['list','--dir',bundle,'--json'])); assert.equal(listed.count, 2);
    const status = json(await command('status', ['status','--dir',bundle,'--json'])); assert.equal(status.docs, 2); assert.equal(status.unresolved_links, 0);
    await command('init-refusal', ['init','--create-only','--recipe','none','--dir',bundle,'--json'], 5);
    raw.files = await snapshot(bundle);
    semantic = { commands: raw.commands.map((c) => canonicalCommand(c, root, versions)), snapshots: Object.fromEntries(Object.entries(raw.snapshots).map(([k,v])=>[k,normalizeDocument(v)])), files: {} };
    for (const [file, record] of Object.entries(raw.files)) semantic.files[file] = { ...record, bytes: normalizeDocument(Buffer.from(record.bytes,'base64').toString()) };
  } else if (name === 'integrations') {
    for (const verb of ['skill','hook']) {
      await command(`${verb}-install`, [verb,'install','--scope','user','--json']);
      await command(`${verb}-status`, [verb,'status','--scope','user','--json']);
    }
    for (const config of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) assert.ok((await stat(path.join(config,'skills/superbee/SKILL.md'))).isFile());
    const settings = JSON.parse(await readFile(path.join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
    const commands = settings.hooks.SessionStart.flatMap((group)=>group.hooks.map((h)=>h.command));
    assert.equal(commands.length, 1); assert.ok(commands[0].includes(artifact.executable)); assert.ok(commands[0].includes('session-start'));
    raw.installed = { claude: await snapshot(env.CLAUDE_CONFIG_DIR), codex: await snapshot(env.CODEX_HOME) };
    for (const verb of ['hook','skill']) await command(`${verb}-uninstall`, [verb,'uninstall','--scope','user','--json']);
    raw.remaining = { claude: await snapshot(env.CLAUDE_CONFIG_DIR), codex: await snapshot(env.CODEX_HOME) };
    for (const tree of Object.values(raw.remaining)) assert.ok(!Object.keys(tree).some((file)=>file.startsWith('skills/superbee/')));
    semantic = normalizeIntegration(raw, root);
  } else if (name === 'private-state') {
    await init();
    const stateRoot = process.platform === 'win32' ? path.join(env.LOCALAPPDATA,'Superbee') : path.join(env.HOME,'.superbee-state');
    await command('catalog-add', ['catalog','add','parity','--dir',bundle,'--json']);
    assert.equal(await readFile(path.join(stateRoot,'state.json'),'utf8'), '{"product":"superbee","schema_version":1}\n');
    const before = await snapshot(stateRoot);
    const catalog = JSON.parse(await readFile(path.join(stateRoot,'catalog.json'),'utf8'));
    exactKeys(catalog,['schema_version','entries']); assert.equal(catalog.schema_version,1); assert.equal(catalog.entries.length,1);
    const entry = catalog.entries[0]; exactKeys(entry,['id','label','locator']); exactKeys(entry.locator,['kind','path']);
    assert.match(entry.id,/^bnd_[a-f0-9]{32}$/); assert.equal(entry.label,'parity'); assert.deepEqual(entry.locator,{kind:'local-path',path:bundle});
    if (process.platform !== 'win32') for (const record of Object.values(before)) assert.equal(record.mode & 0o077,0, 'private state must remain private');
    await command('catalog-repeat', ['catalog','add','parity','--dir',bundle,'--json']);
    const resolved = await command('catalog-resolve', ['catalog','resolve','parity','--field','path']); assert.equal(resolved.stdout, bundle+'\n');
    raw.files = await snapshot(stateRoot); assert.deepEqual(raw.files,before,'idempotent registration must preserve records and clean locks');
    raw.stateRoot = stateRoot;
    // The catalog ID is fixture-generated, validated above and linked to every occurrence.
    semantic = normalizeIntegration(raw, root, [[entry.id,'<catalog-id>']]);
  } else if (name === 'process') {
    await init();
    const rpc = await command('mcp-roundtrip', ['mcp','--dir',bundle,'--actor','process:parity'], 0, { notifications: { 1: [{jsonrpc:'2.0',method:'notifications/initialized'}] }, dialogue: [
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'parity',version:'1'}}},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_views',arguments:{}}},
    ] });
    const replies = rpc.stdout.trim().split('\n').map((line)=>JSON.parse(line));
    assert.equal(replies.length,2); assert.equal(replies[0].id,1); assert.equal(replies[0].result.serverInfo.version,artifact.manifest.version);
    assert.equal(replies[1].id,2); assert.ok(replies[1].result); assert.notEqual(replies[1].result.isError,true); assert.equal(rpc.stderr,'');
    await command('update-worker-argv-refusal', ['__update-refresh-v1']);
    await command('managed-worker-argv-refusal', ['__managed-ui-v1','unexpected']);
    await command('managed-worker-input-refusal', ['__managed-ui-v1'], 1, { input: '{}\n' });
    const usage = await command('mcp-usage', ['mcp','--nope'], 2); assert.equal(usage.stdout,''); assert.match(usage.stderr,/USAGE/);
    const missing = await command('mcp-missing', ['mcp','--dir',path.join(project,'missing')], 6); assert.equal(missing.stdout,''); assert.match(missing.stderr,/NOT_FOUND/);
    semantic = { commands: raw.commands.map((c)=>canonicalCommand(c,root,versions)) };
  } else throw new Error(`Unknown scenario: ${name}`);
  return semantic;
}
function normalizeIntegration(raw, root, substitutions = []) {
  // This adapter only handles fixture-produced host configuration/catalog files, never documents.
  function text(value) { for (const [from,to] of [[root,'<fixture>'],...substitutions]) value=value.replaceAll(from,to); return value; }
  function walk(value, key) {
    if (typeof value === 'string') return key === 'bytes' ? text(Buffer.from(value,'base64').toString('utf8')) : text(value);
    if (Array.isArray(value)) return value.map((v)=>walk(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v,k)]));
    return value;
  }
  return walk(raw);
}
