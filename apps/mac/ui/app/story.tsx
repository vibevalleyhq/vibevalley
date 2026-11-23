// The whole workbench on the workbench fixture without a host (pictures on
// a real host): `host.params.route` picks the page, `locale` zh or en.
import "../infra/polyfill";
import { mount } from "nsh";

import { setLocale } from "@vibevalley/i18n";

import { responses, state } from "../fixtures/workbench";
import { fixtureTransport } from "../infra/fixtures";
import { readHostParams } from "../infra/hostParams";
import { appHistory } from "../infra/router";
import { setTransport } from "../infra/transport";
import { App } from "./Workbench";

const params = readHostParams();
setLocale(params.locale);
// A picture that is on disk, so attachments draw (the fixture's own path is made up).
const shown = { path: `${(responses["host.pixelDir"] as { path: string }).path}/map.png`, type: "image/png" };
setTransport(fixtureTransport({ state, responses: { ...responses, "attachment.file": shown } }));
appHistory.navigate(params.route ?? "/issues", { replace: true });
mount(() => <App />);
