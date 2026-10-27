import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildSite } from '../scripts/build-site.mjs';
import { readRepositoryArchive } from '../dist/hosting.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}

test('production output includes every current skill and catalog, preserves hashes, and fits EdgeOne limits', async () => {
  const built = await buildSite();
  const original = JSON.parse(await readFile(path.join(root, 'skill-cabinet/manifest.json'), 'utf8'));
  const deployed = JSON.parse(await readFile(path.join(built.output, 'skill-cabinet/manifest.json'), 'utf8'));
  assert.deepEqual(deployed.entries, original.entries);
  assert.deepEqual(deployed.categories, original.categories);
  assert.equal(built.skills, Object.values(original.entries).filter(entry => !entry.deleted).length);
  assert.equal(built.skills, 26);
  assert.equal(built.splitArchives, 2);
  for (const entry of Object.values(deployed.entries)) {
    if (entry.deleted) continue;
    const bytes = await readRepositoryArchive(entry, deployed.hosting, async name => new Response(await readFile(path.join(built.output, name))));
    assert.equal(hash(new Uint8Array(bytes)), entry.archiveSha256);
  }
  assert.match(await readFile(path.join(built.output, 'index.html'), 'utf8'), /<meta name="skill-cabinet-hosting" content="static">/);
  assert.deepEqual(JSON.parse(await readFile(path.join(built.output, 'skill-cabinet/prompts.json'), 'utf8')), JSON.parse(await readFile(path.join(root, 'skill-cabinet/prompts.json'), 'utf8')));
  const projects = JSON.parse(await readFile(path.join(built.output, 'assets/github-projects.json'), 'utf8'));
  assert.equal(projects.projects.length, 7);
  const names = (await files(built.output)).map(file => path.relative(built.output, file).replaceAll('\\', '/'));
  assert.ok(names.every(name => !/^(.git\/|test-results\/|skills\/|server\.mjs$|\.env)/.test(name)));
  const activeNames = new Set(Object.values(deployed.entries).filter(entry => !entry.deleted).flatMap(entry => deployed.hosting.archiveParts[entry.archivePath] || [entry.archivePath]));
  assert.deepEqual(names.filter(name => name.startsWith('skill-cabinet/archives/')).sort(), [...activeNames].sort());
  for (const name of names) assert.ok((await stat(path.join(built.output, name))).size <= 25_000_000, name);
  const config = JSON.parse(await readFile(path.join(root, 'edgeone.json'), 'utf8'));
  assert.equal(config.outputDirectory, path.relative(root, built.output).replaceAll('\\', '/'));
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.rewrites, undefined, 'missing APIs must never fall back to HTML');
});

test('a corrupt input archive fails the build before replacing the previous successful output', async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'cabinet-deploy-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'skill-cabinet/archives'), { recursive: true });
  await mkdir(path.join(fixture, 'dist'));
  await mkdir(path.join(fixture, 'build/site'), { recursive: true });
  await writeFile(path.join(fixture, 'dist/index.html'), '<head></head>');
  const slug = 'bad-package', checksum = 'a'.repeat(64), archivePath = `skill-cabinet/archives/${slug}-${checksum}.zip`;
  await writeFile(path.join(fixture, archivePath), 'broken');
  await writeFile(path.join(fixture, 'skill-cabinet/manifest.json'), JSON.stringify({ schemaVersion: 1, entries: { [slug]: { fingerprint: checksum, archiveSha256: checksum, archivePath, metadata: { slug, name: 'Bad package' } } } }));
  await writeFile(path.join(fixture, 'build/site/previous.txt'), 'keep');
  await assert.rejects(buildSite(fixture), /Invalid archive/);
  assert.equal(await readFile(path.join(fixture, 'build/site/previous.txt'), 'utf8'), 'keep');
});

test('split archive loading rejects missing fragments, external paths and excess data', async () => {
  const entry = { archivePath: `skill-cabinet/archives/test-${'a'.repeat(64)}.zip`, metadata: { name: 'Test' } };
  const parts = [`${entry.archivePath}.part-0`, `${entry.archivePath}.part-1`];
  const hosting = { archiveParts: { [entry.archivePath]: parts } };
  const combined = await readRepositoryArchive(entry, hosting, async name => new Response(new Uint8Array(name.endsWith('0') ? [1, 2] : [3, 4])));
  assert.deepEqual([...new Uint8Array(combined)], [1, 2, 3, 4]);
  await assert.rejects(readRepositoryArchive(entry, hosting, async () => new Response('', { status: 404 })), /无法读取/);
  await assert.rejects(readRepositoryArchive(entry, { archiveParts: { [entry.archivePath]: ['https://example.com/secret', parts[1]] } }, async () => assert.fail('unsafe paths must not be fetched')), /分片清单无效/);
  await assert.rejects(readRepositoryArchive(entry, hosting, async () => new Response(new Uint8Array(20_000_001))), /大小限制/);
});
