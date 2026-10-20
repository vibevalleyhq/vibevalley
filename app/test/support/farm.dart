import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/pixel/theme.dart';
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
    doing: Doing(action: SessionAction.editFile, label: 'src/a.ts', actionText: '改文件'),
  ),
  String brief = '跑一遍测试',
  String? project,
  String? branch,
  String? worktree,
  Conflict? conflict,
  LastRun? last,
  SessionGraph? graph,
  List<String> files = const [],
  List<String> commands = const [],
  List<ActionStep> history = const [],
  String? says,
  String? issue,
}) => Session(
  id: id,
  issue: issue ?? 't$id',
  name: name,
  agent: agent,
  runtime: 'claude',
  brief: brief,
  project: project,
  branch: branch,
  worktree: worktree,
  conflict: conflict,
  hiredAt: 0,
  runs: 1,
  phase: phase,
  lastRun: last,
  graph: graph,
  play: play(station, history: history, files: files, commands: commands),
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

AchievementTier _tier(int need, String title, int coins, String reached) =>
    AchievementTier(need: need.toDouble(), title: title, coins: coins.toDouble(), reached: reached);

/// What game.achievements answers: a few of each kind, in words as the server says them.
final achievementList = [
  Achievement(id: 's_open', category: AchievementCategory.starter, title: '开门', detail: '开工', wearable: false, tiers: [_tier(1, '开门', 20, '新手任务做完了')]),
  Achievement(id: 's_hire', category: AchievementCategory.starter, title: '派活', detail: '派出第一个帮工', wearable: false, tiers: [_tier(1, '派活', 20, '新手任务做完了')]),
  Achievement(
    id: 'harvests',
    category: AchievementCategory.harvest,
    title: '收成',
    detail: '收进主分支的活',
    unit: '件',
    wearable: true,
    tiers: [_tier(1, '开张大吉', 10, '解锁成就'), _tier(20, '小有收成', 30, '升到银牌'), _tier(100, '粮仓满了', 60, '升到金牌')],
  ),
  Achievement(
    id: 'first_try',
    category: AchievementCategory.harvest,
    title: '一气呵成',
    detail: '第一轮就做完的活',
    unit: '件',
    wearable: true,
    tiers: [_tier(1, '一气呵成', 10, '解锁成就'), _tier(10, '银牌一气呵成', 30, '升到银牌'), _tier(50, '金牌一气呵成', 60, '升到金牌')],
  ),
  Achievement(
    id: 'steady',
    category: AchievementCategory.craft,
    title: '稳如老农',
    detail: '最长连胜',
    unit: '件',
    wearable: true,
    tiers: [_tier(5, '稳如老农', 10, '解锁成就'), _tier(15, '银牌稳如老农', 30, '升到银牌'), _tier(40, '金牌稳如老农', 60, '升到金牌')],
  ),
  Achievement(id: 'night_owl', category: AchievementCategory.secret, title: '夜猫子', detail: '深夜收进一件活', wearable: true, tiers: [_tier(1, '夜猫子', 50, '发现一个彩蛋')]),
  Achievement(id: 'weekend', category: AchievementCategory.secret, title: '周末农夫', detail: '周末收进一件活', wearable: true, tiers: [_tier(1, '周末农夫', 50, '发现一个彩蛋')]),
];

/// How far the farm is with each, as the frame's view says it for progress below.
const standings = [
  AchievementStanding(id: 's_open', tier: 1, count: 1),
  AchievementStanding(id: 's_hire', tier: 0, count: 0, next: 1),
  AchievementStanding(id: 'harvests', tier: 1, count: 4, next: 20),
  AchievementStanding(id: 'first_try', tier: 0, count: 0, next: 1),
  AchievementStanding(id: 'steady', tier: 0, count: 3, next: 5),
  AchievementStanding(id: 'night_owl', tier: 0, count: 0, next: 1),
  AchievementStanding(id: 'weekend', tier: 0, count: 0, next: 1),
];

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

FarmView view({Map<String, PlotView> plots = const {}, int level = 3, int xp = 4, List<AchievementStanding> achievements = const []}) => FarmView(
  level: FarmLevel(level: level.toDouble(), xp: xp.toDouble(), need: level * 10.0),
  plots: plots,
  achievements: achievements,
);

/// The api of a FakeServer over routes, with more answers on top: what it was asked is routes.calls.
VibeValleyApi fakeApi(Routes routes, [Map<String, Object?> answers = const {}]) => FakeServer((routes..answers.addAll(answers)).handle).api;

List<Override> overrides(CoreState state, FarmView v, VibeValleyApi api, {Map<String, Agent> agents = const {}, List<TaskGraph> graphs = const []}) {
  final frame = ReceivedFrame(StateFrame(state: state, inbox: const [], graphs: graphs, view: v, effects: const []), bytes: 0, decodeMicros: 0);
  return [
    stateFrameProvider.overrideWith((ref) => Stream.value(frame)),
    agentsProvider.overrideWithValue(AsyncData(agents)),
    runtimesProvider.overrideWithValue(AsyncData(const <RuntimeInfo>[])),
    sideEventsProvider.overrideWith((ref) => const Stream<LiveEvent>.empty()),
    streamProblemProvider.overrideWith((ref) => const Stream<String>.empty()),
    apiProvider.overrideWithValue(api),
    farmEffectsProvider.overrideWithValue(const Stream<GameEffect>.empty()),
    hostProvider.overrideWithValue(Desktop.none),
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
