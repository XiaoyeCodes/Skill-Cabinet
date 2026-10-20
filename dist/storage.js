const DB_NAME = 'personal-skill-library';
const MAX_ENTRIES = 3000;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
let databasePromise;
let initializationPromise;

const now = () => new Date().toISOString();
const uuid = () => globalThis.crypto?.randomUUID?.() || `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const slugify = value => {
  const name = String(value || '').normalize('NFKC').trim();
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error('技能名称至少需要包含一个文字或数字。');
  if (/[^\x00-\x7f]/.test(name)) {
    // A name-based suffix makes repeated imports resolve to the same identifier.
    let hash = 2166136261;
    for (const character of name) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return `skill-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
};
const errorMessage = error => error?.message || String(error);
const zipEngine = () => {
  const engine = globalThis.JSZip || globalThis.window?.JSZip;
  if (!engine) throw new Error('ZIP 引擎未加载，请刷新页面后重试。');
  return engine;
};

function safePath(value) {
  const path = String(value || '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f]/.test(path) || path.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`压缩包包含不安全的路径：${String(value).slice(0, 100)}`);
  }
  return path;
}

function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('浏览器不支持 IndexedDB，无法保存技能。请使用支持本地存储的浏览器。')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const skills = db.createObjectStore('skills', { keyPath: 'id' });
      skills.createIndex('slug', 'slug', { unique: true });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; };
      resolve(request.result);
    };
    request.onerror = () => reject(new Error(`本地数据库无法打开：${request.error?.message || '请检查浏览器存储权限'}`));
    request.onblocked = () => reject(new Error('本地数据库被其他页面占用，请关闭旧页面后重试。'));
  }).catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

async function operation(storeName, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    let result;
    let transaction;
    try {
      transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => {};
    } catch (error) { reject(new Error(`本地存储操作失败：${errorMessage(error)}`)); return; }
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => {
      const duplicate = transaction.error?.name === 'ConstraintError';
      reject(new Error(duplicate ? '已存在相同标识的技能，请修改技能名称或标识后重试。' : `本地保存失败：${transaction.error?.message || '浏览器存储空间不足或权限受限'}`));
    };
  });
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) { try { return JSON.parse(text); } catch { return text.replace(/^"|"$/g, ''); } }
  if (text.startsWith("'")) return text.replace(/^'|'$/g, '').replace(/''/g, "'");
  return text.replace(/\s+#.*$/, '').trim();
}

function frontmatter(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  return { raw: match?.[1] || '', body: match ? normalized.slice(match[0].length) : normalized, normalized };
}

export function parseSkillMarkdown(text) {
  const { raw, body, normalized } = frontmatter(text);
  const metadata = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (/^[>|][-+]?\s*$/.test(value)) {
      const chunks = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1])) chunks.push(lines[++i].replace(/^\s{1,2}/, ''));
      metadata[key] = chunks.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else metadata[key] = scalar(value);
  }
  let tags = metadata.tags || [];
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { tags = tags.replace(/^\[|\]$/g, '').split(/[,，]/).map(item => scalar(item)); }
  }
  const name = String(metadata.display_name || body.match(/^#\s+(.+)$/m)?.[1] || metadata.name || '').trim();
  return {
    name, slug: slugify(metadata.name || metadata.slug || name), description: String(metadata.description || ''), category: String(metadata.category || '未分类'),
    version: String(metadata.version || '1.0.0'), author: String(metadata.author || ''),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [], content: normalized.trim(),
  };
}

function normalizeRecord(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('技能数据格式无效。');
  const name = String(input.name || '').trim();
  const content = String(input.content || '').trim();
  if (!name) throw new Error('技能名称不能为空。');
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error('技能名称至少需要包含一个文字或数字。');
  if (!content) throw new Error('SKILL.md 内容不能为空。');
  const slug = input.slug ? String(input.slug).trim().toLowerCase() : slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) throw new Error('技能标识必须以英文或数字开头，且只能包含英文、数字、短横线和下划线。');
  const timestamp = now();
  const files = input.files ?? previous?.files ?? [];
  if (!Array.isArray(files)) throw new Error('技能文件列表格式无效。');
  if (files.length > MAX_ENTRIES) throw new Error('技能文件数量超过限制。');
  let total = 0;
  for (const file of files) {
    safePath(file.path);
    if (!(file.data instanceof Blob)) throw new Error(`技能文件数据无效：${file.path}`);
    if (file.data.size > MAX_FILE) throw new Error(`文件超过 50 MB：${file.path}`);
    total += file.data.size;
  }
  if (total > MAX_TOTAL) throw new Error('技能文件总大小超过 200 MB。');
  return {
    id: String(input.id || previous?.id || uuid()), name, slug,
    description: String(input.description || ''), category: String(input.category || '未分类'),
    tags: Array.isArray(input.tags) ? input.tags.map(String).map(tag => tag.trim()).filter(Boolean) : [],
    version: String(input.version || '1.0.0'), author: String(input.author || ''),
    instructions: String(input.instructions || ''), content, favorite: Boolean(input.favorite),
    createdAt: input.createdAt || previous?.createdAt || timestamp, updatedAt: input.updatedAt || timestamp, files,
  };
}

export async function listSkills() {
  return operation('skills', 'readonly', store => store.getAll());
}

export async function saveSkill(input) {
  const previous = input?.id ? await operation('skills', 'readonly', store => store.get(input.id)) : undefined;
  const record = normalizeRecord(input, previous);
  const duplicate = await operation('skills', 'readonly', store => store.index('slug').get(record.slug));
  if (duplicate && duplicate.id !== record.id) throw new Error(`已存在标识为「${record.slug}」的技能，未覆盖原有内容。`);
  await operation('skills', 'readwrite', store => store.put(record));
  return record;
}

export async function deleteSkill(id) {
  await operation('skills', 'readwrite', store => store.delete(id));
}

async function loadZip(data) {
  if ((data.size ?? data.byteLength ?? 0) > MAX_TOTAL) throw new Error('ZIP 文件超过 200 MB 限制。');
  const JSZip = zipEngine();
  const zip = await JSZip.loadAsync(data instanceof Blob ? await data.arrayBuffer() : data);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error('ZIP 条目超过 3000 个限制。');
  let total = 0;
  for (const entry of entries) {
    safePath(entry.unsafeOriginalName || entry.name);
    safePath(entry.name);
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize;
    if (size > MAX_FILE) throw new Error(`文件超过 50 MB：${entry.name}`);
    total += Number(size) || 0;
  }
  if (total > MAX_TOTAL) throw new Error('ZIP 解压后超过 200 MB 限制。');
  return zip;
}

async function readEntry(entry, budget) {
  const bytes = await entry.async('uint8array');
  if (bytes.byteLength > MAX_FILE) throw new Error(`文件超过 50 MB：${entry.name}`);
  budget.size += bytes.byteLength;
  if (budget.size > MAX_TOTAL) throw new Error('ZIP 解压后超过 200 MB 限制。');
  return new Blob([bytes]);
}

async function recordsFromZip(zip) {
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const roots = entries.filter(entry => /(^|\/)SKILL\.md$/i.test(entry.name)).map(entry => ({ entry, base: entry.name.slice(0, -8) }));
  if (!roots.length) throw new Error('ZIP 中未找到 SKILL.md。');
  const budget = { size: 0 };
  const decoded = new Map();
  for (const entry of entries) decoded.set(entry.name, await readEntry(entry, budget));
  const records = [];
  for (const root of roots) {
    const files = [];
    for (const entry of entries) {
      const owners = roots.filter(candidate => entry.name.startsWith(candidate.base)).sort((a, b) => b.base.length - a.base.length);
      if (owners.length && owners[0] !== root) continue;
      const path = entry.name.startsWith(root.base) ? entry.name.slice(root.base.length) : entry.name;
      if (files.some(file => file.path === path)) throw new Error(`技能文件路径冲突：${path}`);
      files.push({ path: safePath(path), data: decoded.get(entry.name) });
    }
    const markdown = await decoded.get(root.entry.name).text();
    const parsed = parseSkillMarkdown(markdown);
    const instructions = files.find(file => /(^|\/)使用说明\.md$/i.test(file.path));
    records.push(normalizeRecord({ ...parsed, files, instructions: instructions ? await instructions.data.text() : '' }));
  }
  return records;
}

async function unpackBackup(zip) {
  const metadata = JSON.parse(await zip.file('library.json').async('string'));
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.skills)) throw new Error('备份格式或版本不受支持。');
  if (metadata.skills.length > MAX_ENTRIES) throw new Error('备份技能数量超过限制。');
  const records = [];
  for (const skill of metadata.skills) {
    const archivePath = safePath(skill.archivePath);
    const entry = zip.file(archivePath);
    if (!entry) throw new Error(`备份缺少技能包：${archivePath}`);
    const inner = await loadZip(await entry.async('uint8array'));
    const parsed = await recordsFromZip(inner);
    if (parsed.length !== 1) throw new Error(`备份技能包必须包含一个技能：${archivePath}`);
    records.push(normalizeRecord({ ...parsed[0], ...skill, files: parsed[0].files }));
  }
  return records;
}

export async function importFiles(files) {
  const result = { imported: [], skipped: [], errors: [] };
  for (const file of Array.from(files || [])) {
    const name = file.name || '导入文件';
    try {
      if (file.size > MAX_TOTAL) throw new Error('导入文件超过 200 MB 限制。');
      let candidates;
      if (/\.zip$/i.test(name)) {
        const zip = await loadZip(file);
        candidates = zip.file('library.json') ? await unpackBackup(zip) : await recordsFromZip(zip);
      } else if (/\.md$/i.test(name)) {
        const text = await file.text();
        candidates = [normalizeRecord({ ...parseSkillMarkdown(text), files: [{ path: 'SKILL.md', data: file }] })];
      } else if (/\.json$/i.test(name)) {
        const json = JSON.parse(await file.text());
        const items = Array.isArray(json) ? json : Array.isArray(json.skills) ? json.skills : [json];
        candidates = items.map(item => normalizeRecord({ ...item, files: [] }));
      } else throw new Error('支持导入 ZIP 技能包、Markdown 和 JSON。');
      for (const candidate of candidates) {
        const existing = await operation('skills', 'readonly', store => store.index('slug').get(candidate.slug));
        const existingId = await operation('skills', 'readonly', store => store.get(candidate.id));
        if (existing || existingId) { result.skipped.push({ name: candidate.name, reason: '技能标识已存在，保留原有内容。' }); continue; }
        try { result.imported.push(await saveSkill(candidate)); }
        catch (error) { result.errors.push({ name: candidate.name, message: errorMessage(error) }); }
      }
    } catch (error) { result.errors.push({ name, message: errorMessage(error) }); }
  }
  return result;
}

export function getSkillContent(input) {
  const record = normalizeRecord(input);
  const { raw, body } = frontmatter(record.content);
  const lines = raw.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^(name|display_name|description|version|author|tags|category):/.test(lines[i])) {
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || !lines[i + 1])) i++;
    } else if (lines[i]) kept.push(lines[i]);
  }
  const metadata = { name: record.slug, display_name: record.name, description: record.description, version: record.version, author: record.author, tags: record.tags, category: record.category };
  const fields = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${[...fields, ...kept].join('\n')}\n---\n\n${body.trim()}\n`;
}

export async function exportSkill(input) {
  const record = normalizeRecord(input);
  const JSZip = zipEngine();
  const zip = new JSZip();
  for (const file of record.files) {
    const path = safePath(file.path);
    if (path.toLowerCase() === 'skill.md' || path === '使用说明.md') continue;
    zip.file(path, await file.data.arrayBuffer());
  }
  zip.file('SKILL.md', getSkillContent(record));
  zip.file('使用说明.md', record.instructions);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Blob([bytes], { type: 'application/zip' });
}

export async function exportLibrary(records) {
  const JSZip = zipEngine();
  const zip = new JSZip();
  const skills = [];
  const identifiers = new Set();
  for (const input of records || await listSkills()) {
    const record = normalizeRecord(input);
    if (identifiers.has(record.id)) throw new Error('备份包含重复技能 ID。');
    identifiers.add(record.id);
    const archivePath = safePath(`skills/${encodeURIComponent(record.id)}.zip`);
    zip.file(archivePath, await (await exportSkill(record)).arrayBuffer());
    const { files, ...metadata } = record;
    skills.push({ ...metadata, archivePath });
  }
  zip.file('library.json', JSON.stringify({ schemaVersion: 1, exportedAt: now(), skills }, null, 2));
  return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type: 'application/zip' });
}

export async function initialize() {
  if (!initializationPromise) initializationPromise = (async () => {
    const initialized = await operation('meta', 'readonly', store => store.get('initialized'));
    if (!initialized) {
      const response = await fetch('./assets/seed.json');
      if (!response.ok) throw new Error(`初始技能无法加载（${response.status}）。`);
      const json = await response.json();
      const seeds = Array.isArray(json) ? json : Array.isArray(json.skills) ? json.skills : [json];
      for (const seed of seeds) {
        let base = {};
        if (seed.archiveUrl) {
          const archive = await fetch(seed.archiveUrl);
          if (!archive.ok) throw new Error('初始技能包无法加载。');
          const records = await recordsFromZip(await loadZip(await archive.blob()));
          if (records.length !== 1) throw new Error('初始技能包必须包含一个 SKILL.md。');
          base = records[0];
        }
        const record = normalizeRecord({ ...base, ...seed, files: base.files || [] });
        const existing = await operation('skills', 'readonly', store => store.index('slug').get(record.slug));
        if (!existing) await saveSkill(record);
      }
      await operation('meta', 'readwrite', store => store.put({ key: 'initialized', value: true }));
    }
    return listSkills();
  })().catch(error => { initializationPromise = undefined; throw error; });
  await initializationPromise;
  return listSkills();
}

export function formatBytes(number) {
  const bytes = Math.max(0, Number(number) || 0);
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** index).toFixed(index ? 1 : 0))} ${units[index]}`;
}
