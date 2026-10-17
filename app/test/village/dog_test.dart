import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/village/dog.dart';

void main() {
  test('asleep it breathes; a pat wakes it, the next pats get its tricks in turn', () {
    final dog = VillageDog(math.Random(1));
    expect(dog.look(0, false).picture, 'dog-sleep');
    expect(dog.pet(1), Trick.wake);
    expect(dog.look(1.1, false).picture, 'dog-lie');
    expect(dog.pet(5), Trick.wag);
    expect(dog.pet(9), Trick.bark);
    expect(dog.pet(13), Trick.jump);
    expect(dog.look(13.08 + 0.13, false).lift, greaterThan(0));
  });

  test('three quick pats and it rolls over; long after the last it yawns and lies down', () {
    final dog = VillageDog(math.Random(2));
    dog.pet(0);
    dog.pet(0.5);
    expect(dog.pet(1), Trick.belly);
    expect(dog.look(1.3, false).picture, 'dog-belly');
    expect(dog.look(9, false).picture, 'dog-yawn');
  });

  test('pressed it ducks; pointed at while up, it wags', () {
    final dog = VillageDog(math.Random(3));
    dog.press(true);
    expect(dog.look(0, false).grow, -1);
    dog
      ..press(false)
      ..point(true);
    expect(dog.look(0.05, true).picture, 'dog-wag-1');
  });
}
