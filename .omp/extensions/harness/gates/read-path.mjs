// read-path.mjs — resolve the real local files a `read` / `write` / `edit` call targets.
//
// Imported by index.ts (a helper module, never spawned as a gate). It yields the
// bare file path context-gate later compares an edit against: for a read, the
// file omp reports it read (or, for a result that carries no details at all, the
// path with its selector, `?` query or container member stripped); for a write or
// an edit, the file the tool opens for the path the model authored — hashline
// wrapper removed, `@` / `~` shorthand expanded, an archive or SQLite member reduced
// to its container (#152). Web URLs / internal URIs — not local files worth
// tracking — yield nothing.
//
// The two failure directions are not symmetric. A form omp accepts that is left
// unstripped logs a phantom path (e.g. "foo.ts:raw"), so a later edit of "foo.ts"
// falsely fails context-gate — annoying, safe. The worse direction marks a file as
// read that never was, or misses the file a write really touches. Where this
// module cannot know what omp did, it records nothing or a phantom.
//
// Mirrored against omp 18.22.0 (reads 2026-11-20, #109; write / edit targets
// 2026-11-21, #152). Sources: `omp://tools/read.md` (selector grammar, modes,
// internal URL registry, result details), `xd://read/sources` (special source
// selectors — the model-facing canon since 18.20.0), `omp://tools/write.md`, and the
// v18.22.0 source: `splitPathAndSel` (packages/tui/src/tools/read.ts +
// line-ranges.ts), `readDetailsLinkPath` (packages/coding-agent/src/tools/read.ts),
// `read-archive.ts`, `unwrapHashlineHeaderPath` (…/tools/hashline-header-path.ts),
// `write.ts` (`#resolveArchiveWritePath`, `#resolveSqliteWritePath`), `expandPath` /
// `resolveToCwd` (…/tools/path-utils.ts), `InternalUrlRouter.normalize`
// (…/internal-urls/router.ts) and pi-edit's `path_policy.rs` (crates/pi-edit/src).
// Forms marked "measured" were run against the live tools on that version. Recheck
// on every omp upgrade; tests/read-selector-oracle holds READ_SELECTOR to a port of
// the splitter and names its two deviations.

import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

// Line selector grammar (splitPathAndSel, case-insensitive):
//   :raw   :conflicts   :img        (standalone; :img — SVG/SVGZ as PNG, 18.2.9+)
//   :N  :LN  :N-  :N..              (start / open-ended)
//   :A-B  :LA-LB  :A..B             (range; `..` is a forgiving `-` alias)
//   :A+C  :LA+LC                    (count)
//   :-N                             (tail: last N lines)
//   :R1,R2,...                      (comma list; an item is a range chunk or a tail,
//                                    `:1-12,-15` — 18.12.4)
//   :R1,:R2                         (the colon may repeat after a comma, `:1-30,:-30`
//                                    reads as `:1-30,-30` — 18.12.4, measured)
//   :list:raw  |  :raw:list         (raw output, EITHER order)
//   :-N+C  :-N-C                    (accepted by the URL-side splitter only; a local
//                                    `a.md:-6+2` is "not found" (measured). Stripping it
//                                    anyway is safe because a FAILED read is never
//                                    tracked: a single read fails as isError, a list
//                                    read is not tracked at all)
// A range chunk must end in a digit, `.` or `-` (upstream lookbehind): `:50+` is no selector.
// NOT mirrored: the splitter also folds `:1-3,5:10` (a colon between two bare numbers of a
// multi-item list) into `:1-3,5-10`. read.md does not document it; unstripped it degrades
// to a phantom (the safe direction).
const CHUNK = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?(?<=[\d.-])`;
const ITEM = String.raw`(?:${CHUNK}|-\d+)`;
const LIST = String.raw`${ITEM}(?:,:?${ITEM})*`;
export const READ_SELECTOR = new RegExp(
	String.raw`:(?:raw(?::${LIST})?|conflicts|img|${LIST}(?::raw)?|-\d+[-+]\d+)$`,
	"i",
);

/** Longest input the grammar looks at (PATH_MAX). The selector regex is tried from every
 *  `:` (quadratic on a `:1,:1,:1,…` path) and the longer-reading scan in `grammarTarget`
 *  stats one candidate per `:` / `?`, so both need a bound. A bound that covers only
 *  PART of an input would peel part of a selector, or answer "no longer reading exists"
 *  for readings it never looked at — and a longer string can still name a real file once
 *  `resolve` collapses it (r6 review: `./`×2100 + `notes?copy.docx`). So an input longer
 *  than this is not interpreted at all: nothing is recorded. */
const PATH_MAX = 4096;

// Container files: everything after the container's extension addresses something
// INSIDE it — an archive member (`arc.tar:dir/member.json?q=.x`, 18.20.0), a SQLite
// table / row / query (`db.sqlite:table:key`, `db.sqlite?q=SELECT …`), a PDF page image
// (`doc.pdf:page3.png`, 18.13.0). The ledger records the container, the file an edit or
// write would replace. Extension tables: read.md "Archives" / "SQLite databases" /
// "Documents". Version-coupled like the scheme list below: an extension omp adds
// degrades to a phantom until it is listed.
const ARCHIVE_EXTENSIONS =
	String.raw`tar(?:\.(?:gz|bz2|xz|zst|z))?|tgz|tbz2?|txz|tzst|` + // tar family
	String.raw`zip|jar|war|ear|apk|whl|ipa|xpi|vsix|nupkg|cbz|` + // ZIP family
	String.raw`rar|cbr|7z|iso|cab|cpio|rpm|ar|a|lib|deb|lzh|lha|arj|asar|` + // standalone
	String.raw`gz|bz2|xz|zst|z|lzma`; // single-stream
// In an INPUT path the selector follows the extension as `:member` or `?query`.
const INPUT_CONTAINER = new RegExp(String.raw`\.(?:${ARCHIVE_EXTENSIONS}|sqlite3?|db3?|pdf)(?=[:?])`, "gi");
// Followed by `:member` alone. In a path omp REPORTS, `?` is an ordinary file-name
// character and only an ARCHIVE read reports `<archive>:<member>` (read-archive.ts; a
// SQLite or PDF read reports the file itself). In a `write` path a `?` opens no archive
// member either (`parseArchivePathCandidates`).
const ARCHIVE_MEMBER_PREFIX = new RegExp(String.raw`\.(?:${ARCHIVE_EXTENSIONS})(?=:)`, "gi");
// A `write` path into a SQLite database, `db.sqlite:table[:key]`. A `?query` is parsed as
// part of the row address and then refused (`parseSqlitePathCandidates`).
const SQLITE_ROW_PREFIX = /\.(?:sqlite3?|db3?)(?=[:?])/gi;

/** What `path` is on disk — "file", "directory", "special" (FIFO, device, socket) — or
 *  null when nothing is there. Symlinks are followed, as omp's own `stat` does. */
function entryKind(path) {
	try {
		const stat = statSync(path);
		return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "special";
	} catch {
		return null;
	}
}

/** True when omp's router takes `input` as a URL of a registered scheme — a port of
 *  `InternalUrlRouter.normalize` + `canHandle` (v18.22.0 internal-urls/router.ts):
 *  `scheme://…` of a registered scheme; `local:/x`, the single-slash alias of the one
 *  scheme that declares `singleSlashAlias`; and a path glued in front of `local://`
 *  (`/repo/local://plan.md`, also behind a `?`), unless that prefix is itself
 *  scheme-shaped. The segments are scanned as the router scans them, left to right
 *  without overlap: in `notes/a://local://x.md` the `/` before `local` belongs to
 *  `a://`, so the string is no URL. */
function routedUrl(input) {
	if (REGISTERED_URL.test(input)) return true;
	if (SCHEME_SHAPED_PREFIX.test(input)) return false;
	for (const segment of input.matchAll(PREFIXED_URL_SEGMENT)) {
		if (segment[1].toLowerCase() === "local") return true;
	}
	return false;
}

/** True for a path that names no local file to track: a URL the router takes
 *  (`routedUrl`), a known scheme at the START in either slash form (URI_SCHEME_PREFIX),
 *  or `<file>:conflict://N`, which read and write reduce to the conflict URL
 *  (`recoverConflictUriPrefix`). This is the test for a `read` input and for a path omp
 *  REPORTS; a `write` path has a narrower one (`writeTarget`), an `edit` path its own
 *  (`editTarget`).
 *  `://` anywhere else is file-name text: `notes/a://b.md` is the file `notes/a:/b.md`
 *  (measured). Until #152 any `://` made a path virtual, so neither the gate nor the
 *  ledgers saw such a file.
 *  Function declaration (hoisted) so every ledger entry point below shares ONE guard —
 *  r3: the read and search-anchor paths previously checked only `://`. */
function isVirtualPath(p) {
	return URI_SCHEME_PREFIX.test(p) || routedUrl(p) || PREFIXED_CONFLICT_URL.test(p);
}

/** Absolute path of the file omp's TypeScript tools (read, write) open for `p`. A
 *  relative path is joined to cwd by `path.resolve`, which folds `..` as text. An
 *  ABSOLUTE path reaches the file system as spelled (`resolveToCwd` returns it
 *  untouched), so the kernel resolves each `..` after following symlinks: with
 *  `link -> real/sub`, `/r/link/../x.md` is `/r/real/x.md` — measured for read and for
 *  write, which both report the path as spelled. Folded as text it named `/r/x.md`, a
 *  different file that was never read (#152 item 7). Only a name that is itself a link
 *  is followed: under a symlinked ANCESTOR (`/ws -> /real-ws`, `/ws/src/..`) the textual
 *  parent is the same directory, and keeping its spelling keeps the entry equal to what
 *  a later relative edit resolves to. Where nothing exists to follow (a directory the
 *  write is about to create), the textual parent stands too. The link is resolved by the
 *  system call: Node's own `realpathSync` folds a `..` inside a link's target as text,
 *  the very mistake this function exists to avoid. */
function openedPath(p, cwd) {
	if (!isAbsolute(p)) return resolve(cwd, p);
	let out = parse(p).root;
	for (const part of p.slice(out.length).split(sep)) {
		if (part === "" || part === ".") continue;
		if (part !== "..") {
			out = join(out, part);
			continue;
		}
		try {
			if (lstatSync(out).isSymbolicLink()) out = realpathSync.native(out);
		} catch {
			// nothing on disk at this point, or a dangling link: no parent to follow to
		}
		out = dirname(out);
	}
	return out;
}

/** Local file behind a path omp reported as `resolvedPath`, or null. The reported path
 *  is the file itself, with one exception: an archive member read through a JSON query
 *  or as a PDF is reported as `<archive>:<member>` (read-archive.ts; a plain text member
 *  read reports the archive itself — measured). So when a prefix of the reported path is
 *  an existing archive FILE (omp skips directory candidates), the path may stand for that
 *  archive. It does when exactly one such archive exists and the reported string itself
 *  names nothing on disk; when both exist (`pack.zip` next to a real file named
 *  `pack.zip:x.json`), or several archives do, nothing is recorded.
 *
 *  The reduction trusts the disk at handler time (#152 item 8, kept as a residual). omp
 *  reads a literal file named `<archive>:<member>` only while that archive does NOT
 *  exist — beside the archive it reads the member, or fails when there is none
 *  (measured). A read of the literal file is therefore mistaken for a member read only if
 *  it carried `resolvedPath` (a `?q=` query read: same details as a member read,
 *  measured) AND, before the handler ran, the archive appeared and the literal file was
 *  deleted. A plain read of the literal file carries no `resolvedPath` and never comes
 *  here (`readTarget`). Refusing the reduction altogether would close the rest, at the
 *  price of a member read no longer unlocking the `write` into that archive. */
function reportedTarget(reported, cwd) {
	const self = localFileTarget(reported, cwd);
	if (!self) return null;
	const archives = [];
	for (const match of reported.matchAll(ARCHIVE_MEMBER_PREFIX)) {
		const archive = openedPath(reported.slice(0, match.index + match[0].length), cwd);
		if (entryKind(archive) === "file") archives.push(archive);
	}
	if (archives.length === 0) return self;
	return archives.length === 1 && !existsSync(self) ? archives[0] : null;
}

/** Local file a read path names by GRAMMAR alone, or null — used only for a result
 *  that carries no details. The pick is the earliest container before any `?`, else
 *  the part before the `?` query as it stands, else the path without its line selector
 *  (`data.json?q=.x:1-1` — the selector addresses the query output, so it goes with
 *  the query).
 *
 *  omp does not resolve by grammar alone: it prefers existing literal files and tries
 *  archive / SQLite candidates against the disk, in an order this module does not
 *  reproduce. Each of those alternatives is a LONGER prefix of the path, ending where
 *  a `:` or `?` starts or at the end (`notes?.md`, `pack.zip:x`, `a.md:1-2,` for
 *  `a.md:1-2,:-1`). If one of them exists, the grammar cannot know which file was
 *  read, and nothing is recorded. The scan covers the whole input or does not run:
 *  see PATH_MAX.
 *
 *  Not covered: resolutions that are NOT a prefix of the input — omp's unique-suffix
 *  match (`notes?copy.docx` found as `nested/notes?copy.docx`) and `~` / `@`
 *  expansion. On this path the pick stays a best guess, which is why `readTarget`
 *  confines it to a result without details. */
function grammarTarget(path, cwd) {
	if (path.length > PATH_MAX) return null;
	const query = path.indexOf("?");
	const container = path.matchAll(INPUT_CONTAINER).next().value;
	const pick =
		container && (query < 0 || container.index < query)
			? path.slice(0, container.index + container[0].length)
			: query < 0
				? path.replace(READ_SELECTOR, "")
				: path.slice(0, query);
	for (let end = pick.length + 1; end <= path.length; end++) {
		if (end < path.length && path[end] !== ":" && path[end] !== "?") continue;
		const longer = localFileTarget(path.slice(0, end), cwd);
		if (longer && existsSync(longer)) return null;
	}
	return localFileTarget(pick, cwd);
}

/** Local file a successful `read` call read; "" when there is none to record (a URL
 *  or internal resource, a list read, a result that names no file).
 *
 *  What was read is omp's knowledge, so it is taken from the RESULT, not re-derived
 *  from the input. `details.meta.source` says what kind of thing was read. Only a
 *  source of type `path` is a file read; the file is `details.resolvedPath` when the
 *  read resolved its input (query, SQLite, PDF page, archive, suffix match), else the
 *  source's own value — omp's `readDetailsLinkPath` (v18.22.0 packages/coding-agent/
 *  src/tools/read.ts). The two differ for a PDF page (`doc.pdf:page3.png`): the source
 *  is the rendered screenshot, `resolvedPath` the PDF (`#readPdfPageScreenshot`).
 *
 *  Any other result with details records nothing: a source that is NOT a path (an
 *  internal resource, a URL), a resolved path or a suffix resolution without a path
 *  source (measured: an out-of-range selection, `f.mjs:600-760` on a 494-line file,
 *  returns a notice with `resolvedPath` and no source), and details that say nothing
 *  about the source at all (measured: a failed document conversion returns
 *  `{fileSize}` only). None of them showed the file's content, and guessing the file
 *  from the input is where r1, r2 and r6 each recorded a file that was never read.
 *  (A path source means omp OPENED the file, not that it showed content: a binary-file
 *  notice or a multi-range entirely past the end still carries one and is recorded,
 *  as before.)
 *
 *  The grammar is used only when the result carries NO details at all — not a shape
 *  omp 18.22.0 produces for a successful read (none in a replay of this host's 1,500
 *  most recent session files, 2026-11-20); it keeps a result this module cannot
 *  interpret from silently recording nothing for a plain path.
 *
 *  A LIST read (`a.md;b.md`, or a `,` / whitespace list omp recovered — marked by
 *  `details.displayReadTargets`) records nothing. omp reports the parts but not which
 *  of them it actually displayed (`a.md:99999;b.md` links a.md and prints only "beyond
 *  end of file", measured), and whether a path is a list at all is omp's call
 *  (`db.sqlite?q=SELECT 1; x.md` is one SQL query), so the input is not split here
 *  either. A file read through a list must be read alone before it can be edited —
 *  the same outcome as before #109, when the whole list was logged as one phantom
 *  path. Recording list parts is tracked in #150.
 *
 *  A read addressed through a URL (`isVirtualPath`, also behind the `@` mention marker
 *  omp strips first) stays untracked even when omp reports a local backing file
 *  (`rule://x` -> `.omp/rules/x.md`): reading the resource is not reading that file
 *  for the purposes of editing it. */
export function readTarget(input, details, cwd) {
	const raw = input?.path;
	if (typeof raw !== "string" || !raw || isVirtualPath(raw) || isVirtualPath(expandPath(raw))) return "";
	if (details == null) return grammarTarget(raw, cwd) ?? "";
	if (Array.isArray(details.displayReadTargets)) return "";
	const source = details.meta?.source;
	if (source?.type !== "path" || typeof source.value !== "string") return "";
	// Only a `resolvedPath` can be the `<archive>:<member>` form; a bare path source is the file.
	const { resolvedPath } = details;
	return (typeof resolvedPath === "string" ? reportedTarget(resolvedPath, cwd) : localFileTarget(source.value, cwd)) ?? "";
}

// The 21 schemes omp's router registers (v18.22.0 internal-urls/router.ts, read.md "Internal URLs").
const INTERNAL_SCHEMES =
	"xd|local|memory|artifact|agent|history|mcp|skill|rule|omp|issue|pr|mr|ssh|proc|conflict|attachment|cfg|security|vault|out";

/** Single-slash prefix of a KNOWN virtual scheme — the omp event plumbing
 *  normalizes `xd://retain` to `xd:/retain` (live-observed 2026-07-16,
 *  session-log `xd:/retain`/`xd:/recall`). The allowlist is deliberate (r4):
 *  POSIX permits `:` in path components, so a generic `<word>:/` rejection
 *  silently dropped legitimate files like `pkg:/danger.ts` from BOTH the
 *  pre-edit gate and the ledgers — worse than a phantom entry. An unknown
 *  future virtual scheme in single-slash form degrades to a phantom (the r2
 *  failure class, annoying but safe); extend the list when one appears.
 *  `proc` (job/service control: `write proc://<id>/kill`, `proc://<name>/mode`,
 *  `read proc://`) and `conflict` (write-only merge resolution) were added for
 *  omp 18.3.0 (2026-09-24, #42); `attachment`, `cfg`, `security`, `vault`, `out`
 *  and `mr` complete the 21-scheme built-in registry of omp 18.22.0 (read.md
 *  "Internal URLs", #109) — `cfg` and `vault` are writable, so a normalized
 *  `cfg:/…` must not reach the write ledger. The single-slash form is defensive,
 *  only `xd` has been observed normalized. */
const URI_SCHEME_PREFIX = new RegExp(`^(?:${INTERNAL_SCHEMES}|https?|file):/`, "i");
// `routedUrl`: the router's `splitUrlScheme` test with a registered scheme (`local:/x` is
// rewritten to `local://x` first), its `URL_PREFIX_RE` and its `PREFIXED_URL_SEGMENT_RE`.
const REGISTERED_URL = new RegExp(`^(?:(?:${INTERNAL_SCHEMES})://|local:/)`, "i");
const SCHEME_SHAPED_PREFIX = /^(?![a-z]:[\\/])[a-z][a-z0-9+.-]*:/i;
const PREFIXED_URL_SEGMENT = /[\\/]([a-z][a-z0-9+.-]*):\/\/(?=[^/]|$)/gi;
// `PREFIXED_CONFLICT_URI_RE` (tools/conflict-detect.ts).
const PREFIXED_CONFLICT_URL = /^.+:conflict:\/\/.+$/;

/** Absolute path of a LOCAL file as omp named it — a path it reported, a path in a result
 *  payload, a path it takes without expansion; null for a URL target (`isVirtualPath`).
 *  Virtual resources must never enter read/write ledgers as `<cwd>/xd:/…` garbage
 *  (live-reproduced on omp 17.0.1, 2026-07-16; r2 counterexample session-log:315). A path
 *  the model AUTHORED for write or edit goes through `writeTarget` / `editTarget` instead:
 *  omp expands those before it opens anything. */
export function localFileTarget(p, cwd) {
	if (typeof p !== "string" || p.length === 0 || isVirtualPath(p)) return null;
	return openedPath(p, cwd);
}

/** Shared normalization: a device/tool result `files` array — string paths
 *  (upstream shape) or objects with a path/file field (defensive) — each entry
 *  passes localFileTarget: URI entries inside RESULT payloads must not
 *  re-pollute the ledgers either. [] when absent or misshaped. */
function normalizedFileList(files, cwd) {
	if (!Array.isArray(files)) return [];
	const out = [];
	for (const f of files) {
		const p = typeof f === "string" ? f : (f && typeof f === "object" ? (f.path ?? f.file ?? f.filePath) : null);
		const t = localFileTarget(p, cwd);
		if (t) out.push(t);
	}
	return out;
}

/** Absolute file paths an ast_edit apply wrote. On omp >=17 the apply is the
 *  xd://resolve dispatch's `inner` ({ action, sourceToolName, sourceResultDetails });
 *  `sourceResultDetails.files` carries the ast_edit apply result. */
export function resolvedAstEditFiles(details, cwd) {
	return normalizedFileList(details?.sourceResultDetails?.files, cwd);
}

/** Absolute file paths on an ast_edit result's own details (`files`) — the
 *  direct-apply shape of an xd://ast_edit dispatch (dryRun:false). */
export function astEditResultFiles(details, cwd) {
	return normalizedFileList(details?.files, cwd);
}

/** v17 xd:// device dispatch envelope on a `write` tool_result's details:
 *  `{ tool, mode, inner }` (tools/resolve.ts writeDeviceDispatch verifies the
 *  same shape). null unless the envelope matches — a plain file write has no
 *  `details.xdev`. */
export function xdevEnvelope(details) {
	const xdev = details && typeof details === "object" ? details.xdev : null;
	if (!xdev || typeof xdev !== "object") return null;
	if (typeof xdev.tool !== "string" || !("mode" in xdev)) return null;
	return xdev;
}

/** Local files a grep/ast_grep result certified with `[path#TAG]` edit anchors.
 *  omp mints a whole-file snapshot per rendered file (grep.md: recordFileSnapshot)
 *  and its edit tool accepts those tags as anchors ("from your latest read/search"),
 *  so context-gate must treat them as read — otherwise a grep-anchored edit
 *  false-blocks (live-reproduced on omp 16.3.12, 2026-07-09).
 *
 *  Primary source: details.files — absolute path strings on BOTH grep and ast_grep,
 *  single and grouped multi-file results alike (measured on omp 16.3.12). Any array
 *  there is trusted as-is, including empty (no matches -> nothing anchored).
 *  Fallback (details.files absent/misshaped): bracketed `[path#TAG]` headers in the
 *  result text — the single-file output form. Grouped tree headers (`## file.ts#TAG`)
 *  are deliberately NOT reconstructed: directory-stack parsing is format-coupled and
 *  a wrong join would track the WRONG file (loosening the gate), while under-tracking
 *  merely keeps the old strictness. Internal URIs (`://`) never track — virtual
 *  resources don't mint editable anchors. The path may itself contain `#` (yadm
 *  `config##Linux`; hashline headers accept it since omp 18.4.1) — the tag is the
 *  LAST `#`-segment. */
const SEARCH_ANCHOR_HEADER = /^\[([^\]]+)#[0-9A-Fa-f]{4,}\]\s*$/;

/** Paths of the `[path#TAG]` header lines in `text`. A line ends at `\n` alone, as in
 *  omp's output and in its patch parser. Matched over the whole text with the `m` flag,
 *  JavaScript also started a line after U+2028, U+2029 and a lone CR, so
 *  `12:…\u2028[victim.md#1A2B]` INSIDE a displayed line read as a header and marked an
 *  unread file as read (#152 item 5). */
function headerPaths(text) {
	const paths = [];
	for (const line of text.split("\n")) {
		const header = SEARCH_ANCHOR_HEADER.exec(line);
		if (header) paths.push(header[1]);
	}
	return paths;
}

export function searchTrackTargets(details, text, cwd) {
	const out = new Set();
	const files = details?.files;
	if (Array.isArray(files)) {
		for (const f of files) {
			if (typeof f === "string" && f && !isVirtualPath(f)) out.add(resolve(cwd, f));
		}
		return [...out];
	}
	if (typeof text !== "string" || !text) return [];
	for (const path of headerPaths(text)) {
		if (!isVirtualPath(path)) out.add(resolve(cwd, path));
	}
	return [...out];
}

/** Local paths named in an xd://ast_edit dispatch body (JSON args `paths`).
 *  Globs pass through unchanged — context-gate allows non-existent paths
 *  (same semantics as the pre-v17 top-level ast_edit input.paths). */
export function deviceArgPaths(input, cwd) {
	let args;
	try { args = JSON.parse(String(input?.content ?? "")); } catch { return []; }
	if (!args || !Array.isArray(args.paths)) return [];
	const out = [];
	for (const p of args.paths) {
		const t = localFileTarget(p, cwd);
		if (t) out.push(t);
	}
	return out;
}

/** `path` without a copied hashline wrapper. `write` accepts a copied header as its
 *  path (write.md: "A copied `[path#TAG]` wrapper is accepted and removed") and unwraps
 *  it BEFORE deciding what the target is — a wrapped device address still dispatches
 *  the device (`[xd://recall#1A2B]`, measured). This is a port of omp 18.22.0
 *  `unwrapHashlineHeaderPath` (packages/coding-agent/src/tools/hashline-header-path.ts):
 *  after trailing whitespace is dropped, the string must be `[PATH]` or `[PATH#XXXX]`
 *  with a 4-hex tag; a valid tag lets PATH contain `#`, and without one PATH must not.
 *  Anything else — a 5-hex tag, leading whitespace, a trailing selector — stays a
 *  literal file name (all measured). Unmirrored, `[src/foo.ts#1A2B]` resolved to a path
 *  that does not exist, so context-gate judged it a new file and let an unread
 *  `src/foo.ts` be overwritten, and the ledgers then recorded the wrapper instead of the
 *  file. `trimmed` is the caller's: what counts as trailing whitespace differs between
 *  JavaScript (`write`) and Rust (`edit`, see `editTarget`). */
const WRAPPER_TAG = /#[0-9A-Fa-f]{4}$/;
function unwrapHeader(path, trimmed = path.trimEnd()) {
	if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") return path;
	const inner = trimmed.slice(1, -1);
	const tag = WRAPPER_TAG.exec(inner);
	const unwrapped = tag ? inner.slice(0, tag.index) : inner;
	return unwrapped.length === 0 || (!tag && unwrapped.includes("#")) ? path : unwrapped;
}

/** Path a `write` call addresses, hashline wrapper removed — the string omp routes
 *  (URL or file, device dispatch). */
function writePath(input) {
	const path = input?.path ?? input?.file_path ?? input?.filePath;
	return typeof path === "string" ? unwrapHeader(path) : path;
}

/** What omp's TypeScript tools make of the head of a path before resolving it — a port
 *  of `expandPath` (v18.22.0 packages/coding-agent/src/tools/path-utils.ts), used here
 *  for `write` targets and for the URL test on a `read` input. A stray leading `:` before
 *  a path shape is dropped; so is a leading `@` mention marker before `/`, `~`, a Windows
 *  absolute path or a router URL; Unicode spaces become plain spaces; a `file://` URL
 *  becomes its path when `fileURLToPath` accepts it; a leading `~` is the home directory,
 *  the rest appended as text (`~//x` is `<home>//x`), and `~name` is `<home>/name`.
 *  Unmirrored, `write @/abs/file.md` was gated as `<cwd>/@/abs/file.md`, which does not
 *  exist, and the unread `/abs/file.md` was overwritten (measured, #152 item 2). `edit`
 *  has its own rules: `editTarget`.
 *  omp runs `fileURLToPath` on Bun, this module on Node. The two agreed on a 24-input
 *  probe (Bun 1.4.4, Node 24: hosts, bad escapes, `..`, line breaks, `?` / `#` tails)
 *  except for an escape that is not UTF-8, where Bun returns an empty path — omp then
 *  writes nothing — and Node throws.
 *  Not mirrored: the parts that act on native Windows only (extended-length `\\?\`
 *  prefixes, MSYS `/c/…` drive aliases). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function expandPath(path) {
	let p = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(path) ? path.slice(1) : path;
	if (p[0] === "@") {
		const rest = p.slice(1);
		if (rest[0] === "/" || rest === "~" || rest.startsWith("~/") || win32.isAbsolute(rest) || routedUrl(rest)) p = rest;
	}
	p = p.replace(UNICODE_SPACES, " ");
	if (/^file:\/\//i.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			// not a file URL with a local path: omp keeps the string as it stands
		}
	}
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
	return p[0] === "~" ? join(homedir(), p.slice(1)) : p;
}

/** Under WSL, `write` maps a Windows drive path to the drive's mount: `C:\Users\me\f.md`
 *  is `/mnt/c/Users/me/f.md` (`normalizeWindowsDriveAliasPath` -> `windowsPathToWslMount`,
 *  `isWsl`). pi-edit leaves this out on purpose, so `edit` keeps the literal name. */
function wslMount(p) {
	if (process.platform !== "linux" || !(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) return p;
	const drive = /^([A-Za-z]):[\\/](.*)$/.exec(win32.normalize(p.trim()));
	return drive ? posix.join("/mnt", drive[1].toLowerCase(), ...drive[2].split("\\").filter(Boolean)) : p;
}

const SQLITE_MAGIC = "SQLite format 3\0";
/** True when the regular file `path` starts with the SQLite header (omp `isSqliteFile`). */
function isSqlite(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(SQLITE_MAGIC.length);
		return readSync(fd, head, 0, head.length, 0) === head.length && head.toString("latin1") === SQLITE_MAGIC;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** File a `write` to `path` (wrapper already removed once) creates or replaces; null
 *  when it writes no local file this module can name. omp decides in this order
 *  (write.ts `execute`):
 *    1. a URL goes to its handler — a router URL, or `<file>:conflict://N`. The
 *       single-slash spelling of a registered scheme counts as well: the event plumbing
 *       shows a dispatched `xd://retain` as `xd:/retain` (observed 2026-07-16). omp
 *       itself refuses that spelling, but only on one line (its test is `^scheme:/.*$`),
 *       so a path with a line break in it is a file name;
 *    2. `archive.ext:member` rewrites the ARCHIVE — the longest prefix that exists and is
 *       not a directory, else the shortest, which omp creates;
 *    3. `db.sqlite:table[:key]` changes the DATABASE — the longest prefix that is an
 *       existing SQLite file — unless an existing prefix is some other kind of file,
 *       which makes the whole string a plain file name;
 *    4. anything else is a plain file.
 *  Every path it then opens — the plain file, each candidate — goes through
 *  `resolvePlanPath` (`file` below): a hashline wrapper comes off AGAIN, a router URL is
 *  located by its handler (a backing file this module cannot name: null), and anything
 *  else is expanded as a path. Nothing is refused at that point, so behind a second
 *  wrapper `file://`, `https://` and `xd:/x` are paths: `write [[file:///abs/x.md]]`
 *  overwrites `/abs/x.md` and `write [[src/foo.ts]]` overwrites `src/foo.ts` (both
 *  measured). Gated as the literal string, `arc.tar:member.json` named a file that does
 *  not exist, so an unread `arc.tar` was rewritten (measured, #152 item 1).
 *  The disk is consulted the way omp consults it. What omp refuses is judged as the file
 *  it WOULD have opened — a top-level `file:///abs/x` or `pkg://x`, a read-only archive
 *  format, a missing database, a special file, a `?query`: the gate then judges a file
 *  nothing is written to, never a file other than the one written. */
const EVENT_URL = new RegExp(`^(?:${INTERNAL_SCHEMES}):/.*$`, "i");
function writeTarget(path, cwd) {
	if (typeof path !== "string" || path.length === 0) return null;
	if (routedUrl(path) || EVENT_URL.test(path) || PREFIXED_CONFLICT_URL.test(path)) return null;
	const file = (p) => {
		const inner = unwrapHeader(p);
		if (routedUrl(inner)) return null;
		const expanded = wslMount(expandPath(inner));
		// `@local://x` is a URL once the `@` is off: omp throws, nothing is written
		return routedUrl(expanded) ? null : openedPath(expanded, cwd);
	};
	const prefixes = (pattern) =>
		[...path.matchAll(pattern)].map((match) => file(path.slice(0, match.index + match[0].length))).reverse();
	const archives = prefixes(ARCHIVE_MEMBER_PREFIX);
	if (archives.length > 0) {
		if (archives.includes(null)) return null;
		return archives.find((archive) => ["file", "special"].includes(entryKind(archive))) ?? archives.at(-1);
	}
	const databases = prefixes(SQLITE_ROW_PREFIX);
	if (databases.includes(null)) return null;
	let plainName = false;
	for (const database of databases) {
		const kind = entryKind(database);
		if (kind === "special" || (kind === "file" && isSqlite(database))) return database;
		if (kind === "file") plainName = true;
	}
	return databases.length > 0 && !plainName ? databases.at(-1) : file(path);
}

/** pi-edit `percent_decode` (path_policy.rs): `%XX` pairs become bytes and the result
 *  must be UTF-8; null where it fails. A pair is parsed by `u8::from_str_radix`, which
 *  takes a leading `+` — `%+1` is the byte 0x01, where `decodeURIComponent` throws. */
function percentDecode(value) {
	const bytes = Buffer.from(value);
	const out = [];
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0x25) {
			out.push(bytes[i]);
			continue;
		}
		const pair = bytes.toString("latin1", i + 1, i + 3);
		if (i + 2 >= bytes.length || !/^[+0-9A-Fa-f][0-9A-Fa-f]$/.test(pair)) return null;
		out.push(Number.parseInt(pair.replace("+", "0"), 16));
		i += 2;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(out));
	} catch {
		return null;
	}
}

/** File an `edit` of `path` changes; null for a URL target. `edit` paths are resolved by
 *  pi-edit (v18.22.0 crates/pi-edit/src/path_policy.rs `resolve`), not by the TypeScript
 *  helpers, for every path the model authored — a direct `path` in replace / patch mode
 *  as much as a hashline header. Step by step, as there:
 *    - `unwrap_hashline_header_path`: one copied `[path#TAG]` wrapper comes off. Trailing
 *      whitespace is Rust's (`trim_end`: U+0085 counts, U+FEFF does not).
 *    - `address`, on that string minus one leading `@`: a known scheme followed by `:/`
 *      is a URL or is refused; `file://` is a path. pi-edit has neither the path-prefixed
 *      `local://` rewrite nor the conflict-prefix one, so those two shapes are files here.
 *    - `expand_path`: a leading `:` goes before `/`, `\`, `~`, `./`, `../` or a drive
 *      (`X:`); a leading `@` before `/`, `\`, `~`, `~/` or a drive; Unicode spaces become
 *      plain; `file://` is percent-decoded when it decodes (`percentDecode`); a `\\?\`
 *      verbatim prefix with a plain spelling is dropped; `~` is the home directory and
 *      what follows `~/` is
 *      JOINED to it, so an absolute rest replaces it — `~//tmp/x` is `/tmp/x`, where
 *      `write` opens `<home>/tmp/x`.
 *    - `lexical_normalize`: `..` is folded as text, in an absolute path too, and a path
 *      of slashes only is the cwd. A path that expands to nothing names no file.
 *  Taken as the literal string, a direct path `[src/foo.ts#1A2B]` named a file that does
 *  not exist and an unread `src/foo.ts` was edited (#152 item 4). */
const RUST_TRAILING_WHITESPACE = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/;
function editTarget(path, cwd) {
	if (typeof path !== "string") return null;
	const display = unwrapHeader(path, path.replace(RUST_TRAILING_WHITESPACE, ""));
	const address = display[0] === "@" ? display.slice(1) : display;
	if (URI_SCHEME_PREFIX.test(address) && !/^file:\/\//i.test(address)) return null;
	let p = /^:(?:[/\\~]|\.\.?\/|[A-Za-z]:)/.test(display) ? display.slice(1) : display;
	if (/^@(?:[/\\]|~$|~\/|[A-Za-z]:)/.test(p)) p = p.slice(1);
	p = p.replace(UNICODE_SPACES, " ");
	if (/^file:\/\//i.test(p)) p = percentDecode(p.slice(7)) ?? p; // on failure pi-edit keeps the string, still a path
	p = p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
	if (p === "~") p = homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolve(homedir(), p.slice(2));
	else if (p[0] === "~") p = resolve(homedir(), p.slice(1));
	if (p.length === 0) return null;
	return /^\/+$/.test(p) ? cwd : resolve(cwd, p);
}

/** Absolute file targets a mutating tool call touches (plain file tools).
 *  Lives here (not index.ts) so the URI-scheme guard is test-fixed. The
 *  hashline-header fallback reuses SEARCH_ANCHOR_HEADER — same `[path#TAG]`
 *  grammar as search anchors. */
export function editTargets(toolName, input, cwd) {
	if (!input) return [];
	if (toolName === "write") {
		const t = writeTarget(writePath(input), cwd);
		return t ? [t] : [];
	}
	if (toolName === "edit") {
		const targets = new Set();
		const add = (path) => {
			const t = editTarget(path, cwd);
			if (t) targets.add(t);
		};
		// Direct path field (find/replace-style edit tools)...
		add(input.path ?? input.file_path ?? input.filePath);
		// ...native parsed-target list — OMP >=16.1.17 exposes every parsed hashline
		// target as input.paths (single-file calls also set input.path above)...
		if (Array.isArray(input.paths)) {
			for (const p of input.paths) add(p);
		}
		// ...and hashline patch headers `[path#TAG]` as a fallback for hosts that
		// don't expose parsed targets. Note an `MV DEST` op row names its
		// destination outside any header; only a host-provided input.paths that
		// carries the DEST tracks it — the header fallback sees the source file only.
		if (typeof input.input === "string") {
			for (const p of headerPaths(input.input)) add(p);
		}
		return [...targets];
	}
	return [];
}

/** tool_call-side pre-edit gate targets. v17 ast_edit rides `write` with a JSON
 *  body — its `paths` MUST still context-gate (read-before-edit): a bare URI
 *  guard would silently drop the pre-edit invariant for AST rewrites. The device
 *  detection normalizes the same path aliases editTargets honors (path /
 *  file_path / filePath), so an alias-shaped dispatch cannot slip past the gate
 *  (review 2026-07-16 M1 — defense-in-depth; shipped transport sends `path`), and
 *  it runs on the UNWRAPPED path: `[xd://ast_edit#1A2B]` dispatches the device too. */
/** ast_edit device address — tolerate the single-slash normalized form and
 *  scheme case variants (r3: exact `xd://ast_edit` match let `xd:/ast_edit`
 *  fall through to editTargets, whose URI guard DROPPED the path — silently
 *  skipping read-before-edit for the device's body paths). */
const AST_EDIT_DEVICE = /^xd:\/{1,2}ast_edit$/i;

export function mutationCallTargets(toolName, input, cwd) {
	const rawPath = writePath(input);
	if (toolName === "write" && typeof rawPath === "string" && AST_EDIT_DEVICE.test(rawPath.trim())) {
		return deviceArgPaths(input, cwd);
	}
	return editTargets(toolName, input, cwd);
}

/** tool_result-side ledger routing for mutating tools. The xdev envelope is
 *  checked BEFORE plain file targets — structurally fixing the ordering the
 *  v16 wiring got wrong under v17 (device writes fell into the generic file
 *  branch and tracked only the bogus device path). Kinds:
 *    read-anchors — xd grep/ast_grep dispatch: record files as read
 *    apply        — the REAL write (xd resolve-apply / ast_edit direct apply)
 *    preview      — staged ast_edit preview: backpressure-invalidate only
 *    device       — other xd devices: touch no local files
 *    files        — plain file write/edit targets */
export function mutationRoute(toolName, input, details, text, cwd) {
	if (toolName === "write") {
		const xdev = xdevEnvelope(details);
		if (xdev) {
			if (xdev.tool === "grep" || xdev.tool === "ast_grep") {
				return { kind: "read-anchors", files: searchTrackTargets(xdev.inner, text, cwd) };
			}
			if (xdev.tool === "ast_edit") {
				const inner = xdev.inner && typeof xdev.inner === "object" ? xdev.inner : null;
				return inner && inner.applied === true
					? { kind: "apply", files: astEditResultFiles(inner, cwd) }
					: { kind: "preview", files: deviceArgPaths(input, cwd) };
			}
			if (xdev.tool === "resolve") {
				const inner = xdev.inner && typeof xdev.inner === "object" ? xdev.inner : null;
				if (inner && inner.action === "apply" && inner.sourceToolName === "ast_edit") {
					return { kind: "apply", files: resolvedAstEditFiles(inner, cwd) };
				}
				return { kind: "device" };
			}
			return { kind: "device" };
		}
	}
	return { kind: "files", files: editTargets(toolName, input, cwd) };
}
