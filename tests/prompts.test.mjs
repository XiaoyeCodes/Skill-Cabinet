import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';
import { PromptStore, PromptRepository, emptyCatalog, validateCatalog, mergeCatalog, PROMPTS_KEY } from '../dist/prompts.js';

const record = (id = 'test-one', content = '请解释 {{主题}}', extra = {}) => ({ id, title: '解释概念', content, description: '', category: '学习与研究', tags: ['理解'], source: '', favorite: false, createdAt: '2026-10-26T01:00:00.000Z', updatedAt: '2026-10-26T01:00:00.000Z', ...extra });
const catalog = (...prompts) => validateCatalog({ schemaVersion: 1, categories: [], prompts });
const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };

test('prompts preserve multiline content and reject malformed or executable source links', () => {
  const content = '# 内容\n\n解释 {{主题}}\n输出 "$&" 和 <script>text</script>';
  assert.equal(catalog(record('one', content)).prompts[0].content, content);
  assert.equal(catalog(record('one', '  缩进正文\n\n')).prompts[0].content, '  缩进正文\n\n');
  for (const source of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com']) assert.throws(() => catalog(record('one', content, { source })));
  assert.throws(() => catalog(record('one', '')));
  assert.throws(() => catalog(record('one', 'x'.repeat(100001))));
  assert.throws(() => catalog(record(), record()));
});

test('independent edits and deletions merge; edits to the same item require an explicit version choice', () => {
  const base = catalog(record('one'), record('two')), local = catalog(record('one', '本机修改')), remote = catalog(record('one'), record('two'), record('three', '仓库新增'));
  const result = mergeCatalog(base, local, remote);
  assert.equal(result.conflicts.length, 0); assert.deepEqual(result.catalog.prompts.map(item => item.id), ['one', 'three']);
  const conflictRemote = catalog(record('one', '远端修改'), record('two'));
  assert.equal(mergeCatalog(base, local, conflictRemote).conflicts[0].id, 'one');
  assert.equal(mergeCatalog(base, local, conflictRemote, 'remote').catalog.prompts[0].content, '远端修改');
  assert.equal(mergeCatalog(base, local, conflictRemote, 'local').catalog.prompts[0].content, '本机修改');
  const removedRemote = catalog(record('two'));
  assert.equal(mergeCatalog(base, local, removedRemote).conflicts.length, 1);
});

test('local CRUD checks stale editors, preserves custom empty categories, and supports remove undo and additive restore', () => {
  const storage = memory(), store = new PromptStore(storage), original = record();
  store.save(original); store.addCategory('视频与分镜');
  const changed = store.save({ ...original, title: '新标题' }, original);
  assert.throws(() => store.save({ ...original, content: '过期编辑' }, original), /已在其他页面/);
  const backup = store.exportBackup();
  store.remove(original.id, changed); assert.equal(store.list().length, 0);
  store.undoRemove(); assert.equal(store.list()[0].title, '新标题');
  assert.equal(store.importBackup(backup), 0);
  assert(store.read().catalog.categories.includes('视频与分镜'));
  storage.setItem(PROMPTS_KEY, 'broken-json'); assert.throws(() => store.list(), /原始数据已保留/); assert.equal(storage.getItem(PROMPTS_KEY), 'broken-json');
});

async function serverFixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'cabinet-prompts-'));
  const server = createServer({ repositoryRoot: folder });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { folder, request: (url, options) => fetch(new URL(url.replace(/^\.\//, '/'), base), options) };
}

test('repository API writes real project JSON, rejects stale revisions and cross-origin writes', async t => {
  const { folder, request } = await serverFixture(t);
  const current = await (await request('/api/prompts')).json();
  const put = (body, extra = {}) => request('/api/prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const saved = await put({ catalog: catalog(record()), expectedRevision: current.revision }); assert.equal(saved.status, 200);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'skill-cabinet/prompts.json'), 'utf8')).prompts[0].content, '请解释 {{主题}}');
  assert.equal((await put({ catalog: emptyCatalog(), expectedRevision: current.revision })).status, 409);
  assert.equal((await put({ catalog: emptyCatalog(), expectedRevision: current.revision }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await put({ catalog: catalog(record()), expectedRevision: current.revision }, { 'Content-Type': 'text/plain' })).status, 415);
  const updated = await (await request('/api/prompts')).json();
  const invalid = { ...catalog(record()), prompts: [{ ...record(), source: 'javascript:alert(1)' }] };
  assert.equal((await put({ catalog: invalid, expectedRevision: updated.revision })).status, 400);
  assert.equal((await (await request('/api/prompts')).json()).revision, updated.revision);
});

test('pulling repository data merges with browser edits, detects conflicts, and propagates removal without resurrection', async t => {
  const { folder, request } = await serverFixture(t), store = new PromptStore(memory()), repository = new PromptRepository(store, request);
  store.save(record('one')); assert.equal((await repository.refresh()).saved, true);
  const file = path.join(folder, 'skill-cabinet/prompts.json');
  await writeFile(file, JSON.stringify(catalog(record('one'), record('two', '新收录'))));
  store.save({ ...store.list()[0], description: '本机用途说明' }, store.list()[0]);
  await repository.refresh(); assert.equal(store.list().length, 2); assert.equal(store.list()[0].description, '本机用途说明');
  const current = store.list()[0]; store.save({ ...current, content: '浏览器修改' }, current);
  await writeFile(file, JSON.stringify(catalog(record('one', 'git pull 修改'), record('two', '新收录'))));
  assert.equal((await repository.refresh()).conflicts.length, 1);
  assert.equal(store.list()[0].content, '浏览器修改');
  await repository.refresh('remote'); assert.equal(store.list()[0].content, 'git pull 修改');
  assert.equal(store.read().recovery.prompts[0].content, '浏览器修改');
  store.remove('one', store.list()[0]); await repository.refresh(); await repository.refresh();
  assert.deepEqual(store.list().map(item => item.id), ['two']);
  assert.deepEqual(JSON.parse(await readFile(file)).prompts.map(item => item.id), ['two']);
});

test('editing during an in-flight save keeps the new browser content pending for the next save', async t => {
  const { request } = await serverFixture(t), store = new PromptStore(memory()); store.save(record());
  let editDuringWrite = true;
  const repository = new PromptRepository(store, async (url, options) => {
    const response = await request(url, options);
    if (options.method === 'PUT' && editDuringWrite) { editDuringWrite = false; const current = store.list()[0]; store.save({ ...current, content: '编辑期间的新文字' }, current); }
    return response;
  });
  await repository.refresh(); assert.equal(store.list()[0].content, '编辑期间的新文字');
  await repository.refresh(); const remote = await (await request('/api/prompts')).json(); assert.equal(remote.catalog.prompts[0].content, '编辑期间的新文字');
});

test('a conflict choice cannot overwrite a newer repository version without reconfirmation', async t => {
  const { folder, request } = await serverFixture(t), store = new PromptStore(memory()), repository = new PromptRepository(store, request);
  store.save(record()); await repository.refresh();
  store.save({ ...store.list()[0], content: '本机修改' }, store.list()[0]);
  const file = path.join(folder, 'skill-cabinet/prompts.json');
  await writeFile(file, JSON.stringify(catalog(record('test-one', '远端修改'))));
  assert.equal((await repository.refresh()).conflicts.length, 1);
  await writeFile(file, JSON.stringify(catalog(record('test-one', '更晚的远端修改'))));
  assert.equal((await repository.refresh('local')).stale, true);
  assert.equal(JSON.parse(await readFile(file)).prompts[0].content, '更晚的远端修改');
  await repository.refresh('local'); assert.equal(JSON.parse(await readFile(file)).prompts[0].content, '本机修改');
});

test('an invalid repository file never replaces local data', async t => {
  const { folder, request } = await serverFixture(t), store = new PromptStore(memory()); store.save(record());
  await mkdir(path.join(folder, 'skill-cabinet'), { recursive: true }); await writeFile(path.join(folder, 'skill-cabinet/prompts.json'), '{broken');
  const repository = new PromptRepository(store, request);
  await assert.rejects(repository.refresh()); assert.equal(store.list().length, 1);
});

test('static hosting loads published prompts and merges browser edits without attempting writes', async () => {
  const store = new PromptStore(memory());
  let remote = catalog(record('one', '发布内容')), reads = 0;
  const repository = new PromptRepository(store, async (url, options) => {
    assert.equal(url, './skill-cabinet/prompts.json');
    assert.equal(options.method, undefined);
    reads++;
    return new Response(JSON.stringify(remote));
  }, { readOnly: true });
  assert.equal((await repository.refresh()).readOnly, true);
  const current = store.list()[0];
  store.save({ ...current, description: '浏览器备注' }, current);
  const edited = await repository.refresh();
  assert.equal(edited.saved, false);
  assert.equal(edited.pending, false);
  assert.equal(edited.localChanges, true);
  remote = catalog(record('one', 'GitHub 更新后的正文'), record('two', '新增'));
  assert.equal((await repository.refresh()).conflicts.length, 1);
  await repository.refresh('remote');
  assert.equal(store.list().length, 2);
  assert.equal(store.list().find(item => item.id === 'one').content, 'GitHub 更新后的正文');
  assert.equal(store.read().recovery.prompts[0].description, '浏览器备注');
  assert.equal(reads, 4);
});
