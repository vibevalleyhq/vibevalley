import { expect, test } from "./fixtures";

// A server of its own: the language is the whole farm's, and every other file reads the Chinese.
test.use({ farm: "english" });

test("the farm speaks English once the owner picks it, and Chinese again", async ({ page, api }) => {
  await api.issue.create({ title: "Add paging to clock-in" });
  await page.goto("/settings/general");
  const language = page.getByTestId("language");
  await language.locator('[data-key="en"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  const nav = page.getByRole("navigation", { name: "Workbench" });
  for (const label of ["Chat", "Tickets", "Artifacts", "Profiles", "Machines", "Projects", "Catalog", "Settings"])
    await expect(nav.getByRole("link", { name: new RegExp(`^${label} · `, "u") })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Connected");
  await expect(language.locator('[data-key="en"]')).toHaveAttribute("aria-pressed", "true");

  // The board's lanes are the page's words; a card's status is the server's, in the same language.
  await nav.getByRole("link", { name: /^Tickets · /u }).click();
  await expect(page.getByText("Add paging to clock-in")).toBeVisible();
  for (const lane of ["To do", "In progress", "For you to see", "Closed"]) await expect(page.getByText(lane, { exact: true }).first()).toBeVisible();

  // The server's own words follow: the voice line's default greeting, the machines' blurbs.
  const settings = await api.setting.get();
  expect(settings.locale).toBe("en");
  expect(settings.voiceDefaults.greeting).toBe("Hey there! What shall we grow today?");
  await nav.getByRole("link", { name: /^Chat · /u }).click();
  await expect(page.getByRole("heading", { name: "general" })).toBeVisible();
  await nav.getByRole("link", { name: /^Machines · /u }).click();
  await expect(page.getByRole("region", { name: "Machines" })).toBeVisible();

  await page.goto("/settings/general");
  await language.locator('[data-key="zh"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByTestId("rail")).toBeVisible();
});

// Every page, in English, has no Chinese left but what the owner stored (the profiles a farm starts with are written in the
// language it first opened in) and the language picker's own 中文: a word left out of the catalogs, or one the server worked
// out in Chinese and kept, shows here.
test("no page of an English farm shows Chinese of its own", async ({ page, api }) => {
  await api.setting.update({ locale: "en" });
  const issue = await api.issue.create({ title: "Count the clock-ins" });
  const agents = await api.agent.list();
  const stored = ["中文"];
  const keep = (v: unknown): void => {
    if (typeof v === "string") stored.push(v);
    else if (Array.isArray(v)) v.forEach(keep);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(keep);
  };
  keep(agents);
  keep(await api.channel.list());
  const sections = ["general", "appearance", "models", "about", "memory", "skills", "call", "moss", "dictation", "github", "chat", "devices"];
  const paths = [
    "/",
    "/chat",
    "/issues",
    `/issues/${issue.id}`,
    "/artifacts",
    "/agents",
    `/agents/${agents.find((a) => a.role === "worker")!.id}`,
    "/agents/templates",
    "/runtimes",
    "/projects",
    "/catalog",
    "/tree",
    ...sections.map((s) => `/settings/${s}`),
  ];
  // Runs of Chinese: one that is not part of a stored text is the page's own (a profile's duty shows cut short).
  const chinese = /[\p{Script=Han}、，。：；（）！？「」【】〔〕]+/gu;
  for (const path of paths) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("status").filter({ hasText: "Connected" }).or(page.locator("canvas")).first()).toBeVisible();
    // What is shown and what is read aloud.
    const left = async () =>
      (
        await page.evaluate(() => {
          const said = [document.body.innerText];
          for (const el of document.querySelectorAll("[aria-label], [title], [placeholder], [alt]"))
            for (const name of ["aria-label", "title", "placeholder", "alt"]) said.push(el.getAttribute(name) ?? "");
          return said;
        })
      )
        .flatMap((text) => text.split(/\n+/u))
        .filter((line) => (line.match(chinese) ?? []).some((run) => !stored.some((text) => text.includes(run))))
        .map((line) => `${path}: ${line.trim()}`);
    await expect.poll(left).toEqual([]);
  }
});
