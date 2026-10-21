import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { listCategories, saveCategories } from '../dist/storage.js';
import { parseSkillMarkdown, formatBytes, getSkillContent, exportSkill, exportLibrary, importFiles, initialize, listSkills, saveSkill, deleteSkill, getSyncMeta, setSyncMeta, decodeSkillArchive, applySyncChanges, onSkillsChanged } from '../dist/storage.js';

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
    transaction(names, mode) {
      const scope = Array.isArray(names) ? names : [names];
      const staged = new Map(scope.map(name => [name, structuredClone(tables.get(name))]));
      let pending = 0;
      let closed = false;
      const transaction = { error: null, abort() {
        if (closed) return;
        closed = true;
        transaction.onabort?.();
      } };
      const request = action => {
        const result = {};
        pending++;
        setTimeout(() => {
          if (closed) return;
          try { result.result = action(); result.onsuccess?.(); }
          catch (error) { transaction.error = error; transaction.abort(); }
          pending--;
          if (!closed && !pending) {
            closed = true;
            if (mode === 'readwrite') for (const [name, table] of staged) tables.set(name, table);
            transaction.oncomplete?.();
          }
        }, 0);
        return result;
      };
      transaction.objectStore = name => {
        const table = staged.get(name);
        if (!table) throw new Error('Object store outside transaction scope');
        return {
        get: key => request(() => structuredClone(table.get(key))),
        getAll: () => request(() => structuredClone([...table.values()])),
        delete: key => request(() => table.delete(key)),
        put: value => request(() => {
          if (name === 'skills' && [...table.values()].some(row => row.slug === value.slug && row.id !== value.id)) {
            const error = new Error('Duplicate slug'); error.name = 'ConstraintError'; throw error;
          }
          table.set(value.id || value.key, structuredClone(value)); return value.id || value.key;
        }),
        index: key => ({ get: value => request(() => structuredClone([...table.values()].find(row => row[key] === value))) }),
      }; };
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

test('nested example SKILL.md files remain attachments of their enclosing skill across export and backup', async () => {
  for (const prefix of ['', 'nuwa/']) {
    const zip = new JSZip();
    zip.file(`${prefix}SKILL.md`, '---\nname: nested-examples\n---\n# Nuwa\nResearch workflow');
    zip.file(`${prefix}examples/feynman/SKILL.md`, '---\nname: feynman\n---\n# Feynman\nExample only');
    zip.file(`${prefix}examples/feynman/references/research.md`, 'Complete reference');
    zip.file(`${prefix}LICENSE`, 'MIT');
    const records = await decodeSkillArchive(await zip.generateAsync({ type: 'uint8array' }));
    assert.equal(records.length, 1);
    assert.equal(records[0].slug, 'nested-examples');
    assert.equal(records[0].files.length, 4);
    const roundtrip = await decodeSkillArchive(await exportSkill(records[0]));
    assert.equal(roundtrip.length, 1);
    assert.equal(await roundtrip[0].files.find(file => file.path === 'examples/feynman/SKILL.md').data.text(), '---\nname: feynman\n---\n# Feynman\nExample only');
    const restored = await decodeSkillArchive(await exportLibrary(records));
    assert.equal(restored.length, 1);
    assert.ok(restored[0].files.some(file => file.path === 'examples/feynman/references/research.md'));
  }
  const siblings = new JSZip();
  siblings.file('alpha/SKILL.md', '# Alpha\nParent');
  siblings.file('alpha/examples/child/SKILL.md', '# Child\nExample');
  siblings.file('beta/SKILL.md', '# Beta\nIndependent sibling');
  const records = await decodeSkillArchive(await siblings.generateAsync({ type: 'uint8array' }));
  assert.deepEqual(records.map(record => record.slug).sort(), ['alpha', 'beta']);
  assert.ok(records.find(record => record.slug === 'alpha').files.some(file => file.path === 'examples/child/SKILL.md'));
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

test('repository startup reads existing data without fetching or marking seeds initialized', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Repository startup must not fetch seeds'); };
  try { assert.deepEqual(await initialize({ seed: false }), await listSkills()); }
  finally { globalThis.fetch = originalFetch; }
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

test('sync metadata is namespaced and excluded from portable backups', async () => {
  const before = await listSkills();
  await setSyncMeta('initialized', { token: 'private-test-token' });
  assert.deepEqual(await getSyncMeta('initialized'), { token: 'private-test-token' });
  assert.equal(await getSyncMeta('missing'), undefined);
  const backup = await exportLibrary(before);
  const zip = await JSZip.loadAsync(await backup.arrayBuffer());
  const text = await zip.file('library.json').async('string');
  assert.ok(!text.includes('private-test-token'));
  assert.ok(!text.includes('localRevision'));
});

test('archive decoding is pure, preserves txt instructions, and reads all three starter skills', async () => {
  const before = await listSkills();
  const zip = new JSZip();
  zip.file('example/SKILL.md', '---\nname: txt-guide\n---\n# TXT guide\nRead source only');
  zip.file('example/使用说明.txt', '这是使用说明');
  zip.file('example/scripts/run.js', 'throw new Error("must never execute")');
  const [decoded] = await decodeSkillArchive(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(decoded.instructions, '这是使用说明');
  assert.equal(decoded.files.length, 3);
  assert.equal((await listSkills()).length, before.length);
  const starter = await decodeSkillArchive(await readFile(new URL('../backups/skill-cabinet-starter.zip', import.meta.url)));
  assert.equal(starter.length, 3);
  assert.deepEqual(starter.map(record => record.slug).sort(), ['aibase-daily', 'daily-60s-image', 'shiguang-atlas']);
  // The portable export adds two generated 使用说明.md files to 37 source files.
  assert.equal(starter.reduce((sum, record) => sum + record.files.length, 0), 39);
});

test('sync applies records and baseline atomically, preserves local IDs, and emits committed changes', async () => {
  const changes = [];
  const unsubscribe = onSkillsChanged(change => changes.push(change));
  try {
    const original = await saveSkill({ id: 'sync-local', name: 'Sync local', slug: 'sync-local', content: '# Local', files: [] });
    assert.equal(changes.at(-1).source, 'local');
    const snapshot = await listSkills();
    const applied = await applySyncChanges([{ ...original, id: 'remote-device-id', content: '# Remote', favorite: true }], [], {
      expectedRecords: snapshot, metaKey: 'baseline', metaValue: { commit: 'abc' },
    });
    assert.equal(applied.upserts[0].id, original.id);
    assert.equal((await listSkills()).find(record => record.id === original.id).content, '# Remote');
    assert.deepEqual(await getSyncMeta('baseline'), { commit: 'abc' });
    assert.equal(changes.at(-1).source, 'remote');
    assert.notEqual(applied.upserts[0].localRevision, original.localRevision);
    await applySyncChanges([], [original.slug], { expectedRecords: await listSkills() });
    assert.ok(!(await listSkills()).some(record => record.slug === original.slug));
    assert.deepEqual(changes.at(-1).deletions, [original.slug]);
    const count = changes.length;
    unsubscribe();
    await setSyncMeta('silent', true);
    assert.equal(changes.length, count);
  } finally { unsubscribe(); }
});

test('sync rejects duplicate input and stale snapshots including same-size binary edits', async () => {
  const original = await saveSkill({ id: 'sync-revision', name: 'Revision', slug: 'sync-revision', content: '# Same text', updatedAt: 'fixed-time', files: [{ path: 'asset.bin', data: new Blob(['AA']) }] });
  const snapshot = await listSkills();
  await assert.rejects(applySyncChanges([original, { ...original, id: 'different' }]), /重复/);
  await assert.rejects(applySyncChanges([original, { ...original, slug: 'another-slug' }]), /重复/);
  const saved = await saveSkill({ ...original, files: [{ path: 'asset.bin', data: new Blob(['BB']) }] });
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.notEqual(saved.localRevision, original.localRevision);
  await assert.rejects(applySyncChanges([], [original.slug], { expectedRecords: snapshot, metaKey: 'stale-baseline', metaValue: 1 }), /本地技能发生变化/);
  assert.equal(await getSyncMeta('stale-baseline'), undefined);
  assert.equal(await (await listSkills()).find(record => record.id === original.id).files[0].data.text(), 'BB');
  const current = await listSkills();
  await saveSkill({ name: 'Concurrent addition', slug: 'concurrent-addition', content: '# Added' });
  await assert.rejects(applySyncChanges([], [], { expectedRecords: current }), /本地技能发生变化/);
});

test('failed sync transaction rolls back records, deletion, baseline and notifications', async () => {
  const original = await saveSkill({ id: 'sync-rollback', name: 'Rollback', slug: 'sync-rollback', content: '# Before' });
  await setSyncMeta('rollback-baseline', 'before');
  const changes = [];
  const unsubscribe = onSkillsChanged(change => changes.push(change));
  try {
    await assert.rejects(applySyncChanges([{ name: 'Must roll back', slug: 'must-roll-back', content: '# New' }], [original.slug], {
      expectedRecords: await listSkills(), metaKey: 'rollback-baseline', metaValue: () => 'cannot clone',
    }), /同步保存失败/);
    const records = await listSkills();
    assert.equal(records.find(record => record.id === original.id).content, '# Before');
    assert.ok(!records.some(record => record.slug === 'must-roll-back'));
    assert.equal(await getSyncMeta('rollback-baseline'), 'before');
    assert.equal(changes.length, 0);
  } finally { unsubscribe(); }
});

test('editor revision guards prevent stale form overwrite, resurrection and duplicate creation', async () => {
  const original = await saveSkill({ id: 'editor-revision', name: 'Editor revision', slug: 'editor-revision', content: '# Original' }, { expectedRevision: null });
  const current = await saveSkill({ ...original, content: '# Newest' }, { expectedRevision: original.localRevision });
  const changes = [];
  const unsubscribe = onSkillsChanged(change => changes.push(change));
  try {
    await assert.rejects(saveSkill({ ...original, content: '# Stale form' }, { expectedRevision: original.localRevision }), error => error.code === 'LOCAL_CHANGED');
    assert.equal((await listSkills()).find(record => record.id === current.id).content, '# Newest');
    await assert.rejects(saveSkill({ ...current, content: '# Duplicate creation' }, { expectedRevision: null }), error => error.code === 'LOCAL_CHANGED');
    assert.equal(changes.length, 0);
    await deleteSkill(current.id);
    const count = changes.length;
    await assert.rejects(saveSkill({ ...current, content: '# Resurrected stale form' }, { expectedRevision: current.localRevision }), error => error.code === 'LOCAL_CHANGED');
    assert.ok(!(await listSkills()).some(record => record.id === current.id));
    assert.equal(changes.length, count);
  } finally { unsubscribe(); }
});

test('instruction filename casing roundtrips edited text and favors canonical root guide', async () => {
  const zip = new JSZip();
  zip.file('SKILL.md', '# Instructions case\nBody');
  zip.file('使用说明.MD', 'Old instructions');
  const [imported] = await decodeSkillArchive(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(imported.instructions, 'Old instructions');
  const exported = await exportSkill({ ...imported, instructions: 'Edited instructions' });
  const roundtripZip = await JSZip.loadAsync(await exported.arrayBuffer());
  assert.equal(roundtripZip.file('使用说明.MD'), null);
  assert.equal(await roundtripZip.file('使用说明.md').async('string'), 'Edited instructions');
  const [restored] = await decodeSkillArchive(exported);
  assert.equal(restored.instructions, 'Edited instructions');
  zip.file('使用说明.md', 'Canonical instructions');
  const [canonical] = await decodeSkillArchive(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(canonical.instructions, 'Canonical instructions');
});

test('empty categories persist without skills, deduplicate and notify both local and remote listeners', async () => {
  const changes = [], unsubscribe = onSkillsChanged(change => changes.push(change));
  try {
    const before = await listSkills();
    await saveCategories([' 本机空分类 ', '本机空分类']);
    assert.deepEqual(await listCategories(), ['本机空分类']);
    assert.equal(changes.at(-1).source, 'local');
    assert.equal(changes.at(-1).categoriesChanged, true);
    const count = changes.length;
    await saveCategories(['本机空分类']);
    assert.equal(changes.length, count);
    await applySyncChanges([], [], { categories: ['仓库空分类'], expectedCategories: ['本机空分类'] });
    assert.deepEqual(await listCategories(), ['仓库空分类', '本机空分类']);
    assert.equal(changes.at(-1).source, 'remote');
    assert.deepEqual(await listSkills(), before);
  } finally { unsubscribe(); }
});

test('category races roll back the skills and sync baseline in the same transaction', async () => {
  const snapshot = await listCategories();
  await saveCategories(['并发新增分类']);
  const records = await listSkills();
  await assert.rejects(applySyncChanges([{ id: 'category-rollback', name: 'Rollback', slug: 'category-rollback', content: '# Rollback' }], [], {
    expectedCategories: snapshot, categories: ['云端空分类'], metaKey: 'category-rollback', metaValue: true,
  }), error => error.code === 'LOCAL_CHANGED');
  assert.deepEqual(await listSkills(), records);
  assert.equal(await getSyncMeta('category-rollback'), undefined);
  assert.ok(!(await listCategories()).includes('云端空分类'));
  assert.ok((await listCategories()).includes('并发新增分类'));
});
