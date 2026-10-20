import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/shared/composer.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<ComposerDraft> pump(WidgetTester t, {required bool enterSends, ComposerSend? onSend}) async {
    final draft = ComposerDraft();
    addTearDown(draft.dispose);
    await pumpFarm(
      t,
      Composer(look: ComposerLook.inline, draft: draft, placeholder: '说一句', enterSends: enterSends, onSend: onSend),
      overrides: overrides(farm(), view(), fakeApi(Routes())),
    );
    return draft;
  }

  testWidgets('Enter sends and clears; a failed send puts the words back with the same key', (t) async {
    final sent = <(String, String)>[];
    var fail = true;
    final draft = await pump(
      t,
      enterSends: true,
      onSend: (text, key) async {
        sent.add((text, key));
        if (fail) throw StateError('断了');
      },
    );
    await t.enterText(find.byType(EditableText), '补一个测试');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(draft.text.text, '补一个测试', reason: 'the failed words come back');
    expect(draft.problem, contains('断了'));
    expect(find.textContaining('断了'), findsOneWidget);
    fail = false;
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(draft.text.text, isEmpty);
    expect(draft.problem, isNull);
    expect(sent.map((s) => s.$1), ['补一个测试', '补一个测试']);
    expect(sent[1].$2, sent[0].$2, reason: 'a retry is the words already said');
  });

  testWidgets('without enterSends, Enter starts a line and says nothing', (t) async {
    final sent = <String>[];
    final draft = await pump(t, enterSends: false, onSend: (text, _) async => sent.add(text));
    await t.enterText(find.byType(EditableText), '少一个测试');
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(sent, isEmpty);
    expect(draft.text.text, startsWith('少一个测试'));
    await t.tap(find.bySemanticsLabel('发送'));
    await t.pump();
    expect(sent, ['少一个测试']);
  });
}
