import 'dart:io';
import 'dart:ui' as ui;

import 'package:flame/game.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/server.dart' show atlas;
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/village/game.dart';
import 'package:vibevalley/village/level.dart';
import 'package:vibevalley/village/world.dart';

SessionPlay _play(int station) =>
    SessionPlay(station: station.toDouble(), history: const [], toolsThisRun: 0, counts: const {}, files: const [], commands: const [], runStartedAt: 0);

Session _session(String id, String agent, Phase phase, int station) =>
    Session(id: id, name: id, agent: agent, runtime: 'pi', brief: '写打卡', hiredAt: 0, runs: 1, phase: phase, play: _play(station));

PhaseWorking _doing(SessionAction action) => PhaseWorking(
  since: 0,
  doing: Doing(action: action, label: 'a.ts'),
);

VillageData _farm() {
  final sessions = [
    _session('w1', 'lab', _doing(SessionAction.editFile), 0),
    _session('w2', 'zhou', const PhaseRipe(), 1),
    _session('w3', 'kimi', _doing(SessionAction.readFile), 2),
    _session('w4', 'codex', _doing(SessionAction.runCommand), 3),
    _session('w5', 'pi', _doing(SessionAction.web), 4),
    _session('w6', 'oar', _doing(SessionAction.wait), 5),
    _session('w7', 'qwen', const PhaseArriving(), -1),
  ];
  final state = CoreState(call: CallState.idle, manager: ManagerState.speaking, sessions: sessions);
  final view = FarmView(
    level: const FarmLevel(level: 6, xp: 0, need: 60),
    plots: {
      'w1': const PlotView(crop: Crop.leafy),
      'w2': const PlotView(
        crop: Crop.wheat,
        badge: PlotViewBadge(text: '可收获', tone: BadgeTone.ripe),
      ),
      'w3': const PlotView(crop: Crop.sprout),
      'w4': const PlotView(crop: Crop.sprout),
      'w5': const PlotView(crop: Crop.seeded),
      'w6': const PlotView(crop: Crop.flowering),
      'w7': const PlotView(crop: Crop.empty),
    },
  );
  return VillageData(state, view, const {});
}

final _key = GlobalKey();

Future<VillageGame> _start(WidgetTester tester) async {
  final village = VillageWorld(Level.parse(File('assets/village.ldtk').readAsStringSync()));
  final game = VillageGame(atlas: atlas, village: village)..show(_farm());
  tester.view.physicalSize = Size(village.width * 3, village.height * 3);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.runAsync(() async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: _key,
        child: GameWidget(game: game),
      ),
    );
    // Loading every drawing and working out the normal maps takes real time.
    for (var i = 0; i < 200 && !game.isLoaded; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await tester.pump();
    }
    await Future<void>.delayed(const Duration(seconds: 2));
  });
  expect(game.isLoaded, isTrue);
  return game;
}

Future<void> _run(WidgetTester tester, double seconds) async {
  for (var i = 0; i < seconds * 20; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<void> _save(WidgetTester tester, String name) => tester.runAsync(() async {
  final boundary = _key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage();
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  Directory('build').createSync(recursive: true);
  File('build/village-$name.png').writeAsBytesSync(png!.buffer.asUint8List());
});

void main() {
  testWidgets('by day: helpers at their plots and at the buildings, a plot and a thing pointed at, coins', (tester) async {
    final game = await _start(tester);
    game.setTimeOfDay(0.45);
    await _run(tester, 12);
    expect(game.heads.keys.toSet(), {'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'});
    final library = game.village.places['library']!.at;
    final head = game.heads['w3']!;
    expect((head.x - library.x).abs() < 20 && (head.y + 31 - library.y).abs() < 6, isTrue, reason: 'w3 reads at the library: $head vs $library');
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    final plot = game.village.plotAt(6);
    await mouse.moveTo(Offset(plot.x * 3, (plot.y - 10) * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(game.hoverBed.value, 6);
    game
      ..play(const GameEffectReward(sessionId: 'w1', coins: 20, streak: 1))
      ..burst(BedFxKind.water, 6);
    await _run(tester, 0.3);
    await _save(tester, 'day');
    final shop = game.village.spotBoxes[YardPlace.shop]!;
    await mouse.moveTo(Offset((shop.x0 + shop.x1) / 2 * 3, (shop.y0 + shop.y1) / 2 * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(game.hoverSpot.value, YardPlace.shop);
    expect(game.hoverBed.value, isNull);
  });

  testWidgets('at night: lamps, lanterns and fireflies', (tester) async {
    final game = await _start(tester);
    game.setTimeOfDay(0.95);
    await _run(tester, 10);
    await _save(tester, 'night');
  });

  testWidgets('a click on a plot, a thing in the yard, a helper and the yard itself', (tester) async {
    final game = await _start(tester);
    final plots = <int>[];
    final spots = <YardPlace>[];
    game
      ..onPlot = plots.add
      ..onSpot = spots.add;
    await _run(tester, 12);
    final v = game.village;
    final locked = v.plotAt(8);
    await tester.tapAt(Offset(locked.x * 3, (locked.y - 3) * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(plots, [8]);
    final warehouse = v.spotBoxes[YardPlace.warehouse]!;
    await tester.tapAt(Offset((warehouse.x0 + warehouse.x1) / 2 * 3, (warehouse.y1 - 2) * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(spots, [YardPlace.warehouse]);
    final head = game.heads['w2']!;
    await tester.tapAt(Offset(head.x * 3, (head.y + 18) * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(plots, [8, 1]);
    await tester.tapAt(Offset(v.dog.x * 3, (v.dog.y - 4) * 3));
    await tester.tapAt(const Offset(30 * 3, 240 * 3));
    await tester.pump(const Duration(milliseconds: 50));
    expect(plots, [8, 1]);
    expect(spots, [YardPlace.warehouse]);
  });
}
