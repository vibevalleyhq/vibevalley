import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/messages.dart';
import '../gen/vibevalley.dart';
import '../data/remote.dart' show SessionIssue;
import 'tools.dart';
import 'state.dart';
import '../rules/task.dart';
import '../rules/issues.dart' show newIssueTitle;

final farmCommandsProvider = Provider<FarmCommands>(FarmCommands.new);

typedef WrittenIssue = ({Issue issue, String refused});

/// The plus: an issue made at once in the backlog. With words, they are its title and its draft (issue.draft) starts from
/// them. The issue is made even when the server refuses the draft (no project yet): `refused` says why.
Future<WrittenIssue> writeIssue(IssueApi api, {String text = '', String? project, String? agent}) async {
  final words = text.trim();
  final made = await api.create(
    body: IssueRequest(title: words.isEmpty ? newIssueTitle : words, project: project, assignee: agent),
  );
  if (words.isEmpty) return (issue: made, refused: '');
  try {
    return (
      issue: await api.draft(
        id: made.id,
        body: IssueDraftRequest(text: words),
      ),
      refused: '',
    );
  } on VibeValleyApiError catch (e) {
    return (issue: made, refused: e.reason);
  }
}

class FarmCommands {
  FarmCommands(this.ref);
  final Ref ref;

  VibeValleyApi get _api => ref.read(apiProvider);
  CoreState? get _farm => ref.read(stateProvider);

  void _fx(Session w, BedFxKind kind, [String? text]) {
    final bed = bedOfStation(stationOfSession(w));
    if (bed != null && ref.mounted) ref.read(bedFxProvider.notifier).emit(bed.index, kind, text);
  }

  /// `on`: a comment on that step of its trajectory.
  Future<void> water(Session w, String text, {String? sendKey}) async {
    await _api.issue.comment(
      id: w.issueId,
      body: CommentRequest(text: text, sendKey: sendKey),
    );
    _fx(w, BedFxKind.water);
  }

  /// The server tells it what its conflicts are and to settle them.
  Future<void> resolve(Session w) async {
    await _api.issue.resolve(id: w.issueId);
    _fx(w, BedFxKind.water);
  }

  Future<void> cure(Session w) async {
    await _api.issue.comment(
      id: w.issueId,
      body: CommentRequest(text: bugText(w.brief)),
    );
    _fx(w, BedFxKind.spray);
  }

  Future<void> harvest(Session w) async {
    await _api.issue.status(
      id: w.issueId,
      body: const IssueStatusRequest(status: IssueStatus.done),
    );
    _fx(w, BedFxKind.harvest, '收进仓库');
  }

  Future<void> shovel(Session w) async {
    if (w.phase is PhaseWorking) {
      await _api.session.stop(id: w.id);
    } else {
      await _api.issue.status(
        id: w.issueId,
        body: const IssueStatusRequest(status: IssueStatus.canceled),
      );
    }
    _fx(w, BedFxKind.shovel);
  }

  Future<void> stop(String id) => _api.session.stop(id: id);
  Future<void> stopManager() => _api.manager.stop();
  Future<void> dismiss(String id) => _api.issue.status(
    id: _issueOf(id),
    body: const IssueStatusRequest(status: IssueStatus.canceled),
  );

  String _issueOf(String session) => (_farm?.sessions ?? const <Session>[]).firstWhere((w) => w.id == session).issueId;

  /// `project`: the one the owner chose on the sowing form; the manager is told to sow it there.
  /// `station`: the farm plot it was sown on; none from the project map.
  Future<void> plant(String text, {int? station, String? agent, String? project}) =>
      ref.read(messagesProvider).send(text, sendKey: newSendKey(), station: station, agent: agent, project: project);

  /// A queued todo started, on this plot if there is one. Not ok: still waiting, or refused; the text is the server's why.
  Future<Answer> startQueued(String issue, {int? station}) async {
    final got = await _answer(() async {
      final d = await _api.issue.dispatch(
        id: issue,
        body: IssueDispatchRequest(station: station?.toDouble()),
      );
      return d.queued ?? '';
    });
    return (ok: got.ok && got.text.isEmpty, text: got.text);
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
  Future<ToolResult> act(PlotAim plot) async {
    final bed = plot.bed;
    final tool = plot.tool;
    final session = plot.session;
    final aim = plot.aim;
    if (!aim.ok || session == null) {
      if (aim.ok) return ToolSow(bed.station);
      ref.read(bedFxProvider.notifier).emit(bed.index, BedFxKind.note, aim.text);
      return ToolRefused(aim.text);
    }
    switch (tool) {
      case Tool.hand:
        return ToolInspect(session.id);
      case Tool.water:
        return ToolWater(session.id);
      case Tool.bug:
        await cure(session);
        return const ToolDone();
      case Tool.harvest:
        return ToolReview(session.id);
      case Tool.shovel:
        await shovel(session);
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

  Future<Answer> split(GraphSplitRequest request) => _answer(() => _api.graph.split(body: request));
  Future<Answer> editTask(String id, String task, TaskEdit edit) => _answer(() => _api.graph.updateTask(id: id, task: task, body: edit));
  Future<Answer> removeTask(String id, String task) => _answer(() => _api.graph.deleteTask(id: id, task: task));
  Future<Answer> actOnGraph(String id, GraphAction action) => _answer(
    () => _api.graph.act(
      id: id,
      body: GraphActRequest(action: action),
    ),
  );
  Future<Answer> actOnTask(String id, String task, TaskAction action) => _answer(
    () => _api.graph.taskAct(
      id: id,
      task: task,
      body: TaskActRequest(action: action),
    ),
  );

  Future<void> chooseTitle([String? achievement, int? tier]) => _api.game.chooseTitle(
    body: ChooseTitleRequest(achievement: achievement, tier: tier?.toDouble()),
  );

  Future<void> refreshRuntime(String id) => _api.runtime.refresh(id: id);
}

/// A refusal is the server's to tell (a notice).
void fire(Future<Object?> command) => unawaited(command.then((_) {}, onError: (Object _) {}));
