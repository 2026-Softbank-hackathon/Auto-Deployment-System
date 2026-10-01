import type {
  AgentControlPlaneClient,
  EcrCredential,
  OnpremAgentJob,
  OnpremExecutionResult,
  TunnelProvider,
  TunnelResult,
  TunnelSession,
  TunnelStartInput,
} from "./contracts.js";

export class FakeControlPlaneClient implements AgentControlPlaneClient {
  readonly reportedResults: OnpremExecutionResult[] = [];
  readonly heartbeats: Array<string | undefined> = [];
  private readonly jobs: OnpremAgentJob[];
  private readonly credentials = new Map<string, EcrCredential>();
  private readonly tunnelSessions = new Map<string, TunnelSession>();
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

  setTunnelSession(jobId: string, session: TunnelSession): void {
    this.tunnelSessions.set(jobId, session);
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

  async prepareTunnel(input: TunnelStartInput): Promise<TunnelSession> {
    const session = this.tunnelSessions.get(input.jobId);
    if (!session) throw new Error("Fake Tunnel session이 없습니다.");
    return session;
  }

  async reportResult(
    _jobId: string,
    result: OnpremExecutionResult,
  ): Promise<void> {
    this.reportedResults.push(result);
  }

  async sendHeartbeat(currentJobId?: string): Promise<{ jobCancelled?: boolean }> {
    this.heartbeats.push(currentJobId);
    return currentJobId && this.cancellations.has(currentJobId)
      ? { jobCancelled: true }
      : {};
  }
}

export class FakeTunnelProvider implements TunnelProvider {
  readonly starts: TunnelStartInput[] = [];
  readonly stops: number[] = [];
  private readonly active = new Set<number>();

  constructor(private readonly endpoint: string) {}

  async start(input: TunnelStartInput): Promise<TunnelResult> {
    this.starts.push(input);
    this.active.add(input.deploymentId);
    return { endpoint: this.endpoint, tunnelId: `fake-${input.deploymentId}` };
  }

  async stop(deploymentId: number): Promise<void> {
    this.stops.push(deploymentId);
    this.active.delete(deploymentId);
  }

  async isRunning(deploymentId: number): Promise<boolean> {
    return this.active.has(deploymentId);
  }
}
