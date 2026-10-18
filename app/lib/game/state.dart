export '../data/overlays.dart' show farmOverlaysProvider, sowingProvider, wateringProvider, reviewingProvider, menuOpenProvider;
// The farm itself is the server's (stateProvider); nothing here copies it.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../gen/vibevalley.dart';
import './effects.dart' show farmEffects;
import 'tools.dart';

final heldToolProvider = held(Tool.hand);

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

class BedEffects extends Timed<BedFxEntry> {
  BedEffects() : super(const Duration(milliseconds: 2200));
  int _next = 0;

  void emit(int bed, BedFxKind kind, [String? text]) => push(BedFxEntry(++_next, bed, kind, text));
}

final bedFxProvider = NotifierProvider<BedEffects, List<BedFxEntry>>(BedEffects.new);

final rewardsProvider = NotifierProvider<Timed<GameEffectReward>, List<GameEffectReward>>(() => Timed(const Duration(milliseconds: 4000)));

class GraphHistory extends Notifier<Map<String, List<GraphEvent>>> {
  @override
  Map<String, List<GraphEvent>> build() => const {};

  Future<void> load(String id) async {
    final events = await ref.read(apiProvider).graph.events(id: id);
    state = {...state, id: events};
  }
}

final graphLogProvider = NotifierProvider<GraphHistory, Map<String, List<GraphEvent>>>(GraphHistory.new);
