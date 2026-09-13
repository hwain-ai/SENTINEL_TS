---
type: validation-reference
updated: 2026-09-13
status: in-progress
owner: Codex
---

# TypeScript 설치·실제 프로젝트 검증

2026-09-13에 통합 명령(`sentinel setup --language typescript` → `doctor` → 검사)으로 공개 프로젝트 unjs/scule v1.3.0을 검사하고, 같은 잠긴 Stryker로 직접 돌린 결과와 대조했다. 검사 결과는 품질 기준 미달인 종료 2/qualityFailed다. 아래 "공개 프로젝트 검사" 절이 현재 상태이고, 그 아래 절은 2026-09-10 당시 기록이다.

## 공개 프로젝트 검사(2026-09-13)

대상은 unjs/scule v1.3.0(commit 90d28593c8426d16beb5dadf3af8d341b6fee107)이다. 런타임 의존성이 없고 src 2개 파일(364줄), 테스트 `test/scule.test.ts`와 타입 테스트 `test/types.test-d.ts`, Vitest 설정 파일 없음, tsconfig.json 있음이 특징이다. 설정은 production `src/**/*.ts`, testRoots `test`, testPatterns `*.test.ts`, excluded `build.config.ts`·`test/*.test-d.ts`로 두었다. 프로젝트 파일은 바꾸지 않았다.

이 프로젝트를 돌리기 위해 검사기의 한계 네 가지를 풀었다. 모듈 설정 `excluded` 글롭(Python 검사기와 같은 키)이 없어 build.config.ts가 unclassifiedSource로 거부됐고, Vitest 설정 파일이 정확히 하나 있어야 해서 설정 없는 프로젝트와 vite.config.ts만 있는 프로젝트가 거부됐으며, Stryker가 샌드박스의 tsconfig.json을 고쳐 쓰려고 잠긴 트리에 없는 typescript 패키지를 불러 실패했다. 각각 회귀 시험을 추가했고 자체 시험 179개가 통과했다.

|항목|SENTINEL 검사(140초)|직접 Stryker 실행(35초)|
|---|---|---|
|변이 범위|81|81|
|killed|72|75|
|survived|7|5|
|uncovered(NoCoverage)|1|1|
|runtimeError|1|(Stryker는 별도 상태 없음)|
|kill 비율|72/81 = 88.89%, 기준 100% 미달|-|
|CRAP|호출 가능 15개, 기준 8 초과 1개(src/index.ts, CRAP 12)|측정 안 함|
|종료|2/qualityFailed|0|

직접 실행은 같은 잠긴 node_modules(Stryker 10.0.0, Vitest 4.1.11)를 링크한 사본에서 Stryker 기본 vitest 러너로 돌렸고, tsconfig 고쳐 쓰기는 검사기와 같은 방식으로 껐다. 변이 id 81개를 하나씩 대조한 결과, killed 3개 차이 중 1개는 판정 정의 차이(SENTINEL은 예외로 죽은 변이를 runtimeError로 분리)이고, 나머지 2개(id 0·79, 둘 다 src/index.ts 최상위 정규식 상수를 바꾸는 static 변이)는 SENTINEL이 survived로 둔 결함이다. 두 변이를 손으로 넣으면 테스트 63개 중 각각 18개·1개가 실패하므로 Stryker의 killed가 맞다. 원인은 Stryker 계획기가 테스트 필터가 있는 변이를 runtime(import 이후)에 켜는데, SENTINEL의 닫힌 설정이 `testFiles`를 명시해 모든 변이에 필터가 붙는 것이었다. SENTINEL 실행기가 reloadEnvironment 표시가 있는(static) 요청을 static 활성화로 바꿔 넘기도록 고쳤고(커밋 dcbcf3e), 재검사에서 killed 74·survived 5·uncovered 1·runtimeError 1로 변이 81개가 직접 Stryker 결과와 전부 일치한다.

먼저 시도한 unjs/pathe v2.0.3은 검사할 수 없었다. 소스(src/_path.ts)가 devDependency인 zeptomatch를 직접 import하는데, 검사기는 대상 테스트를 검사기의 잠긴 node_modules만으로 실행하기 때문이다. 프로젝트 의존성을 함께 링크하는 기능(Python의 `.sentinel-deps`에 해당)은 아직 없다. 이것이 TypeScript 검사기의 가장 큰 남은 한계다.

## 확인한 것

- 기존 읽기 전용 검증기로 Node 22.23.1 설치 전체·실행 파일·npm 파일을 잠금값과 대조했다. 종료값은 0이다.
- 의존성 전체·package-lock.json·TypeScript 컴파일러·SENTINEL 빌드 결과·Stryker 10.0.0과 Vitest 연결 패키지를 대조했다. 종료값은 0이고 선택된 시작 파일은 node_modules/@stryker-mutator/core/bin/stryker.js다.
- 이번 확인에서 다운로드, SDK 실행, 프로젝트 실행, 기존 파일 변경은 하지 않았다. 정확한 명령과 응답은 /tmp/sentinel-ts-preflight.E67sOfV4/existing-input-verification.json에 보존했다.

## 실제 연결에 남은 공백

|항목|현재 코드|필요한 검증|
|독립 설치|[패키지 목록](../package.json)은 dist만 포함한다. [실행 환경 검사](../src/mutation/runtime.ts)는 같은 설치 루트의 잠금 파일과 node_modules도 읽는다.|단순 패키지 압축만으로 완료라고 하지 않는다. 고정 실행 환경·의존성·빌드 결과를 분리된 설치 위치에서 함께 검증해야 한다.|
|실제 점수 수집|[check 명령](../src/cli.ts)은 --input으로 계산용 자료를 요구한다. 실제 변이 검사는 프로젝트에서 실행하지만 이 자료까지 자동 수집하지는 않는다.|프로젝트의 실제 실행 범위 보고서와 [기존 분석 함수](../src/coverage.ts)를 연결한다. 임의 점수나 시험용 자료로 대체하지 않는다.|
|통합 실행|[Stryker 실행부](../src/mutation/project-runner.ts)는 설치 루트의 실행 파일·의존성과 프로젝트 사본을 사용한다.|원본 저장소에 접근할 수 없는 컨테이너에서 빌드·전체 테스트·도구 비교·입력 보존·정리를 확인한 뒤 공통 명령에 연결한다.|

공통 SENTINEL의 실행·정리 기능은 재사용한다. 플러그인에 TypeScript 설치나 빌드 코드를 추가하지 않는다.

## 변경이력

- 2026-09-13 | static 변이 결함 수정 | 변경: 실행기가 reloadEnvironment 요청을 static 활성화로 위임하도록 고치고 재검사 결과로 갱신 | 검증: 변이 81개 상태가 직접 Stryker와 전부 일치, 자체 시험 180개 통과.
- 2026-09-13 | 공개 프로젝트 검사와 직접 Stryker 대조 | 변경: unjs/scule 검사 결과와 직접 실행 집계 표, 이를 위해 푼 검사기 한계 네 가지, pathe가 실패한 이유를 현재 상태로 기록. 변이 id 대조로 killed 차이 3개를 runtimeError 1개와 static 변이 미탐지 2개로 분리 | 검증: 변이 81개 범위 일치, static 변이 2개는 손으로 넣어 테스트 실패 확인, 검사 종료 2, 자체 시험 179개 통과. 프로젝트 의존성 링크와 static 변이 탐지는 미구현.

- 2026-09-10 | 기존 입력 재사용 사전 확인 | 변경: 독립 설치와 실제 점수 수집의 공백을 현재 소스 기준으로 구분 | 검증: 기존 Node 설치 및 Stryker 경로 검증 2개 명령 모두 종료 0. 실제 SDK·프로젝트 실행은 0회.
