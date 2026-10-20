import 'dart:convert';

import 'package:flutter/material.dart';

import '../ui/theme.dart';
import '../gen/vibevalley.dart';
import '../rules/rounds.dart';
import '../ui/pixel/base.dart';
import '../ui/icons.dart';
import '../ui/labels.dart';
import '../ui/pixel/markdown.dart';
import 'widgets.dart';

const _nearBottom = 48.0;

class WorkLog extends StatefulWidget {
  const WorkLog({super.key, required this.steps, required this.now, this.asked, this.tall = false, this.working = false});
  final List<SessionEvent> steps;
  final double now;

  final String? asked;

  final bool tall;

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
      color: Palette.cream100,
      child: SingleChildScrollView(
        controller: _scroll,
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < rounds.length; i++) ...[
              if (i > 0) const SizedBox(height: 10),
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
    final label = asked == null
        ? '更早的步骤'
        : asked.under != null
        ? '帮手接到'
        : (widget.asked ?? (asked.seq == firstAsked ? '工单' : '带话'));
    return Container(
      decoration: BoxDecoration(border: Border.all(color: Palette.cream300)),
      padding: const EdgeInsets.all(6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Tappable(
            onTap: () => setState(() => _toggled[_idOf(round)] = !open),
            semanticLabel: open ? '收起这一轮' : '展开这一轮',
            builder: (context, s) => Container(
              color: s.hovered ? Palette.creamHover : null,
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              child: Row(
                children: [
                  AnimatedRotation(
                    turns: open ? .25 : 0,
                    duration: motionDuration(context, const Duration(milliseconds: 150)),
                    child: const SpriteIcon('button-next', size: 12),
                  ),
                  const SizedBox(width: 6),
                  Text(label, style: PxText.xs.copyWith(color: Palette.bark800)),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${round.steps.length} 步 · ${tookText(roundMs(round, end: end))}${live ? ' · 进行中' : ''}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: PxText.xs.copyWith(color: Palette.bark400),
                    ),
                  ),
                  if (asked != null) _When(at: asked.time, now: widget.now),
                ],
              ),
            ),
          ),
          if (asked != null) ...[const SizedBox(height: 4), _keyed(asked, _askedView(asked))],
          if (round.steps.isNotEmpty) ...[
            const SizedBox(height: 6),
            _TimeBar(
              spans: spansOf(round, end: end),
              onPick: (step) => _show(round, step),
            ),
          ],
          for (final step in shown) ...[const SizedBox(height: 6), _keyed(step, _indented(step))],
          if (!open && round.steps.length > shown.length)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: InlineLink('看这一轮的 ${round.steps.length} 步', onTap: () => setState(() => _toggled[_idOf(round)] = true)),
            ),
        ],
      ),
    );
  }

  Widget _askedView(SessionEvent asked) {
    return Container(
      color: Palette.wheat.withValues(alpha: .25),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: _Folded(text: asked.text, lines: 4, markdown: false),
    );
  }

  Widget _keyed(SessionEvent step, Widget child) {
    final n = step.seq.round();
    final marked = _marked == n;
    return Container(
      key: _keys.putIfAbsent(n, GlobalKey.new),
      decoration: marked ? BoxDecoration(border: Border.all(color: Palette.wheat, width: 2)) : null,
      child: child,
    );
  }

  Widget _indented(SessionEvent step) {
    final item = _Step(step: step, now: widget.now, job: false, asked: widget.asked);
    if (step.under != null) {
      return Container(
        margin: const EdgeInsets.only(left: 20),
        padding: const EdgeInsets.only(left: 8),
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: Palette.leaf500.withValues(alpha: .4), width: 2)),
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
    return SizedBox(
      height: 14,
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
    );
  }
}

String spanLabel(SessionEvent step) => switch (step.type) {
  SessionEventType.userMessage => '收到',
  SessionEventType.memoryRecalled => '想起',
  SessionEventType.assistantThinking => '思考',
  SessionEventType.assistantMessage => '说',
  SessionEventType.llmRetry => '重试',
  SessionEventType.llmUsage => '缓存',
  SessionEventType.runError => '出错',
  SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult => '',
  SessionEventType.toolCall => farmToolText(step.text) != null ? '田头' : step.actionText ?? '工具',
};

Color spanColor(SessionEvent step) => switch (step.type) {
  SessionEventType.userMessage => Palette.wheat,
  SessionEventType.memoryRecalled => Palette.leaf300,
  SessionEventType.assistantThinking => Palette.cream300,
  SessionEventType.assistantMessage => Palette.leaf500,
  SessionEventType.llmRetry || SessionEventType.llmUsage => Palette.wheatHover,
  SessionEventType.runError => Palette.berry,
  SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult => Palette.cream200,
  SessionEventType.toolCall when step.ok == false => Palette.berry,
  SessionEventType.toolCall => switch (step.action ?? ToolAction.other) {
    ToolAction.readFile || ToolAction.search || ToolAction.web => Palette.water,
    ToolAction.editFile => Palette.leaf700,
    ToolAction.runCommand => Palette.bark600,
    ToolAction.wait => Palette.cream200,
    ToolAction.mcp || ToolAction.other => Palette.bark400,
  },
};

class _Step extends StatelessWidget {
  const _Step({required this.step, required this.now, required this.job, this.asked});
  final SessionEvent step;
  final double now;
  final bool job;
  final String? asked;

  @override
  Widget build(BuildContext context) {
    final sub = step.under != null;
    Widget box({required Color? fill, Border? border, double opacity = 1, required String label, required Widget body}) => Opacity(
      opacity: opacity,
      child: Container(
        decoration: BoxDecoration(color: fill, border: border),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            _Head(label: label, at: step.time, now: now),
            const SizedBox(height: 2),
            body,
          ],
        ),
      ),
    );
    switch (step.type) {
      case SessionEventType.userMessage:
        return box(
          fill: Palette.wheat.withValues(alpha: .25),
          label: sub ? '帮手接到' : (asked ?? (job ? '工单' : '带话')),
          body: _Folded(text: step.text, lines: 4, markdown: false),
        );
      case SessionEventType.memoryRecalled:
        return box(
          fill: Palette.leaf300.withValues(alpha: .15),
          border: Border.all(color: Palette.leaf500.withValues(alpha: .4)),
          label: '想起了',
          body: _Folded(text: step.text, lines: 3, markdown: false),
        );
      case SessionEventType.assistantThinking:
        return box(
          fill: null,
          border: Border.all(color: Palette.cream300),
          opacity: .8,
          label: sub ? '帮手想了想' : '想了想',
          body: _Folded(text: step.text, lines: 2, markdown: false),
        );
      case SessionEventType.assistantMessage:
        return box(
          fill: Palette.cream50,
          label: sub ? '帮手说' : '它说',
          body: _Folded(text: step.text, lines: 8, markdown: true),
        );
      case SessionEventType.toolCall:
        return _ToolStep(step: step, now: now);
      case SessionEventType.llmRetry:
        return _Line(mark: 'button-replay', text: step.text, at: step.time, now: now, fill: Palette.wheat.withValues(alpha: .15), ink: Palette.bark800);
      case SessionEventType.llmUsage:
        return _Line(mark: 'icon-coin', text: step.text, at: step.time, now: now, fill: Palette.wheat.withValues(alpha: .08), ink: Palette.bark600);
      case SessionEventType.runError:
        return _Line(mark: 'mark-warn', text: step.text, at: step.time, now: now, fill: Palette.berry.withValues(alpha: .12), ink: Palette.berry);
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
    color: fill,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(padding: const EdgeInsets.only(top: 2), child: SpriteIcon(mark, size: 12)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text, style: PxText.xs.copyWith(color: ink)),
        ),
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
  Widget build(BuildContext context) => Text(ago(at, now), style: PxText.xs.copyWith(color: Palette.bark400));
}

class _Head extends StatelessWidget {
  const _Head({required this.label, required this.at, required this.now});
  final String label;
  final double at;
  final double now;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(label, style: PxText.xs.copyWith(color: Palette.bark600)),
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
    final long = widget.text.length > widget.lines * 60 || widget.text.split('\n').length > widget.lines;
    final clamp = !_open && long;
    // The log is read, not chatted: folded or not, it is in the reading font.
    Widget body = widget.markdown ? PxMarkdown(widget.text, reading: true) : PxReadText(widget.text, maxLines: clamp ? widget.lines : null);
    // Markdown has no line clamp: it is cut at the lines' height instead.
    if (widget.markdown && clamp) {
      body = ClipRect(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: widget.lines * PxText.read.fontSize! * PxText.read.height!),
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
            padding: const EdgeInsets.only(top: 2),
            child: InlineLink(_open ? '收起' : '展开全部', onTap: () => setState(() => _open = !_open)),
          ),
      ],
    );
  }
}

String? farmToolText(String text) => switch (RegExp(r'^vibevalley__(channel_say|channel_read|channel_inbox|session_list)').firstMatch(text.trim())?.group(1)) {
  'channel_say' => '在田头说话',
  'channel_read' => '读田头的消息',
  'channel_inbox' => '看有没有找它的话',
  'session_list' => '看田头上都有谁',
  null => null,
  final other => '田头：$other',
};

String readableInput(SessionEvent step) {
  final raw = step.input?.trim() ?? '';
  if (raw.isEmpty) return '';
  try {
    final parsed = jsonDecode(raw);
    if (parsed is Map) {
      if (parsed['command'] is String) return '\$ ${parsed['command']}';
      return const JsonEncoder.withIndent('  ').convert(parsed);
    }
    if (parsed is List) return const JsonEncoder.withIndent('  ').convert(parsed);
  } on FormatException {
    // Not JSON (or clipped): show it as it came.
  }
  return raw;
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
    // The pixel font has no ✓ or ✗: their sprites instead.
    final (mark, label) = switch (step.ok) {
      null => (Text('…', style: PxText.xs.copyWith(color: Palette.bark400)), '进行中'),
      true => (const SpriteIcon('mark-check', size: 12), '成功'),
      false => (const SpriteIcon('mark-cross', size: 12), '失败'),
    };
    return Container(
      color: Palette.cream50.withValues(alpha: .6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Tappable(
            onTap: () => setState(() => _open = !_open),
            semanticLabel: '${farm != null ? '田头' : step.actionText ?? ''} $what',
            builder: (context, s) => Container(
              color: s.hovered ? Palette.cream50 : null,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                children: [
                  ActionGlyph(action, size: 18),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 56,
                    child: Text(farm != null ? '田头' : step.actionText ?? '', style: PxText.sm.copyWith(color: Palette.bark800)),
                  ),
                  const SizedBox(width: 8),
                  // The whole command is one tap away (the row opens), not a tooltip as wide as the window.
                  Expanded(
                    child: Text(
                      what,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: PxText.mono.copyWith(color: Palette.bark600),
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
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (step.tool != null) Text('工具 ${step.tool}', style: PxText.xs.copyWith(color: Palette.bark400)),
                  if (input.isNotEmpty) ...[const SizedBox(height: 6), _Pre(input, fill: Palette.bark900, ink: Palette.cream100, maxHeight: 160)],
                  const SizedBox(height: 6),
                  if (step.output case final out? when out.isNotEmpty)
                    _Pre(out, fill: Palette.cream200, ink: Palette.bark900, maxHeight: 224)
                  else
                    Text(step.ok == null ? '还没返回' : '没有输出', style: PxText.xs.copyWith(color: Palette.bark400)),
                ],
              ),
            ),
        ],
      ),
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
    color: fill,
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    child: SingleChildScrollView(
      child: SelectableText(text, style: PxText.mono.copyWith(color: ink, height: 1.625)),
    ),
  );
}

/// 干活过程 starts folded to one line: the steps are there to look into, not to read through every time.
class FoldedWorkLog extends StatefulWidget {
  const FoldedWorkLog({super.key, required this.steps, required this.child});
  final List<SessionEvent> steps;
  final Widget child;

  @override
  State<FoldedWorkLog> createState() => _FoldedWorkLogState();
}

class _FoldedWorkLogState extends State<FoldedWorkLog> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final tools = widget.steps.where((s) => s.type == SessionEventType.toolCall).length;
    final label = tools > 0 ? '用了 $tools 个工具' : '${widget.steps.length} 条记录';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: InlineLink(_open ? '$label · 收起' : '$label · 展开', onTap: () => setState(() => _open = !_open)),
        ),
        if (_open) ...[const SizedBox(height: 6), widget.child],
      ],
    );
  }
}
