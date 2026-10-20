import 'dart:io';

import 'package:flutter/material.dart';

import '../../data/remote.dart' show SessionEnd;
import '../../gen/vibevalley.dart';
import '../../rules/board.dart';
import '../../rules/issues.dart';
import '../../rules/rounds.dart' show tookText;
import '../../shared/chat_widgets.dart' show ManagerHead;
import '../../shared/faces.dart';
import '../../ui/pro/pro.dart';
import 'issues_page.dart';
import 'marks.dart';

/// What a card and a list row both show of one board card. `detail` is everything else: it is the hover tip.
class CardLook {
  const CardLook({
    required this.number,
    required this.title,
    required this.status,
    required this.flags,
    required this.detail,
    this.statusColor,
    this.priority,
    this.progress,
  });

  /// `#12`, or null for a task whose issue the board has not read.
  final String? number;
  final String title;
  final IssueStatus status;
  final Color? statusColor;
  final Priority? priority;
  final List<(String, Color)> flags;
  final String detail;
  final ({int done, int total})? progress;
}

String _number(Issue i) => '#${numberText(i.number)}';

double _issueUpdated(Issue i) => [i.createdAt, ?i.queuedAt, ?i.closedAt, ?i.acceptedAt].reduce((a, b) => a > b ? a : b);

RowFacts rowFacts(BoardCard card) => switch (card) {
  TodoCard(:final item) => RowFacts(
    lane: card.lane,
    priority: item.priority,
    createdAt: item.createdAt,
    updatedAt: _issueUpdated(item),
    project: item.project,
    agent: item.assignee,
  ),
  IssueCard(:final issue, :final sessions) => RowFacts(
    lane: card.lane,
    priority: issue.priority,
    createdAt: issue.createdAt,
    updatedAt: [
      _issueUpdated(issue),
      for (final s in sessions) ...[s.hiredAt, ?s.lastRun?.at, ?s.endedAt],
    ].reduce((a, b) => a > b ? a : b),
    project: issue.project,
    agent: issue.assignee,
  ),
  ManagerCard(:final issue) || MissingSessionCard(:final issue) => RowFacts(
    lane: card.lane,
    priority: issue.priority,
    createdAt: issue.createdAt,
    updatedAt: _issueUpdated(issue),
    project: issue.project,
    agent: issue.assignee,
  ),
  TaskCard(:final graph, :final issue) => RowFacts(
    lane: card.lane,
    createdAt: issue?.createdAt ?? graph.createdAt,
    updatedAt: issue == null ? graph.createdAt : _issueUpdated(issue),
    project: graph.project,
  ),
};

CardLook cardLook(BoardCard card, {required String Function(String agent) nameOf, required List<TaskGraph> graphs, required double now}) {
  final flags = <(String, Color)>[];
  final lines = <String>[];
  switch (card) {
    case TodoCard(:final item):
      if (item.drafting case final d?) {
        flags.add(('${d.name}在起草', Palette.water));
      } else if (item.status == IssueStatus.backlog) {
        flags.add(('草稿', Palette.wheat));
      }
      if (item.queuedAt != null) flags.add(('排队中', Palette.water));
      if (item.schedule != null) flags.add(('定时', Palette.cream300));
      lines.add(item.assignee == null ? '还没选帮工' : nameOf(item.assignee!));
      if (item.assignee == null || item.project == null) lines.add('没选帮工或项目，开工前要选好');
      lines.add(item.queuedAt != null ? '等空地，${ago(item.queuedAt!, now)}排上的' : '写于 ${ago(item.createdAt, now)}');
      return CardLook(number: _number(item), title: item.title, status: item.status, priority: item.priority, flags: flags, detail: lines.join('\n'));
    case IssueCard(:final issue, :final sessions, :final head, :final state, :final session):
      final phase = session?.phase;
      final now0 = session ?? head;
      if (session?.conflict != null) flags.add(('冲突', Palette.berry));
      if (phase is PhaseFailed || now0.lastRun?.outcome == Outcome.failed) flags.add(('没做成', Palette.berry));
      if (state == IssueTag.lost) flags.add(('丢了', Palette.berry));
      if (issue.schedule != null) flags.add(('定时', Palette.cream300));
      lines.add(head.name);
      if (phase is PhaseWorking && phase.quietSince != null) lines.add('${tookText(now - phase.quietSince!)}没动静');
      if (sessions.length > 1) lines.add('第 ${sessions.length} 次');
      final turns = now0.runs.round();
      final cny = now0.spent?.cny;
      final took = state.open ? '开了 ${tookText(now - head.hiredAt)}' : '用了 ${tookText((issue.closedAt ?? head.endedAt ?? now) - sessions.first.hiredAt)}';
      lines.add([if (state == IssueTag.working) '第 ${turns + 1} 轮' else '$turns 轮', took, if (cny != null) '¥${cny.toStringAsFixed(2)}'].join(' · '));
      final said = now0.lastRun?.summary;
      if (state == IssueTag.waiting && said != null && said.isNotEmpty) lines.add(said);
      if (!state.open) lines.add('${state.label} · ${ago(issue.closedAt ?? head.endedAt ?? head.hiredAt, now)}');
      return CardLook(
        number: _number(issue),
        title: issueTitle(issue, graphs),
        status: issue.status,
        statusColor: state == IssueTag.lost ? Palette.berry : null,
        priority: issue.priority,
        flags: flags,
        detail: lines.join('\n'),
      );
    case ManagerCard(:final issue):
      if (issue.schedule != null) flags.add(('定时', Palette.cream300));
      final state = issueTag(issue);
      lines.add(state.open ? '管家在做' : '${state.label} · ${ago(issue.closedAt ?? issue.createdAt, now)}');
      return CardLook(number: _number(issue), title: issue.title, status: issue.status, priority: issue.priority, flags: flags, detail: lines.join('\n'));
    case MissingSessionCard(:final issue, :final history):
      flags.add(('记录缺失', Palette.berry));
      return CardLook(
        number: _number(issue),
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        flags: flags,
        detail: '执行记录缺失：${history.missingSessions.join('、')}',
      );
    case TaskCard(:final graph, :final issue):
      return CardLook(
        number: issue == null ? null : _number(issue),
        title: '计划：${graph.title}',
        status: issue?.status ?? laneStatus(card.lane),
        flags: flags,
        detail: taskLine(graph),
        progress: (done: (graph.settled ?? 0).round(), total: graph.tasks.length),
      );
  }
}

/// Who works it: the helper's face, the manager's head, or a dashed circle for nobody yet. A task has none.
Widget? cardFace(BoardCard card, {double size = 18}) => switch (card) {
  TaskCard() => null,
  ManagerCard() => ManagerHead(size: size),
  _ when card.agent != null => AgentFaceOf(card.agent!, size: size),
  _ => NoFaceMark(size: size - 2),
};

/// The hover tip; a phone has no hover and a long press there picks the card up.
String? cardTip(CardLook look) => Platform.isIOS || Platform.isAndroid ? null : look.detail;

/// A card's or row's flags, in one line.
List<Widget> flagChips(CardLook look) => [for (final (text, color) in look.flags) FlagChip(text, color)];
