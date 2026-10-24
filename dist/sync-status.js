import { fingerprintSkill } from './sync-engine.js';
import { fingerprintProject } from './project-sync.js';

export const SYNC_LABELS = { local: '仅本地', pending: '待同步', syncing: '同步中', synced: '已同步', error: '同步失败', conflict: '有冲突' };
const states = { skills: new Map(), projects: new Map() };
const cachedSkills = new Map();
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function compareSyncItems(items, baseline) {
  const result = { items: new Map(), pending: 0, unconfirmed: 0, deleted: 0, confirmed: Boolean(baseline) };
  const local = new Map(items.map(item => [item.id, item.fingerprint]));
  for (const [id, fingerprint] of local) {
    const status = !baseline ? 'local' : baseline.entries?.[id] === fingerprint ? 'synced' : 'pending';
    result.items.set(id, status);
    if (status === 'pending') result.pending++;
    if (status === 'local') result.unconfirmed++;
  }
  for (const [id, fingerprint] of Object.entries(baseline?.entries || {})) if (fingerprint && !local.has(id)) { result.deleted++; result.pending++; }
  return result;
}

export async function inspectLocalSync({ records, baseline, projectRecords = [], projectBaseline }) {
  const skills = [];
  for (const record of records) {
    const cacheKey = `${record.id}:${record.localRevision || ''}`;
    const cached = cachedSkills.get(record.slug);
    const fingerprint = record.localRevision && cached?.key === cacheKey ? cached.fingerprint : await fingerprintSkill(record);
    cachedSkills.set(record.slug, { key: cacheKey, fingerprint });
    skills.push({ id: record.slug, fingerprint });
  }
  const projects = await Promise.all(projectRecords.map(async record => ({ id: record.id, fingerprint: await fingerprintProject(record) })));
  return { skills: compareSyncItems(skills, baseline), projects: compareSyncItems(projects, projectBaseline) };
}

function visibleState(status, transport, id, conflicts, kind) {
  if (conflicts?.some(item => item.slug === (kind === 'projects' ? `project:${id}` : id))) return 'conflict';
  if (status === 'synced') return 'synced';
  return ['syncing', 'connecting'].includes(transport) ? 'syncing' : transport === 'error' ? 'error' : status;
}
export function syncBadge(kind, id) {
  const state = states[kind].get(id) || 'local', label = SYNC_LABELS[state];
  return `<button type="button" class="item-sync" data-sync-kind="${kind}" data-sync-id="${esc(id)}" data-state="${state}" aria-label="${label}，查看 GitHub 同步" title="${label} · 点击查看同步详情"><span class="sync-dot" aria-hidden="true"></span><span>${label}</span></button>`;
}
export function publishSyncStatus(summary, transport, conflicts = []) {
  for (const kind of ['skills', 'projects']) {
    states[kind] = new Map([...summary[kind].items].map(([id, status]) => [id, visibleState(status, transport, id, conflicts, kind)]));
  }
  if (!globalThis.document) return;
  for (const node of document.querySelectorAll('.item-sync[data-sync-kind]')) {
    const state = states[node.dataset.syncKind]?.get(node.dataset.syncId) || 'local', label = SYNC_LABELS[state];
    node.dataset.state = state; node.lastElementChild.textContent = label;
    node.title = state === 'synced' ? '内容与最近一次 GitHub 确认的版本一致；点击可重新检查云端' : `${label} · 点击查看同步详情`;
    node.setAttribute('aria-label', `${label}，查看 GitHub 同步`);
  }
  for (const kind of ['skills', 'projects']) {
    const dot = document.querySelector(`[data-workspace="${kind === 'skills' ? 'skills' : 'github'}"] .local-dot`);
    if (!dot) continue;
    const collection = summary[kind], statuses = [...states[kind].values()];
    const state = statuses.includes('conflict') ? 'conflict' : transport === 'error' && (collection.pending || collection.unconfirmed) ? 'error' : ['syncing', 'connecting'].includes(transport) ? 'syncing' : collection.pending ? 'pending' : collection.unconfirmed || !collection.confirmed ? 'local' : 'synced';
    dot.dataset.state = state; dot.title = `${SYNC_LABELS[state]}${collection.deleted ? ` · ${collection.deleted} 项删除待同步` : ''}`; dot.setAttribute('aria-label', dot.title);
  }
}
