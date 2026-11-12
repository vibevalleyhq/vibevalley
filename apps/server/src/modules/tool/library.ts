import type * as T from "@vibevalley/protocol";
import { isApiError } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { reasonOf } from "#/base/errors.ts";

import { answers } from "./prompts.ts";
import { callerOf, sessionSchemaTool, tool, type Who } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function libraryTools(deps: Pick<ToolDeps, "library">) {
  const { library } = deps;
  const listed = async (req: T.LibraryListRequest) => {
    const items = await library.list(req);
    return items.length === 0 ? answers.library.none : items.map(answers.library.line).join("\n");
  };
  // A refused add is the answer; anything else fails the call.
  const said = async (work: () => Promise<string>) => {
    try {
      return await work();
    } catch (e) {
      if (isApiError(e)) return answers.failed(reasonOf(e));
      throw e;
    }
  };
  return {
    orchestrator: (who: Who) => [
      tool("library.item.list", (p) => listed(p)),
      tool("library.item.add", (p, signal) => {
        const c = callerOf(who);
        return said(async () => answers.library.added(await library.add(p, { kind: "agent", agent: c.agent }, signal)));
      }),
    ],
    session: (who: Who) => [
      sessionSchemaTool("library.item.list", (p) => listed(p)),
      sessionSchemaTool("library.item.add", (p, signal) => {
        const c = callerOf(who);
        return said(async () =>
          answers.library.added(await library.add(p, { kind: "agent", agent: c.agent, ...(c.session ? { session: S.sessionId(c.session) } : {}) }, signal)),
        );
      }),
    ],
  };
}
