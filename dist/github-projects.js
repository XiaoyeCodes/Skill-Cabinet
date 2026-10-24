export const PROJECTS_KEY = 'skill-cabinet-github-projects-v1';
const projectListeners = new Set();
export function onProjectsChanged(listener) { projectListeners.add(listener); return () => projectListeners.delete(listener); }
function notifyProjects(source) { for (const listener of projectListeners) { try { listener({ source }); } catch (error) { console.error('Project change listener failed', error); } } }
export const PROJECT_CATEGORIES = ['AI 与智能体', '开发工具', '网站与应用', '数据与分析', '设计与创作', '自动化工具', '金融与投资', '学习与资料', '其他项目'];
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function parseRepositoryUrl(input) {
  let value = text(input, 2048);
  if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)) value = `https://github.com/${value}`;
  else if (/^(?:www\.)?github\.com\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { throw Error('请粘贴有效的 GitHub 仓库地址，例如 https://github.com/owner/repository。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['github.com', 'www.github.com'].includes(url.hostname) || url.username || url.password || url.port) throw Error('目前支持 github.com 上的项目仓库地址。');
  const [owner, rawRepo] = url.pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner || '') || !/^[\w.-]{1,100}$/.test(repo || '') || ['.', '..'].includes(repo)) throw Error('这个地址缺少有效的仓库名称，请复制项目首页链接。');
  return { owner, repo, id: `${owner}/${repo}`.toLowerCase(), url: `https://github.com/${owner}/${repo}` };
}

export function readableReadme(source) {
  return text(source, 100000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:.*$/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\r\t]/g, '');
}

const RULES = [
  ['AI 与智能体', /\b(?:ai|llm|gpt|agent[s]?|chatbot|chatgpt|skills?|diffusion|machine.learning|deep.learning|rag|mcp)\b|人工智能|大模型|智能体|机器学习|技能管理/gi],
  ['金融与投资', /\b(?:trading|finance|financial|stock|quant|investment|portfolio|backtest|economic)\b|财经|金融|投资|股票|量化|经济/gi],
  ['设计与创作', /\b(?:design|animation|motion|illustration|creative|image.editor|video.editor|typography|figma|drawing)\b|设计|动效|绘图|图像编辑|创作工具|字体/gi],
  ['自动化工具', /\b(?:automation|automate|workflow|scraper|crawler|rpa|scheduler|n8n)\b|自动化|爬虫|定时任务|工作流/gi],
  ['数据与分析', /\b(?:data.analysis|analytics|visualization|database|data.science|pandas|sql|etl|dashboard|statistics)\b|数据分析|可视化|数据库|统计分析|数据科学/gi],
  ['网站与应用', /\b(?:react|vue|svelte|nextjs|next.js|website|web.app|frontend|fullstack|mobile.app|android|ios|flutter)\b|网站|前端|网页|移动应用|小程序/gi],
  ['学习与资料', /\b(?:awesome|tutorial|course|learning.resources|handbook|roadmap|interview|book|cheatsheet|notes)\b|教程|学习资料|面试|书单|知识库|笔记合集/gi],
  ['开发工具', /\b(?:developer|development|cli|sdk|framework|library|compiler|debug|terminal|editor|devtools|linter|api)\b|开发工具|命令行|编译|调试|代码编辑|开发框架/gi],
];
export function classifyProject(metadata, readme = '') {
  const fields = [[`${metadata.name || ''} ${metadata.description || ''}`, 5], [(metadata.topics || []).join(' '), 8], [readableReadme(readme).slice(0, 8000), 1]];
  const scored = RULES.map(([category, expression]) => ({ category, score: fields.reduce((sum, [value, weight]) => sum + Math.min([...value.matchAll(expression)].length, 5) * weight, 0) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score ? scored[0].category : '其他项目';
}

export function describeProject(metadata, readme = '') {
  const clean = readableReadme(readme);
  const paragraphs = clean.split(/\n\s*\n/).map(value => value.replace(/^\s*#{1,6}\s+/gm, '').replace(/[*_`]/g, '').trim())
    .filter(value => value.length >= 25 && !/^\s*(?:\||[-=*]{3}|\[|npm |pip |git clone)/.test(value) && !/^(?:license|installation|table of contents|目录)\b/i.test(value));
  const description = text(metadata.description, 1500);
  const chineseParagraph = paragraphs.find(value => /[\u4e00-\u9fff]/.test(value) && !/^(?:English|中文|简体中文)\s*[|·/]/i.test(value));
  const summary = /[\u4e00-\u9fff]/.test(description) ? description : chineseParagraph || description || paragraphs[0] || '项目暂未提供用途介绍，可以点击编辑补充。';
  return { description: summary.replace(/\s+/g, ' ').slice(0, 1500), readmeExcerpt: paragraphs.slice(0, 5).join('\n\n').slice(0, 4000) };
}

export async function inspectRepository(input, { token = '', fetchImpl = (...args) => globalThis.fetch(...args), signal } = {}) {
  const parsed = parseRepositoryUrl(input);
  const request = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}${path}`, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) {
      const error = new Error(response.status === 404 ? '没有找到这个仓库。请检查地址；私有仓库需要已连接的 GitHub 令牌具备该仓库的读取权限。' : response.status === 401 ? 'GitHub 令牌已失效，请在 Skills 空间重新连接 GitHub 后再试。' : [403, 429].includes(response.status) ? 'GitHub 暂时限制了访问，请稍后重试；也可先在 Skills 空间连接 GitHub，再添加项目。' : `GitHub 暂时无法读取项目（${response.status}），请稍后重试。`);
      error.status = response.status; throw error;
    }
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw Error('项目资料过大，请稍后重试。');
    return JSON.parse(raw);
  };
  try {
    const metadata = await request('');
    if (!metadata.name || !metadata.full_name) throw Error('GitHub 返回的项目资料不完整。');
    const canonical = parseRepositoryUrl(`https://github.com/${metadata.full_name}`);
    let readme = '', readmeStatus = 'missing';
    try {
      const file = await request('/readme');
      if (file.encoding === 'base64' && file.size <= 512 * 1024) {
        readme = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), character => character.charCodeAt(0)));
        readmeStatus = 'read';
      } else readmeStatus = 'unavailable';
    } catch (error) { if (signal?.aborted) throw error; readmeStatus = error.status === 404 ? 'missing' : 'unavailable'; }
    return sanitizeProject({ ...canonical, name: metadata.name, ...describeProject(metadata, readme), category: classifyProject(metadata, readme),
      tags: [...new Set([...(metadata.topics || []), metadata.language].filter(Boolean))].slice(0, 8), language: metadata.language,
      stars: metadata.stargazers_count, forks: metadata.forks_count, license: metadata.license?.spdx_id,
      homepage: metadata.homepage, repositoryUpdatedAt: metadata.pushed_at || metadata.updated_at,
      readmeStatus, archived: metadata.archived, favorite: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  } catch (error) {
    if (error.status || !(error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
    throw Error(error.name === 'AbortError' ? '已取消读取项目。' : '暂时无法连接 GitHub，请确认网络或 VPN 已开启，再试一次。');
  }
}

export function sanitizeProject(value) {
  if (!value || typeof value !== 'object') throw Error('项目备份格式无效。');
  const parsed = parseRepositoryUrl(value.url);
  if (value.id !== undefined && value.id !== parsed.id) throw Error('项目标识与地址不一致。');
  const validDate = date => typeof date === 'string' && !Number.isNaN(Date.parse(date)) ? date : new Date().toISOString();
  let homepage = '';
  try { const candidate = new URL(value.homepage); if (['https:', 'http:'].includes(candidate.protocol) && !candidate.username && !candidate.password) homepage = candidate.href; } catch {}
  return { ...parsed, name: text(value.name, 100) || parsed.repo, description: text(value.description, 1500), category: text(value.category, 30) || '其他项目',
    tags: [...new Set((Array.isArray(value.tags) ? value.tags : []).map(tag => text(tag, 50)).filter(Boolean))].slice(0, 8),
    language: text(value.language, 50), stars: Math.max(0, Number.isSafeInteger(value.stars) ? value.stars : 0), forks: Math.max(0, Number.isSafeInteger(value.forks) ? value.forks : 0),
    license: text(value.license, 50), homepage, readmeExcerpt: text(value.readmeExcerpt, 4000), readmeStatus: ['read', 'missing', 'unavailable'].includes(value.readmeStatus) ? value.readmeStatus : 'missing',
    repositoryUpdatedAt: validDate(value.repositoryUpdatedAt), archived: value.archived === true, favorite: value.favorite === true,
    createdAt: validDate(value.createdAt), updatedAt: validDate(value.updatedAt) };
}

export class ProjectStore {
  constructor(storage = globalThis.localStorage) { this.storage = storage; }
  readState() {
    const raw = this.storage.getItem(PROJECTS_KEY);
    if (!raw) return { projects: [], seededIds: [], sync: {} };
    let value;
    try { value = JSON.parse(raw); } catch { throw Error('项目收藏读取失败，已有数据仍保留在浏览器中。'); }
    if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 1000) throw Error('项目收藏格式不受支持，已有数据已保留。');
    const seededIds = value.seededIds || [];
    if (!Array.isArray(seededIds) || seededIds.length > 1000 || seededIds.some(id => typeof id !== 'string' || parseRepositoryUrl(id).id !== id)) throw Error('项目初始化记录无效，已有收藏已保留。');
    if (value.sync !== undefined && (!value.sync || typeof value.sync !== 'object' || Array.isArray(value.sync))) throw Error('项目同步记录无效，已有收藏已保留。');
    return { projects: value.projects.map(sanitizeProject), seededIds, sync: value.sync || {} };
  }
  list() { return this.readState().projects; }
  write(projects, seededIds = this.readState().seededIds, { sync = this.readState().sync, source = 'local' } = {}) {
    if (projects.length > 1000) throw Error('项目收藏已达到 1000 个，请先导出备份再整理。');
    const serialized = JSON.stringify({ schemaVersion: 1, projects, seededIds, sync });
    if (serialized.length > 3 * 1024 * 1024) throw Error('项目资料较多，请先导出备份再整理。');
    try { this.storage.setItem(PROJECTS_KEY, serialized); } catch { throw Error('浏览器空间不足或禁止保存，项目尚未保存，请先导出已有收藏。'); }
    notifyProjects(source);
  }
  snapshot() { return this.storage.getItem(PROJECTS_KEY); }
  getSyncBaseline(repoKey) { return this.readState().sync[repoKey]; }
  assertSnapshot(expected) {
    if (this.snapshot() !== expected) { const error = new Error('同步期间项目收藏又有修改，已保留本机数据，请重新同步。'); error.code = 'LOCAL_CHANGED'; throw error; }
  }
  applyCloud(plan, repoKey, head) {
    this.assertSnapshot(plan.expected);
    const state = this.readState();
    const baseline = { seenManifest: true, entries: plan.fingerprints, head, syncedAt: new Date().toISOString() };
    if (plan.restored || plan.deleted) baseline.recovery = state.projects;
    else if (state.sync[repoKey]?.recovery) baseline.recovery = state.sync[repoKey].recovery;
    // Projects, seed deletion markers and the confirmed baseline persist together.
    const seededIds = [...new Set([...state.seededIds, ...Object.keys(plan.entries)])];
    this.write(plan.records, seededIds, { sync: { ...state.sync, [repoKey]: baseline }, source: 'remote' });
  }
  add(record) {
    const project = sanitizeProject(record), projects = this.list();
    if (projects.some(item => item.id === project.id)) throw Error('这个项目已经在你的 GitHub 空间里了。');
    this.write([...projects, project]); return project;
  }
  update(id, changes) {
    const projects = this.list(), index = projects.findIndex(project => project.id === id);
    if (index < 0) throw Error('这个项目已被其他页面移除，请刷新后重试。');
    const current = projects[index];
    projects[index] = sanitizeProject({ ...current, ...changes, id: current.id, url: current.url, createdAt: current.createdAt, updatedAt: new Date().toISOString() });
    this.write(projects); return projects[index];
  }
  remove(id) { this.write(this.list().filter(project => project.id !== id)); }
  seedCatalog(value) {
    if (value?.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 1000) throw Error('预置项目目录格式无效，已有收藏已保留。');
    const incoming = value.projects.map(sanitizeProject), state = this.readState();
    const seen = new Set(state.seededIds), existing = new Set(state.projects.map(project => project.id));
    let added = 0;
    for (const project of incoming) {
      if (seen.has(project.id)) continue;
      if (!existing.has(project.id)) { state.projects.push(project); existing.add(project.id); added++; }
      seen.add(project.id);
    }
    if (added || seen.size !== state.seededIds.length) this.write(state.projects, [...seen]);
    return added;
  }
  importBackup(value) {
    if (value?.schemaVersion !== 1 || value?.type !== 'skill-cabinet-github-projects' || !Array.isArray(value.projects) || value.projects.length > 1000) throw Error('请选择由 GitHub 空间导出的项目备份 JSON。');
    const imported = value.projects.map(sanitizeProject), current = this.list(), ids = new Set(current.map(project => project.id));
    let added = 0;
    for (const project of imported) if (!ids.has(project.id)) { current.push(project); ids.add(project.id); added++; }
    this.write(current); return added;
  }
  exportBackup() { return { schemaVersion: 1, type: 'skill-cabinet-github-projects', exportedAt: new Date().toISOString(), projects: this.list() }; }
}

export function validateProjectEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) throw Error('云端项目清单格式无效或超过限制。');
  const entries = Object.create(null);
  for (const [id, entry] of Object.entries(value)) {
    if (parseRepositoryUrl(id).id !== id || !entry || typeof entry !== 'object') throw Error('云端项目标识无效。');
    if (entry.deleted === true) {
      if (typeof entry.updatedAt !== 'string' || Number.isNaN(Date.parse(entry.updatedAt))) throw Error('云端项目删除记录无效。');
      entries[id] = { deleted: true, updatedAt: entry.updatedAt };
    } else {
      if (!/^[a-f0-9]{64}$/.test(entry.fingerprint || '') || entry.record?.id !== id || !entry.record?.name) throw Error('云端项目说明或校验值无效。');
      for (const field of ['createdAt', 'updatedAt', 'repositoryUpdatedAt']) if (typeof entry.record[field] !== 'string' || Number.isNaN(Date.parse(entry.record[field]))) throw Error('云端项目日期无效。');
      entries[id] = { fingerprint: entry.fingerprint, record: sanitizeProject(entry.record) };
    }
  }
  return entries;
}

export async function loadProjectCatalog(store, { fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  const response = await fetchImpl('./assets/github-projects.json', { cache: 'no-cache' });
  if (response.status === 404) return 0;
  if (!response.ok) throw Error('暂时无法读取预置项目，刷新页面后可重试。');
  return store.seedCatalog(await response.json());
}
