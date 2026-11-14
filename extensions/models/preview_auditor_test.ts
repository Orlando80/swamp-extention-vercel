import assert from "node:assert/strict";
import { model } from "./preview_auditor.ts";

Deno.test("scan writes a schema-valid report and returns its handle", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ deployments: [], pagination: { next: null } }),
    );
  const writes: unknown[] = [];
  const logs: unknown[] = [];
  try {
    const result = await model.methods.scan.execute({}, {
      logger: {
        info(...args) {
          logs.push(args);
        },
      },
      globalArgs: {
        projectId: "prj_test",
        repository: "demo/app",
        vercelToken: "fake",
        githubToken: "fake",
      },
      writeResource(spec, name, report) {
        model.resources.report.schema.parse(report);
        writes.push({ spec, name, report });
        return Promise.resolve({ name });
      },
    });
    assert.equal(writes.length, 1);
    assert.equal(logs.length, 2);
    assert.equal(JSON.stringify(logs).includes("fake"), false);
    assert.deepEqual(result, { dataHandles: [{ name: "latest" }] });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("scan propagates API failure without writing a success report", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(null, { status: 403 }));
  try {
    await assert.rejects(() =>
      model.methods.scan.execute({}, {
        globalArgs: {
          projectId: "prj_test",
          repository: "demo/app",
          vercelToken: "fake",
          githubToken: "fake",
        },
        writeResource() {
          throw new Error("Unexpected write");
        },
      }), /HTTP 403/);
  } finally {
    globalThis.fetch = original;
  }
});
