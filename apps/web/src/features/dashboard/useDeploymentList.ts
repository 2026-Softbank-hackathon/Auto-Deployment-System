import type { ProjectDeploymentSummary } from '../../api/deployment-api';

/** 배포 내역 목록(프로젝트 상세)의 한 줄. 프로젝트 이름을 함께 들고 다닌다. */
export interface DeploymentListItem extends ProjectDeploymentSummary { projectName: string }
