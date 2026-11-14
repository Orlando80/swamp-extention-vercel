/** Read-only preview audit. Candidates always require review before deletion. */
class AuditError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function audit(
  config,
  request = fetch,
  now = Date.now(),
  signal?: AbortSignal,
) {
  const { projectId, teamId, repository, vercelToken, githubToken } = config;
  if (!projectId || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Project and owner/repository are required");
  }
  const graceHours = config.graceHours ?? 72;
  const maxPages = config.maxPages ?? 10;
  if (
    !Number.isFinite(graceHours) || graceHours < 0 ||
    !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100
  ) throw new Error("Invalid policy bounds");
  async function get(url, token) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await request(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: requestSignal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new AuditError(
        timeout.aborted
          ? "API request timed out"
          : "API network request failed",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint = response.status === 429
        ? "rate limited; rerun after the provider's Retry-After interval"
        : response.status === 403
        ? "access denied or provider rate limit; check permissions and quota"
        : response.status === 404
        ? "not found or not accessible"
        : "provider request rejected";
      throw new AuditError(
        `API request failed: HTTP ${response.status} (${hint})`,
      );
    }
    try {
      const value = await response.json();
      signal?.throwIfAborted();
      return value;
    } catch {
      signal?.throwIfAborted();
      throw new AuditError(
        timeout.aborted
          ? "API response timed out"
          : "API response is not valid JSON",
      );
    }
  }
  const rows: {
    id: string;
    url: string | null;
    decision: string;
    reason: string;
  }[] = [];
  const seen = new Set();
  const prs = new Map();
  let until;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://api.vercel.com/v7/deployments");
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("limit", "100");
    if (teamId) url.searchParams.set("teamId", teamId);
    if (until !== undefined) url.searchParams.set("until", String(until));
    const batch = await get(url, vercelToken);
    if (
      !object(batch) || !Array.isArray(batch.deployments) ||
      !object(batch.pagination) || !("next" in batch.pagination) ||
      (batch.pagination.next !== null &&
        (!Number.isSafeInteger(batch.pagination.next) ||
          batch.pagination.next < 0))
    ) {
      throw new Error("Invalid deployment response");
    }
    for (const d of batch.deployments) {
      signal?.throwIfAborted();
      if (
        !object(d) || typeof d.uid !== "string" || !d.uid ||
        (d.url != null && typeof d.url !== "string") ||
        (d.target != null && typeof d.target !== "string") ||
        (d.meta != null && !object(d.meta)) ||
        (d.state != null && typeof d.state !== "string") ||
        (d.readyState != null && typeof d.readyState !== "string")
      ) {
        throw new AuditError("Malformed Vercel deployment record");
      }
      if (seen.has(d.uid)) continue;
      seen.add(d.uid);
      const row = {
        id: d.uid,
        url: d.url ?? null,
        decision: "review",
        reason: "Missing or ambiguous PR evidence",
      };
      const meta = d.meta ?? {};
      if (d.target === "production") {
        row.decision = "keep";
        row.reason = "Production deployment";
      } else if (
        d.customEnvironment != null ||
        (d.target != null && d.target !== "preview")
      ) {
        row.reason = "Custom environment";
      } else if (
        ["BUILDING", "QUEUED", "INITIALIZING"].includes(d.state ?? d.readyState)
      ) {
        row.decision = "keep";
        row.reason = "Deployment in progress";
      } else if (
        `${meta.githubCommitOrg}/${meta.githubCommitRepo}`.toLowerCase() ===
          repository.toLowerCase() &&
        /^[1-9][0-9]*$/.test(String(meta.githubPrId))
      ) {
        const number = String(meta.githubPrId);
        try {
          if (!prs.has(number)) {
            prs.set(
              number,
              await get(
                `https://api.github.com/repos/${repository}/pulls/${number}`,
                githubToken,
              ),
            );
          }
          const pr = prs.get(number);
          if (
            !object(pr) || !object(pr.base) || !object(pr.base.repo) ||
            typeof pr.base.repo.full_name !== "string" ||
            !["open", "closed"].includes(pr.state) ||
            (pr.state === "closed" &&
              (typeof pr.closed_at !== "string" ||
                !Number.isFinite(Date.parse(pr.closed_at)))) ||
            pr.base.repo.full_name.toLowerCase() !==
              repository.toLowerCase() ||
            String(pr.number) !== number
          ) {
            throw new AuditError(
              "Malformed PR response or PR identity mismatch",
            );
          }
          if (pr.state === "open") {
            row.decision = "keep";
            row.reason = "Pull request is open";
          } else if (pr.state === "closed") {
            const closed = Date.parse(pr.closed_at);
            const created = d.createdAt ?? d.created;
            if (
              Number.isFinite(closed) && Number.isSafeInteger(created) &&
              created >= 0 &&
              created <= now && closed <= now
            ) {
              if (now - Math.max(closed, created) >= graceHours * 3600000) {
                row.decision = "candidate";
                row.reason =
                  "Closed PR and grace period elapsed; verify aliases, promotions and rollback needs before cleanup";
              } else {
                row.decision = "keep";
                row.reason = "Within grace period";
              }
            }
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof AuditError)) throw error;
          row.reason = `PR lookup needs review: ${error.message}`;
        }
      }
      rows.push(row);
    }
    const next = batch.pagination?.next;
    if (next == null) {
      complete = true;
      break;
    }
    if (!Number.isFinite(next) || (until !== undefined && next >= until)) {
      throw new Error("Invalid pagination cursor");
    }
    until = next;
  }
  signal?.throwIfAborted();
  return {
    generatedAt: new Date(now).toISOString(),
    projectId,
    repository,
    graceHours,
    complete,
    candidates: rows.filter((r) => r.decision === "candidate").length,
    deployments: rows,
  };
}
