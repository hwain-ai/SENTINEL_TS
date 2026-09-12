# SENTINEL_TS

## 역할

SENTINEL_TS의 단일 책임은 TypeScript 프로젝트의 CRAP 계산과 mutation 결과를 하나의 품질 게이트로 판정하는 것입니다.

현재는 로컬 구현 단계이며 GitHub private remote는 아직 없습니다.

첫 구현 범위에서는 TypeScript·TSX source를 AST로 분석해 함수, method, getter, setter,
constructor, 함수 표현식, arrow function과 TSX callback을 각각 찾습니다. 실제 Istanbul
`coverage-final.json`의 function·statement range를 같은 module과 source digest의 callable에만
연결하고 CRAP을 exact 분수로 계산합니다. 전체 CLI, mutation과 history는 아직 구현 중입니다.

## 현재 확인 방법

1. `npm ci --ignore-scripts`로 lock file에 고정된 dependency를 설치합니다.
2. `npm run build`로 TypeScript 7 compiler를 실행합니다.
3. `npm test`로 Node 기본 test runner의 회귀 test를 실행합니다.

TypeScript 7.0에는 안정된 compiler API가 없으므로 build에는 TypeScript 7.0.2를,
AST 분석에는 npm alias로 exact 고정한 TypeScript 6.0.3 API를 직접 사용합니다. 자세한 이유는
[TypeScript 분석 구조](docs/typescript-analysis.md)에 있습니다.

## 설계 근거

원본 작업공간 설계 문서: `docs/design-docs/2026-08-native-quality-tools.md`
