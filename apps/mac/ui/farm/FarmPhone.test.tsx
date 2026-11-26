import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

function makeValidInboxItem(id: string, who = "Builder Bear") {
  return {
    id,
    kind: "review",
    from: { kind: "session", id: "sess-1", name: who, agent: "builder" },
    who,
    text: `Check ${id}`,
    at: 1_764_000_000_000,
    target: { kind: "issue", id: "issue-1" },
    words: {
      label: "Review",
      title: `Review ${id}`,
      body: `Body for ${id}`,
      tray: `Tray ${id}`,
    },
  };
}

test("FarmPhone renders a calm Papertrails idle card when calls.open is false instead of blank white-screen", async () => {
  const app = await open("./FarmPhone.story.tsx", {
    width: 320,
    height: 360,
    colorScheme: "light",
    platform: "macos",
    host: {
      params: {
        view: "farm-phone",
        locale: "en",
        unfolded: false,
        calls: { open: false, narrow: false, ringing: null, missed: [], log: [] },
      },
    },
  });

  await app.waitFor("id:farm-phone-idle");
  expect(app.shows("id:farm-phone-idle")).toBe(true);
  expect(app.count("id:farm-phone")).toBe(0);
});

test("FarmPhone preserves open handset and valid calls when one InboxItem fails Zod validation", async () => {
  const app = await open("./FarmPhone.story.tsx", {
    width: 320,
    height: 360,
    colorScheme: "dark",
    platform: "macos",
    host: {
      params: {
        view: "farm-phone",
        locale: "en",
        unfolded: false,
        calls: {
          open: true,
          narrow: false,
          ringing: { id: "bad-ring", kind: "invalid" },
          missed: [makeValidInboxItem("missed-ok", "Helper Fox"), { id: "bad-item" }],
          log: [],
        },
      },
    },
  });

  await app.waitFor("id:farm-phone");
  expect(app.shows("id:farm-phone")).toBe(true);
  expect(app.count("id:farm-phone-idle")).toBe(0);
  await app.press("id:missed");
  await app.waitUntil(() => app.texts().some((line) => line.includes("Helper Fox")));
});

test("FarmForm renders Papertrails loading placeholder while board slice is pending and renders sow form cleanly", async () => {
  const loadingApp = await open("./FarmPhone.story.tsx", {
    width: 540,
    height: 430,
    colorScheme: "light",
    platform: "macos",
    host: {
      params: {
        view: "farm-form",
        locale: "en",
        kind: "water",
        issue: "issue-1",
        session: "sess-1",
        repo: "vibevalley",
        station: 0,
      },
    },
  });

  await loadingApp.waitFor("id:farm-form-loading");
  expect(loadingApp.shows("id:farm-form-loading")).toBe(true);

  const sowApp = await open("./FarmPhone.story.tsx", {
    width: 540,
    height: 430,
    colorScheme: "dark",
    platform: "macos",
    host: {
      params: {
        view: "farm-form",
        locale: "en",
        kind: "sow",
        repo: "vibevalley",
        station: 0,
      },
    },
  });

  await sowApp.waitFor("id:sow-text");
  expect(sowApp.shows("id:sow-draft")).toBe(true);
  expect(sowApp.shows("id:sow-start")).toBe(true);
});

test("FarmPhone ErrorBoundary catches child failures and recovers on retry without white-screen", async () => {
  const app = await open("./FarmPhone.story.tsx", {
    width: 320,
    height: 360,
    colorScheme: "light",
    platform: "macos",
    host: {
      params: {
        view: "farm-phone",
        locale: "en",
        simulateCrash: true,
        calls: { open: false, narrow: false, ringing: null, missed: [], log: [] },
      },
    },
  });

  await app.waitFor("id:farm-error-fallback");
  expect(app.texts()).toContain("simulated farm render failure");
  await app.press("id:farm-error-retry");
  await app.waitFor("id:farm-phone-idle");
});
