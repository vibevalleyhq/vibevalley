import { expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { AlertDialog, Dialog, type DialogCloseReason } from "../src/index.ts";
import { $, mount, settle } from "./render.tsx";

const view = (said: [boolean, DialogCloseReason][]) => (
  <Dialog.Root onOpenChange={(open, why) => said.push([open, why])}>
    <Dialog.Trigger>open</Dialog.Trigger>
    <Dialog.Popup data-testid="popup">
      <Dialog.Title>Settings</Dialog.Title>
      <Dialog.Description>What this machine keeps.</Dialog.Description>
      <input aria-label="name" />
      <Dialog.Close>done</Dialog.Close>
    </Dialog.Popup>
  </Dialog.Root>
);

test("the trigger opens a modal in the top layer, named by its title, with the focus inside", async () => {
  const said: [boolean, DialogCloseReason][] = [];
  mount(() => view(said));
  const trigger = $("button");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  await userEvent.click(trigger);
  await settle();
  const popup = $<HTMLDialogElement>("[data-testid=popup]");
  expect([popup.open, popup.matches(":modal"), popup.hasAttribute("data-open"), trigger.hasAttribute("data-popup-open")]).toEqual([true, true, true, true]);
  expect($(`#${popup.getAttribute("aria-labelledby")}`).textContent).toBe("Settings");
  expect($(`#${popup.getAttribute("aria-describedby")}`).textContent).toBe("What this machine keeps.");
  expect(popup.contains(document.activeElement)).toBe(true);
  expect(said).toEqual([[true, "trigger"]]);
});

test("Escape, the close button and a press on the backdrop close it, and the focus goes back to the trigger", async () => {
  const said: [boolean, DialogCloseReason][] = [];
  mount(() => view(said));
  const trigger = $("button");
  const popup = $<HTMLDialogElement>("[data-testid=popup]");
  await userEvent.click(trigger);
  await settle();
  await userEvent.keyboard("{Escape}");
  await settle();
  expect([popup.open, document.activeElement]).toEqual([false, trigger]);

  await userEvent.click(trigger);
  await settle();
  await userEvent.click($("dialog button"));
  await settle();
  expect(popup.open).toBe(false);

  await userEvent.click(trigger);
  await settle();
  // The backdrop is the dialog element itself, outside its content box.
  await userEvent.click(popup, { position: { x: 1, y: 1 } });
  await settle();
  expect(popup.open).toBe(false);
  expect(said.map(([, why]) => why)).toEqual(["trigger", "escape", "trigger", "close", "trigger", "outside"]);
});

test("an alert dialog is not closed by its backdrop, and reads as an alert dialog", async () => {
  mount(() => (
    <AlertDialog.Root defaultOpen>
      <AlertDialog.Popup data-testid="popup" style={{ padding: "40px" }}>
        <AlertDialog.Title>Delete it?</AlertDialog.Title>
        <AlertDialog.Close>no</AlertDialog.Close>
      </AlertDialog.Popup>
    </AlertDialog.Root>
  ));
  await settle();
  const popup = $<HTMLDialogElement>("[data-testid=popup]");
  expect([popup.open, popup.getAttribute("role")]).toEqual([true, "alertdialog"]);
  await userEvent.click(popup, { position: { x: 1, y: 1 } });
  await settle();
  expect(popup.open).toBe(true);
});
