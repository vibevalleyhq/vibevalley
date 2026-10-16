// The dog by the manager's door, as the page draws it (web/src/pixel/dog.ts; it is not the farm's state). It sleeps
// most of the day and stirs now and then (lifts its head and yawns, or gets up to stretch and scratch); it sits up
// with you while the farm is open or the voice is live, and keeps busy there (a wag, a scratch, a yawn, a lie-down, a
// look around). It answers you: pointed at, it lifts its head (awake, it wags); pressed, it ducks; patted, it wakes,
// and every pat after that gets its next trick: a wag, a bark, a jump, rolling over for a belly rub. Three quick pats
// and it rolls over at once. A while after the last pat (with the farm closed) it yawns and lies down again.

import 'dart:math' as math;

import 'life.dart' show Cadence;

/// What a pat gets.
enum Trick { wake, wag, bark, jump, belly }

/// What it shows: a picture ('dog-…'), how far off the ground (a jump), how much taller with its feet put (a breath, a
/// duck).
typedef DogLook = ({String picture, double lift, double grow});

enum _Act { wake, wag, bark, jump, belly, stir, stretch, scratch, settle, yawn, rest, look }

typedef _Frame = ({String picture, double s, double lift, double grow});

_Frame _f(String picture, double s, {double lift = 0, double grow = 0}) => (picture: 'dog-$picture', s: s, lift: lift, grow: grow);

/// The tail going side to side for about `s` seconds.
List<_Frame> _wagging(double s) => [for (var i = 0; i < (s / 0.12).round(); i++) _f(i.isOdd ? 'wag-2' : 'wag-1', 0.12)];

/// A hind leg at an ear: it jiggles.
List<_Frame> _scratching(double s) => [for (var i = 0; i < (s / 0.08).round(); i++) _f('scratch', 0.08, grow: i.isOdd ? -1 : 0)];

final _acts = <_Act, List<_Frame>>{
  _Act.wake: [_f('lie', 0.35), _f('awake', 0.15), ..._wagging(1.2)],
  _Act.wag: [..._wagging(1.4), _f('awake', 0.2)],
  _Act.bark: [_f('awake', 0.05, grow: -1), _f('bark', 0.2), _f('awake', 0.12), _f('bark', 0.25), _f('awake', 0.3)],
  _Act.jump: [
    _f('awake', 0.08, grow: -1),
    for (final lift in const [2.0, 4.0, 5.0, 5.0, 4.0, 2.0]) _f('jump', 0.06, lift: lift),
    _f('awake', 0.08, grow: -1),
    _f('awake', 0.3),
  ],
  _Act.belly: [_f('lie', 0.2), _f('belly', 0.5), _f('belly', 0.12, grow: 1), _f('belly', 0.5), _f('belly', 0.12, grow: 1), _f('belly', 0.7), _f('lie', 0.3)],
  _Act.stir: [_f('lie', 1.2), _f('yawn', 0.9), _f('lie', 0.9)],
  _Act.stretch: [_f('lie', 0.4), _f('stretch', 1.3), _f('awake', 0.4), ..._scratching(0.9), _f('awake', 0.4), _f('lie', 0.6)],
  _Act.scratch: [..._scratching(1), _f('awake', 0.2)],
  _Act.settle: [_f('yawn', 0.8), _f('lie', 1)],
  _Act.yawn: [_f('yawn', 0.9), _f('awake', 0.3)],
  _Act.rest: [_f('lie', 4)],
  _Act.look: [_f('stand', 2.4)],
};

/// What it does now and then while it sits up, and how often each, of every ten.
const _sitting = [(_Act.wag, 4), (_Act.scratch, 2), (_Act.yawn, 1), (_Act.rest, 2), (_Act.look, 1)];

_Act _pickSitting(double r) {
  var left = r * 10;
  for (final (act, n) in _sitting) {
    if (left < n) return act;
    left -= n;
  }
  return _Act.wag;
}

/// The tricks a pat gets, in turn, once it is awake.
const _tricks = [Trick.wag, Trick.bark, Trick.jump, Trick.belly];

/// How long it stays up after a pat, seconds; pats this close together count as quick ones, this many and it rolls over.
const _awakeS = 7.0;
const _quickS = 2.5;
const _quickPats = 3;

_Act _actOf(Trick t) => switch (t) {
  Trick.wake => _Act.wake,
  Trick.wag => _Act.wag,
  Trick.bark => _Act.bark,
  Trick.jump => _Act.jump,
  Trick.belly => _Act.belly,
};

class VillageDog {
  VillageDog([math.Random? random]) : _random = random ?? math.Random(), _every = Cadence(random);
  final math.Random _random;
  final Cadence _every;
  (_Act, double)? _act;

  /// Sitting up: after a pat or with you on a call, until it settles again.
  bool _up = false;
  double _upUntil = double.negativeInfinity;
  bool _pointed = false;
  bool _pressed = false;
  int _turn = 0;
  final _pats = <double>[];

  _Frame? _frameOf(_Act name, double since) {
    var left = since;
    for (final frame in _acts[name]!) {
      if (left < frame.s) return frame;
      left -= frame.s;
    }
    return null;
  }

  DogLook _show(String picture, [double lift = 0, double grow = 0]) => (picture: picture, lift: lift, grow: _pressed ? -1 : grow);

  /// What it shows at `t` seconds (the village's clock). `listening`: the farm is open (its call is live) or the voice
  /// is, so it sits up.
  DogLook look(double t, bool listening) {
    final act = _act;
    if (act != null) {
      final frame = _frameOf(act.$1, t - act.$2);
      if (frame != null) return _show(frame.picture, frame.lift, frame.grow);
      _act = null;
    }
    if (listening || t < _upUntil) {
      _up = true;
      if (_every.due('awake', 6, t)) _act = (_pickSitting(_random.nextDouble()), t);
      // Pointed at, it is pleased you are there.
      return _pointed ? _show(t % 0.24 < 0.12 ? 'dog-wag-1' : 'dog-wag-2') : _show('dog-awake');
    }
    if (_up) {
      _up = false;
      _act = (_Act.settle, t);
      return _show('dog-yawn');
    }
    if (_every.due('stir', 40, t)) _act = (_random.nextDouble() < 0.6 ? _Act.stir : _Act.stretch, t);
    // Pointed at, it lifts its head; asleep, it breathes.
    return _pointed ? _show('dog-lie') : _show('dog-sleep', 0, ((t / 1.6).floor() % 2).toDouble());
  }

  /// A pat at `t`: what it does about it.
  Trick pet(double t) {
    _pats.add(t);
    while (_pats.isNotEmpty && t - _pats.first > _quickS) {
      _pats.removeAt(0);
    }
    final asleep = !_up;
    _upUntil = t + _awakeS;
    _up = true;
    final trick = asleep ? Trick.wake : (_pats.length >= _quickPats ? Trick.belly : _tricks[_turn++ % _tricks.length]);
    if (trick == Trick.belly) _pats.clear();
    _act = (_actOf(trick), t);
    return trick;
  }

  /// The pointer or the keyboard is on it, or not.
  void point(bool on) => _pointed = on;

  /// Pressed, it ducks until let go.
  void press(bool on) => _pressed = on;
}
