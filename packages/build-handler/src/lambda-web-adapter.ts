/**
 * AWS Lambda Web Adapter (https://github.com/awslabs/aws-lambda-web-adapter)
 *
 * 모든 빌드 이미지의 마지막 레이어로 /opt/extensions/lambda-adapter 를 넣는다.
 * Lambda 는 /opt/extensions 의 실행 파일을 확장으로 띄우고, 이 확장이 Lambda 이벤트를
 * 컨테이너 안 웹 앱(AWS_LWA_PORT, 없으면 PORT)에 HTTP 요청으로 넘긴다.
 * Lambda 밖(ECS · 온프레미스)에서는 아무도 실행하지 않는 파일이라 앱 동작이 그대로이고,
 * 같은 digest 하나를 ECS · Lambda · 온프레미스가 함께 쓴다.
 * 버전은 태그와 multi-arch index digest 로 고정한다 (빌드 플랫폼에 맞는 바이너리를 고른다).
 */
export const LAMBDA_WEB_ADAPTER_VERSION = "1.1.0";

export const LAMBDA_WEB_ADAPTER_IMAGE =
  `public.ecr.aws/awsguru/aws-lambda-adapter:${LAMBDA_WEB_ADAPTER_VERSION}` +
  "@sha256:17cfd08eff1dfea3f6a9a1e9c65fdac80aa4919b6085e746615530f43f57d2f1";

export const LAMBDA_WEB_ADAPTER_PATH = "/opt/extensions/lambda-adapter";

export const LAMBDA_WEB_ADAPTER_COPY =
  `COPY --from=${LAMBDA_WEB_ADAPTER_IMAGE} /lambda-adapter ${LAMBDA_WEB_ADAPTER_PATH}`;
