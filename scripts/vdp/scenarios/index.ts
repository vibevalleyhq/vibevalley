import type { VdpScenario } from "../dsl.ts";
import { chatScenario } from "./chat.ts";
import { dashboardScenario } from "./dashboard.ts";
import { docEditorScenario } from "./doc-editor.ts";
import { issuesScenario } from "./issues.ts";
import { libraryScenario } from "./library.ts";
import { noteScenario } from "./note.ts";
import { settingsScenario } from "./settings.ts";

export const SCENARIOS: Readonly<Record<string, VdpScenario>> = {
  [noteScenario.id]: noteScenario,
  [docEditorScenario.id]: docEditorScenario,
  [issuesScenario.id]: issuesScenario,
  [chatScenario.id]: chatScenario,
  [libraryScenario.id]: libraryScenario,
  [dashboardScenario.id]: dashboardScenario,
  [settingsScenario.id]: settingsScenario,
};

export function listScenarios(): readonly VdpScenario[] {
  return Object.values(SCENARIOS);
}
