# 문서 안내

각 문서의 내용과 함께 확인할 코드·설정 경로입니다.

`docs/manifest.json`을 수정한 뒤 `python scripts/docs_lint.py --write-index`로 이 목록을 갱신합니다.
코드 변경에 필요한 문서는 `python scripts/docs_lint.py --base HEAD`로 확인합니다.
Python 명령은 환경에 맞게 Windows에서 `py -3`, Linux에서 `python3`로 바꿀 수 있습니다.
검사는 관련 문서의 실제 변경 여부를 확인하며, 설명이 정확한지는 사람이 검토해야 합니다.

| 문서 | 내용 | 관련 코드·설정 |
| --- | --- | --- |
| [README.md](../README.md) | TypeScript 검사기의 설치, 설정, 실행 명령과 결과 | `package-lock.json`, `package.json`, `scripts/toolchain.py`, `sentinel-tool/**`, `src/**`, `toolchain.lock.json`, `tsconfig*.json` |
| [docs/contributing.md](contributing.md) | 문서 색인·소스 연결표 관리, diff 검사와 push 훅 사용 | `.githooks/**`, `.github/workflows/**`, `docs/manifest.json`, `scripts/docs_lint.py`, `scripts/verify_repository.sh`, `tests/test_docs_lint.py` |
| [docs/stryker-runtime.md](stryker-runtime.md) | Stryker 변이 수집·실행·결과 분류와 선택 범위 | `package-lock.json`, `scripts/toolchain.py`, `src/mutation/**`, `toolchain.lock.json` |
| [docs/typescript-analysis.md](typescript-analysis.md) | TypeScript 함수 분석, 복잡도와 커버리지 연결 규칙 | `src/coverage.ts`, `src/crap*.ts`, `src/source-text.ts` |
