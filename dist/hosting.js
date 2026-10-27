// The deployment build marks its HTML; local development keeps its file APIs.
export function isStaticHosting() {
  return globalThis.document?.querySelector('meta[name="skill-cabinet-hosting"]')?.content === 'static';
}

export async function readRepositoryArchive(entry, hosting, read) {
  const parts = hosting?.archiveParts?.[entry.archivePath];
  const paths = parts || [entry.archivePath];
  if (parts && (!Array.isArray(parts) || parts.length < 2 || parts.length > 3 || parts.some((part, i) => part !== `${entry.archivePath}.part-${i}`))) {
    throw Error('线上技能包分片清单无效。');
  }
  const buffers = [];
  let size = 0;
  for (const path of paths) {
    const response = await read(path);
    if (!response.ok) throw Error(`仓库技能包「${entry.metadata.name}」无法读取，稍后会自动重试。`);
    const bytes = await response.arrayBuffer();
    size += bytes.byteLength;
    if (size > 45 * 1024 * 1024 || parts && bytes.byteLength > 20_000_000) throw Error('线上技能包超过大小限制。');
    buffers.push(bytes);
  }
  return buffers.length === 1 ? buffers[0] : new Blob(buffers).arrayBuffer();
}
