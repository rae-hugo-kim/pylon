# Current Scope: read-path-mutation-targets-152

**Created**: 2026-11-21
**Seed**: docs/harness/seed.yaml (task_id 20261121-235150-0dd2, v1)
**Issue**: #152

## MUST
- `gates/read-path.mjs`가 `write`·`edit` 대상을 omp 18.22.0이 실제로 여는 파일로 해석합니다: `write`의 컨테이너 대상(아카이브·SQLite), `expandPath`(`@`·`~`·선두 `:`·유니코드 공백·`file://`)와 WSL 드라이브 매핑, `://`가 든 로컬 경로, `edit` 경로의 `[path#TAG]` 언래핑, `\n` 단위 헤더 인식, 절대 경로의 `..`.
- 항목 8건마다 재현 테스트와 처리 결과(수정 또는 근거가 붙은 잔존면)를 남깁니다.
- 통합 계약의 원장 정규화 문단과 `CHANGELOG.md` `[Unreleased]`를 결과에 맞게 고칩니다.

## MUST NOT
- 읽지 않은 파일을 읽은 것으로 기록하는 방향으로 넓히지 않습니다. 8번 삭제 경합은 닫지 않고 잔존면으로 둡니다(닫으면 멤버 읽기 뒤의 아카이브 쓰기가 막힙니다).
- #150(목록 읽기), 와이어 별칭 디바이스, `xd://ast_edit` 본문 경로, `harness-surface.md`, 버전 범프를 건드리지 않습니다.
- 통합 계약·`audit.jsonl`·`CHANGELOG.md`에서 이 이슈 범위 밖의 줄을 고치지 않습니다.

## Acceptance Criteria
- [x] AC1 — 컨테이너 쓰기와 `@` 경로의 차단(`read-path.test.mjs` "#152-1: a write to an archive member targets the archive", "#152-1: a write to a SQLite row targets the database omp opens", "#152-2: write resolves a path the way omp expandPath does", "#152-2: under WSL a Windows drive path is the mounted file for write"; 종단: `read-ledger-wiring.test.mjs` "#152 AC1: a write into an unread archive, or through an @-path, is blocked until the file is read" — 읽기 전 `block: true`, 읽은 뒤 통과; "#152-1: an archive member write is recorded under the archive"; 중첩 세션 실측 3건 차단)
- [x] AC2 — `://`가 든 로컬 경로(`read-path.test.mjs` "#152-3: `://` inside a local path does not make it virtual"; 종단: "#152 AC2: a local path containing :// is gated as the file it names")
- [x] AC3 — 4번 수정("#152-2/4: edit targets lose a [path#TAG] wrapper and take the same expansion", 종단 "#152-4"), 5번 수정("#152-5: only a line feed starts a [path#TAG] header line"), 6번은 #111에서 닫힘(`state-origin.test.mjs` "a path with a line break cannot write ledger lines of its own", 종단 "#152-6: a reported path containing a line break records nothing"), 7번 수정("#152-7: an absolute path keeps the kernel reading of `..` behind a symlink; edit folds it"), 8번 잔존면("#152-8 (residual)", 통합 계약 §1 Ledger path normalization의 kept residual 문장)
- [x] AC4 — `node --test .omp/extensions/harness/tests/*.test.mjs`(906 pass, RED 12건 → GREEN)와 `node scripts/docs-drift`(OK) 통과, `CHANGELOG.md` `[Unreleased]` #152 항목, 통합 계약 원장 정규화 문단 갱신
