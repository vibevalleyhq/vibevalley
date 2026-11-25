import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

test("Markdown mermaid block opens RichPreviewModal, toggles Diagram/Source, zooms 50%-200%, copies, and closes", async () => {
  const app = await open("./RichPreviewModal.story.tsx", {
    width: 1200,
    height: 900,
    colorScheme: "light",
    platform: "macos",
  });

  // Compact inline preview renders "mermaid" and expandable trigger, modal starts closed.
  expect(app.count("id:md-default >> id:diagram")).toBe(1);
  expect(app.count("id:md-default >> id:diagram-expand")).toBe(1);
  expect(app.count("id:md-default >> id:diagram-preview")).toBe(1);
  expect(app.count("id:rich-preview-modal")).toBe(0);
  expect(app.texts()).toContain("mermaid");
  expect(app.texts()).toContain(t("web.base.rich.expand"));

  // Clicking expand trigger opens RichPreviewModal on the Diagram tab at 100%.
  await app.press("id:md-default >> id:diagram-expand");
  expect(app.count("id:rich-preview-modal")).toBe(1);
  expect(app.count("id:rich-preview-diagram-pane")).toBe(1);
  expect(app.count("id:rich-preview-source-pane")).toBe(0);
  expect(app.texts()).toContain("100%");

  // Zoom in (125% -> 150% -> 175% -> 200%), verify disabled at max 200%.
  await app.press("id:rich-preview-zoom-in");
  expect(app.texts()).toContain("125%");
  await app.press("id:rich-preview-zoom-in");
  await app.press("id:rich-preview-zoom-in");
  await app.press("id:rich-preview-zoom-in");
  expect(app.texts()).toContain("200%");
  expect(app.enabled("id:rich-preview-zoom-in")).toBe(false);
  expect(app.enabled("id:rich-preview-zoom-out")).toBe(true);

  // Reset returns to 100%.
  await app.press("id:rich-preview-zoom-reset");
  expect(app.texts()).toContain("100%");

  // Zoom out (75% -> 50%), verify disabled at min 50%.
  await app.press("id:rich-preview-zoom-out");
  expect(app.texts()).toContain("75%");
  await app.press("id:rich-preview-zoom-out");
  expect(app.texts()).toContain("50%");
  expect(app.enabled("id:rich-preview-zoom-out")).toBe(false);

  // Toggle to Source tab renders CodeBlock and hides zoom controls.
  await app.press("id:rich-preview-tab-source");
  expect(app.count("id:rich-preview-source-pane")).toBe(1);
  expect(app.count("id:rich-preview-diagram-pane")).toBe(0);
  expect(app.count("id:rich-preview-modal >> id:code-block")).toBe(1);
  expect(app.count("id:rich-preview-zoom-in")).toBe(0);

  // Toggle back to Diagram tab restores diagram pane and zoom controls.
  await app.press("id:rich-preview-tab-diagram");
  expect(app.count("id:rich-preview-diagram-pane")).toBe(1);
  expect(app.count("id:rich-preview-zoom-in")).toBe(1);

  // Copy button writes raw Mermaid source to clipboard.
  await app.press("id:rich-preview-copy");
  expect(app.clipboard()).toContain("flowchart LR");

  // Close button dismisses the modal.
  await app.press("id:rich-preview-close");
  expect(app.count("id:rich-preview-modal")).toBe(0);

  // Clicking the diagram preview body also opens the modal.
  await app.press("id:md-default >> id:diagram-preview");
  expect(app.count("id:rich-preview-modal")).toBe(1);
  await app.press("id:rich-preview-close");
  expect(app.count("id:rich-preview-modal")).toBe(0);

  // Optional onDiagramPress override intercepts click instead of opening internal modal.
  await app.press("id:md-custom >> id:diagram-expand");
  expect(app.count("id:rich-preview-modal")).toBe(0);
  expect(app.texts()).toContain("flowchart LR\n  A[Request] --> B{Valid?}\n  B -->|Yes| C[Done]");
});
