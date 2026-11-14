import { z } from "npm:zod@4";
import { audit } from "./audit_core.ts";
/** Local draft namespace; replace before publishing. */
export const model = {
  type: "@orlando/preview-auditor",
  version: "2026.11.14.1",
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
        const report = await audit(context.globalArgs);
        const handle = await context.writeResource("report", "latest", report);
        return { dataHandles: [handle] };
      },
    },
  },
};
