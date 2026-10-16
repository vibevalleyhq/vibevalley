// The phone games' seeded generator: mulberry32, as packages/core blocks.ts and dino.ts have it, in 32-bit integer
// arithmetic so a seed deals the same pieces and obstacles here as on the web page.

int _u32(int x) => x & 0xFFFFFFFF;
int _i32(int x) => x.toSigned(32);

/// Math.imul: the low 32 bits of the product, signed. Dart's 64-bit product keeps the low 32 bits exact.
int _imul(int a, int b) => _i32(a * b);

/// The next number in [0, 1) and the generator's next state.
(double, int) nextRandom(int seed) {
  final s = _i32(seed + 0x6d2b79f5);
  var t = _imul(_i32(s ^ (_u32(s) >> 15)), _i32(1 | s));
  t = _i32(_i32(t + _imul(_i32(t ^ (_u32(t) >> 7)), _i32(61 | t))) ^ t);
  return (_u32(t ^ (_u32(t) >> 14)) / 4294967296, s);
}
