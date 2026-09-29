from lib import Doc, legend, est_w

W, H = 1900, 2250
d = Doc(W, H, "AI 원클릭 멀티 환경 배포 시스템 · 개략 아키텍처 v5",
        "P0 핵심 흐름 중심의 배포 시스템 아키텍처: IR + 환경 프로필, 통합 워커, AWS와 온프레미스")

# ---------------- header + legend
d.text(48, 70, "AI 원클릭 멀티 환경 배포 시스템", "h1")
d.text(48, 106, "개략 아키텍처 v5.4.1 · 환경 프로필(골격 + capabilities) + 확장 모듈 (P1 검증 애드온 · P2 사용자 정의) | One Action, Infinite Clouds.", "h2")
legend(d, 980, 52, [
    ("e-api", "API 호출 (HTTPS · SSE)"),
    ("e-prov", "프로비저닝 · 배포"),
    ("e-obs", "관측 데이터"),
    ("e-async", "비동기 작업 (Postgres 큐)"),
    ("e-user", "사용자 트래픽"),
    ("P0", "데모 핵심 흐름 (먼저 완주)"),
    ("P1", "P0 안정화 후 확장"),
    ("P2", "시간 남으면 · 설계 문서로 커버"),
], col_w=300)

def pcls(p, base="card"):
    return "optc" if p == "P2" else base

# ---------------- left: clients
LX, LW = 48, 310
clients = [
    ("웹 대시보드", ["개발자 · 팀의 기본 입구", "배포 대상 선택 (필수) · 업로드", "빠진 요소 결정 · 승인 · 진행 · URL"], "P0"),
    ("CLI (softbank)", ["deploy · status · logs · rollback", "공식 요구 #5 · 로컬 CI 러너"], "P1"),
    ("CI / Git", ["GitHub Actions → softbank deploy", "공식 요구 #5 · push 자동 배포"], "P1"),
    ("MCP · llms.txt", ["Claude Code · IDE 연동", "파괴적 도구 = 승인 필수"], "P2"),
]
y = 150
client_mid = []
for t, ls, p in clients:
    h = d.card(LX, y, LW, t, ls, new=p, cls=pcls(p))
    client_mid.append(y + 44)
    y += h + 18

BX = 380
for cy in client_mid:
    d.add(f'<line x1="{LX + LW}" y1="{cy}" x2="{BX}" y2="{cy}" class="e-api"/>')
d.add(f'<line x1="{BX}" y1="{client_mid[0]}" x2="{BX}" y2="{client_mid[-1]}" class="e-api"/>')

# ---------------- control plane
CX, CW = 405, 940
CY, CH = 145, 1195
d.rect(CX, CY, CW, CH, "cp", rx=18)
d.text(CX + 34, CY + 42, "컨트롤 플레인", "cpt")
d.text(CX + CW - 30, CY + 42, "P0 실행 단위: api · worker · web (+ onprem-agent)", "lbl", "end")

IX, IW = 440, 870
C1, C2, CWc = 440, 890, 420
api_y = 205
d.card(IX, api_y, IW, "API 서버 + 오케스트레이터 (단일 프로세스)", [
    "REST · SSE · 인증 · 요청 검증 · 에러 응답에 다음 행동(hint)  ·  웹 · CLI · CI 모두 같은 API",
    "상태 머신 · env_lock (환경 단위 락) · 승인 게이트 target · plan (P0) / patch (P1)",
    "상태 변경 + 작업 생성 = 한 트랜잭션  ·  한 대로 운영 → 리더 선출 불필요",
], tag="UI · DEP · LCK", new="P0", h=140)
d.path(f"M{BX} {api_y + 50} L{IX - 4} {api_y + 50}", "e-api")
d.add(f'<line x1="{BX}" y1="{client_mid[0]}" x2="{BX}" y2="{api_y + 50}" class="e-api"/>')

r2 = api_y + 140 + 44
d.card(C1, r2, CWc, "AI 에이전트", [
    "P0: IR 빈칸 채우기 (감지 · 입력 후 남은 칸)",
    "P2: 빠진 조각 → 허용 모듈 선택 · 입력값",
    "P1: 코드 패치 제안 · 실패 진단",
    "prompt caching · 시크릿 값 미전송",
    "ai_usage: 배포별 토큰 · 비용 기록",
], tag="AGT", cls="agent", new="P0", h=210)
d.card(C2, r2, CWc, "환경 프로필 카탈로그", [
    "환경별 인프라 골격을 미리 정의 · 검증",
    "aws-ecs-basic · onprem-docker-basic",
    "capabilities: 지원 서비스 유형 · 리소스",
    "골격 출력 (vpc_id · subnet_ids) 제공",
    "없는 요소: 알림 → 추가 / 제외 (사용자)",
], tag="PRF", new="P0", h=210)
d.path(f"M{C1 + 210} {api_y + 144} L{C1 + 210} {r2 - 4}", "e-api", start=True)
d.text(C1 + 224, api_y + 168, "도구 호출", "lbl")
d.path(f"M{C2 + 210} {api_y + 144} L{C2 + 210} {r2 - 4}", "e-api")
d.text(C2 + 224, api_y + 168, "프로필 조회", "lbl")

r3 = r2 + 210 + 26
d.card(C2, r3, CWc, "비용 엔진", [
    "P1: 선택한 프로필의 월 예상 비용",
    "pricing-catalog (JSON) · 사용량 가정 표시",
    "P2: 프로필 추천 · 근거 설명은 AI",
], tag="CST · REC", new="P1", h=156)
d.card(C1, r3, CWc, "관측 게이트웨이", [
    "P0 대체: 단계 로그 + 헬스체크 결과",
    "P2: CloudWatch · Docker 로그 통합 조회",
    "P2: OTel · Grafana 한 화면 뷰",
], tag="OBS", cls="optc", new="P2", h=156)

py = r3 + 156 + 30
ph = CY + CH - 25 - py
d.rect(C1 - 15, py, IW + 30, ph, "pool", rx=14)
d.text(C1 + 10, py + 32, "통합 워커 (단일 프로세스 · job_type별 핸들러)", "stt")
d.text(C1 + IW + 5, py + 32, "Postgres 큐 · 작업 공간 격리 · 멱등 (job_id + attempt)", "lbl", "end")
w1 = py + 52
wh = (ph - 52 - 18 - 20) // 2
d.card(C1 + 5, w1, CWc - 10, "분석 핸들러", [
    "① 서비스 단위 분리 · 실행 방식 판정",
    "② 규칙 감지 → 사용자 입력 → AI 빈칸",
    "Dockerfile 유무 · 빌드 방식 판정",
    "P1: SQLite+Drizzle → PG · raw SQL 경고",
    "출력: IR (앱 요구사항만)",
], tag="ANL", new="P0", h=wh)
d.card(C2 + 5, w1, CWc - 10, "빌드 핸들러", [
    "1회 빌드 → digest 하나",
    "BuildKit · linux/amd64 · 루트리스",
    "ECR 푸시 (온프레미스도 여기서 pull)",
    "Dockerfile 없으면 Railpack 빌드",
], tag="BLD", new="P0", h=wh)
w2 = w1 + wh + 18
d.card(C1 + 5, w2, CWc - 10, "프로비저닝 핸들러", [
    "IR 값 → 프로필 모듈 변수",
    "P1: 골격 출력 → 확장 모듈 입력",
    "AWS: Terraform plan → 승인 → apply",
    "온프레미스: 에이전트에 작업 전달",
    "스택별 S3 state · use_lockfile",
], tag="PRV", new="P0", h=wh)
d.card(C2 + 5, w2, CWc - 10, "검증 핸들러", [
    "P0: 헬스체크 → 공개 URL 확정",
    "P1: 스모크 · 실패 시 이전 digest 롤백",
    "P2: 환경 헬스 감시 → 자동 전환",
    "P2: k6 부하 · 카나리 관찰",
], tag="VRF", new="P0", h=wh)

ax = CX + CW - 17
d.path(f"M{IX + IW} {api_y + 100} L{ax} {api_y + 100} L{ax} {py + 80} L{C1 + IW + 20} {py + 80}", "e-async")

# ---------------- right: stores
SX, SW = 1392, 464
stores = [
    ("Postgres", ["단일 진실 원천 · 배포 상태 · 이력", "작업 큐 SKIP LOCKED · LISTEN/NOTIFY"], "st-pg", "P0"),
    ("Redis", ["P0: API 1대 → 메모리 안에서 SSE 전달", "API 여러 대일 때 Streams로 로그 전달"], "st-rd", "P1"),
    ("오브젝트 스토리지", ["MinIO / S3 · 소스 zip · IR 스냅샷", "작업 로그 영구 저장 (단계별)"], "st-ob", "P0"),
    ("IaC State 백엔드", ["S3 + use_lockfile · 버전 관리 · SSE-KMS", "key = 프로젝트 × 환경 (스택)"], "st-ob", "P0"),
    ("시크릿 저장소", ["Postgres 암호화 저장 (AES-GCM) · getSecret()", "마스터 키 = SOPS + age"], "st-vt", "P1"),
    ("LLM API (Anthropic)", ["IR 빈칸 · (P1) 패치 · 진단 · (P2) 모듈 선택", "prompt caching · 시크릿 값 미전송"], "st-ai", "P0"),
    ("컨테이너 레지스트리", ["ECR 하나에 1회 푸시 · 같은 digest", "온프레미스: 읽기 전용 IAM으로 pull"], "st-rg", "P0"),
]
sy = CY + 5
gap = 16
sh = (CH - 10 - gap * (len(stores) - 1)) // len(stores)
store_mid = []
for t, ls, cls, p in stores:
    d.card(SX, sy, SW, t, ls, cls=cls, new=p, h=sh)
    store_mid.append(sy + sh // 2)
    sy += sh + gap
RB = 1368
for cy in store_mid:
    d.add(f'<line x1="{RB}" y1="{cy}" x2="{SX}" y2="{cy}" class="e-api"/>')
d.add(f'<line x1="{RB}" y1="{store_mid[0]}" x2="{RB}" y2="{store_mid[-1]}" class="e-api"/>')
d.add(f'<line x1="{IX + IW}" y1="{api_y + 50}" x2="{RB}" y2="{api_y + 50}" class="e-api"/>')
d.add(f'<line x1="{C1 + IW + 15}" y1="{w2 + 40}" x2="{RB}" y2="{w2 + 40}" class="e-api"/>')

# ---------------- data plane
DY = CY + CH + 90
DX0 = 405
BIGW, SMW, G = 538, 331, 22
envs = [
    ("ON", "온프레미스", "on", "onprem-docker-basic · 에이전트 Pull (롱 폴링)", "P0", [
        ["onprem-agent · 1회용 등록 토큰", "인텔 맥 VM · Docker (amd64)", "같은 digest를 ECR에서 pull",
         "Compose로 실행 · 헬스 게이트 교체"],
        ["Cloudflare Tunnel → 공개 URL", "Docker DNS 내부 라우팅", "Docker 로그",
         "P1: Postgres 컨테이너 바인딩"]]),
    ("AWS", "AWS", "aws", "aws-ecs-basic · Terraform 모듈 · IAM", "P0", [
        ["VPC · 퍼블릭 / 프라이빗 서브넷", "ALB → 공개 URL", "ECS 롤링 + 서킷 브레이커",
         "Cloud Map 내부 라우팅"],
        ["CloudWatch Logs", "P1: 검증된 확장 모듈 (골격 위)", "P1: RDS PostgreSQL 바인딩",
         "P2: blue/green · 카나리"]]),
]
DH = 300
env_cx = []
for i, (code, name, k, sub, p, cols) in enumerate(envs):
    x = DX0 + i * (BIGW + G)
    env_cx.append(x + BIGW // 2)
    d.rect(x, DY, BIGW, DH, f"env env-{k}", rx=14)
    bw = 26 + len(code) * 10
    d.rect(x + 22, DY + 24, bw, 30, f"bd-{k}", rx=7)
    d.text(x + 22 + bw / 2, DY + 44, code, "bdt", "middle")
    d.text(x + 22 + bw + 14, DY + 47, name, "ttl")
    d.new_badge(x + 22 + bw + 14 + est_w(name, 19) + 10, DY + 31, p, p.lower() + "b")
    d.text(x + 22, DY + 86, sub, "pt", fit=x + BIGW - 10)
    colw = (BIGW - 44) // 2
    for c, bullets in enumerate(cols):
        cx0 = x + 22 + c * colw
        for j, bl in enumerate(bullets):
            yy = DY + 124 + j * 30
            d.add(f'<circle cx="{cx0 + 6}" cy="{yy - 5}" r="3.2" class="dot-{k}"/>')
            d.text(cx0 + 18, yy, bl, "sub", fit=cx0 + colw - 6)

sx = DX0 + 2 * (BIGW + G)
env_cx.append(sx + SMW // 2)
d.rect(sx, DY, SMW, DH, "optc", rx=14)
for j, (code, k) in enumerate([("GCP", "gcp"), ("AZ", "az")]):
    bx = sx + 22 + j * 66
    d.rect(bx, DY + 24, 56, 30, f"bd-{k}", rx=7)
    d.text(bx + 28, DY + 44, code, "bdt", "middle")
d.text(sx + 22 + 2 * 66 + 6, DY + 47, "프로필 확장", "ttl")
d.new_badge(sx + SMW - 50, DY + 31, "P2", "p2b")
d.text(sx + 22, DY + 86, "같은 IR · 새 프로필 + 어댑터만 추가", "pt", fit=sx + SMW - 10)
for j, bl in enumerate(["gcp-cloudrun-basic", "azure-aca-basic",
                        "공식 요구 #16 → 설계 문서", "시간 남으면 실제 배포 시연"]):
    yy = DY + 124 + j * 30
    d.add(f'<circle cx="{sx + 28}" cy="{yy - 5}" r="3.2" style="fill:var(--muted)"/>')
    d.text(sx + 40, yy, bl, "sub", fit=sx + SMW - 10)

# provisioning bus
bus_y = CY + CH + 28
prov_x = C1 + 5 + (CWc - 10) // 2
d.add(f'<path d="M{prov_x} {w2 + wh} L{prov_x} {bus_y}" class="e-prov"/>')
d.add(f'<line x1="{min(prov_x, env_cx[0])}" y1="{bus_y}" x2="{env_cx[-1]}" y2="{bus_y}" class="e-prov"/>')
for cx in env_cx:
    d.path(f"M{cx} {bus_y} L{cx} {DY - 4}", "e-prov")
lab = "같은 이미지 digest → 두 환경  ·  AWS: 클라우드 API Push  ·  온프레미스: 에이전트 Pull (롱 폴링)"
lw = est_w(lab, 13.5) + 24
lx = (env_cx[0] + env_cx[1]) // 2
d.rect(lx - lw / 2, bus_y + 12, lw, 26, "bg", rx=4)
d.text(lx, bus_y + 30, lab, "lbl", "middle")

# left labels for data plane + app users
d.text(LX, DY + 30, "데이터 플레인", "cpt")
d.text(LX, DY + 60, "컨트롤이 멈춰도 배포된 앱은 계속 동작", "sub")
uy = DY + 80
d.card(LX, uy, LW, "앱 사용자", ["P0: 환경별 URL · P2: 고정 도메인"], h=84)
sw_y = uy + 84 + 30
d.path(f"M{LX + LW // 2} {uy + 84} L{LX + LW // 2} {sw_y - 4}", "e-user")
d.card(LX, sw_y, LW, "트래픽 스위치", ["app.도메인 → ALB 또는 Tunnel", "헬스 모니터 → 자동 전환", "Cloudflare DNS · LB"], new="P2", cls="optc", h=150)
d.path(f"M{LX + LW} {sw_y + 60} L{DX0 - 4} {sw_y + 60}", "e-user")

# ---------------- observation band
OY = DY + DH + 60
OH = 190
d.rect(DX0, OY, 1856 - DX0, OH, "obsc", rx=14, extra='style="stroke-dasharray:6 4"')
d.text(DX0 + 26, OY + 40, "관측 · 피드백 (Grafana LGTM)", "ttl")
d.new_badge(DX0 + 26 + est_w("관측 · 피드백 (Grafana LGTM)", 19) + 10, OY + 24, "P2", "p2b")
d.text(1856 - 24, OY + 38, "P0 대체: 웹 대시보드의 배포 단계 로그 + 헬스체크 결과", "lbl", "end")
cells = [
    ("Grafana", ["대시보드 · 웹에 iframe 임베드"]),
    ("Prometheus", ["메트릭 · 24h 보관"]),
    ("Loki", ["로그 · 플랫폼 이벤트 수신"]),
    ("Pyroscope", ["배포별 CPU · heap 프로파일"]),
    ("OTel Collector", ["표준 태그 · 사이드카 주입"]),
]
cw = (1856 - DX0 - 52 - 4 * 16) // 5
for i, (t, ls) in enumerate(cells):
    x = DX0 + 26 + i * (cw + 16)
    d.card(x, OY + 66, cw, t, ls, tcls="ttl-s", h=98, top=34)
for cx in env_cx:
    d.path(f"M{cx} {DY + DH} L{cx} {OY - 4}", "e-obs")
swy = DY + DH + 24
d.add(f'<path d="M{env_cx[0] + 70} {swy} L{env_cx[1] - 70} {swy}" class="e-user" style="stroke-dasharray:7 5" marker-start="url(#m-e-user)" marker-end="url(#m-e-user)"/>')
_sl = "P2 환경 전환: 같은 digest 재배포 → 헬스 OK → 스위치 → 정리"
d.rect((env_cx[0] + env_cx[1]) / 2 - est_w(_sl, 13.5) / 2 - 10, swy - 13, est_w(_sl, 13.5) + 20, 26, "bg", rx=4)
d.text((env_cx[0] + env_cx[1]) / 2, swy + 5, _sl, "lbl", "middle")
d.rect(env_cx[1] + 16, DY + DH + 18, est_w("P2: OTel 사이드카 → 표준 태그", 13.5) + 20, 26, "bg", rx=4)
d.text(env_cx[1] + 24, DY + DH + 36, "P2: OTel 사이드카 → 표준 태그", "lbl")

# obs band -> obs gateway (left route)
gx = 385
d.path(f"M{DX0} {OY + 100} L{gx} {OY + 100} L{gx} {CY + CH + 10} L{CX + 17} {CY + CH + 10} "
       f"L{CX + 17} {r3 + 90} L{C1 - 4} {r3 + 90}", "e-obs")
d.text(LX, OY + 40, "관측 · 피드백", "cpt")
d.text(LX, OY + 72, "P2 · 고급 모니터링", "sub")
d.text(LX, OY + 96, "P0는 단계 로그 + 헬스체크로 대체", "sub")

# ---------------- principles strip
PY = OY + OH + 34
PH = 1856 - DX0
d.rect(DX0, PY, PH, 200, "strip", rx=14)
d.text(LX, PY + 40, "설계 원칙", "cpt")
d.text(LX, PY + 72, "팀 합의 사항 (9/29 저녁)", "sub")
d.text(LX, PY + 100, "협업: 멱등 · 락 · 큐 · 로그", "sub")
d.text(LX, PY + 148, "코드: 모노레포 + 폴더별 담당자", "sub")
d.text(LX, PY + 124, "서킷 브레이커 자동 롤백", "sub")
princ = [
    ("P0 핵심 흐름", "소스 → IR → 1회 빌드 → 같은 digest로 AWS · 온프레미스 → 헬스체크"),
    ("IR + 환경 프로필", "IR = 앱 요구만 · 프로필 = 환경별 골격 + capabilities 선언"),
    ("AI 범위 제한", "IR 빈칸 · (P1) 코드 패치 · 진단 · (P2) 모듈 선택 · 사람 확인"),
    ("DB 전환 (P1)", "SQLite+Drizzle → PostgreSQL · 배포본만 규칙 변환 · raw SQL 경고"),
    ("환경 전환 (P2 · 차별점)", "고정 도메인 + 스위치 · AWS ↔ 온프레미스 원클릭 · 장애 시 자동"),
    ("확장 모듈 (P1 → P2)", "P1: 팀이 검증한 애드온 · P2: 사용자 정의 (검증 안 됨 표시)"),
]
colw = PH // 3
for i, (t, s) in enumerate(princ):
    x = DX0 + 30 + (i % 3) * colw
    yy = PY + 46 + (i // 3) * 86
    d.text(x, yy, t, "stt")
    d.text(x, yy + 30, s, "sub", fit=x + colw - 20)

H2 = PY + 200 + 40
d.h = H2
open("docs/diagrams/v5/architecture_v541.html", "w").write(d.render())
print("height", H2)
