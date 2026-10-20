import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/ui/pro/pro.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> pump(WidgetTester t, Widget child) => pumpFarm(
    t,
    ProScope(child: SingleChildScrollView(child: child)),
    overrides: overrides(farm(), view(), fakeApi(Routes())),
  );

  testWidgets('a fold says what is inside while folded, and shows it when opened', (t) async {
    await pump(t, const ProFold(label: '改动', summary: '3 个文件 +40 −2', child: Text('src/a.ts')));
    expect(find.text('3 个文件 +40 −2'), findsOneWidget);
    expect(find.text('src/a.ts'), findsNothing);
    await t.tap(find.text('改动'));
    await t.pumpAndSettle();
    expect(find.text('src/a.ts'), findsOneWidget);
  });

  testWidgets('a fold opens by itself when it is wanted open later (a review starts)', (t) async {
    var open = false;
    late StateSetter set;
    await pump(
      t,
      StatefulBuilder(
        builder: (context, s) {
          set = s;
          return ProFold(label: '验收标准', summary: '2 条', open: open, child: const Text('能选月份'));
        },
      ),
    );
    expect(find.text('能选月份'), findsNothing);
    set(() => open = true);
    await t.pumpAndSettle();
    expect(find.text('能选月份'), findsOneWidget);
  });

  testWidgets('更多 keeps the rest out of sight until asked, and says how many', (t) async {
    await pump(t, const ProMore(children: [Text('分支'), Text('worktree')]));
    expect(find.text('更多（2）'), findsOneWidget);
    expect(find.text('分支'), findsNothing);
    await t.tap(find.text('更多（2）'));
    await t.pumpAndSettle();
    expect(find.text('分支'), findsOneWidget);
    expect(find.text('收起'), findsOneWidget);
  });
}
