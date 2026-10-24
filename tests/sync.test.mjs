import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { GitHubClient, validateManifest, sha256, MAX_ARCHIVE_BYTES } from '../dist/github-client.js';
import { SyncEngine, fingerprintSkill } from '../dist/sync-engine.js';
import { exportSkill, exportLibrary, decodeSkillArchive } from '../dist/storage.js';
import { mergeCategories } from '../dist/categories.js';
import { ProjectStore, sanitizeProject } from '../dist/github-projects.js';
import { fingerprintProject } from '../dist/project-sync.js';
import { compareSyncItems, inspectLocalSync } from '../dist/sync-status.js';

globalThis.crypto ||= webcrypto;
const module = { exports: {} };
vm.runInNewContext(await readFile(new URL('../dist/vendor/jszip.min.js', import.meta.url), 'utf8'), { module, exports: module.exports, Buffer, setTimeout, clearTimeout, setImmediate, Uint8Array, ArrayBuffer });
globalThis.JSZip = module.exports;
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const skill = (body = 'First', extra = {}) => ({ id: 'local-id', name: 'Test', slug: 'test', content: `# Test\n\n${body}`, description: 'Description', category: 'Tools', tags: ['tag'], version: '1.0', author: '', favorite: false, instructions: 'Read first', createdAt: '2026-10-20', updatedAt: '2026-10-20', files: [{ path: 'assets/picture.bin', data: new Blob([new Uint8Array([0, 128, 255])]) }], localRevision: 'initial', ...extra });
function memoryStorage(initial = [], initialCategories = []) {
  let records = [...initial];
  let categories = mergeCategories(initialCategories);
  const meta = new Map();
  let serial = 0;
  return {
    listSkills: async () => [...records], exportSkill, exportLibrary, decodeSkillArchive,
    listCategories: async () => [...categories],
    saveCategories: async names => { categories = mergeCategories(categories, names); return [...categories]; },
    getSyncMeta: async key => meta.get(key), setSyncMeta: async (key, value) => meta.set(key, value),
    async applySyncChanges(upserts, deletions, options) {
      if (options.expectedCategories && JSON.stringify(categories) !== JSON.stringify(options.expectedCategories)) { const error = new Error('本地分类已变化'); error.code = 'LOCAL_CHANGED'; throw error; }
      if (JSON.stringify(records.map(r => [r.id, r.localRevision])) !== JSON.stringify(options.expectedRecords.map(r => [r.id, r.localRevision]))) { const error = new Error('本机数据已变化'); error.code = 'LOCAL_CHANGED'; throw error; }
      records = records.filter(record => !deletions.includes(record.slug));
      for (const record of upserts) { const previous = records.find(r => r.slug === record.slug); records = records.filter(r => r.slug !== record.slug); records.push({ ...record, id: previous?.id || record.id, localRevision: String(++serial) }); }
      categories = mergeCategories(categories, options.categories || []);
      meta.set(options.metaKey, options.metaValue);
    },
    edit(record) { const previous = records.find(r => r.slug === record.slug); records = records.filter(r => r.slug !== record.slug); records.push({ ...record, id: previous?.id || record.id, localRevision: String(++serial) }); },
    remove(slug) { records = records.filter(record => record.slug !== slug); },
  };
}
function remote(initialManifest = null) {
  let manifest = initialManifest;
  let head = A;
  const archives = new Map();
  return {
    repoKey: 'owner/repo@main', writes: 0, reads: 0, archives,
    async getSnapshot() { if (this.offline) throw new Error('offline'); return { head, treeSha: B, manifest: manifest && structuredClone(manifest) }; },
    async readArchive(path) { this.reads++; return new Uint8Array(await archives.get(path).arrayBuffer()); },
    async writeSnapshot(snapshot, next, files) { if (this.beforeWrite) await this.beforeWrite(); if (snapshot.head !== head) throw new Error('REMOTE_CHANGED'); this.writes++; for (const [path, bytes] of files) archives.set(path, bytes); manifest = structuredClone(next); head = this.writes % 2 ? C : D; return { head, treeSha: B, manifest }; },
    async inject(record) { const zip = await exportSkill(record), hash = await sha256(zip), path = `skill-cabinet/archives/${record.slug}-${hash}.zip`; archives.set(path, zip); manifest ||= { schemaVersion: 1, entries: {} }; const { files, content, instructions, localRevision, ...metadata } = record; manifest.entries[record.slug] = { fingerprint: await fingerprintSkill(record), archiveSha256: hash, archivePath: path, metadata }; head = head === C ? D : C; },
    eraseManifest() { manifest = null; head = D; },
  };
}
const engine = (client, storage) => new SyncEngine({ client, storage });
const project = (extra = {}) => sanitizeProject({ url: 'https://github.com/ink/paper', name: '项目原名', description: '我的项目收藏', category: '开发工具', createdAt: '2026-10-24', updatedAt: '2026-10-24', repositoryUpdatedAt: '2026-10-24', ...extra });
function projectStorage(initial = []) {
  const values = new Map();
  const local = { fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw Error('disk full'); values.set(key, value); } };
  const store = new ProjectStore(local);
  for (const record of initial) store.add(record);
  return { store, local };
}
const combinedEngine = (client, storage, projectStore) => new SyncEngine({ client, storage, projectStore });

test('renaming a skill changes its cloud metadata and complete ZIP, then restores on another device', async () => {
  const cloud = remote(), local = memoryStorage([skill()]), sync = engine(cloud, local);
  await sync.sync();
  local.edit({ ...(await local.listSkills())[0], name: '每日财经日报PDF报纸版' });
  const before = await inspectLocalSync({ records: await local.listSkills(), baseline: await local.getSyncMeta(sync.baseKey) });
  assert.equal(before.skills.items.get('test'), 'pending');
  await sync.sync();
  const entry = (await cloud.getSnapshot()).manifest.entries.test;
  assert.equal(entry.metadata.name, '每日财经日报PDF报纸版');
  const [decoded] = await decodeSkillArchive(await cloud.archives.get(entry.archivePath));
  assert.equal(decoded.name, entry.metadata.name);
  const second = memoryStorage(); await engine(cloud, second).sync();
  assert.equal((await second.listSkills())[0].name, entry.metadata.name);
});

test('both spaces sync in one commit, project rename and favorite restore on another device without credentials', async () => {
  const cloud = remote(), first = projectStorage([project()]), second = projectStorage();
  const skillsA = memoryStorage([skill()]), skillsB = memoryStorage();
  const a = combinedEngine(cloud, skillsA, first.store), b = combinedEngine(cloud, skillsB, second.store);
  await a.sync(); assert.equal(cloud.writes, 1);
  first.store.update('ink/paper', { name: '新的中文名', favorite: true }); await a.sync();
  await b.sync();
  assert.equal((await skillsB.listSkills()).length, 1);
  assert.equal(second.store.list()[0].name, '新的中文名'); assert.equal(second.store.list()[0].favorite, true);
  const manifest = validateManifest((await cloud.getSnapshot()).manifest);
  assert.equal(manifest.projects['ink/paper'].record.name, '新的中文名');
  assert.equal(JSON.stringify(manifest).includes('token'), false);
  const writes = cloud.writes; await a.sync(); await b.sync(); assert.equal(cloud.writes, writes);
});

test('project deletions sync as tombstones and catalog initialization cannot resurrect them', async () => {
  const cloud = remote(), first = projectStorage([project()]), second = projectStorage();
  const a = combinedEngine(cloud, memoryStorage(), first.store), b = combinedEngine(cloud, memoryStorage(), second.store);
  await a.sync(); await b.sync(); first.store.remove('ink/paper');
  const dirty = compareSyncItems([], first.store.getSyncBaseline(cloud.repoKey)); assert.equal(dirty.deleted, 1);
  await a.sync(); await b.sync();
  assert.equal((await cloud.getSnapshot()).manifest.projects['ink/paper'].deleted, true);
  assert.deepEqual(second.store.list(), []);
  assert.equal(second.store.seedCatalog({ schemaVersion: 1, projects: [project()] }), 0);
  assert.deepEqual(second.store.list(), []);
  assert.equal(second.store.getSyncBaseline(cloud.repoKey).recovery.length, 1);
});

test('project edit conflicts require explicit choices and stale choices cannot overwrite newer edits', async () => {
  const cloud = remote(), first = projectStorage([project()]), second = projectStorage();
  const a = combinedEngine(cloud, memoryStorage(), first.store), b = combinedEngine(cloud, memoryStorage(), second.store);
  await a.sync(); await b.sync();
  first.store.update('ink/paper', { name: '甲的改名' }); second.store.update('ink/paper', { name: '乙的改名' }); await a.sync();
  const conflict = await b.sync(); assert.equal(conflict.status, 'conflict'); assert.equal(conflict.conflicts[0].slug, 'project:ink/paper');
  second.store.update('ink/paper', { description: '冲突后继续修改' });
  const resolution = { token: conflict.conflictToken, projectToken: conflict.projectToken, choices: { 'project:ink/paper': 'remote' } };
  await assert.rejects(b.sync({ resolutions: resolution }), /项目已变化/);
  const current = await b.sync();
  await b.sync({ resolutions: { token: current.conflictToken, projectToken: current.projectToken, choices: resolution.choices } });
  assert.equal(second.store.list()[0].name, '甲的改名');
});

test('project edits during upload and storage failures preserve data and do not advance the project baseline', async () => {
  const cloud = remote(), initial = projectStorage([project()]), sync = combinedEngine(cloud, memoryStorage(), initial.store);
  cloud.beforeWrite = () => { cloud.beforeWrite = null; initial.store.update('ink/paper', { name: '上传期间的修改' }); };
  await assert.rejects(sync.sync(), error => error.code === 'LOCAL_CHANGED');
  assert.equal(initial.store.list()[0].name, '上传期间的修改'); assert.equal(initial.store.getSyncBaseline(cloud.repoKey), undefined);
  const conflict = await sync.sync();
  await sync.sync({ resolutions: { token: conflict.conflictToken, projectToken: conflict.projectToken, choices: { 'project:ink/paper': 'local' } } });
  const second = projectStorage(), restored = combinedEngine(cloud, memoryStorage(), second.store);
  second.local.fail = true; await assert.rejects(restored.sync(), /浏览器空间不足/);
  assert.deepEqual(second.store.list(), []); assert.equal(second.store.getSyncBaseline(cloud.repoKey), undefined);
  second.local.fail = false; await restored.sync(); assert.equal(second.store.list()[0].name, '上传期间的修改');
});

test('offline project changes remain pending after reopening and sync later; skill-only clients preserve projects', async () => {
  const cloud = remote(), first = projectStorage([project()]), sync = combinedEngine(cloud, memoryStorage(), first.store);
  await sync.sync(); first.store.update('ink/paper', { name: '离线修改' }); cloud.offline = true;
  await assert.rejects(sync.sync(), /offline/);
  const reopened = new ProjectStore(first.local), baseline = reopened.getSyncBaseline(cloud.repoKey);
  assert.equal(compareSyncItems([{ id: 'ink/paper', fingerprint: await fingerprintProject(reopened.list()[0]) }], baseline).items.get('ink/paper'), 'pending');
  cloud.offline = false; await sync.sync();
  const before = structuredClone((await cloud.getSnapshot()).manifest.projects);
  await engine(cloud, memoryStorage([skill()])).sync();
  assert.deepEqual((await cloud.getSnapshot()).manifest.projects, before);
});

test('project content validation rejects tampering and missing cloud collections before changing local data', async () => {
  const cloud = remote(), first = projectStorage([project()]), sync = combinedEngine(cloud, memoryStorage(), first.store);
  await sync.sync();
  const saved = (await cloud.getSnapshot()).manifest;
  saved.projects['ink/paper'].record.name = '篡改内容';
  const tampered = remote(saved), empty = projectStorage();
  await assert.rejects(combinedEngine(tampered, memoryStorage(), empty.store).sync(), /校验值不一致/);
  assert.deepEqual(empty.store.list(), []);
  cloud.eraseManifest(); await assert.rejects(sync.sync(), /项目同步清单已被移除/);
});

test('status comparisons distinguish unconfirmed local data, pending edits and invisible pending deletions', () => {
  assert.equal(compareSyncItems([]).confirmed, false);
  assert.equal(compareSyncItems([{ id: 'new', fingerprint: 'a' }]).items.get('new'), 'local');
  const result = compareSyncItems([{ id: 'same', fingerprint: 'a' }, { id: 'edit', fingerprint: 'new' }, { id: 'add', fingerprint: 'c' }], { entries: { same: 'a', edit: 'old', removed: 'b', alreadyDeleted: null } });
  assert.equal(result.items.get('same'), 'synced'); assert.equal(result.items.get('edit'), 'pending'); assert.equal(result.items.get('add'), 'pending');
  assert.equal(result.pending, 3); assert.equal(result.deleted, 1);
});

test('a failed skill apply does not roll back confirmed project changes or advance the skill baseline', async () => {
  const cloud = remote(), first = projectStorage([project()]), source = combinedEngine(cloud, memoryStorage([skill()]), first.store);
  await source.sync();
  const target = memoryStorage(), projects = projectStorage(), sync = combinedEngine(cloud, target, projects.store);
  const apply = target.applySyncChanges;
  target.applySyncChanges = async () => { const error = Error('保存期间技能已修改'); error.code = 'LOCAL_CHANGED'; throw error; };
  await assert.rejects(sync.sync(), error => error.code === 'LOCAL_CHANGED');
  assert.equal(projects.store.list()[0].name, project().name);
  assert.ok(projects.store.getSyncBaseline(cloud.repoKey));
  assert.equal(await target.getSyncMeta(sync.baseKey), undefined);
  target.applySyncChanges = apply; await sync.sync();
  assert.equal((await target.listSkills()).length, 1);
  assert.equal(projects.store.list()[0].name, project().name);
});

test('a fresh device with a deleted seed project must resolve it rather than silently restoring it', async () => {
  const cloud = remote(), first = projectStorage([project()]), source = combinedEngine(cloud, memoryStorage(), first.store);
  await source.sync(); first.store.remove('ink/paper'); await source.sync();
  const second = projectStorage([project()]), target = combinedEngine(cloud, memoryStorage(), second.store);
  const before = cloud.writes, conflict = await target.sync();
  assert.equal(conflict.status, 'conflict'); assert.equal(cloud.writes, before);
  await target.sync({ resolutions: { token: conflict.conflictToken, projectToken: conflict.projectToken, choices: { 'project:ink/paper': 'remote' } } });
  assert.deepEqual(second.store.list(), []);
});

test('empty categories sync across devices, merge additions and do not create repeated commits', async () => {
  const client = remote(), first = memoryStorage([], ['设备甲空分类']), second = memoryStorage([], ['设备乙空分类']);
  await engine(client, first).sync();
  assert.deepEqual((await client.getSnapshot()).manifest.categories, ['设备甲空分类']);
  assert.equal(client.archives.size, 0);
  await engine(client, second).sync();
  await engine(client, first).sync();
  assert.deepEqual(await first.listCategories(), mergeCategories(['设备甲空分类', '设备乙空分类']));
  assert.deepEqual(await second.listCategories(), await first.listCategories());
  const writes = client.writes;
  await engine(client, second).sync();
  await engine(client, first).sync();
  assert.equal(client.writes, writes);
});

test('adding a category during GitHub upload preserves it and retries without advancing the baseline', async () => {
  const client = remote(), storage = memoryStorage([], ['先添加的分类']);
  client.beforeWrite = async () => { client.beforeWrite = null; await storage.saveCategories(['上传期间新增']); };
  const sync = engine(client, storage);
  await assert.rejects(sync.sync(), error => error.code === 'LOCAL_CHANGED');
  assert.equal(await storage.getSyncMeta(sync.baseKey), undefined);
  assert.ok((await storage.listCategories()).includes('上传期间新增'));
  await sync.sync();
  assert.deepEqual((await client.getSnapshot()).manifest.categories, await storage.listCategories());
});

test('manifest validates optional categories and remains compatible with older manifests', () => {
  assert.deepEqual(validateManifest({ schemaVersion: 1, entries: {} }), { schemaVersion: 1, entries: Object.create(null) });
  assert.deepEqual(validateManifest({ schemaVersion: 1, entries: {}, categories: [' 分类 ', '分类'] }).categories, ['分类']);
  for (const categories of ['invalid', [null], [''], ['x'.repeat(31)]]) {
    assert.throws(() => validateManifest({ schemaVersion: 1, entries: {}, categories }), /分类/);
  }
});

test('canonical fingerprint survives export/import, dates and ids; binary or instructions edits differ', async () => {
  const record = skill();
  const [parsed] = await decodeSkillArchive(await exportSkill(record));
  assert.equal(await fingerprintSkill(record), await fingerprintSkill({ ...parsed, favorite: record.favorite }));
  assert.equal(await fingerprintSkill(record), await fingerprintSkill({ ...record, id: 'new-device', updatedAt: 'tomorrow', localRevision: 'new' }));
  assert.notEqual(await fingerprintSkill(record), await fingerprintSkill({ ...record, instructions: 'Changed' }));
  assert.notEqual(await fingerprintSkill(record), await fingerprintSkill({ ...record, files: [{ path: 'assets/picture.bin', data: new Blob(['changed']) }] }));
});
test('two devices push, restore full files, and sync editing without replacing local id', async () => {
  const cloud = remote(), deviceA = memoryStorage([skill()]), deviceB = memoryStorage();
  assert.equal((await engine(cloud, deviceA).sync()).uploaded, 1);
  const b = engine(cloud, deviceB);
  assert.equal((await b.sync()).restored, 1);
  assert.deepEqual(new Uint8Array(await (await deviceB.listSkills())[0].files.find(file => file.path === 'assets/picture.bin').data.arrayBuffer()), new Uint8Array([0, 128, 255]));
  deviceB.edit(skill('Edited on device B', { id: 'different-id' }));
  await b.sync();
  const result = await engine(cloud, deviceA).sync();
  assert.equal(result.restored, 1);
  assert.equal((await deviceA.listSkills())[0].id, 'local-id');
  assert.match((await deviceA.listSkills())[0].content, /Edited on device B/);
  assert.ok((await deviceA.getSyncMeta('recovery:owner/repo@main')).blob instanceof Blob);
});
test('initial same slug collision never writes or applies until explicit resolution', async () => {
  const cloud = remote(); await cloud.inject(skill('Remote'));
  const local = memoryStorage([skill('Local')]), sync = engine(cloud, local);
  const conflict = await sync.sync();
  assert.equal(conflict.status, 'conflict'); assert.equal(cloud.writes, 0);
  assert.match((await local.listSkills())[0].content, /Local/);
  await sync.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'remote' } } });
  assert.match((await local.listSkills())[0].content, /Remote/);
});
test('stale conflict choices are invalid after another device changes remote', async () => {
  const cloud = remote(); await cloud.inject(skill('Remote'));
  const local = memoryStorage([skill('Local')]), sync = engine(cloud, local), conflict = await sync.sync();
  await cloud.inject(skill('New remote'));
  await assert.rejects(sync.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'local' } } }), /重新比较冲突/);
  assert.equal(cloud.writes, 0);
});
test('two-sided edits conflict; one-sided deletions propagate as tombstones', async () => {
  const cloud = remote(), a = memoryStorage([skill()]), b = memoryStorage();
  const sa = engine(cloud, a), sb = engine(cloud, b);
  await sa.sync(); await sb.sync();
  a.edit(skill('A edit')); b.edit(skill('B edit')); await sa.sync();
  const conflict = await sb.sync(); assert.equal(conflict.status, 'conflict');
  await sb.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'remote' } } });
  a.remove('test'); await sa.sync();
  assert.equal((await cloud.getSnapshot()).manifest.entries.test.deleted, true);
  await sb.sync(); assert.equal((await b.listSkills()).length, 0);
});
test('delete/edit collision is protected and choosing local restores edited skill', async () => {
  const cloud = remote(), a = memoryStorage([skill()]), b = memoryStorage(); const sa = engine(cloud, a), sb = engine(cloud, b);
  await sa.sync(); await sb.sync(); a.remove('test'); await sa.sync(); b.edit(skill('Keep edit'));
  const conflict = await sb.sync(); assert.equal(conflict.status, 'conflict');
  await sb.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'local' } } });
  assert.ok((await cloud.getSnapshot()).manifest.entries.test.fingerprint);
});
test('a fresh device cannot silently resurrect a previously deleted bundled seed', async () => {
  const cloud = remote({ schemaVersion: 1, entries: { test: { deleted: true, updatedAt: '2026-10-20' } } });
  const local = memoryStorage([skill()]); const sync = engine(cloud, local);
  const conflict = await sync.sync(); assert.equal(conflict.status, 'conflict'); assert.equal(cloud.writes, 0);
  await sync.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'remote' } } });
  assert.equal((await local.listSkills()).length, 0);
});
test('offline errors preserve pending data and can later retry', async () => {
  const cloud = remote(), local = memoryStorage([skill()]), sync = engine(cloud, local); cloud.offline = true;
  await assert.rejects(sync.sync(), /offline/); assert.equal((await local.listSkills()).length, 1);
  cloud.offline = false; assert.equal((await sync.sync()).status, 'synced');
});
test('missing formerly-seen manifest and tampered archive fail before local apply', async () => {
  const cloud = remote(), local = memoryStorage([skill()]), sync = engine(cloud, local); await sync.sync();
  cloud.eraseManifest(); await assert.rejects(sync.sync(), /清单已被删除/);
  const corrupt = remote(); await corrupt.inject(skill()); const path = (await corrupt.getSnapshot()).manifest.entries.test.archivePath;
  corrupt.archives.set(path, new Blob(['bad'])); const empty = memoryStorage();
  await assert.rejects(engine(corrupt, empty).sync(), /校验失败/); assert.equal((await empty.listSkills()).length, 0);
});
test('local edits while cloud upload runs are preserved and sync next time', async () => {
  const cloud = remote(), local = memoryStorage([skill()]), sync = engine(cloud, local);
  cloud.beforeWrite = () => { local.edit(skill('Edited mid-upload')); cloud.beforeWrite = null; };
  await assert.rejects(sync.sync(), error => error.code === 'LOCAL_CHANGED');
  assert.match((await local.listSkills())[0].content, /Edited mid-upload/);
  const conflict = await sync.sync();
  assert.equal(conflict.status, 'conflict');
  assert.equal((await sync.sync({ resolutions: { token: conflict.conflictToken, choices: { test: 'local' } } })).status, 'synced');
});
test('failed atomic apply keeps old baseline so an unapplied remote update cannot be overwritten', async () => {
  const a = skill('A original', { id: 'a', slug: 'a', name: 'A' });
  const b = skill('B original', { id: 'b', slug: 'b', name: 'B' });
  const c = skill('C original', { id: 'c', slug: 'c', name: 'C' });
  const cloud = remote(), local = memoryStorage([a, b, c]), sync = engine(cloud, local);
  await sync.sync();
  const before = await local.getSyncMeta(sync.baseKey);
  await cloud.inject({ ...a, content: '# A\nRemote A updated' });
  local.edit({ ...b, content: '# B\nLocal B updated' });
  cloud.beforeWrite = () => { local.edit({ ...c, content: '# C\nC edited during upload' }); cloud.beforeWrite = null; };
  await assert.rejects(sync.sync(), error => error.code === 'LOCAL_CHANGED');
  assert.deepEqual(await local.getSyncMeta(sync.baseKey), before);
  assert.match((await local.listSkills()).find(record => record.slug === 'a').content, /A original/);
  await sync.sync();
  const records = await local.listSkills();
  assert.match(records.find(record => record.slug === 'a').content, /Remote A updated/);
  assert.match(records.find(record => record.slug === 'b').content, /Local B updated/);
  assert.match(records.find(record => record.slug === 'c').content, /C edited during upload/);
  assert.equal((await cloud.getSnapshot()).manifest.entries.a.fingerprint, await fingerprintSkill({ ...a, content: '# A\nRemote A updated' }));
});
test('bootstrap pulls existing repository seed files and writes dedicated manifest only', async () => {
  const cloud = remote(); cloud.getBootstrap = async () => { const record = skill('Seed'); const { files, content, instructions, localRevision, ...metadata } = record; return [{ metadata, bytes: await (await exportSkill(record)).arrayBuffer() }]; };
  const local = memoryStorage(); const result = await engine(cloud, local).sync();
  assert.equal(result.restored, 1); assert.equal(result.uploaded, 1);
  assert.match((await local.listSkills())[0].content, /Seed/);
  assert.equal((await cloud.getSnapshot()).manifest.entries.test.bootstrap, undefined);
});
test('manifest rejects unsafe paths, unsupported schema and strips executable metadata fields', async () => {
  const cloud = remote(); await cloud.inject(skill()); const m = (await cloud.getSnapshot()).manifest;
  const sanitized = validateManifest({ ...m, entries: { test: { ...m.entries.test, metadata: { ...m.entries.test.metadata, token: 'NEVER', archiveUrl: 'https://evil.example' } } } });
  assert.equal(sanitized.entries.test.metadata.token, undefined);
  assert.throws(() => validateManifest({ ...m, schemaVersion: 2 }), /版本/);
  assert.throws(() => validateManifest({ ...m, entries: { test: { ...m.entries.test, archivePath: '../secret' } } }), /路径/);
});
test('default GitHub fetch preserves the browser global receiver', async t => {
  t.mock.method(globalThis, 'fetch', async function (url) {
    // Browser fetch rejects a GitHubClient instance as its receiver.
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(url, 'https://api.github.com/repos/owner/repo');
    return Response.json({ full_name: 'owner/repo', default_branch: 'main' });
  });
  const client = new GitHubClient({ owner: 'owner', repo: 'repo', token: 'test-token' });
  assert.equal((await client.getRepository()).full_name, 'owner/repo');
});
test('GitHub API pins reads to fixed host and commit, falls back to blobs and limits files', async () => {
  const seen = [];
  const client = new GitHubClient({ owner: 'owner', repo: 'repo', token: 'private-token', fetchImpl: async (url, options) => {
    seen.push([url, options]);
    if (url.includes('/contents/')) return { ok: true, status: 200, json: async () => ({ type: 'file', size: 5, encoding: 'none', sha: B }) };
    return { ok: true, status: 200, json: async () => ({ encoding: 'base64', size: 5, content: btoa('bytes') }) };
  } });
  assert.equal(new TextDecoder().decode(await client.readArchive(`skill-cabinet/archives/test-${'f'.repeat(64)}.zip`, A)), 'bytes');
  assert.ok(seen[0][0].endsWith(`?ref=${A}`)); assert.ok(seen.every(([url, options]) => url.startsWith('https://api.github.com/repos/owner/repo/') && options.redirect === 'error'));
  await assert.rejects(client.readArchive('https://evil.example/file.zip', A), /路径/);
  client.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ type: 'file', size: MAX_ARCHIVE_BYTES + 1 }) });
  await assert.rejects(client.readArchive(`skill-cabinet/archives/test-${'f'.repeat(64)}.zip`, A), /大小/);
});
test('GitHub commits use non-forced ref updates, reject stale refs, reconcile lost success response', async () => {
  for (const reconcile of [false, true]) {
    const calls = [];
    const client = new GitHubClient({ owner: 'owner', repo: 'repo', token: 'never-log-token', fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (options.method === 'PATCH') return { ok: false, status: 422 };
      const json = url.includes('/git/trees') ? { sha: B } : url.includes('/git/commits') ? { sha: C } : { object: { sha: reconcile ? C : D } };
      return { ok: true, status: 200, json: async () => json };
    } });
    const operation = client.writeSnapshot({ head: A, treeSha: B }, { schemaVersion: 1, entries: {}, categories: ['空分类'] });
    if (reconcile) assert.equal((await operation).head, C); else await assert.rejects(operation, error => error.code === 'REMOTE_CHANGED' && !error.message.includes('never-log-token'));
    const update = calls.find(([, options]) => options.method === 'PATCH'); assert.equal(JSON.parse(update[1].body).force, false);
    const commit = calls.find(([url]) => url.includes('/git/commits')); assert.deepEqual(JSON.parse(commit[1].body).parents, [A]);
    const tree = JSON.parse(calls.find(([url]) => url.includes('/git/trees'))[1].body);
    assert.deepEqual(JSON.parse(tree.tree.find(entry => entry.path === 'skill-cabinet/manifest.json').content).categories, ['空分类']);
  }
});
