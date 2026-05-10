import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    errorCode: null as string | null,
    summary: "All done.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres transient upstream comment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describeEmbeddedPostgres("heartbeat system comment on claude_transient_upstream", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-transient-upstream-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix the transient upstream bug",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  // Branch A: first failure → retry scheduled, no P1 comment
  it("schedules a 60s retry and suppresses P1 comment on first claude_transient_upstream failure", async () => {
    const { agentId, issueId } = await seedFixture();

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_transient_upstream",
      errorMessage: "Claude API overloaded (transient)",
      summary: null,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    const heartbeat = heartbeatService(db);
    const before = Date.now();
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    await waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running");
    });

    // No P1 system comment on first failure
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    // A scheduled_retry run must exist with attempt=1 and ~60s delay
    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "scheduled_retry"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(retryRun).not.toBeNull();
    expect(retryRun?.scheduledRetryAttempt).toBe(1);
    const dueAt = retryRun?.scheduledRetryAt?.getTime() ?? 0;
    expect(dueAt).toBeGreaterThanOrEqual(before + 55_000);
    expect(dueAt).toBeLessThanOrEqual(before + 65_000);
  });

  // Branch B: retry run (attempt=1) also fails → P1 system comment emitted
  it("emits P1 system comment when the scheduled retry run also fails with claude_transient_upstream", async () => {
    const { agentId, issueId } = await seedFixture();

    // Stage 1: first failure → creates the scheduled_retry run
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_transient_upstream",
      errorMessage: "Claude API overloaded (transient)",
      summary: null,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    await waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running");
    });

    const retryRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "scheduled_retry"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(retryRun).not.toBeNull();

    // Stage 2: make the retry run due now and execute it (fails again)
    const now = new Date();
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: new Date(now.getTime() - 1_000), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryRun!.id));

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "claude_transient_upstream",
      errorMessage: "Claude API overloaded (transient)",
      summary: null,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });

    await heartbeat.promoteDueScheduledRetries(now);
    await heartbeat.resumeQueuedRuns();

    await waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running");
    });

    // P1 comment must be emitted after retry exhaustion
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      authorAgentId: null,
      authorUserId: null,
      createdByRunId: null,
    });
    expect(comments[0]?.body).toContain("claude_transient_upstream");
    expect(comments[0]?.body).toContain("adapter_failed");
    expect(comments[0]?.body).toContain("ClaudeCoder");
  });

  // Branch C: non-transient failure → no retry, no comment (existing behavior unchanged)
  it("does not schedule a retry or insert a comment for non-transient failures", async () => {
    const { agentId, issueId } = await seedFixture();

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorMessage: "Internal adapter error",
      summary: null,
      provider: "test",
      model: "test-model",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    await waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running");
    });

    const scheduledRetryRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "scheduled_retry"));
    expect(scheduledRetryRuns).toHaveLength(0);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  // Branch D (guard): agent already posted a comment during the retry run → no system comment
  it("skips system comment when agent already posted a comment during the run", async () => {
    const { agentId, issueId, companyId } = await seedFixture();

    // Use a gate to pause adapter execution while we seed the pre-existing comment.
    let releaseGate!: () => void;
    const adapterGate = new Promise<void>((resolve) => { releaseGate = resolve; });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await adapterGate;
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "claude_transient_upstream",
        errorMessage: "Claude API overloaded (transient)",
        summary: null,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      };
    });

    const heartbeat = heartbeatService(db);
    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    if (queuedRun) {
      // Wait until the run is "running" (adapter has started but is blocked at gate).
      await waitFor(async () => {
        const [run] = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queuedRun.id));
        return run?.status === "running";
      });

      // Seed a comment linked to this run to simulate the agent having commented.
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: queuedRun.id,
        body: "I've started working on this but hit an upstream issue.",
      });
    }

    // Release the adapter gate so the run can complete.
    releaseGate();

    await waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return runs.length > 0 && runs.every((r) => r.status !== "queued" && r.status !== "running");
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

    // Only the pre-existing agent comment; no system comment inserted
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorAgentId).toBe(agentId);
  });
});
