from lib import Doc, legend, est_w

W = 2000
d = Doc(W, 3000, "배포 파이프라인 확대 · 소스 업로드 → AI 분석 → IR 추출 → 어댑터 연결 → 인프라 반영",
        "P0 핵심 흐름 5단계: 소스 입력, 감지와 IR 생성, 프로필 선택, 1회 빌드와 어댑터 연결, 두 환경 배포와 헬스체크")

d.text(48, 70, "배포 파이프라인 확대", "h1")
d.text(48, 106, "P0: 대상 선택 → 소스 입력 → IR 생성 → 프로필 대조 → 1회 빌드 → 두 환경 배포 · 헬스체크  |  v5.4.1", "h2")
legend(d, 1020, 50, [
    ("e-api", "단계 내 흐름 · 산출물 전달"),
    ("e-async", "작업 큐 (Postgres SKIP LOCKED)"),
    ("gatebox", "사람 승인 게이트 (웹 · CLI)"),
    ("e-prov", "인프라 반영"),
    ("e-fail", "실패 → 진단 → 재시도"),
    ("P0", "데모 핵심 흐름"),
    ("P1", "P0 안정화 후"),
    ("P2", "시간 남으면"),
], col_w=330)

M, GAP = 48, 40
LW = (W - 2 * M - 4 * GAP) // 5
LX = [M + i * (LW + GAP) for i in range(5)]

# ---------------- stage ribbon
stages = [
    ("대상 선택 · 소스 입력", "웹 + API 서버"),
    ("감지 · IR 생성", "분석 핸들러 + 사용자 + AI"),
    ("IR 검증 · 프로필 대조", "오케스트레이터 + 프로필"),
    ("빌드 · 어댑터 연결", "빌드 · 프로비저닝 핸들러"),
    ("배포 · 검증", "프로비저닝 · 검증 핸들러"),
]
RY, RH = 150, 72
for i, (t, s) in enumerate(stages):
    x = LX[i]
    tip = 22
    pts = f"{x},{RY} {x + LW + (tip if i < 4 else 0)},{RY} " \
          f"{x + LW + (tip + 18 if i < 4 else 0)},{RY + RH / 2} {x + LW + (tip if i < 4 else 0)},{RY + RH} {x},{RY + RH}"
    if i > 0:
        pts += f" {x + 18},{RY + RH / 2}"
    d.add(f'<polygon points="{pts}" class="cp" style="stroke-dasharray:none"/>')
    cx = x + (40 if i else 30)
    d.add(f'<circle cx="{cx}" cy="{RY + RH / 2}" r="17" style="fill:var(--cp-text)"/>')
    d.text(cx, RY + RH / 2 + 5.5, str(i + 1), "stn", "middle")
    d.text(cx + 30, RY + 32, t, "ttl")
    d.text(cx + 30, RY + 56, s, "sub")

# ---------------- lane content
def card(title, lines, cls="card", tag=None, new=False):
    return ("card", title, lines, cls, tag, new)

def gate(n, kind, lines):
    return ("gate", n, kind, lines)

def code(title, lines):
    return ("code", title, lines)

def rows(title, items, tag=None):
    return ("rows", title, items, tag)

P2C = "optc"
lanes = [
    [
        card("배포 대상 선택 (필수)", ["AWS · 온프레미스 중 1개 이상", "기본값 없음 · 선택 전 진행 불가", "선택 = 환경 프로필 확정"], tag="USR", new="P0"),
        card("입력 채널", ["웹: zip 업로드 (P0)", "CLI · CI: softbank deploy (P1)", "MCP: Claude Code 호출 (P2)"], tag="USR", new="P0"),
        card("API 서버", ["인증 · 크기 · 형식 검증", "소스 zip → 오브젝트 스토리지", "source_versions (sha256) 기록", "deployments = received", "+ analyze job (한 트랜잭션)"], tag="API", new="P0"),
        card("환경변수 · 시크릿 입력", ["값은 암호화 저장소로만", "응답은 참조만: secret://…", "AI에는 키 이름만 전달"], tag="SEC", new="P1"),
    ],
    [
        card("소스 스테이징", ["stageSource(deploymentId)", "배포별 소스 카피 · 원본 오염 없음"], tag="ANL", new="P0"),
        card("① 서비스 분리 · 규칙 감지", ["폴더 · compose 기준 서비스 분리", "서비스마다 실행 방식 (http · worker …)", "포트 · 명령 · 헬스 경로 · env 이름"], tag="ANL", new="P0"),
        card("② 사용자 입력", ["감지 못 한 칸 · 틀린 값 수정", "공개 여부 · 크기 (small / medium)"], tag="WEB", new="P0"),
        card("③ AI 빈칸 채우기", ["남은 unknown만 tool_use", "prompt caching · 시크릿 값 미전송", "칸마다 출처 표시 (감지 · 입력 · AI)"], cls="agent", tag="AGT", new="P0"),
        gate(1, "patch (P1)", ["SQLite+Drizzle → Postgres (규칙)", "raw SQL은 위치 표시 + 경고", "Dockerfile 없음: AI 생성 (P0는 Railpack)", "diff 승인 → 배포본에만 적용"]),
    ],
    [
        code("IR · 앱 요구사항만 (YAML)", [
            ("k", "name: "), ("v", "todo-app"), ("k", "  version: "), ("v", "1.2.0"), None,
            ("k", "services:"), None,
            ("k", "  api:"), None,
            ("k", "    type: "), ("v", "http"), None,
            ("k", "    build: "), ("v", "./Dockerfile"), None,
            ("k", "    command: "), ("v", "[node, server.js]"), None,
            ("k", "    port: "), ("v", "3000"), None,
            ("k", "    health: "), ("v", "/health → 200"), None,
            ("k", "    env: "), ("v", "[NODE_ENV]"), None,
            ("k", "    secrets: "), ("v", "[JWT_SECRET]  # P1"), None,
            ("k", "    expose: "), ("v", "public"), None,
            ("k", "    size: "), ("v", "small"), None,
            ("k", "resources:"), None,
            ("k", "  db: "), ("v", "postgres  # 애드온 (P1)"), None,
            ("k", "  cache: "), ("v", "redis  # 프로필에 없음"), None,
        ]),
        card("스키마 검증", ["IrSchema.parse() (Zod)", "ir_versions 저장 · IR diff 뷰"], tag="ORC", new="P0"),
        rows("선택한 프로필 (검증된 골격)", [
            ("AWS", "aws", "aws-ecs-basic: VPC · ALB · ECS"),
            ("ON", "on", "onprem-docker-basic: Docker"),
        ]),
        card("capabilities 비교", ["IR 서비스 유형 · 리소스 ↔ 프로필", "http ✓ · postgres ✓ (P1 애드온)", "redis ✕ → 빠진 요소로 표시"], tag="PRF", new="P0"),
        card("빠진 요소 알림 · 결정", ["redis: 프로필에 없음 (먼저 알림)", "[확장 모듈 추가] / [제외하고 진행]", "결정은 IR에 기록 → 재질문 없음"], tag="PRF", new="P0"),
        gate(2, "target", ["프로필 · 빠진 요소 결정 확정", "확정 직후 env_lock 획득"]),
    ],
    [
        card("이미지 1회 빌드", ["BuildKit · linux/amd64", "Dockerfile 없으면 Railpack 빌드", "ECR 푸시 → digest 하나 · 두 환경 공유"], tag="BLD", new="P0"),
        card("어댑터 연결", ["IR 값 → 프로필 모듈 변수", "port · health · size → 실행 사양", "expose → ALB · Tunnel"], tag="PRV", new="P0"),
        code("확장 모듈 연결 (P1: 팀 애드온)", [
            ("k", 'module "addon_redis" {'), None,
            ("k", "  source = "), ("v", "./addons/redis (검증됨)"), None,
            ("k", "  vpc_id = "), ("v", "profile.vpc_id"), None,
            ("k", "  subnet_ids = "), ("v", "profile.subnets"), None,
            ("k", "}"), None,
            ("v", "# 출력 redis_url → 앱 env REDIS_URL"), None,
        ]),
        card("모듈 출처 · 우선순위", ["P1 ① 팀 애드온 (검증됨 · AI 없음)", "P2 ② Registry 허용 목록 · AI는 입력값만", "P2 ③ 사용자 정의 모듈", "P2 ④ AI 생성 (최후) · ②~④ 검증 안 됨"], tag="PRV", new="P1"),
        rows("프로필 → 실행 도구", [
            ("AWS", "aws", "Terraform 모듈 (ECS · ALB)"),
            ("ON", "on", "Compose 렌더 → 에이전트"),
        ]),
        card("plan()", ["스택별 S3 state key", "init -backend-config · plan -out", "(P2) 사용자 모듈: validate 먼저"], tag="PRV", new="P0"),
        gate(3, "plan", ["골격 + 확장 모듈 리소스를 한 번에 확인", "Plan: 9 to add · 0 change · 0 destroy"]),
    ],
    [
        card("apply", ["terraform apply plan.bin (S3 락)", "온프레미스: 에이전트 롱 폴링 수신", "두 환경 모두 같은 digest pull"], tag="PRV", new="P0"),
        rows("롤아웃", [
            ("AWS", "aws", "P0: ECS 롤링 + 서킷 브레이커"),
            ("ON", "on", "P0: 헬스 게이트 교체"),
            ("AWS", "aws", "P2: blue/green · 카나리"),
        ]),
        card("DB 바인딩", ["RDS · Postgres 컨테이너", "DATABASE_URL 하나로 주입", "마이그레이션 명령 선실행"], tag="PRV", new="P1"),
        card("헬스체크", ["/health → 200 연속 3회", "P1: 스모크 · P2: k6 · 카나리"], tag="VRF", new="P0"),
        card("완료", ["AWS URL + 온프레미스 URL", "env_lock 해제 · succeeded"], cls="st-rg", new="P0"),
        card("환경 전환", ["고정 도메인 → 스위치 대상 변경", "장애 감지 시 자동 (상태 없는 앱)", "옛 환경 정리 · 이력 기록"], cls="optc", tag="SW", new="P2"),
    ],
]

LANE_Y = RY + RH + 34
ITEM_GAP = 34
LH = 25
lane_bottom = []
anchors = []  # per lane list of (top, bottom)
for li, items in enumerate(lanes):
    x = LX[li]
    y = LANE_Y + 20
    boxes = []
    for it in items:
        kind = it[0]
        if kind == "card":
            _, t, ls, cls, tag, new = it
            h = d.card(x + 14, y, LW - 28, t, ls, cls=cls, tag=tag, new=new, lh=LH, tcls="ttl-s", top=34)
        elif kind == "gate":
            _, n, g, ls = it
            h = 58 + len(ls) * LH + 6
            d.rect(x + 14, y, LW - 28, h, "gatec", rx=12)
            dx, dy = x + 42, y + 30
            d.add(f'<path d="M{dx} {dy - 14} L{dx + 14} {dy} L{dx} {dy + 14} L{dx - 14} {dy} Z" style="fill:var(--gate)"/>')
            d.text(dx, dy + 5, str(n), "stn", "middle")
            d.text(dx + 26, y + 36, f"승인 게이트 {n} · {g}", "gatet")
            for j, ln in enumerate(ls):
                d.text(x + 36, y + 66 + j * LH, ln, "subd", fit=x + LW - 20)
        elif kind == "code":
            _, t, toks = it
            # group tokens into lines
            lines, cur = [], []
            for tk in toks:
                if tk is None:
                    lines.append(cur); cur = []
                else:
                    cur.append(tk)
            h = 50 + len(lines) * 21 + 16
            d.rect(x + 14, y, LW - 28, h, "codec", rx=12)
            d.add(f'<text x="{x + 34}" y="{y + 32}" style="fill:var(--code-t);font-size:16px;font-weight:700">{t}</text>')
            for j, ln in enumerate(lines):
                parts = "".join(
                    f'<tspan class="{"codek" if c == "k" else "code"}">{s.replace("<", "&lt;").replace(">", "&gt;")}</tspan>'
                    for c, s in ln)
                d.add(f'<text x="{x + 34}" y="{y + 64 + j * 21}" xml:space="preserve" data-fit="{x + LW - 20}">{parts}</text>')
        elif kind == "rows":
            _, t, rs, tag = it
            h = 50 + len(rs) * 38 + 8
            d.rect(x + 14, y, LW - 28, h, "card", rx=12)
            d.text(x + 36, y + 34, t, "ttl-s", fit=x + LW - 20)
            for j, (code_, k, desc) in enumerate(rs):
                ry = y + 52 + j * 38
                bw = 20 + len(code_) * 9.5
                d.rect(x + 36, ry, bw, 26, f"bd-{k}", rx=6)
                d.text(x + 36 + bw / 2, ry + 18, code_, "bdt", "middle")
                d.text(x + 36 + 58, ry + 19, desc, "sub", fit=x + LW - 20)
        boxes.append((y, y + h))
        y += h + ITEM_GAP
    anchors.append(boxes)
    lane_bottom.append(y - ITEM_GAP)

CHIP_Y = max(lane_bottom) + 40
# lane frames (drawn behind by inserting at start of body)
frames = []
for li in range(5):
    frames.append(f'<rect x="{LX[li]}" y="{LANE_Y}" width="{LW}" height="{CHIP_Y + 78 - LANE_Y}" rx="16" class="pool"/>')
d.p = frames + d.p

# vertical arrows between items
for li, boxes in enumerate(anchors):
    cx = LX[li] + LW // 2
    for (a0, a1), (b0, b1) in zip(boxes, boxes[1:]):
        d.path(f"M{cx} {a1 + 2} L{cx} {b0 - 4}", "e-api")
    d.path(f"M{cx} {boxes[-1][1] + 2} L{cx} {CHIP_Y - 4}", "e-api")

# artifact chips
chips = [
    ("산출물", "source_version · deployment #42"),
    ("산출물", "IR 초안 (감지 + 입력 + AI)"),
    ("산출물", "검증된 IR · 확정 프로필"),
    ("산출물", "image digest · 승인된 plan"),
    ("결과", "두 환경 URL · (P2) 고정 도메인"),
]
for i, (k, s) in enumerate(chips):
    x = LX[i] + 14
    d.rect(x, CHIP_Y, LW - 28, 58, "st-pg", rx=10)
    d.text(x + 20, CHIP_Y + 24, k, "lbl")
    d.text(x + 20, CHIP_Y + 46, s, "subd", fit=x + LW - 36)
    if i < 4:
        kind = "e-async" if i in (0, 2) else "e-api"
        d.path(f"M{x + LW - 28} {CHIP_Y + 29} L{LX[i + 1] + 10} {CHIP_Y + 29}", "e-prov" if i == 3 else kind)
d.text(LX[0] + LW + GAP // 2, CHIP_Y - 10, "큐", "lbl", "middle")
d.text(LX[2] + LW + GAP // 2, CHIP_Y - 10, "큐", "lbl", "middle")

# ---------------- failure loop band
FY = CHIP_Y + 78 + 36
fx0, fx1 = LX[1], LX[4] + LW
d.rect(fx0, FY, fx1 - fx0, 118, "failc", rx=14)
d.text(fx0 + 26, FY + 36, "실패 경로 · 어느 단계든", "failt")
d.text(fx0 + 26, FY + 66, "P0: 실패 단계에서 멈추고 로그 + 다음 행동(hint) 표시 · AWS는 ECS 서킷 브레이커가 이전 버전으로 자동 롤백 · 락은 lease 만료로 해제", "subd", fit=fx1 - 20)
d.text(fx0 + 26, FY + 94, "P1: AI 진단 (로그 꼬리 + 설정 파일, 시크릿 값 제외) → 패치 초안 → 승인 → 새 source_version으로 재시도 (최대 3회) → 초과 시 failed", "sub", fit=fx1 - 20)
for i in (2, 3, 4):
    cx = LX[i] + LW - 40
    d.path(f"M{cx} {CHIP_Y + 78 + 2} L{cx} {FY - 4}", "e-fail", end=True)
cx = LX[1] + 40
d.path(f"M{cx} {FY - 2} L{cx} {CHIP_Y + 62}", "e-fail")
d.text(cx + 12, FY - 12, "재시도", "failt")

# ---------------- bottom rows: states / tables / SSE
def chip_row(y, title, sub, per_lane, cls_text="mono", chip=True):
    maxn = max(len(v) for v in per_lane)
    h = 72 + maxn * 32
    d.rect(M, y, W - 2 * M, h, "strip", rx=14)
    d.text(M + 24, y + 34, title, "stt")
    d.text(M + 24 + est_w(title, 17) + 16, y + 34, sub, "sub")
    for i, vals in enumerate(per_lane):
        for j, v in enumerate(vals):
            cy = y + 58 + j * 32
            x = LX[i] + 14
            if chip:
                w = len(v) * 7.9 + 24
                d.rect(x, cy, w, 24, "st-ob", rx=12)
                d.text(x + 11, cy + 17, v, "mono", fit=LX[i] + LW)
            else:
                d.text(x, cy + 17, v, "mono", fit=LX[i] + LW)
        if i < 4:
            pass
    return h

y = FY + 118 + 40
y += chip_row(y, "오케스트레이터 상태", "16상태 중 정상 경로 · 각 전이는 Postgres 한 트랜잭션", [
    ["received"],
    ["analyzing", "(P1) awaiting_patch_approval"],
    ["awaiting_target_confirmation", "queued"],
    ["building", "planning", "awaiting_plan_approval"],
    ["provisioning", "deploying", "verifying", "succeeded"],
]) + 20
y += chip_row(y, "Postgres 기록", "쓰기 소유 컴포넌트만 해당 테이블에 기록", [
    ["deployments", "source_versions", "jobs"],
    ["analysis_reports", "ai_usage", "(P1) patches"],
    ["ir_versions", "approvals", "env_locks"],
    ["deployment_services (digest)", "infra_plans", "iac_stacks"],
    ["provisioned_resources", "deployment_steps", "deployments.public_url"],
], chip=False) + 20
y += chip_row(y, "SSE 이벤트", "P0: API 메모리 → 웹 · (P1) Redis Streams", [
    ["state_changed"],
    ["analysis.progress", "approval_requested"],
    ["approval_requested", "lock.changed"],
    ["step_completed", "approval_requested"],
    ["step_completed", "state_changed"],
]) + 20

d.h = y + 20
open("docs/diagrams/v5/pipeline_v541.html", "w").write(d.render())
print("height", d.h)
