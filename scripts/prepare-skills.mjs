import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseSkillMarkdown, getSkillContent, exportLibrary } from '../dist/storage.js';

// Supplied skills are data. Never execute their scripts.
const root = fileURLToPath(new URL('../', import.meta.url));
const zipModule = { exports: {} };
vm.runInNewContext(await readFile(path.join(root, 'dist/vendor/jszip.min.js'), 'utf8'), {
  module: zipModule, exports: zipModule.exports, Buffer, setTimeout, clearTimeout, setImmediate, Uint8Array, ArrayBuffer,
});
globalThis.JSZip = zipModule.exports;
const JSZip = zipModule.exports;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = process.argv.slice(2);
if (!sources.length) throw new Error('Usage: node scripts/prepare-skills.mjs <skill.zip> [another-skill.zip ...]');
const records = [], manifest = [], seeds = [];
const known = {
  'shiguang-atlas': { name: '拾光百科图文', category: '图像与设计', tags: ['科普图文', '小红书', '图像生成'], author: '我的创作', description: '把好奇心，变成值得收藏的知识。按主题队列制作小红书博物志图文，从真实参考图、完整文案到逐页质检，一次完成。' },
  'aibase-daily': { name: 'AIBase 日报', category: '新闻日报' },
  'daily-60s-image': { name: '每日 60 秒新闻图片', category: '新闻日报' },
};
for (const source of sources) {
  const original = await readFile(source);
  const zip = await JSZip.loadAsync(original);
  const entries = Object.values(zip.files).filter(file => !file.dir);
  if (entries.length > 3000) throw new Error('Too many entries');
  for (const file of entries) {
    const originalName = file.unsafeOriginalName || file.name;
    if (/^(?:\/|[a-z]:)/i.test(originalName) || originalName.replaceAll('\\','/').split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe archive path');
  }
  const entry = entries.filter(file => /(^|\/)SKILL\.md$/i.test(file.name));
  if (entry.length !== 1) throw new Error('Each input must contain exactly one SKILL.md');
  const base = entry[0].name.slice(0,-8);
  const content = await entry[0].async('string');
  const parsed = parseSkillMarkdown(content);
  if (records.some(record => record.slug === parsed.slug)) throw new Error('Duplicate Skill');
  const files = [], hashes = [];
  let size = 0;
  for (const file of entries) {
    const bytes = await file.async('uint8array');
    size += bytes.byteLength;
    if (bytes.byteLength > 50 * 1024 * 1024 || size > 200 * 1024 * 1024) throw new Error('Archive exceeds size limits');
    const relative = file.name.startsWith(base) ? file.name.slice(base.length) : file.name;
    if (files.some(f => f.path === relative)) throw new Error('Archive path collision');
    files.push({ path: relative, data: new Blob([bytes]) });
    hashes.push({ path: relative, bytes: bytes.byteLength, sha256: digest(bytes) });
  }
  const usage = files.find(file => file.path === '使用说明.md') || files.find(file => file.path === '使用说明.txt');
  const record = { ...parsed, ...known[parsed.slug], id: `${parsed.slug}-seed`, content, files,
    instructions: usage ? await usage.data.text() : '', favorite: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const destination = path.join(root, 'skills', record.slug);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = path.resolve(destination, file.path);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Target escaped Skill directory');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, /^SKILL\.md$/i.test(file.path) ? getSkillContent(record) : new Uint8Array(await file.data.arrayBuffer()));
  }
  await writeFile(path.join(root, 'dist/assets', `${record.slug}.zip`), original);
  seeds.push({ id: record.id, name: record.name, slug: record.slug, description: record.description, category: record.category, tags: record.tags || [], version: record.version || '1.0.0', author: record.author || '', favorite: false, archiveUrl: `./assets/${record.slug}.zip` });
  manifest.push({ slug: record.slug, name: record.name, category: record.category, originalFileCount: files.length, originalArchiveSha256: digest(original), archive: `dist/assets/${record.slug}.zip`, files: hashes });
  records.push(record);
}
await writeFile(path.join(root, 'dist/assets/seed.json'), JSON.stringify(seeds, null, 2) + '\n');
await mkdir(path.join(root, 'backups'), { recursive: true });
await writeFile(path.join(root, 'backups/skill-cabinet-starter.zip'), new Uint8Array(await (await exportLibrary(records)).arrayBuffer()));
await writeFile(path.join(root, 'docs/skill-catalog.json'), JSON.stringify({ schemaVersion: 1, note: 'Assembled from complete source bundles; names and categories verified against the application. Browser-specific IDs and original edit timestamps are not exported.', skills: manifest }, null, 2) + '\n');
console.log(JSON.stringify({ skills: manifest.map(({slug, originalFileCount})=>({slug,files:originalFileCount})), totalFiles:manifest.reduce((n,s)=>n+s.originalFileCount,0) }));
