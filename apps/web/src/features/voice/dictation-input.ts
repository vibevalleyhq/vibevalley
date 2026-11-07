// An AudioWorklet's module, as a script of its own: it hands the microphone's samples on in runs of 4096, so the page
// is not woken every 128.
export const dictateWorkletCode = `registerProcessor("vibevalley-capture", class extends AudioWorkletProcessor {
  run = new Float32Array(4096);
  at = 0;
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const s of samples) {
        this.run[this.at++] = s;
        if (this.at === this.run.length) {
          this.port.postMessage(this.run);
          this.run = new Float32Array(4096);
          this.at = 0;
        }
      }
    return true;
  }
});`;

// A space only between adjacent Latin words: Chinese runs on without one.
export function insertDictated(value: string, start: number, end: number, words: string) {
  const before = value.slice(0, start);
  const ascii = /[A-Za-z0-9]/u;
  const gap = before && ascii.test(before.at(-1) ?? "") && ascii.test(words[0] ?? "") ? " " : "";
  const inserted = gap + words;
  return { value: before + inserted + value.slice(end), caret: start + inserted.length };
}
