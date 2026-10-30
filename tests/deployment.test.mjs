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
  assert.equal(built.skills, 34);
  assert.equal(built.splitArchives, 8);
  for (const entry of Object.values(deployed.entries)) {
    if (entry.deleted) continue;
    const bytes = await readRepositoryArchive(entry, deployed.hosting, async name => new Response(await readFile(path.join(built.output, name))));
    assert.equal(hash(new Uint8Array(bytes)), entry.archiveSha256);
  }
  assert.match(await readFile(path.join(built.output, 'index.html'), 'utf8'), /<meta name="skill-cabinet-hosting" content="static">/);
  assert.deepEqual(JSON.parse(await readFile(path.join(built.output, 'skill-cabinet/prompts.json'), 'utf8')), JSON.parse(await readFile(path.join(root, 'skill-cabinet/prompts.json'), 'utf8')));
  const projects = JSON.parse(await readFile(path.join(built.output, 'assets/github-projects.json'), 'utf8'));
  assert.equal(projects.projects.length, 9);
  const names = (await files(built.output)).map(file => path.relative(built.output, file).replaceAll('\\', '/'));
  assert.ok(names.every(name => !/^(.git\/|test-results\/|skills\/|server\.mjs$|\.env)/.test(name)));
  const activeNames = new Set(Object.values(deployed.entries).filter(entry => !entry.deleted).flatMap(entry => deployed.hosting.archiveParts[entry.archivePath] || [entry.archivePath]));
  assert.deepEqual(names.filter(name => name.startsWith('skill-cabinet/archives/')).sort(), [...activeNames].sort());
  for (const name of names) assert.ok((await stat(path.join(built.output, name))).size <= (name.startsWith('skill-cabinet/archives/') ? 2_000_000 : 25_000_000), name);
  for (const entry of Object.values(deployed.entries).filter(entry => !entry.deleted)) {
    assert.equal(deployed.hosting.archiveSizes[entry.archivePath], (await stat(path.join(root, entry.archivePath))).size);
    for (const name of deployed.hosting.archiveParts[entry.archivePath] || []) assert.equal(deployed.hosting.archivePartHashes[name], hash(await readFile(path.join(built.output, name))));
  }
  const config = JSON.parse(await readFile(path.join(root, 'edgeone.json'), 'utf8'));
  assert.equal(config.outputDirectory, path.relative(root, built.output).replaceAll('\\', '/'));
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.rewrites, undefined, 'missing APIs must never fall back to HTML');
});

function splitFixture() {
  const bytes = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const checksum = hash(Buffer.concat(bytes));
  const entry = { archivePath: `skill-cabinet/archives/test-${checksum}.zip`, archiveSha256: checksum, metadata: { name: 'Test' } };
  const paths = bytes.map((_, i) => `${entry.archivePath}.part-${i}`);
  const hosting = { archiveParts: { [entry.archivePath]: paths }, archivePartHashes: Object.fromEntries(paths.map((name, i) => [name, hash(bytes[i])])), archiveSizes: { [entry.archivePath]: 4 } };
  const cached = new Map();
  const cache = { get: async key => cached.get(key), put: async (key, value) => cached.set(key, value), delete: async key => cached.delete(key) };
  return { bytes, entry, paths, hosting, cached, cache };
}

test('verified download parts survive a later interruption and a fresh loader resumes from cache', async () => {
  const f = splitFixture(), reads = [];
  let offline = true;
  const read = async name => {
    reads.push(name);
    if (name === f.paths[1] && offline) throw new TypeError('Connection closed');
    return new Response(f.bytes[f.paths.indexOf(name)]);
  };
  await assert.rejects(readRepositoryArchive(f.entry, f.hosting, read, { cache: f.cache }), /Connection closed/);
  offline = false;
  const progress = [];
  const result = await readRepositoryArchive(f.entry, f.hosting, read, { cache: f.cache, onProgress: event => progress.push(event) });
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
  assert.equal(reads.filter(name => name === f.paths[0]).length, 1);
  assert.equal(progress.at(-1).loaded, 4);
  assert.equal(progress.at(-1).totalBytes, 4);
  assert.ok(progress.some(event => event.cached));
});

test('corrupt cached bytes are discarded and retried network fragments must pass their own digest', async () => {
  const f = splitFixture();
  await readRepositoryArchive(f.entry, f.hosting, name => Promise.resolve(new Response(f.bytes[f.paths.indexOf(name)])), { cache: f.cache });
  for (const key of f.cached.keys()) f.cached.set(key, new Uint8Array([9, 9]).buffer);
  const reads = new Map();
  const result = await readRepositoryArchive(f.entry, f.hosting, async name => {
    const count = (reads.get(name) || 0) + 1; reads.set(name, count);
    return new Response(count === 1 ? new Uint8Array([8, 8]) : f.bytes[f.paths.indexOf(name)]);
  }, { cache: f.cache, attempts: 2, retryDelay: 0 });
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
  assert.equal(reads.get(f.paths[0]), 2);
  assert.equal(reads.get(f.paths[1]), 2);
});

test('stalled response bodies time out, cancel their stream and retry only that fragment', async () => {
  const f = splitFixture(); let reads = 0, cancelled = false;
  const result = await readRepositoryArchive(f.entry, f.hosting, async name => {
    reads++;
    if (reads === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }));
    return new Response(f.bytes[f.paths.indexOf(name)]);
  }, { attempts: 2, retryDelay: 0, idleTimeout: 10 });
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});

test('active slow downloads reset the inactivity timeout while receiving bytes', async () => {
  const f = splitFixture(); let reads = 0;
  const result = await readRepositoryArchive(f.entry, f.hosting, async name => {
    reads++;
    const bytes = f.bytes[f.paths.indexOf(name)]; let offset = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset)); else controller.close();
    } }));
  }, { idleTimeout: 40 });
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
  assert.equal(reads, 2);
});

test('missing files are not retried and cache failures do not prevent a verified download', async () => {
  const f = splitFixture(); let reads = 0;
  await assert.rejects(readRepositoryArchive(f.entry, f.hosting, async () => { reads++; return new Response('', { status: 404 }); }, { attempts: 3, retryDelay: 0 }), /无法读取/);
  assert.equal(reads, 1);
  const unavailableCache = Object.fromEntries(['get', 'put', 'delete'].map(name => [name, async () => { throw Error('Storage disabled'); }]));
  const result = await readRepositoryArchive(f.entry, f.hosting, name => Promise.resolve(new Response(f.bytes[f.paths.indexOf(name)])), { cache: unavailableCache });
  assert.deepEqual([...new Uint8Array(result)], [1, 2, 3, 4]);
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
