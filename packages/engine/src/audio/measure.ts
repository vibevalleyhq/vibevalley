// How loud a rendered sound is, for evening out a set of sounds. Peak alone misleads: a short click and a low
// thump can share a peak and sound nothing alike. Loudness here is the ear-weighted (ITU-R BS.1770 K-weighting)
// level of the loudest 100 ms, which suits sounds far shorter than the standard's 400 ms window.

export interface Measure {
  /** Highest sample, in dBFS. */
  peak: number;
  /** K-weighted level of the loudest 100 ms, in dB (LUFS-like). */
  loudness: number;
  /** Until the sound falls below -60 dBFS for good. */
  seconds: number;
}

type Coefficients = readonly [b0: number, b1: number, b2: number, a1: number, a2: number];

/** The two BS.1770 stages, recomputed for any sample rate: a +4 dB shelf above ~1.7 kHz, then a highpass at ~38 Hz. */
function kWeighting(fs: number): Coefficients[] {
  const shelf = (fc: number, q: number, db: number): Coefficients => {
    const a = 10 ** (db / 40);
    const w = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const root = 2 * Math.sqrt(a) * alpha;
    const a0 = a + 1 - (a - 1) * cos + root;
    return [
      (a * (a + 1 + (a - 1) * cos + root)) / a0,
      (-2 * a * (a - 1 + (a + 1) * cos)) / a0,
      (a * (a + 1 + (a - 1) * cos - root)) / a0,
      (2 * (a - 1 - (a + 1) * cos)) / a0,
      (a + 1 - (a - 1) * cos - root) / a0,
    ];
  };
  const highpass = (fc: number, q: number): Coefficients => {
    const w = (2 * Math.PI * fc) / fs;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  };
  return [shelf(1681.97, 0.7072, 4), highpass(38.135, 0.5003)];
}

function filter(x: Float32Array, [b0, b1, b2, a1, a2]: Coefficients): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const db = (power: number) => Math.round(10 * Math.log10(Math.max(power, 1e-12)) * 10) / 10;

export function measure(buffer: AudioBuffer): Measure {
  const x = buffer.getChannelData(0);
  const fs = buffer.sampleRate;
  let peak = 0;
  let last = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    if (v > peak) peak = v;
    if (v > 0.001) last = i;
  }
  const y = kWeighting(fs).reduce(filter, x);
  // Mean square over a sliding 100 ms window, every 10 ms; the loudest window wins.
  const window = Math.round(fs * 0.1);
  const hop = Math.round(fs * 0.01);
  let sum = 0;
  for (let i = 0; i < Math.min(window, y.length); i++) sum += y[i]! * y[i]!;
  let loudest = sum;
  for (let start = 0; start + window + hop <= y.length; start += hop) {
    for (let i = start; i < start + hop; i++) sum += y[i + window]! * y[i + window]! - y[i]! * y[i]!;
    loudest = Math.max(loudest, sum);
  }
  return { peak: db(peak * peak), loudness: Math.round((db(loudest / window) - 0.691) * 10) / 10, seconds: Math.round((last / fs) * 100) / 100 };
}
