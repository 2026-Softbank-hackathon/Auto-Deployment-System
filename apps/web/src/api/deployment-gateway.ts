/** Transport boundary. Real adapters are added only when API payloads are confirmed. */
export interface DeploymentGateway {
  listProfiles(): Promise<unknown>;
  createDeployment(form: FormData): Promise<unknown>;
}
export const deploymentGateway: DeploymentGateway = {
  async listProfiles() { throw new Error('API adapter is not connected yet.'); },
  async createDeployment() { throw new Error('API adapter is not connected yet.'); },
};
