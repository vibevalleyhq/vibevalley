import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/host/notify.dart';
import 'package:vibevalley/gen/vibevalley.dart';

InboxItem _call(
  String id,
  InboxKind kind, {
  InboxFrom from = const InboxFromSession(id: 'h1', name: '阿土', agent: 'oar'),
  String text = '修好登录页',
  InboxTarget? target,
}) => InboxItem(
  id: id,
  kind: kind,
  from: from,
  text: text,
  at: 1,
  target: target ?? const InboxTargetSession(id: 'h1'),
);

CoreState _state({String call = 'live', List<Map<String, dynamic>> conversations = const [], List<Map<String, dynamic>> messages = const []}) =>
    CoreState.fromJson({
      'call': call,
      'manager': ManagerState.values.first.wire,
      'sessions': const <Object>[],
      'chat': {'conversations': conversations, 'messages': messages},
    });

void main() {
  test('the calls standing at start are known; a new one rings once', () {
    final bell = CallBell();
    final old = _call('h1:harvest:1', InboxKind.merge);
    expect(bell.ring([old]), isEmpty);
    final fresh = _call('h1:fix:2', InboxKind.fix);
    expect(bell.ring([fresh, old]).map((c) => c.id), ['h1:fix:2']);
    expect(bell.ring([fresh, old]), isEmpty);
  });

  test('calls become notifications in the Electron client words, opening what they are about', () {
    expect(noticeForCall(_call('a', InboxKind.merge)), const HostNotice('阿土 做完了', '修好登录页', HostOpenSession('h1')));
    expect(noticeForCall(_call('b', InboxKind.fix)).title, '阿土 没做成');
    expect(noticeForCall(_call('c', InboxKind.quiet)).body, '可能在跑很久的命令，也可能卡住了：看看它的干活过程。');
    expect(
      noticeForCall(
        _call(
          'd',
          InboxKind.planRipe,
          from: const InboxFromManager(),
          text: '登录改版',
          target: const InboxTargetPlans(playbook: 'pb1'),
        ),
      ),
      const HostNotice('计划「登录改版」都做完了', '看看改动，收获进主分支', HostOpenPlans('pb1')),
    );
    expect(
      noticeForCall(
        _call(
          'm3',
          InboxKind.mention,
          from: const InboxFromManager(),
          text: '看一眼',
          target: const InboxTargetChat(conversation: 'c2'),
        ),
      ),
      const HostNotice('管家 叫你', '看一眼', HostOpenChat('c2')),
    );
  });

  test('achievements and errors', () {
    expect(noticeForEffect(const GameEffectAchievement(achievement: 'harvests', tier: 2)), const HostNotice('升到银牌：小有收成', '收进主分支的活', HostOpenAchievements()));
    expect(noticeForEffect(const GameEffectAchievement(achievement: 'steady', tier: 3))!.title, '升到金牌：金牌稳如老农');
    expect(noticeForEffect(const GameEffectAchievement(achievement: 's_hire', tier: 1))!.title, '新手任务做完了：派活');
    expect(noticeForEffect(const GameEffectAchievement(achievement: 'unknown', tier: 1)), isNull);
    expect(noticeForEvent(const LiveEventNotice(at: 0, level: NoticeLevel.error, text: '数据库\n坏了')), const HostNotice('码农场物语', '数据库 坏了'));
    expect(noticeForEvent(const LiveEventNotice(at: 0, level: NoticeLevel.info, text: 'hi')), isNull);
  });

  test('the menu bar: what goes on, what waits, what is unread', () {
    expect(traySummary(_state(call: 'idle'), const []), const TraySummary('', ['还没开工']));
    final inbox = [
      _call('h1:harvest:1', InboxKind.merge),
      _call(
        'pb:draft',
        InboxKind.planDraft,
        from: const InboxFromManager(),
        text: '登录改版',
        target: const InboxTargetPlans(playbook: 'pb'),
      ),
      _call('m9', InboxKind.mention, target: const InboxTargetChat(conversation: 'c1')),
    ];
    final state = _state(
      conversations: [
        {'id': 'c1', 'kind': 'general', 'replies': 0, 'read': 1, 'at': 0},
      ],
      messages: [
        for (final (seq, from, kind) in [(1, 'manager', 'chat'), (2, 'manager', 'chat'), (3, 'user', 'chat'), (4, 'h1', 'notice'), (5, 'h1', 'chat')])
          {
            'id': 'm$seq',
            'number': seq,
            'conversation': 'c1',
            'from': from,
            'fromKind': from == 'user' ? 'user' : 'manager',
            'name': from,
            'kind': kind,
            'text': 't',
            'final': true,
            'at': seq,
          },
      ],
    );
    expect(traySummary(state, inbox), const TraySummary('2!', ['开工了，没有在干的活', '阿土 做完了，可以收', '计划「登录改版」等你看', '田头 2 条没读']));
  });

  test('commands round-trip the protocol JSON; unknown ones are dropped', () {
    for (final c in const <HostCommand>[HostVoice(), HostOpenSession('h1'), HostOpenChat('c3'), HostOpenPlans('pb'), HostOpenAchievements()]) {
      expect(HostCommand.fromJson(c.toJson())?.toJson(), c.toJson());
    }
    expect(HostCommand.fromJson({'type': 'session'}), isNull);
    expect(HostCommand.fromJson({'type': 'later'}), isNull);
    expect(HostCommand.fromJson('voice'), isNull);
  });

  test('shortcut and channel words', () {
    expect(shortcutText('Alt+Shift+Space'), '⌥⇧Space');
    expect(DesktopChannel.alpha.titled('码农场物语'), '码农场物语 · Alpha');
    expect(DesktopChannel.release.titled('码农场物语'), '码农场物语');
    expect(DesktopChannel.named('alpha'), DesktopChannel.alpha);
    expect(() => DesktopChannel.named('nope'), throwsArgumentError);
  });
}
