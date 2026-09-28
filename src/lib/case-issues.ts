export function getPersistedCaseIssues<T>(
  issues: T[] | null | undefined,
): T[] {
  return issues ?? [];
}

export function getPersistedCaseIssueCount(
  issues: readonly unknown[] | null | undefined,
) {
  return issues?.length ?? 0;
}
