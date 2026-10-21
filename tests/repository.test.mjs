import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { createServer } from '../server.mjs';
import { RepositoryLibrary } from '../dist/repository-library.js';
import { exportSkill, decodeSkillArchive } from '../dist/storage.js';
import { fingerprintSkill } from '../dist/sync-engine.js';
import { sha256 } from '../dist/github-client.js';
import { mergeCategories } from '../dist/categories.js';

globalThis.crypto ||= webcrypto;
const module = { exports: {} };
vm.runInNewContext(await readFile(new URL('../dist/vendor/jszip.min.js', import.meta.url), 'utf8'), { module, exports: module.exports, Buffer, setTimeout, clearTimeout, setImmediate, Uint8Array, ArrayBuffer });
globalThis.JSZip = module.exports;

const skill = (body = 'Original', extra = {}) => ({ id: 'repo-test', slug: 'repo-test', name: 'Repository test', content: `# Test\n${body}`, description: '', category: 'Tools', tags: [], version: '1.0', author: '', favorite: false, instructions: '', files: [], ...extra });
function memoryStorage(initial = [], initialCategories = []) {
  let records = structuredClone(initial), revision = 0;
  let categories = mergeCategories(initialCategories);
  const meta = new Map();
  return {
    listSkills: async () => structuredClone(records),
    listCategories: async () => [...categories],
    saveCategories: async names => { categories = mergeCategories(categories, names); return [...categories]; },
    getSyncMeta: async key => structuredClone(meta.get(key)),
    decodeSkillArchive,
    async applySyncChanges(upserts, deletions, options) {
      if (options.expectedCategories) assert.deepEqual(categories, options.expectedCategories);
      assert.deepEqual(records, options.expectedRecords, 'concurrent edit must reject the transaction');
      const next = records.filter(record => !deletions.includes(record.slug) && !upserts.some(item => item.slug === record.slug));
      for (const record of upserts) next.push({ ...record, id: records.find(item => item.slug === record.slug)?.id || record.id, localRevision: ++revision });
      records = structuredClone(next);
      categories = mergeCategories(categories, options.categories || []);
      meta.set(options.metaKey, structuredClone(options.metaValue));
    },
    async edit(record) { records = records.filter(item => item.slug !== record.slug).concat({ ...record, localRevision: ++revision }); },
    async remove(slug) { records = records.filter(item => item.slug !== slug); },
  };
}
function checkout() {
  const manifest = { schemaVersion: 1, entries: {} }, archives = new Map();
  let reads = 0;
  return {
    manifest, archives,
    get reads() { return reads; },
    async add(record) {
      const blob = await exportSkill(record), hash = await sha256(blob);
      const archivePath = `skill-cabinet/archives/${record.slug}-${hash}.zip`;
      const { files, content, instructions, localRevision, ...metadata } = record;
      archives.set(archivePath, new Uint8Array(await blob.arrayBuffer()));
      manifest.entries[record.slug] = { metadata, archivePath, fingerprint: await fingerprintSkill(record), archiveSha256: hash };
    },
    async fetch(url, options) {
      assert.equal(options.cache, 'no-store');
      if (url === './skill-cabinet/manifest.json') return new Response(JSON.stringify(manifest));
      reads++;
      const bytes = archives.get(url.replace(/^\.\//, ''));
      return new Response(bytes || '', { status: bytes ? 200 : 404 });
    },
  };
}
const library = (storage, source) => new RepositoryLibrary({ storage, fetchImpl: source.fetch.bind(source) });

test('a fresh checkout loads all five real archives and migrates a one-skill browser without credentials', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const seeds = JSON.parse(await readFile(new URL('../dist/assets/seed.json', import.meta.url), 'utf8'));
  const [decoded] = await decodeSkillArchive(await readFile(new URL('../dist/assets/shiguang-atlas.zip', import.meta.url)));
  const storage = memoryStorage([{ ...decoded, ...seeds[0], files: decoded.files, id: 'legacy-browser-id' }]);
  const client = new RepositoryLibrary({ storage, fetchImpl: (url, options) => fetch(new URL(url, base), options) });
  const result = await client.refresh();
  assert.equal(result.count, 5);
  assert.deepEqual(result.preserved, []);
  const records = await storage.listSkills();
  assert.deepEqual(records.map(record => record.slug).sort(), ['aibase-daily', 'daily-60s-image', 'jin10-breakfast', 'jin10-financial-daily', 'shiguang-atlas']);
  assert.equal(records.find(record => record.slug === 'shiguang-atlas').id, 'legacy-browser-id');
  assert.ok(records.every(record => record.content && record.files.length > 0));
  const manifestResponse = await fetch(new URL('skill-cabinet/manifest.json', base));
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-store');
  for (const path of ['.git/config', 'README.md', 'skill-cabinet/other.json', 'skill-cabinet/archives/secret.zip', 'skill-cabinet/%2e%2e%2f.git/config']) {
    assert.equal((await fetch(new URL(path, base))).status, 404, path);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base)).status, 200);
});

test('repository updates replace unchanged content while avoiding repeated archive downloads', async () => {
  const source = checkout(), storage = memoryStorage(), client = library(storage, source);
  await source.add(skill());
  await client.refresh();
  const id = (await storage.listSkills())[0].id;
  const reads = source.reads;
  assert.equal((await client.refresh()).changed, false);
  assert.equal(source.reads, reads);
  await source.add(skill('After git pull', { id: 'another-device-id' }));
  assert.equal((await client.refresh()).changed, true);
  assert.equal((await storage.listSkills())[0].id, id);
  assert.match((await storage.listSkills())[0].content, /After git pull/);
});

test('local edits, imports and deletions survive upstream changes and browser restarts', async () => {
  const source = checkout(), storage = memoryStorage([skill('Locally edited')]);
  const client = library(storage, source);
  await source.add(skill());
  assert.equal((await client.refresh()).preserved.length, 1);
  await source.add(skill('Upstream update'));
  assert.equal((await client.refresh()).preserved.length, 1);
  assert.match((await storage.listSkills())[0].content, /Locally edited/);
  await storage.remove('repo-test');
  await library(storage, source).refresh();
  assert.equal((await storage.listSkills()).length, 0);
  await storage.edit(skill('Personal only', { slug: 'personal-only', id: 'personal-id' }));
  await library(storage, source).refresh();
  assert.deepEqual((await storage.listSkills()).map(record => record.slug), ['personal-only']);
});

test('upstream deletions remove unchanged copies and retain local edits', async () => {
  const source = checkout(), storage = memoryStorage(), client = library(storage, source);
  await source.add(skill()); await source.add(skill('Keep original', { id: 'other', slug: 'other' }));
  await client.refresh();
  await storage.edit({ ...(await storage.listSkills()).find(record => record.slug === 'other'), favorite: true });
  source.manifest.entries['repo-test'] = { deleted: true, updatedAt: new Date().toISOString() };
  delete source.manifest.entries.other;
  const result = await client.refresh();
  assert.equal(result.preserved.length, 1);
  assert.deepEqual((await storage.listSkills()).map(record => record.slug), ['other']);
});

test('a missing or corrupt archive leaves the whole library unchanged and is retryable', async () => {
  const source = checkout(), storage = memoryStorage(), client = library(storage, source);
  await source.add(skill());
  await source.add(skill('Second', { id: 'second', slug: 'second' }));
  const path = source.manifest.entries.second.archivePath, bytes = source.archives.get(path);
  source.archives.delete(path);
  await assert.rejects(client.refresh(), /无法读取/);
  assert.equal((await storage.listSkills()).length, 0);
  assert.equal(await storage.getSyncMeta('repository-library:v1'), undefined);
  source.archives.set(path, new Uint8Array([1, 2, 3]));
  await assert.rejects(client.refresh(), /校验失败/);
  assert.equal((await storage.listSkills()).length, 0);
  source.archives.set(path, bytes);
  const expectedFingerprint = source.manifest.entries.second.fingerprint;
  source.manifest.entries.second.fingerprint = '0'.repeat(64);
  await assert.rejects(client.refresh(), /与清单不一致/);
  assert.equal((await storage.listSkills()).length, 0);
  source.manifest.entries.second.fingerprint = expectedFingerprint;
  await client.refresh();
  assert.equal((await storage.listSkills()).length, 2);
});

test('static hosting falls back on first use, but an existing repository never resets on missing manifest', async () => {
  const storage = memoryStorage(), fetchImpl = async () => new Response('', { status: 404 });
  assert.deepEqual(await new RepositoryLibrary({ storage, fetchImpl }).refresh(), { available: false });
  const source = checkout(); await source.add(skill());
  await library(storage, source).refresh();
  await assert.rejects(new RepositoryLibrary({ storage, fetchImpl }).refresh(), /暂时不可用/);
  assert.equal((await storage.listSkills()).length, 1);
});

test('edits during archive reads reject the stale transaction and survive retry', async () => {
  const source = checkout(), storage = memoryStorage(); await source.add(skill());
  let edit = true;
  const client = new RepositoryLibrary({ storage, fetchImpl: async (...args) => {
    const response = await source.fetch(...args);
    if (args[0].endsWith('.zip') && edit) { edit = false; await storage.edit(skill('Concurrent edit')); }
    return response;
  } });
  await assert.rejects(client.refresh(), /concurrent edit/);
  assert.equal(await storage.getSyncMeta('repository-library:v1'), undefined);
  assert.equal((await client.refresh()).preserved.length, 1);
  assert.match((await storage.listSkills())[0].content, /Concurrent edit/);
});

async function categoryServer(t, document = { schemaVersion: 1, entries: {}, categories: ['仓库空分类'] }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-cabinet-categories-'));
  await mkdir(path.join(directory, 'skill-cabinet'));
  const manifestPath = path.join(directory, 'skill-cabinet/manifest.json');
  await writeFile(manifestPath, JSON.stringify(document));
  const server = createServer({ repositoryRoot: directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'skill-cabinet-categories-')));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  return { manifestPath, base, fetchImpl: (url, options) => fetch(new URL(url, base), options) };
}

test('empty local categories are written to the tracked manifest and pulled by a fresh browser', async t => {
  const initial = { schemaVersion: 1, entries: {}, categories: ['仓库空分类'], extension: { keep: true } };
  const source = await categoryServer(t, initial);
  const storage = memoryStorage([], ['本机空分类']);
  const client = new RepositoryLibrary({ storage, fetchImpl: source.fetchImpl });
  assert.equal((await client.refresh()).categoriesOnDisk, true);
  const onDisk = JSON.parse(await readFile(source.manifestPath, 'utf8'));
  assert.deepEqual(onDisk.categories, mergeCategories(['本机空分类', '仓库空分类']));
  assert.deepEqual(onDisk.entries, initial.entries);
  assert.deepEqual(onDisk.extension, initial.extension);
  assert.equal((await storage.listSkills()).length, 0);
  const fresh = memoryStorage();
  const replica = new RepositoryLibrary({ storage: fresh, fetchImpl: source.fetchImpl });
  await replica.refresh();
  assert.deepEqual(await fresh.listCategories(), onDisk.categories);
  // Replacing the disk manifest models the result of git pull on another checkout.
  onDisk.categories.push('拉取后新增分类');
  await writeFile(source.manifestPath, JSON.stringify(onDisk));
  assert.equal((await replica.refresh()).changed, true);
  assert.deepEqual(await fresh.listCategories(), mergeCategories(onDisk.categories));
});

test('category endpoint merges concurrent additions and rejects cross-origin or invalid writes', async t => {
  const source = await categoryServer(t);
  const put = (categories, headers = {}) => source.fetchImpl('./api/categories', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ categories }) });
  const results = await Promise.all([put(['甲']), put(['乙']), put(['甲'])]);
  assert.ok(results.every(response => response.status === 200));
  const onDisk = JSON.parse(await readFile(source.manifestPath, 'utf8'));
  assert.deepEqual(onDisk.categories, mergeCategories(['甲', '乙', '仓库空分类']));
  const unchanged = await readFile(source.manifestPath, 'utf8');
  assert.equal((await put(['跨站写入'], { Origin: 'https://example.com' })).status, 403);
  assert.equal((await put(['x'.repeat(31)])).status, 400);
  assert.equal((await put([null])).status, 400);
  assert.equal(await readFile(source.manifestPath, 'utf8'), unchanged);
});

test('category write failures preserve browser additions and retry on the next repository check', async t => {
  const source = await categoryServer(t), storage = memoryStorage([], ['待写入']);
  let fail = true;
  const client = new RepositoryLibrary({ storage, fetchImpl: (url, options) => url === './api/categories' && fail ? Promise.resolve(new Response('', { status: 500 })) : source.fetchImpl(url, options) });
  await assert.rejects(client.refresh(), /写入本地仓库失败/);
  assert.ok((await storage.listCategories()).includes('待写入'));
  fail = false;
  await client.refresh();
  assert.ok(JSON.parse(await readFile(source.manifestPath, 'utf8')).categories.includes('待写入'));
});
