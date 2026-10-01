export type AwsAccessKeyCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type EcrRepository = {
  name: string;
  repositoryUri: string;
  registryUri: string;
  registryId?: string;
  arn?: string;
};

/**
 * ECR authorization password는 AWS가 정한 만료 시각까지 유효하다.
 * 호출자는 메모리에서만 사용하고 DB, job payload, 로그에 저장하면 안 된다.
 */
export type EcrAuthorization = {
  registryUri: string;
  username: "AWS";
  password: string;
  expiresAt: string;
};
