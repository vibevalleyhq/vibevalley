import { expect, test } from "vite-plus/test";

import { checksVerdict } from "./github.ts";

const check = (status: string, conclusion = "") => ({ name: status + conclusion, status, conclusion });

test("a pull request's checks: the failed ones, and whether all have finished", () => {
  expect(checksVerdict([])).toEqual({ failed: [], finished: false });
  expect(checksVerdict([check("IN_PROGRESS"), check("COMPLETED", "SUCCESS")])).toEqual({ failed: [], finished: false });
  expect(checksVerdict([check("COMPLETED", "SUCCESS"), check("success")])).toEqual({ failed: [], finished: true });
  const failed = check("COMPLETED", "failure");
  expect(checksVerdict([failed, check("QUEUED")])).toEqual({ failed: [failed], finished: false });
  expect(checksVerdict([check("TIMED_OUT")]).failed).toHaveLength(1);
});
