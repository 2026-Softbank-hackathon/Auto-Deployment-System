# Claude Code 시작 가이드 (v2, 2026-09-30)

claude.ai 세션(9/25~9/30)의 컨텍스트를 Claude Code로 넘기는 패키지.
루트 `CLAUDE.md`가 자동으로 읽히고, 나머지는 `docs/`에 있음.

## 1. 설치 방법 (둘 중 하나)

**A. 새 폴더로 시작**
```bash
unzip deploy-system-handoff-v2.zip && cd deploy-system
git init && git add . && git commit -m "docs: claude.ai 세션 핸드오프 v2 (9/30 회의까지)"
claude
```

**B. 팀 모노레포에 합치기 (추천)** — 팀원 리포에 이미 `docs/`, 코드, D-01~D-34 결정 기록이 있음
```bash
# 팀 리포 루트에서
mkdir -p docs/handoff && cp -r <압축 푼 경로>/deploy-system/docs/* docs/handoff/
cp <압축 푼 경로>/deploy-system/tools/diag -r tools/diag
# CLAUDE.md: 팀 리포에 이미 있으면 이 패키지의 CLAUDE.md 0~6절을 붙여 넣고,
#            파일 지도(7절)의 경로 앞에 handoff/ 를 붙일 것
```

## 2. 첫 메시지로 붙여 넣을 프롬프트
```
CLAUDE.md를 읽고, docs/status-2026-09-30.md → docs/meetings/2026-09-30.md →
docs/architecture-v5.md → docs/decisions.md(D-28 이후와 미결 Q-01~Q-08) →
docs/todo-jeong.md 순서로 읽어줘.
다 읽으면 (1) 지금 상황 5줄 요약 (2) 오늘 새벽 내가 할 일 top 3를 개조식으로 알려줘.
그다음 Q-01(백엔드 구조: API 서버 + Postgres vs 서버리스)을 비교해서 추천해줘.
반말로 해.
```

## 3. 이후 추천 순서
1. Q-01 백엔드 구조 결정 → decisions.md 기록
2. IR 스키마 v0 (Zod, `packages/ir-schema`) — 팀원 리포의 기존 Zod 스키마 · IR 6필드와 맞추기
3. 기능 명세 (P0/P1/P2, 완료 조건) → 노션 백로그
4. API 명세 (배포 생성 · 상태 조회 · 빠진 요소 결정 · 승인 · SSE · 에이전트 폴링)
5. 분석기 → IR 구현
6. 운영진 답변 반영 → 다이어그램 v6 (`tools/diag/` 수정 후 재생성)

## 4. 도구
- 다이어그램: `python3 tools/diag/gen_overall_v541.py` → `docs/diagrams/v5/architecture_v541.html` 생성 → `python3 tools/diag/render.py <절대경로 html> <png> 2` (Playwright + Chromium, IBM Plex Sans KR 웹폰트). 텍스트가 칸을 넘으면 `OVERFLOW`로 출력됨 → 문구 줄이기
- 구 도구(9/26): `tools/schema_v2.py`(스키마 → SQL · 데이터 사전), `tools/gen.py`, `tools/render_one.py`(mermaid)

## 5. 참고 원본
- `docs/reference/meeting-2026-09-30-transcript.txt` — 9/30 회의 음성 인식 녹취 원문 (이름 오기 많음, 회의록 상단 참고)
- `docs/reference/kickoff-slides.txt` — 킥오프 슬라이드 텍스트 (한/일)
- `docs/reference/agenda-minseong.txt` — 김민성 회의 안건
- `docs/reference/team/` — 팀원 아키텍처 문서 2종
- `docs/reference/design-brief.md` — 대시보드 디자인 브리프
- `docs/reference/CLAUDE_v1_2026-09-26.md`, `HANDOFF_v1_…`, `open-items_v1_…` — 구버전
