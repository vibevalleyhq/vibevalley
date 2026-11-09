export function wav(samples = 2880): Buffer {
  const rate = 24000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin((index * 2 * Math.PI * 440) / rate) * 4096), 44 + index * 2);
  return bytes;
}

// A 120ms, 440Hz mono tone encoded with libmp3lame at 24kHz / 32kbps, without metadata or a Xing seek header.
export const mp3 = Buffer.from(
  "//NExAASeGp8P1gYAAu2SWgM7Z2w9d6p1juO8BfwznNJzOUxhLRopsTh+XyykpKSkpKTAEwfB8H31AhwfP5QMSnKB/h739Hv6Pf/DAPn6wICGgH+U9/QQQggwggAAACN" +
    "//NExAkU6T6EV5toAMWe3U+6YWpHbFQwWnhgwNKjvisyUMLbPb18+BNQWkJ7+O4YYYYm/45RwmQ9h7f+Yl0umReL3/5iXS6kkZI/wVEQVBX/lgqCoiPArQBRZ4CofaHp" +
    "//NExAgR+Fo0d94AAHluUfS1pgUhBGD0L0YGwTZg1hmHNmvYZegZJg8g+GB2BoYH4DAMAFQCpqtKfqe5/V+z9//Rpos//+n/2f6vR9IWSAZXhhragAJAEwMBow9IE3pv" +
    "//NExBMS0FocTO/0QJMjgFMCBB8TR+FyMwpUEHPxMNObMUGLNoqKncuHLeGNq10abP777vTp0Wf61Kq0FPs7Dvv/06NiKiZKAIFuKZgEALBwAUYBAAcGA6AcxgmQFcYP" +
    "//NExBoXGFogT18QAKA7BghQQUYceF2mXtsAhiCwn4YbEDPGBjAQwAAbTAcQDswB8AZIgANbaG7E57G+r29nu9VWj/9/XVT1/9p7/X6tHRX0TcFCwCL4MFAleBQ2ARRX" +
    "//NExBAVslKYAZRQAEorosf4BAGwWP8CuIsbhef+LBIIsfk//4sDwkFsfk//+PB4YPx+ePP//zDB+eeSGGE////555IYCYfBAB//+HwQAYfBABh9EkAD9QCBdLA1EcTs" +
    "//NExAwVWqp8C5RoALXgADQBiLcK4B1Ar34xQtIXkd3+I0MMTRhR6/+ZD2JYxHqa//mQ9jY6XTVX/+XnWXUKS///6Kql5kjMUv///5kuYpJGSKJikkZKTEFNRTQuMKqq",
  "base64",
);
