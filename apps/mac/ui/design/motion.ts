import { reduceMotion, signal } from "nsh";

import type { MotionChoice } from "@vibevalley/protocol/host";

const parseMotion = (value: unknown): MotionChoice | undefined => (value === "off" || value === "on" || value === "system" ? value : undefined);

const choice = signal<MotionChoice>("system");
let reportMotion: ((next: MotionChoice) => void) | undefined;

export const setMotionReporter = (reporter: ((next: MotionChoice) => void) | undefined): void => {
  reportMotion = reporter;
};

export const motionChoice = (): MotionChoice => choice();

export const applyMotion = (value: unknown): void => {
  const next = parseMotion(value);
  if (next !== undefined) choice.set(next);
};

export const chooseMotion = (next: MotionChoice): void => {
  choice.set(next);
  reportMotion?.(next);
};

export const motionOff = (): boolean => {
  const current = choice();
  return current === "off" || (current === "system" && reduceMotion());
};

export const motionClass = (cls: string): string => (motionOff() ? "" : cls);

export const motionDuration = (ms: number): number => (motionOff() ? 0 : ms);

export const fadeAnimation = (): "fade" | "none" => (motionOff() ? "none" : "fade");

export const popupTransition = (cls: string): string | undefined => (motionOff() ? undefined : cls);
