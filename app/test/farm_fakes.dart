import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/app/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/desk/shared/state.dart' show deskApiProvider;
import 'package:vibevalley/desktop/desktop.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/village/village_view.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

HelperPlay play(int station, {List<ActionStep> history = const [], List<String> files = const [], List<String> commands = const []}) =>
    HelperPlay(station: station.toDouble(), history: history, toolsThisTurn: 0, counts: const {}, files: files, commands: commands);

Helper helper(
  String id, {
  String name = '小吴',
  String agent = 'tester',
  int station = 0,
  Phase phase = const PhaseWorking(
    since: 0,
    doing: Doing(action: WorkerAction.editFile, label: 'src/a.ts'),
  ),
  String task = '跑一遍测试',
  String? project,
  String? branch,
  String? worktree,
  Conflict? conflict,
  LastTurn? last,
  HelperPlaybook? playbook,
  List<String> files = const [],
  List<String> commands = const [],
}) => Helper(
  id: id,
  name: name,
  agent: agent,
  runtime: 'claude',
  task: task,
  project: project,
  branch: branch,
  worktree: worktree,
  conflict: conflict,
  hiredAt: 0,
  turns: 1,
  phase: phase,
  last: last,
  playbook: playbook,
  play: play(station, files: files, commands: commands),
);

AgentProfile agent(String id, String name, {bool enabled = true, String species = 'raccoon'}) => AgentProfile.fromJson({
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
);

FarmState farm({List<Helper> helpers = const [], Progress? progress, Chat? chat, List<Issue>? issues}) =>
    FarmState(call: CallState.live, foreman: ForemanState.listening, helpers: helpers, progress: progress, chat: chat, issues: issues);

FarmView view({Map<String, PlotView> plots = const {}, int level = 3, int xp = 4}) => FarmView(
  level: FarmLevel(level: level.toDouble(), xp: xp.toDouble(), need: level * 10.0),
  plots: plots,
);

class Calls {
  final list = <({String method, String path, Object? body})>[];
  Iterable<String> get paths => list.map((c) => '${c.method} ${c.path}');
}

VibeValleyApi fakeApi(Calls calls, [Map<String, Object?> answers = const {}]) => VibeValleyApi(
  Uri.parse('http://127.0.0.1:8787'),
  MockClient((r) async {
    calls.list.add((method: r.method, path: r.url.path, body: r.body.isEmpty ? null : jsonDecode(r.body)));
    final key = '${r.method} ${r.url.path}';
    if (!answers.containsKey(key)) return http.Response('', 204);
    final a = answers[key];
    if (a is http.Response) return a;
    return http.Response(jsonEncode(a), 200, headers: {'content-type': 'application/json; charset=utf-8'});
  }),
);

List<Override> overrides(FarmState state, FarmView v, VibeValleyApi api, {Map<String, AgentProfile> agents = const {}, List<Playbook> plans = const []}) {
  final frame = StateFrame(SiteFrame(state: state, inbox: const [], plans: plans, view: v, effects: const []), bytes: 0, decodeMicros: 0);
  return [
    stateFrameProvider.overrideWith((ref) => Stream.value(frame)),
    agentsProvider.overrideWith((ref) async => agents),
    runtimesProvider.overrideWith((ref) => Stream.value(const <RuntimeInfo>[])),
    sideEventsProvider.overrideWith((ref) => const Stream<SiteEvent>.empty()),
    streamProblemProvider.overrideWith((ref) => const Stream<String>.empty()),
    farmApiProvider.overrideWithValue(api.farm),
    deskApiProvider.overrideWithValue(api),
    farmEffectsProvider.overrideWithValue(const Stream<GameEffect>.empty()),
    farmNoticesProvider.overrideWithValue(const Stream<SiteEvent>.empty()),
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

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void ignore(Future<Object?> f) => unawaited(f);
