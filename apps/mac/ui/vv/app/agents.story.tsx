import "../polyfill";
import { host, mount, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import type { StateFrame } from "@vibevalley/protocol";

import { responses } from "../fixtures/agents";
import { responses as pixelResponses } from "../fixtures/pixel";
import { App } from "../web/app/App";
import { Root } from "../web/app/Root";
import { SkillsPage } from "../web/features/runtime/SkillsPage";
import { fixtureTransport } from "../web/infra/fixtures";
import { appHistory } from "../web/infra/router";
import { setTransport } from "../web/infra/transport";

const state: StateFrame = {
  seq: 1,
  state: { call: "live", callReason: "", sessions: [], issues: [], crons: [], connectors: [], machines: [] } as unknown as StateFrame["state"],
  inbox: [],
  effects: [],
  view: { level: { level: 3, xp: 40, need: 300 }, plots: {}, plays: {}, achievements: [] },
};

setLocale(host.params.locale === "en" ? "en" : "zh");
setTransport(fixtureTransport({ state, responses: { "issue.history.list": [], ...responses, ...pixelResponses } }));
const skill = typeof host.params.skill === "string" ? host.params.skill : undefined;
if (skill === undefined) {
  appHistory.navigate(typeof host.params.route === "string" ? host.params.route : "/agents", { replace: true });
  mount(() => <App />);
} else
  mount(() => (
    <Root>
      <View class="flex-1 bg-page p-3">
        <SkillsPage id={skill} />
      </View>
    </Root>
  ));
