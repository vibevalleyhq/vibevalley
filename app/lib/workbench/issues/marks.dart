import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../ui/pro/pro.dart';
import 'issues_page.dart' show priorityLabel;

const _statusLabel = {
  IssueStatus.backlog: '草稿',
  IssueStatus.todo: '待办',
  IssueStatus.inProgress: '处理中',
  IssueStatus.inReview: '等你看',
  IssueStatus.done: '已关',
  IssueStatus.canceled: '收工了',
};

/// A lane's header shows the status its cards mostly have.
IssueStatus laneStatus(Lane lane) => switch (lane) {
  Lane.todo => IssueStatus.todo,
  Lane.working => IssueStatus.inProgress,
  Lane.waiting => IssueStatus.inReview,
  Lane.closed => IssueStatus.done,
};

Color statusColor(IssueStatus s) => switch (s) {
  IssueStatus.backlog => ProColor.faint,
  IssueStatus.todo => ProColor.muted,
  IssueStatus.inProgress => Palette.water,
  IssueStatus.inReview => Palette.wheat,
  IssueStatus.done => Palette.leaf500,
  IssueStatus.canceled => ProColor.faint,
};

/// The status an issue is drawn with: a ring that fills as the work goes on, as Linear draws it.
class StatusMark extends StatelessWidget {
  const StatusMark(this.status, {super.key, this.size = 14, this.color, this.label});
  final IssueStatus status;
  final double size;

  /// Instead of the status's own colour: a lost issue is berry.
  final Color? color;
  final String? label;

  @override
  Widget build(BuildContext context) => Semantics(
    label: label ?? _statusLabel[status],
    child: CustomPaint(size: Size.square(size), painter: _StatusPainter(status, color ?? statusColor(status))),
  );
}

class _StatusPainter extends CustomPainter {
  _StatusPainter(this.status, this.color);
  final IssueStatus status;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2 - 1;
    final ring = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final fill = Paint()..color = color;
    switch (status) {
      case IssueStatus.backlog:
        // Dashed: not yet asked for.
        const dashes = 8;
        for (var i = 0; i < dashes; i++) {
          final start = i * 2 * math.pi / dashes;
          canvas.drawArc(Rect.fromCircle(center: c, radius: r), start, math.pi / dashes, false, ring);
        }
      case IssueStatus.todo:
        canvas.drawCircle(c, r, ring);
      case IssueStatus.inProgress || IssueStatus.inReview:
        canvas.drawCircle(c, r, ring);
        final part = status == IssueStatus.inProgress ? .5 : .75;
        canvas.drawArc(Rect.fromCircle(center: c, radius: r - 2.5), -math.pi / 2, 2 * math.pi * part, true, fill);
      case IssueStatus.done || IssueStatus.canceled:
        canvas.drawCircle(c, r + .75, fill);
        final mark = Paint()
          ..color = Palette.paper
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5
          ..strokeCap = StrokeCap.round;
        final u = r / 2.2;
        if (status == IssueStatus.done) {
          canvas.drawPath(
            Path()
              ..moveTo(c.dx - u, c.dy)
              ..lineTo(c.dx - u * .25, c.dy + u * .75)
              ..lineTo(c.dx + u, c.dy - u * .6),
            mark,
          );
        } else {
          canvas.drawLine(c + Offset(-u * .7, -u * .7), c + Offset(u * .7, u * .7), mark);
          canvas.drawLine(c + Offset(u * .7, -u * .7), c + Offset(-u * .7, u * .7), mark);
        }
    }
  }

  @override
  bool shouldRepaint(_StatusPainter old) => old.status != status || old.color != color;
}

/// Bars that rise with the priority; urgent is a filled berry square with a bang, so it stands out on a busy lane.
class PriorityMark extends StatelessWidget {
  const PriorityMark(this.priority, {super.key, this.size = 14});
  final Priority priority;
  final double size;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '优先级：${priorityLabel[priority]}',
    child: Semantics(
      label: priorityLabel[priority],
      child: CustomPaint(size: Size.square(size), painter: _PriorityPainter(priority)),
    ),
  );
}

class _PriorityPainter extends CustomPainter {
  _PriorityPainter(this.priority);
  final Priority priority;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    if (priority == Priority.urgent) {
      final box = RRect.fromRectAndRadius(Rect.fromLTWH(1, 1, s - 2, s - 2), const Radius.circular(3));
      canvas.drawRRect(box, Paint()..color = Palette.berry);
      final bang = Paint()..color = Palette.paper;
      final x = s / 2;
      canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(x - .9, s * .24, 1.8, s * .34), const Radius.circular(.9)), bang);
      canvas.drawCircle(Offset(x, s * .72), 1.1, bang);
      return;
    }
    final lit = switch (priority) {
      Priority.high => 3,
      Priority.medium => 2,
      _ => 1,
    };
    final w = s / 5;
    for (var i = 0; i < 3; i++) {
      final h = s * (.35 + .25 * i);
      final rect = RRect.fromRectAndRadius(Rect.fromLTWH(1 + i * (w + w / 2), s - 1.5 - h, w, h), const Radius.circular(1));
      canvas.drawRRect(rect, Paint()..color = i < lit ? ProColor.muted : ProColor.line);
    }
  }

  @override
  bool shouldRepaint(_PriorityPainter old) => old.priority != priority;
}

/// A task's steps: a ring that fills as they settle, and the count.
class ProgressMark extends StatelessWidget {
  const ProgressMark({super.key, required this.done, required this.total});
  final int done;
  final int total;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      CustomPaint(size: const Size.square(13), painter: _RingPainter(total == 0 ? 0 : done / total)),
      const SizedBox(width: 4),
      Text('$done/$total', style: ProText.meta.copyWith(fontSize: 11, height: 14 / 11)),
    ],
  );
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.part);
  final double part;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.shortestSide / 2 - 1;
    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawCircle(c, r, paint..color = ProColor.line);
    if (part > 0) canvas.drawArc(Rect.fromCircle(center: c, radius: r), -math.pi / 2, 2 * math.pi * part.clamp(0, 1), false, paint..color = Palette.leaf500);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.part != part;
}

/// Nobody picked yet: a dashed circle where the face would be.
class NoFaceMark extends StatelessWidget {
  const NoFaceMark({super.key, this.size = 16});
  final double size;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: '还没选帮工',
    child: CustomPaint(size: Size.square(size), painter: _NoFacePainter()),
  );
}

/// Linear's unassigned: a dashed ring round a small person, so it does not read as a backlog status.
class _NoFacePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    _StatusPainter(IssueStatus.backlog, ProColor.faint).paint(canvas, size);
    final s = size.shortestSide;
    final c = size.center(Offset.zero);
    final ink = Paint()..color = ProColor.faint;
    canvas.drawCircle(c + Offset(0, -s * .12), s * .13, ink);
    canvas.drawArc(Rect.fromCenter(center: c + Offset(0, s * .3), width: s * .5, height: s * .4), math.pi, math.pi, true, ink);
  }

  @override
  bool shouldRepaint(_NoFacePainter old) => false;
}

/// A small flag on a card or row: only the things the owner should notice.
class FlagChip extends StatelessWidget {
  const FlagChip(this.text, this.color, {super.key});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 5),
    decoration: BoxDecoration(color: color.withValues(alpha: .18), borderRadius: const BorderRadius.all(Radius.circular(4))),
    child: Text(
      text,
      maxLines: 1,
      style: ProText.xs.copyWith(fontSize: 11, height: 16 / 11, fontWeight: FontWeight.w500),
    ),
  );
}
