import { sanitizeProject, validateProjectEntries } from './github-projects.js';
import { sha256 } from './github-client.js';

const fp = entry => entry && !entry.deleted ? entry.fingerprint : null;
export async function fingerprintProject(value) {
  const { createdAt, updatedAt, ...record } = sanitizeProject(value);
  return sha256(JSON.stringify(record));
}

export async function prepareProjectSync(store, repoKey, manifest, head, resolutions) {
  const expected = store.snapshot(), records = store.list(), baseline = store.getSyncBaseline(repoKey) || { entries: {} };
  if (manifest?.projects === undefined && baseline.seenManifest) throw Error('远端项目同步清单已被移除，请先恢复清单再同步。');
  const remote = validateProjectEntries(manifest?.projects || {});
  const local = new Map(await Promise.all(records.map(async record => [record.id, { record, fingerprint: await fingerprintProject(record) }])));
  for (const entry of Object.values(remote)) if (!entry.deleted && await fingerprintProject(entry.record) !== entry.fingerprint) throw Error('云端项目内容与校验值不一致，未覆盖本机收藏。');
  const token = await sha256(JSON.stringify([head, expected, baseline.entries]));
  if (resolutions && resolutions.projectToken !== token) throw Error('本机或远端项目已变化，请重新比较冲突。');
  const entries = Object.create(null), next = [], conflicts = [];
  let uploaded = 0, restored = 0, deleted = 0;
  const ids = [...new Set([...local.keys(), ...Object.keys(remote), ...Object.keys(baseline.entries)])].sort();
  for (const id of ids) {
    const l = local.get(id), r = remote[id], b = baseline.entries[id] || null;
    const lf = l?.fingerprint || null, rf = fp(r), tracked = Object.hasOwn(baseline.entries, id);
    const collision = tracked ? lf !== b && rf !== b && lf !== rf : lf && ((rf && lf !== rf) || r?.deleted);
    let side;
    if (collision) {
      side = resolutions?.choices?.[`project:${id}`];
      if (!['local', 'remote'].includes(side)) { conflicts.push({ slug: `project:${id}`, local: l?.record || null, remote: r?.record || null, kind: 'project' }); continue; }
    } else if (lf === rf) side = 'remote';
    else side = tracked ? (lf !== b ? 'local' : 'remote') : (lf ? 'local' : 'remote');
    const chosen = side === 'local' ? l?.record : r?.record;
    if (!chosen) {
      if (r?.deleted) entries[id] = r;
      else if (tracked || rf) entries[id] = { deleted: true, updatedAt: new Date().toISOString() };
      if (lf) deleted++;
      if (rf) uploaded++;
    } else {
      const fingerprint = side === 'local' ? lf : rf;
      entries[id] = { fingerprint, record: chosen }; next.push(chosen);
      if (fingerprint !== rf) uploaded++;
      if (fingerprint !== lf) restored++;
    }
  }
  store.assertSnapshot(expected);
  return { expected, records: next, entries, fingerprints: Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, fp(entry)])), conflicts, token, uploaded, restored, deleted };
}
