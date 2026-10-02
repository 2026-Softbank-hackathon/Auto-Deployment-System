# sample-static-site — 정적 사이트 데모 앱

서버 코드 없는 HTML · CSS · JS 페이지입니다. 분석기가 루트 `index.html`을 보고 정적 사이트(static)로 감지하고, 빌드 단계에서 이 파일들을 담은 nginx 이미지 하나를 만듭니다. 같은 이미지(같은 digest)를 온프레미스에서는 컨테이너로 실행하고, AWS에서는 이미지에서 파일을 꺼내 S3 웹사이트 호스팅으로 서빙합니다(서버 없음).

## 화면

- 큰 버전 표시(`version.js`의 `SITE_VERSION`, v1 파랑 · v2 초록)
- SERVED BY: 응답에 S3 헤더(`x-amz-request-id`)가 있으면 `AWS S3 웹사이트 (서버 없음)`, 없으면 `nginx 컨테이너`
- 3초마다 `version.js`를 다시 읽어 버전이 바뀌면 스스로 새로고침합니다

## 데모 (v1 → v2, 환경 전환)

1. 이 폴더 안의 파일을 zip으로 묶어 올립니다(폴더째가 아니라 내용물). 예: PowerShell `Compress-Archive -Path apps/samples/static-site/* -DestinationPath static-site-v1.zip`
2. `version.js`의 `"v1"`을 `"v2"`로 바꾸고 다시 묶어 같은 프로젝트에 올리면 v1 → v2 갱신입니다.
3. 재배포에서 대상 환경을 바꾸면 같은 이미지로 온프레미스 ↔ AWS를 오갑니다. AWS로 가면 프로필이 `aws-static-basic`으로 자동 선택됩니다.

해시가 없는 파일은 `Cache-Control: no-cache`로 서빙돼서 재배포한 내용이 Cloudflare 캐시에 가려지지 않습니다.

## 로컬 확인

빌드 도구가 없어서 아무 정적 서버로 열면 됩니다. 예: `npx serve .`
