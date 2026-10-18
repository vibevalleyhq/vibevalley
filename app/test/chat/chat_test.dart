import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/ui/theme.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/prefs.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/workbench/chat/chat_page.dart';
import 'package:vibevalley/chat/chat_rules.dart';
import 'package:vibevalley/chat/chat_widgets.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/farm/chat_window.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/data/remote.dart' show agentsProvider;
import 'package:vibevalley/voice/voice.dart';
import 'package:http/http.dart' as http;

import '../support/farm.dart' show agent;
import '../support/server.dart' show FakeServer, atlas, jsonResponse;

import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/rules/chat.dart';
import 'package:vibevalley/rules/sessions.dart';
import 'package:vibevalley/rules/money.dart';

final _now = DateTime.now().millisecondsSinceEpoch.toDouble();

ChatMessage _msg(double seq, double conv, String from, SenderKind kind, String text, {MessageKind type = MessageKind.chat, String? name, bool done = true}) =>
    ChatMessage(
      id: 'm${seq.round()}',
      number: seq,
      conversation: 'c${conv.round()}',
      from: from,
      fromKind: kind,
      name:
          name ??
          (kind == SenderKind.manager
              ? '管家'
              : kind == SenderKind.user
              ? '主人'
              : '测试小吴'),
      agent: kind == SenderKind.agent ? 'tester' : null,
      kind: type,
      text: text,
      final_: done,
      outcome: type == MessageKind.report ? Outcome.completed : null,
      at: _now - (10 - seq) * 1000,
    );

const _session = Session(
  id: 'w1',
  name: '测试小吴',
  agent: 'tester',
  runtime: 'claude',
  brief: '跑一遍测试',
  hiredAt: 0,
  runs: 1,
  phase: PhaseWorking(
    since: 0,
    doing: Doing(action: SessionAction.runCommand, label: 'pnpm test'),
  ),
  channel: 'c1',
  phaseText: '在跑命令：pnpm test',
);

CoreState _state({CallState call = CallState.live, ManagerState manager = ManagerState.listening, double generalRead = 0, List<ChatMessage> more = const []}) =>
    CoreState(
      call: call,
      manager: manager,
      sessions: const [_session],
      chat: Chat(
        conversations: [
          Conversation(id: 'c1', kind: ConversationKind.general, name: '田头', replies: 0, read: generalRead, at: 0, lastNumber: 2),
          const Conversation(
            id: 'c2',
            kind: ConversationKind.channel,
            name: 'clock-in',
            description: '打卡',
            project: 'clock-in',
            replies: 0,
            at: 1,
            lastNumber: 4,
          ),
          const Conversation(
            id: 'c3',
            kind: ConversationKind.thread,
            parent: 'm2',
            channel: 'c1',
            subjectKind: SubjectKind.issue,
            subjectId: 'w1',
            replies: 1,
            at: 2,
            lastNumber: 3,
          ),
        ],
        messages: [
          _msg(1, 1, 'manager', SenderKind.manager, '农场开门了'),
          _msg(2, 1, 'manager', SenderKind.manager, '派给 @w1 跑测试', type: MessageKind.dispatch),
          _msg(3, 3, 'w1', SenderKind.agent, '测试都过了', type: MessageKind.report),
          _msg(4, 2, 'w1', SenderKind.agent, '打卡页改好了'),
          ...more,
        ],
      ),
      schedules: const [
        Schedule(
          id: 's5',
          name: '早测',
          text: '跑一遍测试',
          channel: 'c2',
          when: ScheduleWhenDaily(time: '09:00'),
          tz: 'Asia/Shanghai',
          enabled: true,
          created: 0,
          by: ScheduleBy.owner,
        ),
        Schedule(
          id: 's6',
          name: '早会',
          text: '看看昨天的活',
          channel: 'c2',
          when: ScheduleWhenDaily(time: '09:30'),
          tz: 'Asia/Shanghai',
          enabled: false,
          created: 0,
          by: ScheduleBy.manager,
          pending: true,
          nextText: '等主人同意',
        ),
      ],
    );

/// The chat's history for conversation 3; anything else is nothing.
Future<http.Response> _answer(http.Request r) async {
  if (r.method == 'GET' && r.url.path.endsWith('/messages')) {
    return jsonResponse(r.url.path.contains('/3/') ? [_msg(2, 1, 'manager', SenderKind.manager, '派给 @w1 跑测试').toJson()] : []);
  }
  if (r.url.path == '/api/v1/projects') return jsonResponse([]);
  return http.Response('', 204);
}

/// The first say fails, as when the line drops; the rest go through.
FakeServer _flaky() {
  var failed = false;
  return FakeServer((r) async {
    if (r.url.path == '/api/v1/say' && !failed) {
      failed = true;
      return jsonResponse({'reason': '线断了'}, 503);
    }
    return _answer(r);
  });
}

List<Map<String, dynamic>> _says(FakeServer server) => server.to('POST', '/api/v1/say').map((r) => jsonDecode(r.body) as Map<String, dynamic>).toList();

ReceivedFrame _frame(CoreState state) => ReceivedFrame(
  StateFrame(
    state: state,
    inbox: const [],
    graphs: const [],
    view: const FarmView(level: FarmLevel(level: 1, xp: 0, need: 10), plots: {}),
    effects: const [],
  ),
  bytes: 0,
  decodeMicros: 0,
);

Future<void> _pump(
  WidgetTester t,
  Widget child,
  FakeServer server,
  CoreState state, {
  Stream<CoreState>? later,
  bool still = false,
  Map<String, Agent> agents = const {},
}) async {
  t.view.physicalSize = const Size(1440, 900);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  Stream<ReceivedFrame> frames() async* {
    yield _frame(state);
    if (later != null) yield* later.map(_frame);
  }

  await t.pumpWidget(
    ProviderScope(
      overrides: [
        stateFrameProvider.overrideWith((ref) => frames()),
        sideEventsProvider.overrideWith((ref) => const Stream<LiveEvent>.empty()),
        atlasProvider.overrideWith((ref) async => atlas),
        agentsProvider.overrideWithValue(AsyncData(agents)),
        apiProvider.overrideWithValue(server.api),
        hostProvider.overrideWithValue(Desktop.none),
      ],
      child: MaterialApp(
        theme: farmTheme(),
        home: Scaffold(
          body: still
              ? Builder(
                  builder: (context) => MediaQuery(data: MediaQuery.of(context).copyWith(disableAnimations: true), child: child),
                )
              : child,
        ),
      ),
    ),
  );
  for (var i = 0; i < 5; i++) {
    await t.pump(const Duration(milliseconds: 20));
  }
}

Finder _rich(String text) => find.textContaining(text, findRichText: true);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('chat rules', () {
    final chat = _state().chat;

    test('channels: the general first; unread counts the others\' finished words, threads under their channel', () {
      expect(channelsOf(chat).map((c) => c.id), ['c1', 'c2']);
      expect(unreadIn(chat, chat!.conversations[0]), 2);
      expect(unreadUnder(chat, chat.conversations[0]), 3);
      expect(unreadUnder(chat, chat.conversations[1]), 1);
      expect(unreadTotal(chat), 4);
      expect(newestUnread(chat, chat.conversations[0]), 2);
      expect(jobThreadOf(chat, 'w1')?.id, 'c3');
      expect(channelOf(chat, chat.conversations[2])?.id, 'c1');
      expect(channelLabel(chat.conversations[1]), '#clock-in');
      expect(channelLabel(chat.conversations[0]), '田头');
    });

    test('the @word at the caret; whom it offers', () {
      expect(typedName('叫 @w', 4), (start: 2, query: 'w'));
      expect(typedName('a@w', 3), isNull);
      final all = nameables(const [_session], _now);
      expect(all.map((n) => n.token), ['@w1', '@管家']);
      expect(offeredFor(all, '管').single.token, '@管家');
      expect(offeredFor(all, '小吴').single.token, '@w1');
    });

    test('the thread items carry their thread; spoken lines weave into the general only', () {
      final general = chat!.conversations[0];
      final line = Line(id: 1, role: LineRole.user, text: '说一句', final_: true, at: _now - 8500);
      final items = itemsOf(chat, general, [line]);
      expect(items.map((i) => i.key), ['m1', 's1', 'm2']);
      expect((items.last as MessageItem).thread?.id, 'c3');
      expect(itemsOf(chat, chat.conversations[1], [line]).map((i) => i.key), ['m4']);
      final more = const Loaded([], complete: false).merge([_msg(0.5, 3, 'user', SenderKind.user, '早')], complete: true);
      expect(messagesOf(chat, 'c3', more).map((m) => m.number), [0.5, 3]);
      expect(more.complete, isTrue);
    });

    test('a helper in words', () {
      expect(phaseText(_session, _now), '在跑命令：pnpm test');
      expect(spentText(const Spent(tokens: 26000, cny: 0.031)), '约 ¥0.03 · 2.6 万 token');
    });
  });

  group('the workbench chat page', () {
    testWidgets('channels with unread, the general shown and read, a thread preview under the dispatch', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, const ChatPage(), server, _state());
      expect(find.text('频道'), findsOneWidget);
      expect(find.text('clock-in'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('1'), findsWidgets);
      expect(_rich('农场开门了'), findsOneWidget);
      expect(_rich('1 条回复'), findsOneWidget);
      expect(find.text('派活'), findsOneWidget);
      expect(_rich('默认的频道'), findsNothing);
      expect(find.byTooltip('默认的频道：你、管家和帮工都在这儿'), findsOneWidget);
      expect(_rich('回车发送'), findsNothing);
      expect(find.byTooltip('回车发送 · Shift+回车换行 · @ 叫人'), findsOneWidget);
      final read = server.to('POST', '/api/v1/channels/c1/read');
      expect(read, hasLength(1));
      expect(jsonDecode(read.single.body), {'number': 2});
    });

    testWidgets('a report with no run behind it shows no run line', (t) async {
      final server = FakeServer((r) async => r.url.path == '/api/v1/sessions/w1/events' ? jsonResponse([]) : _answer(r));
      await _pump(t, const ChatPage(), server, _state(more: [_msg(5, 1, 'w1', SenderKind.agent, '活干完了', type: MessageKind.report)]));
      expect(_rich('活干完了'), findsOneWidget);
      expect(server.to('GET', '/api/v1/sessions/w1/events'), isEmpty, reason: 'no run, nothing to read');
      expect(_rich('这一轮的干活过程'), findsNothing);
      expect(_rich('没有记录执行轮次'), findsNothing);
      expect(_rich('用了'), findsNothing);
    });

    testWidgets('the dispatch note is one line until opened, then the whole task once', (t) async {
      const task = '派 @w1（测试小吴）去 clock-in：跑一遍测试\n\n然后把失败的列出来';
      await _pump(t, const ChatPage(), FakeServer(_answer), _state(more: [_msg(5, 1, 'manager', SenderKind.manager, task, type: MessageKind.dispatch)]));
      expect(find.text('派 @w1（测试小吴）去 clock-in：跑一遍测试 然后把失败的列出来'), findsOneWidget);
      expect(_rich('然后把失败的列出来'), findsOneWidget);
      await t.tap(find.text('派 @w1（测试小吴）去 clock-in：跑一遍测试 然后把失败的列出来'));
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('派 @w1（测试小吴）去 clock-in：跑一遍测试 然后把失败的列出来'), findsNothing);
      expect(_rich('然后把失败的列出来'), findsOneWidget);
    });

    for (final still in [false, true]) {
      testWidgets(
        still
            ? 'with less motion asked for, a message that comes in just appears'
            : 'a message that comes in while it is open rises into place; the first ones just appear',
        (t) async {
          final later = StreamController<CoreState>();
          addTearDown(later.close);
          await _pump(t, const ChatPage(), FakeServer(_answer), _state(), later: later.stream, still: still);
          Finder fading(String text) => find.ancestor(of: _rich(text), matching: find.byWidgetPredicate((w) => w is Opacity && w.opacity < 1));
          expect(_rich('农场开门了'), findsWidgets);
          expect(fading('农场开门了'), findsNothing);

          later.add(_state(more: [_msg(6, 1, 'manager', SenderKind.manager, '新来的一句')]));
          await t.pump();
          await t.pump(const Duration(milliseconds: 60));
          expect(_rich('新来的一句'), findsWidgets);
          expect(fading('新来的一句'), still ? findsNothing : findsWidgets);
          expect(fading('农场开门了'), findsNothing);
          await t.pump(const Duration(milliseconds: 300));
          expect(fading('新来的一句'), findsNothing);
        },
      );
    }

    testWidgets('a channel opens with its history; typing there says it in that conversation', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, const ChatPage(), server, _state());
      await t.tap(find.text('clock-in'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('GET', '/api/v1/channels/c2/messages').single.url.queryParameters, {'limit': '50'});
      expect(_rich('打卡页改好了'), findsOneWidget);
      expect(find.text('打卡 · 默认项目 clock-in'), findsOneWidget);
      await t.enterText(find.byType(TextField).first, '今天把打卡做完');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      final say = server.to('POST', '/api/v1/say');
      expect(say, hasLength(1));
      expect(jsonDecode(say.single.body), {'text': '今天把打卡做完', 'conversation': 'c2', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});
    });

    testWidgets('the stop button shows while the manager thinks and stops it', (t) async {
      final server = FakeServer(_answer);
      final later = StreamController<CoreState>();
      addTearDown(later.close);
      await _pump(t, const ChatPage(), server, _state(), later: later.stream);
      expect(find.bySemanticsLabel('叫停管家'), findsNothing);
      later.add(_state(manager: ManagerState.thinking));
      await t.pump(const Duration(milliseconds: 20));
      await t.tap(find.bySemanticsLabel('叫停管家'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('POST', '/api/v1/manager/stop'), hasLength(1));
    });

    testWidgets('a send that fails keeps the draft, and sending it again uses the same key', (t) async {
      final server = _flaky();
      await _pump(t, const ChatPage(), server, _state());
      final field = find.byType(TextField).first;
      await t.enterText(field, '把打卡做完');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('线断了'), findsOneWidget);
      expect(t.widget<TextField>(field).controller!.text, '把打卡做完');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(t.widget<TextField>(field).controller!.text, '');
      await t.enterText(field, '把打卡做完');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      final keys = _says(server).map((b) => b['sendKey']).toList();
      expect(keys, hasLength(3));
      expect(keys[1], keys[0]);
      expect(keys[2], isNot(keys[0]));
    });

    testWidgets('@ offers whom to name; Enter names, then Enter sends on the square', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, const ChatPage(), server, _state());
      final field = find.byType(TextField).first;
      await t.enterText(field, '叫 @w');
      await t.pump();
      expect(find.byType(NamingMenu), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump();
      expect(t.widget<TextField>(field).controller!.text, '叫 @w1 ');
      expect(server.to('POST', '/api/v1/say'), isEmpty);
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(jsonDecode(server.to('POST', '/api/v1/say').single.body), {'text': '叫 @w1', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});
    });

    testWidgets('the thread opens on the right; the schedules tab lists and switches them', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, const ChatPage(), server, _state());
      await t.tap(_rich('1 条回复'));
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('测试小吴的工单串'), findsOneWidget);
      expect(server.to('GET', '/api/v1/channels/c3/messages'), hasLength(1));
      expect(_rich('测试都过了'), findsWidgets);
      expect(find.text('做完了'), findsOneWidget);

      await t.tap(find.text('clock-in'));
      await t.pump(const Duration(milliseconds: 50));
      await t.tap(find.text('定时'));
      await t.pump();
      expect(find.text('跑一遍测试'), findsOneWidget);
      await t.tap(find.text('开着'));
      await t.pump(const Duration(milliseconds: 50));
      expect(jsonDecode(server.to('PUT', '/api/v1/schedules/s5').single.body), {'enabled': false});
      await t.tap(find.byTooltip('删掉'));
      await t.pump();
      await t.tap(find.text('确定删？'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('DELETE', '/api/v1/schedules/s5'), hasLength(1));

      expect(_rich('等主人同意 · 管家定的'), findsOneWidget);
      await t.tap(find.text('同意'));
      await t.pump(const Duration(milliseconds: 50));
      expect(jsonDecode(server.to('PUT', '/api/v1/schedules/s6').single.body), {'enabled': true});
      await t.tap(find.text('不要'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('DELETE', '/api/v1/schedules/s6'), hasLength(1));
    });
  });

  group('the farm chat window', () {
    Widget window(FakeServer server, CoreState state, List<String> said) => Align(
      alignment: Alignment.bottomRight,
      child: Consumer(
        builder: (context, ref, _) => ChatWindow(
          state: ref.watch(stateProvider) ?? state,
          atlas: atlas,
          agents: const {},
          call: VoiceCall(VibeValleyServer(Uri.parse('http://farm.test')).api),
        ),
      ),
    );

    testWidgets('the general in bubbles; typing there uses the shared message owner; the thread chip opens the thread', (t) async {
      final server = FakeServer(_answer);
      final said = <String>[];
      await _pump(t, window(server, _state(), said), server, _state());
      expect(_rich('农场开门了'), findsOneWidget);
      expect(find.text('管家在听'), findsOneWidget);
      expect(find.text('2 处有新话'), findsOneWidget);

      await t.enterText(find.byType(TextField), '现在进度怎么样？');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('POST', '/api/v1/say').map((r) => (jsonDecode(r.body) as Map)['text']), ['现在进度怎么样？']);

      await t.tap(find.text('1 条回复'));
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('测试小吴的工单串'), findsOneWidget);
      expect(find.text('@w1'), findsWidgets);
      expect(_rich('测试都过了'), findsOneWidget);
      await t.enterText(find.byType(TextField), '再跑一次');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(jsonDecode(server.to('POST', '/api/v1/say').last.body), {'text': '再跑一次', 'conversation': 'c3', 'sendKey': matches(RegExp(r'^[0-9a-f]{32}$'))});

      await t.tap(find.bySemanticsLabel('回到田头').first);
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('测试小吴的工单串'), findsNothing);
      expect(_rich('农场开门了'), findsOneWidget);
    });

    testWidgets('a picked helper leaves the field wide: in the narrow window its chip is the head, its name a tooltip', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, window(server, _state(), []), server, _state(), agents: {'lab': agent('lab', '后端老周')});
      ProviderScope.containerOf(t.element(find.byType(ChatWindow))).read(prefsProvider.notifier).setPick('lab');
      await t.pump(const Duration(milliseconds: 50));
      expect(find.byTooltip('派给后端老周'), findsOneWidget);
      expect(find.text('派给后端老周'), findsNothing);
      final open = t.getSize(find.byType(TextField));
      expect(open.width, greaterThan(100));
      await t.tap(find.bySemanticsLabel('收起对话').first);
      await t.pump(const Duration(milliseconds: 300));
      expect(t.takeException(), isNull);
      expect(t.getSize(find.byType(TextField)), open, reason: 'one line of hint, folded or not');
    });

    testWidgets('an empty general greets; folding leaves the input row', (t) async {
      final server = FakeServer(_answer);
      final empty = CoreState(
        call: CallState.idle,
        manager: ManagerState.idle,
        sessions: const [],
        chat: const Chat(conversations: [], messages: []),
      );
      await _pump(t, window(server, empty, []), server, empty);
      expect(_rich('这里是田头'), findsOneWidget);
      expect(find.text('打字或者按麦克风，就开工'), findsOneWidget);
      expect(find.text('让小吴跑测试'), findsOneWidget);
      await t.tap(find.bySemanticsLabel('收起对话').first);
      await t.pump(const Duration(milliseconds: 300));
      expect(_rich('这里是田头'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('the stop button shows while the manager speaks and stops it', (t) async {
      final server = FakeServer(_answer);
      final later = StreamController<CoreState>();
      addTearDown(later.close);
      await _pump(t, window(server, _state(), []), server, _state(), later: later.stream);
      expect(find.bySemanticsLabel('叫停管家'), findsNothing);
      later.add(_state(manager: ManagerState.speaking));
      await t.pump(const Duration(milliseconds: 20));
      await t.tap(find.bySemanticsLabel('叫停管家'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('POST', '/api/v1/manager/stop'), hasLength(1));
    });

    testWidgets('a send that fails puts the draft back, and sending it again uses the same key', (t) async {
      final server = _flaky();
      await _pump(t, window(server, _state(), []), server, _state());
      await t.enterText(find.byType(TextField), '现在进度怎么样？');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(find.text('线断了'), findsOneWidget);
      expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '现在进度怎么样？');
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pump(const Duration(milliseconds: 50));
      expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '');
      expect(find.text('线断了'), findsNothing);
      final says = _says(server);
      expect(says.map((b) => b['text']), ['现在进度怎么样？', '现在进度怎么样？']);
      expect(says[1]['sendKey'], says[0]['sendKey']);
    });

    testWidgets('the channel menu\'s schedules: the owner says yes or no to the manager\'s', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, window(server, _state(), []), server, _state());
      await t.tap(find.bySemanticsLabel(RegExp('^频道：田头')));
      await t.pump();
      await t.tap(find.text('定时 1'));
      await t.pump();
      expect(_rich('管家定的 · 等主人同意'), findsOneWidget);
      expect(find.text('关着'), findsNothing);
      await t.tap(find.text('同意'));
      await t.pump(const Duration(milliseconds: 50));
      expect(jsonDecode(server.to('PUT', '/api/v1/schedules/s6').single.body), {'enabled': true});
      await t.tap(find.text('不要'));
      await t.pump(const Duration(milliseconds: 50));
      expect(server.to('DELETE', '/api/v1/schedules/s6'), hasLength(1));
    });

    testWidgets('the channel menu lists channels with unread and switches', (t) async {
      final server = FakeServer(_answer);
      await _pump(t, window(server, _state(), []), server, _state());
      await t.tap(find.bySemanticsLabel(RegExp('^频道：田头')));
      await t.pump();
      expect(find.text('#clock-in'), findsOneWidget);
      expect(find.text('开新频道'), findsOneWidget);
      expect(find.text('定时 1'), findsOneWidget);
      await t.tap(find.text('#clock-in'));
      await t.pump(const Duration(milliseconds: 50));
      expect(_rich('打卡页改好了'), findsOneWidget);
    });
  });
}
