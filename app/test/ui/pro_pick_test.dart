import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/ui/pro/pro.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the placeholder is the one choice for no value, even when an option repeats it', (t) async {
    await pumpFarm(
      t,
      ProScope(
        child: Center(
          child: SizedBox(
            width: 200,
            child: ProPick(
              value: '',
              placeholder: '所有项目',
              semanticLabel: '按项目看',
              options: const [
                PickOption(value: '', label: '所有项目'),
                PickOption(value: 'site', label: 'site'),
              ],
              onChanged: (_) {},
            ),
          ),
        ),
      ),
      overrides: overrides(farm(), view(), fakeApi(Routes())),
    );
    await t.tap(find.text('所有项目'));
    await t.pumpAndSettle();
    expect(find.text('所有项目'), findsNWidgets(2), reason: 'the trigger and one choice in the menu');
    expect(find.text('site'), findsOneWidget);
  });
}
