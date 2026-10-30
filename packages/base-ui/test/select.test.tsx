import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { Select } from "../src/index";
import { $, mount, settle } from "./render";

const items = { pi: "Pi", codex: "Codex", claude: "Claude Code", gemini: "Gemini" };

const view = (chose: string[], o: { defaultValue?: string; value?: string } = {}) => (
  <form data-testid="form">
    <Select.Root items={items} name="runtime" {...o} onValueChange={(v) => chose.push(v)}>
      <Select.Trigger data-testid="trigger">
        <Select.Value data-testid="value" placeholder="pick one" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup data-testid="list">
            {Object.entries(items).map(([value, label]) => (
              <Select.Item value={value} disabled={value === "gemini"}>
                {label}
                <Select.ItemIndicator data-testid={`check-${value}`} />
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </form>
);

const focused = () => (document.activeElement as HTMLElement | null)?.dataset.value;

test("the trigger shows the label or the placeholder, and reads as a combobox", () => {
  mount(() => view([]));
  const trigger = $("[data-testid=trigger]");
  expect([trigger.getAttribute("role"), trigger.getAttribute("aria-haspopup"), $("[data-testid=value]").textContent]).toEqual([
    "combobox",
    "listbox",
    "pick one",
  ]);
  expect($("[data-testid=value]").hasAttribute("data-placeholder")).toBe(true);
});

test("a click opens it on the chosen option; picking one closes it, shows its label and gives the focus back", async () => {
  const chose: string[] = [];
  mount(() => view(chose, { defaultValue: "codex" }));
  const trigger = $("[data-testid=trigger]");
  expect($("[data-testid=value]").textContent).toBe("Codex");
  await userEvent.click(trigger);
  await settle();
  expect(focused()).toBe("codex");
  const chosen = $("[data-value=codex]");
  expect([chosen.getAttribute("aria-selected"), chosen.hasAttribute("data-selected"), document.querySelector("[data-testid=check-codex]") !== null]).toEqual([
    "true",
    true,
    true,
  ]);
  await userEvent.click($("[data-value=claude]"));
  await settle();
  expect([chose, $("[data-testid=value]").textContent, document.querySelector("[data-testid=list]"), document.activeElement]).toEqual([
    ["claude"],
    "Claude Code",
    null,
    trigger,
  ]);
  expect(new FormData($("[data-testid=form]", HTMLFormElement)).get("runtime")).toBe("claude");
});

test("from the keyboard: ArrowDown opens, arrows stop at the ends and pass disabled ones, letters jump, Enter picks", async () => {
  const chose: string[] = [];
  mount(() => view(chose));
  $("[data-testid=trigger]").focus();
  await userEvent.keyboard("{ArrowDown}");
  await settle();
  expect(focused()).toBe("pi");
  await userEvent.keyboard("{ArrowUp}");
  expect(focused()).toBe("pi");
  await userEvent.keyboard("{End}");
  expect(focused()).toBe("claude");
  await userEvent.keyboard("c");
  expect(focused()).toBe("codex");
  await userEvent.keyboard("{Enter}");
  await settle();
  expect(chose).toEqual(["codex"]);
});

test("Escape closes without picking, and a controlled select shows only its owner's value", async () => {
  const chose: string[] = [];
  mount(() => view(chose, { value: "pi" }));
  const trigger = $("[data-testid=trigger]");
  await userEvent.click(trigger);
  await settle();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect([document.querySelector("[data-testid=list]"), document.activeElement]).toEqual([null, trigger]);
  await userEvent.click(trigger);
  await settle();
  await userEvent.click($("[data-value=codex]"));
  await settle();
  expect([chose, $("[data-testid=value]").textContent]).toEqual([["codex"], "Pi"]);
});
