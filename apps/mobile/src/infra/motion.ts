import { host, reduceMotion, signal } from "nsh";

import type { MotionChoice } from "@vibevalley/protocol/host";
import { MOTION_DURATIONS, MOTION_ENTER_CLASSES, type MotionTier } from "@vibevalley/protocol/ui";

export type { MotionTier };

export const MOTION_DURATION = MOTION_DURATIONS;

const parseMotion = (value: unknown): MotionChoice | undefined => (value === "off" || value === "on" || value === "system" ? value : undefined);

const envAnimationsDisabled = (): boolean =>
  host.params.noAnimation === true ||
  Reflect.get(globalThis, "__VIBEVALLEY_NO_ANIMATION__") === true ||
  (typeof process !== "undefined" && process.env?.VIBEVALLEY_NO_ANIMATION === "1");

const choice = signal<MotionChoice>("system");

export const motionChoice = (): MotionChoice => choice();

export const applyMotion = (value: unknown): void => {
  const next = parseMotion(value);
  if (next !== undefined) choice.set(next);
};

export const motionOff = (): boolean => {
  if (envAnimationsDisabled()) return true;
  const current = choice();
  return current === "off" || (current === "system" && reduceMotion());
};

export const motionClass = (cls: string): string => (motionOff() ? "" : cls);

export const motionEnter = (tier: MotionTier = "normal"): string => motionClass(MOTION_ENTER_CLASSES[tier]);

export const motionDuration = (ms: number): number => (motionOff() ? 0 : ms);

export const fadeAnimation = (): "fade" | "none" => (motionOff() ? "none" : "fade");

export const popupTransition = (cls: string): string | undefined => (motionOff() ? undefined : cls);
