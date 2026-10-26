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

test('a fresh checkout loads all bundled real archives and migrates a one-skill browser without credentials', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const seeds = JSON.parse(await readFile(new URL('../dist/assets/seed.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../skill-cabinet/manifest.json', import.meta.url), 'utf8'));
  const [decoded] = await decodeSkillArchive(await readFile(new URL('../dist/assets/shiguang-atlas.zip', import.meta.url)));
  const storage = memoryStorage([{ ...decoded, ...seeds[0], files: decoded.files, id: 'legacy-browser-id' }]);
  const client = new RepositoryLibrary({ storage, fetchImpl: (url, options) => fetch(new URL(url, base), options) });
  const result = await client.refresh();
  assert.equal(result.count, 23);
  assert.deepEqual(result.preserved, []);
  const records = await storage.listSkills();
  assert.deepEqual(records.map(record => record.slug).sort(), ['aibase-daily', 'animated-explainer-video', 'awesome-design-md', 'buffett-letters-skill', 'build-jin10-breakfast', 'cangjie-skill', 'claude-design', 'fupeng-macro-framework', 'generate-daily60-digest', 'huangzhizhong-communication', 'huashu-design', 'huashu-motion', 'huashu-nuwa', 'jin10-financial-daily', 'poor-charlies-almanack-skill', 'qinxiaoming-finance-thinking', 'ray-dalio-framework', 'senior-product-manager', 'shiguang-atlas', 'soros-reflexivity-framework', 'ui-ux-pro-max', 'vibe-knowledge-film', 'warm-paper-editorial']);
  assert.equal(records.find(record => record.slug === 'shiguang-atlas').id, 'legacy-browser-id');
  assert.ok(records.every(record => record.content && record.files.length > 0));
  const vibe = records.find(record => record.slug === 'vibe-knowledge-film');
  assert.equal(vibe.name, 'Vibe 知识短片 · 无旁白科普');
  assert.equal(vibe.category, '图像与设计');
  assert.equal(vibe.files.length, 43);
  for (const file of ['engine/vk.js', 'engine/vk-kit.js', 'engine/render.py', 'engine/audio.py', 'engine/get_fonts.py', 'scripts/new_film.py', 'requirements.txt', 'references/engine.md', 'references/visualization.md', 'references/prompts.md', 'references/analysis.md', 'examples/fold_C/film.js', 'examples/pigeon_B/film.js', 'examples/kit_gallery/film.js', 'LICENSE', 'upstream/SKILL.original.md', '使用说明.md', 'CABINET_SOURCE.json']) assert.ok(vibe.files.some(item => item.path === file), file);
  assert.ok(vibe.files.every(file => !/^examples\/(stim_B|info_C)\//.test(file.path) && !file.path.endsWith('.gif')));
  const vibeSource = JSON.parse(await vibe.files.find(file => file.path === 'CABINET_SOURCE.json').data.text());
  assert.equal(vibeSource.commit, '62d51508aad00003dc6209afa80c4b5dc540de59');
  const { createHash } = await import('node:crypto');
  for (const file of vibeSource.unchangedFiles) {
    const data = new Uint8Array(await vibe.files.find(item => item.path === file).data.arrayBuffer());
    assert.equal(createHash('sha1').update(`blob ${data.byteLength}\0`).update(data).digest('hex'), vibeSource.sourceFiles.find(item => item.path === file).sha, file);
  }
  assert.match(await vibe.files.find(file => file.path === 'references/analysis.md').data.text(), /不复制该材料/);
  const animated = records.find(record => record.slug === 'animated-explainer-video');
  assert.equal(animated.name, '趣味科普动画视频');
  assert.equal(animated.category, '图像与设计');
  assert.equal(animated.files.length, 41);
  assert.equal(animated.files.filter(file => file.path.endsWith('.mp3')).length, 19);
  assert.equal(animated.files.find(file => file.path === 'assets/fonts/NotoSansSC.ttf').data.size, 17772300);
  for (const file of ['SKILL.md', 'agents/openai.yaml', 'assets/fonts/OFL.txt', 'assets/potato/story.json', 'assets/potato/sources.json', 'assets/potato/visuals.py', 'assets/starter/story.json', 'assets/starter/visuals.py', 'assets/runtime/narrate.py', 'assets/runtime/render.py', 'assets/runtime/verify.py', 'scripts/init_project.py', 'scripts/setup_env.py', 'scripts/install_skill.py', 'references/workflow.md', 'references/install-and-use.md']) assert.ok(animated.files.some(item => item.path === file), file);
  const designLibrary = records.find(record => record.slug === 'awesome-design-md');
  assert.equal(designLibrary.category, '图像与设计');
  assert.equal(designLibrary.files.filter(file => /^library\/[^/]+\/DESIGN\.md$/.test(file.path)).length, 84);
  assert.equal(designLibrary.files.length, 90);
  assert.equal(designLibrary.files.filter(file => /(^|\/)SKILL\.md$/i.test(file.path)).length, 1);
  const claudeDesign = records.find(record => record.slug === 'claude-design');
  assert.equal(claudeDesign.name, '克劳德设计');
  assert.equal(claudeDesign.category, '图像与设计');
  assert.equal(claudeDesign.files.length, 8);
  const websiteDesign = records.find(record => record.slug === 'ui-ux-pro-max');
  assert.equal(websiteDesign.name, 'UI/UX Pro Max · 网站设计');
  assert.equal(websiteDesign.category, '图像与设计');
  assert.equal(websiteDesign.version, '2.15.0');
  assert.equal(websiteDesign.files.length, 80);
  for (const file of ['scripts/search.py', 'scripts/core.py', 'scripts/design_system.py', 'data/styles.csv', 'data/colors.csv', 'data/typography.csv', 'data/stacks/nextjs.csv', 'references/quick-reference.md', 'references/pro-rules.md', 'LICENSE', 'upstream/SKILL.original.md', 'upstream/source.json', '使用说明.md']) assert.ok(websiteDesign.files.some(item => item.path === file), file);
  const source = JSON.parse(await websiteDesign.files.find(item => item.path === 'upstream/source.json').data.text());
  assert.equal(source.repository, 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill');
  assert.equal(source.commit, '1f8857914da3c723d58dab1d609dd0d55a86bf51');
  const productManager = records.find(record => record.slug === 'senior-product-manager');
  assert.equal(productManager.name, '资深产品经理');
  assert.equal(productManager.category, '开发与工具');
  assert.equal(productManager.files.length, 5);
  for (const file of ['agents/openai.yaml', 'references/clarification.md', 'references/product-design-book.md', '使用说明.md']) assert.ok(productManager.files.some(item => item.path === file), file);
  assert.ok((await storage.listCategories()).includes('开发与工具'));
  for (const [slug, fileCount] of [['aibase-daily', 18], ['generate-daily60-digest', 36], ['build-jin10-breakfast', 53]]) {
    const news = records.find(record => record.slug === slug);
    // Display names can be edited and synced independently of the stable slug.
    assert.equal(news.name, manifest.entries[slug].metadata.name);
    assert.equal(news.category, '新闻日报');
    assert.equal(news.favorite, true);
    assert.equal(news.files.length, fileCount);
  }
  const design = records.find(record => record.slug === 'huashu-design');
  assert.equal(design.category, '图像与设计');
  assert.equal(design.version, '3.0.0');
  assert.equal(design.author, '花叔');
  assert.equal(design.files.length, 391);
  const paths = new Set(design.files.map(file => file.path));
  for (const file of ['LICENSE', 'README.md', 'package.json', 'assets/design_canvas.jsx', 'references/workflow.md', 'scripts/verify.py', 'demos/c1-ios-prototype.html', 'upstream/SKILL.original.md']) assert.ok(paths.has(file), file);
  assert.match(await design.files.find(file => file.path === 'LICENSE').data.text(), /MIT License/);
  const nuwa = records.find(record => record.slug === 'huashu-nuwa');
  assert.equal(nuwa.category, '学习与研究');
  assert.equal(nuwa.version, '1.0.0');
  assert.equal(nuwa.files.length, 164);
  assert.equal(nuwa.files.filter(file => /^examples\/.+\/SKILL\.md$/.test(file.path)).length, 15);
  for (const file of ['LICENSE', 'references/extraction-framework.md', 'scripts/quality_check.py', 'examples/feynman-perspective/SKILL.md', 'upstream/SKILL.original.md']) assert.ok(nuwa.files.some(item => item.path === file), file);
  const motion = records.find(record => record.slug === 'huashu-motion');
  assert.equal(motion.category, '图像与设计');
  assert.equal(motion.version, '0.1.1');
  assert.equal(motion.files.length, 327);
  const motionFiles = new Map(motion.files.map(file => [file.path, file.data]));
  for (const file of ['LICENSE', 'THIRD_PARTY.md', 'cli/om.js', 'runtime/om-engine.js', 'fonts/LICENSES.md', 'templates/blank/index.html', 'skills/huashu-motion/SKILL.md', 'references/director.md', 'bin/om', 'bin/om.cmd']) assert.ok(motionFiles.has(file), file);
  assert.equal(await motionFiles.get('references/director.md').text(), await motionFiles.get('skills/huashu-motion/references/director.md').text());
  assert.match(await motionFiles.get('bin/om').text(), /DIR\/\.\.\/cli\/om\.js/);
  assert.match(await motionFiles.get('bin/om.cmd').text(), /cli\\om\.js/);
  const paper = records.find(record => record.slug === 'warm-paper-editorial');
  assert.equal(paper.name, '暖纸编辑设计');
  assert.equal(paper.category, '图像与设计');
  assert.equal(paper.version, '1.0.0');
  for (const file of ['assets/tokens.json', 'assets/paper.css', 'assets/line-art.svg', 'assets/folio-mark.svg', 'assets/reference.png', 'references/web.md', 'references/documents-pdf.md', 'references/image-prompts.md', 'references/quality-check.md', 'scripts/check_palette.py', 'agents/openai.yaml', 'upstream/SKILL.original.md']) assert.ok(paper.files.some(item => item.path === file), file);
  const cangjie = records.find(record => record.slug === 'cangjie-skill');
  assert.equal(cangjie.category, '学习与研究');
  assert.equal(cangjie.version, '2.5.0');
  assert.equal(cangjie.files.length, 370);
  for (const file of ['LICENSE', 'README.zh-CN.md', 'scripts/cangjie.py', 'methodology/00-overview.md', 'upstream/SKILL.original.md', 'CABINET_SOURCE.json']) assert.ok(cangjie.files.some(item => item.path === file), file);
  for (const [slug, category, modules, fileCount] of [['poor-charlies-almanack-skill', '学习与研究', 12, 77], ['buffett-letters-skill', '投资与金融', 20, 57]]) {
    const collection = records.find(record => record.slug === slug);
    assert.equal(collection.category, category);
    assert.equal(collection.files.length, fileCount);
    assert.equal(collection.files.filter(file => /^[^/]+\/SKILL\.md$/.test(file.path)).length, modules);
    for (const file of ['INDEX.md', 'BOOK_OVERVIEW.md', 'LICENSE', 'verified.md', 'circle-of-competence/SKILL.md', 'circle-of-competence/test-prompts.json', 'CABINET_SOURCE.json']) assert.ok(collection.files.some(item => item.path === file), `${slug}/${file}`);
    assert.ok(collection.files.some(file => file.path.startsWith('candidates/')));
    assert.ok(collection.files.some(file => file.path.startsWith('rejected/')));
  }
  assert.ok((await storage.listCategories()).includes('投资与金融'));
  for (const [slug, category, count] of [['fupeng-macro-framework', '投资与金融', 70], ['soros-reflexivity-framework', '投资与金融', 66], ['ray-dalio-framework', '投资与金融', 15], ['qinxiaoming-finance-thinking', '投资与金融', 5], ['huangzhizhong-communication', '写作与内容', 10]]) {
    const entry = records.find(record => record.slug === slug);
    assert.equal(entry.category, category);
    assert.equal(entry.files.length, count);
    for (const file of ['upstream/SKILL.original.md', 'upstream/README.md', 'CABINET_SOURCE.json', '使用说明.md']) assert.ok(entry.files.some(item => item.path === file), `${slug}/${file}`);
    assert.match(entry.content, /^---\n/);
    assert.doesNotMatch(entry.content, /\n\n(?:name|description): /);
    if (['fupeng-macro-framework', 'soros-reflexivity-framework'].includes(slug)) assert.match(await entry.files.find(file => file.path === 'upstream/SKILL.original.md').data.text(), /^\*\*\*/);
  }
  const dalio = records.find(record => record.slug === 'ray-dalio-framework');
  assert.ok(dalio.files.some(file => file.path === 'scripts/dalio_economic_indicators_20260909.xlsx' && file.data.size > 0));
  const huang = records.find(record => record.slug === 'huangzhizhong-communication');
  assert.equal(huang.files.filter(file => file.path.startsWith('references/')).length, 5);
  assert.ok((await storage.listCategories()).includes('写作与内容'));
  const manifestResponse = await fetch(new URL('skill-cabinet/manifest.json', base));
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-store');
  const updatedManifest = await manifestResponse.json();
  for (const oldSlug of ['daily-60s-image', 'jin10-breakfast']) assert.equal(updatedManifest.entries[oldSlug].deleted, true);
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
