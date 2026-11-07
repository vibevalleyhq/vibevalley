import { test as base, expect, type Page } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    const escaped: string[] = [];
    page.on("pageerror", (error) => {
      escaped.push(error.message);
      if (process.env.VIBEVALLEY_WEB_DEV === "1") console.log(`[page stack] ${error.stack}`);
      if (process.env.CI) console.log(`[page] ${error.message}`);
    });
    if (process.env.CI)
      page.on("console", (message) => {
        if (message.type() === "error") console.log(`[page] ${message.text()}`);
      });
    if (process.env.VIBEVALLEY_WEB_DEV === "1") {
      await page.addInitScript(() => {
        const warn = console.warn.bind(console);
        console.warn = (...args: unknown[]) => warn(...args, String(args[0]).includes("STRICT_READ") ? new Error().stack : "");
      });
      page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") console.log(`[solid ${message.type()}] ${message.text().replaceAll("\n", " ⏎ ")}`);
      });
    }
    await use(page);
    expect(escaped, "errors that escaped the page").toEqual([]);
  },
});
export { expect };

export function diagnosticsOf(page: Page) {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (/\[(STRICT_|REACTIVITY_|NO_OWNER_|REACTIVE_WRITE_)/u.test(message.text())) messages.push(message.text());
  });
  return () => expect(messages).toEqual([]);
}
