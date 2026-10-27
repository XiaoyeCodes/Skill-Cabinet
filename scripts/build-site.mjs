import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../dist/github-client.js';
import { readPrompts } from '../repository-prompts.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const MAX_FILE_BYTES = 25_000_000;
const CHUNK_BYTES = 2_000_000;

async function checkAssets(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw Error(`Deployment assets cannot contain symbolic links: ${file}`);
    if (item.isDirectory()) await checkAssets(file);
    else if (!item.isFile() || (await stat(file)).size > MAX_FILE_BYTES) throw Error(`Deployment asset exceeds the 25 MB limit: ${file}`);
  }
}

export async function buildSite(repositoryRoot = root) {
  const base = path.resolve(repositoryRoot);
  // Only this dedicated, generated directory can be removed by the build.
  const output = path.resolve(base, 'build', 'site');
  if (!output.startsWith(base + path.sep) || output !== path.join(base, 'build', 'site')) throw Error('Unsafe build output path');
  const raw = JSON.parse(await readFile(path.join(base, 'skill-cabinet/manifest.json'), 'utf8'));
  const manifest = validateManifest(raw);
  const prompts = await readPrompts(base);
  await checkAssets(path.join(base, 'dist'));
  // Validate inputs before replacing the previous successful build.
  const archives = [];
  for (const entry of Object.values(manifest.entries)) {
    if (entry.deleted) continue;
    const bytes = await readFile(path.join(base, entry.archivePath));
    if (bytes.length > 45 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== entry.archiveSha256) throw Error(`Invalid archive: ${entry.archivePath}`);
    archives.push({ entry, bytes });
  }
  await rm(output, { recursive: true, force: true });
  await cp(path.join(base, 'dist'), output, { recursive: true });
  await mkdir(path.join(output, 'skill-cabinet/archives'), { recursive: true });
  const archiveParts = {}, archivePartHashes = {}, archiveSizes = {};
  for (const { entry, bytes } of archives) {
    archiveSizes[entry.archivePath] = bytes.length;
    if (bytes.length <= CHUNK_BYTES) await writeFile(path.join(output, entry.archivePath), bytes);
    else {
      const parts = [];
      for (let start = 0, index = 0; start < bytes.length; start += CHUNK_BYTES, index++) {
        const name = `${entry.archivePath}.part-${index}`;
        const part = bytes.subarray(start, start + CHUNK_BYTES);
        await writeFile(path.join(output, name), part);
        archivePartHashes[name] = createHash('sha256').update(part).digest('hex');
        parts.push(name);
      }
      archiveParts[entry.archivePath] = parts;
    }
  }
  await writeFile(path.join(output, 'skill-cabinet/manifest.json'), JSON.stringify({ ...manifest, hosting: { archiveParts, archivePartHashes, archiveSizes } }, null, 2) + '\n');
  await writeFile(path.join(output, 'skill-cabinet/prompts.json'), JSON.stringify(prompts.catalog, null, 2) + '\n');
  if (manifest.projects) {
    await writeFile(path.join(output, 'assets/github-projects.json'), JSON.stringify({ schemaVersion: 1, projects: Object.values(manifest.projects).filter(entry => !entry.deleted).map(entry => entry.record) }, null, 2) + '\n');
  }
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  if (!html.includes('<head>')) throw Error('Missing HTML head');
  await writeFile(path.join(output, 'index.html'), html.replace('<head>', '<head>\n  <meta name="skill-cabinet-hosting" content="static">'));
  // A real 404 prevents missing JSON or archive URLs from returning the app HTML.
  await writeFile(path.join(output, '404.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面不存在</title><h1>页面不存在</h1><a href="/">返回 Skill Cabinet</a></html>');
  await checkAssets(output);
  return { output, skills: archives.length, projects: Object.values(manifest.projects || {}).filter(entry => !entry.deleted).length, prompts: prompts.catalog.prompts.length, splitArchives: Object.keys(archiveParts).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildSite(), null, 2));
}
