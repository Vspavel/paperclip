export function shouldInsertTransientFailureComment(
  livenessReason: string | null | undefined,
  postedComment: { id: string } | null | undefined,
): boolean {
  return livenessReason === "claude_transient_upstream" && !postedComment;
}

export function buildTransientFailureCommentBody(runId: string, agentName: string): string {
  return `Run ${runId} ended with adapter_failed (claude_transient_upstream). Issue returned to todo. Assignee: ${agentName}.`;
}
