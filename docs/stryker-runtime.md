# Stryker 실행과 설치 진단

통합 `check`에서 CRAP과 mutation은 기본 병렬 실행이며, `--execution-mode sequential`로 순차 실행을 선택합니다. 각 측정 프로세스는 별도 프로세스 그룹을 사용합니다. 실행 오류나 취소 시 다른 측정의 테스트 작업도 중단하고 종료를 확인한 뒤 사본을 정리합니다. 점수 기준 미달은 실행 오류와 구분하여 두 결과를 모두 보고합니다.

Mutation 사본은 프로젝트 모듈의 설치된 패키지와 검사기의 고정된 측정 도구를 링크로 연결합니다. 사본의 `node_modules` 폴더와 캐시 폴더를 따로 만들며, Stryker 내부 변이 작업 수는 기존 `concurrency: 1`을 유지합니다. CRAP과 mutation의 병렬 실행과 Stryker 내부의 변이 병렬 수는 별개입니다.

SENTINEL_TS는 잠긴 Stryker·Vitest로 프로젝트 사본을 검사합니다. `version`는 설치 파일을 읽어 사용할 수 있는지 확인하고, mutation 실행도 이 확인을 통과한 뒤 시작합니다.

## 설치 진단

저장소 루트에서 실행합니다.

```sh
# 저장소 실행기로 잠긴 CLI의 설치 진단 호출
scripts/node.sh --entry sentinel-ts -- version
```

검사기는 `toolchain.lock.json`의 기대 버전과 실제 Node·npm·Stryker core·Vitest runner 버전을 비교합니다. Stryker CLI 파일의 SHA-256도 대조합니다. 정상이면 `ready`와 종료 0, 누락·불일치면 `unavailable`과 종료 5를 반환합니다. 읽을 수 없는 버전은 `null`이며 실제로 다른 버전이 설치되어 있으면 그 값을 표시합니다.

| 진단 코드 | 뜻 |
|---|---|
| `runtimeLockInvalid` | 잠금 파일의 승인 상태·버전·도구 식별자가 유효하지 않음 |
| `dependencyMissing` | 필요한 파일이 없음 |
| `dependencyManifestInvalid` | 설치 정보를 읽을 수 없거나 일반 파일이 아님 |
| `dependencyIdentityMismatch` | 설치된 패키지 이름이 다름 |
| `dependencyVersionMismatch` | 실제 버전이 잠금과 다름 |
| `dependencyArtifactMismatch` | Stryker CLI 파일 지문이 잠금과 다름 |

진단은 프로젝트 설정·npm·Stryker를 실행하지 않습니다. Node와 의존성 전체 트리의 무결성은 저장소 실행기와 잠금 검증기가 별도로 확인합니다. 현재 잠긴 저장소 설치 구조를 사용하며 임의의 전역 설치나 pnpm 구조를 탐색하지 않습니다.

## 파일·함수·테스트 선택

통합 `sentinel check --file ... --function ... --tests ...` 요청은 어댑터가 native 검사기에 전달합니다. 함수 선택은 소스 분석으로 확인한 callable의 범위를 사용합니다. 이름이 없거나 모호한 함수는 오류이며, 함수 이름에 `()`를 붙이지 않습니다.

Coverage는 전체 보고서와 소스 함수의 대응 관계를 먼저 확인한 뒤 선택한 함수만 CRAP 판정에 포함합니다. Mutation 실행기는 선택 파일과 함수의 위치 범위를 Stryker에 전달합니다. 보고서의 파일 목록은 Stryker 범위 표기에서 경로를 분리해 원래 기능 코드 목록과 대조하며, 설정의 실제 중복 파일은 오류입니다.

`--tests`는 Vitest가 실행할 테스트 파일을 제한합니다. 생략하면 프로젝트 설정에서 찾은 테스트를 사용합니다. 측정할 코드 범위와 테스트 범위는 결과의 `scope`에 따로 기록합니다.

## 시간 제한과 변이 판정

기본 검사에는 자동 실행 시간 제한이 없습니다. `stryker-unlimited.ts`가 Stryker의 실행 API를 호출하고 변이 실행의 시간 제한 처리를 해제합니다. Vitest의 테스트·hook 시간 제한도 0으로 설정합니다. 취소와 자식 프로세스 정리는 통합 실행기가 처리합니다. 설치된 외부 패키지 파일을 수정하는 방식은 아닙니다.

Stryker가 `killed`로 표시한 결과를 그대로 탐지 성공으로 세지 않습니다. 실행기가 정상 코드 대조와 변이 재실행의 테스트 목록·기대값 검사 실패를 확인합니다. 실행 오류는 `runtimeError`, 테스트가 변이 위치를 실행하지 않았으면 `uncovered`로 기록합니다. 모듈을 불러올 때 적용되는 변이는 환경을 다시 불러오기 전에 활성화합니다.

`inScope`는 선택 범위의 변이 개수이고 `killed`는 테스트가 오류를 탐지한 개수입니다. 점수는 `killed / inScope × 100`입니다. `survived`, `uncovered`, 실행 오류 등도 분모에 남으며 탐지 성공으로 세지 않습니다. 변이가 0개면 점수를 100%로 만들지 않습니다. 세부 함수·파일 점수와 전체 명령 판정의 차이는 [결과 해석](https://github.com/hwain-ai/SENTINEL/blob/main/docs/results.md)에 있습니다.

## 관련 코드와 검증

- [runtime.ts](../src/mutation/runtime.ts): 설치 파일과 잠금 비교
- [project-runner.ts](../src/mutation/project-runner.ts): 선택 범위, 실행과 결과 연결
- [stryker-unlimited.ts](../src/mutation/stryker-unlimited.ts): 시간 제한 없는 Stryker 실행
- [stryker-proof-runner.ts](../src/mutation/stryker-proof-runner.ts): 테스트 재실행과 탐지 증거
- [설치 진단 시험](../test/runtime.test.mjs), [실제 변이 시험](../test/project-mutation.test.mjs), [범위 선택 시험](../test/selection.test.mjs)

`scripts/node.sh --test test/*.test.mjs`로 검사기 시험을 실행합니다. 빌드 결과가 바뀌면 `toolchain.lock.json`의 firstPartyTools 지문도 실제 빌드와 맞춰야 합니다.
