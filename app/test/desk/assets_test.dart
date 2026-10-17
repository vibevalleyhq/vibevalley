import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/assets/assets_data.dart';
import 'package:vibevalley/desk/assets/assets_page.dart';
import 'package:vibevalley/audio/sfx.dart';

import '../support/desk.dart';

class _Silent implements SfxOutput {
  final played = <String>[];
  @override
  Future<void> play(String name, Uint8List wav) async => played.add(name);
}

void main() {
  final pictures = Pictures.parse(File('assets/pixel/sprites.json').readAsStringSync());

  test('the manifest in art pixels, with heads and sheets', () {
    final bear = pictures['bear-farmer-down']!;
    expect(bear.w, atlas['bear-farmer-down'].w);
    expect(bear.hx, isNotNull);
    expect(bear.sheet, 'design/pixel/raw/char-bear.png');
    expect(remakeOf(bear), (draw: 'design/pixel/gen.sh char-bear', cut: 'python3 design/pixel/process.py char-bear'));
  });

  test('shelves', () {
    expect(shelfOf('bear-farmer-down'), 'helpers');
    expect(shelfOf('manager-face'), 'manager');
    expect(shelfOf('map'), 'yard');
    expect(shelfOf('lang-go'), 'langs');
    expect(shelfOf('day-0'), 'ui');
    expect(shelfOf('connector-qq'), 'logos');
    expect(shelfOf('something-new'), 'other');
    final sessions = groupsOf('helpers', [
      for (final p in pictures.all)
        if (shelfOf(p.name) == 'helpers') p,
    ]);
    expect(sessions.first.label, '熊 · 农夫');
    expect(sessions.every((g) => g.pictures.every((p) => p.name.startsWith(g.key))), isTrue);
  });

  test('frames and matching', () {
    bool has(String n) => {'walk', 'walk-1', 'walk-2', 'run-1', 'run-2', 'run-3', 'lone-1'}.contains(n);
    expect(framesOf('walk', has), ['walk-1', 'walk', 'walk-2', 'walk']);
    expect(framesOf('run-2', has), ['run-1', 'run-2', 'run-3']);
    expect(framesOf('lone-1', has), isNull);
    expect(pictureMatches(pictures['bear-rain-down'] ?? pictures['bear-farmer-down']!, '熊'), isTrue);
    expect(pictureMatches(pictures['lang-go']!, '语言'), isTrue);
    expect(pictureMatches(pictures['lang-go']!, '熊'), isFalse);
    expect(naturalCompare('x-2', 'x-10'), lessThan(0));
  });

  testWidgets('the pictures shelf: counts, search and a picture in detail', (t) async {
    await pumpPage(t, const AssetsPage(shelf: 'sprites', id: 'plot-flowering'), Routes({}).handle);
    await settle(t);
    expect(find.text('全部'), findsOneWidget);
    expect(find.text('${pictures.all.length}'), findsOneWidget);
    expect(find.text('plot-flowering'), findsWidgets);
    expect(find.textContaining('design/pixel/gen.sh'), findsOneWidget);
    await t.enterText(find.bySemanticsLabel('找素材').last, 'lang-');
    await t.pump();
    expect(find.text('语言 · ${pictures.all.where((p) => p.name.startsWith('lang-')).length}'), findsOneWidget);
    expect(find.textContaining('帮工 · '), findsNothing);
  });

  testWidgets('the sounds shelf plays each sound', (t) async {
    final out = _Silent();
    Sfx.output = out;
    addTearDown(() => Sfx.output = null);
    await pumpPage(t, const AssetsPage(shelf: 'sounds'), Routes({}).handle);
    expect(find.text('奖励'), findsOneWidget);
    await t.tap(find.text('金币'));
    await t.runAsync(() => Future<void>.delayed(const Duration(seconds: 2)));
    expect(Sfx.played().last.name, 'coin');
  });
}
