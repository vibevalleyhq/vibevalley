import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/game/commands.dart';
import 'package:vibevalley/game/tools.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:http/http.dart' as http;

import '../support/farm.dart';

void main() {
  final working = session('w1', name: '小吴', station: 0);
  final failed = session('w2', name: '阿郑', station: 1, phase: const PhaseFailed(), brief: '修登录');
  final ripe = session('w3', name: '老李', station: 2, phase: const PhaseRipe());
  final state = farm(sessions: [working, failed, ripe]);
  final v = view(
    plots: {
      'w1': const PlotView(crop: Crop.leafy),
      'w2': const PlotView(crop: Crop.withered),
      'w3': const PlotView(crop: Crop.carrot),
    },
  );

  Future<(ProviderContainer, Routes)> setUpFarm() async {
    final routes = Routes({
      'PUT /api/v1/issues/tw3/status': const Issue(
        id: 'tw3',
        number: 3,
        title: 'x',
        priority: Priority.medium,
        createdAt: 0,
        sessions: ['w3'],
        status: IssueStatus.canceled,
        moves: [],
      ).toJson(),
    });
    final c = ProviderContainer(overrides: overrides(state, v, fakeApi(routes)));
    addTearDown(c.dispose);
    c.listen(stateProvider, (_, _) {});
    await c.read(stateFrameProvider.future);
    return (c, routes);
  }

  Future<ToolResult> use(ProviderContainer c, Tool tool, int bed) async {
    c.read(heldToolProvider.notifier).set(tool);
    return c.read(farmCommandsProvider).act(c.read(farmCommandsProvider).aim(beds[bed]));
  }

  test('the hand opens a worked bed and sows an empty one', () async {
    final (c, routes) = await setUpFarm();
    expect(await use(c, Tool.hand, 0), isA<ToolInspect>().having((r) => r.sessionId, 'session', 'w1'));
    expect(await use(c, Tool.hand, 4), isA<ToolSow>().having((r) => r.station, 'station', 4));
    expect(routes.calls, isEmpty);
  });

  test('water opens the can; bug tells the failed helper to go on, with the spray over its bed', () async {
    final (c, routes) = await setUpFarm();
    expect(await use(c, Tool.water, 0), isA<ToolWater>());
    expect(await use(c, Tool.bug, 1), isA<ToolDone>());
    expect(routes.paths, ['POST /api/v1/issues/tw2/comment']);
    expect(routes.calls.single.body, {'text': '接着修：修登录。看一下报错，修好再跑一遍测试'});
    expect(c.read(bedFxProvider).single.kind, BedFxKind.spray);
    expect(c.read(bedFxProvider).single.bed, 1);
  });

  test('the command owns its feedback without caller effect plumbing', () async {
    final (c, _) = await setUpFarm();
    c.read(heldToolProvider.notifier).set(Tool.bug);
    final got = await c.read(farmCommandsProvider).act(c.read(farmCommandsProvider).aim(beds[0]));
    expect(got, isA<ToolRefused>());
    expect(c.read(bedFxProvider).single.kind, BedFxKind.note);
  });

  test('a click is decided once: the held tool can change between aim and act', () async {
    final (c, routes) = await setUpFarm();
    c.read(heldToolProvider.notifier).set(Tool.bug);
    final aim = c.read(farmCommandsProvider).aim(beds[1]);
    c.read(heldToolProvider.notifier).set(Tool.hand);
    expect(await c.read(farmCommandsProvider).act(aim), isA<ToolDone>());
    expect(routes.paths, ['POST /api/v1/issues/tw2/comment']);
  });

  test('harvest on a ripe bed asks to look at the changes first', () async {
    final (c, routes) = await setUpFarm();
    expect(await use(c, Tool.harvest, 2), isA<ToolReview>().having((r) => r.sessionId, 'session', 'w3'));
    expect(routes.calls, isEmpty);
  });

  test('the shovel stops a working helper and sends a resting one home', () async {
    final (c, routes) = await setUpFarm();
    await use(c, Tool.shovel, 0);
    await use(c, Tool.shovel, 2);
    expect(routes.paths, ['POST /api/v1/sessions/w1/stop', 'PUT /api/v1/issues/tw3/status']);
    expect(c.read(bedFxProvider).map((f) => f.kind), [BedFxKind.shovel, BedFxKind.shovel]);
  });

  test('a tool that does not apply says why over the bed, and sends nothing', () async {
    final (c, routes) = await setUpFarm();
    final r = await use(c, Tool.bug, 0);
    expect(r, isA<ToolRefused>().having((r) => r.text, 'text', '这块地没有虫'));
    final note = c.read(bedFxProvider).single;
    expect((note.kind, note.text, note.bed), (BedFxKind.note, '这块地没有虫', 0));
    expect(await use(c, Tool.hand, 7), isA<ToolRefused>().having((r) => r.text, 'text', 'Lv.8 开垦这块地'));
    expect(routes.calls, isEmpty);
  });

  testWidgets('a bed effect goes away after a moment', (tester) async {
    final c = ProviderContainer(overrides: overrides(state, v, fakeApi(Routes())));
    addTearDown(c.dispose);
    c.read(bedFxProvider.notifier).push(const BedFxEntry(1, 0, BedFxKind.water, null));
    expect(c.read(bedFxProvider), hasLength(1));
    await tester.pump(const Duration(milliseconds: 2300));
    expect(c.read(bedFxProvider), isEmpty);
  });

  test('sowing asks the manager with the bed and the agent', () async {
    final (c, routes) = await setUpFarm();
    await c.read(farmCommandsProvider).plant(3, '给 README 补上怎么启动', 'tester');
    expect(routes.paths, ['POST /api/v1/say']);
    expect(routes.calls.single.body, {'text': '给 README 补上怎么启动', 'bed': 3, 'agent': 'tester', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});
  });

  test('task commands answer with the server\'s words, or why not', () async {
    final routes = Routes();
    final c = ProviderContainer(
      overrides: overrides(
        state,
        v,
        fakeApi(routes, {
          'POST /api/v1/graphs/p1/act': '开工了',
          'POST /api/v1/graphs/p1/tasks/api/act': http.Response(
            jsonEncode({'_tag': 'Refused', 'reason': '这一步没失败，不用重试'}),
            409,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        }),
      ),
    );
    addTearDown(c.dispose);
    final ok = await c.read(farmCommandsProvider).actOnGraph('p1', GraphAction.start);
    expect((ok.ok, ok.text), (true, '开工了'));
    expect(routes.calls.single.body, {'action': 'start'});
    final no = await c.read(farmCommandsProvider).actOnTask('p1', 'api', TaskAction.retry);
    expect((no.ok, no.text), (false, '这一步没失败，不用重试'));
  });
}
