const test = Deno.test;
import assert from "node:assert/strict";
import { audit } from "./audit_core.ts";
const now = Date.parse("2026-11-14T12:00:00Z");
const config = {
  projectId: "prj_demo",
  repository: "demo/app",
  vercelToken: "fake",
  githubToken: "fake",
};
const deployment = {
  uid: "d1",
  created: now - 10 * 86400000,
  target: null,
  meta: { githubCommitOrg: "demo", githubCommitRepo: "app", githubPrId: "1" },
};
function mock(ds, pr, next: number | null = null) {
  return (url) =>
    Promise.resolve(Response.json(
      String(url).includes("api.vercel.com")
        ? { deployments: ds, pagination: { next } }
        : pr,
    ));
}
const closed = {
  number: 1,
  state: "closed",
  closed_at: "2026-11-01T00:00:00Z",
  base: { repo: { full_name: "demo/app" } },
};
test("closed PR beyond grace is a candidate", async () =>
  assert.equal(
    (await audit(config, mock([deployment], closed), now)).candidates,
    1,
  ));
test("production remains protected", async () =>
  assert.equal(
    (await audit(
      config,
      mock([{ ...deployment, target: "production" }], closed),
      now,
    )).deployments[0].decision,
    "keep",
  ));
test("open PR remains protected", async () =>
  assert.equal(
    (await audit(config, mock([deployment], { ...closed, state: "open" }), now))
      .candidates,
    0,
  ));
test("recent closure stays in grace period", async () =>
  assert.equal(
    (await audit(
      config,
      mock([deployment], {
        ...closed,
        closed_at: new Date(now - 3600000).toISOString(),
      }),
      now,
    )).candidates,
    0,
  ));
test("missing metadata needs review", async () =>
  assert.equal(
    (await audit(config, mock([{ ...deployment, meta: {} }], closed), now))
      .deployments[0].decision,
    "review",
  ));
test("wrong repository cannot qualify", async () =>
  assert.equal(
    (await audit(
      config,
      mock([deployment], {
        ...closed,
        base: { repo: { full_name: "other/app" } },
      }),
      now,
    )).candidates,
    0,
  ));
test("page cap marks incomplete inventory", async () =>
  assert.equal(
    (await audit(
      { ...config, maxPages: 1 },
      mock([deployment], closed, 100),
      now,
    )).complete,
    false,
  ));
test("API failure rejects report", () =>
  assert.rejects(() =>
    audit(
      config,
      () => Promise.resolve(new Response(null, { status: 403 })),
      now,
    )
  ));

for (
  const bad of [
    null,
    {},
    { deployments: [] },
    { deployments: [], pagination: {} },
    { deployments: [], pagination: { next: "bad" } },
    { deployments: [null], pagination: { next: null } },
  ]
) {
  test(`rejects malformed inventory ${JSON.stringify(bad)}`, () =>
    assert.rejects(() =>
      audit(config, () => Promise.resolve(Response.json(bad)), now)
    ));
}
for (const status of [403, 404, 429, 503]) {
  test(`PR HTTP ${status} is classified without leaking body or token`, async () => {
    let cancelled = false;
    const result = await audit(
      config,
      (url) =>
        Promise.resolve(
          String(url).includes("api.vercel.com")
            ? Response.json({
              deployments: [deployment],
              pagination: { next: null },
            })
            : new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              { status },
            ),
        ),
      now,
    );
    assert.equal(cancelled, true);
    assert.equal(result.deployments[0].decision, "review");
    assert.match(result.deployments[0].reason, new RegExp(`HTTP ${status}`));
    assert.equal(JSON.stringify(result).includes(config.githubToken), false);
  });
}
test("cancellation interrupts GitHub lookup rather than becoming review", async () => {
  const controller = new AbortController();
  await assert.rejects(() =>
    audit(
      config,
      (url, options) => {
        if (String(url).includes("api.vercel.com")) {
          return Promise.resolve(
            Response.json({
              deployments: [deployment],
              pagination: { next: null },
            }),
          );
        }
        controller.abort();
        assert.equal(options?.signal?.aborted, true);
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      },
      now,
      controller.signal,
    ), { name: "AbortError" });
});
test("rejects repeated pagination cursor", () =>
  assert.rejects(
    () => audit(config, mock([], closed, 100), now),
    /pagination cursor/,
  ));
test("invalid PR JSON stays review", async () => {
  const report = await audit(
    config,
    (url) =>
      Promise.resolve(
        String(url).includes("api.vercel.com")
          ? Response.json({
            deployments: [deployment],
            pagination: { next: null },
          })
          : new Response("bad json"),
      ),
    now,
  );
  assert.match(report.deployments[0].reason, /not valid JSON/);
});
