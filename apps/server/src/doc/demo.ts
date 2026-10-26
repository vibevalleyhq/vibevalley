// The demo's pacing: up to three helpers write one article at once, from the script in words.ts, through the real op
// pipeline as their profiles. The writing itself is in doc.ts.

/** The pacing of one writer: about a tick per piece, a bit more or less so the writers interleave. */
export const demoPieces = 6;
export const demoJitter = 0.3;
