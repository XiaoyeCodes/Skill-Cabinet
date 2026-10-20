import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseSkillMarkdown, formatBytes, getSkillContent, exportSkill, exportLibrary, importFiles, initialize, listSkills, saveSkill, deleteSkill } from '../dist/storage.js';

const zipModule = { exports: {} };
vm.runInNewContext(await readFile(new URL('../dist/vendor/jszip.min.js', import.meta.url), 'utf8'), {
  module: zipModule, exports: zipModule.exports, Buffer, setTimeout, clearTimeout, setImmediate, Uint8Array, ArrayBuffer,
});
globalThis.JSZip = zipModule.exports;

// A minimal asynchronous IndexedDB adapter keeps persistence-facing behavior testable in Node.
function memoryIndexedDB() {
  const tables = new Map();
  const db = {
    createObjectStore(name) { tables.set(name, new Map()); return { createIndex() {} }; },
    close() {},
    transaction(name) {
      const transaction = { error: null };
      const table = tables.get(name);
      const request = action => {
        const result = {};
        setTimeout(() => {
          try { result.result = action(); result.onsuccess?.(); transaction.oncomplete?.(); }
          catch (error) { transaction.error = error; transaction.onabort?.(); }
        }, 0);
        return result;
      };
      transaction.objectStore = () => ({
        get: key => request(() => table.get(key)),
        getAll: () => request(() => [...table.values()]),
        delete: key => request(() => table.delete(key)),
        put: value => request(() => { table.set(value.id || value.key, structuredClone(value)); return value.id || value.key; }),
        index: key => ({ get: value => request(() => [...table.values()].find(row => row[key] === value)) }),
      });
      return transaction;
    },
  };
  return { open() {
    const request = { result: db };
    setTimeout(() => { if (!tables.size) request.onupgradeneeded?.(); request.onsuccess?.(); }, 0);
    return request;
  } };
}

globalThis.indexedDB = memoryIndexedDB();
const makeFile = (data, name) => Object.assign(new Blob([data]), { name });
const markdown = '---\nname: "Test skill"\ndescription: >\n  First line\n  second line\nversion: "1.0"\nlicense: MIT\n---\n\n# Test skill\nNever execute source.';

test('markdown parses quoted and folded metadata while keeping source inert', () => {
  const parsed = parseSkillMarkdown(markdown);
  assert.equal(parsed.name, 'Test skill');
  assert.equal(parsed.description, 'First line second line');
  assert.equal(parsed.slug, 'test-skill');
  assert.equal(parsed.content, markdown);
  assert.equal(parseSkillMarkdown('# 中文技能\n\nBody').name, '中文技能');
  assert.match(parseSkillMarkdown('# 中文技能\n\nBody').slug, /^skill-[a-f0-9]{8}$/);
  assert.equal(parseSkillMarkdown('---\nname: shiguang-atlas\n---\n# 拾光百科图文\nBody').name, '拾光百科图文');
  assert.equal(parseSkillMarkdown('---\nname: shiguang-atlas\ndisplay_name: "中文显示名"\n---\n# Old heading\nBody').name, '中文显示名');
  assert.equal(parseSkillMarkdown('---\nname: shiguang-atlas\ndisplay_name: "中文显示名"\n---\n# Old heading\nBody').slug, 'shiguang-atlas');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('export updates metadata, keeps unknown frontmatter and binary assets', async () => {
  const record = { name: '改名 "Quoted"', slug: 'renamed-skill', content: markdown.replace('license: MIT', 'license: MIT\ntags: ["old-tag"]\ncategory: "旧分类"'), description: '换行\n描述', version: '2.0', author: '开发者', tags: ['新标签', 'writing'], category: '写作', instructions: '运行前阅读', files: [
    { path: 'SKILL.md', data: new Blob(['stale']) },
    { path: 'assets/example.bin', data: new Blob([new Uint8Array([0, 255, 3])]) },
    { path: 'scripts/example.py', data: new Blob(['print("only text")']) },
  ] };
  const blob = await exportSkill(record);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const text = await zip.file('SKILL.md').async('string');
  assert.equal(text, getSkillContent(record));
  assert.match(text, /^---\nname: "renamed-skill"\ndisplay_name: "改名 \\"Quoted\\""/);
  assert.equal(parseSkillMarkdown(text).name, record.name);
  assert.equal(parseSkillMarkdown(text).slug, record.slug);
  assert.deepEqual(parseSkillMarkdown(text).tags, record.tags);
  assert.equal(parseSkillMarkdown(text).category, record.category);
  assert.equal((text.match(/^tags:/gm) || []).length, 1);
  assert.equal(parseSkillMarkdown(text).description, record.description);
  assert.match(text, /license: MIT/);
  assert.equal(await zip.file('使用说明.md').async('string'), record.instructions);
  assert.deepEqual([...await zip.file('assets/example.bin').async('uint8array')], [0, 255, 3]);
  assert.equal(await zip.file('scripts/example.py').async('string'), 'print("only text")');
});

test('import divides multiple skill folders and preserves shared top-level instructions', async () => {
  const zip = new JSZip();
  zip.file('alpha/SKILL.md', '---\nname: Alpha\n---\nBody A');
  zip.file('alpha/assets/a.txt', 'A');
  zip.file('beta/SKILL.md', '---\nname: Beta\n---\nBody B');
  zip.file('beta/scripts/b.py', 'B');
  zip.file('使用说明.md', 'Shared guide');
  const report = await importFiles([makeFile(await zip.generateAsync({ type: 'uint8array' }), 'multi.zip')]);
  assert.equal(report.errors.length, 0);
  assert.equal(report.imported.length, 2);
  assert.equal(report.imported[0].instructions, 'Shared guide');
  assert.deepEqual(report.imported[0].files.map(file => file.path).sort(), ['SKILL.md', 'assets/a.txt', '使用说明.md'].sort());
  assert.ok(report.imported[1].files.some(file => file.path === 'scripts/b.py'));
  const duplicate = await importFiles([makeFile('# Alpha\nBody', 'SKILL.md')]);
  assert.equal(duplicate.skipped.length, 1);
  assert.equal(duplicate.imported.length, 0);
});

test('backup restores editable metadata and attachments without overwriting duplicates', async () => {
  const original = await saveSkill({ name: 'Backup skill', slug: 'backup-skill', id: 'backup-id', content: markdown, favorite: true, category: '图像', tags: ['中文'], instructions: '说明', author: '作者', version: '3', createdAt: '2020-01-01', files: [{ path: 'references/a.md', data: new Blob(['Reference']) }] });
  const backup = await exportLibrary([original]);
  const zip = await JSZip.loadAsync(await backup.arrayBuffer());
  const manifest = JSON.parse(await zip.file('library.json').async('string'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.skills[0].archivePath, 'skills/backup-id.zip');
  await deleteSkill(original.id);
  const restored = await importFiles([makeFile(backup, 'backup.zip')]);
  assert.equal(restored.errors.length, 0);
  assert.equal(restored.imported.length, 1);
  const record = restored.imported[0];
  for (const key of ['name', 'content', 'favorite', 'category', 'instructions', 'author', 'version', 'createdAt']) assert.deepEqual(record[key], original[key]);
  assert.deepEqual(record.tags, ['中文']);
  assert.equal(await record.files.find(file => file.path === 'references/a.md').data.text(), 'Reference');
  const duplicate = await importFiles([makeFile(backup, 'backup.zip')]);
  assert.equal(duplicate.skipped.length, 1);
});

test('rejects traversal, empty names and malformed files while continuing the batch', async () => {
  const zip = new JSZip();
  zip.file('../escape/SKILL.md', '# Malicious\nBody');
  const report = await importFiles([
    makeFile(await zip.generateAsync({ type: 'uint8array' }), 'unsafe.zip'),
    makeFile('No name, no heading', 'bad.md'),
    makeFile('{invalid', 'bad.json'),
    makeFile('# Good batch item\nWorks', 'valid.md'),
  ]);
  assert.equal(report.errors.length, 3);
  assert.match(report.errors[0].message, /不安全/);
  assert.equal(report.imported.length, 1);
  await assert.rejects(exportSkill({ name: '', content: '# Body' }), /名称不能为空/);
  await assert.rejects(exportSkill({ name: 'Empty', content: '' }), /内容不能为空/);
});

test('seed initialization imports the actual supplied package only once', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(`../dist/${String(url).replace(/^\.\//, '')}`, import.meta.url);
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200 });
  };
  try {
    const records = await initialize();
    const seed = records.find(record => record.id === 'shiguang-atlas-seed');
    assert.ok(seed);
    assert.ok(seed.files.length > 10);
    assert.ok(seed.files.some(file => file.path.startsWith('references/')));
    assert.equal(records.find(record => record.slug === 'aibase-daily').files.length, 10);
    assert.equal(records.find(record => record.slug === 'daily-60s-image').files.length, 6);
    await deleteSkill(seed.id);
    assert.ok(!(await initialize()).some(record => record.id === seed.id));
    assert.ok(!(await listSkills()).some(record => record.id === seed.id));
  } finally { globalThis.fetch = originalFetch; }
});

test('storage failure is explicit instead of pretending the save succeeded', async () => {
  const adapter = globalThis.indexedDB;
  delete globalThis.indexedDB;
  try {
    const isolated = await import('../dist/storage.js?missing-indexeddb');
    await assert.rejects(isolated.saveSkill({ name: 'Missing storage', content: '# Body' }), /IndexedDB.*无法保存/);
  } finally { globalThis.indexedDB = adapter; }
});

test('Chinese-only names get stable ASCII identifiers and punctuation-only names fail', async () => {
  const chinese = '# 纯中文技能名称\n\n内容';
  const first = await importFiles([makeFile(chinese, 'chinese.md')]);
  assert.equal(first.errors.length, 0);
  assert.match(first.imported[0].slug, /^skill-[a-f0-9]{8}$/);
  const second = await importFiles([makeFile(chinese, 'chinese.md')]);
  assert.equal(second.skipped.length, 1);
  const invalid = await importFiles([makeFile('# !!!\n\nBody', 'punctuation.md')]);
  assert.equal(invalid.imported.length, 0);
  assert.equal(invalid.errors.length, 1);
  assert.match(invalid.errors[0].message, /文字或数字/);
  await assert.rejects(saveSkill({ name: 'Invalid identifier', slug: '中文标识', content: '# Body' }), /技能标识/);
  const explicit = await saveSkill({ name: '保留显式标识', slug: 'my_skill-v2', content: '# Body' });
  assert.equal(explicit.slug, 'my_skill-v2');
});
