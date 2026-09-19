# SENTINEL_TS

TypeScript·TSX 함수의 복잡도와 Vitest 실행 범위로 CRAP을 계산하고, Stryker로 테스트의 오류 탐지율을 측정합니다. `sentinel-tool/`의 어댑터가 통합 SENTINEL 요청을 받아 결과 JSON을 반환합니다.

## 검사 실행

[SENTINEL 설치 안내](https://github.com/hwain-ai/SENTINEL)를 따라 통합 명령을 준비한 뒤 검사할 프로젝트에서 실행합니다.

```sh
# TypeScript 검사 도구와 프로젝트 설정 준비
sentinel setup --language typescript
# 기능 파일의 특정 함수를 지정한 테스트로 검사
sentinel check --file src/pricing.ts --function calculateDiscount --tests test/pricing.test.ts
# 프로젝트 설정의 기능 코드와 테스트 전체 검사
sentinel check --all
```

`--file`은 점수를 측정할 기능 파일, `--function`은 괄호 없는 함수 이름입니다. 함수를 생략하면 파일 전체를 측정합니다. `--tests`는 실행할 테스트 파일이며 여러 파일은 옵션을 반복합니다. 생략하면 설정된 테스트를 사용합니다. `--changed`는 Git 변경분의 기능 코드만 선택합니다. 테스트만 수정했으면 기능 파일을 직접 지정해 다시 검사합니다.

기본 검사에는 자동 실행 시간 제한이 없습니다. Ctrl+C로 중단합니다. 통합 명령에서 `exitCode`는 명령 종료 코드, `selection`은 검사 범위, `results[].status`는 품질 판정입니다. 내부 CRAP·mutation의 `pass`는 각 기준 충족 여부입니다. [JSON 조각별 결과 해석](https://github.com/hwain-ai/SENTINEL/blob/main/docs/results.md)을 참고하세요.

## 프로젝트 설정과 제한

설정의 `production`, `testRoots`·`testPatterns`, `excluded`로 기능 코드·테스트·제외 파일을 구분합니다. Vitest 설정이 없으면 기본값을 사용하며 `vite.config.*`도 지원합니다.

프로젝트 테스트는 검사기의 잠긴 `node_modules`로 실행합니다. 프로젝트에 필요한 다른 런타임 의존성을 자동으로 설치하거나 연결하지 않습니다. Coverage의 파일·위치·소스 지문이 함수와 맞지 않으면 오류 또는 미측정으로 표시합니다.

CRAP 기본 상한은 8, mutation 최소 탐지율은 90%입니다. 테스트의 기대값 검사 실패를 증명한 변이만 `killed`로 셉니다. Stryker의 원래 상태와 SENTINEL의 판정이 다를 수 있습니다.

Linux와 macOS의 x86_64·arm64를 지원하며 Windows는 WSL2에서 사용합니다.

## 검사기 개발과 검증

`toolchain.lock.json`과 `package-lock.json`이 사용할 Node·패키지·빌드 결과를 고정합니다. 설치기는 파일 지문을 확인하고 실행기는 잠금과 다른 파일을 거부합니다.

```sh
# 고정 Node·의존성·빌드 준비
sentinel-tool/setup.sh
# 검사기 빌드
scripts/node.sh --tool tsc -- -p tsconfig.json
# 검사기 자체 시험
scripts/node.sh --test test/*.test.mjs
```

빌드용 TypeScript와 소스 분석용 AST API의 역할은 [분석 구조](docs/typescript-analysis.md), 설치 진단과 오류 코드는 [Stryker 진단](docs/stryker-runtime.md)에 있습니다. 전체 목록은 [문서 목록](docs/index.md)을 참고합니다.

통합 실행기에 연결하는 어댑터 버전은 `0.1.3`이다. [sentinel-tool/version](sentinel-tool/version)과 설치한 실행기의 승인 목록을 함께 확인한다. 기존 설치의 갱신은 [통합 실행기 갱신 안내](https://github.com/hwain-ai/SENTINEL#승인된-도구-버전-갱신)를 따른다.
