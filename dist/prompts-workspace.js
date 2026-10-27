import { PROMPTS_KEY, PROMPT_CATEGORIES, PromptStore, PromptRepository } from './prompts.js';
import { isStaticHosting } from './hosting.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stamp = () => new Date().toISOString();
const variables = content => [...new Set([...content.matchAll(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g)].map(match => match[1]))];
const drawing = `<svg viewBox="0 0 320 240" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path fill="#ebe7db" d="m74 46 138-11 14 156-138 11z"/><path fill="#faf8f2" d="m100 38 138 13-15 153-138-13z"/><path d="m116 65 86 8m-89 16 94 9m-97 11 68 6m-71 17 95 9m-97 12 74 7m-42 33 63 6"/><path d="M130 96c-8-1-11 4-12 10l-1 8 9 1 1-9-5-.5m28-7c-8-1-11 4-12 10l-1 8 9 1 1-9-5-.5" stroke="#bf6b50" stroke-width="2"/><path fill="#c87457" d="m231 163 37-77 9 4-37 77-9 9z"/><path d="m233 159 8 4m24-71 8 4M45 211h233M56 192h8m-4-4v8M266 43v23m-11-12h23m-19-8 15 16m-16 0 16-16"/><circle cx="62" cy="70" r="3" fill="#9b987f" stroke="none"/></g><text x="87" y="232" fill="currentColor" font-size="8" font-family="Georgia,serif" letter-spacing="2.3">GOOD WORDS, WELL KEPT.</text></svg>`;

export function initializePromptsWorkspace({ icon, hydrateIcons, toast }) {
  const staticHosting = isStaticHosting();
  const content = document.createElement('div'); content.id = 'prompts-content'; content.className = 'page-content'; content.hidden = true;
  content.innerHTML = `
    <section class="prompt-hero"><div><div class="eyebrow"><span></span>A NOTEBOOK FOR YOUR BEST WORDS</div><h1>把好提示，<br>留给下一次<span class="hero-accent">灵感。</span></h1><p>收录一句好指令，积累一种好方法。<br>让每次反复打磨的表达，都能再次派上用场。</p><div class="hero-buttons"><button class="primary-btn" id="prompt-new">${icon('plus')}收录提示词</button><button class="outline-btn" id="prompt-import">${icon('upload')}导入备份</button></div></div><div class="prompt-hero-art">${drawing}</div></section>
    <section class="prompt-library" aria-labelledby="prompt-library-title"><div class="library-heading"><div class="section-title"><h2 id="prompt-library-title">我的提示词库</h2><span id="prompt-count">0 条提示词</span></div><span class="shelf-label">CAPTURE. POLISH. REUSE.</span></div>
    <div class="prompt-save-bar"><span id="prompt-save-status" role="status">正在读取提示词…</span><button class="text-btn" id="prompt-refresh">${staticHosting ? '检查线上更新' : '刷新本机仓库'}</button></div>
    <div class="prompt-conflict" id="prompt-conflict" hidden><p id="prompt-conflict-message"></p><div><button class="outline-btn" id="prompt-keep-local">保留本页版本</button><button class="outline-btn" id="prompt-use-remote">使用仓库版本</button><button class="text-btn" id="prompt-conflict-backup">先导出本页备份</button></div></div>
    <div class="toolbar"><div class="search-wrap">${icon('search')}<input type="search" id="prompt-search" placeholder="搜索标题、正文或标签…" aria-label="搜索提示词"><kbd>/</kbd></div><div class="toolbar-controls"><select id="prompt-sort" aria-label="提示词排序"><option value="updated">最近更新</option><option value="created">最近收录</option><option value="title">标题 A–Z</option></select><button class="quiet-btn" id="prompt-undo" hidden>撤销上次移除</button></div></div>
    <div class="filter-row"><div class="filter-chips" id="prompt-filters"></div><button class="text-btn" id="prompt-reset" hidden>清除筛选</button></div><div id="prompt-grid" class="prompt-grid" aria-live="polite"></div>
    <p class="prompt-storage-note">${staticHosting ? '本页修改保存在当前浏览器，可导出 JSON 备份。仓库提示词随网站发布更新。' : '自动保存到本机项目，也可导出 JSON 备份。提交到 GitHub 后，其他设备拉取即可查看。'}</p></section>
    <footer class="page-footer"><span><span class="footer-mark">✳</span> 好的表达，也值得拥有自己的书架。</span><span>YOUR WORDS. YOUR NEXT POSSIBILITY.</span></footer><input type="file" id="prompt-backup-input" accept=".json,application/json" hidden>`;
  $('main').append(content);
  const exportButton = document.createElement('button'); exportButton.id = 'prompts-export'; exportButton.className = 'quiet-btn'; exportButton.hidden = true; exportButton.innerHTML = `${icon('download')}<span>导出提示词</span>`; $('.top-actions').append(exportButton);
  const label = document.createElement('strong'); label.id = 'prompts-page-label'; label.hidden = true; $('#page-label').after(label);
  const help = document.createElement('div'); help.innerHTML = '<span>05</span><h3>收好每一句提示词</h3><p>在「提示词收录」中保存正文、用途、分类、标签和来源。使用 {{变量名}} 标记可替换内容，在详情中填好后一键复制。提示词会写入本机项目文件，支持 JSON 备份与恢复；提交代码后，其他设备拉取即可读取。</p>'; $('.help-steps').append(help);
  if (staticHosting) help.querySelector('p').textContent = '在「提示词收录」中保存正文、用途、分类、标签和来源。使用 {{变量名}} 标记可替换内容。本页修改保存在当前浏览器；可导出 JSON 备份，在本地项目恢复后提交发布。';
  const makeDialog = (id, className) => { const node = document.createElement('dialog'); node.id = id; node.className = `modal ${className}`; document.body.append(node); return node; };
  const editor = makeDialog('prompt-editor', 'prompt-editor'), detail = makeDialog('prompt-detail', 'prompt-detail'), categoryDialog = makeDialog('prompt-category-dialog', 'confirm-modal'), confirm = makeDialog('prompt-confirm', 'confirm-modal');
  const closeButton = `<button type="button" class="icon-btn" data-prompt-close aria-label="关闭">${icon('x')}</button>`;
  let store, repository, records = [], nav = 'all', category = '', query = '', currentId, editorBase = null;
  const categories = () => [...new Set([...PROMPT_CATEGORIES, ...store.read().catalog.categories])];
  function render() {
    const names = { all: '全部提示词', favorites: '我的收藏', recent: '最近更新', category };
    label.textContent = names[nav]; $('#prompt-library-title').textContent = nav === 'all' ? '我的提示词库' : names[nav];
    $('#prompts-navigation').innerHTML = `<div class="nav-caption">我的提示词手册</div><nav aria-label="提示词导航"><button class="nav-item ${nav === 'all' ? 'active' : ''}" data-prompt-nav="all">${icon('file')}全部提示词<span class="nav-count">${records.length}</span></button><button class="nav-item ${nav === 'favorites' ? 'active' : ''}" data-prompt-nav="favorites">${icon('star')}我的收藏<span class="nav-count">${records.filter(item => item.favorite).length}</span></button><button class="nav-item ${nav === 'recent' ? 'active' : ''}" data-prompt-nav="recent">${icon('clock')}最近更新</button></nav><div class="nav-caption category-heading">按分类浏览<button class="icon-btn" id="prompt-add-category" aria-label="新建提示词分类">${icon('plus')}</button></div><nav aria-label="提示词分类">${categories().map(name => `<button class="nav-item ${category === name ? 'active' : ''}" data-prompt-category="${esc(name)}"><span class="category-dot"></span>${esc(name)}<span class="nav-count">${records.filter(item => item.category === name).length || ''}</span></button>`).join('')}</nav>`;
    $('#prompt-filters').innerHTML = [['', '全部'], ...categories().filter(name => name === category || records.some(item => item.category === name)).map(name => [name, name])].map(([value, name]) => `<button class="chip ${category === value ? 'active' : ''}" data-prompt-category="${esc(value)}">${esc(name)}</button>`).join('');
    const filtered = records.filter(item => (nav !== 'favorites' || item.favorite) && (!category || item.category === category) && (!query || [item.title, item.description, item.content, item.category, ...item.tags].join(' ').toLowerCase().includes(query)));
    const sort = nav === 'recent' ? 'updated' : $('#prompt-sort').value;
    filtered.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : Date.parse(b[sort === 'created' ? 'createdAt' : 'updatedAt']) - Date.parse(a[sort === 'created' ? 'createdAt' : 'updatedAt']));
    $('#prompt-count').textContent = `${filtered.length} 条提示词`; $('#prompt-reset').hidden = !(query || category || nav !== 'all');
    const removed = store.read().removed;
    $('#prompt-undo').hidden = !removed || records.some(item => item.id === removed.id);
    $('#prompt-grid').innerHTML = filtered.length ? filtered.map((item, index) => `<article class="prompt-card"><div class="prompt-card-top"><span class="prompt-number">NOTE ${String(index + 1).padStart(2, '0')}</span><button class="icon-btn prompt-star ${item.favorite ? 'is-favorite' : ''}" data-prompt-favorite="${esc(item.id)}" aria-label="${item.favorite ? '取消收藏' : '收藏'} ${esc(item.title)}" aria-pressed="${item.favorite}">${icon('star')}</button></div><div class="card-eyebrow">${esc(item.category)}</div><h3><button data-prompt-open="${esc(item.id)}">${esc(item.title)}</button></h3><p class="prompt-description">${esc(item.description || '点击查看完整提示词，复制后即可使用。')}</p><div class="prompt-excerpt"><span aria-hidden="true">“</span><p>${esc(item.content)}</p></div><div class="card-tags">${item.tags.slice(0, 3).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div><div class="prompt-card-footer"><span>${new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} 更新</span><button data-prompt-open="${esc(item.id)}" class="text-btn" aria-label="查看 ${esc(item.title)}">查看详情 ↗</button><button class="prompt-copy" data-prompt-copy="${esc(item.id)}" aria-label="复制 ${esc(item.title)}">${icon('copy')}复制</button></div></article>`).join('') : `<div class="prompt-empty"><span class="prompt-empty-mark" aria-hidden="true">“ ”</span><div class="eyebrow">A GOOD PROMPT IS WORTH KEEPING</div><h3>${query || category || nav !== 'all' ? '换个方向，再找找。' : '给好提示，留一个位置。'}</h3><p>${query || category || nav !== 'all' ? '试试其他关键词或分类，也可以清除当前筛选。' : '写作的开场白、设计的灵感、解决问题的指令。<br>把反复用到的那一句，先收进来。'}</p><button class="outline-btn" ${query || category || nav !== 'all' ? 'data-prompt-reset' : 'data-prompt-new'}>${query || category || nav !== 'all' ? '查看全部提示词' : '收录第一条提示词 ↗'}</button></div>`;
    hydrateIcons(content); hydrateIcons($('#prompts-navigation'));
  }
  function reload() { records = store.list(); render(); }
  function reset() { nav = 'all'; category = ''; query = ''; $('#prompt-search').value = ''; render(); }
  function download(value, name = '提示词备份') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), a = document.createElement('a');
    a.href = url; a.download = `${name}-${new Date().toLocaleDateString('en-CA')}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function refresh(choice) {
    if (!repository || repository.busy) return;
    const before = JSON.stringify(store.read().catalog), status = $('#prompt-save-status');
    try {
      const result = await repository.refresh(choice);
      $('#prompt-conflict').hidden = !result.conflicts?.length;
      if (result.conflicts?.length) {
        status.textContent = result.stale ? '内容刚有新修改，请根据最新差异重新选择版本。' : '检测到版本差异，两个版本均已保留。';
        $('#prompt-conflict-message').textContent = `以下提示词在本页和项目仓库都有修改：${result.conflicts.map(item => item.title).join('、')}。请选择冲突项使用哪个版本；其他修改会自动合并。`;
      } else {
        status.textContent = result.readOnly ? '已加载线上提示词库 · 本页修改保存在当前浏览器，可导出备份' : result.pending ? '浏览器已保存 · 正在写入最新修改…' : '已保存到本机项目 · 拉取代码后自动读取更新';
        if (result.pending) setTimeout(() => { void refresh(); }, 0);
      }
      status.removeAttribute('data-error');
      if (before !== JSON.stringify(store.read().catalog)) {
        reload();
        if (detail.open) { if (records.some(item => item.id === currentId)) showDetail(currentId); else detail.close(); }
      }
    } catch (error) { status.textContent = error.message; status.dataset.error = 'true'; }
  }
  function changed(message) { reload(); toast(message); $('#prompt-save-status').textContent = staticHosting ? '已保存到当前浏览器 · 可导出备份' : '浏览器已保存 · 正在写入本机项目…'; void refresh(); }
  async function copy(text) {
    let timer;
    try {
      await Promise.race([navigator.clipboard.writeText(text), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Clipboard timeout')), 1500); })]);
      toast('提示词已复制');
    } catch {
      const field = document.createElement('textarea'); field.value = text; field.style.cssText = 'position:fixed;opacity:0;left:0;top:0;width:1px;height:1px';
      const previous = document.activeElement;
      (detail.open ? detail : content).append(field); field.select();
      try { if (!document.execCommand('copy')) throw Error('Copy failed'); toast('提示词已复制'); }
      catch { toast('剪贴板暂不可用，请在详情中选择正文手动复制。', true); }
      finally { field.remove(); previous?.focus(); }
    } finally { clearTimeout(timer); }
  }
  function showDetail(id) {
    const item = store.list().find(record => record.id === id); if (!item) return; currentId = id;
    const fields = variables(item.content);
    detail.innerHTML = `<div class="modal-heading"><div><div class="card-eyebrow">${esc(item.category)}</div><h2>${esc(item.title)}</h2></div>${closeButton}</div><p class="prompt-detail-description">${esc(item.description)}</p><div class="card-tags">${item.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div>${fields.length ? `<section class="prompt-variables"><h3>填一填，变成这次的提示</h3><p>填写后复制会替换 {{变量}}，留空时保留原占位符。</p><div class="form-grid">${fields.map((name, index) => `<label>${esc(name)}<input data-prompt-variable="${index}" maxlength="10000" placeholder="填写${esc(name)}"></label>`).join('')}</div></section>` : ''}<div class="prompt-body-label"><span>完整提示词 · ${item.content.length.toLocaleString()} 字符</span><button class="text-btn" id="prompt-copy-original">${icon('copy')}复制原文</button></div><pre class="prompt-full-content" tabindex="0">${esc(item.content)}</pre>${item.source ? `<a class="prompt-source" href="${esc(item.source)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ''}<div class="modal-footer prompt-detail-footer"><button class="text-btn prompt-remove" data-prompt-remove="${esc(id)}">${icon('trash')}移除</button><button class="outline-btn" data-prompt-edit="${esc(id)}">${icon('edit')}编辑</button><button class="outline-btn" data-prompt-duplicate="${esc(id)}">另存一份</button><button class="primary-btn" id="prompt-copy-filled">${icon('copy')}${fields.length ? '复制填写后的提示词' : '复制提示词'}</button></div>`;
    $('#prompt-copy-original').onclick = () => copy(item.content);
    $('#prompt-copy-filled').onclick = () => {
      const filled = new Map(fields.map((name, index) => [name, $(`[data-prompt-variable="${index}"]`, detail)?.value || '']));
      void copy(item.content.replace(/\{\{\s*([^{}\n]{1,40}?)\s*\}\}/g, (match, name) => filled.get(name) || match));
    };
    hydrateIcons(detail); if (!detail.open) detail.showModal();
  }
  function showEditor(id, duplicate = false) {
    const item = id ? store.list().find(record => record.id === id) : null; if (id && !item) return;
    editorBase = duplicate ? null : item;
    detail.close();
    editor.innerHTML = `<form id="prompt-editor-form"><div class="modal-heading"><div><div class="eyebrow">MAKE ROOM FOR A GOOD PROMPT</div><h2>${item && !duplicate ? '再打磨一句好提示。' : '收录一句好提示。'}</h2></div>${closeButton}</div><div class="form-grid"><label class="full">提示词标题 <span class="required">*</span><input name="title" required maxlength="120" placeholder="例如：把复杂概念讲清楚" value="${esc(item ? item.title + (duplicate ? '（副本）' : '') : '')}"></label><label>分类 <span class="required">*</span><input name="category" required maxlength="30" list="prompt-category-options" value="${esc(item?.category || category || '效率与工作')}"><datalist id="prompt-category-options">${categories().map(name => `<option value="${esc(name)}">`).join('')}</datalist><small>选择已有分类，或直接输入新分类</small></label><label>标签<input name="tags" maxlength="330" placeholder="用逗号分隔，最多 8 个" value="${esc(item?.tags.join(', ') || '')}"></label><label class="full">用途说明<textarea name="description" rows="2" maxlength="2000" placeholder="什么时候用？希望得到什么结果？">${esc(item?.description || '')}</textarea></label><label class="full">提示词正文 <span class="required">*</span><textarea class="prompt-content-input" name="content" required rows="11" maxlength="100000" placeholder="在这里写下完整提示词…&#10;&#10;可以用 {{主题}}、{{受众}} 标记每次需要替换的内容。">${esc(item?.content || '')}</textarea><small>支持多行文字与 Markdown，按原文保存；{{变量名}} 可在详情中填写后复制。</small></label><label class="full">来源链接<input name="source" type="url" maxlength="2048" placeholder="https://…（选填）" value="${esc(item?.source || '')}"></label></div><p class="form-error" id="prompt-editor-error" role="alert"></p><div class="modal-footer"><button type="button" class="outline-btn" data-prompt-close>取消</button><button class="primary-btn" type="submit">${icon('check')}保存提示词</button></div></form>`;
    $('#prompt-editor-form').onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target)), now = stamp();
      try {
        store.save({ ...values, id: editorBase?.id || crypto.randomUUID(), tags: values.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean), favorite: editorBase?.favorite || false, createdAt: editorBase?.createdAt || now, updatedAt: now }, editorBase);
        editor.close(); reset(); changed('提示词已收好');
      } catch (error) { $('#prompt-editor-error').textContent = error.message; }
    };
    hydrateIcons(editor); editor.showModal();
  }
  $('#prompt-new').onclick = () => store && showEditor();
  $('#prompt-search').oninput = event => { query = event.target.value.trim().toLowerCase(); render(); };
  $('#prompt-sort').onchange = render; $('#prompt-reset').onclick = reset;
  $('#prompt-refresh').onclick = () => refresh();
  $('#prompt-keep-local').onclick = () => refresh('local'); $('#prompt-use-remote').onclick = () => refresh('remote');
  exportButton.onclick = $('#prompt-conflict-backup').onclick = () => { try { download(store.exportBackup()); } catch (error) { toast(error.message, true); } };
  $('#prompt-undo').onclick = () => { try { store.undoRemove(); changed('已恢复上次移除的提示词'); } catch (error) { toast(error.message, true); } };
  $('#prompt-import').onclick = () => $('#prompt-backup-input').click();
  $('#prompt-backup-input').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 8 * 1024 * 1024) throw Error('备份超过 8 MB，请检查文件。'); const count = store.importBackup(JSON.parse(await file.text())); reset(); changed(`已恢复 ${count} 条提示词，同标识内容保持不变`); }
    catch (error) { toast(error instanceof SyntaxError ? '这个文件不是有效的提示词 JSON 备份。' : error.message, true); }
    finally { event.target.value = ''; }
  };
  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.hasAttribute('data-prompt-close')) { target.closest('dialog').close(); return; }
    if (!store) return;
    if (target.dataset.promptNav) { nav = target.dataset.promptNav; category = ''; render(); $('#sidebar').classList.remove('open'); return; }
    if (target.hasAttribute('data-prompt-category')) { category = target.dataset.promptCategory; nav = category ? 'category' : 'all'; render(); $('#sidebar').classList.remove('open'); return; }
    if (target.hasAttribute('data-prompt-new')) { showEditor(); return; }
    if (target.hasAttribute('data-prompt-reset')) { reset(); return; }
    if (target.id === 'prompt-add-category') {
      categoryDialog.innerHTML = `<form id="prompt-category-form"><div class="modal-heading"><h2>为好提示分个类。</h2>${closeButton}</div><label>分类名称<input name="category" required maxlength="30" placeholder="例如：视频与分镜"></label><p class="form-error" role="alert"></p><div class="modal-footer"><button class="primary-btn">添加分类</button></div></form>`;
      $('#prompt-category-form').onsubmit = event => { event.preventDefault(); try { store.addCategory(new FormData(event.target).get('category')); categoryDialog.close(); changed('分类已添加'); } catch (error) { $('.form-error', categoryDialog).textContent = error.message; } }; hydrateIcons(categoryDialog); categoryDialog.showModal(); return;
    }
    const item = records.find(record => record.id === (target.dataset.promptFavorite || target.dataset.promptCopy || target.dataset.promptRemove));
    if (target.dataset.promptFavorite && item) { try { store.save({ ...item, favorite: !item.favorite, updatedAt: stamp() }, item); changed(item.favorite ? '已取消收藏' : '已加入收藏'); } catch (error) { toast(error.message, true); } return; }
    if (target.dataset.promptCopy && item) { void copy(item.content); return; }
    if (target.dataset.promptEdit) { showEditor(target.dataset.promptEdit); return; }
    if (target.dataset.promptDuplicate) { showEditor(target.dataset.promptDuplicate, true); return; }
    if (target.dataset.promptRemove && item) {
      confirm.innerHTML = `<div class="modal-heading"><h2>移除这条提示词？</h2>${closeButton}</div><p>将移除「${esc(item.title)}」。移除后可通过「撤销上次移除」找回。</p><div class="modal-footer"><button class="outline-btn" data-prompt-close>取消</button><button class="danger-btn" id="prompt-confirm-remove">移除提示词</button></div>`;
      $('#prompt-confirm-remove').onclick = () => { try { store.remove(item.id, item); confirm.close(); detail.close(); changed('已移除，可撤销上次移除'); } catch (error) { toast(error.message, true); } }; hydrateIcons(confirm); confirm.showModal(); return;
    }
    if (target.dataset.promptOpen) showDetail(target.dataset.promptOpen);
  });
  window.addEventListener('storage', event => { if (event.key === PROMPTS_KEY || event.key === null) { try { reload(); void refresh(); } catch (error) { toast(error.message, true); } } });
  try { store = new PromptStore(); records = store.list(); repository = new PromptRepository(store); render(); void refresh(); }
  catch (error) { store = null; $('#prompt-save-status').textContent = error.message; $('#prompt-save-status').dataset.error = 'true'; $('#prompt-new').disabled = true; $('#prompt-import').disabled = true; $('#prompt-search').disabled = true; $('#prompt-sort').disabled = true; }
  setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  hydrateIcons(content); hydrateIcons(exportButton);
  return { store };
}
