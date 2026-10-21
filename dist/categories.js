export function normalizeCategories(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('分类列表格式无效或超过 1000 项。');
  const names = value.map(name => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 30 || /[\u0000-\u001f]/.test(name)) throw new Error('分类名称须为 1—30 个字符。');
    return name.trim();
  });
  return [...new Set(names)].sort();
}

// Categories currently support adding only. A union preserves additions on both devices.
export function mergeCategories(...groups) {
  return normalizeCategories([...new Set(groups.flatMap(normalizeCategories))]);
}
