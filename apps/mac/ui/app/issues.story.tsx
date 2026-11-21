// The workbench with the issue pages' own cases (vv/fixtures/issues.ts
// withIssues) for pictures, as story.tsx with the workbench alone:
// `host.params.route` picks the page, `locale` zh or en. `session` shows a
// session's log alone instead: "worklog" (WorkLog) or "trajectory"
// (Trajectory), on VibeValley's session samples.
import "../infra/polyfill";
import { host, mount, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { failedRun, finishedRun, liveRun, nowAfter } from "../features/session/session.samples";
import { Trajectory } from "../features/session/Trajectory";
import { WorkLog } from "../features/session/WorkLog";
import { withIssues } from "../fixtures/issues";
import { responses, state } from "../fixtures/workbench";
import { fixtureTransport } from "../infra/fixtures";
import { appHistory } from "../infra/router";
import { setTransport } from "../infra/transport";
import { Root } from "./Root";
import { App } from "./Workbench";

setLocale(host.params.locale === "en" ? "en" : "zh");
setTransport(fixtureTransport(withIssues({ state, responses })));
const twoRuns = [...finishedRun, ...liveRun];

if (host.params.session === "worklog")
  mount(() => (
    <Root>
      <View testID="session-story" class="flex-1 gap-4 bg-page p-4">
        <WorkLog steps={twoRuns} now={nowAfter(twoRuns)} working height={420} />
        <WorkLog steps={failedRun} now={nowAfter(failedRun)} />
      </View>
    </Root>
  ));
else if (host.params.session === "trajectory")
  mount(() => (
    <Root>
      <View testID="session-story" class="flex-1 bg-page p-4">
        <Trajectory
          steps={twoRuns}
          now={nowAfter(twoRuns)}
          working
          onMarkWrong={(step, want) => Promise.resolve({ name: `case-${step}`, want, file: `evals/case-${step}.json` } as never)}
        />
      </View>
    </Root>
  ));
else {
  appHistory.navigate(typeof host.params.route === "string" ? host.params.route : "/issues", { replace: true });
  mount(() => <App />);
}
