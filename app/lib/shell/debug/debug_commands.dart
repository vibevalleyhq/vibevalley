// The debug console's commands (web/src/debug/commands.ts `hb`), those that mean something against the real server:
// start and end the day, say something to the manager, tell, stop, dismiss and harvest a helper, the farm's clock
// (the village's own, through DebugHooks), a level-up banner or an achievement toast to look at, the sounds and their
// levels. The rest of `hb` drives the web page's in-browser mock (forcing states, hiring past the rules, facts,
// failure injection, the mock's clock, its ledger, the scenarios, replaying a log into the page's core); this client
// has no mock and folds no facts, so those are not here.

import 'dart:isolate';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../fx_layer.dart';
import '../sfx.dart';
import '../synth.dart';
import '../../rules/progress.dart';

/// What the farm screen lends the console: its clock and its bed panel. Null until the farm screen sets it.
class DebugHooks {
  const DebugHooks({required this.tod, required this.setTod, required this.daySpeed, required this.setDaySpeed, required this.openHelper});

  /// The time of day, 0..1 (0.5 is noon).
  final double Function() tod;
  final void Function(double tod) setTod;

  /// The farm clock's speed: 0 stops it, 60 makes a day ten seconds.
  final double Function() daySpeed;
  final void Function(double speed) setDaySpeed;

  /// Opens a helper's bed panel.
  final void Function(String id) openHelper;
}

final debugHooksProvider = NotifierProvider<DebugHooksNotifier, DebugHooks?>(DebugHooksNotifier.new);

class DebugHooksNotifier extends Notifier<DebugHooks?> {
  @override
  DebugHooks? build() => null;
  void set(DebugHooks? hooks) => state = hooks;
}

/// hb.achieve() without an id shows the achievements one after another.
var _achieved = 0;

class Hb {
  Hb(this.ref);
  final Ref ref;

  VibeValleyApi get _api => ref.read(serverProvider).api;

  // The call.
  Future<void> start() => _api.farm.start();
  Future<void> end() => _api.farm.end();

  /// As if the user said this to the manager.
  Future<void> hear(String text) => _api.farm.say(body: SayRequest(text: text));

  // Helpers.
  Future<void> tell(String id, String text) => _api.farm.tell(
    id: id,
    body: TellRequest(text: text),
  );
  Future<void> stop(String id) => _api.farm.stop(id: id);
  Future<void> dismiss(String id) => _api.farm.dismiss(id: id);
  Future<void> harvest(String id) => _api.farm.harvest(id: id);

  /// 全部叫停 / 全部收工: each helper on the farm in turn.
  Future<void> everyone(String action) async {
    for (final h in ref.read(farmProvider)?.helpers ?? const <Helper>[]) {
      await (action == 'stop' ? stop(h.id) : dismiss(h.id));
    }
  }

  void open(String id) => ref.read(debugHooksProvider)?.openHelper(id);

  // The farm's clock.
  void tod(double t) => ref.read(debugHooksProvider)?.setTod(t);
  void daySpeed(double n) => ref.read(debugHooksProvider)?.setDaySpeed(n);

  /// The level-up banner and its sound, for the next level (nothing is earned: the level is the server's).
  void levelUp() => localEffects.add(GameEffectLevelUp(level: (ref.read(viewProvider)?.level.level ?? 1) + 1));

  /// An achievement's toast and sound (nothing is earned), by default the next one in the list.
  void achieve([String? id, int tier = 1]) {
    final shown = achievements[_achieved++ % achievements.length];
    localEffects.add(GameEffectAchievement(achievement: id ?? shown.id, tier: tier.toDouble()));
  }

  // Sounds.
  void play(String name) => Sfx.play(name);

  /// Every sound rendered offline: peak (dBFS), loudness (K-weighted, loudest 100 ms) and length.
  static Future<Map<String, Measure>> soundStats() => Isolate.run(() => {for (final name in sounds.keys) name: measure(renderSound(name))});
}

final hbProvider = Provider<Hb>(Hb.new);
