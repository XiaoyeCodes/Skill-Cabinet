import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { emptyCatalog, validateCatalog } from './dist/prompts.js';

export async function readPrompts(repositoryRoot) {
  let catalog;
  try { catalog = validateCatalog(JSON.parse(await readFile(path.join(repositoryRoot, 'skill-cabinet/prompts.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; catalog = emptyCatalog(); }
  return { catalog, revision: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') };
}
export async function writePrompts(repositoryRoot, value) {
  const catalog = validateCatalog(value?.catalog), current = await readPrompts(repositoryRoot);
  if (value.expectedRevision !== current.revision) return { conflict: true, ...current };
  const file = path.join(repositoryRoot, 'skill-cabinet/prompts.json'), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', 'utf8'); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  return { catalog, revision: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') };
}
