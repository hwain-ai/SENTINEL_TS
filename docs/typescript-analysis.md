---
type: Architecture Note
status: draft
generated: { by: process:codex, at: 2026-09-03T06:18:36Z }
owner: human:hwain
sources:
  - resource: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
    title: Announcing TypeScript 7.0
stale_after: 2026-12-03
---

# TypeScript 분석 구조

한마디 요약: SENTINEL_TS는 project build에는 TypeScript 7을 쓰고, source AST 분석에는
TypeScript 6 호환 API를 사용합니다.

## 왜 두 version이 필요한가

TypeScript 7.0.2는 Go로 새로 만든 native compiler입니다. 이 version의 `typescript`
package root는 전체 compiler API를 제공하지 않습니다. Microsoft도 7.0에서 programmatic
compiler API가 필요한 도구는 `@typescript/typescript6`를 함께 사용하도록 안내합니다.

실제 역할은 다음과 같습니다.

|구성요소|version|역할|
|---|---:|---|
|`@typescript/native`|7.0.2|SENTINEL_TS 자체 source의 빠른 typecheck와 build|
|`@typescript/old` npm alias|실제 AST API 6.0.3 exact|검사할 TypeScript·TSX source를 AST로 parse하고 순회|
|Node.js|22.23.1 이상|build 결과와 test 실행|

Production analyzer는 `@typescript/old`라는 dependency 이름으로 exact
`typescript@6.0.3`을 직접 import합니다. Consumer가 다른 TypeScript dependency를 가져도
호환 wrapper의 넓은 version 범위나 npm hoisting으로 analyzer version이 바뀌지 않습니다.
이 분리를 하지 않고 TypeScript 7 package root에서 예전 `createSourceFile`을 호출하면 API가
없어 compile 단계에서 실패합니다.

`test/fixtures/vitest-range/coverage-final.json`은 Vitest 4.1.11과 coverage-v8 4.1.11로
직접 생성한 report에서 작업공간 절대 경로만 `/project`로 바꾼 회귀 fixture입니다.

## 현재 처리 순서

1. 입력 source를 TypeScript 또는 TSX AST로 parse합니다.
2. 함수, async 함수, method, getter, setter, constructor, 함수 표현식, arrow function과 TSX callback을 찾습니다.
3. nested callable의 decision을 parent에서 빼고 callable별 cyclomatic complexity를 계산합니다.
4. Istanbul top-level file key와 record 안의 path가 같은 canonical module인지 확인합니다.
5. `fnMap`·`f`와 `statementMap`·`s`의 ID 집합과 range를 검증한 뒤, 같은 source digest의 callable에만 연결합니다.
6. covered count와 total count로 CRAP 기약분수를 만들고 raw 값이 8 이하인지 판정합니다.

예를 들어 complexity가 4이고 statement 4개 중 3개가 실행됐다면 결과는 `17/4`,
표시값은 `4.25`, 판정은 통과입니다.

## 실패를 숨기지 않는 경계

- 같은 callable identity가 두 번 나오면 line 번호를 임의로 붙이지 않고 ambiguity 오류를 냅니다.
- callable identity는 namespace, object binding, class binding, static·instance receiver,
  바깥 callback binding, JSX element 경로와 whitespace를 정규화한 signature를 사용합니다.
- coverage path는 basename이나 suffix로 추측하지 않습니다.
- coverage module이나 source digest가 callable과 다르면 연결하지 않고 오류를 냅니다.
- coverage unit이 없으면 0%로 꾸미지 않고 unknown으로 남깁니다.
- source range는 JavaScript 문자열 위치가 아니라 valid Unicode scalar의 UTF-8 byte 기준으로 변환합니다.
- CRAP row는 unknown, exact CRAP 분수, UTF-8 path, byte start, callable ID 순서로 정렬합니다.
- TypeScript 7이 안정된 AST API를 제공하기 전에는 lock된 6.x API dependency를 제거하지 않습니다.

이 문서는 외부 TypeScript API 상태가 바뀔 수 있어 3개월 뒤 신선도를 다시 확인합니다.
