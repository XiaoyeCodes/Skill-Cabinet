import { getSkillContent } from './storage.js';
import { sha256, safeMetadata, MAX_ARCHIVE_BYTES } from './github-client.js';
import { mergeCategories } from './categories.js';
import { prepareProjectSync } from './project-sync.js';

const present = entry => entry && !entry.deleted ? entry.fingerprint : null;
const own = (value, key) => Object.hasOwn(value || {}, key);
const stamp = () => new Date().toISOString();
export async function fingerprintSkill(record) {
  const files = [];
  const paths = new Set();
  for (const file of record.files || []) {
    if (file.path.toLowerCase() === 'skill.md' || file.path.toLowerCase() === '使用说明.md') continue;
    if (paths.has(file.path)) throw new Error('技能中存在重复文件路径。');
    paths.add(file.path);
    files.push([file.path, await sha256(file.data)]);
  }
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha256(JSON.stringify({ markdown: getSkillContent(record), instructions: String(record.instructions || ''), favorite: Boolean(record.favorite), files }));
}
async function indexSkills(records) {
  const result = new Map();
  for (const record of records) {
    if (result.has(record.slug)) throw new Error('本地技能标识重复，无法安全同步。');
    result.set(record.slug, { record, fingerprint: await fingerprintSkill(record) });
  }
  return result;
}
const fingerprints = index => Object.fromEntries([...index].map(([slug, value]) => [slug, value.fingerprint]));
async function localSignature(index) { return sha256(JSON.stringify(Object.entries(fingerprints(index)).sort(([a], [b]) => a.localeCompare(b)))); }

export class SyncEngine {
  constructor({ client, storage, projectStore, onState = () => {} }) {
    this.client = client; this.storage = storage; this.projectStore = projectStore; this.onState = onState;
    this.baseKey = `baseline:${client.repoKey}`;
    this.recoveryKey = `recovery:${client.repoKey}`;
    this.running = false;
  }
  state(status, message, extra = {}) { const state = { status, message, ...extra }; this.onState(state); return state; }
  async sync({ resolutions } = {}) {
    if (this.running) return this.state('pending', '同步正在进行，稍后会检查新修改。');
    this.running = true;
    this.state('syncing', '正在读取 GitHub，比较两个空间的修改…');
    try { return await this.performSync(resolutions); }
    catch (error) {
      this.state(error.code === 'LOCAL_CHANGED' ? 'pending' : 'error', error.message || '同步失败，本机数据已保留。', { code: error.code });
      throw error;
    } finally { this.running = false; }
  }
  async performSync(resolutions) {
    const storage = this.storage;
    const records = await storage.listSkills();
    const localCategories = await storage.listCategories();
    const local = await indexSkills(records);
    const signature = await sha256(`${await localSignature(local)}:${JSON.stringify(localCategories)}`);
    const base = await storage.getSyncMeta(this.baseKey) || { entries: {}, seenManifest: false };
    const snapshot = await this.client.getSnapshot();
    const projects = this.projectStore ? await prepareProjectSync(this.projectStore, this.client.repoKey, snapshot.manifest, snapshot.head, resolutions) : null;
    if (!snapshot.manifest && base.seenManifest) throw new Error('远端同步清单已被删除。为防止覆盖，请先在 GitHub 恢复清单再同步。');
    const remote = snapshot.manifest?.entries || Object.create(null);
    const remoteRecords = new Map();
    if (!snapshot.manifest && this.client.getBootstrap) {
      for (const item of await this.client.getBootstrap(snapshot)) {
        const parsed = await storage.decodeSkillArchive(new Blob([item.bytes]));
        if (parsed.length !== 1) throw new Error('初始云端技能包必须仅包含一个技能。');
        const record = { ...parsed[0], ...item.metadata, files: parsed[0].files };
        if (remoteRecords.has(record.slug)) throw new Error('初始云端技能标识重复。');
        const fp = await fingerprintSkill(record);
        remote[record.slug] = { fingerprint: fp, metadata: safeMetadata(record, record.slug), bootstrap: true };
        remoteRecords.set(record.slug, record);
      }
    }
    const token = await sha256(`${snapshot.head}:${signature}:${JSON.stringify(base.entries)}`);
    if (resolutions && resolutions.token !== token) throw new Error('本机或远端内容已变化，请重新比较冲突。');
    const choices = resolutions?.choices || {};
    const allSlugs = new Set([...local.keys(), ...Object.keys(remote), ...Object.keys(base.entries)]);
    const selected = new Map();
    const conflicts = [];
    for (const slug of [...allSlugs].sort()) {
      const l = local.get(slug)?.fingerprint || null;
      const r = present(remote[slug]);
      const b = base.entries[slug] || null;
      let side;
      // On a new device, bundled seeds may reappear locally after a cloud deletion.
      // Treat that as a conflict rather than silently resurrecting a deleted skill.
      const collision = own(base.entries, slug) ? l !== b && r !== b && l !== r : l && ((r && l !== r) || remote[slug]?.deleted);
      if (collision) {
        if (choices[slug] === 'local' || choices[slug] === 'remote') side = choices[slug];
        else { conflicts.push({ slug, local: local.get(slug)?.record || null, remote: remote[slug]?.deleted ? null : remote[slug]?.metadata || null, base: b }); continue; }
      } else if (l === r) side = r ? 'remote' : 'local';
      else if (!own(base.entries, slug)) side = l ? 'local' : 'remote';
      else side = l !== b ? 'local' : 'remote';
      selected.set(slug, side);
    }
    conflicts.push(...(projects?.conflicts || []));
    if (conflicts.length) return this.state('conflict', `发现 ${conflicts.length} 个冲突，请选择保留哪一份。`, { conflicts, conflictToken: token, projectToken: projects?.token });
    const categories = mergeCategories(localCategories, snapshot.manifest?.categories || []);
    const next = { schemaVersion: 1, entries: Object.create(null), ...(categories.length || snapshot.manifest?.categories ? { categories } : {}), ...(projects ? { projects: projects.entries } : snapshot.manifest?.projects === undefined ? {} : { projects: snapshot.manifest.projects }) };
    const archives = new Map();
    const upserts = [];
    const deletions = [];
    for (const [slug, side] of selected) {
      const l = local.get(slug);
      const r = remote[slug];
      const chosenFP = side === 'local' ? l?.fingerprint : present(r);
      if (!chosenFP) {
        if (r?.deleted) next.entries[slug] = r;
        else if (own(base.entries, slug) || present(r)) next.entries[slug] = { deleted: true, updatedAt: stamp() };
        if (l) deletions.push(slug);
        continue;
      }
      let record;
      if (side === 'remote') {
        next.entries[slug] = r;
        if (l?.fingerprint !== chosenFP || r.bootstrap) {
          record = remoteRecords.get(slug);
          if (!record) {
            const bytes = await this.client.readArchive(r.archivePath, snapshot.head);
            if (await sha256(bytes) !== r.archiveSha256) throw new Error(`技能「${r.metadata.name}」的云端文件校验失败，未恢复或覆盖。`);
            const parsed = await storage.decodeSkillArchive(new Blob([bytes]));
            if (parsed.length !== 1) throw new Error('云端技能包必须仅包含一个技能。');
            record = { ...parsed[0], ...r.metadata, files: parsed[0].files };
            if (await fingerprintSkill(record) !== r.fingerprint) throw new Error('云端技能内容与同步清单不一致，未恢复或覆盖。');
          }
          if (l?.fingerprint !== chosenFP) upserts.push({ ...record, id: l?.record.id || record.id });
        }
      } else {
        record = l.record;
        if (present(r) === l.fingerprint && !r.bootstrap) next.entries[slug] = r;
      }
      if (!next.entries[slug] || next.entries[slug].bootstrap) {
        record ||= l?.record || remoteRecords.get(slug);
        const archive = await storage.exportSkill(record);
        if (archive.size > MAX_ARCHIVE_BYTES) throw new Error(`技能「${record.name}」超过 GitHub 同步的 45 MB 单包限制，本机数据仍已保存。`);
        const hash = await sha256(archive);
        const path = `skill-cabinet/archives/${slug}-${hash}.zip`;
        next.entries[slug] = { fingerprint: chosenFP, archiveSha256: hash, archivePath: path, metadata: safeMetadata(record, slug) };
        archives.set(path, archive);
      }
    }
    const current = await indexSkills(await storage.listSkills());
    if (projects) this.projectStore.assertSnapshot(projects.expected);
    if (await sha256(`${await localSignature(current)}:${JSON.stringify(await storage.listCategories())}`) !== signature) { const error = new Error('同步期间又有本机修改，已保留全部修改，请再次同步。'); error.code = 'LOCAL_CHANGED'; throw error; }
    const changed = !snapshot.manifest || JSON.stringify(snapshot.manifest.entries) !== JSON.stringify(next.entries) || JSON.stringify(snapshot.manifest.categories || []) !== JSON.stringify(categories) || JSON.stringify(snapshot.manifest.projects) !== JSON.stringify(next.projects);
    // Save a complete recovery ZIP before applying any remote edits or deletions.
    if (upserts.length || deletions.length) await storage.setSyncMeta(this.recoveryKey, { blob: await storage.exportLibrary(records), createdAt: stamp() });
    this.state('syncing', changed ? `正在上传 ${archives.size} 个技能包${projects ? `、${projects.uploaded} 项项目变更` : ''}，等待 GitHub 确认…` : '正在确认本机与 GitHub 内容一致…');
    const written = changed ? await this.client.writeSnapshot(snapshot, next, archives) : { ...snapshot, manifest: next };
    if (projects) this.projectStore.applyCloud(projects, this.client.repoKey, written.head);
    const baseline = { seenManifest: true, head: written.head, syncedAt: stamp(), categories, entries: Object.fromEntries(Object.entries(next.entries).map(([slug, entry]) => [slug, present(entry)])) };
    // The storage transaction checks every localRevision, including unchanged records.
    // A device edit during upload can therefore never be overwritten by a pull.
    // A failed apply must preserve the old baseline too: some remote edits have
    // not reached this device yet. Advancing it would misclassify their old local
    // copies as new edits during the next merge and could upload stale content.
    await storage.applySyncChanges(upserts, deletions, { expectedRecords: records, expectedCategories: localCategories, categories, metaKey: this.baseKey, metaValue: baseline });
    return this.state('synced', changed ? `GitHub 已确认保存：上传 ${archives.size} 个技能包${projects ? `、${projects.uploaded} 项项目变更` : ''}。云端修改与删除已合并。` : '已检查 GitHub，两个空间均无新增差异。', { head: written.head, syncedAt: baseline.syncedAt, uploaded: archives.size, restored: upserts.length, deleted: deletions.length, changed, projects: projects && { uploaded: projects.uploaded, restored: projects.restored, deleted: projects.deleted } });
  }
}
