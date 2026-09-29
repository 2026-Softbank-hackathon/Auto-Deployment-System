from html import escape as e
S=[]
def a(s): S.append(s)
def t(x,y,txt,cls='sub',anchor='start'):
    a(f'<text x="{x}" y="{y}" class="{cls}" text-anchor="{anchor}">{e(txt)}</text>')
def card(x,y,w,h,title,lines,cls='card',tag=None):
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" class="{cls}"/>')
    t(x+18,y+32,title,'ttl')
    if tag: t(x+w-16,y+30,tag,'tag','end')
    for i,l in enumerate(lines): t(x+18,y+56+i*21,l)
def arrow(d,cls='e-api',start=False):
    a(f'<path d="{d}" class="{cls}" fill="none" marker-end="url(#m-{cls})"'+(f' marker-start="url(#m-{cls})"' if start else '')+'/>')

W,H=1600,1640
a(f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="dt dd">')
a('<title id="dt">AI 원클릭 멀티 환경 배포 시스템 개략 아키텍처</title><desc id="dd">클라이언트, 컨트롤 플레인, 저장소, 데이터 플레인 4개 환경으로 구성된 배포 시스템 아키텍처</desc>')
a('<defs>')
for c in ['e-api','e-async','e-prov','e-user','e-obs']:
    a(f'<marker id="m-{c}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9z" class="mk-{c}"/></marker>')
a('</defs>')
a(f'<rect width="{W}" height="{H}" class="bg"/>')
t(40,62,'AI 원클릭 멀티 환경 배포 시스템','h1')
t(40,92,'개략 아키텍처 v3  |  One Action, Infinite Clouds.','h2')
leg=[('e-api','API 호출 (HTTPS · SSE)'),('e-async','비동기 작업 (작업 큐)'),('e-prov','프로비저닝 · 배포'),('e-user','사용자 트래픽'),('e-obs','관측 데이터 수집')]
for i,(c,lab) in enumerate(leg):
    xx=1060+(i%2)*260; yy=44+(i//2)*26
    a(f'<line x1="{xx}" y1="{yy}" x2="{xx+40}" y2="{yy}" class="{c}"/>'); t(xx+52,yy+5,lab,'leg')

cl=[(130,80,'개발자 · 팀',['소스 업로드 · 승인']),
    (230,100,'CLI',['init · deploy · logs · rollback','로컬 러너 (같은 파이프라인)']),
    (350,120,'웹 대시보드',['Next.js · 분석 리포트','diff 승인 · IR 편집 · 플랜 미리보기','진행 · 이력 · 관측 · 롤백']),
    (490,100,'CI / Git',['GitHub Actions','push 시 자동 배포']),
    (610,80,'외부 AI 도구',['MCP · IDE 연동 (선택)'])]
for y,h,ti,ls in cl:
    card(40,y,260,h,ti,ls)
    a(f'<line x1="300" y1="{y+h/2}" x2="320" y2="{y+h/2}" class="e-api"/>')
a('<line x1="320" y1="170" x2="320" y2="650" class="e-api"/>')
arrow('M320 210 L368 210','e-api')

a('<rect x="340" y="120" width="790" height="926" rx="18" class="cp"/>')
t(366,150,'컨트롤 플레인','cpt'); t(1104,150,'데모: VM 1대 · 무상태 API·워커로 수평 확장','tag','end')
card(370,170,730,80,'API 서버',['REST · SSE 로그 스트림 · 인증 · 요청 검증 · 단일 API로 모든 클라이언트 지원'],tag='UI · USR')
card(370,280,350,160,'AI 에이전트 서비스',['LLM tool use로 API를 도구처럼 호출','스택 분석 · 코드 패치 · 실패 진단','가드레일: 인프라 변경은 사람 승인','토큰 사용량 · 효과 지표 기록'],cls='agent',tag='AGT · FIX')
card(750,280,350,160,'오케스트레이터',['상태 머신 · 파이프라인 정의 파일','분석 → 빌드 → 계획 →','프로비저닝 → 배포 → 검증','커스텀 단계 · 락 · 대기열 · 재시도','데모용 사전 프로비저닝 모드'],tag='DEP · LCK · CI · DMO')
arrow('M545 252 L545 278','e-api',start=True); t(556,270,'도구 호출','lbl')
arrow('M925 252 L925 278','e-api')
card(370,468,350,142,'관측 게이트웨이',['환경별 관측 백엔드 조회 어댑터','로그 · 메트릭 · 트레이스 · Pyroscope 프로파일','대시보드와 에이전트에 제공','배포 후 장애 진단의 입력'],cls='obsc',tag='OBS · FIX')
card(750,468,350,142,'추천 · 비용 엔진',['가격 카탈로그 + 규칙으로 후보 산출','서버리스 · 컨테이너 · 인스턴스 비교','월 예상 비용 · 최적화 제안','AI는 근거 설명만 담당'],tag='REC · CST')

a('<rect x="370" y="630" width="730" height="396" rx="14" class="pool"/>')
t(390,656,'샌드박스 격리 워커 풀  (수평 확장)','pt')
a('<path d="M1100 400 L1116 400 L1116 700 L1104 700" class="e-async" fill="none" marker-end="url(#m-e-async)"/>')
card(388,672,338,140,'분석 워커',['규칙 감지 → 애매하면 LLM','프레임워크 · 포트 · DB · 환경변수','모놀리스 · MSA 의존 그래프','운영 위험 진단 · 결과 캐시'],tag='ANL')
card(744,672,338,140,'빌드 워커',['BuildKit · Dockerfile','실패 시 Railpack 대체','태깅 · 캐시 · amd64/arm64 빌드','대상별 레지스트리 푸시'],tag='BLD')
card(388,828,338,180,'프로비저닝 워커',['IR 생성 · 검증 · 환경별 오버라이드','플랜 → 적용 · 리소스 정리','Pulumi / Terraform · 환경별 어댑터 4종','다중 서비스 배포 순서 · 리소스 한도','자동 확장 · 서비스 디스커버리','DB 마이그레이션 · 데이터 이전 · 롤아웃'],tag='PRV · SCL · MIG · IR')
card(744,828,338,180,'검증 워커',['패치 적용 후 빌드 · 테스트','배포 후 헬스체크 · 스모크 테스트','k6 부하 테스트','결과를 에이전트에 전달'],tag='PAT · SCL')

st=[('pg','Postgres',['프로젝트 · 배포 이력 · 락 · 비용 · 분석 캐시']),
    ('rd','Redis',['작업 큐 · 이벤트 스트림 (SSE 중계)']),
    ('ob','오브젝트 스토리지',['MinIO / S3 · 소스 · 빌드 로그 · IaC state']),
    ('vt','시크릿 볼트',['앱 비밀값 · 대상 환경 자격증명 (역할 위임)']),
    ('ai','LLM API',['비밀값 마스킹 후 필요한 단계만 호출']),
    ('rg','컨테이너 레지스트리',['ECR · Artifact Registry · ACR · 로컬'])]
for i,(c,ti,ls) in enumerate(st):
    y=130+i*106
    card(1170,y,390,86,ti,ls,cls='st-'+c)
    a(f'<line x1="1150" y1="{y+43}" x2="1168" y2="{y+43}" class="e-api"/>')
a('<line x1="1150" y1="173" x2="1150" y2="760" class="e-api"/>')
a('<line x1="1100" y1="210" x2="1150" y2="210" class="e-api"/>')
a('<line x1="1100" y1="760" x2="1150" y2="760" class="e-api"/>')

t(40,1142,'데이터 플레인','cpt'); t(40,1166,'사용자 계정 · 사용자 서버에서 앱 실행','sub')
arrow('M557 1010 L557 1070','e-prov')
a('<line x1="485" y1="1070" x2="1415" y2="1070" class="e-prov"/>')
t(815,1095,'클라우드 API Push · 온프레미스 Pull/SSH','lbl')
arrow('M356 1108 L356 535 L366 535','e-obs'); t(366,1064,'관측 데이터 (4개 환경)','lbl')
envs=[('ON','온프레미스','에이전트 Pull 또는 SSH','on',['온프레미스 에이전트 · 로컬 레지스트리','k3s · Docker Compose','HPA 자동 확장 · CoreDNS','Postgres · MinIO 컨테이너','암호화 .env','Cloudflare Tunnel · TLS','Traefik 가중치 카나리','OTel · Prometheus · Grafana','Loki · Tempo · Pyroscope','Linux · macOS · Windows VM']),
      ('AWS','AWS','클라우드 API · 사용자 계정','aws',['ECS Fargate · Lambda · EC2','ECS 오토스케일링 · Cloud Map','RDS · 비공개 서브넷','S3','Secrets Manager','ALB + ACM 인증서','ECS 블루그린 · Lambda 가중치','CloudWatch · X-Ray · Pyroscope','CodeBuild (선택: 계정 내 빌드)']),
      ('GCP','Google Cloud','클라우드 API · 사용자 계정','gcp',['Cloud Run · Functions · GCE','자동 확장 · 내부 서비스 URL','Cloud SQL · 비공개 IP','Cloud Storage','Secret Manager','관리형 URL · TLS','Cloud Run 트래픽 분할','Cloud Logging · Trace · Pyroscope','Cloud Build (선택: 계정 내 빌드)']),
      ('AZ','Azure','클라우드 API · 사용자 계정','az',['Container Apps','KEDA 자동 확장 · 내부 DNS','Azure DB for PostgreSQL','VNet 통합 · 비공개 엔드포인트','Blob Storage','Key Vault','관리형 URL · TLS','리비전 트래픽 분할','Azure Monitor · Pyroscope','ACR Tasks (선택: 계정 내 빌드)'])]
for i,(b,ti,sub,c,ls) in enumerate(envs):
    x=340+i*310; y=1110
    arrow(f'M{x+145} 1070 L{x+145} 1106','e-prov')
    a(f'<rect x="{x}" y="{y}" width="290" height="320" rx="14" class="env env-{c}"/>')
    a(f'<rect x="{x+16}" y="{y+16}" width="40" height="24" rx="6" class="bd-{c}"/>')
    t(x+36,y+33,b,'bdt','middle')
    t(x+66,y+34,ti,'ttl'); t(x+16,y+64,sub,'tag')
    for j,l in enumerate(ls):
        yy=y+92+j*21
        a(f'<circle cx="{x+22}" cy="{yy-4}" r="2.5" class="dot-{c}"/>'); t(x+32,yy,l)
card(40,1200,260,100,'앱 사용자',['공개 URL로 접속','모든 환경 동일하게 제공'])
arrow('M300 1250 L336 1250','e-user')

a('<rect x="340" y="1460" width="1220" height="150" rx="14" class="strip"/>')
items=[('IR 중심 이식성','같은 명세 → 환경별 어댑터'),('배포 전략','롤링 · 블루그린 · 카나리 · 자동 롤백'),('관측 자동 구성','OTel 주입 · 프로파일링은 Pyroscope로 통일'),
       ('비용 · AI ROI','토큰 사용량 · 인프라 월 비용 예측'),('데이터 경계','런타임 데이터는 사용자 환경 · LLM 전송 시 비밀값 마스킹'),('확장 경로','무상태 API·워커 + 외부 DB·큐 → 수평 확장')]
for i,(ti,sub) in enumerate(items):
    x=366+(i%3)*406; y=1492+(i//3)*66
    t(x,y,ti,'stt'); t(x,y+24,sub)
a('</svg>')
svg='\n'.join(S)

css='''
:root{--bg:#F6F8FA;--card:#FFFFFF;--line:#D5DBE3;--text:#1C2430;--muted:#5E6B7A;--edge:#7C8896;
--cp-fill:#EFF6F2;--cp-line:#7DB596;--cp-text:#2F7A55;--pool:#9AA7B5;
--ag-fill:#F3F0FD;--ag-line:#A99BE6;--async:#7B61D9;--prov:#D9731A;--user:#2F6FD1;
--pg-f:#EEF3FB;--pg-l:#BCCDEA;--rd-f:#FCEFEE;--rd-l:#EBC0BB;--ob-f:#F2F4F6;--ob-l:#D2D8DF;--vt-f:#FBF4E6;--vt-l:#E4CC9C;--ai-f:#F3F0FD;--ai-l:#CFC5F1;--rg-f:#EEF6F1;--rg-l:#BCDAC8;
--on:#5B6B7F;--obs:#1F9E89;--obs-f:#EAF6F4;--obs-l:#9FD3C8;--aws:#E07A1F;--gcp:#3B7BE0;--az:#1E8FD6;--strip:#FFFFFF}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#12161C;--card:#1B212A;--line:#2E3845;--text:#E6EBF1;--muted:#9AA6B4;--edge:#8391A1;
--cp-fill:#14231C;--cp-line:#4F8F6D;--cp-text:#7FC9A0;--pool:#566273;--ag-fill:#221D38;--ag-line:#6D5DC0;--async:#A08BF0;--prov:#F0913E;--user:#6FA2F0;
--pg-f:#18222F;--pg-l:#34496A;--rd-f:#2A1A1A;--rd-l:#5C3531;--ob-f:#1D232B;--ob-l:#36404C;--vt-f:#2A2418;--vt-l:#5E4E2C;--ai-f:#221D38;--ai-l:#4C4285;--rg-f:#162520;--rg-l:#34594A;--strip:#1B212A;--obs:#4CC3AE;--obs-f:#15272A;--obs-l:#2F6B62}}
:root[data-theme="dark"]{--bg:#12161C;--card:#1B212A;--line:#2E3845;--text:#E6EBF1;--muted:#9AA6B4;--edge:#8391A1;
--cp-fill:#14231C;--cp-line:#4F8F6D;--cp-text:#7FC9A0;--pool:#566273;--ag-fill:#221D38;--ag-line:#6D5DC0;--async:#A08BF0;--prov:#F0913E;--user:#6FA2F0;
--pg-f:#18222F;--pg-l:#34496A;--rd-f:#2A1A1A;--rd-l:#5C3531;--ob-f:#1D232B;--ob-l:#36404C;--vt-f:#2A2418;--vt-l:#5E4E2C;--ai-f:#221D38;--ai-l:#4C4285;--rg-f:#162520;--rg-l:#34594A;--strip:#1B212A;--obs:#4CC3AE;--obs-f:#15272A;--obs-l:#2F6B62}
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
body{margin:0;background:var(--bg);color:var(--text);font-family:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
svg{display:block;width:100%;min-width:1180px;max-width:1800px;margin:0 auto;height:auto;font-family:inherit}
.bg{fill:var(--bg)}
.card{fill:var(--card);stroke:var(--line);stroke-width:1}
.agent{fill:var(--ag-fill);stroke:var(--ag-line);stroke-width:1.5}
.st-pg{fill:var(--pg-f);stroke:var(--pg-l)}.st-rd{fill:var(--rd-f);stroke:var(--rd-l)}.st-ob{fill:var(--ob-f);stroke:var(--ob-l)}
.st-vt{fill:var(--vt-f);stroke:var(--vt-l)}.st-ai{fill:var(--ai-f);stroke:var(--ai-l)}.st-rg{fill:var(--rg-f);stroke:var(--rg-l)}
.cp{fill:var(--cp-fill);stroke:var(--cp-line);stroke-width:1.5;stroke-dasharray:7 6}
.pool{fill:none;stroke:var(--pool);stroke-width:1.2;stroke-dasharray:5 5}
.env{fill:var(--card);stroke-width:1.5}
.env-on{stroke:var(--on)}.env-aws{stroke:var(--aws)}.env-gcp{stroke:var(--gcp)}.env-az{stroke:var(--az)}
.bd-on{fill:var(--on)}.bd-aws{fill:var(--aws)}.bd-gcp{fill:var(--gcp)}.bd-az{fill:var(--az)}
.dot-on{fill:var(--on)}.dot-aws{fill:var(--aws)}.dot-gcp{fill:var(--gcp)}.dot-az{fill:var(--az)}
.strip{fill:var(--strip);stroke:var(--line)}
.h1{font-size:30px;font-weight:700;fill:var(--text)}
.h2{font-size:15px;fill:var(--muted)}
.ttl{font-size:17px;font-weight:700;fill:var(--text)}
.sub{font-size:13px;fill:var(--muted)}
.tag{font-size:12px;fill:var(--muted);font-weight:600}
.cpt{font-size:18px;font-weight:700;fill:var(--cp-text)}
.pt{font-size:13px;font-weight:700;fill:var(--muted)}
.stt{font-size:15px;font-weight:700;fill:var(--cp-text)}
.lbl{font-size:12px;fill:var(--muted);font-weight:600}
.leg{font-size:13px;fill:var(--muted)}
.bdt{font-size:11px;font-weight:700;fill:#fff}
.e-api{stroke:var(--edge);stroke-width:1.4}
.e-async{stroke:var(--async);stroke-width:1.5;stroke-dasharray:5 4}
.e-prov{stroke:var(--prov);stroke-width:1.8}
.e-user{stroke:var(--user);stroke-width:1.8}
.obsc{fill:var(--obs-f);stroke:var(--obs-l)}
.e-obs{stroke:var(--obs);stroke-width:1.6;stroke-dasharray:3 3}
.mk-e-obs{fill:var(--obs)}
.mk-e-api{fill:var(--edge)}.mk-e-async{fill:var(--async)}.mk-e-prov{fill:var(--prov)}.mk-e-user{fill:var(--user)}
'''
html=f'''<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>AI 원클릭 멀티 환경 배포 시스템 · 개략 아키텍처</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;600;700&display=swap" rel="stylesheet">
<style>{css}</style></head><body><div class="wrap">{svg}</div></body></html>'''
open('docs/diagrams/architecture.html','w').write(html)
print('ok')
