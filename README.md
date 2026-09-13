# SENTINEL_TS

## 역할

SENTINEL_TS의 단일 책임은 TypeScript 프로젝트의 CRAP 계산과 mutation 결과를 하나의 품질 게이트로 판정하는 것입니다.

원격 저장소는 github.com/hwain-ai/SENTINEL_TS 입니다.

TypeScript·TSX source를 AST로 분석해 함수, method, getter, setter, constructor, 함수 표현식,
arrow function과 TSX callback을 각각 찾습니다. `check --project`는 검사 대상의 사본에서 잠긴
Vitest로 coverage를 새로 만들고, Istanbul `coverage-final.json`의 function·statement range를 같은
module과 source digest의 callable에만 연결해 CRAP을 exact 분수로 계산한 뒤, 같은 사본에서 Stryker
변이 검사를 돌려 두 결과를 하나의 증거로 기록합니다. `--input`으로 미리 계산한 CRAP 행을 넘기는
방식도 그대로 지원합니다.

변경분만 검사하려면 `--changed-file 경로`(프로젝트 기준 상대 경로, 반복 가능)를 `--project` 실행에 넘깁니다.
생산 파일에 해당하는 경로만 CRAP 측정과 Stryker 변이 대상으로 남기고, 나머지 소스는 컴파일용 지원 파일로
사본에 함께 둡니다. 넘긴 경로 중 생산 파일이 없으면 판정할 대상이 없으므로 검사 없이 통과(종료 0,
`changedScope: empty`)로 응답하고 증거를 남기지 않습니다. `--input`과는 함께 쓸 수 없습니다.

기준값은 `crap`, `mutation`, `check`의 `--crap-max`(CRAP 상한, 기본 8)와 `--mutation-min`(변이 최소
kill 비율 %, 기본 100)으로 넘깁니다. 정수 또는 소수점 두 자리까지의 문자열이며 정확한 분수로 비교하고,
증거 파일의 crap·mutation 구성요소에 판정에 쓴 crapMax·mutationMin을 함께 기록합니다.

통합 SENTINEL 연결은 `sentinel-tool/` 폴더가 맡습니다. 어댑터가 도구 요청(표준입력 JSON)을 받아
`check --project`를 실행하고 응답 JSON 하나만 표준출력에 쓰며, `sentinel setup --language typescript`가
`sentinel-tool/setup.sh`로 Node·의존성·빌드를 준비한 뒤 이 어댑터를 묶음으로 설치합니다. 검사 대상
프로젝트의 테스트는 이 검사기의 잠긴 node_modules(Vitest 4.1.11)로 실행되므로, 대상 프로젝트가 다른
런타임 의존성을 쓰면 아직 검사할 수 없습니다.

## 지원 플랫폼과 준비

Linux(x86_64, arm64)와 macOS(Intel, Apple Silicon)를 지원합니다. Windows 는 WSL2 안에서 씁니다.
`scripts/toolchain.py`(표준 라이브러리만 쓰는 Python 실행기)가 플랫폼을 감지해 `toolchain.lock.json`의
해당 항목(공식 주소·크기·SHA-256·실행 파일·설치 트리 지문)으로 Node 22.23.1 을 받고, `npm ci`로
package-lock.json 의 의존성을 설치한 뒤 설치된 node_modules 트리 지문과 TypeScript 네이티브 실행 파일
지문을 플랫폼별 잠금값과 대조합니다. `scripts/node.sh`·`scripts/npm.sh`·`scripts/bootstrap-node.sh`·
`sentinel-tool/setup.sh`는 이 실행기로 넘기는 얇은 wrapper 입니다. 자식 프로세스는 상속 없는 최소
환경(HOME·캐시는 `.toolchain` 아래, PATH 는 고정 Node 만)에서 돕니다.

## 현재 확인 방법

1. `sentinel-tool/setup.sh`(또는 `python3 -I -B scripts/toolchain.py setup`)로 Node·의존성·빌드를 준비합니다.
2. `scripts/node.sh --tool tsc -- -p tsconfig.json`(`npm run build`와 같음)으로 TypeScript 7 compiler를 실행합니다.
3. `scripts/node.sh --test test/*.test.mjs`(`npm test`와 같음)로 Node 기본 test runner의 회귀 test를 실행합니다.

TypeScript 7.0에는 안정된 compiler API가 없으므로 build에는 TypeScript 7.0.2를,
AST 분석에는 npm alias로 exact 고정한 TypeScript 6.0.3 API를 직접 사용합니다. 자세한 이유는
[TypeScript 분석 구조](docs/typescript-analysis.md)에 있습니다.

## 설계 근거

원본 작업공간 설계 문서: [2026-08-native-quality-tools.md](https://github.com/hwain-ai/SENTINEL/blob/main/docs/design-docs/2026-08-native-quality-tools.md) (SENTINEL 저장소)
