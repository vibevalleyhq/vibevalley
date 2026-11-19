// The whole workbench on the workbench fixture without a host (pictures on
// a real host): `host.params.route` picks the page, `locale` zh or en.
import "../polyfill";
import { host, mount } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { responses, state } from "../fixtures/workbench";
import { App } from "../web/app/App";
import { fixtureTransport } from "../web/infra/fixtures";
import { appHistory } from "../web/infra/router";
import { setTransport } from "../web/infra/transport";

setLocale(host.params.locale === "en" ? "en" : "zh");
// A picture that is on disk, so attachments draw (the fixture's own path is made up).
const shown = { path: `${(responses["host.pixelDir"] as { path: string }).path}/map.png`, type: "image/png" };
setTransport(fixtureTransport({ state, responses: { ...responses, "attachment.file": shown } }));
appHistory.navigate(typeof host.params.route === "string" ? host.params.route : "/issues", { replace: true });
mount(() => <App />);
