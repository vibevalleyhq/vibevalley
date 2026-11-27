import "../infra/polyfill";
import { host, mount } from "nsh";

import "@vibevalley/i18n/catalogs";
import type { FarmShopView } from "@vibevalley/protocol";

import { setTransport } from "../infra/transport";
import { FarmForm } from "./FarmForm";
import { FarmPhone } from "./FarmPhone";

const createShopState = (): FarmShopView => {
  let coins = 120;
  const owned = new Set<string>();
  const makeView = (): FarmShopView => ({
    coins,
    items: [
      {
        id: "deco_stone_lantern",
        kind: "decoration",
        title: "Stone Lantern",
        detail: "Paper stone lantern beside the bridge.",
        price: 40,
        owned: owned.has("deco_stone_lantern"),
        decoration: { asset: "p_lantern", x: 2.15, z: -1.85, yawDeg: 12, scale: 1.15 },
      },
      {
        id: "tmpl_regression_guard",
        kind: "template",
        title: "Add regression test",
        detail: "Unlock a regression-first issue template.",
        price: 45,
        owned: owned.has("tmpl_regression_guard"),
        template: {
          id: "tmpl_regression_guard",
          title: "Add regression test",
          done: "Write a failing regression test first.",
          text: "Add regression test: Write a failing regression test first.",
        },
      },
    ],
    daily: {
      day: "2026-11-27",
      tasks: [
        {
          id: "2026-11-27:tests_passed",
          kind: "tests_passed",
          title: "Verified Check",
          detail: "Record 1 passing check.",
          progress: 1,
          target: 1,
          rewardCoins: 25,
          completed: true,
          settled: true,
          settledAt: 1_764_000_000_000,
        },
        {
          id: "2026-11-27:clean_harvest",
          kind: "clean_harvest",
          title: "Clean Delivery",
          detail: "Deliver 1 issue cleanly.",
          progress: 0,
          target: 1,
          rewardCoins: 30,
          completed: false,
          settled: false,
        },
      ],
      settledCoinsToday: 25,
    },
  });
  return makeView();
};

let shopCoins = 120;
const shopOwned = new Set<string>();
const buildShopView = (): FarmShopView => {
  const base = createShopState();
  return {
    ...base,
    coins: shopCoins,
    items: base.items.map((item) => ({ ...item, owned: shopOwned.has(item.id) })),
  };
};

setTransport({
  call: (op, params) => {
    switch (op) {
      case "agent.list":
      case "repo.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: [] });
      case "repo.template.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: { recent: [], kinds: [] } });
      case "game.shop.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: buildShopView() });
      case "game.shop.buy": {
        const id = typeof params === "object" && params !== null && "id" in params ? String(params.id) : "";
        const current = buildShopView();
        const found = current.items.find((item) => item.id === id);
        if (found && !found.owned && shopCoins >= found.price) {
          shopCoins -= found.price;
          shopOwned.add(found.id);
        }
        return Promise.resolve({ bizCode: 0, message: "ok", data: buildShopView() });
      }
      case "game.daily.list":
        return Promise.resolve({ bizCode: 0, message: "ok", data: buildShopView().daily });
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
