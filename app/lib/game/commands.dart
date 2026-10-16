// The player's moves on the farm, as the client sends them (packages/core farm.ts water/cure/harvest/shovel/plant and
// applyTool, session.ts say/whenLive, playbooks.ts): each is a server command, plus the effect over the bed it was for.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../village/village_view.dart' show agentsProvider;
import 'farm.dart';
import 'state.dart';
import '../rules/playbook.dart';
import '../rules/session.dart';

final farmCommandsProvider = Provider<FarmCommands>(FarmCommands.new);

class FarmCommands {
  FarmCommands(this.ref);
  final Ref ref;

  FarmApi get _api => ref.read(farmApiProvider);
  FarmState? get _farm => ref.read(farmProvider);

  void _burst(Helper w, BedFxKind kind, [String? text]) {
    final bed = bedOfStation(stationOfHelper(w));
    if (bed != null) burst(ref, bed.index, kind, text);
  }

  /// 浇水: a word for the helper; a working one reads it before its next step, an idle one works another turn. `on`:
  /// a comment on that step of its trajectory.
  Future<void> water(Helper w, String text, {int? on}) async {
    await _api.tell(
      id: w.id,
      body: TellRequest(text: text, on: on?.toDouble()),
    );
    _burst(w, BedFxKind.water);
  }

  /// 杀虫: the failed job again, with the error in mind.
  Future<void> cure(Helper w) async {
    await _api.tell(
      id: w.id,
      body: TellRequest(text: bugText(w.task)),
    );
    _burst(w, BedFxKind.spray);
  }

  /// 收获: keep what it made, and let it go home.
  Future<void> harvest(Helper w) async {
    await _api.harvest(id: w.id);
    _burst(w, BedFxKind.harvest, '收进仓库');
  }

  /// 铲除: stop it if it is working, otherwise send it home.
  Future<void> shovel(Helper w) async {
    if (w.phase is PhaseWorking) {
      await _api.stop(id: w.id);
    } else {
      await _api.dismiss(id: w.id);
    }
    _burst(w, BedFxKind.shovel);
  }

  Future<void> stop(String id) => _api.stop(id: id);
  Future<void> dismiss(String id) => _api.dismiss(id: id);

  /// The agent picked for the next job, if it still exists (core pickedAgent).
  String? get pickedAgent {
    final pick = ref.read(prefsProvider).pick;
    final agents = ref.read(agentsProvider).value ?? const {};
    return pick != 'auto' && agents.containsKey(pick) ? pick : null;
  }

  /// Whether the call is live, starting it first if needed: you can plant before you have said hello (core whenLive).
  Future<bool> whenLive() async {
    final now = _farm?.call;
    if (now == CallState.live) return true;
    if (now != CallState.connecting) unawaited(_api.start().catchError((Object _) {}));
    final until = DateTime.now().add(connectWait);
    while (DateTime.now().isBefore(until)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final call = _farm?.call;
      if (call == CallState.live) return true;
      if (call == CallState.error) return false;
    }
    return false;
  }

  /// 播种: a job for this bed, to this agent (or the picked one, or the manager's pick); starts the call if needed.
  Future<void> plant(int station, String text, [String? agent]) async {
    if (!await whenLive()) return;
    await _api.say(
      body: SayRequest(text: text, bed: station.toDouble(), agent: agent ?? pickedAgent),
    );
  }

  /// Uses the tool in hand on `bed` (core applyTool): when it does not apply, the reason is said over the bed.
  Future<ToolResult> applyTool(Bed bed) async {
    final tool = ref.read(heldToolProvider);
    final state = _farm;
    final view = ref.read(viewProvider);
    final worker = state == null ? null : stationOf(state.helpers, bed.station);
    final level = view?.level.level.round() ?? 1;
    final aim = aimTool(tool, bed, worker, view == null ? const PlotView(crop: Crop.empty) : plotOf(view, worker), level);
    if (!aim.ok || worker == null) {
      if (aim.ok) return ToolSow(bed.station);
      burst(ref, bed.index, BedFxKind.note, aim.text);
      return ToolRefused(aim.text);
    }
    switch (tool) {
      case Tool.hand:
        return ToolInspect(worker.id);
      case Tool.water:
        return ToolWater(worker.id);
      case Tool.bug:
        await cure(worker);
        return const ToolDone();
      case Tool.harvest:
        // The server says what the harvest would merge: look before saying yes.
        return ToolReview(worker.id);
      case Tool.shovel:
        await shovel(worker);
        return const ToolDone();
      case Tool.weed:
        return const ToolDone();
    }
  }

  Future<Answer> _answer(Future<String> Function() call) async {
    try {
      return (ok: true, text: await call());
    } on VibeValleyApiError catch (e) {
      return (ok: false, text: e.reason);
    } on Object catch (e) {
      return (ok: false, text: '$e');
    }
  }

  Future<Answer> plan(PlanRequest request) => _answer(() => _api.plan(body: request));
  Future<Answer> editNode(String id, String node, NodeEdit edit) => _answer(() => _api.editNode(id: id, node: node, body: edit));
  Future<Answer> removeNode(String id, String node) => _answer(() => _api.removeNode(id: id, node: node));
  Future<Answer> actOnPlaybook(String id, PlaybookAction action) => _answer(
    () => _api.playbookAct(
      id: id,
      body: PlaybookActRequest(action: action),
    ),
  );
  Future<Answer> actOnNode(String id, String node, NodeAction action) => _answer(
    () => _api.nodeAct(
      id: id,
      node: node,
      body: NodeActRequest(action: action),
    ),
  );

  /// Wears a tier of an achievement as the farm's title, or none (core chooseTitle).
  Future<void> chooseTitle([String? achievement, int? tier]) => _api.chooseTitle(
    body: ChooseTitleRequest(achievement: achievement, tier: tier?.toDouble()),
  );

  /// Asks every usable runtime's account again (Quota.tsx 现在读一次).
  Future<void> refreshRuntime(String id) => _api.refreshRuntime(id: id);
}

/// Runs a command and forgets it: a refusal is the server's to tell (a notice), as the web page's `fire`.
void fire(Future<Object?> command) => unawaited(command.then((_) {}, onError: (Object _) {}));
