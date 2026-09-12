---
type: Architecture Note
status: stable
generated: { by: process:codex, at: 2026-09-07T12:50:00Z }
sources:
  - resource: ../src/mutation/runtime.ts
    title: 설치 진단 구현
  - resource: ../test/runtime.test.mjs
    title: 설치 진단 회귀 테스트
---

# Stryker 설치 진단

doctor는 기대 버전을 출력하는 명령이 아니라, 실제 설치가 사용 가능한지 읽기 전용으로 확인하는 명령이다.

## 해결한 문제

기존 구현은 Stryker가 없어도 준비 완료를 뜻하는 ready와 고정 버전을 출력했다. 별도 임시 설치에서 Stryker만 제외한 CLI를 실행해 종료 코드 0을 확인했다. 회귀 테스트의 기대값은 설치 불가를 뜻하는 unavailable과 종료 코드 5다.

## 실제 처리 순서

1. toolchain.lock.json에서 승인 상태와 기대 버전을 읽는다. 저장소·Node·Stryker가 locked 상태여야 한다.
2. 실행 중인 Node 버전, 해당 Node 배포의 npm package.json, 저장소의 Stryker core·Vitest runner package.json을 읽는다.
3. 설치된 이름과 버전을 비교하고 Stryker CLI 파일의 SHA-256을 잠금 파일과 비교한다. SHA-256은 파일 내용이 바뀌었는지 확인하는 지문이다.
4. 정상이면 ready와 종료 코드 0, 누락·불일치면 unavailable과 종료 코드 5를 반환한다. 설치가 없거나 메타데이터를 읽지 못한 패키지는 버전을 null로 표시한다. 다른 버전이 설치됐다면 기대 버전 대신 실제 버전을 표시한다.
5. 실제 project mutation 실행도 같은 확인을 거친 뒤에만 소스 복사본을 만든다.

| 진단 코드 | 뜻 |
|---|---|
| runtimeLockInvalid | 잠금 파일이 없거나 승인 상태·정확한 버전·도구 식별자가 유효하지 않음 |
| dependencyMissing | 필요한 파일이 없음 |
| dependencyManifestInvalid | 설치 정보를 해석할 수 없거나 대상이 일반 파일이 아님 |
| dependencyIdentityMismatch | 설치된 패키지 이름이 다름 |
| dependencyVersionMismatch | 실행 환경이나 설치 버전이 잠금과 다름 |
| dependencyArtifactMismatch | Stryker CLI 파일 내용이 잠금과 다름 |

진단을 위해 npm·Stryker·프로젝트 설정을 실행하거나 대상 프로젝트에 파일을 만들지 않는다. 기존 출력 필드는 유지하고 diagnostics 목록을 추가했다.

## 경계와 유지보수

- 기대 버전은 이 모듈에 중복 작성하지 않고 toolchain.lock.json에서 읽는다.
- 이 확인은 설치 사용 가능성을 위한 것이다. 전체 dependency tree·Node binary의 무결성 검증은 scripts/node.sh와 scripts/toolchain_lock.py가 계속 맡는다. 이 doctor를 독립적인 보안 인증으로 취급하지 않는다.
- 현재 저장소 내부 node_modules와 승인 Node 배포 구조를 대상으로 한다. 임의의 전역 설치, pnpm 구조, npm 공개 배포 지원을 추가한 것은 아니다.
- 새 backend 자동 다운로드, 사용자 프로젝트 설정 실행, 기존 backend 자동 교체는 하지 않는다.
- 빌드 결과가 바뀌면 firstPartyTools의 CLI·dist 지문을 다시 계산한다. 외부 Stryker 버전과 dependency 잠금은 이번 변경에서 바꾸지 않았다.

## 확인 방법과 근거

SENTINEL_TS 폴더에서 scripts/node.sh --entry sentinel-ts -- doctor를 실행하면 설치 진단 JSON을 읽을 수 있다. scripts/node.sh는 승인 Node로 실행하는 저장소 명령이고, --entry sentinel-ts는 검증된 CLI를 선택하며, doctor는 진단 기능이다.

- [runtime 회귀 테스트](../test/runtime.test.mjs): 실제 파일을 생성해 정상·누락·다른 버전·다른 이름·변경된 CLI·잘못된 잠금을 검사한다.
- [CLI 설치 회귀 테스트](../test/doctor.test.mjs): Stryker 없는 별도 설치에서 종료 코드 5와 프로젝트 무변경을 확인한다.
- [실제 mutation 테스트](../test/project-mutation.test.mjs): 고정 Stryker 실행과 typed assertion 증거가 기존처럼 동작하는지 확인한다.

검증 명령은 scripts/node.sh --test test/*.test.mjs이며, --test는 테스트 실행, test/*.test.mjs는 해당 이름의 전체 테스트 파일이다. scripts/self-crap.sh는 실제 테스트 실행률과 코드 복잡도를 함께 점검한다.

2026-09-07 검증 결과: TypeScript 빌드 성공, 전체 Node 테스트 168개 통과·실패 0개, 자체 품질 검사의 Vitest 테스트 145개 통과. 분석한 함수·메서드 596개에서 CRAP 기준 초과와 계산 불가는 모두 0개이고 최대값은 허용 상한인 8이었다. 정상 설치의 doctor는 실제 버전과 빈 diagnostics를 반환했다. 전체 배포 승인이나 다른 언어의 backend 교체를 검증한 결과는 아니다.
