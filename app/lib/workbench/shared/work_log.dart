import 'package:flutter/material.dart';

import '../../gen/vibevalley.dart';
import '../../rules/rounds.dart';
import '../../shared/work_log_rules.dart';
import '../../ui/pro/pro.dart';

const _nearBottom = 48.0;

/// The workbench's work log: a session's steps by round, each round folded to its answer but the last. The farm has its own
/// (shared/work_log.dart); what a step says and its colour are shared (shared/work_log_rules.dart).
class WorkLog extends StatefulWidget {
  const WorkLog({super.key, required this.steps, required this.now, this.asked, this.tall = false, this.working = false});
  final List<SessionEvent> steps;
  final double now;

  /// What a word the session got is called; by default 工单 for the first, 带话 after.
  final String? asked;
  final bool tall;

  /// The last round is still going: its time runs to now.
  final bool working;

  @override
  State<WorkLog> createState() => _WorkLogState();
}

class _WorkLogState extends State<WorkLog> {
  final _scroll = ScrollController();
  final _keys = <int, GlobalKey>{};
  bool _atBottom = true;

  /// By the `n` of what started each round (-1: before the first); the last is open unless closed.
  final _toggled = <int, bool>{};

  int? _marked;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      final p = _scroll.position;
      _atBottom = p.maxScrollExtent - p.pixels < _nearBottom;
    });
    _stick();
  }

  @override
  void didUpdateWidget(WorkLog old) {
    super.didUpdateWidget(old);
    if (old.steps != widget.steps) _stick();
  }

  void _stick() {
    if (!_atBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  int _idOf(Round r) => r.asked?.seq.round() ?? -1;

  bool _open(Round r, bool last) => _toggled[_idOf(r)] ?? last;

  void _show(Round r, SessionEvent step) {
    setState(() {
      _toggled[_idOf(r)] = true;
      _marked = step.seq.round();
      _atBottom = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final at = _keys[step.seq.round()]?.currentContext;
      if (at != null) Scrollable.ensureVisible(at, alignment: .3, duration: const Duration(milliseconds: 200));
    });
  }

  @override
  Widget build(BuildContext context) {
    final steps = shownEvents(widget.steps);
    final rounds = roundsOf(steps);
    final firstAsked = steps.where((s) => s.type == SessionEventType.userMessage && s.under == null).firstOrNull?.seq;
    return Container(
      constraints: BoxConstraints(maxHeight: widget.tall ? 576 : 352),
      decoration: const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: proRadius),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        controller: _scroll,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < rounds.length; i++) ...[
              if (i > 0) const Divider(height: 1, thickness: 1, color: ProColor.line),
              _roundView(rounds[i], last: i == rounds.length - 1, firstAsked: firstAsked),
            ],
          ],
        ),
      ),
    );
  }

  Widget _roundView(Round round, {required bool last, required double? firstAsked}) {
    final live = last && widget.working;
    final end = live ? widget.now : (round.all.lastOrNull?.time ?? widget.now);
    final open = _open(round, last);
    final answer = round.answer;
    final shown = open ? round.steps : [?answer];
    final asked = round.asked;
    final label = roundLabel(round, firstAsked: firstAsked, asked: widget.asked);
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Tappable(
            onTap: () => setState(() => _toggled[_idOf(round)] = !open),
            semanticLabel: open ? '收起这一轮' : '展开这一轮',
            builder: (context, s) => Container(
              decoration: BoxDecoration(color: s.hovered ? ProColor.hover : null, borderRadius: proRadius),
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              child: Row(
                children: [
                  AnimatedRotation(
                    turns: open ? .25 : 0,
                    duration: motionDuration(context, const Duration(milliseconds: 150)),
                    child: const SpriteIcon('button-next', size: 12),
                  ),
                  const SizedBox(width: 8),
                  Text(label, style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${round.steps.length} 步 · ${tookText(roundMs(round, end: end))}${live ? ' · 进行中' : ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ProText.meta,
                    ),
                  ),
                  if (asked != null) _When(at: asked.time, now: widget.now),
                ],
              ),
            ),
          ),
          if (asked != null) ...[const SizedBox(height: 6), _keyed(asked, _askedView(asked))],
          if (round.steps.isNotEmpty) ...[
            const SizedBox(height: 8),
            _TimeBar(
              spans: spansOf(round, end: end),
              onPick: (step) => _show(round, step),
            ),
          ],
          for (final step in shown) ...[const SizedBox(height: 6), _keyed(step, _indented(step))],
          if (!open && round.steps.length > shown.length)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 6),
              child: DefaultTextStyle(
                style: ProText.sm,
                child: InlineLink('看这一轮的 ${round.steps.length} 步', onTap: () => setState(() => _toggled[_idOf(round)] = true)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _askedView(SessionEvent asked) => Container(
    decoration: BoxDecoration(color: Palette.wheat.withValues(alpha: .14), borderRadius: proRadius),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    child: _Folded(text: asked.text, lines: 4, markdown: false),
  );

  Widget _keyed(SessionEvent step, Widget child) {
    final n = step.seq.round();
    final marked = _marked == n;
    return Container(
      key: _keys.putIfAbsent(n, GlobalKey.new),
      decoration: marked
          ? BoxDecoration(
              border: Border.all(color: Palette.wheat, width: 1.5),
              borderRadius: proRadius,
            )
          : null,
      child: child,
    );
  }

  Widget _indented(SessionEvent step) {
    final item = _Step(step: step, now: widget.now, asked: widget.asked);
    if (step.under != null) {
      return Container(
        margin: const EdgeInsets.only(left: 20),
        padding: const EdgeInsets.only(left: 10),
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: Palette.leaf500.withValues(alpha: .5), width: 2)),
        ),
        child: item,
      );
    }
    return item;
  }
}

class _TimeBar extends StatelessWidget {
  const _TimeBar({required this.spans, required this.onPick});
  final List<Span> spans;
  final ValueChanged<SessionEvent> onPick;

  @override
  Widget build(BuildContext context) {
    final total = spans.fold<double>(0, (sum, s) => sum + s.ms);
    // The shortest span still shows: at least 1/80 of the bar.
    final least = total <= 0 ? 1.0 : total / 80;
    return ClipRRect(
      borderRadius: const BorderRadius.all(Radius.circular(3)),
      child: SizedBox(
        height: 8,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final span in spans)
              Expanded(
                flex: ((span.ms < least ? least : span.ms) / least * 10).round().clamp(1, 1 << 30),
                child: Tooltip(
                  message: '${spanLabel(span.step)} · ${tookText(span.ms)}\n${span.step.text.split('\n').first}',
                  child: Tappable(
                    onTap: () => onPick(span.step),
                    semanticLabel: '${spanLabel(span.step)} ${tookText(span.ms)}',
                    builder: (context, s) => Container(margin: const EdgeInsets.only(right: 1), color: s.hovered ? Palette.bark900 : spanColor(span.step)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.step, required this.now, this.asked});
  final SessionEvent step;
  final double now;
  final String? asked;

  @override
  Widget build(BuildContext context) {
    final sub = step.under != null;
    Widget box({required Color? fill, bool edge = false, double opacity = 1, required String label, required Widget body}) => Opacity(
      opacity: opacity,
      child: Container(
        decoration: BoxDecoration(
          color: fill,
          border: edge ? const Border.fromBorderSide(proLine) : Border.all(color: const Color(0x00000000)),
          borderRadius: proRadius,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            _Head(label: label, at: step.time, now: now),
            const SizedBox(height: 4),
            body,
          ],
        ),
      ),
    );
    switch (step.type) {
      case SessionEventType.userMessage:
        return box(
          fill: Palette.wheat.withValues(alpha: .14),
          label: sub ? '帮手接到' : (asked ?? '带话'),
          body: _Folded(text: step.text, lines: 4, markdown: false),
        );
      case SessionEventType.memoryRecalled:
        return box(
          fill: Palette.leaf300.withValues(alpha: .15),
          label: '想起了',
          body: _Folded(text: step.text, lines: 3, markdown: false),
        );
      case SessionEventType.assistantThinking:
        return box(
          fill: null,
          edge: true,
          opacity: .8,
          label: sub ? '帮手想了想' : '想了想',
          body: _Folded(text: step.text, lines: 2, markdown: false),
        );
      case SessionEventType.assistantMessage:
        return box(
          fill: ProColor.hover,
          label: sub ? '帮手说' : '它说',
          body: _Folded(text: step.text, lines: 8, markdown: true),
        );
      case SessionEventType.toolCall:
        return _ToolStep(step: step, now: now);
      case SessionEventType.llmRetry:
        return _Line(mark: 'button-replay', text: step.text, at: step.time, now: now, fill: Palette.wheat.withValues(alpha: .12), ink: ProColor.ink);
      case SessionEventType.llmUsage:
        return _Line(mark: 'icon-coin', text: step.text, at: step.time, now: now, fill: Palette.wheat.withValues(alpha: .06), ink: ProColor.muted);
      case SessionEventType.runError:
        return _Line(mark: 'mark-warn', text: step.text, at: step.time, now: now, fill: Palette.berry.withValues(alpha: .1), ink: Palette.berry);
      // Not rows: a run's bounds split the rounds, a result is shown in its call (shownEvents).
      case SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult:
        return const SizedBox.shrink();
    }
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.mark, required this.text, required this.at, required this.now, required this.fill, required this.ink});

  final String mark;
  final String text;
  final double at;
  final double now;
  final Color fill;
  final Color ink;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(color: fill, borderRadius: proRadius),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(top: 3), child: SpriteIcon(mark, size: 12)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text, style: ProText.sm.copyWith(color: ink)),
        ),
        const SizedBox(width: 8),
        _When(at: at, now: now),
      ],
    ),
  );
}

class _When extends StatelessWidget {
  const _When({required this.at, required this.now});
  final double at;
  final double now;

  @override
  Widget build(BuildContext context) => Text(ago(at, now), style: ProText.meta.copyWith(color: ProColor.faint));
}

class _Head extends StatelessWidget {
  const _Head({required this.label, required this.at, required this.now});
  final String label;
  final double at;
  final double now;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(
        label,
        style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
      ),
      const Spacer(),
      _When(at: at, now: now),
    ],
  );
}

class _Folded extends StatefulWidget {
  const _Folded({required this.text, required this.lines, required this.markdown});
  final String text;
  final int lines;
  final bool markdown;

  @override
  State<_Folded> createState() => _FoldedState();
}

class _FoldedState extends State<_Folded> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final long = isLongText(widget.text, widget.lines);
    final clamp = !_open && long;
    Widget body = widget.markdown
        ? ProMarkdown(widget.text)
        : Text(widget.text, maxLines: clamp ? widget.lines : null, overflow: clamp ? TextOverflow.ellipsis : null, style: ProText.base);
    // Markdown has no line clamp: it is cut at the lines' height instead.
    if (widget.markdown && clamp) {
      body = ClipRect(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: widget.lines * ProText.base.fontSize! * ProText.base.height!),
          child: OverflowBox(alignment: Alignment.topLeft, maxHeight: double.infinity, child: body),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        body,
        if (long)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: DefaultTextStyle(
              style: ProText.sm,
              child: InlineLink(_open ? '收起' : '展开全部', onTap: () => setState(() => _open = !_open)),
            ),
          ),
      ],
    );
  }
}

class _ToolStep extends StatefulWidget {
  const _ToolStep({required this.step, required this.now});
  final SessionEvent step;
  final double now;

  @override
  State<_ToolStep> createState() => _ToolStepState();
}

class _ToolStepState extends State<_ToolStep> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final step = widget.step;
    final action = SessionAction.fromJson((step.action ?? ToolAction.other).wire);
    final farm = farmToolText(step.text);
    final what = farm ?? step.text;
    final input = readableInput(step);
    final (mark, label) = switch (step.ok) {
      null => (Text('…', style: ProText.meta.copyWith(color: ProColor.faint)), '进行中'),
      true => (const SpriteIcon('mark-check', size: 12), '成功'),
      false => (const SpriteIcon('mark-cross', size: 12), '失败'),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Tappable(
          onTap: () => setState(() => _open = !_open),
          semanticLabel: '${farm != null ? '田头' : step.actionText ?? ''} $what',
          builder: (context, s) => Container(
            decoration: BoxDecoration(color: s.hovered || _open ? ProColor.hover : null, borderRadius: proRadius),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            child: Row(
              children: [
                ActionGlyph(action, size: 16),
                const SizedBox(width: 8),
                SizedBox(
                  width: 64,
                  child: Text(
                    farm != null ? '田头' : step.actionText ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
                  ),
                ),
                const SizedBox(width: 8),
                // The whole command is one tap away (the row opens), not a tooltip as wide as the window.
                Expanded(
                  child: Text(
                    what,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ProText.mono.copyWith(color: ProColor.muted),
                  ),
                ),
                const SizedBox(width: 8),
                Tooltip(message: label, child: mark),
                const SizedBox(width: 8),
                _When(at: step.time, now: widget.now),
              ],
            ),
          ),
        ),
        if (_open)
          Padding(
            padding: const EdgeInsets.fromLTRB(32, 4, 8, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (step.tool != null) Text('工具 ${step.tool}', style: ProText.meta),
                if (input.isNotEmpty) ...[const SizedBox(height: 6), _Pre(input, fill: Palette.bark900, ink: Palette.cream100, maxHeight: 160)],
                const SizedBox(height: 6),
                if (step.output case final out? when out.isNotEmpty)
                  _Pre(out, fill: ProColor.hover, ink: ProColor.ink, maxHeight: 224)
                else
                  Text(step.ok == null ? '还没返回' : '没有输出', style: ProText.meta),
              ],
            ),
          ),
      ],
    );
  }
}

class _Pre extends StatelessWidget {
  const _Pre(this.text, {required this.fill, required this.ink, required this.maxHeight});
  final String text;
  final Color fill;
  final Color ink;
  final double maxHeight;

  @override
  Widget build(BuildContext context) => Container(
    constraints: BoxConstraints(maxHeight: maxHeight),
    decoration: BoxDecoration(color: fill, borderRadius: proRadius),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    child: SingleChildScrollView(
      child: SelectableText(text, style: ProText.mono.copyWith(color: ink)),
    ),
  );
}
