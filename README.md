# Preview auditor — Vercel + GitHub

A Swamp extension that reads Vercel deployments and checks linked GitHub pull requests. It writes a structured report with `keep`, `review`, or `candidate` decisions. It does not delete anything.

## Policy

Default grace period: 72 hours after BOTH deployment creation and PR closure. Production and in-progress deployments are kept; custom environments, missing metadata, failed PR lookups and inconsistent evidence require review. An open PR is kept. Scans are bounded to 10 pages of 100 deployments by default; `complete: false` means the inventory was truncated.

Candidates are suggestions for human review, not proof that deletion is safe. Alias usage, promotions, rollback requirements, branch reuse and metadata authenticity are not verified. PR linkage requires Vercel metadata `githubCommitOrg`, `githubCommitRepo` and `githubPrId`; deployments without those fields remain review items. Age alone never creates a candidate.

## Configure

From this directory, create a Swamp vault and enter tokens interactively:

```sh
swamp vault create local_encryption audit
swamp vault put audit vercel-token
swamp vault put audit github-token
```

Use a Vercel token with access to the project and a GitHub token with read access to the repository's pull requests. Do not put tokens in chat or source files.

Create the auditor, replacing the project ID and repository. Add `--global-arg teamId=team_...` for a Vercel team project:

```sh
swamp behavior create @local/preview-auditor preview-audit \
  --global-arg projectId=prj_REPLACE \
  --global-arg repository=OWNER/REPO \
  --global-arg 'vercelToken=${{ vault.get("audit", "vercel-token") }}' \
  --global-arg 'githubToken=${{ vault.get("audit", "github-token") }}'
swamp behavior run preview-audit scan --json
```

The report is stored as the `report` resource, instance `latest`, with 30-day lifetime. API requests have a 30-second timeout, do not follow redirects and never include tokens in reports. Rate-limit and API failures are not retried automatically.

## Validation

```sh
node --test audit.test.mjs
swamp model type describe @local/preview-auditor --json
swamp extension fmt manifest.yaml --check
```

Eight offline tests cover candidate detection, production protection, open PRs, grace periods, missing metadata, repository mismatch, incomplete pagination and HTTP failures. Swamp successfully loads the behavior and its schemas. A live account scan is still required before operational use.

## Publishing

Use your Swamp collective consistently in the manifest, model and commands above. Add your source repository, then run Swamp's quality and publishing dry-run checks.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Orlando Perri.

References:
- https://swamp-club.com/manual/reference/extensions/behavior
- https://vercel.com/docs/rest-api
- https://docs.github.com/en/rest/pulls/pulls
