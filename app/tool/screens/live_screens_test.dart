// Every page of the app, drawn against a running vibevalley server, each to build/live-<page>.png: a look at the real
// thing without a screen recorder. Not part of `flutter test` (it needs a server):
//
//   VIBEVALLEY_SERVER=http://127.0.0.1:8787 flutter test tool/screens/live_screens_test.dart
//   VIBEVALLEY_SCREEN=390x844 …     # at a phone's size (default 1440x900)
//   VIBEVALLEY_EXTRA='bed=/issues/w2,…' …   # more pages, name=route (with |text as in `pages`)
//   VIBEVALLEY_FRAMES=40,90,150 …   # after a tap, also build/live-<page>@<ms>ms.png that long after it: a transition

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/app/router.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/app/app.dart';
import 'package:vibevalley/data/ui_state.dart';

// name: route, or 'route|text' to tap the (last) widget showing that text once the page is up: a tab, a panel's
// button; with no such text, the one with it as its tooltip or semantic label (an icon button). VIBEVALLEY_PAGES=name,
// name… draws only those.
const pages = {
  'title': '/',
  'farm': '/',
  'chat': '/chat',
  'tickets': '/issues',
  'ticket': '/issues/w11',
  'ticket-planned': '/issues/w13',
  'ticket-new': '/issues/new',
  'map': '/projects',
  'map-island': '/projects/pb-smoke',
  'gate': '/settings/gate',
  'agents': '/agents',
  'agent': '/agents/backend',
  'agent-runtime': '/agents/backend|能力',
  'agent-persona': '/agents/backend|人设',
  'agent-skills': '/agents/backend|技能',
  'agent-tools': '/agents/backend|工具',
  'agent-env': '/agents/backend|环境',
  'agent-memory': '/agents/backend|记性',
  'agent-trajectories': '/agents/backend|轨迹',
  'manager': '/manager',
  'manager-trajectory': '/manager/trajectory',
  'manager-archive': '/manager/archive',
  'manager-voice': '/manager/voice',
  'runtimes': '/runtimes',
  'runtime': '/runtimes/claude',
  'runtime-codex': '/runtimes/codex',
  'runtime-pi': '/runtimes/pi',
  'runtime-kimi': '/runtimes/kimi',
  'runtime-cursor': '/runtimes/cursor',
  'skills': '/settings/skills',
  'connectors': '/settings/connectors',
  'connector-feishu': '/settings/connectors/feishu',
  'connector-qq': '/settings/connectors/qq',
  'projects': '/projects',
  'voice': '/settings/voice',
  'assets': '/catalog',
  'assets-cursors': '/catalog/cursors',
  'assets-sounds': '/catalog/sounds',
};

void main() {
  final address = Platform.environment['VIBEVALLEY_SERVER'];
  testWidgets('every page against a live server', (tester) async {
    if (address == null) return markTestSkipped('VIBEVALLEY_SERVER is not set');
    final semantics = tester.ensureSemantics();
    // Real sockets: flutter_test answers every HTTP request with 400 unless told otherwise.
    HttpOverrides.global = null;
    await tester.runAsync(() async {
      final font = FontLoader(pixelFont)
        ..addFont(Future.value(ByteData.sublistView(File('assets/fonts/fusion-pixel-12px-proportional-zh_hans.otf').readAsBytesSync())));
      await font.load();
      // The code font (theme monoFont): the app finds Menlo on the system; flutter_test only has what it is given.
      final mono = FontLoader(monoFont)..addFont(Future.value(ByteData.sublistView(File('/System/Library/Fonts/SFNSMono.ttf').readAsBytesSync())));
      await mono.load();
    });
    final [width, height] = (Platform.environment['VIBEVALLEY_SCREEN'] ?? '1440x900').split('x').map(double.parse).toList();
    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1;
    final key = GlobalKey();
    await tester.runAsync(() async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [serverProvider.overrideWithValue(VibeValleyServer(Uri.parse(address))), hostProvider.overrideWithValue(Desktop.none)],
          child: RepaintBoundary(key: key, child: const VibeValleyApp()),
        ),
      );
      final container = ProviderScope.containerOf(key.currentContext!);
      final only = Platform.environment['VIBEVALLEY_PAGES']?.split(',');
      final frames = [for (final ms in (Platform.environment['VIBEVALLEY_FRAMES'] ?? '').split(',')) ?int.tryParse(ms)]..sort();
      final extra = {
        for (final e in (Platform.environment['VIBEVALLEY_EXTRA'] ?? '').split(',').where((e) => e.contains('=')))
          e.substring(0, e.indexOf('=')): e.substring(e.indexOf('=') + 1),
      };
      for (final MapEntry(key: name, value: target) in {...pages, ...extra}.entries) {
        if (only != null && !only.contains(name) && !extra.containsKey(name)) continue;
        final [path, ...tap] = target.split('|');
        // The title screen shows over the farm until it is left.
        if (name == 'title') {
          container.read(titleOpenProvider.notifier).show();
        } else {
          container.read(titleOpenProvider.notifier).enterFarm(start: false);
        }
        router.go(path);
        for (var i = 0; i < 60; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(router.routeInformationProvider.value.uri.path, path, reason: '$name must render its requested route');
        Future<void> shoot(String file) async {
          final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
          final image = await boundary.toImage();
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          Directory('build').createSync(recursive: true);
          File(file).writeAsBytesSync(png!.buffer.asUint8List());
        }

        if (tap.isNotEmpty) {
          final target = _target(tap.first).last;
          await tester.ensureVisible(target);
          await tester.tap(target);
          var at = 0;
          for (final ms in frames) {
            await tester.pump(Duration(milliseconds: ms - at));
            at = ms;
            await shoot('build/live-$name@${ms}ms.png');
          }
          for (var i = 0; i < 30; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 50));
            await tester.pump(const Duration(milliseconds: 50));
          }
        }
        for (final e in find.byType(Image).evaluate()) {
          await precacheImage((e.widget as Image).image, e);
        }
        await tester.pump(const Duration(milliseconds: 50));
        await shoot('build/live-$name.png');
      }
    });
    semantics.dispose();
  });
}

Finder _target(String text) {
  for (final found in [find.text(text), find.byTooltip(text), find.bySemanticsLabel(text)]) {
    if (found.evaluate().isNotEmpty) return found;
  }
  return find.text(text);
}
