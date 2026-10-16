import 'dart:isolate';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../fx_layer.dart';
import '../sfx.dart';
import '../synth.dart';
import '../../rules/progress.dart';

/// Null until the farm screen sets it.
class DebugHooks {
  const DebugHooks({required this.tod, required this.setTod, required this.daySpeed, required this.setDaySpeed, required this.openHelper});

  /// 0..1, 0.5 is noon.
  final double Function() tod;
  final void Function(double tod) setTod;

  /// 0 stops it, 60 makes a day ten seconds.
  final double Function() daySpeed;
  final void Function(double speed) setDaySpeed;

  final void Function(String id) openHelper;
}

final debugHooksProvider = NotifierProvider<DebugHooksNotifier, DebugHooks?>(DebugHooksNotifier.new);

class DebugHooksNotifier extends Notifier<DebugHooks?> {
  @override
  DebugHooks? build() => null;
  void set(DebugHooks? hooks) => state = hooks;
}

var _achieved = 0;

class Hb {
  Hb(this.ref);
  final Ref ref;

  VibeValleyApi get _api => ref.read(serverProvider).api;

  Future<void> start() => _api.farm.start();
  Future<void> end() => _api.farm.end();

  Future<void> hear(String text) => _api.farm.say(body: SayRequest(text: text));

  Future<void> tell(String id, String text) => _api.farm.tell(
    id: id,
    body: TellRequest(text: text),
  );
  Future<void> stop(String id) => _api.farm.stop(id: id);
  Future<void> dismiss(String id) => _api.farm.dismiss(id: id);
  Future<void> harvest(String id) => _api.farm.harvest(id: id);

  Future<void> everyone(String action) async {
    for (final h in ref.read(farmProvider)?.helpers ?? const <Helper>[]) {
      await (action == 'stop' ? stop(h.id) : dismiss(h.id));
    }
  }

  void open(String id) => ref.read(debugHooksProvider)?.openHelper(id);

  void tod(double t) => ref.read(debugHooksProvider)?.setTod(t);
  void daySpeed(double n) => ref.read(debugHooksProvider)?.setDaySpeed(n);

  /// Nothing is earned: the level is the server's.
  void levelUp() => localEffects.add(GameEffectLevelUp(level: (ref.read(viewProvider)?.level.level ?? 1) + 1));

  /// Nothing is earned.
  void achieve([String? id, int tier = 1]) {
    final shown = achievements[_achieved++ % achievements.length];
    localEffects.add(GameEffectAchievement(achievement: id ?? shown.id, tier: tier.toDouble()));
  }

  void play(String name) => Sfx.play(name);

  static Future<Map<String, Measure>> soundStats() => Isolate.run(() => {for (final name in sounds.keys) name: measure(renderSound(name))});
}

final hbProvider = Provider<Hb>(Hb.new);
