import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/shared/work_log.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/rounds.dart';

SessionEvent step(int n, double at, SessionEventType kind, String text, {ToolAction? action, bool? ok, int? under, int? on, String? output}) =>
    SessionEvent(seq: n.toDouble(), time: at, type: kind, text: text, action: action, ok: ok, under: under?.toDouble(), on: on?.toDouble(), output: output);

final trajectory = [
  step(0, 0, SessionEventType.userMessage, '修登录'),
  step(1, 1000, SessionEventType.toolCall, 'rg handleLogin', action: ToolAction.search, ok: true),
  step(2, 3000, SessionEventType.toolCall, 'pnpm test', action: ToolAction.runCommand, ok: false, output: '1 failed'),
  step(3, 63000, SessionEventType.assistantMessage, '测试挂了一个，先停在这'),
  step(4, 100000, SessionEventType.userMessage, '【评论第 2 步】关于你这一步的操作：pnpm test\n\n我的评论：token 过期那条也修掉', on: 2),
  step(5, 101000, SessionEventType.toolCall, 'edit src/auth.ts', action: ToolAction.editFile, ok: true),
  step(6, 106000, SessionEventType.assistantMessage, '修好了，测试全过'),
];

void main() {
  test('rounds start at each thing the helper was told', () {
    final rounds = roundsOf(trajectory);
    expect(rounds.map((r) => r.asked?.seq), [0, 4]);
    expect(rounds.first.steps.map((s) => s.seq), [1, 2, 3]);
    expect(rounds.first.answer?.text, '测试挂了一个，先停在这');
    final withSub = roundsOf([...trajectory.take(2), step(9, 1500, SessionEventType.userMessage, '帮手的活', under: 1)]);
    expect(withSub.length, 1);
  });

  test('each span lasts until the next step; the last until the end given', () {
    final first = roundsOf(trajectory).first;
    expect(spansOf(first, end: 63000).map((s) => s.ms), [1000, 2000, 60000, 0]);
    expect(spansOf(first, end: 70000).last.ms, 7000);
    expect(tookText(roundMs(first, end: 63000)), '1 分 3 秒');
    expect(tookText(8000), '8 秒');
    expect(tookText(3900000), '1 小时 5 分');
  });

  test("the helpers' farm tools read as what they do", () {
    expect(farmToolText('vibevalley__channel_inbox'), '看有没有找它的话');
    expect(farmToolText('vibevalley__channel_say'), '在田头说话');
    expect(farmToolText('pnpm test'), isNull);
    expect(spanLabel(step(1, 0, SessionEventType.toolCall, 'vibevalley__channel_read', action: ToolAction.mcp)), '田头');
  });

  test('a comment is tied to its step and read without the quote', () {
    final comments = commentsOf(trajectory);
    expect(comments.keys, [2]);
    expect(commentWords(comments[2]!.single), 'token 过期那条也修掉');
    expect(spanColor(trajectory[2]), Palette.berry);
    expect(spanLabel(trajectory[1]), '搜索');
  });

  testWidgets('earlier rounds fold to their answer; the bar opens a step; a comment goes out about its step', (t) async {
    t.view.physicalSize = const Size(900, 1400);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    final sent = <(int, String)>[];
    await t.pumpWidget(
      MaterialApp(
        theme: farmTheme(),
        home: Scaffold(
          body: WorkLog(steps: trajectory, now: 106000, tall: true, onComment: (n, text) async => sent.add((n, text))),
        ),
      ),
    );
    await t.pump();
    expect(find.text('工单'), findsOneWidget);
    expect(find.text('评论第 2 步'), findsOneWidget);
    expect(find.text('测试挂了一个，先停在这'), findsOneWidget);
    expect(find.text('pnpm test'), findsNothing);
    expect(find.text('你评论：token 过期那条也修掉'), findsNothing);
    expect(find.text('token 过期那条也修掉'), findsOneWidget);

    await t.tap(find.bySemanticsLabel('跑命令 1 分'));
    await t.pumpAndSettle();
    expect(find.text('pnpm test'), findsOneWidget);
    expect(find.text('你评论：token 过期那条也修掉'), findsOneWidget);

    expect(find.text('评论'), findsNothing);
    final mouse = await t.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(t.getCenter(find.text('pnpm test')));
    await t.pump();
    expect(find.text('评论'), findsOneWidget);
    await t.tap(find.text('评论'));
    await t.pump();
    await t.enterText(find.byType(EditableText).first, '换个思路');
    await t.pump();
    await t.tap(find.text('发给它'));
    await t.pumpAndSettle();
    expect(sent, [(2, '换个思路')]);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  test('the work log shows a call with its result, and neither the result nor the run bounds as rows', () {
    const log = [
      SessionEvent(seq: 0, time: 0, type: SessionEventType.runStart, text: ''),
      SessionEvent(seq: 1, time: 0, type: SessionEventType.toolCall, text: 'ls'),
      SessionEvent(seq: 2, time: 0, type: SessionEventType.toolResult, text: '', call: 1, output: 'a.ts', ok: true),
      SessionEvent(seq: 3, time: 0, type: SessionEventType.runEnd, text: 'completed'),
    ];
    final shown = shownEvents(log);
    expect(shown.map((e) => e.seq), [1]);
    expect((shown.single.output, shown.single.ok), ('a.ts', true));
  });
}
