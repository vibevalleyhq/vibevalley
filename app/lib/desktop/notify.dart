// What the desktop app tells the person while the farm is not in front of them (ported from the Electron client's
// notify.ts, removed): system notifications, and the menu bar's summary. Pure: frames in, words out. It reads the
// server's frame: a new item in its inbox (a helper's turn done or failed, a conflict, a quiet helper, a playbook
// drafted, ripe or stuck, someone naming the person), an achievement effect, an error notice.

import '../gen/vibevalley.dart';
import '../rules/chat.dart';
import '../rules/progress.dart';
import '../rules/view.dart';
import 'command.dart';

/// A system notification: what to say, and what clicking it opens (the farm itself when null).
class DesktopNotice {
  const DesktopNotice(this.title, this.body, [this.open]);
  final String title;
  final String body;
  final DesktopCommand? open;

  @override
  bool operator ==(Object other) => other is DesktopNotice && other.title == title && other.body == body && other.open == open;
  @override
  int get hashCode => Object.hash(title, body, open);
  @override
  String toString() => 'DesktopNotice($title, $body, ${open?.toJson()})';
}

/// Words for a notification's body: one line, not too long.
String clipLine(String text, [int max = 140]) {
  final one = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return one.length > max ? '${one.substring(0, max - 1)}…' : one;
}

DesktopCommand openFor(InboxTarget target) => switch (target) {
  InboxTargetWorker(:final id) => DesktopOpenWorker(id),
  InboxTargetPlans(:final playbook) => DesktopOpenPlans(playbook),
  InboxTargetChat(:final conversation) => DesktopOpenChat(conversation),
};

/// A call as a notification, in the words the Electron client used.
DesktopNotice noticeForCall(InboxItem call) {
  final who = callerName(call);
  final open = openFor(call.target);
  final text = clipLine(call.text);
  return switch (call.kind) {
    InboxKind.harvest => DesktopNotice('$who 做完了', text, open),
    InboxKind.fix => DesktopNotice('$who 没做成', text, open),
    InboxKind.conflict => DesktopNotice('$who 的活合进主分支会冲突', text, open),
    InboxKind.quiet => DesktopNotice('$who 好一阵没动静了', '可能在跑很久的命令，也可能卡住了：看看它的干活过程。', open),
    InboxKind.planDraft => DesktopNotice('计划「$text」拆好了', '看过再开工', open),
    InboxKind.planRipe => DesktopNotice('计划「$text」都做完了', '看看改动，收获进主分支', open),
    InboxKind.planFailed => DesktopNotice('计划卡住了：$text', '重试、改工单，或者跳过', open),
    InboxKind.mention => DesktopNotice('$who 叫你', text, open),
  };
}

/// Rings once for each call: the ones standing when the app starts are known, not rung; a call id seen once never
/// rings again (a helper's next ripe turn has a new id).
class CallBell {
  final _seen = <String>{};
  bool _primed = false;

  /// The calls among `calls` not seen before.
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

/// An achievement effect as a notification: a tier reached, a starter task done, a secret found.
DesktopNotice? noticeForEffect(GameEffect effect) {
  if (effect is! GameEffectAchievement) return null;
  final a = achievementOf(effect.achievement);
  if (a == null) return null;
  final tier = effect.tier.round();
  final what = switch (a.category) {
    AchievementCategory.starter => '新手任务做完了',
    AchievementCategory.secret => '发现一个彩蛋',
    _ => tier == 3 ? '升到金牌' : (tier == 2 ? '升到银牌' : '解锁成就'),
  };
  return DesktopNotice('$what：${tierTitle(a, tier)}', clipLine(a.detail), const DesktopOpenAchievements());
}

/// The farm's errors (a red notice) as a notification that opens the farm.
DesktopNotice? noticeForEvent(SiteEvent event) => switch (event) {
  SiteEventNotice(level: NoticeLevel.error, :final text) => DesktopNotice('码农场物语', clipLine(text)),
  _ => null,
};

/// What the menu bar shows: a short title beside the icon, and lines for its menu.
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

/// One line of the menu for a call that waits for the person (a mention is counted with the unread instead).
String? waitingLine(InboxItem call) {
  final who = callerName(call);
  return switch (call.kind) {
    InboxKind.harvest => '$who 做完了，可以收',
    InboxKind.fix => '$who 没做成',
    InboxKind.conflict => '$who 的活会冲突',
    InboxKind.quiet => '$who 好一阵没动静',
    InboxKind.planDraft => '计划「${call.text}」等你看',
    InboxKind.planRipe => '计划「${call.text}」可以收获',
    InboxKind.planFailed => '计划「${call.text}」没做成',
    InboxKind.mention => null,
  };
}

/// The menu bar's summary (notify.ts traySummary), its waiting lines from the frame's inbox.
TraySummary traySummary(FarmState state, List<InboxItem> inbox) {
  final working = state.helpers.where((h) => h.phase is PhaseWorking).length;
  final waiting = [for (final c in inbox) ?waitingLine(c)];
  final unread = unreadTotal(state.chat);
  final lines = [state.call == CallState.live ? (working > 0 ? '$working 个帮工在干活' : '开工了，没有在干的活') : '还没开工', ...waiting, if (unread > 0) '田头 $unread 条没读'];
  final title = [if (working > 0) '$working', if (waiting.isNotEmpty) '${waiting.length}!'].join(' · ');
  return TraySummary(title, lines);
}
