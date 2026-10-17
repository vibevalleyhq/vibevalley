// The farm itself is the server's (farmProvider); nothing here copies it.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../shell/fx_layer.dart' show farmEffects;
import 'farm.dart';

class Held<T> extends Notifier<T> {
  Held(this._initial);
  final T _initial;

  @override
  T build() => _initial;

  void set(T value) => state = value;
}

NotifierProvider<Held<T>, T> _held<T>(T initial) => NotifierProvider<Held<T>, T>(() => Held<T>(initial));

enum FarmPanel { shop, warehouse, tasks, log, manager, plans }

final heldToolProvider = _held(Tool.hand);

final panelProvider = _held<FarmPanel?>(null);

final selectedProvider = _held<String?>(null);

final sowingProvider = _held<int?>(null);

final wateringProvider = _held<String?>(null);

final reviewingProvider = _held<String?>(null);

/// null: the newest still open.
final planShownProvider = _held<String?>(null);

final friendsOpenProvider = _held(false);

final menuOpenProvider = _held(false);

final farmEffectsProvider = Provider<Stream<GameEffect>>((ref) => farmEffects(ref.watch(serverProvider)));

class BedFxEntry {
  const BedFxEntry(this.id, this.bed, this.kind, this.text);
  final int id;
  final int bed;
  final BedFxKind kind;
  final String? text;
}

class Timed<T> extends Notifier<List<T>> {
  Timed(this.linger);
  final Duration linger;
  final _timers = <Timer>{};

  @override
  List<T> build() {
    ref.onDispose(() {
      for (final t in _timers) {
        t.cancel();
      }
    });
    return const [];
  }

  void push(T entry) {
    state = [...state, entry];
    late final Timer timer;
    timer = Timer(linger, () {
      _timers.remove(timer);
      state = [...state]..remove(entry);
    });
    _timers.add(timer);
  }
}

var _fxIds = 0;

final bedFxProvider = NotifierProvider<Timed<BedFxEntry>, List<BedFxEntry>>(() => Timed(const Duration(milliseconds: 2200)));

void burst(Ref ref, int bed, BedFxKind kind, [String? text]) => ref.read(bedFxProvider.notifier).push(BedFxEntry(++_fxIds, bed, kind, text));

final rewardsProvider = NotifierProvider<Timed<GameEffectReward>, List<GameEffectReward>>(() => Timed(const Duration(milliseconds: 4000)));

/// A message lands a moment after the step it ends: steps this much later still count as its turn.
const _slackMs = 3000;

List<SessionEvent> turnEndingAt(List<SessionEvent> steps, double at) {
  var end = -1;
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].time <= at + _slackMs) end = i;
  }
  if (end < 0) return const [];
  var start = end;
  while (start > 0 && steps[start].type != SessionEventType.userMessage) {
    start--;
  }
  return steps.sublist(start, end + 1);
}

class PlaybookLog extends Notifier<Map<String, List<PlaybookEvent>>> {
  @override
  Map<String, List<PlaybookEvent>> build() => const {};

  Future<void> load(String id) async {
    final events = await ref.read(apiProvider).playbook.events(id: id);
    state = {...state, id: events};
  }
}

final playbookLogProvider = NotifierProvider<PlaybookLog, Map<String, List<PlaybookEvent>>>(PlaybookLog.new);
