declare global {
  interface Window {
    /** Set only by a script the page must never run (artifact.spec.ts). */
    ran?: number;
    /** How many messages the dictation's capture worklet has handed the page (dictation.spec.ts). */
    heard?: number;
  }
}

export {};
