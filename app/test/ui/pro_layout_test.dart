import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/ui/pro/pro.dart';
import 'package:vibevalley/workbench/shared/composer.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // A focused box's edge must not take room from its text: the caret would jump in when it is clicked.
  Future<void> holdsStill(WidgetTester t, Widget box) async {
    await pumpFarm(
      t,
      ProScope(
        child: Padding(padding: const EdgeInsets.all(24), child: box),
      ),
      overrides: overrides(farm(), view(), fakeApi(Routes())),
    );
    final text = find.byType(EditableText).first;
    final before = t.getTopLeft(text);
    await t.tap(text);
    await t.pump();
    expect(t.widget<EditableText>(text).focusNode.hasFocus, isTrue);
    expect(t.getTopLeft(text), before);
  }

  testWidgets('a text input keeps its text where it was when it takes the focus', (t) async {
    await holdsStill(t, ProTextInput(value: '', onChanged: (_) {}, placeholder: '写一张'));
  });

  testWidgets('a text area keeps its text where it was when it takes the focus', (t) async {
    await holdsStill(t, ProTextArea(value: '', onChanged: (_) {}, rows: 3));
  });

  testWidgets('the workbench composer keeps its text where it was when it takes the focus', (t) async {
    await holdsStill(t, const WorkbenchComposer(placeholder: '说一句'));
  });

  testWidgets('a button keeps its size when its tone changes', (t) async {
    Future<Size> sized(ProTone tone) async {
      await pumpFarm(
        t,
        ProScope(
          child: Center(
            child: ProButton.text('起草', tone: tone, onPressed: () {}),
          ),
        ),
        overrides: overrides(farm(), view(), fakeApi(Routes())),
      );
      return t.getSize(find.byType(ProButton));
    }

    final plain = await sized(ProTone.plain);
    for (final tone in ProTone.values) {
      expect(await sized(tone), plain, reason: '$tone');
    }
  });
}
