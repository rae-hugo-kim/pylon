# Current Scope: cross-repo-time-cd-149

**Created**: 2026-11-24
**Seed**: docs/harness/seed.yaml (task_id 20261121-144622-149a, v2)
**Issue**: #149

## MUST
- `time` 뒤의 `cd`·`pushd`·`popd`·`eval`·`source` 다음에 오는 커밋·푸시를 판정 불가(fail-closed)로 처리합니다(`timedProgram`, `scanWriteTargets`의 `doubt`).
- `CDPATH`가 설정된 상태의 상대 `cd` 다음에 오는 커밋·푸시를 판정 불가로 처리합니다(`cdpathSearches`).
- 이슈 표의 거짓 차단 두 형태는 그대로 두고 테스트로 고정합니다.
- 판정은 bash 실측으로 정하고 통합 계약(20·44·45·116행)에 적습니다. 역방향 우회는 실측과 함께 잔존면에 적습니다.

## MUST NOT
- 가드가 추적하는 cwd와 ① 레일의 귀속 규칙을 바꾸지 않습니다(사용자 결정 B — v1의 후보 모델을 넣지 않습니다).
- 이전에 차단되던 형태를 통과시키지 않습니다.
- 계약 문서·CHANGELOG·audit에서 이 이슈 밖의 줄을 고치지 않고, 아직 없는 후속 이슈 번호를 적지 않습니다.

## Acceptance Criteria
- [x] AC1 — `time cd <다른 하네스 리포> && git commit -m x` BLOCK(`cross-repo.test.mjs` "② `time cd <other repo> && git commit` fails closed: the `time` keyword leaves the cd in the current shell (#149 AC1)" — `time -p`·`time --`·`time time`·`time command cd`·`! time cd`·`time { cd …; }`·`time pushd`·`time eval` 포함; main의 gates로 돌리면 RED: "must fail closed: time cd …/external && git commit -m x")
- [x] AC2 — 이슈 표 6형태 판정 고정(`cross-repo.test.mjs` "② the six spellings of the #149 table (AC2): the two false blocks stay blocked" — BLOCK 5 + 허용 1). 거짓 차단 두 형태는 그대로 둡니다: 가드는 따라간 `cd`를 실행된 것으로 보며, 이 가정을 풀면 방향이 뒤집힌 같은 형태(bash `cwd`=다른 리포, `cd <세션 리포> | cat; git commit`)의 우회와 함께 다뤄야 하므로 후속 이슈로 넘겼습니다(사용자 결정 B, 계약 45행에 실측 기록)
- [x] AC3 — `CDPATH` 실측(`CDPATH=<부모>`에서 `cd other && git commit`이 `<부모>/other`에 커밋, main은 허용)과 판정(fail-closed; `./`·`../`·절대 경로는 계속 추적)이 `harness-harness_integration_contract.md` 45행에 기록되고 `cross-repo.test.mjs` "② a relative `cd` under CDPATH is not trusted: the commit fails closed (#149 AC3)"로 고정
- [x] AC4 — `node --test .omp/extensions/harness/tests/*.test.mjs` 전 항목 통과(2026-11-24), `node scripts/docs-drift` 0 errors
