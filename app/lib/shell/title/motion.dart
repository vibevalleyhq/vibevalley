// CSS animations as functions of time (web/src/index.css title-*): where an animation is at `t` seconds with its
// duration, delay and direction, and a property between keyframes, eased per interval as CSS does.

import 'package:flutter/animation.dart';

/// CSS ease-in-out.
const cssEaseInOut = Cubic(0.42, 0, 0.58, 1);

/// The directed progress (0..1) of an infinite animation `t` seconds in: a negative delay starts it that far along;
/// `alternate` runs every other iteration backwards.
double cssProgress(double t, double duration, {double delay = 0, bool alternate = false}) {
  final e = t - delay;
  if (e <= 0) return 0;
  final n = e / duration;
  final it = n.floor();
  final p = n - it;
  return alternate && it.isOdd ? 1 - p : p;
}

/// A property's value at directed progress `p`, between the keyframes that set it (offset, value), each interval
/// eased by `ease`.
double cssKeyframes(List<(double, double)> frames, double p, [Curve ease = Curves.linear]) {
  if (p <= frames.first.$1) return frames.first.$2;
  for (var k = 0; k < frames.length - 1; k++) {
    final (o0, v0) = frames[k];
    final (o1, v1) = frames[k + 1];
    if (p <= o1) return v0 + (v1 - v0) * ease.transform((p - o0) / (o1 - o0));
  }
  return frames.last.$2;
}

/// CSS steps(n) (jump-end).
double cssSteps(double p, int n) => (p * n).floorToDouble() / n;
