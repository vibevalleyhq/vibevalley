import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/server.dart' show connectWait;
import '../gen/vibevalley.dart';
import '../data/prefs.dart';
import '../data/remote.dart' show agentsProvider, SessionIssue;
import 'tools.dart';
import 'state.dart';
import '../rules/playbook.dart';

final farmCommandsProvider = Provider<FarmCommands>(FarmCommands.new);

class FarmCommands {
  FarmCommands(this.ref);
  final Ref ref;

  VibeValleyApi get _api => ref.read(apiProvider);
  CoreState? get _farm => ref.read(stateProvider);

  List<BedEffect> _fx(Session w, BedFxKind kind, [String? text]) {
    final bed = bedOfStation(stationOfSession(w));
    return bed == null ? const [] : [BedEffect(bed.index, kind, text)];
  }

  /// `on`: a comment on that step of its trajectory.
  Future<List<BedEffect>> water(Session w, String text, {int? on}) async {
    await _api.issue.comment(
      id: w.issueId,
      body: CommentRequest(text: text, on: on?.toDouble()),
    );
    return _fx(w, BedFxKind.water);
  }

  /// The server tells it what its conflicts are and to settle them.
  Future<List<BedEffect>> resolve(Session w) async {
    await _api.issue.resolve(id: w.issueId);
    return _fx(w, BedFxKind.water);
  }

  Future<List<BedEffect>> cure(Session w) async {
    await _api.issue.comment(
      id: w.issueId,
      body: CommentRequest(text: bugText(w.task)),
    );
    return _fx(w, BedFxKind.spray);
  }

  Future<List<BedEffect>> harvest(Session w) async {
    await _api.issue.merge(id: w.issueId);
    return _fx(w, BedFxKind.harvest, '收进仓库');
  }

  Future<List<BedEffect>> shovel(Session w) async {
    if (w.phase is PhaseWorking) {
      await _api.session.stop(id: w.id);
    } else {
      await _api.issue.cancel(id: w.issueId);
    }
    return _fx(w, BedFxKind.shovel);
  }

  Future<void> stop(String id) => _api.session.stop(id: id);
  Future<void> dismiss(String id) => _api.issue.cancel(id: _issueOf(id));

  String _issueOf(String session) => (_farm?.sessions ?? const <Session>[]).firstWhere((w) => w.id == session).issueId;

  String? get pickedAgent {
    final pick = ref.read(prefsProvider).pick;
    final agents = ref.read(agentsProvider).value ?? const {};
    return pick != 'auto' && agents.containsKey(pick) ? pick : null;
  }

  /// You can plant before you have said hello.
  Future<bool> whenLive() async {
    final now = _farm?.call;
    if (now == CallState.live) return true;
    if (now != CallState.connecting) unawaited(_api.manager.open().catchError((Object _) {}));
    final until = DateTime.now().add(connectWait);
    while (DateTime.now().isBefore(until)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      final call = _farm?.call;
      if (call == CallState.live) return true;
      if (call == CallState.error) return false;
    }
    return false;
  }

  Future<void> plant(int station, String text, [String? agent]) async {
    if (!await whenLive()) return;
    await _api.channel.say(
      body: SayRequest(text: text, bed: station.toDouble(), agent: agent ?? pickedAgent),
    );
  }

  /// The click's decision: read the farm once, so the page's sound and the command use the same aim.
  PlotAim aim(Bed bed) {
    final tool = ref.read(heldToolProvider);
    final state = _farm;
    final view = ref.read(viewProvider);
    final session = state == null ? null : stationOf(state.sessions, bed.station);
    final level = view?.level.level.round() ?? 1;
    final aim = aimTool(tool, bed, session, view == null ? const PlotView(crop: Crop.empty) : plotOf(view, session), level);
    return PlotAim(bed: bed, tool: tool, session: session, aim: aim);
  }

  /// When the tool does not apply, the reason is said over the bed.
  Future<PlotResult> act(PlotAim plot) async {
    final bed = plot.bed;
    final tool = plot.tool;
    final session = plot.session;
    final aim = plot.aim;
    if (!aim.ok || session == null) {
      if (aim.ok) return PlotResult(ToolSow(bed.station), const []);
      final effects = [BedEffect(bed.index, BedFxKind.note, aim.text)];
      return PlotResult(ToolRefused(aim.text), effects);
    }
    switch (tool) {
      case Tool.hand:
        return PlotResult(ToolInspect(session.id), const []);
      case Tool.water:
        return PlotResult(ToolWater(session.id), const []);
      case Tool.bug:
        return PlotResult(const ToolDone(), await cure(session));
      case Tool.harvest:
        return PlotResult(ToolReview(session.id), const []);
      case Tool.shovel:
        return PlotResult(const ToolDone(), await shovel(session));
      case Tool.weed:
        return PlotResult(const ToolDone(), const []);
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

  Future<Answer> plan(PlanRequest request) => _answer(() => _api.playbook.plan(body: request));
  Future<Answer> editNode(String id, String node, NodeEdit edit) => _answer(() => _api.playbook.updateNode(id: id, node: node, body: edit));
  Future<Answer> removeNode(String id, String node) => _answer(() => _api.playbook.deleteNode(id: id, node: node));
  Future<Answer> actOnPlaybook(String id, PlaybookAction action) => _answer(
    () => _api.playbook.act(
      id: id,
      body: PlaybookActRequest(action: action),
    ),
  );
  Future<Answer> actOnNode(String id, String node, NodeAction action) => _answer(
    () => _api.playbook.nodeAct(
      id: id,
      node: node,
      body: NodeActRequest(action: action),
    ),
  );

  Future<void> chooseTitle([String? achievement, int? tier]) => _api.game.chooseTitle(
    body: ChooseTitleRequest(achievement: achievement, tier: tier?.toDouble()),
  );

  Future<void> refreshRuntime(String id) => _api.runtime.refresh(id: id);
}

/// A refusal is the server's to tell (a notice).
void fire(Future<Object?> command) => unawaited(command.then((_) {}, onError: (Object _) {}));
