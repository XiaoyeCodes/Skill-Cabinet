import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const library = new URL('../skills/awesome-design-md/', import.meta.url), claude = new URL('../skills/claude-design/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const python = process.env.SKILL_TEST_PYTHON || 'python';
const hasPython = spawnSync(python, ['--version'], { timeout: 10000 }).status === 0;

test('one design library contains 84 complete, hash-verified original references and Claude preserves its requested source', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog.json', library)));
  assert.equal(catalog.designs.length, 84); assert.equal(new Set(catalog.designs.map(item => item.id)).size, 84);
  for (const item of catalog.designs) {
    assert.match(item.id, /^[a-z0-9][a-z0-9.-]{0,63}$/);
    assert.equal(item.path, `library/${item.id}/DESIGN.md`);
    const bytes = await readFile(new URL(item.path, library));
    assert.equal(hash(bytes), item.sha256, item.id); assert(bytes.length > 1000, item.id);
  }
  const manifest = JSON.parse(await readFile(new URL('../skill-cabinet/manifest.json', import.meta.url)));
  for (const slug of ['awesome-design-md', 'claude-design']) assert.equal(manifest.entries[slug].metadata.category, '图像与设计');
  assert.equal(manifest.entries['claude-design'].metadata.name, '克劳德设计');
  for (const item of catalog.designs) assert(!manifest.entries[`design-${item.id}`], 'References must remain inside one skill');
  const source = JSON.parse(await readFile(new URL('source.json', claude)));
  assert.equal(source.page, 'https://getdesign.md/claude/design-md');
  assert.equal(hash(await readFile(new URL('references/DESIGN.md', claude))), source.sha256);
  assert.equal(hash(await readFile(new URL('library/claude/DESIGN.md', library))), source.repositoryDocumentSha256);
});

test('the library can recommend by keywords and export one reference while preserving existing user files', { skip: !hasPython }, async t => {
  const script = fileURLToPath(new URL('scripts/design_library.py', library));
  const run = (...args) => spawnSync(python, [script, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  const listed = run('list', '--query', '暖白'); assert.equal(listed.status, 0, listed.stderr);
  const results = JSON.parse(listed.stdout).designs; assert(results.some(item => item.id === 'claude')); assert(results.length > 1);
  const unknown = run('list', '--query', 'no-such-design-4fa9c5'); assert.equal(JSON.parse(unknown.stdout).count, 0);
  assert.equal(run('show', '../../LICENSE').status, 1);
  assert.equal(run('show', 'unknown-style-8877').status, 1);
  const folder = await mkdtemp(path.join(tmpdir(), 'design-skill-test-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const output = path.join(folder, 'DESIGN.md');
  const exported = run('export', 'claude', '--output', output); assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(await readFile(output), await readFile(new URL('library/claude/DESIGN.md', library)));
  await writeFile(output, 'Existing project decisions');
  assert.equal(run('export', 'claude', '--output', output).status, 1);
  assert.equal(await readFile(output, 'utf8'), 'Existing project decisions');
});

function luminance(color) {
  const values = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
const contrast = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + .05) / (low + .05); };
test('Claude implementation tokens preserve the warm direction with readable text and controls', async () => {
  const { colors: c, minimumTargetPx } = JSON.parse(await readFile(new URL('assets/tokens.json', claude)));
  assert.equal(c.canvas, '#faf9f5'); assert.equal(c.accent, '#cc785c'); assert(minimumTargetPx >= 44);
  for (const [fg, bg] of [['ink', 'canvas'], ['body', 'canvas'], ['muted', 'canvas'], ['onAction', 'action'], ['onAction', 'actionHover'], ['onDark', 'surfaceDark'], ['onDarkMuted', 'surfaceDark'], ['body', 'surfaceCard'], ['muted', 'surfaceCard']]) assert(contrast(c[fg], c[bg]) >= 4.5, `${fg}/${bg}: ${contrast(c[fg], c[bg])}`);
  assert(contrast(c.controlBorder, c.canvas) >= 3);
});
