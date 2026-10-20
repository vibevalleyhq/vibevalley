import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/rounds.dart';
import 'package:vibevalley/shared/trajectory.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/ui/pixel/theme.dart';
import 'package:vibevalley/workbench/agents/agent_creator_page.dart';

import '../support/workbench.dart';

SessionEvent _e(
  int n,
  double at,
  SessionEventType type, {
  String text = '',
  int? call,
  String? tool,
  String? input,
  String? output,
  bool? ok,
  EventTokens? tokens,
}) => SessionEvent(
  seq: n.toDouble(),
  time: at,
  type: type,
  text: text,
  call: call?.toDouble(),
  tool: tool,
  action: type == SessionEventType.toolCall ? ToolAction.runCommand : null,
  input: input,
  output: output,
  ok: ok,
  tokens: tokens,
);

const _long = '第一行想法\n第二行想法，很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长';

/// Two rounds: the first thinks, runs a test and answers; the second answers straight away.
final _log = [
  _e(0, 0, SessionEventType.runStart),
  _e(1, 0, SessionEventType.userMessage, text: '帮我跑测试'),
  _e(2, 1000, SessionEventType.assistantThinking, text: _long),
  _e(3, 2000, SessionEventType.toolCall, text: 'pnpm test', tool: 'Bash', input: '{"command": "pnpm test"}'),
  _e(4, 3000, SessionEventType.llmUsage, text: '缓存命中 75%', tokens: const EventTokens(input: 100, cacheRead: 300, output: 50)),
  _e(5, 7000, SessionEventType.toolResult, call: 3, output: '12 passed\nall good', ok: true),
  _e(6, 8000, SessionEventType.assistantMessage, text: '测试都过了。'),
  _e(7, 9000, SessionEventType.llmUsage, text: '缓存命中 83%', tokens: const EventTokens(input: 100, cacheRead: 500, output: 30)),
  _e(8, 9000, SessionEventType.runEnd, text: 'completed'),
  _e(9, 3600000, SessionEventType.userMessage, text: '再看看 lint'),
  _e(10, 3602000, SessionEventType.assistantMessage, text: 'lint 也干净。'),
  _e(11, 3603000, SessionEventType.llmUsage, text: '缓存命中 90%', tokens: const EventTokens(input: 0, cacheRead: 0, output: 20)),
];

Future<void> _pump(WidgetTester t, List<SessionEvent> log) async {
  t.view.physicalSize = const Size(1200, 900);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    MaterialApp(
      theme: farmTheme(),
      home: Scaffold(
        body: Trajectory(steps: log, now: 3603000, asked: '收到'),
      ),
    ),
  );
  await t.pump();
}

Text _textOf(WidgetTester t, String text) => t.widget<Text>(find.text(text));

void main() {
  test('the waterfall takes its lanes from the times the log has', () {
    final fall = waterfallOf(_log, end: 3603000);
    expect(fall.rounds, [(0.0, 9000.0), (3600000.0, 3603000.0)]);
    final model = [for (final s in fall.spans.where((s) => s.lane == Lane.model)) (s.start, s.end, s.seq)];
    // From what it answered to its usage: the message, then the tool's result, then the second message.
    expect(model, [(0.0, 3000.0, 2.0), (7000.0, 9000.0, 6.0), (3600000.0, 3603000.0, 10.0)]);
    final tools = [for (final s in fall.spans.where((s) => s.lane == Lane.tool)) (s.start, s.end, s.seq)];
    expect(tools, [(2000.0, 7000.0, 3.0)]);
    expect(fall.spans.where((s) => s.lane == Lane.asked).map((s) => s.seq), [1.0, 9.0]);
  });

  test('a call that has not returned runs to the end; with no usage the answer stops at its last step', () {
    final fall = waterfallOf([_e(1, 0, SessionEventType.userMessage, text: 'x'), _e(2, 500, SessionEventType.toolCall, text: 'sleep 9')], end: 4000);
    expect([for (final s in fall.spans) (s.lane, s.start, s.end)], [(Lane.asked, 0.0, 500.0), (Lane.model, 0.0, 4000.0), (Lane.tool, 500.0, 4000.0)]);
  });

  test('the summary counts rounds, steps, the lanes\' time and the usage\'s tokens', () {
    final s = summaryOf(_log, end: 3603000);
    expect((s.rounds, s.steps), (2, 6));
    expect((s.modelMs, s.toolMs), (8000.0, 5000.0));
    expect((s.input, s.cacheRead, s.output), (200, 800, 100));
    expect(s.cacheHit, .8);
    expect(tokensText(32600), '3.3 万');
    expect(secondsText(1240), '1.2 秒');
    expect(secondsText(65000), '1 分 5 秒');
  });

  testWidgets('each step is one line until it is tapped, and folds again', (t) async {
    await _pump(t, _log);
    expect(_textOf(t, _long.replaceAll(RegExp(r'\s+'), ' ')).maxLines, 1);
    await t.tap(find.text(_long.replaceAll(RegExp(r'\s+'), ' ')));
    await t.pump();
    expect(_textOf(t, _long).maxLines, isNull);
    await t.tap(find.text(_long));
    await t.pump();
    expect(find.text(_long), findsNothing);
  });

  testWidgets('a tool reads as what, its args and its result on one line; tapped, all of them', (t) async {
    await _pump(t, _log);
    final line = find.text('pnpm test {"command": "pnpm test"} → 12 passed all good', findRichText: true);
    expect(line, findsOneWidget);
    expect(t.widget<RichText>(line).maxLines, 1);
    expect(find.text('Bash'), findsOneWidget);
    await t.tap(line);
    await t.pump();
    expect(find.text('\$ pnpm test'), findsOneWidget);
    expect(find.text('12 passed\nall good'), findsOneWidget);
  });

  testWidgets('the gutter names each round once and its time is on its first row only', (t) async {
    await _pump(t, _log);
    expect(find.text('第 1 轮'), findsOneWidget);
    expect(find.text('第 2 轮'), findsOneWidget);
    expect(find.text('1 小时前'), findsOneWidget);
    expect(find.text('收到'), findsNWidgets(3));
    expect(find.text('想了想'), findsOneWidget);
    expect(find.text('用量'), findsNWidgets(3));
  });

  testWidgets('the footer adds up the rounds and the usage', (t) async {
    await _pump(t, _log);
    expect(find.text('2 轮 · 6 步 · 模型用时 8.0 秒 · 工具用时 5.0 秒 · 缓存命中 80% · 输入 1000 / 输出 100 token'), findsOneWidget);
  });

  testWidgets('the search box keeps the rows that have the text', (t) async {
    await _pump(t, _log);
    await t.enterText(find.descendant(of: labelled('搜索轨迹'), matching: find.byType(EditableText)), 'LINT');
    await t.pump();
    expect(find.text('再看看 lint'), findsOneWidget);
    expect(find.text('lint 也干净。'), findsOneWidget);
    expect(find.text('帮我跑测试'), findsNothing);
    expect(find.text('第 2 轮'), findsOneWidget);
    await t.enterText(find.descendant(of: labelled('搜索轨迹'), matching: find.byType(EditableText)), 'nothing like it');
    await t.pump();
    expect(find.text('没有对得上的步骤。'), findsOneWidget);
  });

  testWidgets('a waterfall segment picks its row', (t) async {
    await _pump(t, _log);
    await t.tap(labelled('工具 5.0 秒'));
    await t.pumpAndSettle();
    final marked = find.byWidgetPredicate((w) => w is Container && w.color == Palette.wheat.withValues(alpha: .35));
    expect(find.descendant(of: marked, matching: find.text('Bash')), findsOneWidget);
  });

  testWidgets("a helper's 轨迹 opens over the whole page and goes back to the profile", (t) async {
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final server = WorkbenchBackend(
      agents: [agent('backend', '后端老周')],
      runtimes: [runtime('claude')],
      events: {'h1': _log},
      heads: [
        Session(
          id: 'h1',
          name: '老周一号',
          agent: 'backend',
          runtime: 'claude',
          brief: '跑测试',
          hiredAt: now,
          runs: 1,
          phase: PhaseClosed(at: now, closed: IssueClose.dismissed),
        ),
      ],
    );
    await pumpPage(t, const AgentCreatorPage(id: 'backend'), server.handle, size: const Size(1440, 900));
    await t.tap(find.text('轨迹'));
    await settle(t);
    expect(find.text('身份'), findsNothing);
    expect(t.getSize(find.byType(Trajectory)).width, greaterThan(1100));
    expect(find.text('第 2 轮'), findsOneWidget);
    await t.tap(find.text('← 回到档案'));
    await settle(t);
    expect(find.text('身份'), findsOneWidget);
    expect(find.byType(Trajectory), findsNothing);
  });
}
