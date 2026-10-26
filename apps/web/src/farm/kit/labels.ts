import { farmWording } from "../words";
import type { IssueAct } from "@vibevalley/protocol";

export { ago, numberText } from "../../rules/time";

/** The farm's words for an issue's acts where they are its own: completing a change is a harvest here. */
export const farmActWords: Partial<Record<IssueAct, string>> = { complete: farmWording().tool.harvest.label };
