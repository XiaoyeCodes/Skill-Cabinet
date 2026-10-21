import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mergeCategories } from './dist/categories.js';
import { validateManifest } from './dist/github-client.js';

export async function writeRepositoryCategories(manifestPath, names) {
  // Read the latest document for every write and retain the skill entries and extensions.
  for (let attempt = 0; attempt < 3; attempt++) {
    const original = await readFile(manifestPath, 'utf8');
    const document = JSON.parse(original);
    const current = validateManifest(document).categories || [];
    const categories = mergeCategories(current, names);
    if (JSON.stringify(current) === JSON.stringify(categories)) return categories;
    validateManifest({ ...document, categories });
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ ...document, categories }, null, 2)}\n`, { flag: 'wx' });
      if (await readFile(manifestPath, 'utf8') !== original) continue;
      await rename(temporary, manifestPath);
      return categories;
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  throw new Error('仓库正在更新，分类会稍后自动重试保存。');
}
