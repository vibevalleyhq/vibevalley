import { expect, test } from "vite-plus/test";

import { planRelease } from "./release-plan";

const tagged = (stage: "alpha" | "beta" | "final", tags: string[], branch: string) => {
  const p = planRelease(stage, tags, branch);
  return p.ok ? [p.plan.tag, p.plan.branch, p.plan.cut, p.plan.schemaSince] : p.why;
};

test("alphas count up on main towards the version main is working on", () => {
  expect(tagged("alpha", [], "main")).toEqual(["v0.1.0-alpha.1", "main", false, undefined]);
  expect(tagged("alpha", ["v0.4.0-alpha.1", "v0.4.0-alpha.9", "v0.4.0-alpha.10"], "main")).toEqual(["v0.4.0-alpha.11", "main", false, undefined]);
  // Once 0.4 has a beta, main is working on 0.5.
  expect(tagged("alpha", ["v0.4.0-alpha.2", "v0.4.0-beta.1"], "main")).toEqual(["v0.5.0-alpha.1", "main", false, undefined]);
  expect(tagged("alpha", ["v0.4.0", "v0.4.1"], "main")).toEqual(["v0.5.0-alpha.1", "main", false, undefined]);
});

test("the first beta cuts release/x.y from main; later betas and the release are tagged on it, the farm kept", () => {
  expect(tagged("beta", ["v0.4.0-alpha.3"], "main")).toEqual(["v0.4.0-beta.1", "release/0.4", true, undefined]);
  const line = ["v0.4.0-alpha.3", "v0.4.0-beta.1", "v0.5.0-alpha.1"];
  expect(tagged("beta", line, "release/0.4")).toEqual(["v0.4.0-beta.2", "release/0.4", false, "v0.4.0-beta.1"]);
  expect(tagged("final", [...line, "v0.4.0-beta.2"], "release/0.4")).toEqual(["v0.4.0", "release/0.4", false, "v0.4.0-beta.1"]);
  // After the release, a fix is the next patch's beta, then its release.
  expect(tagged("beta", [...line, "v0.4.0"], "release/0.4")).toEqual(["v0.4.1-beta.1", "release/0.4", false, "v0.4.0-beta.1"]);
  expect(tagged("final", [...line, "v0.4.0", "v0.4.1-beta.1"], "release/0.4")).toEqual(["v0.4.1", "release/0.4", false, "v0.4.0-beta.1"]);
});

test("a stage on the wrong branch, a release with no beta before it and one twice are refused, saying how", () => {
  expect(tagged("alpha", [], "release/0.4")).toMatch(/^alphas are tagged on main.*Fix: git switch main$/u);
  expect(tagged("final", ["v0.4.0-alpha.1"], "main")).toMatch(/release\/x\.y branch.*Fix:/u);
  expect(tagged("beta", ["v0.4.0-alpha.1"], "release/0.4")).toMatch(/no beta yet.*Fix: on main/u);
  expect(tagged("final", ["v0.4.0-beta.1", "v0.4.0"], "release/0.4")).toMatch(/released already.*0\.4\.1/u);
  expect(tagged("final", ["v0.4.0-beta.1", "v0.4.0", "v0.4.1-alpha.1"], "release/0.4")).toMatch(/follows a beta/u);
});
