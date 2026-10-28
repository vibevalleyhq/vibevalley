import { expect, test } from "./fixtures";

// Every place of the workbench fits a phone's width and a narrow window: nothing runs past the window's edge, so the page
// never scrolls sideways (docs/style/design.md, 6.5). What does not fit truncates, folds or wraps inside its own box.
const places = ["/chat", "/issues", "/docs", "/agents", "/agents/templates", "/runtimes", "/projects", "/catalog", "/settings/general", "/orchestrator"];

/** The outermost elements past the window's right edge (fixed ones are placed against the window on purpose). */
const pastTheEdge = () => {
  const edge = document.documentElement.clientWidth + 1;
  const out: string[] = [];
  if (document.documentElement.scrollWidth > edge) out.push(`the page scrolls to ${document.documentElement.scrollWidth}`);
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.right <= edge || getComputedStyle(el).position === "fixed") continue;
    const parent = el.parentElement?.getBoundingClientRect();
    if (!parent || parent.right <= edge) out.push(`${el.tagName.toLowerCase()}.${el.getAttribute("class") ?? ""}`);
  }
  return out;
};

for (const [width, height] of [
  [400, 800],
  [720, 700],
] as const)
  test(`every place fits ${width}px across`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const path of places) {
      await page.goto(path);
      await expect(page.getByRole("status")).toHaveText("已连上");
      await expect.poll(() => page.evaluate(pastTheEdge), { message: path }).toEqual([]);
    }
  });
