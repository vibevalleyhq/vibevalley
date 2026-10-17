import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'server.dart';

export 'server.dart';
import 'package:vibevalley/data/remote.dart';

SessionPlay play(int station, {List<ActionStep> history = const [], List<String> files = const [], List<String> commands = const []}) =>
    SessionPlay(station: station.toDouble(), history: history, toolsThisRun: 0, counts: const {}, files: files, commands: commands);

Session session(
  String id, {
  String name = '小吴',
  String agent = 'tester',
  int station = 0,
  Phase phase = const PhaseWorking(
    since: 0,
    doing: Doing(action: SessionAction.editFile, label: 'src/a.ts'),
  ),
  String task = '跑一遍测试',
  String? project,
  String? branch,
  String? worktree,
  Conflict? conflict,
  LastRun? last,
  SessionPlaybook? playbook,
  List<String> files = const [],
  List<String> commands = const [],
  String? says,
  String? issue,
}) => Session(
  id: id,
  issue: issue ?? 't$id',
  name: name,
  agent: agent,
  runtime: 'claude',
  task: task,
  project: project,
  branch: branch,
  worktree: worktree,
  conflict: conflict,
  hiredAt: 0,
  runs: 1,
  phase: phase,
  lastRun: last,
  playbook: playbook,
  play: play(station, files: files, commands: commands),
  phaseText: says,
);

Agent agent(String id, String name, {bool enabled = true, String species = 'raccoon'}) => Agent.fromJson({
  'id': id,
  'name': name,
  'role': '跑测试的',
  'enabled': enabled,
  'runtime': 'claude',
  'model': '',
  'effort': '',
  'persona': '',
  'personaMode': 'append',
  'skills': <String>[],
  'mcpServers': <Object>[],
  'disallowedTools': <String>[],
  'env': <String, String>{},
  'workdir': '',
  'worktree': true,
  'tags': <String>[],
  'look': {'species': species, 'outfit': 'farmer', 'build': 'biped', 'head': 'rounded', 'body': '#fff', 'trim': '#000', 'hat': '#f00', 'eye': '#0ff'},
});

const progress = Progress(
  coins: 120,
  streak: 3,
  bestStreak: 3,
  counts: {'harvests': 4, 'steady': 3},
  unlocked: [
    Unlock(id: 's_open', tier: 1, at: 0),
    Unlock(id: 'harvests', tier: 1, at: 0),
  ],
  multiplier: 1.2,
);

CoreState farm({List<Session> sessions = const [], Progress? progress, Chat? chat, List<Issue>? issues}) =>
    CoreState(call: CallState.live, manager: ManagerState.listening, sessions: sessions, progress: progress, chat: chat, issues: issues);

FarmView view({Map<String, PlotView> plots = const {}, int level = 3, int xp = 4}) => FarmView(
  level: FarmLevel(level: level.toDouble(), xp: xp.toDouble(), need: level * 10.0),
  plots: plots,
);

/// The api of a FakeServer over routes, with more answers on top: what it was asked is routes.calls.
VibeValleyApi fakeApi(Routes routes, [Map<String, Object?> answers = const {}]) => FakeServer((routes..answers.addAll(answers)).handle).api;

List<Override> overrides(CoreState state, FarmView v, VibeValleyApi api, {Map<String, Agent> agents = const {}, List<Playbook> plans = const []}) {
  final frame = ReceivedFrame(StateFrame(state: state, inbox: const [], plans: plans, view: v, effects: const []), bytes: 0, decodeMicros: 0);
  return [
    stateFrameProvider.overrideWith((ref) => Stream.value(frame)),
    agentsProvider.overrideWithValue(AsyncData(agents)),
    runtimesProvider.overrideWithValue(AsyncData(const <RuntimeInfo>[])),
    sideEventsProvider.overrideWith((ref) => const Stream<SideEvent>.empty()),
    streamProblemProvider.overrideWith((ref) => const Stream<String>.empty()),
    apiProvider.overrideWithValue(api),
    farmEffectsProvider.overrideWithValue(const Stream<GameEffect>.empty()),
    desktopProvider.overrideWithValue(Desktop.none),
  ];
}

Future<ProviderContainer> pumpFarm(WidgetTester tester, Widget child, {required List<Override> overrides}) async {
  tester.view.physicalSize = const Size(1440, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(overrides: overrides);
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: farmTheme(),
        home: Scaffold(body: child),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  return container;
}

void ignore(Future<Object?> f) => unawaited(f);
