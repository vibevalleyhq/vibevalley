import { describe, expect, test } from "vite-plus/test";

import { edgesOf, fanInOf, fanInProblems, pathProblems } from "./service-paths.ts";

const files = [
  {
    path: "apps/server/src/services.ts",
    text: [
      'import { makeSession, type Session } from "#/modules/session/session.ts";',
      'import { makeChannel, type Channel } from "#/modules/channel/channel.ts";',
      'import { type Db, makeDb } from "./infra/db.ts";',
    ].join("\n"),
  },
  { path: "apps/server/src/modules/session/session.ts", text: "export interface Session { hire(): void }" },
  { path: "apps/server/src/modules/channel/channel.ts", text: "export interface Channel { post(): void }" },
  { path: "apps/server/src/infra/db.ts", text: "export interface Db { run(): void }" },
  {
    path: "apps/server/src/modules/mailbox/mailbox.ts",
    text: [
      'import type { Session as S } from "#/modules/session/session.ts";',
      'import type { Db } from "#/infra/db.ts";',
      "interface Below { readonly db: Db }",
      "export interface MailboxDeps extends Below { readonly session: S; readonly chat: Pick<Channel, 'post'> }",
      'import type { Channel } from "../channel/channel.ts";',
      "export async function makeMailbox(deps: MailboxDeps) {",
      "  const { session: sessions, db } = deps;",
      "  const later = () => sessions.hire();",
      "  db.run();",
      "  const { post } = deps.chat;",
      "  const other = (sessions: { hire(): void }) => sessions.hire();",
      "}",
    ].join("\n"),
  },
  {
    path: "apps/server/src/modules/session/launch.ts",
    text: 'import type { Session } from "./session.ts"; export function launch(own: Session) { own.hire(); }',
  },
  {
    path: "apps/server/src/gateway/http/handlers/session.ts",
    text: 'import type { Session } from "#/modules/session/session.ts"; export const h = (deps: { session: Session }) => deps.session.dismiss();',
  },
  {
    path: "apps/server/src/modules/issue/issue.test.ts",
    text: 'import type { Session } from "#/modules/session/session.ts"; const t = (s: Session) => s.dismiss();',
  },
  {
    path: "apps/server/src/modules/issue/issue.ts",
    text: "interface Session { hire(): void } export const local = (s: Session) => s.hire();",
  },
];

describe("the service path table", () => {
  test("counts another module's use of a service member through its deps, not its own module, the ground, the handlers or the tests", () => {
    expect(edgesOf(files)).toEqual({ "Channel.post": ["mailbox"], "Session.hire": ["mailbox"] });
  });

  test("a type of the same name declared in the file is not the service", () => {
    expect(edgesOf(files.filter((f) => f.path.includes("issue/issue.ts") || f.path.endsWith("services.ts")))).toEqual({});
  });

  test("a new caller of a member is a new path and fails, naming today's callers", () => {
    const problems = pathProblems({ "Session.hire": ["mailbox"] }, { "Session.hire": ["channel", "mailbox"] });
    expect(problems).toEqual([expect.stringMatching(/^channel now uses Session\.hire.*Fix: .*today: mailbox.*See /u)]);
  });

  test("a path gone fails until the table is written down", () => {
    expect(pathProblems({ "Session.hire": ["mailbox"] }, {})).toEqual([expect.stringMatching(/mailbox no longer uses Session\.hire.*paths:write/u)]);
  });

  test("counts service fan-in across modules including http and rejects new single-caller services", () => {
    expect(fanInOf(files)).toEqual({ Channel: ["mailbox"], Session: ["http", "mailbox"] });
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
