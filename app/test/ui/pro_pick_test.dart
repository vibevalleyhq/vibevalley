import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/ui/pixel/pixel.dart';
import 'package:vibevalley/ui/pro/pro.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> open(WidgetTester t, Widget pick, String trigger) async {
    await pumpFarm(
      t,
      ProScope(
        child: Center(child: SizedBox(width: 200, child: pick)),
      ),
      overrides: overrides(farm(), view(), fakeApi(Routes())),
    );
    await t.tap(find.text(trigger));
    await t.pumpAndSettle();
  }

  testWidgets('a clearable pick lists no value once, as its placeholder, even when an option repeats it', (t) async {
    await open(
      t,
      ProPick(
        value: '',
        placeholder: '所有项目',
        clearable: true,
        options: const [
          PickOption(value: '', label: '所有项目'),
          PickOption(value: 'site', label: 'site'),
        ],
        onChanged: (_) {},
      ),
      '所有项目',
    );
    expect(find.text('所有项目'), findsNWidgets(2), reason: 'the trigger and one choice in the menu');
    expect(find.text('site'), findsOneWidget);
  });

  testWidgets('a pick that always has a value lists only its options', (t) async {
    await open(
      t,
      ProPick(
        value: 'glance',
        placeholder: '看一眼就收',
        options: const [
          PickOption(value: 'glance', label: '看一眼就收'),
          PickOption(value: 'required', label: '必须过验收'),
        ],
        onChanged: (_) {},
      ),
      '看一眼就收',
    );
    expect(find.text('看一眼就收'), findsNWidgets(2), reason: 'the trigger and its own option, no second entry for no value');
    expect(find.text('必须过验收'), findsOneWidget);
  });

  testWidgets('the pixel pick follows the same rule', (t) async {
    await open(
      t,
      PxPick(
        value: 'auto',
        placeholder: '按规则挑',
        options: const [
          PickOption(value: 'auto', label: '按规则挑'),
          PickOption(value: 'lab', label: '实验员'),
        ],
        onChanged: (_) {},
      ),
      '按规则挑',
    );
    expect(find.text('按规则挑'), findsNWidgets(2));
    expect(find.text('实验员'), findsOneWidget);
  });
}
