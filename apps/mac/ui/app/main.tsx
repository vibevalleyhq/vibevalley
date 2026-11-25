// Test and story entry of the whole workbench (vv/VibeValley.tsx), as the
// app hosts it: tests play the host (fixtures/fakeHost.ts).
import "../infra/polyfill";
import { mount } from "nsh";

import "@vibevalley/i18n/catalogs";

import { VibeValley } from "./VibeValley";

mount(VibeValley);
