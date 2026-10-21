import { PROJECTS_KEY, PROJECT_CATEGORIES, ProjectStore, inspectRepository, parseRepositoryUrl, loadProjectCatalog } from './github-projects.js';
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = value => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const date = value => new Date(value).toLocaleDateString('zh-CN');
const projectDrawing = `<svg viewBox="0 0 300 230" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="54" y="51" width="187" height="135" rx="5"/><path d="M54 77h187M65 65h3m7 0h3m7 0h3M89 107l-17 14 17 14m28-28 17 14-17 14m-9-35-10 41M72 158h63m-63 10h43M169 106h43m-43 12h30m-30 12h38M35 199h230"/><path d="M194 39V20m-9 9h19M255 150v20m-10-10h20" stroke="#bf6b50"/><circle cx="39" cy="120" r="6"/><path d="M39 126v39h15M241 99h21v27"/><circle cx="262" cy="132" r="6"/></g><path d="M146 186h47v12h-47z" fill="#dfd7c5"/><text x="91" y="220" fill="currentColor" font-size="8" font-family="Georgia,serif" letter-spacing="2.5">GOOD CODE, WELL KEPT.</text></svg>`;

export function initializeGitHubWorkspace({ icon, hydrateIcons, toast, getToken = () => '' }) {
  const content = document.createElement('div');
  content.id = 'github-content'; content.className = 'page-content'; content.hidden = true;
  content.innerHTML = `
    <section class="project-hero"><div class="project-hero-copy"><div class="eyebrow"><span></span>A LITTLE MAP OF WHAT YOU CAN BUILD</div><h1>把好项目，<br>收进你的<span class="hero-accent">创作地图。</span></h1><p>一个 GitHub 链接，留下名称、用途和分类。<br>下次需要，从这里开始。</p></div><div class="project-hero-art">${projectDrawing}</div></section>
    <form id="project-add-form" class="project-add-form"><label for="project-url">收藏一个 GitHub 项目</label><div class="project-url-row"><span class="project-url-icon">${icon('plus')}</span><input id="project-url" type="text" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="粘贴 GitHub 仓库地址，例如 github.com/owner/repository" aria-describedby="project-add-help project-add-status"><button type="submit" class="primary-btn" id="project-add-button">识别并添加 ${icon('arrow')}</button><button type="button" class="text-btn" id="project-cancel" hidden>取消</button></div><p id="project-add-help">自动读取项目简介、README 和技术标签，补全用途并归类。添加后可以继续编辑。</p><p id="project-add-status" role="status" aria-live="polite"></p></form>
    <section class="project-library" aria-labelledby="project-library-title"><div class="library-heading"><div class="section-title"><h2 id="project-library-title">我的项目库</h2><span id="project-result-count">0 个项目</span></div><span class="shelf-label">DISCOVER. KEEP. BUILD.</span></div><div class="toolbar"><div class="search-wrap">${icon('search')}<input id="github-search" type="search" placeholder="搜索项目、用途、作者或标签…" aria-label="搜索 GitHub 项目"><kbd>/</kbd></div><div class="toolbar-controls"><select id="project-sort" aria-label="GitHub 项目排序"><option value="created">最近添加</option><option value="name">名称 A–Z</option><option value="stars">最多 Star</option></select><button class="quiet-btn" id="project-import-button" type="button">${icon('upload')}恢复备份</button><input id="project-backup-input" type="file" accept=".json,application/json" hidden></div></div><div class="filter-row"><div id="project-filters" class="filter-chips"></div><button class="text-btn" id="project-reset" hidden>清除筛选</button></div><div id="project-grid" class="project-grid" aria-live="polite"></div></section>
    <footer class="page-footer"><span><span class="footer-mark">✳</span> 好项目，留给下一次灵感。</span><span>YOUR PROJECTS. YOUR NEXT POSSIBILITY.</span></footer>`;
  $('main').append(content);
  const exportButton = document.createElement('button');
  exportButton.className = 'quiet-btn'; exportButton.id = 'project-export'; exportButton.hidden = true;
  exportButton.innerHTML = `${icon('download')}<span>导出项目</span>`; $('.top-actions').append(exportButton);
  const pageLabel = document.createElement('strong'); pageLabel.id = 'github-page-label'; pageLabel.hidden = true; pageLabel.textContent = '全部项目'; $('#page-label').after(pageLabel);
  const localNote = $('.local-note small'), skillsNote = localNote.innerHTML;
  const localCaption = $('.local-note p').firstChild, skillsCaption = localCaption.textContent;
  const helpStep = document.createElement('div'); helpStep.innerHTML = '<span>04</span><h3>收藏你的 GitHub 项目</h3><p>切换到「我的 GitHub 空间」，粘贴项目仓库链接，即可自动读取名称、用途和分类。识别结果可以编辑。项目收藏保存在当前浏览器；使用「导出项目」和「恢复备份」在设备之间迁移。</p>'; $('.help-steps').append(helpStep);
  const dialog = document.createElement('dialog'); dialog.className = 'modal project-dialog'; dialog.id = 'project-dialog'; document.body.append(dialog);
  const editor = document.createElement('dialog'); editor.className = 'modal project-editor'; editor.id = 'project-editor'; document.body.append(editor);
  const confirmDialog = document.createElement('dialog'); confirmDialog.className = 'modal confirm-modal'; confirmDialog.id = 'project-confirm'; document.body.append(confirmDialog);
  for (const modal of [dialog, editor, confirmDialog]) modal.addEventListener('click', event => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close(); } });

  let store, projects = [], nav = 'all', category = '', query = '', active = false, pending, currentId;
  const status = $('#project-add-status');
  try { store = new ProjectStore(); projects = store.list(); } catch (error) { status.textContent = error.message; status.className = 'form-error'; }
  const categories = () => [...new Set([...PROJECT_CATEGORIES, ...projects.map(project => project.category)])];
  const closeButton = `<button type="button" class="icon-btn" data-project-close aria-label="关闭">${icon('x')}</button>`;
  const reload = () => { projects = store.list(); render(); };
  function render() {
    const labels = { all: '全部项目', favorites: '我的收藏', recent: '最近添加', category };
    $('#github-page-label').textContent = labels[nav];
    $('#project-library-title').textContent = nav === 'all' ? '我的项目库' : labels[nav];
    $('#github-navigation').innerHTML = `<div class="nav-caption">我的项目收藏室</div><nav aria-label="GitHub 项目导航"><button class="nav-item ${nav === 'all' ? 'active' : ''}" data-project-nav="all">${icon('library')}全部项目<span class="nav-count">${projects.length}</span></button><button class="nav-item ${nav === 'favorites' ? 'active' : ''}" data-project-nav="favorites">${icon('star')}我的收藏<span class="nav-count">${projects.filter(project => project.favorite).length}</span></button><button class="nav-item ${nav === 'recent' ? 'active' : ''}" data-project-nav="recent">${icon('clock')}最近添加</button></nav><div class="nav-caption category-heading">按分类浏览<span class="project-auto-label">自动归类</span></div><nav aria-label="GitHub 项目分类">${categories().filter(name => projects.some(project => project.category === name)).map(name => `<button class="nav-item ${category === name ? 'active' : ''}" data-project-category="${esc(name)}"><span class="category-dot"></span>${esc(name)}<span class="nav-count">${projects.filter(project => project.category === name).length}</span></button>`).join('') || '<p class="project-category-empty">添加第一个项目后，<br>分类会出现在这里。</p>'}</nav>`;
    $('#project-filters').innerHTML = [['', '全部'], ...categories().filter(name => projects.some(project => project.category === name)).map(name => [name, name])].map(([value, label]) => `<button class="chip ${category === value ? 'active' : ''}" data-project-category="${esc(value)}">${esc(label)}${!value ? `<span class="chip-count">${projects.length}</span>` : ''}</button>`).join('');
    const filtered = projects.filter(project => (nav !== 'favorites' || project.favorite) && (!category || project.category === category) && (!query || [project.name, project.description, project.owner, project.repo, project.category, ...project.tags].join(' ').toLowerCase().includes(query)));
    const sort = nav === 'recent' ? 'created' : $('#project-sort').value;
    filtered.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort === 'stars' ? b.stars - a.stars : Date.parse(b.createdAt) - Date.parse(a.createdAt));
    $('#project-result-count').textContent = `${filtered.length} 个项目`;
    $('#project-reset').hidden = !(query || category || nav !== 'all');
    $('#project-grid').innerHTML = filtered.length ? filtered.map(project => `<article class="project-card" role="button" tabindex="0" data-project-open="${esc(project.id)}" aria-label="查看项目 ${esc(project.name)}"><div class="project-card-top"><span class="project-code-mark" aria-hidden="true">&lt;/&gt;</span><span class="project-owner">${esc(project.owner)}</span><button class="icon-btn project-favorite ${project.favorite ? 'is-favorite' : ''}" data-project-favorite="${esc(project.id)}" aria-label="${project.favorite ? '取消收藏' : '收藏'} ${esc(project.name)}" aria-pressed="${project.favorite}">${icon('star')}</button></div><div class="card-eyebrow">${esc(project.category)}${project.archived ? ' · 已归档' : ''}</div><h3>${esc(project.name)}</h3><p class="project-description">${esc(project.description || '还没有用途说明，点击项目可以补充。')}</p><div class="card-tags">${project.tags.slice(0, 3).map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div><div class="project-card-footer"><span>${project.language ? `<span class="project-language-dot"></span>${esc(project.language)}` : 'GitHub 项目'}</span><span class="project-stars">${icon('star')}${number(project.stars)}</span><span class="card-arrow" aria-hidden="true">↗</span></div></article>`).join('') : `<div class="project-empty">${projects.length ? icon('search') : '<span class="project-empty-mark" aria-hidden="true">{ }</span>'}<div class="eyebrow">${projects.length ? 'A LITTLE MORE EXPLORING' : 'YOUR NEXT IDEA STARTS HERE'}</div><h3>${projects.length ? '换个关键词，再找找。' : '好项目，值得留一个位置。'}</h3><p>${projects.length ? '试试项目名、作者或用途，也可以清除当前筛选。' : '把第一个 GitHub 链接粘贴到上方，<br>让散落的项目，成为随时可用的灵感。'}</p>${projects.length ? '<button class="outline-btn" data-project-reset>查看全部项目</button>' : '<button class="outline-btn" id="project-focus-url">添加第一个项目 ↗</button>'}</div>`;
    hydrateIcons($('#github-navigation')); hydrateIcons(content);
  }
  function switchWorkspace(workspace) {
    active = workspace === 'github'; document.body.classList.toggle('github-workspace', active);
    document.title = active ? 'Skill Cabinet · 我的 GitHub 空间' : 'Skill Cabinet · 我的 Skills 空间';
    localNote.innerHTML = active ? '项目收藏保存在本机<br>可导出备份，随时带走。' : skillsNote;
    localCaption.textContent = active ? '你的项目，值得好好收藏。' : skillsCaption;
    $('#skills-content').hidden = active; $('#github-content').hidden = !active;
    $('#skills-navigation').hidden = active; $('#github-navigation').hidden = !active;
    $('#page-label').hidden = active; $('#github-page-label').hidden = !active;
    $('#backup-button').hidden = active; exportButton.hidden = !active;
    $('.breadcrumb > span:not(.slash)').textContent = active ? 'GitHub 空间' : 'Skills 空间';
    for (const button of document.querySelectorAll('[data-workspace]')) { const selected = button.dataset.workspace === workspace; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); }
    $('#sidebar').classList.remove('open');
    try { localStorage.setItem('skill-cabinet-active-workspace', workspace); } catch {}
  }
  function showDetail(id) {
    const project = projects.find(item => item.id === id); if (!project) return;
    currentId = id;
    dialog.innerHTML = `<div class="modal-heading"><div><div class="card-eyebrow">${esc(project.category)}</div><h2>${esc(project.name)}</h2></div>${closeButton}</div><div class="project-full-name">${esc(project.owner)}/${esc(project.repo)}</div><p class="project-detail-description">${esc(project.description)}</p><div class="card-tags">${project.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('')}</div><div class="project-detail-actions"><a class="primary-btn" href="${esc(project.url)}" target="_blank" rel="noopener noreferrer">打开 GitHub ${icon('arrow')}</a><button class="outline-btn" data-project-edit="${esc(id)}">${icon('edit')}编辑资料</button><button class="icon-btn project-favorite ${project.favorite ? 'is-favorite' : ''}" data-project-favorite="${esc(id)}" aria-label="${project.favorite ? '取消收藏' : '收藏'} ${esc(project.name)}" aria-pressed="${project.favorite}">${icon('star')}</button></div><dl class="project-facts"><div><dt>主要语言</dt><dd>${esc(project.language || '未标注')}</dd></div><div><dt>GitHub Star</dt><dd>${number(project.stars)}</dd></div><div><dt>开源协议</dt><dd>${esc(project.license === 'NOASSERTION' ? '未标注' : project.license || '未标注')}</dd></div><div><dt>最近推送</dt><dd>${esc(date(project.repositoryUpdatedAt))}</dd></div></dl>${project.homepage ? `<a class="project-homepage" href="${esc(project.homepage)}" target="_blank" rel="noopener noreferrer">访问项目网站 ↗</a>` : ''}<div class="project-readme"><div class="eyebrow">FROM THE README</div><h3>关于这个项目</h3><p>${esc(project.readmeExcerpt || '仓库暂未提供可读取的 README，已根据项目简介和标签完成识别。')}</p></div><div class="project-detail-note">资料读取于 ${esc(date(project.createdAt))} · 用途与分类可按自己的理解调整</div>`;
    hydrateIcons(dialog); if (!dialog.open) dialog.showModal();
  }
  function showEditor(id) {
    const project = projects.find(item => item.id === id); if (!project) return;
    dialog.close();
    editor.innerHTML = `<form id="project-editor-form"><div class="modal-heading"><div><div class="eyebrow">MAKE IT YOURS</div><h2>用自己的方式，记住它。</h2></div>${closeButton}</div><p class="project-full-name">${esc(project.owner)}/${esc(project.repo)}</p><div class="form-grid"><label>项目名称<input name="name" value="${esc(project.name)}" required maxlength="100"></label><label>分类<input name="category" value="${esc(project.category)}" required maxlength="30" list="project-category-options"><datalist id="project-category-options">${categories().map(name => `<option value="${esc(name)}">`).join('')}</datalist></label><label class="full">用途说明<textarea name="description" rows="4" maxlength="1500">${esc(project.description)}</textarea></label><label class="full">标签<input name="tags" value="${esc(project.tags.join(', '))}" placeholder="用逗号分隔，最多 8 个"></label></div><p class="form-error" id="project-editor-error" role="alert"></p><div class="modal-footer"><button type="button" class="text-btn danger-text" data-project-remove="${esc(id)}">移除收藏</button><button type="button" class="outline-btn" data-project-close>取消</button><button class="primary-btn" type="submit">保存修改</button></div></form>`;
    editor.showModal(); hydrateIcons(editor);
    $('#project-editor-form').onsubmit = event => {
      event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
      if (!values.name.trim() || !values.category.trim()) { $('#project-editor-error').textContent = '请填写项目名称和分类。'; return; }
      try { store.update(id, { name: values.name, category: values.category, description: values.description, tags: values.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }); reload(); editor.close(); showDetail(id); toast('项目资料已保存'); } catch (error) { $('#project-editor-error').textContent = error.message; }
    };
  }
  function reset() { nav = 'all'; category = ''; query = ''; $('#github-search').value = ''; render(); }
  async function submit(event) {
    event.preventDefault(); if (pending) return;
    const input = $('#project-url'), button = $('#project-add-button');
    status.className = '';
    try {
      const parsed = parseRepositoryUrl(input.value);
      if (store.list().some(project => project.id === parsed.id)) throw Error('这个项目已经添加过了，可以在下方搜索找到它。');
      pending = new AbortController(); button.disabled = true; input.readOnly = true; $('#project-cancel').hidden = false;
      button.innerHTML = '<span class="project-spinner" aria-hidden="true"></span>正在识别';
      status.textContent = '正在读取 GitHub 项目简介、README 和技术标签…';
      const project = await inspectRepository(input.value, { token: getToken(), signal: pending.signal });
      store.add(project); nav = 'all'; category = ''; query = ''; $('#github-search').value = ''; $('#project-sort').value = 'created';
      reload(); input.value = '';
      status.textContent = `已收好「${project.name}」· 自动分类为「${project.category}」${project.readmeStatus === 'unavailable' ? '。README 暂未读到，已使用项目简介和标签。' : ''}`;
      toast(`已添加「${project.name}」`);
    } catch (error) { status.className = 'form-error'; status.textContent = error.message; }
    finally { pending = null; button.disabled = false; input.readOnly = false; $('#project-cancel').hidden = true; button.innerHTML = `识别并添加 ${icon('arrow')}`; hydrateIcons(button); }
  }
  $('#project-add-form').addEventListener('submit', submit);
  $('#project-cancel').onclick = () => pending?.abort();
  $('#github-search').oninput = event => { query = event.target.value.trim().toLowerCase(); render(); };
  $('#project-sort').onchange = render;
  $('#project-reset').onclick = reset;
  exportButton.onclick = () => {
    try {
      const blob = new Blob([JSON.stringify(store.exportBackup(), null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `GitHub空间-项目备份-${new Date().toLocaleDateString('en-CA')}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('项目备份已开始下载');
    } catch (error) { toast(error.message, true); }
  };
  $('#project-import-button').onclick = () => $('#project-backup-input').click();
  $('#project-backup-input').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > 4 * 1024 * 1024) throw Error('项目备份超过 4 MB，请检查文件。'); const added = store.importBackup(JSON.parse(await file.text())); reload(); toast(`已恢复 ${added} 个项目，已有收藏保持不变`); } catch (error) { toast(error instanceof SyntaxError ? '这个文件不是有效的项目备份 JSON。' : error.message, true); } finally { event.target.value = ''; }
  };
  document.addEventListener('click', event => {
    const target = event.target.closest('button, [data-project-open]'); if (!target) return;
    if (target.dataset.workspace) { switchWorkspace(target.dataset.workspace); return; }
    if (target.hasAttribute('data-project-close')) { target.closest('dialog').close(); return; }
    if (target.dataset.projectNav) { nav = target.dataset.projectNav; category = ''; render(); $('#sidebar').classList.remove('open'); return; }
    if (target.hasAttribute('data-project-category')) { category = target.dataset.projectCategory; nav = category ? 'category' : 'all'; render(); $('#sidebar').classList.remove('open'); return; }
    if (target.hasAttribute('data-project-reset')) { reset(); return; }
    if (target.id === 'project-focus-url') { $('#project-url').focus(); return; }
    if (target.dataset.projectFavorite) {
      try { const project = store.list().find(item => item.id === target.dataset.projectFavorite); if (!project) return; store.update(project.id, { favorite: !project.favorite }); reload(); if (dialog.open) showDetail(project.id); } catch (error) { toast(error.message, true); } return;
    }
    if (target.dataset.projectEdit) { showEditor(target.dataset.projectEdit); return; }
    if (target.dataset.projectRemove) {
      const project = projects.find(item => item.id === target.dataset.projectRemove); if (!project) return;
      confirmDialog.innerHTML = `<div class="modal-heading"><h2>移除这个收藏？</h2>${closeButton}</div><p>将从当前空间移除「${esc(project.name)}」。GitHub 上的项目仓库不受影响。</p><div class="modal-footer"><button class="outline-btn" data-project-close>取消</button><button class="danger-btn" id="project-confirm-remove">移除收藏</button></div>`; confirmDialog.showModal(); hydrateIcons(confirmDialog);
      $('#project-confirm-remove').onclick = () => { try { store.remove(project.id); reload(); confirmDialog.close(); editor.close(); toast('项目已从收藏中移除'); } catch (error) { toast(error.message, true); } }; return;
    }
    if (target.dataset.projectOpen) showDetail(target.dataset.projectOpen);
  });
  content.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.project-card')) { event.preventDefault(); showDetail(event.target.dataset.projectOpen); } });
  window.addEventListener('storage', event => { if (event.key === PROJECTS_KEY || event.key === null) { try { reload(); if (dialog.open) { if (projects.some(project => project.id === currentId)) showDetail(currentId); else dialog.close(); } } catch (error) { toast(error.message, true); } } });
  render(); hydrateIcons(content); hydrateIcons(exportButton);
  if (store) void loadProjectCatalog(store).then(() => reload()).catch(() => { status.className = 'form-error'; status.textContent = '预置项目暂未加载，刷新页面后可重试。已有收藏已保留。'; });
  let initial = 'skills'; try { initial = localStorage.getItem('skill-cabinet-active-workspace') === 'github' ? 'github' : 'skills'; } catch {}
  switchWorkspace(initial);
}
