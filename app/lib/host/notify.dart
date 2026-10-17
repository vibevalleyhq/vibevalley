// Pure: frames in, words out.

import '../gen/vibevalley.dart';
import '../rules/chat.dart';
import '../rules/progress.dart';
import '../rules/view.dart';
import 'command.dart';

/// null opens the farm itself.
class HostNotice {
  const HostNotice(this.title, this.body, [this.open]);
  final String title;
  final String body;
  final HostCommand? open;

  @override
  bool operator ==(Object other) => other is HostNotice && other.title == title && other.body == body && other.open == open;
  @override
  int get hashCode => Object.hash(title, body, open);
  @override
  String toString() => 'HostNotice($title, $body, ${open?.toJson()})';
}

String clipLine(String text, [int max = 140]) {
  final one = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return one.length > max ? '${one.substring(0, max - 1)}…' : one;
}

HostCommand openFor(InboxTarget target) => switch (target) {
  InboxTargetSession(:final id) => HostOpenSession(id),
  InboxTargetPlans(:final playbook) => HostOpenPlans(playbook),
  InboxTargetChat(:final conversation) => HostOpenChat(conversation),
};

HostNotice noticeForCall(InboxItem call) {
  final who = callerName(call);
  final open = openFor(call.target);
  final text = clipLine(call.text);
  return switch (call.kind) {
    InboxKind.merge => HostNotice('$who 做完了', text, open),
    InboxKind.fix => HostNotice('$who 没做成', text, open),
    InboxKind.conflict => HostNotice('$who 的活合进主分支会冲突', text, open),
    InboxKind.quiet => HostNotice('$who 好一阵没动静了', '可能在跑很久的命令，也可能卡住了：看看它的干活过程。', open),
    InboxKind.planDraft => HostNotice('计划「$text」拆好了', '看过再开工', open),
    InboxKind.planRipe => HostNotice('计划「$text」都做完了', '看看改动，收获进主分支', open),
    InboxKind.planFailed => HostNotice('计划卡住了：$text', '重试、改工单，或者跳过', open),
    InboxKind.mention => HostNotice('$who 叫你', text, open),
  };
}

/// The calls standing when the app starts are known, not rung; a call id seen once never rings again (a helper's next ripe turn has a new id).
class CallBell {
  final _seen = <String>{};
  bool _primed = false;

  List<InboxItem> ring(List<InboxItem> calls) {
    final fresh = [
      for (final c in calls)
        if (_seen.add(c.id)) c,
    ];
    if (!_primed) {
      _primed = true;
      return const [];
    }
    return fresh;
  }
}

HostNotice? noticeForEffect(GameEffect effect) {
  if (effect is! GameEffectAchievement) return null;
  final a = achievementOf(effect.achievement);
  if (a == null) return null;
  final tier = effect.tier.round();
  final what = switch (a.category) {
    AchievementCategory.starter => '新手任务做完了',
    AchievementCategory.secret => '发现一个彩蛋',
    _ => tier == 3 ? '升到金牌' : (tier == 2 ? '升到银牌' : '解锁成就'),
  };
  return HostNotice('$what：${tierTitle(a, tier)}', clipLine(a.detail), const HostOpenAchievements());
}

HostNotice? noticeForEvent(SideEvent event) => switch (event) {
  SideEventNotice(level: NoticeLevel.error, :final text) => HostNotice('码农场物语', clipLine(text)),
  _ => null,
};

class TraySummary {
  const TraySummary(this.title, this.lines);
  final String title;
  final List<String> lines;

  static const opening = TraySummary('', ['正在开门…']);

  @override
  bool operator ==(Object other) => other is TraySummary && other.title == title && other.lines.join('\n') == lines.join('\n');
  @override
  int get hashCode => Object.hash(title, lines.join('\n'));
}

/// A mention is counted with the unread instead.
String? waitingLine(InboxItem call) {
  final who = callerName(call);
  return switch (call.kind) {
    InboxKind.merge => '$who 做完了，可以收',
    InboxKind.fix => '$who 没做成',
    InboxKind.conflict => '$who 的活会冲突',
    InboxKind.quiet => '$who 好一阵没动静',
    InboxKind.planDraft => '计划「${call.text}」等你看',
    InboxKind.planRipe => '计划「${call.text}」可以收获',
    InboxKind.planFailed => '计划「${call.text}」没做成',
    InboxKind.mention => null,
  };
}

TraySummary traySummary(CoreState state, List<InboxItem> inbox) {
  final working = state.sessions.where((h) => h.phase is PhaseWorking).length;
  final waiting = [for (final c in inbox) ?waitingLine(c)];
  final unread = unreadTotal(state.chat);
  final lines = [state.call == CallState.live ? (working > 0 ? '$working 个帮工在干活' : '开工了，没有在干的活') : '还没开工', ...waiting, if (unread > 0) '田头 $unread 条没读'];
  final title = [if (working > 0) '$working', if (waiting.isNotEmpty) '${waiting.length}!'].join(' · ');
  return TraySummary(title, lines);
}
