import type {
  AgentControlPlaneClient,
  EcrCredential,
  OnpremAgentJob,
  OnpremExecutionResult,
  TunnelProvider,
  TunnelResult,
  TunnelStartInput,
} from "./contracts.js";

export class FakeControlPlaneClient implements AgentControlPlaneClient {
  readonly reportedResults: OnpremExecutionResult[] = [];
  heartbeatCount = 0;
  private readonly jobs: OnpremAgentJob[];
  private readonly credentials = new Map<string, EcrCredential>();
  private readonly cancellations = new Set<string>();

  constructor(jobs: OnpremAgentJob[] = []) {
    this.jobs = [...jobs];
  }

  enqueue(job: OnpremAgentJob): void {
    this.jobs.push(job);
  }

  setEcrCredential(jobId: string, credential: EcrCredential): void {
    this.credentials.set(jobId, credential);
  }

  cancel(jobId: string): void {
    this.cancellations.add(jobId);
  }

  async claimJob(): Promise<OnpremAgentJob | null> {
    return this.jobs.shift() ?? null;
  }

  async getEcrCredential(jobId: string): Promise<EcrCredential> {
    const credential = this.credentials.get(jobId);
    if (!credential) throw new Error("Fake ECR credential이 없습니다.");
    return credential;
  }

  async isJobCancelled(jobId: string): Promise<boolean> {
    return this.cancellations.has(jobId);
  }

  async reportResult(
    _jobId: string,
    result: OnpremExecutionResult,
  ): Promise<void> {
    this.reportedResults.push(result);
  }

  async sendHeartbeat(): Promise<void> {
    this.heartbeatCount += 1;
  }
}

export class FakeTunnelProvider implements TunnelProvider {
  readonly starts: TunnelStartInput[] = [];
  readonly stops: number[] = [];

  constructor(private readonly endpoint: string) {}

  async start(input: TunnelStartInput): Promise<TunnelResult> {
    this.starts.push(input);
    return { endpoint: this.endpoint, tunnelId: `fake-${input.deploymentId}` };
  }

  async stop(deploymentId: number): Promise<void> {
    this.stops.push(deploymentId);
  }
}
