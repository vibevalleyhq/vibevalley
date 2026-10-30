import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { Accordion, Toolbar } from "../src/index";
import { $, expectAccessible, mount, settle } from "./render";

const sections = (multiple: boolean, said: string[][] = []) => (
  <Accordion.Root multiple={multiple} onValueChange={(v) => said.push(v)}>
    {["one", "two", "three"].map((v) => (
      <Accordion.Item value={v} disabled={v === "two" && !multiple}>
        <Accordion.Header>
          <Accordion.Trigger data-testid={`t-${v}`}>{v}</Accordion.Trigger>
        </Accordion.Header>
        <Accordion.Panel data-testid={`p-${v}`}>{`about ${v}`}</Accordion.Panel>
      </Accordion.Item>
    ))}
  </Accordion.Root>
);

test("one item open at a time; the trigger controls a region named by it; arrows pass disabled triggers", async () => {
  const said: string[][] = [];
  mount(() => sections(false, said));
  await userEvent.click($("[data-testid=t-one]"));
  await settle();
  const panel = $("[data-testid=p-one]");
  expect([
    $("[data-testid=t-one]").getAttribute("aria-expanded"),
    $("[data-testid=t-one]").getAttribute("aria-controls"),
    panel.getAttribute("aria-labelledby"),
  ]).toEqual(["true", panel.id, $("[data-testid=t-one]").id]);
  expect(document.activeElement).toBe($("[data-testid=t-one]"));
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe($("[data-testid=t-three]"));
  await userEvent.keyboard("{Enter}");
  await settle();
  expect([document.querySelector("[data-testid=p-one]"), said]).toEqual([null, [["one"], ["three"]]]);
  await expectAccessible();
});

test("with multiple, several stay open", async () => {
  mount(() => sections(true));
  await userEvent.click($("[data-testid=t-one]"));
  await userEvent.click($("[data-testid=t-two]"));
  await settle();
  expect([document.querySelector("[data-testid=p-one]") !== null, document.querySelector("[data-testid=p-two]") !== null]).toEqual([true, true]);
});

test("a toolbar is one tab stop that remembers the item focused last; arrows skip disabled ones", async () => {
  mount(() => (
    <>
      <button data-testid="before">before</button>
      <Toolbar.Root aria-label="format">
        <Toolbar.Button data-testid="bold">B</Toolbar.Button>
        <Toolbar.Button data-testid="italic" disabled>
          I
        </Toolbar.Button>
        <Toolbar.Separator />
        <Toolbar.Link data-testid="help" href="#help">
          help
        </Toolbar.Link>
      </Toolbar.Root>
      <button data-testid="after">after</button>
    </>
  ));
  await settle();
  $("[data-testid=before]").focus();
  await userEvent.tab();
  expect(document.activeElement).toBe($("[data-testid=bold]"));
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe($("[data-testid=help]"));
  await userEvent.tab();
  expect(document.activeElement).toBe($("[data-testid=after]"));
  await userEvent.tab({ shift: true });
  await settle();
  expect(document.activeElement).toBe($("[data-testid=help]"));
  expect($("[role=separator]").getAttribute("aria-orientation")).toBe("vertical");
  const inside = document.createElement("button");
  inside.textContent = "inside";
  $("[role=toolbar]").append(inside);
  inside.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(inside);
  await expectAccessible();
});
