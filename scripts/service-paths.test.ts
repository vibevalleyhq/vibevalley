import { describe, expect, test } from "vite-plus/test";

import { edgesOf, fanInOf, fanInProblems, pathProblems } from "./service-paths.ts";

const files = [
  { path: "apps/server/src/session/session.ts", text: "export class Session extends Context.Service<Session, {}>()('x') {}" },
  { path: "apps/server/src/infra/db.ts", text: "export class Db extends Context.Service<Db, {}>()('x') {}" },
  {
    path: "apps/server/src/mailbox/mailbox.ts",
    text: "const make = Effect.gen(function* () { const sessions = yield* Session; const db = yield* Db; sessions.hire(); db.run(); });",
  },
  { path: "apps/server/src/session/launch.ts", text: "const s = Effect.gen(function* () { const own = yield* Session; own.hire(); });" },
  { path: "apps/server/src/http/handlers/session.ts", text: "const h = Effect.gen(function* () { const s = yield* Session; s.list(); });" },
  { path: "apps/server/src/issue/issue.test.ts", text: "const t = Effect.gen(function* () { const s = yield* Session; s.dismiss(); });" },
];

describe("the service path table", () => {
  test("counts another module's use of a service member, not its own module, the ground, the handlers or the tests", () => {
    expect(edgesOf(files)).toEqual({ "Session.hire": ["mailbox"] });
  });

  test("a new caller of a member is a new path and fails, naming today's callers", () => {
    const problems = pathProblems({ "Session.hire": ["mailbox"] }, { "Session.hire": ["channel", "mailbox"] });
    expect(problems).toEqual([expect.stringMatching(/^channel now uses Session\.hire.*Fix: .*today: mailbox.*See /u)]);
  });

  test("a path gone fails until the table is written down", () => {
    expect(pathProblems({ "Session.hire": ["mailbox"] }, {})).toEqual([expect.stringMatching(/mailbox no longer uses Session\.hire.*paths:write/u)]);
  });

  test("counts service fan-in across modules including http and rejects new single-caller services", () => {
    expect(fanInOf(files)).toEqual({ Session: ["http", "mailbox"] });
    expect(fanInProblems({ Session: ["http", "mailbox"], Storage: ["attachment"] }, new Set())).toEqual([
      expect.stringMatching(/^Storage has only one \(attachment\) caller module/u),
    ]);
    expect(fanInProblems({ Machine: ["session"] }, new Set(["Machine"]))).toEqual([]);
    expect(fanInProblems({ Machine: ["repo", "session"] }, new Set(["Machine", "Storage"]))).toEqual([
      expect.stringMatching(/^Machine now has 2 caller modules/u),
      expect.stringMatching(/^Storage is in singleCallerServices but no longer exists/u),
    ]);
  });
});
