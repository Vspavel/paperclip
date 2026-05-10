import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

  it("inserts a system comment when agent posts no comment during a claude_transient_upstream run", async () => {
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
