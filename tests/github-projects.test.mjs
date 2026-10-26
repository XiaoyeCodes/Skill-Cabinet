import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepositoryUrl, classifyProject, describeProject, inspectRepository, sanitizeProject, ProjectStore, PROJECTS_KEY } from '../dist/github-projects.js';
const metadata = { name: 'paper-shelf', full_name: 'ink/paper-shelf', description: 'A personal website builder.', topics: ['website', 'frontend'], language: 'JavaScript', stargazers_count: 123, forks_count: 7, license: { spdx_id: 'MIT' }, pushed_at: '2026-10-21T10:00:00Z' };
const project = (extra = {}) => sanitizeProject({ url: 'https://github.com/ink/paper-shelf', name: 'paper-shelf', description: '收藏并制作个人网站', category: '网站与应用', tags: ['website'], createdAt: '2026-10-21T10:00:00Z', ...extra });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('GitHub URLs normalize deep links and clone links to one repository identity', () => {
  for (const input of ['https://github.com/Ink/Paper-Shelf', 'github.com/Ink/Paper-Shelf.git', 'Ink/Paper-Shelf', 'https://www.github.com/Ink/Paper-Shelf/tree/main?tab=readme-ov-file']) {
    assert.equal(parseRepositoryUrl(input).id, 'ink/paper-shelf');
    assert.equal(parseRepositoryUrl(input).url, 'https://github.com/Ink/Paper-Shelf');
  }
  for (const input of ['https://github.com/ink', 'https://evil.example/ink/repo', 'https://github.com.evil.example/ink/repo', 'https://token@github.com/ink/repo', 'https://github.com:8080/ink/repo', 'javascript:alert(1)', 'https://github.com/ink/repo%2fsecret']) assert.throws(() => parseRepositoryUrl(input));
});

test('automatic categories use project purpose and topics with a conservative fallback', () => {
  assert.equal(classifyProject({ name: 'Skill-Cabinet', description: 'AI 技能管理工具', topics: ['skills', 'agent'] }), 'AI 与智能体');
  assert.equal(classifyProject({ name: 'jin10-breakfast', description: '金十财经早餐，整理金融市场日报' }), '金融与投资');
  assert.equal(classifyProject(metadata), '网站与应用');
  assert.equal(classifyProject({ name: 'lumen', topics: ['animation', 'motion', 'design'] }), '设计与创作');
  assert.equal(classifyProject({ name: 'my-project', description: '' }), '其他项目');
});

test('README descriptions prefer meaningful Chinese prose and ignore code and badges', () => {
  const result = describeProject(metadata, '# Paper Shelf\n\n![build](https://example.com/status.svg)\n\n```js\nthrow new Error("not prose");\n```\n\n这是一个用于搭建个人网站的轻量工具，支持整理作品和分享自己的创作。\n\n## Installation');
  assert.match(result.description, /^这是一个用于搭建个人网站/);
  assert.doesNotMatch(result.readmeExcerpt, /throw new Error|status.svg/);
});

test('repository inspection reads real metadata and UTF-8 README using fixed GitHub API URLs', async () => {
  const calls = [];
  const markdown = '# Paper Shelf\n\n这是一个用于搭建个人网站的轻量工具，帮助用户整理作品并公开分享。';
  const record = await inspectRepository('https://github.com/ink/paper-shelf/tree/main', { token: 'never-export-this', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/readme') ? { encoding: 'base64', size: Buffer.byteLength(markdown), content: Buffer.from(markdown).toString('base64') } : metadata);
  } });
  assert.equal(record.name, 'paper-shelf');
  assert.match(record.description, /^这是一个用于搭建/);
  assert.equal(record.category, '网站与应用');
  assert.equal(record.readmeStatus, 'read');
  assert.equal(record.stars, 123);
  assert.equal(record.license, 'MIT');
  assert.deepEqual(record.tags, ['website', 'frontend', 'JavaScript']);
  assert.deepEqual(calls.map(call => call.url), ['https://api.github.com/repos/ink/paper-shelf', 'https://api.github.com/repos/ink/paper-shelf/readme']);
  assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer never-export-this' && call.options.redirect === 'error' && !call.options.body));
  assert.doesNotMatch(JSON.stringify(record), /never-export-this/);
});

test('missing or unavailable READMEs preserve usable repository metadata', async () => {
  for (const status of [404, 403, 503]) {
    const record = await inspectRepository('ink/paper-shelf', { fetchImpl: async url => url.endsWith('/readme') ? new Response('', { status }) : Response.json(metadata) });
    assert.equal(record.description, metadata.description);
    assert.equal(record.readmeStatus, status === 404 ? 'missing' : 'unavailable');
  }
  await assert.rejects(inspectRepository('ink/private', { fetchImpl: async () => new Response('', { status: 404 }) }), /私有仓库/);
  await assert.rejects(inspectRepository('ink/paper-shelf', { fetchImpl: async () => new Response('', { status: 403 }) }), /限制了访问/);
});

test('invalid hosts never receive a request or credential and cancellations do not produce a saved project', async () => {
  let called = false;
  await assert.rejects(inspectRepository('https://evil.example/repo', { token: 'secret', fetchImpl: async () => { called = true; } }));
  assert.equal(called, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectRepository('ink/paper-shelf', { signal: controller.signal, fetchImpl: async (url, options) => { options.signal.throwIfAborted(); } }), /取消/);
});

test('project storage prevents duplicate overwrite and persists manual edits and favorites', () => {
  const storage = memoryStorage(), first = new ProjectStore(storage);
  first.add(project());
  assert.throws(() => first.add(project({ url: 'https://github.com/Ink/Paper-Shelf.git' })), /已经/);
  first.update('ink/paper-shelf', { name: '我的作品集工具', favorite: true, category: '我的创作', tags: ['作品集'], description: '按自己的用途整理' });
  const restored = new ProjectStore(storage).list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].name, '我的作品集工具');
  assert.equal(restored[0].category, '我的创作');
  assert.equal(restored[0].favorite, true);
  assert.equal(restored[0].url, 'https://github.com/ink/paper-shelf');
});

test('backups roundtrip projects, exclude credentials and reject invalid batches before writing', () => {
  const storage = memoryStorage(), store = new ProjectStore(storage);
  store.add(project({ token: 'never-export-this', homepage: 'javascript:alert(1)' }));
  const backup = store.exportBackup();
  assert.doesNotMatch(JSON.stringify(backup), /never-export-this|javascript:/);
  const second = new ProjectStore(memoryStorage());
  assert.equal(second.importBackup(backup), 1);
  second.update('ink/paper-shelf', { name: '手动改过的名称' });
  assert.equal(second.importBackup(backup), 0);
  assert.equal(second.list()[0].name, '手动改过的名称');
  const before = storage.getItem(PROJECTS_KEY);
  assert.throws(() => store.importBackup({ ...backup, projects: [project({ url: 'https://github.com/ink/another' }), { url: 'https://evil.example/not-a-repository' }] }));
  assert.equal(storage.getItem(PROJECTS_KEY), before);
});

test('storage failures preserve existing projects instead of reporting a successful addition', () => {
  const storage = memoryStorage(), store = new ProjectStore(storage); store.add(project());
  const before = storage.getItem(PROJECTS_KEY);
  storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => store.add(project({ url: 'https://github.com/ink/another' })), /尚未保存/);
  assert.equal(storage.getItem(PROJECTS_KEY), before);
  assert.equal(store.list().length, 1);
});

test('corrupt saved data is never silently replaced', () => {
  const storage = memoryStorage(); storage.setItem(PROJECTS_KEY, '{broken');
  const store = new ProjectStore(storage);
  assert.throws(() => store.add(project()), /读取失败/);
  assert.equal(storage.getItem(PROJECTS_KEY), '{broken');
});

// Starter projects are explicit user additions; removing one must survive reloads.
test('the requested GitHub projects load once with complete names, purposes and categories', async () => {
  const { readFile } = await import('node:fs/promises');
  const catalog = JSON.parse(await readFile(new URL('../dist/assets/github-projects.json', import.meta.url), 'utf8'));
  const storage = memoryStorage(), store = new ProjectStore(storage);
  assert.equal(store.seedCatalog(catalog), 6);
  assert.deepEqual(new Set(store.list().map(item => item.id)), new Set(['mexicat/pdoom-video', 'tunai-0511/meme67-art-history', 'vincentwei1021/mg-styles-15', 'lemomo-ai/lemo-opuscar', 'heygen-com/hyperframes', 'remotion-dev/remotion']));
  assert.ok(store.list().every(item => item.category === '设计与创作' && item.description.length > 0 && item.readmeStatus === 'read'));
  const hyperframes = store.list().find(item => item.id === 'heygen-com/hyperframes');
  assert.equal(hyperframes.name, '面向 AI 编程助手的视频制作框架');
  assert.equal(hyperframes.description, '利用 Claude、Codex 等 AI 编程助手生成视频。');
  const manifest = JSON.parse(await readFile(new URL('../skill-cabinet/manifest.json', import.meta.url), 'utf8'));
  const { fingerprintProject } = await import('../dist/project-sync.js');
  assert.deepEqual(manifest.projects[hyperframes.id].record, hyperframes);
  assert.equal(manifest.projects[hyperframes.id].fingerprint, await fingerprintProject(hyperframes));
  const remotion = store.list().find(item => item.id === 'remotion-dev/remotion');
  assert.deepEqual(manifest.projects[remotion.id].record, remotion);
  assert.equal(manifest.projects[remotion.id].fingerprint, await fingerprintProject(remotion));
  const before = storage.getItem(PROJECTS_KEY);
  assert.equal(store.seedCatalog(catalog), 0);
  assert.equal(storage.getItem(PROJECTS_KEY), before);
});

test('starter projects preserve existing edits and never resurrect a deliberately removed project', () => {
  const storage = memoryStorage(), store = new ProjectStore(storage);
  store.add(project({ name: '自己的名称', category: '自己的分类' }));
  const catalog = { schemaVersion: 1, projects: [project(), project({ url: 'https://github.com/ink/second' })] };
  assert.equal(store.seedCatalog(catalog), 1);
  assert.equal(store.list().find(item => item.id === 'ink/paper-shelf').name, '自己的名称');
  store.remove('ink/second');
  const reopened = new ProjectStore(storage);
  assert.equal(reopened.seedCatalog(catalog), 0);
  assert.deepEqual(reopened.list().map(item => item.id), ['ink/paper-shelf']);
  const expanded = { ...catalog, projects: [...catalog.projects, project({ url: 'https://github.com/ink/third' })] };
  assert.equal(reopened.seedCatalog(expanded), 1);
  assert.deepEqual(reopened.list().map(item => item.id), ['ink/paper-shelf', 'ink/third']);
});

test('starter project records and initialization markers commit together or preserve existing data', () => {
  const storage = memoryStorage(), store = new ProjectStore(storage);
  storage.setItem = () => { throw Error('quota'); };
  assert.throws(() => store.seedCatalog({ schemaVersion: 1, projects: [project()] }), /尚未保存/);
  assert.deepEqual(store.readState(), { projects: [], seededIds: [], sync: {} });
  assert.throws(() => store.seedCatalog({ schemaVersion: 1, projects: [project(), { url: 'https://evil.example/project' }] }));
  assert.deepEqual(store.readState(), { projects: [], seededIds: [], sync: {} });
});
