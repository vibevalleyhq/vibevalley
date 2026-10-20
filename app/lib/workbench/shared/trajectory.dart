import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../data/remote.dart';
import '../../gen/vibevalley.dart';
import '../../rules/rounds.dart';
import '../../shared/work_log.dart' show farmToolText, readableInput, spanColor, spanLabel;
import '../../ui/pro/pro.dart';
import 'widgets.dart';

const _nearBottom = 48.0;

/// The widths of the round gutter and the tag column; narrower on a phone.
class _Columns {
  const _Columns(this.gutter, this.tag);
  final double gutter;
  final double tag;

  /// Where the step's text starts.
  double get inset => gutter + tag + 8;

  static _Columns of(double width) => width < 520 ? const _Columns(56, 68) : const _Columns(60, 88);
}

double _now() => DateTime.now().millisecondsSinceEpoch.toDouble();

/// Saves the round its user/message `step` began as a case of the manager's evals; `want` is what it should have done.
typedef MarkWrong = Future<ManagerEval> Function(int step, String want);

String _oneLine(String text) => text.replaceAll(RegExp(r'\s+'), ' ').trim();

/// The part after an MCP server's prefix: `mcp__vibevalley__channel_say` is channel_say.
String _toolName(String tool) {
  final at = tool.lastIndexOf('__');
  return at >= 0 && at + 2 < tool.length ? tool.substring(at + 2) : tool;
}

/// The tag column's word for a step.
String tagOf(SessionEvent step, {String? asked, bool job = false}) {
  final sub = step.under != null;
  return switch (step.type) {
    SessionEventType.userMessage => sub ? '帮手接到' : (asked ?? (job ? '工单' : '带话')),
    SessionEventType.memoryRecalled => '想起',
    SessionEventType.assistantThinking => sub ? '帮手想了想' : '想了想',
    SessionEventType.assistantMessage => sub ? '帮手说' : '它说',
    SessionEventType.llmRetry => '重试',
    SessionEventType.llmUsage => '用量',
    SessionEventType.runError => '出错',
    SessionEventType.toolCall when farmToolText(step.text) != null => '田头',
    SessionEventType.toolCall => switch (step.tool) {
      final tool? when tool.isNotEmpty => _toolName(tool),
      _ => spanLabel(step),
    },
    SessionEventType.runStart || SessionEventType.runEnd || SessionEventType.toolResult => '',
  };
}

Color _tagFill(SessionEvent step) => switch (step.type) {
  SessionEventType.llmUsage => ProColor.selected,
  SessionEventType.llmRetry => Palette.wheatHover,
  _ => spanColor(step),
};

/// A see-through fill shows the page under it, so it reads as light.
Color _inkOn(Color fill) => fill.a > .5 && fill.computeLuminance() < .25 ? Palette.paper : ProColor.ink;

/// What a row is searched by.
String _haystack(SessionEvent step, String tag) => [tag, step.text, step.tool ?? '', step.input ?? '', step.output ?? ''].join('\n').toLowerCase();

/// A trajectory one row per step: the round in the gutter, what kind of step in the tag, its text cut to a line until
/// the row is opened; a waterfall of the rounds over it and their totals under it.
class Trajectory extends StatefulWidget {
  const Trajectory({super.key, required this.steps, required this.now, this.asked, this.working = false, this.onMarkWrong, this.leading});
  final List<SessionEvent> steps;
  final double now;

  /// The tag of what began each round; null: 工单 for the first, 带话 for the others.
  final String? asked;

  final bool working;

  final MarkWrong? onMarkWrong;

  /// The toolbar's left side, before the search box.
  final Widget? leading;

  @override
  State<Trajectory> createState() => _TrajectoryState();
}

class _TrajectoryState extends State<Trajectory> {
  final _scroll = ScrollController();
  final _keys = <int, GlobalKey>{};
  bool _atBottom = true;
  final _open = <int>{};
  int? _marked;
  String _query = '';

  /// The rounds marked wrong here, by their asked step's `n`: the case's file.
  final _wrong = <int, String>{};

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
  void didUpdateWidget(Trajectory old) {
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

  void _show(int seq) {
    setState(() {
      _query = '';
      _marked = seq;
      _atBottom = false;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final at = _keys[seq]?.currentContext;
      if (at != null) Scrollable.ensureVisible(at, alignment: .3, duration: const Duration(milliseconds: 200));
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final body = _body(_Columns.of(box.maxWidth), box.maxWidth);
      return box.hasBoundedHeight ? body : SizedBox(height: 560, child: body);
    },
  );

  Widget _body(_Columns cols, double width) {
    final shown = shownEvents(widget.steps);
    final rounds = roundsOf(shown);
    final last = widget.steps.lastOrNull?.time ?? widget.now;
    final end = widget.working && widget.now > last ? widget.now : last;
    final firstAsked = shown.where((s) => s.type == SessionEventType.userMessage && s.under == null).firstOrNull?.seq;
    final bySeq = {for (final s in shown) s.seq.round(): s};
    final query = _query.trim().toLowerCase();
    final rows = <Widget>[];
    var turn = 0;
    for (final round in rounds) {
      if (round.asked != null) turn++;
      var first = true;
      for (final step in round.all) {
        final tag = tagOf(step, asked: widget.asked, job: step.seq == firstAsked);
        if (query.isNotEmpty && !_haystack(step, tag).contains(query)) continue;
        rows.add(
          _keyed(
            step,
            _row(step, cols, tag: tag, gutter: first ? (round.asked == null ? '更早' : '第 $turn 轮') : null, when: first ? round.all.first.time : null),
          ),
        );
        first = false;
      }
    }
    final summary = summaryOf(widget.steps, end: end);
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(
            children: [
              Expanded(child: widget.leading ?? const SizedBox.shrink()),
              const SizedBox(width: 12),
              SizedBox(
                width: width < 520 ? 150 : 220,
                child: ProTextInput(
                  value: _query,
                  onChanged: (v) => setState(() => _query = v),
                  placeholder: '搜索',
                  icon: 'button-search',
                  semanticLabel: '搜索轨迹',
                ),
              ),
            ],
          ),
        ),
        _Waterfall(
          gutter: cols.gutter,
          fall: waterfallOf(widget.steps, end: end),
          colorOf: (seq) => switch (bySeq[seq.round()]) {
            final step? => spanColor(step),
            null => ProColor.faint,
          },
          onPick: (seq) => _show(seq.round()),
        ),
        const SizedBox(height: 8),
        const Divider(height: 1, thickness: 1, color: ProColor.line),
        Expanded(
          child: rows.isEmpty
              ? const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Align(alignment: Alignment.topLeft, child: EmptyNote('没有对得上的步骤。')),
                )
              : SingleChildScrollView(
                  controller: _scroll,
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows),
                ),
        ),
        const Divider(height: 1, thickness: 1, color: ProColor.line),
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(_summaryText(summary), style: ProText.meta),
        ),
      ],
    );
    return body;
  }

  Widget _keyed(SessionEvent step, Widget child) => KeyedSubtree(key: _keys.putIfAbsent(step.seq.round(), GlobalKey.new), child: child);

  Widget _row(SessionEvent step, _Columns cols, {required String tag, required String? gutter, required double? when}) {
    final n = step.seq.round();
    final row = _Row(
      cols: cols,
      step: step,
      tag: tag,
      gutter: gutter,
      when: when == null ? null : ago(when, widget.now),
      open: _open.contains(n),
      marked: _marked == n,
      onTap: () => setState(() => _open.contains(n) ? _open.remove(n) : _open.add(n)),
    );
    final mark = widget.onMarkWrong;
    if (mark == null || step.type != SessionEventType.userMessage || step.under != null) return row;
    return _Markable(inset: cols.inset, step: n, send: mark, file: _wrong[n], onMarked: (file) => setState(() => _wrong[n] = file), child: row);
  }
}

String _summaryText(TrajectorySummary s) {
  final hit = s.cacheHit;
  return [
    '${s.rounds} 轮',
    '${s.steps} 步',
    '模型用时 ${secondsText(s.modelMs)}',
    '工具用时 ${secondsText(s.toolMs)}',
    if (hit != null) '缓存命中 ${(hit * 100).round()}%',
    if (hit != null) '输入 ${tokensText(s.input + s.cacheRead)} / 输出 ${tokensText(s.output)} token',
  ].join(' · ');
}

class _Row extends StatelessWidget {
  const _Row({
    required this.cols,
    required this.step,
    required this.tag,
    required this.gutter,
    required this.when,
    required this.open,
    required this.marked,
    required this.onTap,
  });
  final _Columns cols;
  final SessionEvent step;
  final String tag;
  final String? gutter;
  final String? when;
  final bool open;
  final bool marked;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fill = _tagFill(step);
    final tool = step.type == SessionEventType.toolCall;
    final failed = (tool && step.ok == false) || step.type == SessionEventType.runError;
    final ink = failed ? Palette.berry : ProColor.ink;
    final text = ProText.sm.copyWith(color: ink);
    final sub = step.under != null;
    final Widget content;
    if (tool) {
      content = Text.rich(_toolLine(step), maxLines: 1, overflow: TextOverflow.ellipsis, style: text);
    } else if (open && step.type == SessionEventType.assistantMessage) {
      content = ProMarkdown(step.text, style: text);
    } else if (open) {
      content = Text(step.text, style: text);
    } else {
      content = Text(open ? step.text : _oneLine(step.text), maxLines: open ? null : 1, overflow: open ? null : TextOverflow.ellipsis, style: text);
    }
    return Tappable(
      onTap: onTap,
      semanticLabel: '$tag ${_oneLine(step.text)}',
      builder: (context, s) => Container(
        decoration: BoxDecoration(
          color: marked
              ? Palette.wheat.withValues(alpha: .35)
              : s.hovered
              ? ProColor.hover
              : null,
          borderRadius: proRadius,
        ),
        padding: const EdgeInsets.fromLTRB(0, 3, 8, 3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: cols.gutter,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 8, top: 2),
                    child: gutter == null ? null : Text(gutter!, maxLines: 1, style: ProText.meta),
                  ),
                ),
                Container(
                  width: sub ? cols.tag - 10 : cols.tag,
                  margin: EdgeInsets.only(top: 1, left: sub ? 10 : 0),
                  decoration: BoxDecoration(color: sub ? fill.withValues(alpha: .55) : fill, borderRadius: const BorderRadius.all(Radius.circular(4))),
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                  child: Text(
                    tag,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: ProText.xs.copyWith(color: _inkOn(fill), fontWeight: FontWeight.w500),
                  ),
                ),
                const SizedBox(width: 8),
                if (failed && tool) const Padding(padding: EdgeInsets.only(top: 4, right: 4), child: SpriteIcon('mark-cross', size: 12)),
                Expanded(child: content),
                if (when != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 8, top: 2),
                    child: Text(when!, style: ProText.meta.copyWith(color: ProColor.faint)),
                  ),
              ],
            ),
            if (open && tool) _ToolDetail(step, inset: cols.inset),
          ],
        ),
      ),
    );
  }
}

/// `what {args} → result`, the args and result in the code font.
TextSpan _toolLine(SessionEvent step) {
  final farm = farmToolText(step.text);
  final code = ProText.mono.copyWith(color: ProColor.muted);
  final args = _oneLine(step.input ?? '');
  final out = _oneLine(step.output ?? '');
  return TextSpan(
    children: [
      TextSpan(text: farm ?? step.text),
      if (args.isNotEmpty) TextSpan(text: ' $args', style: code),
      const TextSpan(text: ' → '),
      if (step.ok == null)
        const TextSpan(text: '还没返回')
      else if (out.isEmpty)
        const TextSpan(text: '没有输出')
      else
        TextSpan(
          text: out,
          style: code.copyWith(color: step.ok == false ? Palette.berry : ProColor.ink),
        ),
    ],
  );
}

class _ToolDetail extends StatelessWidget {
  const _ToolDetail(this.step, {required this.inset});
  final SessionEvent step;
  final double inset;

  @override
  Widget build(BuildContext context) {
    final input = readableInput(step);
    const label = ProText.meta;
    const code = ProText.mono;
    return Padding(
      padding: EdgeInsets.fromLTRB(inset, 4, 0, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            [
              if (step.tool != null) '工具 ${step.tool}',
              switch (step.ok) {
                null => '进行中',
                true => '成功',
                false => '失败',
              },
            ].join(' · '),
            style: label,
          ),
          if (input.isNotEmpty) ...[const SizedBox(height: 4), Text('输入', style: label), SelectableText(input, style: code)],
          const SizedBox(height: 4),
          Text('输出', style: label),
          if (step.output case final out? when out.isNotEmpty) SelectableText(out, style: code) else Text(step.ok == null ? '还没返回' : '没有输出', style: label),
        ],
      ),
    );
  }
}

const _laneNames = {Lane.asked: '收到', Lane.model: '模型', Lane.tool: '工具'};

class _Waterfall extends StatelessWidget {
  const _Waterfall({required this.gutter, required this.fall, required this.colorOf, required this.onPick});
  final double gutter;
  final Waterfall fall;
  final Color Function(double seq) colorOf;
  final ValueChanged<double> onPick;

  static const _lane = 12.0;
  static const _gap = 2.0;
  static const _between = 4.0;

  @override
  Widget build(BuildContext context) {
    final rounds = fall.rounds;
    return SizedBox(
      height: _lane * 3 + _gap * 2,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: gutter,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final lane in Lane.values)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Text(_laneNames[lane]!, style: ProText.meta.copyWith(height: 1)),
                  ),
              ],
            ),
          ),
          Expanded(
            child: LayoutBuilder(
              builder: (context, box) {
                if (rounds.isEmpty) return const SizedBox.shrink();
                // Rounds are laid side by side by how long each took; the idle time between them is a fixed gap.
                final room = (box.maxWidth - _between * (rounds.length - 1)).clamp(0.0, double.infinity);
                final took = [for (final (a, b) in rounds) b - a];
                final total = took.fold<double>(0, (n, t) => n + t);
                final widths = [for (final t in took) total > 0 ? room * t / total : room / rounds.length];
                final lefts = <double>[];
                var x = 0.0;
                for (final w in widths) {
                  lefts.add(x);
                  x += w + _between;
                }
                double at(int r, double t) => lefts[r] + (took[r] > 0 ? (t - rounds[r].$1) / took[r] * widths[r] : 0);
                var r = 0;
                final segments = <Widget>[];
                for (final span in fall.spans) {
                  while (r + 1 < rounds.length && span.start >= rounds[r + 1].$1) {
                    r++;
                  }
                  while (r > 0 && span.start < rounds[r].$1) {
                    r--;
                  }
                  final left = at(r, span.start);
                  final width = (at(r, span.end) - left).clamp(2.0, double.infinity);
                  final color = switch (span.lane) {
                    Lane.asked => Palette.wheat,
                    Lane.model => Palette.leaf500,
                    Lane.tool => colorOf(span.seq),
                  };
                  segments.add(
                    Positioned(
                      left: left,
                      width: width,
                      top: span.lane.index * (_lane + _gap),
                      height: _lane,
                      child: Tooltip(
                        message: '${_laneNames[span.lane]} · ${secondsText(span.ms)}',
                        child: Tappable(
                          onTap: () => onPick(span.seq),
                          semanticLabel: '${_laneNames[span.lane]} ${secondsText(span.ms)}',
                          builder: (context, s) => Container(
                            margin: const EdgeInsets.only(right: 1),
                            decoration: BoxDecoration(color: s.hovered ? ProColor.ink : color, borderRadius: const BorderRadius.all(Radius.circular(2))),
                          ),
                        ),
                      ),
                    ),
                  );
                }
                return Stack(
                  clipBehavior: Clip.hardEdge,
                  children: [
                    for (var i = 0; i < 3; i++)
                      Positioned(
                        left: 0,
                        right: 0,
                        top: i * (_lane + _gap),
                        height: _lane,
                        child: const DecoratedBox(
                          decoration: BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(2))),
                        ),
                      ),
                    ...segments,
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

bool get _touchOnly => defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android;

/// 这一轮做错了 floats over what began the round.
class _Markable extends StatefulWidget {
  const _Markable({required this.inset, required this.step, required this.send, required this.file, required this.onMarked, required this.child});
  final double inset;
  final int step;
  final MarkWrong send;

  /// The saved case; null until it is marked.
  final String? file;
  final ValueChanged<String> onMarked;
  final Widget child;

  @override
  State<_Markable> createState() => _MarkableState();
}

class _MarkableState extends State<_Markable> {
  bool _hover = false;
  bool _tapped = false;
  bool _writing = false;
  bool _busy = false;
  String _want = '';

  Future<void> _submit() async {
    final want = _want.trim();
    if (want.isEmpty || _busy) return;
    setState(() => _busy = true);
    final eval = await runAction(() => widget.send(widget.step, want));
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (eval != null) _writing = false;
    });
    if (eval != null) widget.onMarked(eval.file);
  }

  @override
  Widget build(BuildContext context) {
    final file = widget.file;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: Listener(
        onPointerUp: _touchOnly ? (_) => setState(() => _tapped = true) : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Stack(
              children: [
                widget.child,
                if (file == null && !_writing && (_hover || _tapped))
                  Positioned(
                    top: 0,
                    right: 0,
                    child: Container(
                      decoration: const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: proRadius),
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const SpriteIcon('icon-bug', size: 12),
                          const SizedBox(width: 4),
                          DefaultTextStyle(
                            style: ProText.xs.copyWith(fontWeight: FontWeight.w500),
                            child: InlineLink('这一轮做错了', onTap: () => setState(() => _writing = true)),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
            if (file != null)
              Tooltip(
                message: file,
                child: Container(
                  margin: EdgeInsets.fromLTRB(widget.inset, 2, 8, 2),
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(color: Palette.berry.withValues(alpha: .12), borderRadius: proRadius),
                  child: Row(
                    children: [
                      const SpriteIcon('icon-bug', size: 12),
                      const SizedBox(width: 6),
                      Expanded(child: Text('标成了做错的一轮，存成了一条评测', style: ProText.xs)),
                    ],
                  ),
                ),
              ),
            if (_writing)
              Padding(
                padding: EdgeInsets.fromLTRB(widget.inset, 4, 8, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: ProTextInput(
                        value: _want,
                        onChanged: (v) => setState(() => _want = v),
                        onSubmitted: (_) => _submit(),
                        autofocus: true,
                        enabled: !_busy,
                        placeholder: '它应该怎样：比如「先问我是哪个项目，别直接派活」',
                        semanticLabel: '这一轮应该怎样',
                      ),
                    ),
                    const SizedBox(width: 6),
                    ProButton.text('记下', tone: ProTone.primary, size: ProSize.sm, onPressed: _busy || _want.trim().isEmpty ? null : _submit),
                    const SizedBox(width: 6),
                    ProButton.text('算了', size: ProSize.sm, onPressed: _busy ? null : () => setState(() => _writing = false)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A title whose explanation is a hover away.
class TrajectoryTitle extends StatelessWidget {
  const TrajectoryTitle(this.title, {super.key, required this.about});
  final String title;
  final String about;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Tooltip(
      message: about,
      child: Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: ProText.sm.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
  );
}

class TrajectoryLog extends ConsumerWidget {
  const TrajectoryLog({super.key, required this.id, this.asked, this.empty = '还没有动静。', this.onMarkWrong, this.leading});
  final String id;
  final String? asked;
  final String empty;
  final MarkWrong? onMarkWrong;
  final Widget? leading;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final log = ref.watch(sessionEventsProvider(id));
    final steps = log.value;
    final note = steps == null ? (log.hasError ? reasonOf(log.error!) : '在读……') : (steps.isEmpty ? empty : null);
    if (note != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading case final leading?) Padding(padding: const EdgeInsets.only(bottom: 8), child: leading),
          EmptyNote(note),
        ],
      );
    }
    return Trajectory(steps: steps!, now: _now(), asked: asked, onMarkWrong: onMarkWrong, leading: leading);
  }
}

/// The helpers an agent sent, a list to pick from beside the picked one's trajectory.
class TrajectoryList extends ConsumerStatefulWidget {
  const TrajectoryList({super.key, required this.agent});
  final String agent;

  @override
  ConsumerState<TrajectoryList> createState() => _TrajectoryListState();
}

class _TrajectoryListState extends ConsumerState<TrajectoryList> {
  List<Session>? _heads;
  String? _open;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final heads = await runAction(() => ref.read(apiProvider).session.list(agent: widget.agent));
    if (!mounted) return;
    setState(() {
      _heads = heads ?? const [];
      _open ??= _heads!.firstOrNull?.id;
    });
  }

  Widget _head(Session h, double now) {
    final on = _open == h.id;
    return Tappable(
      onTap: () => setState(() => _open = h.id),
      selected: on,
      semanticLabel: h.name,
      builder: (context, s) => Container(
        decoration: BoxDecoration(
          color: on
              ? ProColor.selected
              : s.hovered
              ? ProColor.hover
              : null,
          borderRadius: proRadius,
        ),
        margin: const EdgeInsets.only(bottom: 2),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(h.name, style: ProText.sm.copyWith(fontWeight: FontWeight.w500)),
                if (h.project != null) Text(h.project!, style: ProText.meta),
                if (h.endedAt == null) const BadgeLabel('在场', hat: true),
              ],
            ),
            Text(h.endedAt == null ? '${ago(h.hiredAt, now)}接活' : '${ago(h.hiredAt, now)}接活 · ${ago(h.endedAt!, now)}走的', style: ProText.meta),
            if (h.brief.isNotEmpty) Text(_oneLine(h.brief), maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.xs),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final now = _now();
    final heads = _heads;
    if (heads == null) return const Align(alignment: Alignment.topLeft, child: EmptyNote('在读……'));
    if (heads.isEmpty) return const Align(alignment: Alignment.topLeft, child: EmptyNote('还没派出去过。'));
    final picked = heads.where((h) => h.id == _open).firstOrNull;
    final list = ListView(children: [for (final h in heads) _head(h, now)]);
    final log = picked == null
        ? const Align(alignment: Alignment.topLeft, child: EmptyNote('选一个帮工，看它的轨迹。'))
        : TrajectoryLog(
            key: ValueKey(picked.id),
            id: picked.id,
            leading: TrajectoryTitle(picked.brief.isEmpty ? picked.name : '${picked.name} · ${_oneLine(picked.brief)}', about: picked.brief),
          );
    return LayoutBuilder(
      builder: (context, box) {
        final wide = box.maxWidth >= 720;
        final body = wide
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(width: 240, child: list),
                  const SizedBox(width: 12),
                  Expanded(child: log),
                ],
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 132),
                    child: ListView(shrinkWrap: true, children: [for (final h in heads) _head(h, now)]),
                  ),
                  const SizedBox(height: 8),
                  Expanded(child: log),
                ],
              );
        return box.hasBoundedHeight ? body : SizedBox(height: 640, child: body);
      },
    );
  }
}
