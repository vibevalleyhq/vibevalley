import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/shared/chat_rules.dart';
import 'package:vibevalley/shared/chat_widgets.dart';
import 'package:vibevalley/ui/pixel/pixel.dart';

import '../support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a message reads long by its length, its lines, a heading or a code block', () {
    expect(readsLong('好，我去跑测试'), isFalse);
    expect(readsLong('字' * 241), isTrue);
    expect(readsLong(List.filled(9, '一行').join('\n')), isTrue);
    expect(readsLong('## 做了什么\n加好了'), isTrue);
    expect(readsLong('看这个：\n```\ngo test\n```'), isTrue);
    expect(readsLong('#没空格不是标题'), isFalse);
  });

  bool reading(WidgetTester t) => t.widgetList<PxMarkdown>(find.byType(PxMarkdown)).single.reading;

  testWidgets('a long message is said in pixels and opens to be read', (t) async {
    await pumpFarm(t, const ChatText('## 做了什么\n\n加好了按月查询。'), overrides: overrides(farm(), view(), fakeApi(Routes())));
    expect(reading(t), isFalse);
    await t.tap(find.text('展开阅读'));
    await t.pump();
    expect(reading(t), isTrue);
    await t.tap(find.text('收起'));
    await t.pump();
    expect(reading(t), isFalse);
  });

  testWidgets('a short message, or one still streaming, has nothing to open', (t) async {
    await pumpFarm(t, const Column(children: [ChatText('好'), ChatText('## 还在写', folds: false)]), overrides: overrides(farm(), view(), fakeApi(Routes())));
    expect(find.text('展开阅读'), findsNothing);
    expect(t.widgetList<PxMarkdown>(find.byType(PxMarkdown)).every((m) => !m.reading), isTrue);
  });
}
