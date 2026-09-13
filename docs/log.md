# 변경 기록

## 2026-09-13

- **Fix** sentinel-tool/setup.sh·toolchain.lock.json: 잠금의 dist 트리 지문이 파일 권한을 포함하는데 이전 지문은 과거 빌드의 664/775 권한을 담고 있어, 새 clone(CI)에서 launcher 의 umask 077 로 새로 만든 dist(600/700)와 맞지 않아 `compiled tree manifest mismatch` 로 준비가 실패했다. setup.sh 가 dist 를 지우고 새로 빌드하도록 하고, 그 정본 트리(600/700)의 지문으로 다시 잠갔다.
- **Creation** .github/workflows/ci.yml: push·PR 마다 `sentinel-tool/setup.sh` 로 잠긴 Node·패키지·dist 빌드를 준비하고 자체 시험 전체를 돌리는 GitHub Actions 워크플로. `.toolchain` 은 잠금 파일 지문으로 캐시한다.
- **Fix** mutation/stryker-proof-runner.ts: 모듈 최상위 코드의 변이(Stryker 의 static 변이)를 실행기가 잡지 못하던 결함을 고쳤다. 닫힌 Stryker 설정이 `testFiles` 를 명시하면 Stryker 계획기는 모든 변이에 테스트 필터를 붙이고, 필터가 있으면 `mutantActivation` 을 `runtime` 으로 정하므로 static 변이가 import 이후(beforeAll)에야 활성화돼 항상 살아남았다. Stryker 는 static 변이에만 `reloadEnvironment` 를 켜므로, 실행기가 그 요청의 활성화를 `static`(import 전)으로 바꿔 위임한다. unjs/scule 재검사에서 변이 81개가 직접 Stryker 결과와 전부 일치(killed 74·survived 5·uncovered 1·runtimeError 1). 회귀 시험 1개, dist 지문 재잠금, 자체 시험 180개 통과.
- **Update** project.ts·crap-runner.ts·mutation/stryker-adapter.ts·mutation/project-runner.ts: 공개 프로젝트(unjs/scule)를 검사하면서 드러난 세 가지 한계를 풀었다. 모듈 설정에 `excluded` 글롭(선택)을 추가해 build.config.ts 같은 파일을 생산도 테스트도 아닌 범주로 선언한다(Python 검사기와 같은 키). Vitest 설정은 vitest.config.* 가 없으면 vite.config.* 를 받고, 둘 다 없으면 Vitest 기본값으로 실행한다(이전에는 정확히 하나가 없으면 거부). Stryker 의 tsconfig 고쳐 쓰기는 잠긴 트리에 없는 typescript 패키지를 부르므로 존재하지 않는 파일을 가리켜 끄고, 스냅샷의 tsconfig 는 원본 그대로 샌드박스에 들어간다. 회귀 시험 3개(제외 글롭·vite.config·설정 없음)와 변이 픽스처의 tsconfig.json 추가, dist 지문 재잠금.
- **Update** cli.ts·project.ts: `--changed-file`(반복)로 생산 파일을 변경분으로 좁힌다. 변경분에 생산 파일이 없으면 검사 없이 통과로 응답하고 증거를 남기지 않는다. 어댑터가 통합 요청의 changedFiles를 이 인자로 전달한다. dist 지문 재잠금, 자체 시험 176개 통과.
- **Creation** gate.ts·crap-runner.ts·sentinel-tool/: CRAP 상한(`--crap-max`, 기본 8)과 변이 최소 kill 비율(`--mutation-min`, 기본 100)을 명령에서 받아 판정에 쓰고, `check --project`가 사본에서 잠긴 Vitest로 coverage를 만들어 CRAP을 직접 계산한다. 통합 SENTINEL의 도구 요청을 받는 어댑터와 첫 실행 준비 스크립트를 추가했다. 기준값 문자열 계약은 SENTINEL_SPEC threshold-v1.json과 같다.
- **Update** evidence/contract.ts·cli.ts: crap 구성요소에 crapMax, mutation 구성요소에 mutationMin을 기록하고 의미 검사도 그 값으로 재계산한다. 이 항목이 없는 이전 증거 파일은 유효하지 않다. CRAP 초과 진단 코드는 crapAbove8에서 crapAboveLimit로 바꿨다.
- **Update** toolchain.lock.json: 다시 빌드한 dist의 항목·트리 지문으로 첫 번째 도구 잠금을 갱신했다. 사본의 node_modules는 통째로 링크하지 않고 항목별로 링크해 Vitest 캐시가 검사기의 잠긴 의존성 트리에 쓰이지 않게 했다.
- 검증: 자체 시험 173개 통과(공유 잠금 시험의 작업자 시작 대기만 2초에서 10초로 늘림).

## 2026-09-07

- **Creation** stryker-runtime.md: doctor의 고정 성공 응답을 실제 설치 확인으로 교체한 이유와 읽기 전용 진단·실행 전 검증 경계 기록.

## 2026-09-03

- **Update** typescript-analysis.md: callback의 바깥 binding과 JSX element 경로를 위치 독립 semantic identity에 포함.
- **Update** typescript-analysis.md: analyzer가 exact TypeScript 6.0.3 alias를 직접 읽어 consumer dependency hoisting의 영향을 받지 않도록 경계를 수정.
- **Update** README.md: runtime AST dependency 설명을 실제 direct alias 구조와 일치시킴.
- **Update** typescript-analysis.md: callable identity, Istanbul function mapping, source digest와 exact 위험도 정렬 계약을 반영.
- **Creation** typescript-analysis.md: native CRAP core와 TypeScript 7·6 역할 분리 기록.
- **Update** README.md: 현재 구현 범위와 재현 가능한 검증 명령 추가.
- **Creation** SENTINEL_TS 문서 번들: OKF v0.2 init 골격 생성.
