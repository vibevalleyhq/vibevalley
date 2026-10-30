// Each component, closed and open, as axe reads it: the roles, names and states the parts write are allowed and whole.

import { test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { AlertDialog, Checkbox, Collapsible, Dialog, Menu, Popover, Select, Switch, Tabs, Toggle, ToggleGroup, Tooltip } from "../src/index";
import { $, expectAccessible, mount, settle } from "./render";

test("controls", async () => {
  mount(() => (
    <main>
      <Switch.Root aria-label="sound">
        <Switch.Thumb />
      </Switch.Root>
      <Checkbox.Root aria-label="done" indeterminate>
        <Checkbox.Indicator />
      </Checkbox.Root>
      <Toggle aria-label="bold">B</Toggle>
      <ToggleGroup aria-label="view" defaultValue={["list"]}>
        <Toggle value="list">list</Toggle>
        <Toggle value="board">board</Toggle>
      </ToggleGroup>
      <Collapsible.Root defaultOpen>
        <Collapsible.Trigger>more</Collapsible.Trigger>
        <Collapsible.Panel>inside</Collapsible.Panel>
      </Collapsible.Root>
      <Tabs.Root>
        <Tabs.List aria-label="pages">
          <Tabs.Tab value="a">a</Tabs.Tab>
          <Tabs.Tab value="b">b</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="a">first</Tabs.Panel>
        <Tabs.Panel value="b">second</Tabs.Panel>
      </Tabs.Root>
    </main>
  ));
  await settle();
  await expectAccessible();
});

test("dialogs", async () => {
  mount(() => (
    <main>
      <Dialog.Root defaultOpen>
        <Dialog.Popup>
          <Dialog.Title>Settings</Dialog.Title>
          <Dialog.Close>done</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Root>
    </main>
  ));
  await settle();
  await expectAccessible();
});

test("an alert dialog", async () => {
  mount(() => (
    <main>
      <AlertDialog.Root defaultOpen>
        <AlertDialog.Popup>
          <AlertDialog.Title>Delete?</AlertDialog.Title>
          <AlertDialog.Description>It cannot come back.</AlertDialog.Description>
          <AlertDialog.Close>cancel</AlertDialog.Close>
        </AlertDialog.Popup>
      </AlertDialog.Root>
    </main>
  ));
  await settle();
  await expectAccessible();
});

test("floating popups, open", async () => {
  mount(() => (
    <main>
      <Popover.Root>
        <Popover.Trigger data-testid="popover">display</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner>
            <Popover.Popup>
              <Popover.Title>Display</Popover.Title>
              <Popover.Close>done</Popover.Close>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Tooltip.Root delay={0}>
        <Tooltip.Trigger data-testid="tooltip">copy</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner>
            <Tooltip.Popup>Copy the link</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </main>
  ));
  await userEvent.click($("[data-testid=popover]"));
  await settle();
  await expectAccessible();
  await userEvent.keyboard("{Escape}");
  await userEvent.hover($("[data-testid=tooltip]"));
  await settle();
  await expectAccessible();
});

test("a menu and a select, open", async () => {
  mount(() => (
    <main>
      <Menu.Root>
        <Menu.Trigger data-testid="menu">more</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner>
            <Menu.Popup>
              <Menu.Item>Reply</Menu.Item>
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Danger</Menu.GroupLabel>
                <Menu.Item disabled>Delete</Menu.Item>
              </Menu.Group>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Select.Root items={{ pi: "Pi", codex: "Codex" }} defaultValue="pi">
        <Select.Trigger data-testid="select" aria-label="runtime">
          <Select.Value />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner>
            <Select.Popup>
              <Select.Item value="pi">Pi</Select.Item>
              <Select.Item value="codex">Codex</Select.Item>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </main>
  ));
  await userEvent.click($("[data-testid=menu]"));
  await settle();
  await expectAccessible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click($("[data-testid=select]"));
  await settle();
  await expectAccessible();
});
