import "../infra/polyfill";
import { host, mount } from "nsh";

import "@vibevalley/i18n/catalogs";

import { setTransport } from "../infra/transport";
import { FarmForm } from "./FarmForm";
import { FarmPhone } from "./FarmPhone";

setTransport({
  call: (op) => {
    switch (op) {
      case "agent.list":
      case "repo.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: [] });
      case "repo.template.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: { recent: [], kinds: [] } });
      case "host.assetsDir":
        return Promise.resolve({ bizCode: 0, message: "ok", data: { path: "" } });
      default:
        return Promise.resolve({ bizCode: 0, message: "ok", data: null });
    }
  },
  slice: () => () => {},
  live: () => () => {},
  subscribe: () => () => {},
});

mount(() => {
  const raw = typeof host.params === "object" && host.params !== null ? host.params : {};
  if (raw.simulateCrash === true) {
    let crashed = false;
    Object.defineProperty(host, "params", {
      configurable: true,
      enumerable: true,
      get() {
        if (!crashed) {
          crashed = true;
          throw new Error("simulated farm render failure");
        }
        return { view: "farm-phone", locale: "en", unfolded: false, calls: { open: false, narrow: false, ringing: null, missed: [], log: [] } };
      },
    });
    return <FarmPhone />;
  }
  if (raw.view === "farm-form") return <FarmForm />;
  return <FarmPhone />;
});
