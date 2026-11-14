import { z } from "npm:zod@4";
import { audit } from "./audit_core.ts";
/** Read-only Vercel preview auditor for the @orlando collective. */
export const model = {
  type: "@orlando/preview-auditor",
  version: "2026.11.14.3",
  upgrades: [
    {
      toVersion: "2026.11.14.2",
      description:
        "Package README and LICENSE; preserve existing configuration",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.14.3",
      description:
        "Use the audit report instance name; preserve existing configuration",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: z.object({
    projectId: z.string().min(1),
    teamId: z.string().optional(),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    vercelToken: z.string().min(1).meta({ sensitive: true }),
    githubToken: z.string().min(1).meta({ sensitive: true }),
    graceHours: z.number().nonnegative().default(72),
    maxPages: z.number().int().min(1).max(100).default(10),
  }),
  resources: {
    report: {
      description:
        "Read-only cleanup candidates; incomplete inventories are explicitly marked",
      schema: z.object({
        generatedAt: z.string(),
        projectId: z.string(),
        repository: z.string(),
        graceHours: z.number(),
        complete: z.boolean(),
        candidates: z.number(),
        deployments: z.array(
          z.object({
            id: z.string(),
            url: z.string().nullable(),
            decision: z.enum(["keep", "review", "candidate"]),
            reason: z.string(),
          }),
        ),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    scan: {
      description:
        "Inspect Vercel deployments and linked GitHub PRs without modifying either service",
      arguments: z.object({}),
      async execute(_args, context) {
        context.logger?.info("Starting preview audit");
        const report = await audit(
          context.globalArgs,
          fetch,
          Date.now(),
          context.signal,
        );
        context.signal?.throwIfAborted();
        const handle = await context.writeResource("report", "audit", report);
        context.logger?.info(
          "Preview audit completed: {count} deployments, {candidates} candidates, complete={complete}",
          {
            count: report.deployments.length,
            candidates: report.candidates,
            complete: report.complete,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
