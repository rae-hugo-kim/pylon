// read-path.test.mjs — readTarget / READ_SELECTOR / editTargets (the paths index.ts feeds the
// read and write ledgers).
//
// Regression F1: the old READ_SELECTOR only stripped `:range:raw`, not the
// documented `:raw:range` order, so `read foo.ts:raw:2-4` logged the phantom
// path "foo.ts:raw" and a later edit of "foo.ts" falsely failed context-gate.

import test from 'node:test';
import assert from 'node:assert';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  readTarget, localFileTarget, editTargets, mutationCallTargets, mutationRefusal, mutationRoute,
  READ_SELECTOR, resolvedAstEditFiles, searchTrackTargets,
} from '../gates/read-path.mjs';
import { mkdtempReal } from './helpers/real-tmpdir.mjs';

// An EMPTY temp dir, not a fixed path: the grammar fallback consults the disk, so the selector
// tests below must not depend on what a path like /work happens to hold on this host.
const CWD = mkdtempReal('read-path-grammar-');
test.after(() => rmSync(CWD, { recursive: true, force: true }));
const BARE = resolve(CWD, 'src/foo.ts');
// T is the grammar view: a read whose result carries no details, so the file is derived from
// the path alone.
const T = (p) => readTarget({ path: p }, undefined, CWD);

test('strips every documented selector form (range / raw-trailing / L-prefix / .. / multi)', () => {
  for (const sel of [
    'src/foo.ts:50-100',
    'src/foo.ts:raw',
    'src/foo.ts:conflicts',
    'src/foo.ts:50',
    'src/foo.ts:50-',
    'src/foo.ts:50+150',
    'src/foo.ts:5-16,960-973',
    'src/foo.ts:2-4:raw',
    'src/foo.ts:L50',
    'src/foo.ts:L50-L100',
    'src/foo.ts:50..',
    'src/foo.ts:5..16',
  ]) {
    assert.equal(T(sel), BARE, `selector not stripped: ${sel}`);
  }
});

test('strips raw-LEADING selectors — :raw:range (the F1 fix)', () => {
  assert.equal(T('src/foo.ts:raw:2-4'), BARE);
  assert.equal(T('src/foo.ts:raw:50-100'), BARE);
  assert.equal(T('src/foo.ts:raw:5-16,960-973'), BARE);
});

test('leaves a bare path (no selector) untouched — no over-strip', () => {
  assert.equal(T('src/foo.ts'), BARE);
  assert.equal(T('src/report-2024.md'), resolve(CWD, 'src/report-2024.md'));
  assert.equal(T('src/v2.ts'), resolve(CWD, 'src/v2.ts'));
});

test('returns "" for web URLs and internal URIs (not local files to track)', () => {
  for (const p of ['https://example.com', 'http://x.y/a', 'skill://foo', 'omp://x.md', 'memory://m', 'artifact://1']) {
    assert.equal(T(p), '', `should not track: ${p}`);
  }
});

test('returns "" for missing / empty / non-string path', () => {
  assert.equal(readTarget({}, undefined, CWD), '');
  assert.equal(readTarget({ path: '' }, undefined, CWD), '');
  assert.equal(readTarget(undefined, undefined, CWD), '');
  assert.equal(readTarget({ path: 42 }, undefined, CWD), '');
});

test('READ_SELECTOR matches raw in EITHER order, plain/multi ranges; not a bare path', () => {
  for (const s of ['x:raw', 'x:raw:2-4', 'x:2-4:raw', 'x:5-16,960-973', 'x:conflicts', 'x:L9-L20']) {
    assert.match(s, READ_SELECTOR, `should match: ${s}`);
  }
  for (const s of ['x', 'src/v2.ts', 'src/report-2024.md', 'x:notaselector']) {
    assert.doesNotMatch(s, READ_SELECTOR, `should NOT match: ${s}`);
  }
});

// #42 (omp 18.2.9–18.3.0, measured 2026-09-24): `:img` is the mandatory selector for SVG
// rendering. Unstripped, `logo.svg:img` landed in read-log and a later edit of `logo.svg`
// false-blocked in context-gate. Standalone only — read.md documents no range combination,
// and the selector regex mirrors that grammar EXACTLY.
test('strips the :img selector (standalone only) — the F1 phantom class for SVG reads', () => {
  assert.equal(T('assets/logo.svg:img'), resolve(CWD, 'assets/logo.svg'));
  assert.match('x:img', READ_SELECTOR);
  assert.doesNotMatch('x:image', READ_SELECTOR);
  assert.equal(T('src/img'), resolve(CWD, 'src/img'), 'a path component named img is not a selector');
});

// `:-N` (last N lines) is advertised by the read tool and accepted live (omp 18.3.0, 2026-09-24:
// `read current-scope.md:-3` returned the tail AND logged the phantom `current-scope.md:-3`).
test('strips the :-N tail selector — the same phantom class', () => {
  assert.equal(T('docs/harness/current-scope.md:-3'), resolve(CWD, 'docs/harness/current-scope.md'));
  assert.equal(T('src/foo.ts:-60'), BARE);
  assert.equal(T('src/foo.ts:raw:-60'), BARE, ':raw:-N is accepted live (omp 18.3.0)');
  assert.equal(T('src/foo.ts:-60:raw'), BARE);
  assert.match('x:-60', READ_SELECTOR);
  assert.doesNotMatch('x:-', READ_SELECTOR);
  assert.equal(T('src/a-b:-c'), resolve(CWD, 'src/a-b:-c'), 'a non-numeric tail is a path, not a selector');
});

// #42: 18.3.0 job/service control (`write proc://<id>/kill`, `proc://<name>/mode`, `read proc://`)
// and write-only `conflict://` must never enter the ledgers — in the canonical `://` form OR the
// single-slash form the event plumbing has been observed to emit for xd (`xd:/retain`).
test('proc:// and conflict:// are virtual in both slash forms — never a ledger path', () => {
  for (const p of ['proc://', 'proc://bg_1', 'proc:/', 'proc:/bg_1/kill', 'proc:/web/mode', 'conflict://src/a.ts', 'conflict:/src/a.ts']) {
    assert.equal(T(p), '', `read must not track: ${p}`);
    assert.equal(localFileTarget(p, CWD), null, `write must not track: ${p}`);
  }
});

test('resolvedAstEditFiles extracts apply file paths from a resolve result', () => {
  // upstream shape: details.sourceResultDetails.files is string[]
  assert.deepEqual(
    resolvedAstEditFiles({ sourceResultDetails: { files: ['src/a.ts', 'src/b.ts'] } }, CWD),
    [resolve(CWD, 'src/a.ts'), resolve(CWD, 'src/b.ts')],
  );
  // defensive: object entries carrying a path/file field
  assert.deepEqual(
    resolvedAstEditFiles({ sourceResultDetails: { files: [{ path: 'x.ts' }, { file: 'y.ts' }] } }, CWD),
    [resolve(CWD, 'x.ts'), resolve(CWD, 'y.ts')],
  );
  // absent / misshaped -> [] (caller records nothing for that apply)
  assert.deepEqual(resolvedAstEditFiles(undefined, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({}, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: {} }, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: { files: 'nope' } }, CWD), []);
  // empty / non-path entries are skipped
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: { files: ['', null, 42, {}] } }, CWD), []);
});

test('searchTrackTargets: details.files is the trusted primary source', () => {
  // absolute entries (the shape measured on omp 16.3.12) pass through; relative
  // entries resolve against cwd; duplicates collapse; text is IGNORED when the
  // structured list is present.
  assert.deepEqual(
    searchTrackTargets({ files: ['/abs/a.ts', 'rel/b.ts', '/abs/a.ts'] }, '[ignored.ts#AB12]\n*1:x', CWD),
    [resolve('/abs/a.ts'), resolve(CWD, 'rel/b.ts')],
  );
  // internal URIs / non-strings / empties are skipped
  assert.deepEqual(
    searchTrackTargets({ files: ['omp://doc.md', 'skill://x/f.ts', '', 42, null, '/ok.ts'] }, '', CWD),
    [resolve('/ok.ts')],
  );
  // an EMPTY array is trusted as "nothing anchored" — no text fallback kicks in
  assert.deepEqual(searchTrackTargets({ files: [] }, '[foo.ts#AB12]\n*1:x', CWD), []);
});

test('searchTrackTargets: bracketed-header fallback when details.files is absent/misshaped', () => {
  const text = '[src/foo.ts#1A2B]\n*42:hit\n 43:context\n\n[/abs/bar.ts#FFFF]\n*1:hit';
  const expected = [resolve(CWD, 'src/foo.ts'), resolve('/abs/bar.ts')];
  assert.deepEqual(searchTrackTargets(undefined, text, CWD), expected);
  assert.deepEqual(searchTrackTargets({}, text, CWD), expected);
  assert.deepEqual(searchTrackTargets({ files: 'nope' }, text, CWD), expected);
});

test('searchTrackTargets: fallback is fail-strict — grouped trees and URIs track nothing', () => {
  // Grouped multi-file output uses `#`-tree headers, NOT bracketed ones. Reconstructing
  // paths from the tree is format-coupled and a wrong join would track the WRONG file
  // (loosening context-gate), so the fallback deliberately extracts nothing from it.
  const grouped = '# /tmp/scope/\n## a.ts#0168\n*1:export const alpha = 1;\n## sub/\n### b.ts#8274\n*1:export const beta = 2;';
  assert.deepEqual(searchTrackTargets(undefined, grouped, CWD), []);
  // internal-URI headers, headerless text, and non-string text track nothing
  assert.deepEqual(searchTrackTargets(undefined, '[omp://doc.md#AB12]\n*1:x', CWD), []);
  assert.deepEqual(searchTrackTargets(undefined, 'No matches found', CWD), []);
  assert.deepEqual(searchTrackTargets(undefined, undefined, CWD), []);
});

// ── #109: re-mirror against omp 18.22.0 (grammar: omp://tools/read.md, xd://read/sources;
// splitter: packages/tui/src/tools/read.ts; forms below live-measured 2026-11-19) ──────────

// F1: a `?` query (jq filter, image question, SQLite params) is not part of the file name.
// Unstripped, `package.json?q=.scripts` landed in read-log and editing package.json false-blocked.
test('#109 F1: strips the ?query of JSON/JSONL, image and SQLite reads', () => {
  for (const [input, file] of [
    ['package.json?q=.scripts', 'package.json'],
    ['docs/harness/audit.jsonl?q=.event&limit=5', 'docs/harness/audit.jsonl'],
    ['logo.png?q=what does this logo show?', 'logo.png'],
    ['db.sqlite?q=SELECT name FROM users', 'db.sqlite'],
    ['data.json?q={a:.b}', 'data.json'],
    ['data.json?q=.x:1-1', 'data.json'],
    ['data.json?limit=2', 'data.json'],
  ]) {
    assert.equal(T(input), resolve(CWD, file), `query not stripped: ${input}`);
  }
});

// Archive members, SQLite tables/rows and PDF page images address something INSIDE a container
// file; the ledger records the container (the file an edit/write would replace).
test('#109: container selectors resolve to the container file (archive / SQLite / PDF page)', () => {
  for (const [input, file] of [
    ['arc.tar:member.json?q=.x', 'arc.tar'],
    ['arc.tar:dir/inner.txt:50-60', 'arc.tar'],
    ['pkg.tar.gz:lib/a.js', 'pkg.tar.gz'],
    ['dist/app.tgz:package/package.json', 'dist/app.tgz'],
    ['a.zip:folder/sample document.pdf:page2.png', 'a.zip'],
    ['wheel.WHL:meta/RECORD', 'wheel.WHL'],
    ['db.sqlite:users', 'db.sqlite'],
    ['db.sqlite:users:42', 'db.sqlite'],
    ['db.sqlite3:users?limit=5&where=id>3', 'db.sqlite3'],
    ['state/agent.db:auth_credentials', 'state/agent.db'],
    ['doc.pdf:page3.png', 'doc.pdf'],
    ['doc.pdf:p11-img0.png', 'doc.pdf'],
    ['doc.pdf:page3.png?q=what is on this page', 'doc.pdf'],
    ['doc.pdf:50-100', 'doc.pdf'],
  ]) {
    assert.equal(T(input), resolve(CWD, file), `container selector not stripped: ${input}`);
  }
});

test('#109: container detection does not over-strip — the extension must be followed by : or ?', () => {
  for (const p of ['src/zip.ts', 'src/my.db.ts', 'docs/notes.pdf.md', 'pkg.tar.gz', 'tools/db/schema.sql']) {
    assert.equal(T(p), resolve(CWD, p), `bare path changed: ${p}`);
  }
  assert.equal(T('src/my.db.ts:3-9'), resolve(CWD, 'src/my.db.ts'));
  // a container-looking extension INSIDE a query is query text, not a container
  assert.equal(T('data.json?q=.pdf:x'), resolve(CWD, 'data.json'));
});

// C2 (v18.12.4): a comma list may carry a tail chunk and may repeat the colon after a comma.
test('#109 C2: strips comma lists with a tail chunk and a repeated colon', () => {
  for (const sel of [
    'src/foo.ts:1-30,-30',
    'src/foo.ts:1-30,:-30',
    'src/foo.ts:1-12,-15,40-50',
    'src/foo.ts:-30,1-30',
    'src/foo.ts:raw:1-30,:-30',
    'src/foo.ts:1-30,:-30:raw',
    'src/foo.ts:5,:9,:12-14',
  ]) {
    assert.equal(T(sel), BARE, `selector not stripped: ${sel}`);
  }
});

// The splitter is case-insensitive; `:-N+C` / `:-N-C` is accepted by the URL-side splitter.
test('#109: READ_SELECTOR is case-insensitive and strips :-N+C', () => {
  for (const sel of ['src/foo.ts:RAW', 'src/foo.ts:Raw:2-4', 'src/foo.ts:2-4:RAW', 'src/foo.ts:CONFLICTS', 'src/foo.ts:l5-L10', 'src/foo.ts:-60+10', 'src/foo.ts:-60-10']) {
    assert.equal(T(sel), BARE, `selector not stripped: ${sel}`);
  }
  assert.equal(T('assets/logo.svg:IMG'), resolve(CWD, 'assets/logo.svg'));
  for (const s of ['x:RAW', 'x:IMG', 'x:-60+10']) assert.match(s, READ_SELECTOR, `should match: ${s}`);
});

test('#109: a range chunk must end in a digit, dot or dash — `:50+` is not a selector', () => {
  assert.doesNotMatch('x:50+', READ_SELECTOR);
  assert.doesNotMatch('x:1-30,', READ_SELECTOR);
  assert.match('x:50-', READ_SELECTOR);
  assert.match('x:50..', READ_SELECTOR);
});

// F3 + D5: every built-in internal scheme (read.md "Internal URLs", 21 as of 18.22.0) is virtual
// in the canonical `://` form AND the single-slash form the event plumbing emits.
test('#109 F3: attachment / cfg / security / vault / out / mr are virtual in both slash forms', () => {
  for (const scheme of ['attachment', 'cfg', 'security', 'vault', 'out', 'mr']) {
    for (const p of [`${scheme}://ns/key`, `${scheme}:/ns/key`, `${scheme.toUpperCase()}:/ns/key`]) {
      assert.equal(readTarget({ path: p }, undefined, CWD), '', `read must not track: ${p}`);
      assert.equal(localFileTarget(p, CWD), null, `write must not track: ${p}`);
    }
  }
});

// F2: `write` accepts a copied hashline header as its path and removes the wrapper (write.md).
// The rule is omp 18.22.0 `unwrapHashlineHeaderPath`: after trimEnd the string is `[PATH]` or
// `[PATH#XXXX]` (4 hex); a valid tag lets PATH contain `#`, without one PATH must not.
test('#109 F2: write unwraps a copied [path#TAG] wrapper to the real file', () => {
  const foo = resolve(CWD, 'src/foo.ts');
  for (const p of ['[src/foo.ts#1A2B]', '[src/foo.ts#9f0e]', '[src/foo.ts]', '[src/foo.ts#1A2B] ', '[src/foo.ts]\n', '[src/foo.ts#1A2B]\t\n']) {
    assert.deepStrictEqual(editTargets('write', { path: p }, CWD), [foo], `must unwrap: ${JSON.stringify(p)}`);
  }
  assert.deepStrictEqual(editTargets('write', { path: '[conf/config##Linux#1A2B]' }, CWD), [resolve(CWD, 'conf/config##Linux')]);
  assert.deepStrictEqual(editTargets('write', { path: '[/abs/b.ts#1A2B]' }, CWD), [resolve('/abs/b.ts')]);
  assert.deepStrictEqual(editTargets('write', { file_path: '[src/foo.ts#1A2B]' }, CWD), [foo], 'path aliases unwrap too');
  // both ledger sides see the unwrapped file
  assert.deepStrictEqual(mutationCallTargets('write', { path: '[src/foo.ts]', content: 'x' }, CWD), [foo]);
  assert.deepStrictEqual(mutationRoute('write', { path: '[src/foo.ts#1A2B]', content: 'x' }, undefined, '', CWD), { kind: 'files', files: [foo] });
  // a wrapped virtual target stays virtual
  assert.deepStrictEqual(editTargets('write', { path: '[local://plan.md#1A2B]' }, CWD), []);
  assert.deepStrictEqual(editTargets('write', { path: '[local://plan.md]' }, CWD), []);
});

// omp unwraps BEFORE it decides what the target is: `write [xd://recall#1A2B]` dispatched the
// device (measured, omp 18.22.0). A wrapped ast_edit address must therefore still gate the
// paths in its body — matched on the raw string it fell through to the URI guard and dropped them.
test('#109 F2: a wrapped xd://ast_edit address still gates the paths in its body', () => {
  const body = '{"ops":[],"paths":["src/unread.ts"]}';
  for (const p of ['[xd://ast_edit#1A2B]', '[xd:/ast_edit#9f0e]', '[XD://ast_edit#1A2B]', '[xd://ast_edit]', '[xd://ast_edit#1A2B] ']) {
    assert.deepStrictEqual(mutationCallTargets('write', { path: p, content: body }, CWD), [resolve(CWD, 'src/unread.ts')], p);
  }
});

// Each of these was written as a LITERAL file name by omp 18.22.0 (measured) or is rejected by
// unwrapHashlineHeaderPath: an untagged PATH containing `#` (which is what a 5-hex or non-hex
// "tag" is), leading whitespace, a trailing selector, an empty PATH.
test('#109 F2: forms omp does NOT unwrap stay literal', () => {
  for (const p of ['[src/foo.ts#9F0E1]', '[src/foo.ts#12G4]', '[src/foo.ts#1A2]', ' [src/foo.ts#1A2B]', '[src/foo.ts#1A2B]:raw', '[]', '[#1A2B]', '[src/foo.ts', 'src/foo.ts]']) {
    assert.deepStrictEqual(editTargets('write', { path: p }, CWD), [resolve(CWD, p)], `must stay literal: ${JSON.stringify(p)}`);
  }
});

// F4 (v18.4.1 #13428): a tagged header path may itself contain `#` (yadm `config##Linux`).
test('#109 F4: [path#TAG] headers accept # inside the path', () => {
  assert.deepStrictEqual(searchTrackTargets(undefined, '[path/with#hash.ts#1A2B]\n1:x\n', CWD), [resolve(CWD, 'path/with#hash.ts')]);
  assert.deepStrictEqual(
    editTargets('edit', { input: '[conf/config##Linux#1A2B]\nPUT 1.=1:\n+x\n' }, CWD),
    [resolve(CWD, 'conf/config##Linux')],
  );
  // the tag is still the LAST #-segment and must be hex
  assert.deepStrictEqual(searchTrackTargets(undefined, '[src/a.ts#nothex]\n', CWD), []);
});

// ── What was read is taken from the RESULT. The fixtures are the detail shapes omp 18.22.0
// puts on a read result (measured from this repo's session transcripts, 2026-11-19; source:
// read.ts `readDetailsLinkPath`, read-archive.ts). ──────────────────────────────────────────
function tree(t, files) {
  const root = mkdtempReal('read-path-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), 'x\n');
  }
  return root;
}
/** A plain text read: the absolute path only in meta.source. */
const plain = (abs) => ({ meta: { source: { type: 'path', value: abs } } });
/** A read that resolved its input (query, SQLite, image, archive, suffix match): resolvedPath too. */
const resolved = (abs) => ({ resolvedPath: abs, meta: { source: { type: 'path', value: abs } } });

test('#109: a read records the file omp reports — selector, query and suffix resolution included', (t) => {
  const root = tree(t, ['a.md', 'data.json', 'deep/dir/x.ts', 'a.sqlite', 'b.txt']);
  const at = (f) => join(root, f);
  for (const [path, details, file] of [
    ['a.md:1-30,-30', plain(at('a.md')), 'a.md'],
    ['a.md:RAW:3-4', plain(at('a.md')), 'a.md'],
    ['data.json?q=.x:1-1', resolved(at('data.json')), 'data.json'],
    ['dir/x.ts', resolved(at('deep/dir/x.ts')), 'deep/dir/x.ts'], // unique-suffix match: not <root>/dir/x.ts
    ['a.sqlite?q=SELECT name FROM users; b.txt', resolved(at('a.sqlite')), 'a.sqlite'], // ONE SQL query (measured)
  ]) {
    assert.equal(readTarget({ path }, details, root), at(file), path);
  }
});

// r6 review (medium): omp's rule is `resolvedPath ?? source.value`, and the two DIFFER for a PDF
// page — the source is the rendered screenshot, resolvedPath the PDF (read.ts
// `#readPdfPageScreenshot`). Preferring the source would record the screenshot and leave the
// PDF false-blocked.
test('#109: resolvedPath wins over the source value when they differ (PDF page image)', (t) => {
  const root = tree(t, ['doc.pdf', 'cache/shot-page3.png']);
  const details = { resolvedPath: join(root, 'doc.pdf'), meta: { source: { type: 'path', value: join(root, 'cache/shot-page3.png') } } };
  assert.equal(readTarget({ path: 'doc.pdf:page3.png' }, details, root), join(root, 'doc.pdf'));
});

// r1/r2 review: omp prefers existing literal files and tries archive / SQLite candidates
// against the disk in an order of its own. With the reported path there is nothing to guess.
test('#109: a look-alike sibling never stands in for the file omp read', (t) => {
  const root = tree(t, ['notes?.md', 'notes', 'pack.zip', 'pack.zip:x', 'foo.ts', 'foo.ts:raw']);
  const at = (f) => join(root, f);
  // `read notes?.md:1` read the literal notes?.md (measured), not `notes`
  assert.equal(readTarget({ path: 'notes?.md:1' }, plain(at('notes?.md')), root), at('notes?.md'));
  // `read pack.zip:x` opens the ARCHIVE when pack.zip exists (read.ts: archive before plain read)
  assert.equal(readTarget({ path: 'pack.zip:x' }, resolved(at('pack.zip')), root), at('pack.zip'));
  assert.equal(readTarget({ path: 'foo.ts:raw' }, plain(at('foo.ts:raw')), root), at('foo.ts:raw'));
  assert.equal(readTarget({ path: 'foo.ts:raw:2-4' }, plain(at('foo.ts')), root), at('foo.ts'));
});

// An archive member read as JSON or PDF is reported as `<archive>:<member>` (measured:
// `arc.tar:member.json?q=.x` -> resolvedPath `…/arc.tar:member.json`). The file read is the archive.
test('#109: a reported <archive>:<member> path records the archive', (t) => {
  const root = tree(t, ['arc.tar', 'docs.zip', 'both.zip', 'both.zip:x.json']);
  const at = (f) => join(root, f);
  assert.equal(readTarget({ path: 'arc.tar:member.json?q=.x' }, resolved(at('arc.tar:member.json')), root), at('arc.tar'));
  assert.equal(readTarget({ path: 'docs.zip:dir/spec.pdf:5-9' }, resolved(at('docs.zip:dir/spec.pdf')), root), at('docs.zip'));
  assert.equal(readTarget({ path: 'arc.tar:plain.txt' }, resolved(at('arc.tar')), root), at('arc.tar'));
  // archive and a real file named like the report both exist: the report cannot say which — record neither
  assert.equal(readTarget({ path: 'both.zip:x.json?q=.a' }, resolved(at('both.zip:x.json')), root), '');
});

// r3 review C1/N5: in a REPORTED path `?` is an ordinary file-name character. Cutting the
// container search at it hid the archive from the ambiguity rule and recorded an unread sibling.
test('#109: a ? in a reported path does not hide the archive', (t) => {
  const root = tree(t, ['pack.zip', 'pack.zip?backup.zip', 'what?/arc.zip', 'what?/arc.zip:m.json', 'q?/arc.tar', 'secret.ts', 'up?/arc.tar']);
  const at = (f) => join(root, f);
  const R = (reported) => readTarget({ path: 'x' }, resolved(at(reported)), root);
  assert.equal(R('pack.zip?backup.zip:m.json'), at('pack.zip?backup.zip'), 'the archive read, not the unread pack.zip');
  assert.equal(R('what?/arc.zip:m.json'), '', 'archive and a literal file of the reported name both exist');
  assert.equal(R('q?/arc.tar:m.json'), at('q?/arc.tar'), 'no phantom: the archive is recorded');
  // a member path is never resolved onto another file: `..` lands on secret.ts, which then counts as a
  // second reading (the string is built by hand — join() would collapse the `..` before the module sees it)
  assert.equal(readTarget({ path: 'x' }, resolved(`${root}/up?/arc.tar:m/../../secret.ts`), root), '');
});

// The grammar interprets an input whole or not at all. r4 review: a bounded window peeled part
// of an over-long selector and left a residue such as `f.md:1,:1,`. r6 review: a bounded
// longer-reading scan answered "nothing longer exists" for an input it had not covered, and
// `./`×2100 + `notes?copy.docx` collapsed to the unread file `notes`.
test('#109: an input longer than PATH_MAX is not interpreted — nothing is recorded', (t) => {
  const long = `${'d/'.repeat(2000)}foo.ts`;
  assert.equal(T(`${long}:5-10`), resolve(CWD, long));
  assert.equal(T(`${long}:raw:1-30,:-30`), resolve(CWD, long));
  assert.equal(T(`f.md${':1,'.repeat(8000)}:1`), '', 'no partial strip, no residue');
  const root = tree(t, ['notes', 'notes?copy.docx', 'pack.zip', 'pack.zip:x.docx']);
  const G = (p) => readTarget({ path: p }, undefined, root);
  assert.equal(G('notes?copy.docx'), '', 'short form: the literal file is a longer reading');
  assert.equal(G(`${'./'.repeat(2100)}notes?copy.docx`), '', 'long form must not record the unread notes');
  assert.equal(G(`${'./'.repeat(2100)}pack.zip:x.docx`), '', 'long form must not record the unread pack.zip');
  assert.equal(G(`${'./'.repeat(2040)}notes`), join(root, 'notes'), 'a long input inside the bound is still interpreted');
});

// omp skips a DIRECTORY archive candidate and reads the literal file (read-archive.ts).
test('#109: a directory named like an archive is not an archive candidate', (t) => {
  const root = tree(t, ['pack.zip/inner.txt', 'pack.zip:dir']);
  assert.equal(readTarget({ path: 'pack.zip:dir' }, plain(join(root, 'pack.zip:dir')), root), join(root, 'pack.zip:dir'));
});

// Two archive files on the reported path (`a.zip` and a real file `a.zip:b.zip`): omp tries the
// longest candidate first, but the report alone does not say which one it opened.
test('#109: several archive candidates on a reported path record nothing', (t) => {
  const root = tree(t, ['a.zip', 'a.zip:b.zip']);
  assert.equal(readTarget({ path: 'a.zip:b.zip:m.json?q=.x' }, resolved(join(root, 'a.zip:b.zip:m.json')), root), '');
});

// r6 review (low): only an ARCHIVE member is reported as `<archive>:<member>`; a SQLite or PDF
// read reports the file itself (read-sqlite.ts, read.ts). A `.db` / `.pdf` prefix of a
// reported path is therefore not a candidate — the reported path is the file.
test('#109: a SQLite or PDF prefix of a reported path is not an archive candidate', (t) => {
  const root = tree(t, ['x.db', 'x.db:y.json', 'doc.pdf']);
  const at = (f) => join(root, f);
  assert.equal(readTarget({ path: 'x.db:y.json' }, plain(at('x.db:y.json')), root), at('x.db:y.json'));
  assert.equal(readTarget({ path: 'x' }, resolved(at('doc.pdf:notes')), root), at('doc.pdf:notes'), 'a phantom, never the unread doc.pdf');
});

// A read addressed through a URL is not a read of the local file behind it, even though omp
// reports one (measured: `rule://harness-tdd_policy` -> resolvedPath `.omp/rules/harness-tdd_policy.md`).
test('#109: a URL-addressed read is not tracked even when omp reports a backing file', (t) => {
  const root = tree(t, ['rules/x.md', 'plan.md', 'big.txt']);
  const backed = (abs, url) => ({ resolvedPath: abs, meta: { source: { type: 'internal', value: url } } });
  assert.equal(readTarget({ path: 'rule://x' }, backed(join(root, 'rules/x.md'), 'rule://x'), root), '');
  assert.equal(readTarget({ path: 'local://plan.md:1-5' }, backed(join(root, 'plan.md'), 'local://plan.md'), root), '');
  assert.equal(readTarget({ path: 'https://example.com/a?b=1' }, { kind: 'url', meta: { source: { type: 'url', value: 'https://example.com/a?b=1' } } }, root), '');
  // r3 review C2: omp finds a `/scheme://` URL ANYWHERE in the input, also after a `?`; a notice-only
  // result for a large located file names a file that was not read (read.ts)
  assert.equal(readTarget({ path: '/tmp/p?x/local://big.txt:raw' }, backed(join(root, 'big.txt'), 'local://big.txt'), root), '');
  assert.equal(readTarget({ path: 'plan.md?q=a/local://plan.md' }, backed(join(root, 'plan.md'), 'local://plan.md'), root), '');
  // … and the guard is on the INPUT, whatever the result claims: a path source does not make a
  // URL-addressed read local
  assert.equal(readTarget({ path: '/tmp/p?x/local://big.txt:raw' }, resolved(join(root, 'big.txt')), root), '');
  assert.equal(readTarget({ path: 'local:/plan.md' }, plain(join(root, 'plan.md')), root), '');
});

// The source type is omp's own statement of WHAT was read. Anything but `path` is not a file
// read, whatever the input looks like and whatever else the details carry.
test('#109: only a result whose source is a path is attributed to a file', (t) => {
  const root = tree(t, ['custom:item', 'docs:readme.md', 'plan.md', 'invoice', 'nested/invoice?copy.docx']);
  const at = (f) => join(root, f);
  const internal = (value) => ({ meta: { source: { type: 'internal', value } } });
  // r3 review C3: an opaque MCP resource (no `://`) whose name collides with a local file
  assert.equal(readTarget({ path: 'custom:item?view=summary' }, internal('custom:item?view=summary'), root), '');
  assert.equal(readTarget({ path: 'docs:readme.md' }, internal('docs:readme.md'), root), '');
  // a resolved path without a path source names a file omp did not show — measured: an out-of-range
  // selection (`f.mjs:600-760` on a 494-line file) returns a notice with resolvedPath and no source
  assert.equal(readTarget({ path: 'plan.md:raw' }, { resolvedPath: at('plan.md') }, root), '');
  assert.equal(readTarget({ path: 'plan.md:raw' }, { resolvedPath: at('plan.md'), meta: { source: { type: 'internal', value: 'local://plan.md' } } }, root), '');
  // r3 review N1: a suffix-resolved read whose conversion failed reports no source; omp opened
  // nested/invoice?copy.docx, and the grammar would have picked the unread root file `invoice`
  assert.equal(readTarget({ path: 'invoice?copy.docx:1' }, { suffixResolution: { from: 'invoice?copy.docx', to: 'nested/invoice?copy.docx' } }, root), '');
  // … and a path source is still honoured
  assert.equal(readTarget({ path: 'plan.md:raw' }, plain(at('plan.md')), root), at('plan.md'));
  // details that say nothing about the source are not a licence to guess from the input. Measured
  // (r6): a failed document conversion returns `{fileSize}` only; the content was never shown
  assert.equal(readTarget({ path: 'plan.md' }, {}, root), '');
  assert.equal(readTarget({ path: 'plan.md:1-5' }, { fileSize: 10 }, root), '');
  assert.equal(readTarget({ path: 'invoice?copy.docx' }, { fileSize: 10 }, root), '');
  // r7 review: only ABSENT details (null / undefined) are "no details". A malformed value never
  // falls through to the grammar and never throws
  for (const d of [0, '', false, NaN, 'str', [], { meta: null }, { meta: { source: null } }, { meta: { source: 'path' } }, { meta: { source: { type: 'path', value: 42 } } }, { meta: { source: { type: 'PATH', value: at('plan.md') } } }]) {
    assert.equal(readTarget({ path: 'plan.md' }, d, root), '', `details ${JSON.stringify(d)}`);
  }
  assert.equal(readTarget({ path: 'plan.md' }, null, root), at('plan.md'), 'null is the absence of details');
  // a non-string resolvedPath is ignored in favour of the validated source value
  assert.equal(readTarget({ path: 'x' }, { resolvedPath: 42, meta: { source: { type: 'path', value: at('plan.md') } } }, root), at('plan.md'));
});

// A list read (`a.md;b.md`) records NOTHING (list support was split off to #150). omp marks a
// list result with details.displayReadTargets and links every part it OPENED — including one it
// did not display (measured: `a.md:99999;b.md:2-3` links a.md, body says "beyond end of file") —
// so neither the links nor the input can say which files' content the model saw.
test('#109: a list read records nothing, whatever its parts and links say', (t) => {
  const root = tree(t, ['a.md', 'b.md']);
  const [a, b] = [join(root, 'a.md'), join(root, 'b.md')];
  const list = (parts, links) => ({ notes: [`Note: interpreted as ${parts.length} paths: ${parts.join(', ')}`], displayReadTargets: parts, displayReadTargetLinks: links });
  assert.equal(readTarget({ path: 'a.md;b.md' }, list(['a.md', 'b.md'], [a, b]), root), '');
  assert.equal(readTarget({ path: 'a.md:1-5;b.md:3-9' }, list(['a.md:1-5', 'b.md:3-9'], [a, b]), root), '');
  assert.equal(readTarget({ path: 'a.md:99999;b.md:2-3' }, list(['a.md:99999', 'b.md:2-3'], [a, b]), root), '');
  assert.equal(readTarget({ path: 'a.md,b.md' }, list(['a.md', 'b.md'], [a, b]), root), '', 'a recovered comma list is a list too');
  // a list result is not rescued by other details: a path source next to the list marker records nothing
  assert.equal(readTarget({ path: 'a.md;b.md' }, { ...list(['a.md', 'b.md'], [a, b]), ...plain(a) }, root), '');
});

// Whether a path is a list is omp's call — the input is never split here. Without the list
// marker a `;` is part of ONE path (a SQL query, or a file name).
test('#109: a ; in a path omp did not fan out is not split', (t) => {
  const root = tree(t, ['a.md', 'b.md', 'a.sqlite', 'b.txt']);
  const at = (f) => join(root, f);
  assert.equal(readTarget({ path: 'a.sqlite?q=SELECT name FROM users; b.txt' }, resolved(at('a.sqlite')), root), at('a.sqlite'));
  assert.equal(readTarget({ path: 'a.sqlite?q=SELECT 1;b.txt' }, undefined, root), at('a.sqlite'), 'grammar: one SQL query, b.txt untouched');
  assert.equal(readTarget({ path: 'a.md;b.md' }, undefined, root), join(root, 'a.md;b.md'), 'one (phantom) path, neither a.md nor b.md');
  assert.equal(readTarget({ path: 'artifact://142?q=sub("~[0-9]+$"; "")&compact=true' }, undefined, root), '');
});

// ── Grammar fallback (a result that carries no details at all). The grammar's pick is trusted
// only when no LONGER reading of the same string exists on disk; otherwise nothing is
// recorded. ──────────────────────────────────────────────────────────────────────────────
test('#109 fallback: the grammar pick is recorded when it is the only reading on disk', (t) => {
  const root = tree(t, ['foo.ts', 'data.json', 'out/a.tar', 'db.sqlite']);
  const G = (p) => readTarget({ path: p }, undefined, root);
  assert.equal(G('foo.ts:5-10'), join(root, 'foo.ts'));
  assert.equal(G('data.json?q=.x:1-1'), join(root, 'data.json'));
  assert.equal(G('out/a.tar:inner.zip:f.txt'), join(root, 'out/a.tar'));
  assert.equal(G('db.sqlite:users?limit=5'), join(root, 'db.sqlite'));
  // the part before `?` is taken as it stands: `data:raw?q=.x` queries the file `data:raw`, not `data`
  const colon = tree(t, ['data', 'data:raw']);
  assert.equal(readTarget({ path: 'data:raw?q=.x' }, undefined, colon), join(colon, 'data:raw'));
});

test('#109 fallback: when a longer reading exists on disk, nothing is recorded', (t) => {
  const root = tree(t, [
    'notes', 'notes?.md', // literal file with a `?`
    'foo.ts', 'foo.ts:raw', // literal file ending in a selector
    'pack.zip', 'pack.zip:x', // literal file shaped like an archive member
    'a.md', 'a.md:1-2,', // omp's unfolded split of `a.md:1-2,:-1`
    'a', 'a?b.zip', // an archive whose name contains `?`
    'nested/a.tar', 'nested/a.tar:inner.zip', // a longer container candidate
  ]);
  for (const p of ['notes?.md', 'notes?.md:1', 'foo.ts:raw', 'foo.ts:raw:2-4', 'pack.zip:x', 'pack.zip:x:1-5', 'a.md:1-2,:-1', 'a?b.zip:m', 'nested/a.tar:inner.zip:f.txt']) {
    assert.equal(readTarget({ path: p }, undefined, root), '', `ambiguous on disk, must record nothing: ${p}`);
  }
  // r7 review: a longer reading that ends at a `?` with no later `:` — the scan must stop there too
  const pics = tree(t, ['pic', 'pic?v2.png']);
  assert.equal(readTarget({ path: 'pic?v2.png?q=describe' }, undefined, pics), '', 'the literal pic?v2.png is a longer reading than pic');
});

// ── #152: what a `write` / `edit` call really touches. Mirrors omp 18.22.0 `write.ts`
// (`#resolveArchiveWritePath`, `#resolveSqliteWritePath`, `assertWriteTargetAddressable`),
// `path-utils.ts` (`expandPath`, `resolveToCwd`), the router's `normalize`, and pi-edit's
// `path_policy.rs` (`resolve`, `address`, `expand_path`). "measured" = run against the live
// tools on 18.22.0 (2026-11-21). ─────────────────────────────────────────────────────────────
const W = (path, cwd = CWD) => editTargets('write', { path }, cwd);
const E = (input, cwd = CWD) => editTargets('edit', input, cwd);

test('#152-1: a write to an archive member targets the archive (measured: arc.tar is what changes)', (t) => {
  const arc = resolve(CWD, 'arc.tar');
  assert.deepStrictEqual(W('arc.tar:member.json'), [arc]);
  assert.deepStrictEqual(W('build/assets.tar.gz:css/app.css'), [resolve(CWD, 'build/assets.tar.gz')]);
  assert.deepStrictEqual(W('pkg.JAR:META-INF/x'), [resolve(CWD, 'pkg.JAR')]);
  assert.deepStrictEqual(W('old.7z:m.txt'), [resolve(CWD, 'old.7z')], 'omp refuses a read-only format; the gate still names the archive');
  assert.deepStrictEqual(W('[arc.tar:member.json#1A2B]'), [arc], 'the wrapper comes off first');
  assert.deepStrictEqual(W('arc.tar'), [arc], 'no member: the archive file itself is overwritten');
  assert.deepStrictEqual(W('notes.tar.md:x'), [resolve(CWD, 'notes.tar.md:x')], 'the extension must end at the colon');
  // the gate (tool_call) and the ledger (tool_result) see the same file
  assert.deepStrictEqual(mutationCallTargets('write', { path: 'arc.tar:member.json', content: '{}' }, CWD), [arc]);
  assert.deepStrictEqual(mutationRoute('write', { path: 'arc.tar:member.json', content: '{}' }, undefined, '', CWD), { kind: 'files', files: [arc] });
  // several candidates: the longest existing FILE wins, a directory is skipped, and when none
  // exists the shortest is the archive omp would create
  const root = tree(t, ['a.zip', 'a.zip:b.zip', 'only.zip:inner.zip', 'd.zip', 'd.zip:e.zip/keep.txt']);
  assert.deepStrictEqual(W('a.zip:b.zip:c.txt', root), [join(root, 'a.zip:b.zip')]);
  assert.deepStrictEqual(W('only.zip:inner.zip:c.txt', root), [join(root, 'only.zip:inner.zip')]);
  assert.deepStrictEqual(W('d.zip:e.zip:c.txt', root), [join(root, 'd.zip')]);
  assert.deepStrictEqual(W('x.zip:y.zip:c.txt', root), [join(root, 'x.zip')]);
});

test('#152-1: a write to a SQLite row targets the database omp opens', (t) => {
  assert.deepStrictEqual(W('db.sqlite:users'), [resolve(CWD, 'db.sqlite')], 'a missing database: omp refuses the write');
  const root = tree(t, ['notes.db', 'notes.db:users', 'fake.db3', 'd.db/keep.txt']);
  writeFileSync(join(root, 'app.sqlite'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
  const at = (f) => [join(root, f)];
  assert.deepStrictEqual(W('app.sqlite:users', root), at('app.sqlite'));
  assert.deepStrictEqual(W('app.sqlite:users:42', root), at('app.sqlite'));
  assert.deepStrictEqual(W('app.sqlite?q=SELECT 1', root), at('app.sqlite'), 'omp rejects a query on a write; still the database');
  assert.deepStrictEqual(W('app.sqlite', root), at('app.sqlite'), 'no table: the file itself');
  // an existing file that is not SQLite suppresses the reading: omp writes the literal name
  assert.deepStrictEqual(W('notes.db:users', root), at('notes.db:users'));
  assert.deepStrictEqual(W('fake.db3:t', root), at('fake.db3:t'));
  assert.deepStrictEqual(W('d.db:t', root), at('d.db'), 'a directory is no candidate, so no database exists');
  assert.deepStrictEqual(W('x.tar:app.sqlite:t', root), at('x.tar'), 'archive detection runs first');
});

test('#152-2: write resolves a path the way omp expandPath does (measured: @/abs/file.md)', () => {
  const home = homedir();
  for (const [p, file] of [
    ['@/abs/file.md', '/abs/file.md'],
    ['@~/x.md', join(home, 'x.md')],
    ['@~', home],
    ['~/x.md', join(home, 'x.md')],
    ['~x.md', join(home, 'x.md')],
    [':/abs/x.md', '/abs/x.md'],
    [':./rel.md', resolve(CWD, 'rel.md')],
    [':../up.md', resolve(CWD, '../up.md')],
    [':~/x.md', join(home, 'x.md')],
    ['a\u00A0b\u202Fc.md', resolve(CWD, 'a b c.md')],
    ['[@/abs/file.md#1A2B]', '/abs/file.md'],
    ['@/abs/a.zip:m.txt', '/abs/a.zip'],
    // not shorthands: a literal file name
    ['@my-file.txt', resolve(CWD, '@my-file.txt')],
    ['@~x', resolve(CWD, '@~x')],
    [':x.md', resolve(CWD, ':x.md')],
    ['a/~/b.md', resolve(CWD, 'a/~/b.md')],
  ]) {
    assert.deepStrictEqual(W(p), [file], p);
  }
  assert.deepStrictEqual(W('@local://plan.md'), [], 'an @-mentioned internal URL is not a file');
});

test('#152-2: under WSL a Windows drive path is the mounted file for write, a literal name for edit', { skip: process.platform !== 'linux' && 'omp maps drive paths to /mnt only under WSL' }, (t) => {
  const saved = [process.env.WSL_DISTRO_NAME, process.env.WSL_INTEROP];
  t.after(() => {
    for (const [i, key] of ['WSL_DISTRO_NAME', 'WSL_INTEROP'].entries()) {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }
  });
  const drive = 'C:\\Users\\me\\f.md';
  process.env.WSL_DISTRO_NAME = 'Ubuntu';
  assert.deepStrictEqual(W(drive), ['/mnt/c/Users/me/f.md']);
  assert.deepStrictEqual(W('c:/Users/me/../f.md'), ['/mnt/c/Users/f.md']);
  assert.deepStrictEqual(W('@D:\\x.md'), ['/mnt/d/x.md']);
  assert.deepStrictEqual(E({ path: drive }), [resolve(CWD, drive)], 'pi-edit omits the WSL mapping');
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
  assert.deepStrictEqual(W(drive), [resolve(CWD, drive)]);
});

// #152 AC5 (user decision 2026-11-23). Two shapes of a `write` path do not say which file omp
// opens, both measured on omp 18.22.0: behind a SECOND wrapper omp writes what it refuses at
// the top level (`[[file:///…/victim.md]]` overwrote the file, `[[rule://zzprobe]]` the rule's
// backing file), and a `file://` URL goes through Bun's URL parser, which Node's does not
// match (`file:///a:b/../tmp/x`: Bun `/tmp/x`, Node `/a:b/tmp/x`). Such a call is refused.
test('#152-9: a doubly wrapped or file:// write path is refused, never resolved', () => {
  const refused = (path) => mutationRefusal('write', { path, content: 'x' });
  for (const p of [
    '[[src/foo.ts]]', '[[src/foo.ts#1A2B]#9f0e]', '[[src/foo.ts]] ', '[[[src/foo.ts]]]', '[[@/abs/file.md]]',
    '[[file:///abs/victim.md]]', '[[file:///a:b/../tmp/victim.md]]', '[[rule://x]]', '[[local://plan.md]]', '[[xd://ast_edit]]', '[[x.tar:m]]',
    'file:///abs/a%20b.md', 'FILE:///abs/x.md', 'file:///a:b/../tmp/victim.md', 'file:///tmp/vic\ntim.md', 'file://host/x', '[file:///abs/x.md#1A2B]',
    'file:///abs/a.zip:m.txt', 'file:///abs/app.sqlite:users',
  ]) {
    assert.match(refused(p) ?? '', /^HARNESS BLOCK: write path .* — the harness cannot tell which file omp would open\./s, JSON.stringify(p));
    assert.deepStrictEqual(W(p), [], `no file is named either: ${JSON.stringify(p)}`);
  }
  assert.equal(mutationRefusal('write', { file_path: '[[src/foo.ts]]' }) === null, false, 'path aliases too');
  // everything else is judged as before: one wrapper, plain and expanded paths, URLs, `edit`
  for (const p of ['src/foo.ts', '[src/foo.ts#1A2B]', '[src/foo.ts]', '@/abs/file.md', 'arc.tar:member.json', '[a.zip]:m', 'xd://ast_edit', '[xd://ast_edit#1A2B]',
    'local://plan.md', 'https://example.com/a', '@file:///abs/x.md', 'notes/file://x.md', '[src/foo.ts#9F0E1]', '']) {
    assert.equal(refused(p), null, JSON.stringify(p));
  }
  assert.equal(mutationRefusal('write', {}), null);
  assert.equal(mutationRefusal('edit', { path: '[[src/foo.ts]]' }), null, 'pi-edit unwraps once and reads file:// without a URL parser');
  assert.equal(mutationRefusal('edit', { path: 'file:///abs/x.md' }), null);
});

// What omp refuses at the top level is judged as the file it would have opened; only what it
// dispatches stays a URL — including the single-slash form the event plumbing shows for one.
test('#152-3: a top-level write is a URL only where omp dispatches one', () => {
  for (const p of ['xd://resolve', 'xd:/retain', 'XD:/retain', 'cfg:/ns/key', 'local:/plan.md', 'skill://x/y.md']) {
    assert.deepStrictEqual(W(p), [], p);
  }
  assert.deepStrictEqual(W('https://example.com/a'), [resolve(CWD, 'https:/example.com/a')]);
  assert.deepStrictEqual(W('@file:///abs/x.md'), [resolve(CWD, '@file:/abs/x.md')], 'behind an @ it is no file:// URL to omp either');
  // omp refuses `scheme:/…` on ONE line only: with a line break the string is a file name
  assert.deepStrictEqual(W('xd:/x\ny'), [resolve(CWD, 'xd:/x\ny')]);
});

// `edit` paths are resolved by pi-edit (crates/pi-edit path_policy.rs), for every path the
// model authored: a copied header comes off a direct `path` too, and the head is expanded by
// pi-edit's own `expand_path`, which is NOT the TypeScript `expandPath`.
test('#152-2/4: edit targets lose a [path#TAG] wrapper and are expanded as pi-edit expands them', () => {
  const foo = resolve(CWD, 'src/foo.ts');
  const home = homedir();
  for (const p of ['[src/foo.ts#1A2B]', '[src/foo.ts]', '[src/foo.ts#9f0e] ']) {
    assert.deepStrictEqual(E({ path: p }), [foo], `direct path ${JSON.stringify(p)}`);
    assert.deepStrictEqual(E({ paths: [p] }), [foo], `parsed target ${JSON.stringify(p)}`);
  }
  assert.deepStrictEqual(E({ path: '[src/foo.ts#9F0E1]' }), [resolve(CWD, '[src/foo.ts#9F0E1]')], 'a 5-hex tag is no wrapper');
  assert.deepStrictEqual(E({ path: '[[src/foo.ts]]' }), [resolve(CWD, '[src/foo.ts]')], 'pi-edit unwraps once');
  assert.deepStrictEqual(E({ path: '@/abs/file.md' }), ['/abs/file.md']);
  assert.deepStrictEqual(E({ paths: ['~/y.md'] }), [join(home, 'y.md')]);
  assert.deepStrictEqual(E({ path: '~y.md' }), [join(home, 'y.md')]);
  assert.deepStrictEqual(E({ input: '[@~/x.md#1A2B]\n+x\n' }), [join(home, 'x.md')]);
  assert.deepStrictEqual(E({ path: '@local://plan.md' }), []);
  assert.deepStrictEqual(E({ path: '/' }), [CWD], 'a path of slashes only is the cwd');
});

// r1 review: each row is a place where pi-edit and the TypeScript helpers disagree. Gated with
// the `write` rules, the left column named a file that does not exist while `edit` changed the
// right one.
test('#152-2: edit follows pi-edit where it differs from write', () => {
  const home = homedir();
  for (const [p, edited, written] of [
    // `home.join(rest)`: an absolute rest REPLACES the home directory; `write` appends text
    ['~//tmp/victim.txt', '/tmp/victim.txt', join(home, 'tmp/victim.txt')],
    ['~\\victim.txt', join(home, 'victim.txt'), `${home}\\victim.txt`],
    // the stray `:` goes before `./` and `../` only; `write` drops it before `.\` too
    [':.\\x.md', resolve(CWD, ':.\\x.md'), resolve(CWD, '.\\x.md')],
    // `@` goes before any drive prefix; `write` wants a Windows ABSOLUTE path
    ['@C:foo', resolve(CWD, 'C:foo'), resolve(CWD, '@C:foo')],
    // `file://` is a path, classified before it is decoded, and decoded by pi-edit's own decoder
    // (`%+1` is a byte there); a `write` of that shape is refused (#152-9)
    ['file:///abs/a%20b.md', '/abs/a b.md', null],
    ['file://xd://x', resolve(CWD, 'xd:/x'), null],
    ['file://bad%ZZ', resolve(CWD, 'file:/bad%ZZ'), null],
    ['file:///tmp/%+1/../victim.md', '/tmp/victim.md', null],
    ['file:///tmp/%C3%A9.md', '/tmp/\u00e9.md', null],
    ['file:///a:b/../tmp/victim.md', '/tmp/victim.md', null],
    ['@file:///abs/x.md', resolve(CWD, '@file:/abs/x.md'), resolve(CWD, '@file:/abs/x.md')],
    // trailing whitespace before the wrapper test: U+FEFF is JavaScript's only, U+0085 Rust's only
    ['[victim.txt]\uFEFF', resolve(CWD, '[victim.txt]\uFEFF'), resolve(CWD, 'victim.txt')],
    ['[victim.txt]\u0085', resolve(CWD, 'victim.txt'), resolve(CWD, '[victim.txt]\u0085')],
    // a verbatim prefix with a plain spelling is dropped by pi-edit on every platform
    ['\\\\?\\C:\\x.md', resolve(CWD, 'C:\\x.md'), resolve(CWD, '\\\\?\\C:\\x.md')],
  ]) {
    assert.deepStrictEqual(E({ path: p }), [edited], `edit ${JSON.stringify(p)}`);
    assert.deepStrictEqual(W(p), written === null ? [] : [written], `write ${JSON.stringify(p)}`);
  }
  // the single-slash spelling of a known scheme is refused by pi-edit: no file
  assert.deepStrictEqual(E({ path: 'file:/abs/x.md' }), []);
  assert.deepStrictEqual(E({ path: '' }), [], 'an empty path names no file');
  // an escape that is not UTF-8 fails to decode: pi-edit keeps the string, still a path
  assert.deepStrictEqual(E({ path: 'file:///tmp/%FF.md' }), [resolve(CWD, 'file:/tmp/%FF.md')]);
});

test('#152-3: `://` inside a local path does not make it virtual (measured: notes/a://b.md is written)', (t) => {
  const file = resolve(CWD, 'notes/a:/b.md');
  assert.deepStrictEqual(W('notes/a://b.md'), [file]);
  assert.deepStrictEqual(E({ path: 'notes/a://b.md' }), [file]);
  assert.equal(localFileTarget('notes/a://b.md', CWD), file);
  assert.deepStrictEqual(W('./pkg://danger.ts'), [resolve(CWD, 'pkg:/danger.ts')], "omp's own spelling for a URI-looking file name");
  assert.deepStrictEqual(W('pkg://danger.ts'), [resolve(CWD, 'pkg:/danger.ts')], 'omp refuses an unknown scheme; the gate judges the file it would name');
  assert.deepStrictEqual(W('dir/skill://x.md'), [resolve(CWD, 'dir/skill:/x.md')], 'only local:// is rewritten behind a path prefix');
  assert.deepStrictEqual(W('foo:bar/local://x.md'), [resolve(CWD, 'foo:bar/local:/x.md')], 'no rewrite behind a scheme-shaped prefix');
  assert.deepStrictEqual(W('notes/a://local://x.md'), [resolve(CWD, 'notes/a:/local:/x.md')], 'the router scans segments without overlap');
  // the read of such a file is recorded, so the gated write is not blocked for good
  const root = tree(t, ['notes/a:/b.md']);
  assert.equal(readTarget({ path: 'notes/a://b.md' }, plain(join(root, 'notes/a:/b.md')), root), join(root, 'notes/a:/b.md'));
  assert.equal(readTarget({ path: '@local://plan.md' }, plain(join(root, 'notes/a:/b.md')), root), '', 'an @-mentioned URL is still a URL-addressed read');
  // what omp's router routes as a URL stays virtual: a registered scheme, a path glued in front
  // of local:// (`normalize`), a `<file>:conflict://N` (`recoverConflictUriPrefix`)
  for (const p of ['local://plan.md', '/tmp/x/local://plan.md', 'sub\\local://plan.md', 'src/a.ts:conflict://3']) {
    assert.deepStrictEqual(W(p), [], `write must not gate: ${p}`);
  }
  // pi-edit has neither rewrite: both are files to `edit`
  assert.deepStrictEqual(E({ path: 'dir/local://x.md' }), [resolve(CWD, 'dir/local:/x.md')]);
  assert.deepStrictEqual(E({ path: 'src/a.ts:conflict://3' }), [resolve(CWD, 'src/a.ts:conflict:/3')]);
});

// omp splits its output on `\n` alone; JavaScript's `m` flag also starts a line after U+2028,
// U+2029 and a lone CR, so text INSIDE a displayed line could pose as a header.
test('#152-5: only a line feed starts a [path#TAG] header line', () => {
  const a = resolve(CWD, 'a.md');
  for (const sep of ['\u2028', '\u2029', '\r']) {
    assert.deepEqual(searchTrackTargets(undefined, `[a.md#1A2B]\n12:x${sep}[victim.md#1A2B]\n13:y`, CWD), [a], `search text, ${JSON.stringify(sep)}`);
    assert.deepStrictEqual(E({ input: `[a.md#1A2B]\n+x${sep}[victim.md#1A2B]\n` }), [a], `patch body, ${JSON.stringify(sep)}`);
  }
  assert.deepEqual(searchTrackTargets(undefined, '[a.md#1A2B]\r\n*1:x\r\n[b.md#1A2B]', CWD), [a, resolve(CWD, 'b.md')], 'CRLF output still parses');
});

// omp's TypeScript tools hand an ABSOLUTE path to the file system as spelled, so the kernel
// resolves `..` after following a symlink (measured for read and write: with link -> real/sub,
// `<root>/link/../x` is `<root>/real/x`, reported verbatim). A relative path is folded by
// `path.resolve` first, and pi-edit folds every path lexically.
test('#152-7: an absolute path keeps the kernel reading of `..` behind a symlink; edit folds it', { skip: process.platform === 'win32' && 'needs a POSIX symlink' }, (t) => {
  const root = tree(t, ['real/sub/keep', 'real/secret.ts', 'secret.ts', 'real/pack.zip', 'pack.zip']);
  symlinkSync(join('real', 'sub'), join(root, 'link'));
  const spelled = `${root}/link/../secret.ts`;
  assert.equal(readTarget({ path: spelled }, plain(spelled), root), join(root, 'real/secret.ts'));
  assert.deepStrictEqual(W(spelled, root), [join(root, 'real/secret.ts')]);
  assert.deepStrictEqual(W('link/../secret.ts', root), [join(root, 'secret.ts')]);
  assert.deepStrictEqual(E({ path: spelled }, root), [join(root, 'secret.ts')]);
  assert.equal(readTarget({ path: `${root}/link/../pack.zip:m.json?q=.x` }, resolved(`${root}/link/../pack.zip:m.json`), root), join(root, 'real/pack.zip'));
  // nothing on disk to follow: the lexical reading stands
  assert.deepStrictEqual(W(`${root}/nodir/../n.md`, root), [join(root, 'n.md')]);
  assert.deepStrictEqual(W(`${root}/link/new/../n.md`, root), [join(root, 'link/n.md')]);
  // r1 review: only a name that IS a link is followed. Under a symlinked ancestor the textual
  // parent is the same directory, and its spelling is what a later relative edit resolves to.
  symlinkSync('real', join(root, 'ws'));
  const under = `${root}/ws/sub/../secret.ts`;
  assert.equal(readTarget({ path: under }, plain(under), root), join(root, 'ws/secret.ts'));
  assert.deepStrictEqual(E({ path: 'ws/secret.ts' }, root), [join(root, 'ws/secret.ts')]);
  // r2 review: a link whose target spells `..` past another link — the system call resolves
  // it, Node's own realpathSync would fold it as text and land in real/
  const nest = tree(t, ['else/sub/keep', 'else/victim.md', 'real/sub/keep', 'real/victim.md']);
  symlinkSync('../else/sub', join(nest, 'real/second'));
  symlinkSync('real/second/../sub', join(nest, 'link')); // spelled out: path.join would fold the `..`
  assert.deepStrictEqual(W(`${nest}/link/../victim.md`, nest), [join(nest, 'else/victim.md')]);
});

// #152 item 8. Measured on omp 18.22.0: beside an existing `a.zip`, `read a.zip:b.json` reads
// the MEMBER (or fails when there is none), so a literal file named `a.zip:b.json` is read only
// while `a.zip` does not exist. A plain read of it reports a bare path source; a `?q=` read
// reports `resolvedPath` as well — the very details a member query read carries.
test('#152-8: a literal file read and then deleted is not taken for a member read — except a read that reports resolvedPath (residual)', (t) => {
  const root = tree(t, ['a.zip:b.json']); // at read time: the literal file, no archive
  const literal = join(root, 'a.zip:b.json');
  const plainRead = plain(literal); // details of `read a.zip:b.json`
  const queryRead = resolved(literal); // details of `read a.zip:b.json?q=.k`
  assert.equal(readTarget({ path: 'a.zip:b.json' }, plainRead, root), literal);
  assert.equal(readTarget({ path: 'a.zip:b.json?q=.k' }, queryRead, root), literal);
  // the race: before the handler runs, the literal file is deleted and an archive a.zip appears
  rmSync(literal);
  writeFileSync(join(root, 'a.zip'), 'x\n');
  assert.equal(readTarget({ path: 'a.zip:b.json' }, plainRead, root), literal, 'a bare path source is never reduced: the unread a.zip is not recorded');
  // kept residual: this report is the one a member query read produces, on the disk one leaves
  assert.equal(readTarget({ path: 'a.zip:b.json?q=.k' }, queryRead, root), join(root, 'a.zip'));
  // kept residual, second form (measured): a literal file that is itself an archive,
  // `a.zip:b.zip`, is opened first even beside `a.zip`, and every archive read reports
  // `resolvedPath`. Here only the deletion is needed.
  const both = tree(t, ['a.zip', 'a.zip:b.zip']);
  const listing = { ...resolved(join(both, 'a.zip:b.zip')), isDirectory: true };
  assert.equal(readTarget({ path: 'a.zip:b.zip' }, listing, both), '', 'both on disk: the report is ambiguous, nothing is recorded');
  rmSync(join(both, 'a.zip:b.zip'));
  assert.equal(readTarget({ path: 'a.zip:b.zip' }, listing, both), join(both, 'a.zip'));
});
