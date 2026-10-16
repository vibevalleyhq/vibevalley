import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/game/commands.dart';
import 'package:vibevalley/game/farm.dart';
import 'package:vibevalley/game/state.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:http/http.dart' as http;

import 'farm_fakes.dart';

void main() {
  final working = helper('w1', name: '小吴', station: 0);
  final failed = helper('w2', name: '阿郑', station: 1, phase: const PhaseFailed(), task: '修登录');
  final ripe = helper('w3', name: '老李', station: 2, phase: const PhaseRipe());
  final state = farm(helpers: [working, failed, ripe]);
  final v = view(
    plots: {
      'w1': const PlotView(crop: Crop.leafy),
      'w2': const PlotView(crop: Crop.withered),
      'w3': const PlotView(crop: Crop.carrot),
    },
  );

  Future<(ProviderContainer, Calls)> setUpFarm() async {
    final calls = Calls();
    final c = ProviderContainer(overrides: overrides(state, v, fakeApi(calls)));
    addTearDown(c.dispose);
    c.listen(farmProvider, (_, _) {});
    await c.read(stateFrameProvider.future);
    return (c, calls);
  }

  Future<ToolResult> use(ProviderContainer c, Tool tool, int bed) {
    c.read(heldToolProvider.notifier).set(tool);
    return c.read(farmCommandsProvider).applyTool(beds[bed]);
  }

  test('the hand opens a worked bed and sows an empty one', () async {
    final (c, calls) = await setUpFarm();
    expect(await use(c, Tool.hand, 0), isA<ToolInspect>().having((r) => r.workerId, 'worker', 'w1'));
    expect(await use(c, Tool.hand, 4), isA<ToolSow>().having((r) => r.station, 'station', 4));
    expect(calls.list, isEmpty);
  });

  test('water opens the can; bug tells the failed helper to go on, with the spray over its bed', () async {
    final (c, calls) = await setUpFarm();
    expect(await use(c, Tool.water, 0), isA<ToolWater>());
    expect(await use(c, Tool.bug, 1), isA<ToolDone>());
    expect(calls.paths, ['POST /api/workers/w2/tell']);
    expect(calls.list.single.body, {'text': '接着修：修登录。看一下报错，修好再跑一遍测试'});
    expect(c.read(bedFxProvider).single.kind, BedFxKind.spray);
    expect(c.read(bedFxProvider).single.bed, 1);
  });

  test('harvest on a ripe bed asks to look at the changes first', () async {
    final (c, calls) = await setUpFarm();
    expect(await use(c, Tool.harvest, 2), isA<ToolReview>().having((r) => r.workerId, 'worker', 'w3'));
    expect(calls.list, isEmpty);
  });

  test('the shovel stops a working helper and sends a resting one home', () async {
    final (c, calls) = await setUpFarm();
    await use(c, Tool.shovel, 0);
    await use(c, Tool.shovel, 2);
    expect(calls.paths, ['POST /api/workers/w1/stop', 'POST /api/workers/w3/dismiss']);
    expect(c.read(bedFxProvider).map((f) => f.kind), [BedFxKind.shovel, BedFxKind.shovel]);
  });

  test('a tool that does not apply says why over the bed, and sends nothing', () async {
    final (c, calls) = await setUpFarm();
    final r = await use(c, Tool.bug, 0);
    expect(r, isA<ToolRefused>().having((r) => r.text, 'text', '这块地没有虫'));
    final note = c.read(bedFxProvider).single;
    expect((note.kind, note.text, note.bed), (BedFxKind.note, '这块地没有虫', 0));
    expect(await use(c, Tool.hand, 7), isA<ToolRefused>().having((r) => r.text, 'text', 'Lv.8 开垦这块地'));
    expect(calls.list, isEmpty);
  });

  testWidgets('a bed effect goes away after a moment', (tester) async {
    final c = ProviderContainer(overrides: overrides(state, v, fakeApi(Calls())));
    addTearDown(c.dispose);
    c.read(bedFxProvider.notifier).push(const BedFxEntry(1, 0, BedFxKind.water, null));
    expect(c.read(bedFxProvider), hasLength(1));
    await tester.pump(const Duration(milliseconds: 2300));
    expect(c.read(bedFxProvider), isEmpty);
  });

  test('sowing asks the manager with the bed and the agent', () async {
    final (c, calls) = await setUpFarm();
    await c.read(farmCommandsProvider).plant(3, '给 README 补上怎么启动', 'tester');
    expect(calls.paths, ['POST /api/say']);
    expect(calls.list.single.body, {'text': '给 README 补上怎么启动', 'bed': 3, 'agent': 'tester'});
  });

  test('playbook commands answer with the server\'s words, or why not', () async {
    final calls = Calls();
    final c = ProviderContainer(
      overrides: overrides(
        state,
        v,
        fakeApi(calls, {
          'POST /api/playbooks/p1/act': '开工了',
          'POST /api/playbooks/p1/nodes/api/act': http.Response(
            jsonEncode({'_tag': 'FarmRefused', 'reason': '这一步没失败，不用重试'}),
            409,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        }),
      ),
    );
    addTearDown(c.dispose);
    final ok = await c.read(farmCommandsProvider).actOnPlaybook('p1', PlaybookAction.start);
    expect((ok.ok, ok.text), (true, '开工了'));
    expect(calls.list.single.body, {'action': 'start'});
    final no = await c.read(farmCommandsProvider).actOnNode('p1', 'api', NodeAction.retry);
    expect((no.ok, no.text), (false, '这一步没失败，不用重试'));
  });
}
