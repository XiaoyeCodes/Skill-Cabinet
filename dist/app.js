import { initialize, listSkills, saveSkill, deleteSkill, importFiles, exportSkill, exportLibrary, formatBytes, getSkillContent, listCategories, saveCategories, onSkillsChanged } from './storage.js';
import { initializeGitHubSync } from './sync-ui.js';
import { RepositoryLibrary } from './repository-library.js';

const $ = (s,root=document)=>root.querySelector(s);
const $$ = (s,root=document)=>[...root.querySelectorAll(s)];
const paths={library:'M4 4h5v16H4zM12 4h4v16h-4zM18 5l3 1-2 14-3-1',star:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z',clock:'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',plus:'M12 5v14M5 12h14',upload:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',download:'M12 3v13m-5-5 5 5 5-5M4 16v4h16v-4',search:'m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',list:'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',x:'m6 6 12 12M6 18 18 6',check:'m5 12 4 4L19 6',help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-5',menu:'M4 6h16M4 12h16M4 18h16',edit:'m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z',copy:'M8 8h12v13H8zM16 8V3H3v13h5',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',file:'M14 2H5v20h14V7zM14 2v6h5',arrow:'M5 12h14m-5-5 5 5-5 5'};
const icon=(name)=>`<i data-icon="${name}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg></i>`;
function hydrateIcons(root=document){$$('i[data-icon]',root).forEach(el=>{if(!el.children.length)el.innerHTML=icon(el.dataset.icon).replace(/^<i[^>]*>|<\/i>$/g,'');});}
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const baseCategories=['图像与设计','写作与内容','开发与工具','效率与工作','学习与研究'];
let skills=[],nav='all',category='',query='',view='grid',currentDetail=null,detailTab='overview',fileUrl=null;
let customCategories=[], editorBaseRevision=null, githubSync;
try{const v=JSON.parse(localStorage.getItem('skill-cabinet-categories')||'[]');if(Array.isArray(v))customCategories=v.filter(x=>typeof x==='string'&&x.trim()&&x.length<=30&&!/[\u0000-\u001f]/.test(x));}catch{}
const categories=()=>[...new Set([...baseCategories,...customCategories,...skills.map(s=>s.category||'未分类')])];
function toast(text,error=false){const node=document.createElement('div');node.className='toast'+(error?' error':'');node.textContent=text;$('#toasts').append(node);setTimeout(()=>node.remove(),4500);}
function openDialog(id){const dialog=$(id);if(!dialog.open)dialog.showModal();return dialog;}
function closeDialog(dialog){if(dialog.id==='detail-dialog'&&fileUrl){URL.revokeObjectURL(fileUrl);fileUrl=null;}dialog.close();}
function closeAll(){ $$('dialog[open]').forEach(closeDialog); }
function showImport(){ $('#import-result').innerHTML='';openDialog('#import-dialog');}
const date=(value)=>{const d=new Date(value);return Number.isNaN(d.getTime())?'刚刚':d.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}).replace('/','.');};
function artwork(s){const seed=[...s.slug||s.name].reduce((n,c)=>n+c.charCodeAt(0),0);if(s.slug==='shiguang-atlas'||/图|设计/.test(s.category))return `<svg viewBox="0 0 230 150" fill="none" aria-hidden="true"><g stroke="#696347" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M114 131V25M113 119C75 109 54 81 54 63c27 1 49 20 59 56ZM115 104c36-11 61-35 62-57-29 0-54 23-62 57ZM113 80C89 65 77 43 83 24c21 11 31 30 30 56ZM115 59c19-8 32-28 28-42-21 7-28 22-28 42Z"/><path d="m58 67 55 51M173 51l-58 52M86 29l27 51M140 22l-25 37M60 76l24 2M74 91l25 1M171 61l-26 1M157 78l-27 1M88 44l14 1M140 31l-14 1M109 135h13"/><path d="M45 127h140M43 25h16M51 17v16M185 106h12M191 100v12" stroke="#a49a7e"/><circle cx="182" cy="25" r="12" stroke="#b67a5d"/><path d="M176 25h12M182 19v12" stroke="#b67a5d"/></g><path d="M58 112c-3-7-9-10-15-9 0 7 6 12 15 9Z" fill="#b67a5d" opacity=".65"/></svg>`;return `<svg viewBox="0 0 230 150" fill="none" aria-hidden="true"><g stroke="#786f57" stroke-width="1.2" stroke-linecap="round"><path d="M65 32c20-4 36 1 50 9 14-8 30-13 50-9v87c-20-4-36 1-50 9-14-8-30-13-50-9zM115 41v87M75 47c9-1 20 2 29 7M75 59c9-1 20 2 29 7M75 71c9-1 20 2 29 7M75 83c9-1 20 2 29 7M126 54c9-5 20-8 29-7M126 66c9-5 20-8 29-7M126 78c9-5 20-8 29-7M126 90c9-5 20-8 29-7M55 38v88c22-3 41 3 60 11 19-8 38-14 60-11V38"/><path d="M180 28v18M171 37h18M43 104h11M48 99v11" stroke="#bd7859"/></g><circle cx="${50+seed%18}" cy="30" r="3" fill="#bd7859"/></svg>`;}
function render(){
  $('#all-count').textContent=skills.length;$('#favorite-count').textContent=skills.filter(s=>s.favorite).length;
  const labels={all:'全部 Skill',favorites:'我的收藏',recent:'最近更新',category:category};
  $('#page-label').textContent=labels[nav];$('#library-title').textContent=nav==='all'?'我的技能库':labels[nav];
  $$('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===nav));
  $('#category-nav').innerHTML=categories().map((c,i)=>`<button class="nav-item ${nav==='category'&&category===c?'active':''}" data-category="${esc(c)}"><span class="category-dot" style="background:${['#b59b77','#8e9b83','#8a959e','#be8f7c','#a49aaf'][i%5]}"></span>${esc(c)}<span class="nav-count">${skills.filter(s=>s.category===c).length||''}</span></button>`).join('');
  $('#category-filters').innerHTML=[['','全部'],...categories().filter(c=>skills.some(s=>s.category===c)).map(c=>[c,c])].map(([value,label])=>`<button class="chip ${category===value?'active':''}" data-filter="${esc(value)}">${esc(label)}${!value?`<span class="chip-count">${skills.length}</span>`:''}</button>`).join('');
  let filtered=skills.filter(s=>(nav!=='favorites'||s.favorite)&&(!category||s.category===category)&&(!query||[s.name,s.description,s.slug,...s.tags||[]].join(' ').toLowerCase().includes(query)));
  const sort=$('#sort').value;
  filtered.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'zh-CN'):new Date(sort==='created'?b.createdAt:b.updatedAt)-new Date(sort==='created'?a.createdAt:a.updatedAt));
  $('#result-count').textContent=`${filtered.length} 个 Skill`;
  $('#reset-filters').hidden=!(category||query||nav!=='all');
  $('#skill-grid').classList.toggle('list-view',view==='list');
  $('#grid-button').classList.toggle('active',view==='grid');$('#list-button').classList.toggle('active',view==='list');$('#grid-button').setAttribute('aria-pressed',view==='grid');$('#list-button').setAttribute('aria-pressed',view==='list');
  const addCard=`<button class="add-card" id="add-card"><span class="add-mark">＋</span><h3>下一种能力，由你定义。</h3><p>把亲手打磨的方法收进来，<br>让每一次好想法都有迹可循。</p><span class="add-link">导入你的 Skill ↗</span></button>`;
  if(!filtered.length&&(query||category||nav==='favorites'))$('#skill-grid').innerHTML=`<div class="empty-state"><span style="font-size:35px;color:#bda98e">✳</span><h3>${nav==='favorites'?'留一个位置，给常用的好方法。':'还没有找到这份灵感。'}</h3><p>${nav==='favorites'?'点击 Skill 卡片右上角的星标，即可收藏。':'试试其他关键词，或者清除筛选看看。'}</p><button class="outline-btn" id="empty-reset">查看全部 Skill</button></div>`;
  else $('#skill-grid').innerHTML=filtered.map((s,i)=>`<article class="skill-card" tabindex="0" role="button" data-open="${esc(s.id)}" aria-label="查看 ${esc(s.name)}"><button class="favorite-btn ${s.favorite?'is-favorite':''}" data-favorite="${esc(s.id)}" aria-label="${s.favorite?'取消收藏':'收藏'} ${esc(s.name)}" aria-pressed="${!!s.favorite}">${icon('star')}</button><div class="card-art"><span class="art-number">NO. ${String(i+1).padStart(2,'0')}</span>${artwork(s)}<span class="art-caption">${s.slug==='shiguang-atlas'?'A FIELD GUIDE TO CURIOSITY':'IDEAS INTO PRACTICE'}</span></div><div class="card-content"><div class="card-eyebrow">${esc(s.category||'未分类')}</div><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><div class="card-tags">${(s.tags||[]).slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="card-footer"><span class="version">v${esc(s.version||'1.0.0')}</span><span>·</span><span>${date(s.updatedAt)} 更新</span><span class="card-arrow">↗</span></div></div></article>`).join('')+addCard+(filtered.length===1?`<div class="shelf-note"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M50 17v66M17 50h66M27 27l46 46M27 73l46-46M38 20l24 60M20 38l60 24M20 62l60-24M38 80l24-60"/></svg><p>小小的技能，<br>大大的可能。</p><small>A GROWING COLLECTION</small></div>`:'');
  hydrateIcons();
}
async function refresh(){[skills,customCategories]=await Promise.all([listSkills(),listCategories()]);render();}
function reset(){category='';nav='all';query='';$('#search').value='';render();}
function showEditor(s=null){
  editorBaseRevision=s ? s.localRevision : null;
  const f=$('#editor-form');f.reset();$('#editor-error').textContent='';$('#editor-title').textContent=s?'打磨你的好方法。':'记录一种新能力。';
  $('#editor-category').innerHTML=categories().map(c=>`<option>${esc(c)}</option>`).join('');
  const defaults={name:'',slug:'',category:category||baseCategories[0],version:'1.0.0',description:'',tags:[],author:'',instructions:'',content:'# 我的 Skill\n\n## 功能\n\n描述这个 Skill 解决的问题。\n\n## 工作流程\n\n1. 理解用户的需求\n2. 执行任务\n3. 检查并交付结果'};
  const data=s||defaults;
  ['id','name','slug','category','version','description','tags','author','instructions','content'].forEach(key=>{f.elements[key].value=key==='tags'?(data.tags||[]).join(', '):data[key]||'';});
  if($('#detail-dialog').open)closeDialog($('#detail-dialog'));openDialog('#editor-dialog');
}
function inline(text){return esc(text).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>');}
function markdown(text){
  const clean=String(text||'').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'');
  let code=false,buf='',out='',listType='';
  const closeList=()=>{if(listType){out+=`</${listType}>`;listType='';}};
  for(const line of clean.split(/\r?\n/)){
    if(/^```/.test(line)){closeList();if(code){out+=`<pre>${esc(buf)}</pre>`;buf='';}code=!code;continue;}
    if(code){buf+=line+'\n';continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)/);const li=line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)/);
    if(heading){closeList();out+=`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;}
    else if(li){const type=li[2]?'ol':'ul';if(listType!==type){closeList();out+=`<${type}>`;listType=type;}out+=`<li>${inline(li[3])}</li>`;}
    else{closeList();if(/^>/.test(line))out+=`<blockquote>${inline(line.replace(/^>\s?/,''))}</blockquote>`;else if(line.trim())out+=`<p>${inline(line)}</p>`;}
  }
  closeList();if(buf)out+=`<pre>${esc(buf)}</pre>`;return out||'<p>还没有填写说明。点击「编辑」补充你的使用方法。</p>';
}
function showDetail(id,tab='overview'){
  const s=skills.find(s=>s.id===id);if(!s)return;currentDetail=id;detailTab=tab;if(fileUrl){URL.revokeObjectURL(fileUrl);fileUrl=null;}
  const d=$('#detail-dialog');
  d.innerHTML=`<div class="detail-top"><div class="modal-heading"><div><div class="card-eyebrow">${esc(s.category||'未分类')}</div><h2>${esc(s.name)}</h2></div><button class="icon-btn close-dialog" aria-label="关闭">${icon('x')}</button></div><div class="detail-slug">${esc(s.slug)}</div><p class="detail-description">${esc(s.description)}</p><div class="card-tags">${(s.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="detail-actions"><button class="primary-btn" data-export="${esc(s.id)}">${icon('download')}导出技能包</button><button class="outline-btn" data-edit="${esc(s.id)}">${icon('edit')}编辑</button><button class="outline-btn" id="copy-content">${icon('copy')}复制指令</button><button class="icon-btn ${s.favorite?'is-favorite':''}" data-favorite="${esc(s.id)}" aria-label="${s.favorite?'取消收藏':'收藏'}">${icon('star')}</button><button class="icon-btn danger-text" id="delete-current" aria-label="删除 Skill">${icon('trash')}</button></div></div><div class="detail-tabs" role="tablist" aria-label="Skill 内容"><button class="detail-tab ${tab==='overview'?'active':''}" data-tab="overview" role="tab" aria-selected="${tab==='overview'}">功能与指令</button><button class="detail-tab ${tab==='usage'?'active':''}" data-tab="usage" role="tab" aria-selected="${tab==='usage'}">使用说明</button><button class="detail-tab ${tab==='files'?'active':''}" data-tab="files" role="tab" aria-selected="${tab==='files'}">文件 <small>${s.files?.length||0}</small></button></div><div class="detail-body" role="tabpanel">${tab==='overview'?`<div class="detail-meta"><span><strong>版本</strong>${esc(s.version||'1.0.0')}</span><span><strong>作者</strong>${esc(s.author||'未填写')}</span><span><strong>更新</strong>${esc(new Date(s.updatedAt).toLocaleDateString('zh-CN'))}</span></div><div class="markdown">${markdown(getSkillContent(s))}</div>`:tab==='usage'?`<div class="markdown">${markdown(s.instructions)}</div>`:`<p class="muted">完整保存的文件 · ${formatBytes((s.files||[]).reduce((n,f)=>n+f.data.size,0))} · 点击预览，脚本只展示文本</p><div class="file-list">${(s.files||[]).map((f,i)=>`<button class="file-row" data-file="${i}"><span>${icon('file')} ${esc(f.path)}</span><span class="file-size">${formatBytes(f.data.size)} ↗</span></button>`).join('')||'<p class="muted">新建 Skill 将在导出时生成 SKILL.md。</p>'}</div>`}</div>`;
  hydrateIcons(d);if(!d.open)d.showModal();
}
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function importSelected(files){
  if(!files.length)return;
  const target=$('#import-result');target.innerHTML='<div class="import-message">正在读取文件并保存，请稍候…</div>';$('#drop-zone').style.pointerEvents='none';
  try{const result=await importFiles([...files]);await refresh();target.innerHTML=result.imported.map(s=>`<div class="import-message">✓ 已保存「${esc(s.name)}」· ${s.files.length} 个文件</div>`).join('')+result.skipped.map(s=>`<div class="import-message">${esc(s.name)}：${esc(s.reason)}</div>`).join('')+result.errors.map(s=>`<div class="import-message error">${esc(s.name)}：${esc(s.message)}</div>`).join('');if(result.imported.length)toast(`已收好 ${result.imported.length} 个 Skill`);}
  catch(e){target.innerHTML=`<div class="import-message error">${esc(e.message)}</div>`;}
  finally{$('#file-input').value='';$('#drop-zone').style.pointerEvents='';}
}
$('#import-button').onclick=showImport;$('#new-button').onclick=()=>showEditor();$('#help-button').onclick=()=>openDialog('#help-dialog');
$('#search').oninput=e=>{query=e.target.value.trim().toLowerCase();render();};$('#sort').onchange=render;
$('#grid-button').onclick=()=>{view='grid';render();};$('#list-button').onclick=()=>{view='list';render();};$('#reset-filters').onclick=reset;
$('#mobile-menu').onclick=()=>$('#sidebar').classList.toggle('open');
$('#file-input').onchange=e=>importSelected(e.target.files);
$('#drop-zone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#file-input').click();}};
$('#backup-button').onclick=async()=>{if(!skills.length)return toast('仓库还是空的，先收进一个 Skill 吧');const b=$('#backup-button');b.disabled=true;try{download(await exportLibrary(skills),`Skill-Cabinet-备份-${new Date().toLocaleDateString('en-CA')}.zip`);toast('仓库备份已开始下载');}catch(e){toast(e.message,true);}finally{b.disabled=false;}};
$('#editor-form').onsubmit=async e=>{e.preventDefault();const f=e.target,values=Object.fromEntries(new FormData(f)),button=$('#save-button');$('#editor-error').textContent='';button.disabled=true;try{const latest=await listSkills();const existing=latest.find(s=>s.id===values.id);if(values.id&&(!existing||existing.localRevision!==editorBaseRevision))throw Error('这个 Skill 在编辑期间已被其他页面或云端修改。当前输入已保留，请先复制文本，再关闭编辑并查看最新版本。');const slug=values.slug.trim();if(latest.some(s=>s.slug===slug&&s.id!==values.id))throw Error('这个技能标识已存在，请换一个标识。');const record={...existing,...values,id:existing?.id||crypto.randomUUID(),slug,name:values.name.trim(),description:values.description.trim(),tags:values.tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean).slice(0,8),version:values.version.trim()||'1.0.0',files:existing?.files||[],favorite:existing?.favorite||false,createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};if(!record.name||!record.description||!record.content.trim())throw Error('请填写名称、功能介绍和 SKILL.md 正文。');await saveSkill(record,{expectedRevision:editorBaseRevision});await refresh();closeDialog($('#editor-dialog'));toast('好方法，已经收好了');showDetail(record.id);}catch(err){$('#editor-error').textContent=err.message;}finally{button.disabled=false;}};
$('#add-category').onclick=()=>{ $('#category-input').value='';$('#category-error').textContent='';openDialog('#category-dialog');};
$('#category-form').onsubmit=async e=>{e.preventDefault();const name=$('#category-input').value.trim();if(!name)return;if(categories().includes(name)){$('#category-error').textContent='这个分类已经存在。';return;}const button=e.submitter;button.disabled=true;try{customCategories=await saveCategories([...customCategories,name]);render();closeDialog($('#category-dialog'));toast('已添加分类，正在保存到仓库');await checkRepository();}catch(error){$('#category-error').textContent=error.message||'分类保存失败，请检查浏览器存储权限。';}finally{button.disabled=false;}};
document.addEventListener('click',async e=>{
  const close=e.target.closest('.close-dialog');if(close){closeDialog(close.closest('dialog'));return;}
  const navBtn=e.target.closest('[data-nav]');if(navBtn){nav=navBtn.dataset.nav;category='';if(nav==='recent')$('#sort').value='updated';$('#sidebar').classList.remove('open');render();return;}
  const cat=e.target.closest('[data-category]');if(cat){category=cat.dataset.category;nav='category';$('#sidebar').classList.remove('open');render();return;}
  const filter=e.target.closest('[data-filter]');if(filter){category=filter.dataset.filter;if(nav==='category')nav='all';render();return;}
  const fav=e.target.closest('[data-favorite]');if(fav){e.stopPropagation();const s=skills.find(s=>s.id===fav.dataset.favorite);if(!s)return;try{await saveSkill({...s,favorite:!s.favorite},{expectedRevision:s.localRevision});await refresh();if($('#detail-dialog').open)showDetail(s.id,detailTab);}catch(err){toast(err.message,true);}return;}
  const detail=e.target.closest('[data-open]');if(detail){showDetail(detail.dataset.open);return;}
  if(e.target.closest('#add-card')){showImport();return;}
  if(e.target.closest('#empty-reset')){reset();return;}
  const edit=e.target.closest('[data-edit]');if(edit){showEditor(skills.find(s=>s.id===edit.dataset.edit));return;}
  const ex=e.target.closest('[data-export]');if(ex){ex.disabled=true;try{const s=skills.find(s=>s.id===ex.dataset.export);download(await exportSkill(s),`${s.slug}.zip`);toast('技能包已开始下载');}catch(err){toast(err.message,true);}finally{ex.disabled=false;}return;}
  const tab=e.target.closest('[data-tab]');if(tab){showDetail(currentDetail,tab.dataset.tab);return;}
  if(e.target.closest('#copy-content')){try{await navigator.clipboard.writeText(getSkillContent(skills.find(s=>s.id===currentDetail)));toast('完整指令已复制');}catch{toast('复制失败，请在编辑页面手动复制',true);}return;}
  if(e.target.closest('#delete-current')){const s=skills.find(s=>s.id===currentDetail);$('#confirm-copy').textContent=`将删除「${s.name}」及其文件。${githubSync?.isConnected()?'下次同步也会删除云端版本，并同步到其他设备。':''}建议先导出一份备份。`;openDialog('#confirm-dialog');$('#confirm-action').onclick=async()=>{try{await deleteSkill(s.id);closeDialog($('#confirm-dialog'));closeDialog($('#detail-dialog'));await refresh();toast('已从书架移除');}catch(err){toast(err.message,true);}};return;}
  const file=e.target.closest('[data-file]');if(file){const f=skills.find(s=>s.id===currentDetail).files[Number(file.dataset.file)];const body=$('.detail-body');body.innerHTML=`<button class="file-back" id="back-files">← 返回文件列表</button><div class="detail-slug">${esc(f.path)}</div>`;if(/\.(png|jpg|jpeg|gif|webp)$/i.test(f.path)){fileUrl=URL.createObjectURL(f.data);const img=document.createElement('img');img.className='file-preview-image';img.alt=f.path;img.src=fileUrl;body.append(img);}else if(/\.(md|txt|json|py|js|ts|html|css|csv|ya?ml|toml|sh)$/i.test(f.path)){if(f.data.size>1024*1024){const p=document.createElement('p');p.textContent='文件较大，请导出技能包后查看。';body.append(p);}else{const pre=document.createElement('pre');pre.className='file-content';const record=skills.find(s=>s.id===currentDetail);pre.textContent=/^SKILL\.md$/i.test(f.path)?getSkillContent(record):f.path==='使用说明.md'?record.instructions:await f.data.text();body.append(pre);}}else{const p=document.createElement('p');p.textContent='此类文件请导出技能包后查看。';body.append(p);}return;}
  if(e.target.closest('#back-files')){showDetail(currentDetail,'files');return;}
  if($('#sidebar').classList.contains('open')&&!e.target.closest('.sidebar')&&!e.target.closest('#mobile-menu'))$('#sidebar').classList.remove('open');
});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)&&!$('dialog[open]')){e.preventDefault();$('#search').focus();}if((e.key==='Enter'||e.key===' ')&&e.target.matches('.skill-card')){e.preventDefault();showDetail(e.target.dataset.open);}if(e.target.matches('.detail-tab')&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const tabs=$$('.detail-tab'),index=tabs.indexOf(e.target);const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;const nextTab=tabs[next].dataset.tab;showDetail(currentDetail,nextTab);$(`[data-tab="${nextTab}"]`).focus();}});
$$('dialog').forEach(d=>{d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog(d);}});d.addEventListener('close',()=>{if(d.id==='detail-dialog'&&fileUrl){URL.revokeObjectURL(fileUrl);fileUrl=null;}});});
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')){e.preventDefault();dragDepth++;$('#global-drop').hidden=false;}});
document.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('#global-drop').hidden=true;});
document.addEventListener('drop',e=>{if(!e.dataTransfer?.files.length)return;e.preventDefault();dragDepth=0;$('#global-drop').hidden=true;closeAll();showImport();importSelected(e.dataTransfer.files);});
hydrateIcons();
const repositoryLibrary = new RepositoryLibrary();
let checkingRepository = false;
async function refreshLibraryView() {
  await refresh();
  if ($('#detail-dialog').open) {
    if (skills.some(s => s.id === currentDetail)) showDetail(currentDetail, detailTab);
    else closeDialog($('#detail-dialog'));
  }
}
async function checkRepository() {
  if (checkingRepository) return;
  checkingRepository = true;
  const status = $('#repository-status'), button = $('#repository-refresh');
  button.disabled = true;
  try {
    const result = await repositoryLibrary.refresh();
    if (!result.available) {
      await initialize();
      status.textContent = '当前使用内置技能库；自动检查仓库更新';
      await refreshLibraryView();
    } else {
      status.textContent = `本地仓库 ${result.count} 个 Skill · 每 5 秒检查更新${result.preserved.length ? ` · 已保留 ${result.preserved.length} 项本地差异` : ''}${result.categoriesOnDisk ? ' · 自定义分类已保存到仓库' : ' · 分类仅在浏览器保存，可连接 GitHub 同步'}`;
      status.title = result.preserved.length ? `以下技能保留了浏览器中的修改或删除：${result.preserved.join('、')}` : 'git pull 后自动读取仓库的新内容，无需连接 GitHub。';
      if (result.changed) await refreshLibraryView();
    }
    status.removeAttribute('data-error');
  } catch (error) {
    await refreshLibraryView();
    status.textContent = `${error.message || '读取仓库失败'} 将自动重试。`;
    status.setAttribute('data-error', 'true');
  } finally {
    checkingRepository = false;
    button.disabled = false;
  }
}
try {
  skills = await initialize({ seed: false });
  customCategories = await saveCategories(customCategories);
  render();
  onSkillsChanged(event => {
    if (event.categoriesChanged) {
      void refreshLibraryView();
      if (event.source === 'local') void checkRepository();
    }
  });
  await checkRepository();
  githubSync = initializeGitHubSync({ toast, onRefresh: refreshLibraryView });
  $('#repository-refresh').onclick = () => checkRepository();
  setInterval(() => { if (!document.hidden) void checkRepository(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkRepository(); });
  window.addEventListener('focus', () => { void checkRepository(); });
} catch(e) {
  $('#skill-grid').innerHTML=`<div class="empty-state"><h3>暂时无法打开技能库</h3><p>${esc(e.message)}</p><p>请检查浏览器存储权限后刷新页面。</p></div>`;
  toast(e.message,true);
}

