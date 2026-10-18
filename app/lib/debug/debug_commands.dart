import 'dart:isolate';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/remote.dart' show SessionIssue, achievementsProvider;
import '../gen/vibevalley.dart';
import '../game/effects.dart';
import '../audio/sfx.dart';
import '../audio/synth.dart';

/// Null until the farm screen sets it.
class DebugHooks {
  const DebugHooks({required this.tod, required this.setTod, required this.daySpeed, required this.setDaySpeed, required this.openSession});

  /// 0..1, 0.5 is noon.
  final double Function() tod;
  final void Function(double tod) setTod;

  /// 0 stops it, 60 makes a day ten seconds.
  final double Function() daySpeed;
  final void Function(double speed) setDaySpeed;

  final void Function(String id) openSession;
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

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> start() => _api.manager.open();

  Future<void> hear(String text) => _api.channel.say(body: SayRequest(text: text));

  Future<void> tell(String id, String text) => _api.issue.comment(
    id: _issueOf(id),
    body: CommentRequest(text: text),
  );
  Future<void> stop(String id) => _api.session.stop(id: id);
  Future<void> dismiss(String id) => _api.issue.status(
    id: _issueOf(id),
    body: const IssueStatusRequest(status: IssueStatus.canceled),
  );
  Future<void> harvest(String id) => _api.issue.status(
    id: _issueOf(id),
    body: const IssueStatusRequest(status: IssueStatus.done),
  );

  String _issueOf(String session) => (ref.read(stateProvider)?.sessions ?? const <Session>[]).firstWhere((w) => w.id == session).issueId;

  Future<void> everyone(String action) async {
    for (final h in ref.read(stateProvider)?.sessions ?? const <Session>[]) {
      await (action == 'stop' ? stop(h.id) : dismiss(h.id));
    }
  }

  void open(String id) => ref.read(debugHooksProvider)?.openSession(id);

  void tod(double t) => ref.read(debugHooksProvider)?.setTod(t);
  void daySpeed(double n) => ref.read(debugHooksProvider)?.setDaySpeed(n);

  /// Nothing is earned: the level is the server's.
  void levelUp() => localEffects.add(GameEffectLevelUp(level: (ref.read(viewProvider)?.level.level ?? 1) + 1));

  /// Nothing is earned; the words are the server's list's (nothing before it is read).
  void achieve([String? id, int tier = 1]) {
    final all = ref.read(achievementsProvider).value ?? const <Achievement>[];
    if (all.isEmpty) return;
    final a = all.where((a) => a.id == id).firstOrNull ?? all[_achieved++ % all.length];
    final t = a.tiers[(tier - 1).clamp(0, a.tiers.length - 1)];
    localEffects.add(
      GameEffectAchievement(
        achievement: a.id,
        tier: tier.toDouble(),
        title: t.title,
        reached: t.reached,
        detail: a.detail,
        coins: t.coins,
        oneOff: a.tiers.length == 1,
      ),
    );
  }

  void play(String name) => Sfx.play(name);

  static Future<Map<String, Measure>> soundStats() => Isolate.run(() => {for (final name in sounds.keys) name: measure(renderSound(name))});
}

final hbProvider = Provider<Hb>(Hb.new);
