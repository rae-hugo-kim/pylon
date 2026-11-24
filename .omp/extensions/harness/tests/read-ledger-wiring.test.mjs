// read-ledger-wiring.test.mjs — #109: what a read / write really touched must reach the
// ledgers as the REAL file, end to end. Drives the real extension handlers
// (tests/helpers/harness-handlers.mjs) with event fixtures against a temp session root, with
// the real gates spawned — so a path the adapter resolves wrongly shows up as a wrong read-log
// entry or a wrong context-gate verdict, not as a matched source string.
//
// The read events carry the result details omp 18.22.0 emits (measured from this repo's
// session transcripts, 2026-11-19): a plain file read names its file in details.meta.source, a
// read that resolved its input (query, SQLite, archive) also in details.resolvedPath, and a
// list read is marked by details.displayReadTargets (parts) + displayReadTargetLinks.
//
// Run: node --test .omp/extensions/harness/tests/read-ledger-wiring.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarness, ctxFor } from './helpers/harness-handlers.mjs';
import { mkdtempReal } from './helpers/real-tmpdir.mjs';

const { handlers } = await loadHarness();
const call = handlers.tool_call[0];
const result = handlers.tool_result[0];

/** A git repo session root (the cross-repo guard resolves the target's repo) holding `files`. */
function session(t, files) {
  const root = mkdtempReal('read-ledger-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['init', '-q'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), '{"scripts":{}}\n');
  }
  return root;
}
/** Distinct read-log entries (read-tracker logs each path raw AND slash-normalised). */
const readLog = (root) => {
  const p = join(root, '.omp', 'harness-state', 'read-log.txt');
  return existsSync(p) ? [...new Set(readFileSync(p, 'utf8').split('\n').filter((l) => l && !l.startsWith('#origin ')))] : [];
};
const readEvent = (root, path, details) =>
  result({ toolName: 'read', input: { path }, isError: false, details, content: [{ type: 'text', text: '1:x' }] }, ctxFor(root));
/** A plain file read of `file`. */
const read = (root, path, file) => readEvent(root, path, { meta: { source: { type: 'path', value: join(root, file) } } });
/** A read that resolved its input to `reported` (query, SQLite, archive member). */
const readResolved = (root, path, reported) =>
  readEvent(root, path, { resolvedPath: join(root, reported), meta: { source: { type: 'path', value: join(root, reported) } } });
/** A list read: `parts` as displayed, `files` index-aligned (the file omp opened for each part). */
const readList = (root, path, parts, files) =>
  readEvent(root, path, {
    notes: [`Note: interpreted as ${parts.length} paths: ${parts.join(', ')}`],
    displayReadTargets: parts,
    displayReadTargetLinks: files.map((f) => join(root, f)),
  });
const blocked = async (root, toolName, input) => (await call({ toolName, input }, ctxFor(root)))?.block === true;

// List support was split off to #150: omp links every part it OPENED, also one it did not
// display (measured: `a.md:99999;b.md:2-3` links a.md and prints only "beyond end of file"), so
// a list read records nothing and each file must be read alone before it can be edited.
test('a list read records nothing — every part stays gated until it is read alone', async (t) => {
  for (const [path, parts] of [['a.md;b.md', ['a.md', 'b.md']], ['a.md:1-5;b.md:3-9', ['a.md:1-5', 'b.md:3-9']], ['a.md:99999;b.md:2-3', ['a.md:99999', 'b.md:2-3']]]) {
    const root = session(t, ['a.md', 'b.md']);
    await readList(root, path, parts, ['a.md', 'b.md']);
    assert.deepEqual(readLog(root), [], `after read ${path}`);
    assert.equal(await blocked(root, 'write', { path: 'a.md', content: 'x' }), true);
    assert.equal(await blocked(root, 'write', { path: 'b.md', content: 'x' }), true);
    await read(root, 'a.md', 'a.md');
    assert.equal(await blocked(root, 'write', { path: 'a.md', content: 'x' }), false, 'read alone, a.md is editable');
    assert.equal(await blocked(root, 'write', { path: 'b.md', content: 'x' }), true);
  }
});

test('a ; that omp did not fan out (a SQL query) records only what was read', async (t) => {
  const root = session(t, ['a.sqlite', 'b.txt']);
  await readResolved(root, 'a.sqlite?q=SELECT name FROM users; b.txt', 'a.sqlite');
  assert.deepEqual(readLog(root), [join(root, 'a.sqlite')]);
  assert.equal(await blocked(root, 'write', { path: 'b.txt', content: 'x' }), true, 'b.txt was SQL text, never read');
});

test('a ?q= read marks the file itself as read — the later edit is not false-blocked', async (t) => {
  const root = session(t, ['package.json']);
  assert.equal(await blocked(root, 'write', { path: 'package.json', content: '{}' }), true, 'unread file must block first');
  await readResolved(root, 'package.json?q=.scripts', 'package.json');
  assert.deepEqual(readLog(root), [join(root, 'package.json')]);
  assert.equal(await blocked(root, 'write', { path: 'package.json', content: '{}' }), false);
});

test('a comma-tail read and an archive member query record the file, not a phantom', async (t) => {
  const root = session(t, ['a.md', 'arc.tar']);
  await read(root, 'a.md:1-30,-30', 'a.md');
  await readResolved(root, 'arc.tar:member.json?q=.x', 'arc.tar:member.json'); // omp reports <archive>:<member>
  assert.deepEqual(readLog(root), [join(root, 'a.md'), join(root, 'arc.tar')]);
});

test('reading an archive member does not mark a look-alike literal file as read', async (t) => {
  const root = session(t, ['pack.zip', 'pack.zip:x']);
  await readResolved(root, 'pack.zip:x', 'pack.zip'); // with pack.zip present, omp opens the archive
  assert.deepEqual(readLog(root), [join(root, 'pack.zip')]);
  // `write pack.zip:x` rewrites the ARCHIVE even beside a literal file of that name (measured,
  // #152); the literal file is what `edit` addresses, and it was never read
  assert.equal(await blocked(root, 'write', { path: 'pack.zip:x', content: 'x' }), false, 'the archive that write rewrites was read');
  assert.equal(await blocked(root, 'edit', { path: 'pack.zip:x' }), true, 'the literal file pack.zip:x was never read');
});

// r6 review: guessing the file from the input is confined to a result WITHOUT details. Details
// that name no source (measured: a failed document conversion returns `{fileSize}` only) record
// nothing, so the file stays gated.
test('only a result without details falls back to the grammar — details that name no source record nothing', async (t) => {
  const root = session(t, ['a.md', 'notes', 'notes?.md']);
  await readEvent(root, 'a.md:1-5', { fileSize: 10 });
  assert.deepEqual(readLog(root), []);
  assert.equal(await blocked(root, 'write', { path: 'a.md', content: 'x' }), true);
  await readEvent(root, 'a.md:1-5', undefined);
  assert.deepEqual(readLog(root), [join(root, 'a.md')]);
  await readEvent(root, 'notes?.md', undefined); // `notes` + query, or the literal file notes?.md?
  assert.deepEqual(readLog(root), [join(root, 'a.md')]);
  assert.equal(await blocked(root, 'write', { path: 'notes', content: 'x' }), true);
});

// omp reports a PDF page read with the PDF in resolvedPath and the rendered screenshot as the
// source (read.ts `#readPdfPageScreenshot`): the PDF is what was read.
test('a PDF page read records the PDF, not the rendered screenshot', async (t) => {
  const root = session(t, ['doc.pdf', 'cache/shot-page3.png']);
  await readEvent(root, 'doc.pdf:page3.png', { resolvedPath: join(root, 'doc.pdf'), meta: { source: { type: 'path', value: join(root, 'cache/shot-page3.png') } } });
  assert.deepEqual(readLog(root), [join(root, 'doc.pdf')]);
  assert.equal(await blocked(root, 'write', { path: 'doc.pdf', content: 'x' }), false);
  assert.equal(await blocked(root, 'write', { path: 'cache/shot-page3.png', content: 'x' }), true);
});

test('write through a copied [path#TAG] wrapper is gated as the real file', async (t) => {
  const root = session(t, ['src/foo.ts']);
  const wrappers = ['[src/foo.ts#1A2B]', '[src/foo.ts]', '[src/foo.ts#1A2B] '];
  for (const path of wrappers) {
    assert.equal(await blocked(root, 'write', { path, content: 'x' }), true, `overwriting an unread existing file through ${JSON.stringify(path)} must block`);
  }
  await read(root, 'src/foo.ts', 'src/foo.ts');
  for (const path of wrappers) assert.equal(await blocked(root, 'write', { path, content: 'x' }), false);
});

test('a wrapper write is recorded under the real file, so the next edit is not false-blocked', async (t) => {
  const root = session(t, []);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'new.ts'), 'x\n'); // the write tool has just created it
  await result({ toolName: 'write', input: { path: '[src/new.ts#1A2B]', content: 'x\n' }, isError: false }, ctxFor(root));
  assert.ok(readLog(root).includes(join(root, 'src', 'new.ts')), JSON.stringify(readLog(root)));
  assert.equal(await blocked(root, 'edit', { path: 'src/new.ts' }), false);
});

// ── #152: the mutation targets end to end — the real handlers, the real context-gate. ──────
test('#152 AC1: a write into an unread archive, or through an @-path, is blocked until the file is read', async (t) => {
  const root = session(t, ['arc.tar', 'abs/file.md']);
  const mention = `@${join(root, 'abs/file.md')}`;
  assert.equal(await blocked(root, 'write', { path: 'arc.tar:member.json', content: '{}' }), true, 'arc.tar was never read');
  assert.equal(await blocked(root, 'write', { path: mention, content: 'x' }), true, 'abs/file.md was never read');
  await read(root, 'arc.tar', 'arc.tar');
  await read(root, 'abs/file.md', 'abs/file.md');
  assert.equal(await blocked(root, 'write', { path: 'arc.tar:member.json', content: '{}' }), false);
  assert.equal(await blocked(root, 'write', { path: mention, content: 'x' }), false);
});

test('#152 AC2: a local path containing :// is gated as the file it names', async (t) => {
  const root = session(t, ['notes/a:/b.md']);
  assert.equal(await blocked(root, 'write', { path: 'notes/a://b.md', content: 'x' }), true);
  assert.equal(await blocked(root, 'edit', { path: 'notes/a://b.md' }), true);
  await read(root, 'notes/a://b.md', 'notes/a:/b.md');
  assert.equal(await blocked(root, 'write', { path: 'notes/a://b.md', content: 'x' }), false);
});

test('#152-4: an edit whose direct path is a copied [path#TAG] wrapper is gated as the real file', async (t) => {
  const root = session(t, ['src/foo.ts']);
  assert.equal(await blocked(root, 'edit', { path: '[src/foo.ts#1A2B]' }), true);
  await read(root, 'src/foo.ts', 'src/foo.ts');
  assert.equal(await blocked(root, 'edit', { path: '[src/foo.ts#1A2B]' }), false);
});

test('#152-1: an archive member write is recorded under the archive', async (t) => {
  const root = session(t, ['arc.tar']); // the write tool has just created or rewritten it
  await result({ toolName: 'write', input: { path: 'arc.tar:member.json', content: '{}' }, isError: false }, ctxFor(root));
  assert.deepEqual(readLog(root), [join(root, 'arc.tar')]);
});

// #152-6: closed by #111 (state-origin `recordReads`) — a reported path with a line break used
// to add read-log lines of its own. Pinned here at the handler level.
test('#152-6: a reported path containing a line break records nothing', async (t) => {
  const root = session(t, ['a.md', 'b.md']);
  await readEvent(root, 'a.md', { meta: { source: { type: 'path', value: `${join(root, 'a.md')}\n${join(root, 'b.md')}` } } });
  assert.deepEqual(readLog(root), []);
  assert.equal(await blocked(root, 'write', { path: 'b.md', content: 'x' }), true);
});

// #152 AC5: these shapes are refused at tool_call whatever the ledger holds — reading the
// file does not unlock them, and a file that does not exist yet does not either.
test('#152 AC5: a doubly wrapped or file:// write is blocked at tool_call, read or not', async (t) => {
  const root = session(t, ['src/foo.ts', '.omp/rules/zz.md']);
  const paths = ['[[src/foo.ts]]', `[[file://${join(root, 'src/foo.ts')}]]`, `file://${join(root, 'src/foo.ts')}`, '[[file:///a:b/../tmp/victim.md]]', '[[rule://zz]]', '[[src/new.ts]]'];
  await read(root, 'src/foo.ts', 'src/foo.ts');
  for (const path of paths) {
    const verdict = await call({ toolName: 'write', input: { path, content: 'x' } }, ctxFor(root));
    assert.equal(verdict?.block, true, JSON.stringify(path));
    assert.match(verdict.reason, /^HARNESS BLOCK: write path .*cannot tell which file omp would open/s, JSON.stringify(path));
  }
  // the same file through one wrapper or as a plain path is judged by the ledger, as before
  assert.equal(await blocked(root, 'write', { path: '[src/foo.ts#1A2B]', content: 'x' }), false);
  assert.equal(await blocked(root, 'write', { path: 'src/foo.ts', content: 'x' }), false);
  assert.equal(await blocked(root, 'edit', { path: '[[src/new.ts]]' }), false, 'edit is not refused: pi-edit unwraps once');
});
