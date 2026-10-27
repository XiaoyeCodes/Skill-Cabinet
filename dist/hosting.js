import { sha256, MAX_ARCHIVE_BYTES } from './github-client.js';

// The deployment build marks its HTML; local development keeps its file APIs.
export function isStaticHosting() {
  return globalThis.document?.querySelector('meta[name="skill-cabinet-hosting"]')?.content === 'static';
}

export function createArchiveCache(cacheStorage = globalThis.caches, base = globalThis.location?.href) {
  if (!cacheStorage || !base) return null;
  const open = () => cacheStorage.open('skill-cabinet-archives-v1');
  const url = key => new URL(`./${key}`, base).href;
  return {
    async get(key) { return (await (await open()).match(url(key)))?.arrayBuffer(); },
    async put(key, bytes) { await (await open()).put(url(key), new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); },
    async delete(key) { await (await open()).delete(url(key)); },
  };
}

async function downloadPart(path, read, { maxBytes, idleTimeout, onProgress }) {
  const controller = new AbortController();
  let timer, reader, rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error('下载连接长时间没有数据，请稍后重试。');
      rejectTimeout(error); controller.abort(error);
    }, idleTimeout);
  };
  reset();
  try {
    const response = await Promise.race([read(path, { signal: controller.signal }), timeout]);
    if (!response.ok) {
      const error = Error(`技能包无法读取（${response.status}）。`);
      error.retryable = [408, 429].includes(response.status) || response.status >= 500;
      void response.body?.cancel().catch(() => {});
      throw error;
    }
    const chunks = []; let size = 0;
    const append = chunk => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        const error = Error('线上技能包超过大小限制。'); error.retryable = false; throw error;
      }
      chunks.push(chunk); reset(); onProgress(size);
    };
    if (response.body?.getReader) {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        append(value);
      }
    } else append(new Uint8Array(await Promise.race([response.arrayBuffer(), timeout])));
    return await new Blob(chunks).arrayBuffer();
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function readRepositoryArchive(entry, hosting, read, { cache = null, attempts = 1, retryDelay = 400, idleTimeout = 30000, onProgress = () => {} } = {}) {
  const parts = hosting?.archiveParts?.[entry.archivePath];
  const paths = parts || [entry.archivePath];
  if (parts && (!Array.isArray(parts) || parts.length < 2 || parts.length > 24 || parts.some((part, i) => part !== `${entry.archivePath}.part-${i}`))) {
    throw Error('线上技能包分片清单无效。');
  }
  const buffers = [];
  let size = 0;
  for (const [index, path] of paths.entries()) {
    const expected = parts ? hosting?.archivePartHashes?.[path] : entry.archiveSha256;
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) throw Error('线上技能包摘要无效。');
    const key = expected ? `${path}?sha256=${expected}` : null;
    const maxBytes = Math.min(parts ? 20_000_000 : MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES - size);
    const progress = (loaded, extra = {}) => onProgress({ loaded: size + loaded, totalBytes: hosting?.archiveSizes?.[entry.archivePath] || 0, part: index + 1, parts: paths.length, ...extra });
    let bytes;
    if (cache && key) {
      try {
        const saved = await cache.get(key);
        if (saved && saved.byteLength <= maxBytes && await sha256(saved) === expected) { bytes = saved; progress(bytes.byteLength, { cached: true }); }
        else if (saved) await cache.delete(key);
      } catch { /* Download normally when cache storage is unavailable or full. */ }
    }
    if (!bytes) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          progress(0, { attempt });
          bytes = await downloadPart(path, read, { maxBytes, idleTimeout, onProgress: loaded => progress(loaded, { attempt }) });
          if (expected && await sha256(bytes) !== expected) throw Error('技能包下载校验失败，将重新下载当前分片。');
          break;
        } catch (error) {
          if (error.retryable === false || attempt === attempts) throw error;
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
      if (cache && key) { try { await cache.put(key, bytes); } catch { /* Cache failure must not block the library. */ } }
    }
    size += bytes.byteLength;
    if (size > MAX_ARCHIVE_BYTES) throw Error('线上技能包超过大小限制。');
    buffers.push(bytes);
  }
  return buffers.length === 1 ? buffers[0] : new Blob(buffers).arrayBuffer();
}
