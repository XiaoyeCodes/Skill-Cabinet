export const PROMPTS_KEY = 'skill-cabinet-prompts-v1';
export const PROMPT_CATEGORIES = ['写作与内容', '图像与设计', '开发与工具', '效率与工作', '学习与研究'];
export const emptyCatalog = () => ({ schemaVersion: 1, categories: [], prompts: [] });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function text(value, limit, label, required = false, preserve = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error(`${label}为空、过长或格式无效。`);
  return preserve ? value : value.trim();
}
export function validatePrompt(value) {
  if (!value || typeof value !== 'object' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id || '')) throw Error('提示词标识无效。');
  if (!Array.isArray(value.tags) || value.tags.length > 8) throw Error('标签最多 8 个。');
  for (const key of ['createdAt', 'updatedAt']) if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) throw Error('提示词日期无效。');
  let source = text(value.source ?? '', 2048, '来源链接');
  if (source) {
    let url; try { url = new URL(source); } catch { throw Error('请填写完整的 http 或 https 来源链接。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('来源链接只支持 http 和 https。');
    source = url.href;
  }
  return { id: value.id, title: text(value.title, 120, '提示词标题', true), description: text(value.description ?? '', 2000, '用途说明'),
    category: text(value.category, 30, '分类', true), tags: [...new Set(value.tags.map(tag => text(tag, 40, '标签', true)))],
    content: text(value.content, 100000, '提示词正文', true, true), source, favorite: value.favorite === true, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export function validateCatalog(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.prompts) || value.prompts.length > 500 || !Array.isArray(value.categories) || value.categories.length > 100) throw Error('提示词数据格式无效，最多收录 500 条、100 个分类。');
  const prompts = value.prompts.map(validatePrompt);
  if (new Set(prompts.map(item => item.id)).size !== prompts.length) throw Error('提示词数据中存在重复标识。');
  const categories = [...new Set([...value.categories.map(name => text(name, 30, '分类', true)), ...prompts.map(item => item.category)])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (categories.length > 100) throw Error('分类不能超过 100 个。');
  const result = { schemaVersion: 1, categories, prompts: prompts.sort((a, b) => a.id.localeCompare(b.id, 'en')) };
  if (JSON.stringify(result).length > 1500000) throw Error('提示词库超过保存上限，请先导出备份再整理。');
  return result;
}
export function mergeCatalog(base, local, remote, choice) {
  const maps = [base, local, remote].map(catalog => new Map(catalog.prompts.map(item => [item.id, item])));
  const prompts = [], conflicts = [];
  for (const id of new Set(maps.flatMap(map => [...map.keys()]))) {
    const [b, l, r] = maps.map(map => map.get(id));
    const conflict = !equal(l, b) && !equal(r, b) && !equal(l, r);
    if (conflict) conflicts.push({ id, title: l?.title || r?.title || b?.title });
    const chosen = conflict ? (choice === 'remote' ? r : l) : equal(l, b) ? r : l;
    if (chosen) prompts.push(chosen);
  }
  return { catalog: validateCatalog({ schemaVersion: 1, prompts, categories: [...new Set([...local.categories, ...remote.categories])] }), conflicts };
}
export class PromptStore {
  constructor(storage = globalThis.localStorage) { this.storage = storage; }
  read() {
    const raw = this.storage.getItem(PROMPTS_KEY);
    if (!raw) return { catalog: emptyCatalog(), base: emptyCatalog(), revision: null };
    try {
      const state = JSON.parse(raw);
      return { ...state, catalog: validateCatalog(state.catalog), base: validateCatalog(state.base) };
    } catch { throw Error('提示词本地数据无法读取，原始数据已保留，请先备份浏览器数据。'); }
  }
  write(state) {
    const catalog = validateCatalog(state.catalog), base = validateCatalog(state.base);
    try { this.storage.setItem(PROMPTS_KEY, JSON.stringify({ ...state, catalog, base })); }
    catch { throw Error('浏览器空间不足或禁止保存，请先复制正文或导出备份。'); }
  }
  list() { return this.read().catalog.prompts; }
  save(value, expected = null) {
    const state = this.read(), current = state.catalog.prompts.find(item => item.id === value.id);
    if (!equal(current ?? null, expected ? validatePrompt(expected) : null)) throw Error('这条提示词已在其他页面或仓库中更新，请复制当前正文后重新打开编辑。');
    const record = validatePrompt(value);
    state.catalog.prompts = [...state.catalog.prompts.filter(item => item.id !== record.id), record];
    this.write(state); return record;
  }
  remove(id, expected) {
    const state = this.read(), current = state.catalog.prompts.find(item => item.id === id);
    if (!equal(current, validatePrompt(expected))) throw Error('内容已变化，请重新确认后移除。');
    state.removed = current;
    state.catalog.prompts = state.catalog.prompts.filter(item => item.id !== id); this.write(state);
  }
  addCategory(name) {
    const state = this.read(); state.catalog.categories.push(text(name, 30, '分类', true)); this.write(state);
  }
  undoRemove() {
    const state = this.read(); if (!state.removed) return;
    if (state.catalog.prompts.some(item => item.id === state.removed.id)) throw Error('该提示词已存在，请先导出备份后整理。');
    state.catalog.prompts.push({ ...state.removed, updatedAt: new Date().toISOString() }); delete state.removed; this.write(state);
  }
  exportBackup() { return { type: 'skill-cabinet-prompts', exportedAt: new Date().toISOString(), ...this.read().catalog }; }
  importBackup(value) {
    if (value?.type !== 'skill-cabinet-prompts') throw Error('请选择「提示词收录」导出的备份 JSON。');
    const incoming = validateCatalog(value), state = this.read(), ids = new Set(state.catalog.prompts.map(item => item.id));
    let added = 0;
    for (const item of incoming.prompts) if (!ids.has(item.id)) { state.catalog.prompts.push(item); ids.add(item.id); added++; }
    state.catalog.categories = [...new Set([...state.catalog.categories, ...incoming.categories])]; this.write(state); return added;
  }
}

export class PromptRepository {
  constructor(store, fetchImpl = (...args) => fetch(...args)) { this.store = store; this.fetch = fetchImpl; this.busy = false; }
  async refresh(choice) {
    if (this.busy) return { busy: true };
    this.busy = true;
    try {
      const response = await this.fetch('./api/prompts', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('本机仓库暂不可用，提示词仍保存在浏览器；可导出备份。');
      const remote = await response.json(), catalog = validateCatalog(remote.catalog), state = this.store.read();
      const merged = mergeCatalog(state.base, state.catalog, catalog, choice);
      const conflictVersion = JSON.stringify([state.base, state.catalog, remote.revision]);
      if (merged.conflicts.length && (!['local', 'remote'].includes(choice) || this.conflictVersion !== conflictVersion)) {
        const stale = Boolean(choice); this.conflictVersion = conflictVersion;
        return { conflicts: merged.conflicts, stale };
      }
      this.conflictVersion = null;
      if (merged.conflicts.length) state.recovery = state.catalog;
      // Save fetched content before writing; unsent edits survive network errors and reloads.
      this.store.write({ ...state, catalog: merged.catalog, base: catalog, revision: remote.revision });
      if (!equal(merged.catalog, catalog)) {
        const expected = JSON.stringify(this.store.read());
        const saved = await this.fetch('./api/prompts', { method: 'PUT', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ catalog: merged.catalog, expectedRevision: remote.revision }) });
        if (saved.status === 409) throw Error('仓库刚有新修改，稍后会重新比较，当前内容已保留。');
        if (!saved.ok) throw Error('尚未写入项目文件，内容已保存在浏览器，稍后自动重试。');
        const result = await saved.json(), latest = this.store.read();
        // A user may edit while PUT is in flight; update only the baseline in that case.
        this.store.write({ ...latest, base: validateCatalog(result.catalog), revision: result.revision,
          catalog: JSON.stringify(latest) === expected ? validateCatalog(result.catalog) : latest.catalog });
      }
      const latest = this.store.read();
      return { saved: true, pending: !equal(latest.catalog, latest.base) };
    } finally { this.busy = false; }
  }
}
