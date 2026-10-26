const $ = selector => document.querySelector(selector);
let originalNote, originalCaption;

export function switchWorkspace(value) {
  const workspace = ['skills', 'github', 'prompts'].includes(value) ? value : 'skills';
  const note = $('.local-note small'), caption = $('.local-note p').firstChild;
  originalNote ??= note.innerHTML; originalCaption ??= caption.textContent;
  for (const name of ['skills', 'github', 'prompts']) {
    document.body.classList.toggle(`${name}-workspace`, name === workspace);
    for (const suffix of ['content', 'navigation']) {
      const node = $(`#${name}-${suffix}`); if (node) node.hidden = name !== workspace;
    }
  }
  const names = { skills: 'Skills 空间', github: 'GitHub 空间', prompts: '提示词收录' };
  document.title = `Skill Cabinet · ${names[workspace]}`;
  for (const [id, owner] of Object.entries({ 'page-label': 'skills', 'github-page-label': 'github', 'prompts-page-label': 'prompts', 'backup-button': 'skills', 'project-export': 'github', 'prompts-export': 'prompts' })) {
    const node = $(`#${id}`); if (node) node.hidden = owner !== workspace;
  }
  note.innerHTML = workspace === 'prompts' ? '自动保存到本机项目<br>随代码提交，让灵感随你同行。' : workspace === 'github' ? '项目先保存到本机<br>连接 GitHub，两个空间一起同步。' : originalNote;
  caption.textContent = workspace === 'prompts' ? '你的表达，值得好好收藏。' : workspace === 'github' ? '你的项目，值得好好收藏。' : originalCaption;
  $('.breadcrumb > span:not(.slash)').textContent = names[workspace];
  for (const button of document.querySelectorAll('[data-workspace]')) {
    const selected = button.dataset.workspace === workspace;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  }
  $('#sidebar').classList.remove('open');
  try { localStorage.setItem('skill-cabinet-active-workspace', workspace); } catch {}
  if (location.hash !== `#${workspace}`) history.replaceState(null, '', `#${workspace}`);
}

export function restoreWorkspace() {
  let initial = 'skills';
  try { initial = localStorage.getItem('skill-cabinet-active-workspace') || initial; } catch {}
  if (['skills', 'github', 'prompts'].includes(location.hash.slice(1))) initial = location.hash.slice(1);
  switchWorkspace(initial);
  window.addEventListener('hashchange', () => switchWorkspace(location.hash.slice(1)));
}
