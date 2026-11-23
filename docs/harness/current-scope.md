# Current Scope: read-path-mutation-targets-152

**Created**: 2026-11-21
**Seed**: docs/harness/seed.yaml (task_id 20261121-235150-0dd2, v3)
**Issue**: #152

## MUST
- `gates/read-path.mjs`가 `write`·`edit` 대상을 omp 18.22.0이 실제로 여는 파일로 해석합니다: `write`의 컨테이너 대상(아카이브·SQLite), `expandPath`(`@`·`~`·선두 `:`·유니코드 공백)와 WSL 드라이브 매핑, `://`가 든 로컬 경로, `edit` 경로의 pi-edit 해석(`[path#TAG]` 언래핑, `expand_path`, `file://`), `\n` 단위 헤더 인식, 절대 경로의 `..`.
- 두 번 감싼 래퍼·`file://` URL의 `write`는 대상 파일을 추정하지 않고 `tool_call`에서 차단합니다(`mutationRefusal` + `index.ts`, 2026-11-23 사용자 결정 A).
- 항목 8건마다 재현 테스트와 처리 결과(수정 또는 근거가 붙은 잔존면)를 남깁니다.
- 통합 계약의 원장 정규화 문단과 `CHANGELOG.md` `[Unreleased]`를 결과에 맞게 고칩니다.

## MUST NOT
- 읽지 않은 파일을 읽은 것으로 기록하는 방향으로 넓히지 않습니다. 8번 삭제 경합은 `resolvedPath` 결과로 한정해 좁히되 줄이기 자체는 없애지 않습니다(없애면 멤버 읽기 뒤의 아카이브 쓰기가 막힙니다).
- #150(목록 읽기), 와이어 별칭 디바이스, `xd://ast_edit` 본문 경로, `harness-surface.md`, 버전 범프를 건드리지 않습니다. `write`의 두 번째 언래핑과 `file://` 해석(URL 파서 미러)은 두지 않습니다.
- 통합 계약·`audit.jsonl`·`CHANGELOG.md`에서 이 이슈 범위 밖의 줄을 고치지 않습니다.

## Acceptance Criteria
- [x] AC1 — 컨테이너 쓰기와 `@` 경로의 차단(`read-path.test.mjs` "#152-1: a write to an archive member targets the archive", "#152-1: a write to a SQLite row targets the database omp opens", "#152-2: write resolves a path the way omp expandPath does", "#152-2: under WSL a Windows drive path is the mounted file for write"; 종단: `read-ledger-wiring.test.mjs` "#152 AC1: a write into an unread archive, or through an @-path, is blocked until the file is read" — 읽기 전 `block: true`, 읽은 뒤 통과; "#152-1: an archive member write is recorded under the archive"; 중첩 세션 실측 차단)
- [x] AC2 — `://`가 든 로컬 경로(`read-path.test.mjs` "#152-3: `://` inside a local path does not make it virtual", "#152-3: a top-level write is a URL only where omp dispatches one"; 종단: "#152 AC2: a local path containing :// is gated as the file it names")
- [x] AC3 — 4번 수정("#152-2/4: edit targets lose a [path#TAG] wrapper and are expanded as pi-edit expands them", "#152-2: edit follows pi-edit where it differs from write", 종단 "#152-4"), 5번 수정("#152-5: only a line feed starts a [path#TAG] header line"), 6번은 #111에서 닫힘(`state-origin.test.mjs` "a path with a line break cannot write ledger lines of its own", 종단 "#152-6: a reported path containing a line break records nothing"), 7번 수정("#152-7: an absolute path keeps the kernel reading of `..` behind a symlink; edit folds it"), 8번은 좁히고 잔존면 기록("#152-8: a literal file read and then deleted is not taken for a member read — except a read that reports resolvedPath (residual)", 통합 계약 §1 Ledger path normalization의 kept residual 문장)
- [x] AC4 — `node --test .omp/extensions/harness/tests/*.test.mjs`(910 pass, RED 12건 → GREEN)와 `node scripts/docs-drift`(오류 0) 통과, `CHANGELOG.md` `[Unreleased]` #152 항목, 통합 계약 원장 정규화 문단 갱신
- [x] AC5 — 두 번 감싼 래퍼·`file://` `write`의 차단(`read-path.test.mjs` "#152-9: a doubly wrapped or file:// write path is refused, never resolved"; 종단: `read-ledger-wiring.test.mjs` "#152 AC5: a doubly wrapped or file:// write is blocked at tool_call, read or not" — 읽은 파일도 차단, 래퍼 한 겹·일반 경로·`edit`은 이전대로; 중첩 세션 실측 차단)
