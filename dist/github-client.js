export const MANIFEST_PATH = 'skill-cabinet/manifest.json';
export const MAX_ARCHIVE_BYTES = 45 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const FIELDS = ['id', 'name', 'slug', 'description', 'category', 'tags', 'version', 'author', 'favorite', 'createdAt', 'updatedAt'];
const encoder = new TextEncoder();

export class GitHubError extends Error {
  constructor(message, status, code) { super(message); this.name = 'GitHubError'; this.status = status; this.code = code; }
}
export function safeMetadata(value, slug) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('云端技能说明格式无效。');
  const result = {};
  for (const key of FIELDS) if (Object.hasOwn(value, key)) {
    if (key === 'tags') {
      if (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some(tag => typeof tag !== 'string' || tag.length > 500)) throw new Error('云端标签格式无效。');
      result.tags = [...value.tags];
    } else if (key === 'favorite') {
      if (typeof value.favorite !== 'boolean') throw new Error('云端收藏格式无效。');
      result.favorite = value.favorite;
    } else {
      if (typeof value[key] !== 'string' || value[key].length > 20000) throw new Error('云端技能说明过长或格式无效。');
      result[key] = value[key];
    }
  }
  if (result.slug !== slug || !result.name) throw new Error('云端技能标识与说明不一致。');
  return result;
}
export function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('云端清单版本或格式不受支持。');
  if (Object.keys(value.entries).length > 3000 || encoder.encode(JSON.stringify(value)).length > MAX_MANIFEST_BYTES) throw new Error('云端技能清单超过限制。');
  const entries = Object.create(null);
  for (const [slug, entry] of Object.entries(value.entries)) {
    if (!SLUG.test(slug) || !entry || typeof entry !== 'object') throw new Error('云端技能标识无效。');
    if (entry.deleted === true) {
      if (typeof entry.updatedAt !== 'string') throw new Error('云端删除记录无效。');
      entries[slug] = { deleted: true, updatedAt: entry.updatedAt };
    } else {
      if (!HASH.test(entry.fingerprint) || !HASH.test(entry.archiveSha256) || entry.archivePath !== `skill-cabinet/archives/${slug}-${entry.archiveSha256}.zip`) throw new Error('云端技能包路径或校验值无效。');
      entries[slug] = { fingerprint: entry.fingerprint, archiveSha256: entry.archiveSha256, archivePath: entry.archivePath, metadata: safeMetadata(entry.metadata, slug) };
    }
  }
  return { schemaVersion: 1, entries };
}
export async function sha256(value) {
  const bytes = value instanceof Blob ? await value.arrayBuffer() : typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64(bytes) {
  let string = '';
  for (let i = 0; i < bytes.length; i += 32768) string += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(string);
}
function decode64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 + 1000000) throw new Error('云端文件超过大小限制。');
  const string = atob(value.replace(/\s/g, ''));
  if (string.length > max) throw new Error('云端文件超过大小限制。');
  return Uint8Array.from(string, character => character.charCodeAt(0));
}

export class GitHubClient {
  constructor({ owner, repo, branch = 'main', token, fetchImpl = globalThis.fetch, timeoutMs = 45000 }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner || '') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo || '') || ['.', '..'].includes(repo)) throw new Error('GitHub 仓库名称无效。');
    if (!branch || branch.length > 250 || /[\s~^:?*\[\\\u0000-\u001f]/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) throw new Error('GitHub 分支名称无效。');
    if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error('请填写有效的 GitHub Token。');
    this.owner = owner; this.repo = repo; this.branch = branch; this.token = token; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.repoKey = `${owner.toLowerCase()}/${repo.toLowerCase()}@${branch}`;
    this.prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  async requestJson(path, { method = 'GET', body } = {}) {
    if (!(path === this.prefix || path.startsWith(`${this.prefix}/`)) || /[\r\n]/.test(path)) throw new Error('GitHub API 路径无效。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.github.com${path}`, { method, redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        const status = response.status;
        const message = status === 401 ? 'GitHub Token 无效或已过期。' : status === 403 ? 'GitHub 拒绝访问，请检查 Contents 读写权限、额度或仓库规则。' : status === 404 ? 'GitHub 仓库、分支或文件不存在，或 Token 无访问权限。' : [409, 422].includes(status) ? '远端分支发生变化或写入受仓库规则限制，请重新同步。' : `GitHub 请求失败（${status}）。`;
        throw new GitHubError(message, status, [409, 422].includes(status) ? 'REMOTE_CHANGED' : 'HTTP_ERROR');
      }
      return response.status === 204 ? null : await response.json();
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError(controller.signal.aborted ? 'GitHub 请求超时，本机数据已保留，请重试。' : '无法连接 GitHub，本机数据已保留，请检查网络后重试。', 0, 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
  async getHead() {
    const ref = await this.requestJson(`${this.prefix}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!GIT_SHA.test(ref?.object?.sha)) throw new Error('GitHub 返回了无效分支。');
    return ref.object.sha;
  }
  async getRepository() {
    const value = await this.requestJson(this.prefix);
    return { private: value.private === true, visibility: value.visibility || (value.private ? 'private' : 'public'), permissions: value.permissions || {}, default_branch: value.default_branch, html_url: value.html_url, full_name: value.full_name };
  }
  async readFile(path, head, max = MAX_ARCHIVE_BYTES, optional = false) {
    if (!GIT_SHA.test(head) || !/^(?:skill-cabinet\/manifest\.json|skill-cabinet\/archives\/[a-z0-9_-]+-[a-f0-9]{64}\.zip|dist\/assets\/[a-zA-Z0-9_.-]+\.(?:json|zip))$/.test(path)) throw new Error('云端读取路径无效。');
    let file;
    try { file = await this.requestJson(`${this.prefix}/contents/${path}?ref=${head}`); }
    catch (error) { if (optional && error.status === 404) return null; throw error; }
    if (file?.type !== 'file' || file.truncated || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > max) throw new Error('云端文件类型或大小不受支持，或内容不完整。');
    if (file.encoding === 'base64' && file.content) {
      const bytes = decode64(file.content, max);
      if (bytes.byteLength !== file.size) throw new Error('云端文件内容不完整。');
      return bytes;
    }
    if (!GIT_SHA.test(file.sha)) throw new Error('云端文件缺少有效内容引用。');
    const blob = await this.requestJson(`${this.prefix}/git/blobs/${file.sha}`);
    if (blob.encoding !== 'base64' || blob.truncated || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > max || blob.size !== file.size) throw new Error('云端文件无法完整读取或超过大小限制。');
    const bytes = decode64(blob.content, max);
    if (bytes.byteLength !== blob.size) throw new Error('云端文件内容不完整。');
    return bytes;
  }
  async getSnapshot() {
    const head = await this.getHead();
    const commit = await this.requestJson(`${this.prefix}/git/commits/${head}`);
    if (!GIT_SHA.test(commit?.tree?.sha)) throw new Error('GitHub 提交树无效。');
    const bytes = await this.readFile(MANIFEST_PATH, head, MAX_MANIFEST_BYTES, true);
    let manifest = null;
    if (bytes) { try { manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes))); } catch (error) { throw new Error(`云端清单无法读取：${error.message}`); } }
    return { head, treeSha: commit.tree.sha, manifest };
  }
  readArchive(path, head) { return this.readFile(path, head); }
  async getBootstrap(head) {
    head = typeof head === 'object' ? head.head : head;
    const bytes = await this.readFile('dist/assets/seed.json', head, MAX_MANIFEST_BYTES, true);
    if (!bytes) return [];
    const seeds = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(seeds) || seeds.length > 100) throw new Error('初始技能清单格式无效。');
    const result = [];
    for (const seed of seeds) {
      if (!SLUG.test(seed.slug) || !/^\.\/assets\/[a-zA-Z0-9_.-]+\.zip$/.test(seed.archiveUrl || '')) throw new Error('初始技能包路径无效。');
      result.push({ metadata: safeMetadata(seed, seed.slug), bytes: await this.readFile(`dist/${seed.archiveUrl.slice(2)}`, head) });
    }
    return result;
  }
  async writeSnapshot(snapshot, value, archives = new Map()) {
    const manifest = validateManifest(value);
    if (!GIT_SHA.test(snapshot.head) || !GIT_SHA.test(snapshot.treeSha)) throw new Error('同步快照无效。');
    const tree = [];
    for (const [path, input] of archives instanceof Map ? archives : Object.entries(archives)) {
      const entry = Object.values(manifest.entries).find(item => item.archivePath === path);
      const bytes = new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
      if (!entry || bytes.length > MAX_ARCHIVE_BYTES || await sha256(bytes) !== entry.archiveSha256) throw new Error('待上传技能包校验失败或超过 45 MB。');
      const blob = await this.requestJson(`${this.prefix}/git/blobs`, { method: 'POST', body: { content: base64(bytes), encoding: 'base64' } });
      if (!GIT_SHA.test(blob.sha)) throw new Error('GitHub 文件写入未确认。');
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const json = JSON.stringify(manifest, null, 2);
    if (encoder.encode(json).length > MAX_MANIFEST_BYTES) throw new Error('云端技能清单超过 2 MB。');
    tree.push({ path: MANIFEST_PATH, mode: '100644', type: 'blob', content: json });
    const nextTree = await this.requestJson(`${this.prefix}/git/trees`, { method: 'POST', body: { base_tree: snapshot.treeSha, tree } });
    if (!GIT_SHA.test(nextTree.sha)) throw new Error('GitHub 文件树写入未确认。');
    const commit = await this.requestJson(`${this.prefix}/git/commits`, { method: 'POST', body: { message: 'Sync personal Skill Cabinet', tree: nextTree.sha, parents: [snapshot.head] } });
    if (!GIT_SHA.test(commit.sha)) throw new Error('GitHub 提交写入未确认。');
    try {
      const ref = await this.requestJson(`${this.prefix}/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      if (ref?.object?.sha !== commit.sha) throw new Error('GitHub 分支更新未确认。');
    } catch (error) {
      // A dropped response can follow a successful update. Only the exact commit confirms it.
      let current; try { current = await this.getHead(); } catch { throw error; }
      if (current !== commit.sha) throw error;
    }
    return { head: commit.sha, treeSha: nextTree.sha, manifest };
  }
}
