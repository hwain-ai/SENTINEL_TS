---
okf_version: "0.2"
---

# SENTINEL_TS 문서

SENTINEL_TS의 사용법과 변경 이유를 찾는 문서 시작점입니다.

## 구현 상태

CRAP·Stryker 변이·증거 기록에 더해, `check --project`가 사본에서 coverage를 직접 만들어 CRAP을 계산합니다. CRAP 상한과 변이 최소 kill 비율은 명령 인자로 받고, 통합 SENTINEL이 부르는 어댑터(`sentinel-tool/`)를 갖췄습니다. [사용법](../README.md)에서 명령과 한계를 확인합니다.

## 구조

* [TypeScript 분석 구조](typescript-analysis.md) - TypeScript 7 compiler와 TypeScript 6 AST API를 나눈 이유와 현재 분석 경계
* [Stryker 설치 진단](stryker-runtime.md) - 실제 설치 버전·CLI 지문 확인, 실행 전 차단과 진단 오류 코드

## 운영 기록

* [실제 프로젝트 검증 기록](sentinel-typescript-native-validation.md) - 설치 지문 대조, 공개 프로젝트 unjs/scule 검사와 직접 Stryker 대조, 남은 한계
* [변경 기록](log.md) - 문서 번들의 생성과 변경 내역
