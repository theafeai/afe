/**
 * Commit comparison (AFE-22): is commit X included in commit L?
 *
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` reports how `head`
 * relates to `base`:
 *
 * | status      | meaning                                             | X (base) contained in L (head)? |
 * | ----------- | --------------------------------------------------- | ------------------------------- |
 * | `identical` | same commit                                         | yes                             |
 * | `ahead`     | head has commits base lacks; base is an ancestor    | yes                             |
 * | `behind`    | head is an ancestor of base (L is older than X)     | no                              |
 * | `diverged`  | both have commits the other lacks                   | no                              |
 *
 * So X is contained in the live commit L iff compare(X, L).status is
 * `ahead` or `identical`. Ancestry never changes for a pair of commit SHAs,
 * so a result can be cached forever (until the commits are garbage
 * collected after a force-push, after which GitHub answers 404).
 *
 * Permission: the endpoint needs the repository permission `contents: read`
 * for GitHub Apps. Afe treats it as optional (OPTIONAL_READ_PERMISSIONS):
 * without it the answer is "unknown" with the reason.
 * https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */

/** Repository permission the compare endpoint needs (read). */
export const COMPARE_PERMISSION = "contents" as const;

export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

const STATUSES: ReadonlySet<string> = new Set(["ahead", "behind", "identical", "diverged"]);

/** What Afe keeps of a comparison (no commit messages, authors or files). */
export interface CommitComparison {
  status: CompareStatus;
  /** Commits in head that base lacks. */
  aheadBy: number;
  /** Commits in base that head lacks. */
  behindBy: number;
  /** Full SHA of the merge base, when GitHub sent it. */
  mergeBaseSha: string | null;
}

/** Response of the compare endpoint (only the fields Afe reads). */
export interface GitHubCompareResponse {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  base_commit?: { sha?: string } | null;
  merge_base_commit?: { sha?: string } | null;
}

/** A commit SHA or abbreviated SHA the compare path accepts (hex, 7 to 64). */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value);
}

/** Validates and narrows a compare response. Throws on an unexpected status. */
export function parseComparison(data: GitHubCompareResponse | null | undefined): CommitComparison {
  const status = data?.status;
  if (typeof status !== "string" || !STATUSES.has(status)) {
    throw new Error(`unexpected compare status ${JSON.stringify(status ?? null)}`);
  }
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  const mb = data?.merge_base_commit?.sha;
  return {
    status: status as CompareStatus,
    aheadBy: count(data?.ahead_by),
    behindBy: count(data?.behind_by),
    mergeBaseSha: typeof mb === "string" && /^[0-9a-f]{40,64}$/.test(mb) ? mb : null,
  };
}

/** Whether `base` is contained in `head`, from compare(base, head).status. */
export function isContainedStatus(status: CompareStatus): boolean {
  return status === "ahead" || status === "identical";
}
