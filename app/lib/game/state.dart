// The farm screen's own state, as Riverpod state (web/src/farm/ui.ts, pixel/ui.ts, and what packages/core keeps beside
// the core state: the tool in hand, the effects over beds, the rewards just paid, each helper's work steps, the
// playbooks' histories; a helper's steps and the projects' names are lib/desk/shared/state.dart's). The farm itself is the server's (farmProvider); nothing here copies it.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../shell/fx_layer.dart' show farmEffects;
import 'farm.dart';

/// A value the screen sets and reads (an atom of web/src/farm/ui.ts).
class Held<T> extends Notifier<T> {
  Held(this._initial);
  final T _initial;

  @override
  T build() => _initial;

  void set(T value) => state = value;
}

NotifierProvider<Held<T>, T> _held<T>(T initial) => NotifierProvider<Held<T>, T>(() => Held<T>(initial));

/// The panels opened from things in the yard (farm/ui.ts Panel).
enum FarmPanel { shop, warehouse, tasks, log, manager, plans }

/// The tool in hand (core farm.ts tools).
final heldToolProvider = _held(Tool.hand);

/// The panel open, if any.
final panelProvider = _held<FarmPanel?>(null);

/// The helper whose bed details are open.
final selectedProvider = _held<String?>(null);

/// The station whose seed bag is open.
final sowingProvider = _held<int?>(null);

/// The helper the watering can is pointed at.
final wateringProvider = _held<String?>(null);

/// The helper whose harvest is being looked over before saying yes.
final reviewingProvider = _held<String?>(null);

/// The playbook the plan board shows; null: the newest still open.
final planShownProvider = _held<String?>(null);

/// The helpers' dock in the lower-left corner is open.
final friendsOpenProvider = _held(false);

/// The game menu (Esc) is open.
final menuOpenProvider = _held(false);

/// The server's commands, one place to fake them in tests.
final farmApiProvider = Provider<FarmApi>((ref) => ref.watch(serverProvider).api.farm);

/// The farm's effects as they come (coins, level-ups, achievements, penalties): one stream for the village, the FX
/// layer and the sounds; tests give their own.
final farmEffectsProvider = Provider<Stream<GameEffect>>((ref) => farmEffects(ref.watch(serverProvider)));

/// What happens beside the state (notices become toasts); tests give their own.
final farmNoticesProvider = Provider<Stream<SiteEvent>>((ref) => ref.watch(serverProvider).sideEvents);

// ── Short effects ────────────────────────────────────────────────────────────

class BedFxEntry {
  const BedFxEntry(this.id, this.bed, this.kind, this.text);
  final int id;
  final int bed;
  final BedFxKind kind;
  final String? text;
}

/// A list whose entries go away by themselves after `linger` (engine timedList).
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

/// Short effects on beds (by bed index): drops, a puff, "收进仓库", a word about why nothing happened (core bedFx).
final bedFxProvider = NotifierProvider<Timed<BedFxEntry>, List<BedFxEntry>>(() => Timed(const Duration(milliseconds: 2200)));

/// Pushes an effect on a bed; the farm screen plays it in the village and says a note over the plot.
void burst(Ref ref, int bed, BedFxKind kind, [String? text]) => ref.read(bedFxProvider.notifier).push(BedFxEntry(++_fxIds, bed, kind, text));

/// Coins just paid to a helper's bed, for a few seconds after (core gameFx, the rewards).
final rewardsProvider = NotifierProvider<Timed<GameEffectReward>, List<GameEffectReward>>(() => Timed(const Duration(milliseconds: 4000)));

// ── Work steps (the steps themselves are lib/desk/shared/state.dart's workStepsProvider) ──

/// A message lands a moment after the step it ends: steps this much later still count as its turn.
const _slackMs = 3000;

/// The steps of the turn that ended at `at`: from the last line it was told up to `at` (core trajectory.ts).
List<WorkStep> turnEndingAt(List<WorkStep> steps, double at) {
  var end = -1;
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].at <= at + _slackMs) end = i;
  }
  if (end < 0) return const [];
  var start = end;
  while (start > 0 && steps[start].kind != StepKind.asked) {
    start--;
  }
  return steps.sublist(start, end + 1);
}

/// Each playbook's history as last loaded, by playbook id (core playbookLog).
class PlaybookLog extends Notifier<Map<String, List<PlaybookEvent>>> {
  @override
  Map<String, List<PlaybookEvent>> build() => const {};

  Future<void> load(String id) async {
    final events = await ref.read(farmApiProvider).playbookEvents(id: id);
    state = {...state, id: events};
  }
}

final playbookLogProvider = NotifierProvider<PlaybookLog, Map<String, List<PlaybookEvent>>>(PlaybookLog.new);
