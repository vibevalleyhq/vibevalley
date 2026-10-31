import { expect, test } from "vite-plus/test";

import { prefsNow, rememberPick, setWidth } from "./prefs";

test("the last pick is one choice: an issue given to someone is the farm's next job's too, and no one is the orchestrator", () => {
  rememberPick("w3", "clock-in");
  expect(prefsNow()).toMatchObject({ pick: "w3", project: "clock-in" });
  rememberPick("", "site");
  expect(prefsNow()).toMatchObject({ pick: "auto", project: "site" });
  rememberPick("", "");
  expect(prefsNow()).toMatchObject({ pick: "auto", project: "site" });
});

test("a pane's width is kept by its name, and none puts it back to its default", () => {
  setWidth("chat.side", 280);
  setWidth("issue.side", 320);
  setWidth("chat.side", undefined);
  expect(prefsNow().widths).toEqual({ "issue.side": 320 });
});
