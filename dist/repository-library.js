import * as localStorage from './storage.js';
import { validateManifest, sha256, MAX_ARCHIVE_BYTES } from './github-client.js';
import { fingerprintSkill } from './sync-engine.js';
import { mergeCategories } from './categories.js';

const BASELINE = 'repository-library:v1';
const fingerprint = entry => entry && !entry.deleted ? entry.fingerprint : null;

// Loads checkout data and mirrors custom categories to its tracked manifest.
// Git commits and pushes remain explicit user actions.
export class RepositoryLibrary {
  constructor({ storage = localStorage, fetchImpl = (...args) => fetch(...args) } = {}) {
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.running = null;
  }

  refresh() {
    if (!this.running) this.running = this.performRefresh().finally(() => { this.running = null; });
    return this.running;
  }

  async read(path) {
    return this.fetchImpl(`./${path}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
  }

  async performRefresh() {
    const response = await this.read('skill-cabinet/manifest.json');
    if (response.status === 404) {
      // dist-only static hosting can still use the original portable seed library.
      if (this.lastManifest || await this.storage.getSyncMeta(BASELINE)) throw new Error('仓库技能清单暂时不可用，本地数据已保留。');
      return { available: false };
    }
    if (!response.ok) throw new Error(`读取仓库技能失败（${response.status}），本地数据已保留。`);
    const manifest = validateManifest(await response.json());
    const localCategories = await this.storage.listCategories();
    const categories = mergeCategories(localCategories, manifest.categories || []);
    const signature = JSON.stringify([manifest, localCategories]);
    if (signature === this.lastManifest) return { ...this.lastResult, changed: false };

    const storage = this.storage;
    const records = await storage.listSkills();
    const local = new Map(records.map(record => [record.slug, record]));
    const baseline = await storage.getSyncMeta(BASELINE) || { entries: {} };
    const next = { entries: Object.create(null) };
    const upserts = [], deletions = [], preserved = [];
    const slugs = new Set([...Object.keys(baseline.entries), ...Object.keys(manifest.entries)]);
    for (const slug of slugs) {
      const entry = manifest.entries[slug];
      const remoteFP = fingerprint(entry);
      const record = local.get(slug);
      const localFP = record ? await fingerprintSkill(record) : null;
      const tracked = Object.hasOwn(baseline.entries, slug);
      const baseFP = baseline.entries[slug] ?? null;
      next.entries[slug] = remoteFP;
      if (localFP === remoteFP) continue;
      // Only replace an unchanged checkout copy; local edits and local deletions win.
      if (tracked ? localFP !== baseFP : Boolean(record)) {
        preserved.push(record?.name || entry?.metadata?.name || slug);
        continue;
      }
      if (!remoteFP) { if (record) deletions.push(slug); continue; }
      const archive = await this.read(entry.archivePath);
      if (!archive.ok) throw new Error(`仓库技能包「${entry.metadata.name}」无法读取，稍后会自动重试。`);
      const bytes = await archive.arrayBuffer();
      if (bytes.byteLength > MAX_ARCHIVE_BYTES || await sha256(bytes) !== entry.archiveSha256) throw new Error(`仓库技能包「${entry.metadata.name}」校验失败，本地数据已保留。`);
      const decoded = await storage.decodeSkillArchive(bytes);
      if (decoded.length !== 1) throw new Error('仓库技能包必须只包含一个 Skill。');
      const incoming = { ...decoded[0], ...entry.metadata, files: decoded[0].files };
      if (await fingerprintSkill(incoming) !== remoteFP) throw new Error(`仓库技能「${entry.metadata.name}」与清单不一致，本地数据已保留。`);
      upserts.push(incoming);
    }
    // Data and baseline commit together; concurrent edits cause a retry, not an overwrite.
    await storage.applySyncChanges(upserts, deletions, { expectedRecords: records, expectedCategories: localCategories, categories, metaKey: BASELINE, metaValue: next });
    let categoriesOnDisk = true;
    if (JSON.stringify(categories) !== JSON.stringify(manifest.categories || [])) {
      const saved = await this.fetchImpl('./api/categories', { method: 'PUT', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ categories }), signal: AbortSignal.timeout(15000) });
      // A static host has no local write API; connected GitHub sync still carries categories.
      if ([404, 405].includes(saved.status)) categoriesOnDisk = false;
      else if (!saved.ok) throw new Error('分类已保存在浏览器，写入本地仓库失败，将自动重试。');
      else await storage.saveCategories((await saved.json()).categories, { source: 'remote' });
    }
    this.lastManifest = JSON.stringify([manifest, categories]);
    this.lastResult = { available: true, changed: Boolean(upserts.length || deletions.length || JSON.stringify(localCategories) !== JSON.stringify(categories)), count: Object.values(manifest.entries).filter(fingerprint).length, preserved, categoriesOnDisk };
    return this.lastResult;
  }
}
