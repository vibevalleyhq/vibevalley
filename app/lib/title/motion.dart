// CSS animations as functions of time: where an animation is at `t` seconds with its duration, delay and
// direction, and a property between keyframes, eased per interval as CSS does.

import 'package:flutter/animation.dart';

const cssEaseInOut = Cubic(0.42, 0, 0.58, 1);

/// A negative delay starts it that far along; `alternate` runs every other cycle backwards.
double cssProgress(double t, double duration, {double delay = 0, bool alternate = false}) {
  final e = t - delay;
  if (e <= 0) return 0;
  final n = e / duration;
  final it = n.floor();
  final p = n - it;
  return alternate && it.isOdd ? 1 - p : p;
}

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
