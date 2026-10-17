// Changes in state, not clicks, so a sound plays whoever caused the change.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../voice/voice.dart';
import '../game/fx.dart';
import '../data/prefs.dart';
import '../audio/sfx.dart';

typedef BedFx = ({Object id, String kind});

const _bedSound = {'water': 'water', 'spray': 'spray', 'harvest': 'harvest', 'shovel': 'shovel', 'note': 'nope'};

class FarmSounds extends ConsumerStatefulWidget {
  const FarmSounds({super.key, this.child = const SizedBox.shrink(), this.tool, this.bedFx = const [], this.open = const {}, this.call, this.effects});
  final Widget child;

  final String? tool;

  final List<BedFx> bedFx;

  final Map<String, bool> open;

  final VoiceCall? call;

  final Stream<GameEffect>? effects;

  @override
  ConsumerState<FarmSounds> createState() => _FarmSoundsState();
}

class _FarmSoundsState extends ConsumerState<FarmSounds> {
  StreamSubscription<GameEffect>? _effects;
  CallPhase? _phase;
  String? _problem;

  @override
  void initState() {
    super.initState();
    _effects = (widget.effects ?? farmEffects(ref.read(serverProvider))).listen((f) {
      switch (f) {
        case GameEffectReward():
          _inTurn('coin', 300);
        case GameEffectLevelUp():
          _inTurn('levelUp', 700);
        case GameEffectAchievement():
          _inTurn('achievement', 700);
        case GameEffectPenalty():
          break;
      }
    });
    _phase = widget.call?.phase;
    _problem = widget.call?.problem;
    widget.call?.addListener(_voice);
    // Rendered ahead, so the first sounds are not late.
    unawaited(Sfx.warm());
  }

  @override
  void dispose() {
    unawaited(_effects?.cancel());
    widget.call?.removeListener(_voice);
    super.dispose();
  }

  @override
  void didUpdateWidget(FarmSounds old) {
    super.didUpdateWidget(old);
    if (widget.tool != old.tool) Sfx.play('pick');
    final seen = {for (final f in old.bedFx) f.id};
    for (final f in widget.bedFx) {
      if (!seen.contains(f.id)) Sfx.play(_bedSound[f.kind] ?? 'nope');
    }
    for (final MapEntry(:key, :value) in widget.open.entries) {
      if ((old.open[key] ?? false) != value) Sfx.play(value ? 'open' : 'close');
    }
    if (widget.call != old.call) {
      old.call?.removeListener(_voice);
      widget.call?.addListener(_voice);
      _phase = widget.call?.phase;
      _problem = widget.call?.problem;
    }
  }

  void _voice() {
    final call = widget.call;
    if (call == null) return;
    final before = _phase;
    final problem = call.problem;
    _phase = call.phase;
    if (problem != null && problem != _problem) {
      Sfx.play('nope');
    } else if (call.phase != before) {
      if (call.phase == CallPhase.live) {
        Sfx.play('voiceOn');
      } else if (call.phase == CallPhase.idle && (before == CallPhase.live || before == CallPhase.ending)) {
        Sfx.play('voiceOff');
      }
    }
    _problem = problem;
  }

  @override
  Widget build(BuildContext context) {
    Sfx.setMuted(ref.watch(prefsProvider.select((p) => p.muted)));
    // The first state is the farm as it already was: nothing arrives in it.
    ref.listen(stateProvider, (prev, next) {
      if (prev != null && next != null) _sessions(prev.sessions, next.sessions);
    });
    return widget.child;
  }
}

void _sessions(List<Session> prev, List<Session> next) {
  final before = {for (final h in prev) h.id: h};
  for (final h in next) {
    final was = before[h.id];
    if (was == null) {
      Sfx.play('arrive');
    } else if (h.phase is PhaseRipe && was.phase is! PhaseRipe) {
      _inTurn('ripe', 220);
    } else if (h.phase is PhaseFailed && was.phase is! PhaseFailed) {
      Sfx.play('bug');
    }
  }
}

/// A finished job ripens, pays and may earn an achievement in the same moment, and played together those are one muddy chord: each waits for the one before,
/// then holds the floor for `hold` ms.
DateTime _floorFree = DateTime.fromMillisecondsSinceEpoch(0);

void _inTurn(String name, int hold) {
  final now = DateTime.now();
  final at = now.isAfter(_floorFree) ? now : _floorFree;
  _floorFree = at.add(Duration(milliseconds: hold));
  if (at == now) {
    Sfx.play(name);
  } else {
    Timer(at.difference(now), () => Sfx.play(name));
  }
}
