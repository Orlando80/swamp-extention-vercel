/** Read-only preview audit. Candidates always require review before deletion. */
export async function audit(config, request = fetch, now = Date.now()) {
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
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`API request failed: HTTP ${response.status}`);
    }
    return response.json();
  }
  const rows = [];
  const seen = new Set();
  const prs = new Map();
  let until;
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://api.vercel.com/v6/deployments");
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("limit", "100");
    if (teamId) url.searchParams.set("teamId", teamId);
    if (until !== undefined) url.searchParams.set("until", String(until));
    const batch = await get(url, vercelToken);
    if (!Array.isArray(batch.deployments)) {
      throw new Error("Invalid deployment response");
    }
    for (const d of batch.deployments) {
      if (!d.uid || seen.has(d.uid)) continue;
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
      } else if (d.target != null && d.target !== "preview") {
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
            pr.base?.repo?.full_name?.toLowerCase() !==
              repository.toLowerCase() || String(pr.number) !== number
          ) throw new Error("PR identity mismatch");
          if (pr.state === "open") {
            row.decision = "keep";
            row.reason = "Pull request is open";
          } else if (pr.state === "closed") {
            const closed = Date.parse(pr.closed_at);
            const created = d.createdAt ?? d.created;
            if (
              Number.isFinite(closed) && Number.isFinite(created) &&
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
        } catch {
          row.reason = "PR lookup failed or returned inconsistent evidence";
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
