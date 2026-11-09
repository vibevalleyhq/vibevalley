declare global {
  interface Window {
    /** Set only by a script the page must never run (artifact.spec.ts). */
    ran?: number;
    /** How many messages the dictation's capture worklet has handed the page (dictation.spec.ts). */
    heard?: number;
    flashContexts: AudioContext[];
    flashBuffers: { sampleRate: number; channels: number; frames: number }[];
    flashPeakBuffer: number;
  }
}

export function disableWorkers() {
  // oxlint-disable-next-line vibevalley/global-doors
  Object.defineProperty(window, "Worker", { value: undefined });
}

export function insecureContext() {
  // isSecureContext is readonly; simulate an insecure host before application startup.
  // oxlint-disable-next-line vibevalley/global-doors
  Object.defineProperty(window, "isSecureContext", { value: false });
}
