import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { GitHubClient, validateManifest, sha256, MAX_ARCHIVE_BYTES } from '../dist/github-client.js';
import { SyncEngine, fingerprintSkill } from '../dist/sync-engine.js';
import { exportSkill, exportLibrary, decodeSkillArchive } from '../dist/storage.js';
import { mergeCategories } from '../dist/categories.js';

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
