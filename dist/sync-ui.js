import * as storage from './storage.js';
import { GitHubClient } from './github-client.js';
import { SyncEngine } from './sync-engine.js';
import { onProjectsChanged, PROJECTS_KEY } from './github-projects.js';
import { inspectLocalSync, publishSyncStatus } from './sync-status.js';

const CONFIG = 'skill-cabinet-github-config-v1';
const TOKEN = 'skill-cabinet-github-token-v1';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function repository(value) {
  let input = value.trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (input.startsWith('https://github.com/')) input = input.slice(19);
  const match = /^([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)$/.exec(input);
  if (!match) throw Error('请填写 owner/repo 或完整的 GitHub 仓库地址。');
  return { owner: match[1], repo: match[2] };
}

export function initializeGitHubSync({ onRefresh, toast, projectStore, projectsReady = Promise.resolve() }) {
  let config = {}, token = read(sessionStorage, TOKEN) || read(localStorage, TOKEN) || '';
  try { config = JSON.parse(read(localStorage, CONFIG) || '{}'); } catch {}
  let client, engine, busy = false, rerun = false, timer, conflict, generation = 0;
  let lastState = { status: 'disconnected' }, indicatorGeneration = 0;
  const status = document.createElement('button');
  status.className = 'sync-status'; status.type = 'button'; status.dataset.state = 'disconnected';
  status.innerHTML = '<span class="sync-dot"></span><span>连接 GitHub</span>';
  document.querySelector('.local-status').replaceWith(status);
  const nav = document.createElement('button'); nav.className = 'nav-item sync-settings-link'; nav.textContent = '↻　GitHub 云同步';
  document.querySelector('#help-button').before(nav);
  const dialog = document.createElement('dialog'); dialog.className = 'modal sync-modal'; dialog.id = 'sync-dialog';
  dialog.innerHTML = `<form id="sync-form"><div class="modal-heading"><div><div class="eyebrow">YOUR KNOW-HOW, EVERYWHERE</div><h2>让好方法，随你同行。</h2></div><button type="button" class="icon-btn sync-close" aria-label="关闭 GitHub 设置">×</button></div><p class="muted">Skills 与 GitHub 项目收藏一起同步。名称、内容、分类、收藏和删除都会参与比对；项目原仓库不受影响。</p><div class="sync-summary" role="status" aria-live="polite"><strong id="sync-summary-title">尚未连接</strong><p id="sync-message">本机保存正常。连接后才会上传文件。</p><p id="sync-local-summary"></p><small id="sync-time"></small><a id="sync-commit" target="_blank" rel="noopener noreferrer" hidden>查看最近同步提交 ↗</a></div><div class="form-grid"><label class="full">GitHub 仓库<input name="repository" required placeholder="XiaoyeCodes/Skill-Cabinet" autocomplete="off"></label><label class="full">同步分支<input name="branch" required value="main" maxlength="250" autocomplete="off"><small>使用已存在的分支；令牌需要有该分支的写入权限。</small></label><label class="full">细粒度访问令牌<input name="token" type="password" maxlength="512" autocomplete="off" spellcheck="false" placeholder="github_pat_…"><small>令牌仅发送到 GitHub API，不会写入仓库或导出备份。</small></label></div><div class="sync-token-help"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建 fine-grained token ↗</a><p>选择目标仓库，在 Repository permissions 中将 <b>Contents</b> 设为 <b>Read and write</b>，设置有效期后生成。令牌过期时，在这里重新连接。</p></div><label class="sync-check"><input name="auto" type="checkbox" checked>两个空间的添加、编辑、收藏和删除后自动同步</label><label class="sync-check"><input name="remember" type="checkbox">记住此浏览器的令牌（仅限自己的设备）</label><p class="sync-small">默认仅保留在当前标签页会话。勾选记住后，令牌将保存在本机浏览器；断开连接会清除。公开仓库中的技能和项目收藏任何人都能读取。</p><p id="sync-error" class="form-error" role="alert"></p><div class="sync-actions"><button type="submit" class="primary-btn" id="sync-connect">连接并同步</button><button type="button" class="outline-btn" id="sync-now" disabled>立即同步 / 恢复</button><button type="button" class="text-btn" id="sync-disconnect" disabled>断开连接</button></div><div class="sync-recovery"><button type="button" class="text-btn" id="sync-recovery">下载最近一次 Skills 恢复前备份</button><button type="button" class="text-btn" id="sync-project-recovery">下载最近一次项目恢复前备份</button><small>应用云端修改前自动保存本机快照，保存在当前设备。</small></div></form>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), form = $('#sync-form');
  const activity = document.createElement('section'); activity.className = 'sync-activity'; activity.setAttribute('aria-label', '两个空间的 GitHub 同步');
  activity.innerHTML = '<div><strong id="sync-activity-title">本地已保存 · 尚未连接 GitHub</strong><p id="sync-activity-summary" role="status" aria-live="polite">正在核对本地修改…</p><small>灰：仅本地　黄：待同步　蓝：同步中　绿：已同步　红：需处理</small></div><button type="button" class="outline-btn" data-sync-action="sync">同步到 GitHub</button>';
  document.querySelector('.topbar').after(activity);
  const conflictsDialog = document.createElement('dialog'); conflictsDialog.className = 'modal sync-modal'; conflictsDialog.id = 'sync-conflicts'; document.body.append(conflictsDialog);
  const titles = {disconnected:'尚未连接',pending:'等待同步',syncing:'正在同步',synced:'已同步',offline:'离线待同步',error:'同步未完成',conflict:'需要处理冲突',connecting:'正在连接'};
  function state(value) {
    lastState = value;
    const message = String(value.message || '').replaceAll(token || '\u0000', '[已隐藏]');
    status.dataset.state = value.status; status.lastElementChild.textContent = titles[value.status] || '查看同步状态'; status.title = message;
    $('#sync-summary-title').textContent = titles[value.status] || '同步状态'; $('#sync-message').textContent = message;
    if (value.syncedAt) { config.lastSync = value.syncedAt; config.lastHead = value.head; try { localStorage.setItem(CONFIG, JSON.stringify(config)); } catch {} }
    $('#sync-time').textContent = config.lastSync ? `最近完成：${new Date(config.lastSync).toLocaleString('zh-CN')}` : '';
    if (value.status === 'conflict') { conflict = value; $('#sync-now').textContent = '查看并解决冲突'; if (!document.querySelector('dialog[open]')) showConflicts(); }
    if (value.status === 'synced') conflict = null;
    void refreshIndicators();
  }
  async function refreshIndicators() {
    const request = ++indicatorGeneration;
    try {
      await projectsReady;
      const repoKey = client?.repoKey || (config.owner && config.repo ? `${config.owner.toLowerCase()}/${config.repo.toLowerCase()}@${config.branch || 'main'}` : '');
      const [records, baseline, categories] = await Promise.all([storage.listSkills(), repoKey ? storage.getSyncMeta(`baseline:${repoKey}`) : undefined, storage.listCategories()]);
      const summary = await inspectLocalSync({ records, baseline, projectRecords: projectStore?.list() || [], projectBaseline: repoKey ? projectStore?.getSyncBaseline(repoKey) : undefined });
      if (request !== indicatorGeneration) return;
      const categoryPending = Boolean(baseline?.categories && JSON.stringify(baseline.categories) !== JSON.stringify(categories));
      publishSyncStatus(summary, lastState.status, conflict?.conflicts);
      const describe = (label, collection) => `${label}：${collection.pending ? `${collection.pending} 项待同步${collection.deleted ? `（含 ${collection.deleted} 项删除）` : ''}` : collection.unconfirmed ? `${collection.unconfirmed} 项仅本地，待云端确认` : collection.confirmed ? '与最近确认版本一致' : '本地保存，尚未确认'}`;
      const description = `${describe('Skills', summary.skills)} · ${describe('项目', summary.projects)}${categoryPending ? ' · 分类待同步' : ''}`;
      $('#sync-local-summary').textContent = description; activity.querySelector('#sync-activity-summary').textContent = description;
      const dirty = summary.skills.pending + summary.projects.pending + (categoryPending ? 1 : 0);
      const visible = lastState.status === 'synced' && dirty ? 'pending' : lastState.status;
      status.dataset.state = visible; status.lastElementChild.textContent = titles[visible] || '连接 GitHub';
      activity.dataset.state = visible;
      activity.querySelector('#sync-activity-title').textContent = engine ? `${titles[visible] || '查看同步'}${config.lastSync ? ` · 最近确认 ${new Date(config.lastSync).toLocaleTimeString('zh-CN')}` : ''}` : '本地已保存 · 连接 GitHub 后同步';
      const commit = $('#sync-commit'); commit.hidden = !config.lastHead;
      if (config.lastHead) commit.href = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/commit/${encodeURIComponent(config.lastHead)}`;
    } catch (error) { if (request === indicatorGeneration) { activity.querySelector('#sync-activity-summary').textContent = `无法核对同步状态：${error.message}`; activity.dataset.state = 'error'; } }
  }
  function fill() {
    form.elements.repository.value = config.owner && config.repo ? `${config.owner}/${config.repo}` : 'XiaoyeCodes/Skill-Cabinet';
    form.elements.branch.value = config.branch || 'main'; form.elements.auto.checked = config.auto !== false;
    form.elements.remember.checked = Boolean(read(localStorage, TOKEN)); form.elements.token.value = '';
  }
  function controls() {
    $('#sync-connect').disabled = busy; $('#sync-now').disabled = busy || !engine; $('#sync-disconnect').disabled = busy || (!token && !config.owner);
    for (const name of ['repository','branch','token','auto','remember']) form.elements[name].disabled = busy;
    $('#sync-connect').textContent = busy ? '正在处理…' : '连接并同步';
    $('#sync-now').textContent = busy ? '正在同步…' : conflict ? '查看并解决冲突' : '立即同步 / 恢复';
    form.setAttribute('aria-busy', String(busy));
    for (const button of document.querySelectorAll('[data-sync-action="sync"]')) { button.disabled = busy; button.textContent = busy ? '正在同步…' : '同步到 GitHub'; }
  }
  function open() { fill(); void refreshIndicators(); if (!dialog.open) dialog.showModal(); if (conflict) $('#sync-now').textContent = '查看并解决冲突'; }
  status.onclick = open; nav.onclick = open; $('.sync-close').onclick = () => dialog.close();
  function showConflicts() {
    if (!conflict) return;
    const describe = value => value ? `<b>${esc(value.name || value.slug)}</b><span>${esc(value.description || '无功能介绍')}</span><small>${esc(value.updatedAt ? new Date(value.updatedAt).toLocaleString('zh-CN') : '时间未知')}</small>` : '<b>已删除 / 不存在</b><span>选择这一侧将移除另一侧的对应技能或项目收藏。</span>';
    conflictsDialog.innerHTML = `<form><div class="modal-heading"><div><div class="eyebrow">CHOOSE WHAT TO KEEP</div><h2>两份修改，都值得看一眼。</h2></div><button type="button" class="icon-btn" id="conflict-close" aria-label="稍后处理冲突">×</button></div><p class="muted">同一份技能或项目在两边发生了不同修改。请逐项选择，未选择前不会覆盖。</p>${conflict.conflicts.map((item, i) => `<fieldset class="sync-conflict"><legend>${item.kind === 'project' ? '项目 · ' : 'Skill · '}${esc(item.slug.replace(/^project:/, ''))}</legend><div class="sync-versions"><label><input type="radio" name="choice-${i}" value="local" required><strong>保留本机版本</strong>${describe(item.local)}</label><label><input type="radio" name="choice-${i}" value="remote" required><strong>使用 GitHub 版本</strong>${describe(item.remote)}</label></div></fieldset>`).join('')}<p class="form-error" role="alert" id="conflict-error"></p><div class="sync-actions"><button type="button" class="outline-btn" id="conflict-backup">导出 Skills 备份</button><button type="button" class="outline-btn" id="conflict-project-backup">导出项目备份</button><button type="submit" class="primary-btn">按所选版本同步</button></div></form>`;
    conflictsDialog.querySelector('#conflict-close').onclick = () => conflictsDialog.close();
    conflictsDialog.querySelector('#conflict-backup').onclick = async () => { try { download(await storage.exportLibrary(await storage.listSkills()), 'Skill-Cabinet-冲突前备份.zip'); } catch (e) { toast(e.message, true); } };
    conflictsDialog.querySelector('#conflict-project-backup').onclick = () => { try { if (!projectStore) return toast('当前项目库不可用，请先检查本地存储', true); download(new Blob([JSON.stringify(projectStore.exportBackup(), null, 2)], { type: 'application/json' }), 'GitHub-项目冲突前备份.json'); } catch (error) { toast(error.message, true); } };
    conflictsDialog.querySelector('form').onsubmit = e => { e.preventDefault(); const data = new FormData(e.target); const choices = Object.fromEntries(conflict.conflicts.map((item, i) => [item.slug, data.get(`choice-${i}`)])); const resolutions = { token: conflict.conflictToken, projectToken: conflict.projectToken, choices }; conflictsDialog.close(); void run(resolutions, true); };
    if (dialog.open) dialog.close(); if (!conflictsDialog.open) conflictsDialog.showModal();
  }
  async function run(resolutions, manual = false) {
    clearTimeout(timer); if (!engine) { open(); return; }
    if (busy) { rerun = true; return; }
    if (!navigator.onLine) { state({status:'offline',message:'修改已保存到本机，联网后将继续同步。'}); if (manual) toast('当前离线，修改已保留，联网后可再次同步', true); return; }
    busy = true; controls(); $('#sync-error').textContent = ''; const active = engine, currentGeneration = generation;
    try {
      const operation = () => currentGeneration === generation && active === engine ? active.sync({ resolutions }) : null;
      const result = navigator.locks ? await navigator.locks.request(`skill-cabinet:${client.repoKey}`, operation) : await operation();
      if (currentGeneration !== generation || !result) return;
      if (result.status === 'synced') { $('#sync-now').textContent = '立即同步 / 恢复'; await onRefresh(); if (manual) toast(result.message); }
    } catch (error) { if (currentGeneration === generation) { if (resolutions) { conflict = null; $('#sync-now').textContent = '重新比较并同步'; } const message = String(error.message).replaceAll(token || '\u0000', '[已隐藏]'); $('#sync-error').textContent = message; if (error.code === 'LOCAL_CHANGED') rerun = config.auto !== false; if (manual) toast(message, true); } }
    finally { busy = false; controls(); if (rerun) { rerun = false; schedule(); } }
  }
  function schedule() { void refreshIndicators(); if (!engine) return; clearTimeout(timer); if (busy) { rerun = config.auto !== false; return; } if (conflict) return; state({status:navigator.onLine?'pending':'offline', message:config.auto === false?'修改已保存在本机，点击「立即同步」上传。':'修改已保存在本机，稍后自动同步。'}); if (config.auto !== false) timer = setTimeout(() => void run(), 3000); }
  async function connect(next, credential, remember, persist = true) {
    if (busy) return;
    clearTimeout(timer); generation++; if (client) client.token = ''; engine = client = null; conflict = null;
    const attemptGeneration = generation;
    busy = true; controls(); let connected = false; $('#sync-error').textContent = ''; state({status:'connecting',message:'正在检查仓库和分支访问权限…'});
    try {
      const candidate = new GitHubClient({...next, token:credential}); const info = await candidate.getRepository();
      if (info.permissions.push === false) throw Error('该令牌或账号没有仓库写入权限。');
      await projectsReady;
      if (!projectStore) throw Error('项目收藏无法读取，请先修复本地存储后再同步，已有数据已保留。');
      if (attemptGeneration !== generation) { candidate.token = ''; return; }
      if (persist) {
        // Never keep an older persistent credential when the user selects session only.
        localStorage.removeItem(TOKEN); sessionStorage.removeItem(TOKEN);
        (remember ? localStorage : sessionStorage).setItem(TOKEN, credential);
        localStorage.setItem(CONFIG, JSON.stringify(next));
      }
      config = next; token = credential; client = candidate; generation++; conflict = null;
      const connectionGeneration = generation;
      engine = new SyncEngine({client, storage, projectStore, onState:value => { if (generation === connectionGeneration) state(value); }}); form.elements.token.value = '';
      connected = true;
      state({status:'pending',message:info.private ? '已连接私有仓库，准备同步。' : '已连接公开仓库：上传的 Skill 和附件任何人都可读取。'});
    } catch (error) { if (attemptGeneration === generation) { const message = String(error.message).replaceAll(credential || '\u0000','[已隐藏]'); $('#sync-error').textContent = message; state({status:'error',message}); } }
    finally { busy = false; controls(); }
    if (connected && (persist || next.auto !== false)) await run(undefined, persist);
  }
  form.onsubmit = e => { e.preventDefault(); try { const next = {...repository(form.elements.repository.value), branch:form.elements.branch.value.trim(), auto:form.elements.auto.checked}; const credential = form.elements.token.value.trim() || token; if (!credential) throw Error('请先创建并填写 GitHub 细粒度令牌。'); void connect(next, credential, form.elements.remember.checked); } catch (error) { $('#sync-error').textContent = error.message; } };
  form.elements.auto.onchange = () => { if (!engine) return; config.auto = form.elements.auto.checked; try { localStorage.setItem(CONFIG, JSON.stringify(config)); } catch {} if (config.auto) schedule(); else clearTimeout(timer); };
  $('#sync-now').onclick = () => conflict ? showConflicts() : void run(undefined, true);
  $('#sync-disconnect').onclick = () => { if (busy) return; clearTimeout(timer); generation++; if (client) client.token = ''; engine = client = null; token = ''; config = {}; conflict = null; try { localStorage.removeItem(TOKEN); sessionStorage.removeItem(TOKEN); localStorage.removeItem(CONFIG); } catch {} fill(); controls(); state({status:'disconnected',message:'已断开连接并清除本浏览器的令牌。本机技能仍已保存。'}); };
  $('#sync-recovery').onclick = async () => { try { if (!client) return toast('请先连接仓库'); const value = await storage.getSyncMeta(`recovery:${client.repoKey}`); if (!value?.blob) return toast('当前设备还没有恢复前备份'); download(value.blob, 'Skill-Cabinet-恢复前备份.zip'); } catch (error) { toast(error.message, true); } };
  $('#sync-project-recovery').onclick = () => { const value = client && projectStore?.getSyncBaseline(client.repoKey)?.recovery; if (!value) return toast('当前设备还没有项目恢复前备份'); download(new Blob([JSON.stringify({ schemaVersion: 1, type: 'skill-cabinet-github-projects', projects: value }, null, 2)], { type: 'application/json' }), 'GitHub-项目恢复前备份.json'); };
  storage.onSkillsChanged(async event => { if (event.source === 'local') schedule(); else void refreshIndicators(); await onRefresh(); });
  onProjectsChanged(event => { if (event.source === 'local') schedule(); else void refreshIndicators(); });
  document.addEventListener('click', event => { const button = event.target.closest('.item-sync, [data-sync-action]'); if (!button) return; event.preventDefault(); event.stopPropagation(); if (button.matches('.item-sync')) open(); else if (conflict) showConflicts(); else void run(undefined, true); }, true);
  document.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key) && event.target.matches('.item-sync')) { event.preventDefault(); event.stopPropagation(); open(); } }, true);
  const resume = () => { if (engine && config.auto !== false && !conflict) void run(); };
  window.addEventListener('online', resume); window.addEventListener('offline', () => { if (engine) state({status:'offline',message:'目前离线，技能继续保存在本机。联网后自动重试。'}); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
  window.addEventListener('storage', event => {
    if (event.key === PROJECTS_KEY || event.key === null) void refreshIndicators();
    let changedRepo = false;
    if (event.key === CONFIG && event.newValue) { try { const next = JSON.parse(event.newValue); changedRepo = ['owner','repo','branch'].some(key => next[key] !== config[key]); if (!changedRepo) { config.auto = next.auto; if (config.auto === false) clearTimeout(timer); } } catch { changedRepo = true; } }
    const revoked = event.key === CONFIG && !event.newValue || event.key === TOKEN && event.oldValue === token && event.newValue !== token;
    if (revoked || changedRepo) {
      clearTimeout(timer); generation++; if (client) client.token = ''; engine = client = null; token = ''; conflict = null;
      try { sessionStorage.removeItem(TOKEN); } catch {}
      state({status:'disconnected',message:'另一个标签页已断开或更改连接。当前页已停止自动同步，请重新连接。'}); controls();
    }
  });
  fill(); controls();
  void refreshIndicators();
  setInterval(() => { if (!document.hidden && !busy) resume(); }, 60000);
  if (config.owner && config.repo && token) void connect(config, token, Boolean(read(localStorage, TOKEN)), false);
  else if (config.owner) state({status:'disconnected',message:'本机会话没有可用令牌，请重新连接以继续同步。'});
  return { isConnected: () => Boolean(engine), getReadToken: () => engine ? token : '' };
}
