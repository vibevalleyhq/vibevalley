import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../game/tools.dart';
import 'tags.dart';
import '../data/providers.dart';
import '../data/remote.dart';
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../rules/issues.dart';
import '../rules/rounds.dart';
import '../rules/time.dart';
import '../rules/sessions.dart';
import '../rules/task.dart';
import '../rules/cast.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import 'widgets.dart';
import 'work_log.dart';
import 'swatches.dart';

enum IssueFrame { farm, workbench }

class _IssueSection extends StatelessWidget {
  const _IssueSection({required this.frame, required this.title, this.aside, required this.child});
  final IssueFrame frame;
  final String title;
  final Widget? aside;
  final Widget child;
  @override
  Widget build(BuildContext context) => frame == IssueFrame.workbench
      ? PxCard(title: title, aside: aside, child: child)
      : FarmSection(
          title: title,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [?aside, child]),
        );
}

class IssueView extends ConsumerStatefulWidget {
  const IssueView({
    super.key,
    required this.issue,
    required this.sessions,
    required this.state,
    required this.session,
    this.reload,
    this.frame = IssueFrame.workbench,
    required this.onHarvest,
    required this.onClose,
    this.onThread,
    this.onNavigate,
    this.onTask,
  });
  final Issue? issue;

  // Oldest first, the ones on the farm and the ended (session.list).
  final List<Session> sessions;
  final IssueTag state;
  final Session? session;
  final Future<void> Function()? reload;
  final IssueFrame frame;
  final Future<void> Function(Session) onHarvest;
  final Future<void> Function(Session) onClose;
  final VoidCallback? onThread;
  final VoidCallback? onNavigate;
  final VoidCallback? onTask;

  @override
  ConsumerState<IssueView> createState() => _IssueViewState();
}

class _IssueViewState extends ConsumerState<IssueView> {
  String _word = '';
  bool _busy = false;

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> _act(Future<void> Function() act) async {
    setState(() => _busy = true);
    await runAction(act);
    if (!mounted) return;
    await widget.reload?.call();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _tell() async {
    final session = widget.session;
    final text = _word.trim();
    if (session == null || text.isEmpty) return;
    setState(() => _busy = true);
    final done = await runAction(() async {
      await ref.read(farmCommandsProvider).water(session, text);
      return true;
    });
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (done == true) _word = '';
    });
  }

  Future<void> _reopen() async {
    setState(() => _busy = true);
    final got = await runAction(
      () => _api.issue.status(
        id: widget.issue!.id,
        body: IssueStatusRequest(status: IssueStatus.todo, text: _word.trim()),
      ),
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (got?.sessions.lastOrNull case final session?) {
      toasts.add(type: ToastType.info, title: '工单重开了', description: '$session 接着做。');
      await widget.reload?.call();
    }
  }

  Future<void> _close(Session session) => _act(() => widget.onClose(session));

  Future<void> _accept(bool pass) async {
    final issue = widget.issue;
    if (issue == null) return;
    if (pass) return _act(() => _api.issue.accept(id: issue.id, body: const IssueAcceptRequest(pass: true)));
    final lines = await showPxDialog<List<String>>(context, title: const Text('没过验收：哪里要修'), builder: (_) => const _FindingsForm());
    if (lines == null || lines.isEmpty) return;
    await _act(
      () => _api.issue.accept(
        id: issue.id,
        body: IssueAcceptRequest(pass: false, findings: lines),
      ),
    );
  }

  Future<void> _setAcceptance(Acceptance a) async {
    final issue = widget.issue;
    if (issue == null) return;
    await _act(
      () => _api.issue.update(
        id: issue.id,
        body: IssueUpdate(acceptance: a),
      ),
    );
  }

  /// The one thing this plot waits on you for, from what the server keeps on the issue; nothing when it waits on no one.
  Widget? _needYou(Issue issue, Session? session) {
    final body = KitText.sm.copyWith(color: Palette.bark800);
    Widget box(String head, String line, List<Widget> actions, {Widget? extra}) => Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      color: tint(Palette.wheat, .3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('这块地现在需要你：$head', style: KitText.sm),
          Text(line, style: KitText.xs.copyWith(color: Palette.bark600)),
          ?extra,
          if (actions.isNotEmpty) ...[const SizedBox(height: 8), Wrap(spacing: 8, runSpacing: 8, children: actions)],
        ],
      ),
    );
    if (issue.asks.isNotEmpty && session != null) {
      return box(
        '施肥',
        '它在等你回答，回答以前地里缺肥。在下面带话里回答就行。',
        const [],
        extra: Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [for (final a in issue.asks) Text('· $a', style: body)],
          ),
        ),
      );
    }
    if (widget.state != IssueTag.waiting || session == null || session.conflict != null || session.lastRun?.outcome == Outcome.failed) return null;
    if (issue.acceptedAt != null) {
      return box('收获', '验收过了。', [PxButton.text('收获', tone: PxTone.primary, onPressed: _busy ? null : () => _act(() => widget.onHarvest(session)))]);
    }
    return box('验收', issue.acceptance == Acceptance.required ? '这张工单要先过验收才能收获。' : '这张工单看一眼就算验收：直接收获也行，没过就写意见让它修。', [
      PxButton.text('验收通过', tone: PxTone.primary, onPressed: _busy ? null : () => _accept(true)),
      PxButton.text('没过，写意见', tone: PxTone.danger, onPressed: _busy ? null : () => _accept(false)),
    ]);
  }

  bool get _inTask => widget.issue != null ? issueInTask(widget.issue!, widget.session) : widget.session?.graph != null;
  Widget _section({required String title, Widget? aside, required Widget child}) =>
      _IssueSection(frame: widget.frame, title: title, aside: aside, child: child);

  /// A task's step has none of its own: it goes with its task.
  List<Widget> _actions(Session? session) {
    final busy = _busy;
    final bed = widget.onNavigate == null
        ? null
        : PxButton.text(widget.frame == IssueFrame.farm ? '在看板上看' : '去农场看这块地', icon: 'button-open', size: PxSize.sm, onPressed: widget.onNavigate);
    if (_inTask) return [?bed];
    return switch ((widget.state, session)) {
      (IssueTag.working, final h?) => [
        PxButton.text('叫停这一轮', size: PxSize.sm, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).stop(h.id))),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (IssueTag.waiting, final h?) when h.conflict != null => [
        PxButton.text('让它解决冲突', size: PxSize.sm, tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).resolve(h))),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
      (IssueTag.waiting, final h?) when h.lastRun?.outcome == Outcome.interrupted => [
        PxButton.text(
          '接着做',
          size: PxSize.sm,
          tone: PxTone.primary,
          onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).water(h, '上一轮停在了半路，接着把它做完。')),
        ),
        PxButton.text('收获', size: PxSize.sm, onPressed: busy ? null : () => _act(() => widget.onHarvest(h))),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (IssueTag.waiting, final h?) => [
        // Every issue has an acceptance; the server leaves done out of moves until a required one has passed.
        if (h.lastRun?.outcome != Outcome.failed && (widget.issue?.moves.contains(IssueStatus.done) ?? true))
          PxButton.text('收获', size: PxSize.sm, tone: PxTone.primary, onPressed: busy ? null : () => _act(() => widget.onHarvest(h))),
        if (h.lastRun?.outcome == Outcome.failed)
          PxButton.text('接着修', size: PxSize.sm, tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).cure(h))),
        PxButton.text('关上', size: PxSize.sm, tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      _ => const [],
    };
  }

  @override
  Widget build(BuildContext context) {
    final issue = widget.issue;
    final sessions = widget.sessions;
    final head = widget.session ?? sessions.last;
    final session = widget.session;
    final open = widget.state.open;
    final changes = widget.state == IssueTag.waiting && session != null && issue != null ? ref.watch(issueChangesProvider(issue.id)) : null;
    final steps = ref.watch(sessionEventsProvider(head.id)).value ?? const <SessionEvent>[];
    final body = KitText.sm.copyWith(color: Palette.bark800);
    final turns = (session ?? head).runs;
    final cny = (session ?? head).spent?.cny;
    final summary = (session ?? head).lastRun?.summary;
    final actions = _actions(session);
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final agent = (ref.watch(agentsProvider).value ?? const <String, Agent>{})[head.agent];
    final tag = head.graph;
    final graphId = tag?.id ?? issue?.parent ?? (issue?.graph != null ? issue?.id : null);
    final graph = graphId == null ? null : graphOf(ref.watch(graphsProvider), graphId);
    final node = tag?.task == null || graph == null ? null : taskOf(graph, tag!.task!);
    final taskText = graph == null
        ? '这是种植计划里的一步，跟着计划走。'
        : node == null
        ? '在拆种植计划「${graph.title}」：只读代码，不改文件。'
        : '种植计划「${graph.title}」的一步：${node.title}。做完自动合进计划分支，收获整个计划时才进主分支。';
    final title = issue == null ? head.brief : issueTitle(issue, ref.watch(graphsProvider));
    final description = issue?.description?.isNotEmpty == true ? issue!.description! : head.brief;
    final current = doingOf(head);
    final phase = head.phase;
    final quiet = phase is PhaseWorking && phase.quietSince != null;
    final retrying = phase is PhaseWorking && phase.retry != null;
    final play = head.play;
    final history = play?.history ?? const <ActionStep>[];
    final recentSteps = history.skip(history.length > 12 ? history.length - 12 : 0).toList().reversed.toList();
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    final need = issue == null ? null : _needYou(issue, session);
    final crew = [
      for (final s in sessions)
        if (!sessions.takeWhile((x) => x != s).any((x) => x.agent == s.agent)) s,
    ];
    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (issue != null) _StageRail(stageOf(issue.status)),
        ?need,
        _section(
          title: title,
          aside: Text(widget.state.label),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (actions.isNotEmpty) ...[Wrap(spacing: 8, runSpacing: 8, children: actions), const SizedBox(height: 12)],
              _Row('谁在做', Text('${head.name}${head.runtime.isNotEmpty ? '（${head.runtime}）' : ''}', style: body)),
              if (crew.length > 1 || (session != null && head.worktree != null))
                _Row(
                  '地上的人',
                  Text(
                    [
                      crew.map((s) => s.name).join('、'),
                      // One plot, one worktree: only the session on it now changes the code.
                      if (session != null && head.worktree != null) '锄头在${session.name}手上',
                    ].join(' · '),
                    style: body,
                  ),
                ),
              if (issue != null && !_inTask)
                _Row(
                  '验收',
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      for (final (a, label) in const [(Acceptance.glance, '看一眼就收'), (Acceptance.required, '必须过验收')])
                        PxButton.text(
                          label,
                          size: PxSize.sm,
                          tone: issue.acceptance == a ? PxTone.primary : PxTone.plain,
                          onPressed: _busy || issue.acceptance == a || !widget.state.open ? null : () => _setAcceptance(a),
                        ),
                      if (issue.acceptedAt != null) Text('已验收 ${wallClockText(issue.acceptedAt!)}', style: KitText.xs.copyWith(color: Palette.leaf700)),
                    ],
                  ),
                ),
              if (issue != null && issue.findings.isNotEmpty)
                _Row(
                  '草',
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final f in issue.findings)
                        Text(
                          f.pulled == true ? '已拔 · ${f.text}' : '· ${f.text}',
                          style: body.copyWith(
                            color: f.pulled == true ? Palette.bark400 : Palette.berry,
                            decoration: f.pulled == true ? TextDecoration.lineThrough : null,
                          ),
                        ),
                    ],
                  ),
                ),

              if (agent?.model case final model? when model.isNotEmpty) _Row('模型', Text(model, style: body)),
              _Row('档案', _Link('看${agent?.name ?? head.name}的档案', onTap: () => context.go('/agents/${Uri.encodeComponent(head.agent)}'))),
              if (head.worktree case final path?)
                _Row(
                  'worktree',
                  Row(
                    children: [
                      Expanded(child: SelectableText(path, style: KitText.mono)),
                      PxButton.text(
                        '复制路径',
                        size: PxSize.sm,
                        onPressed: () => Clipboard.setData(ClipboardData(text: path)),
                      ),
                    ],
                  ),
                ),
              if (description.isNotEmpty && description != title) _Row('要做的', Text(description, style: body)),
              if (widget.onThread != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: PxButton.text('看工单串', onPressed: widget.onThread),
                ),
              if ((issue?.project ?? head.project) case final project?)
                _Row('项目', _Link(project, onTap: () => context.go('/projects/${Uri.encodeComponent(project)}'))),
              if (head.branch != null) _Row('分支', Text(head.branch!, style: KitText.mono.copyWith(color: Palette.bark800))),
              if (issue != null) _Row('开单', Text(wallClockText(issue.createdAt), style: body)),
              if (issue?.closedAt != null) _Row('关单', Text(wallClockText(issue!.closedAt!), style: body)),
              _Row('做过', Text('${sessions.length} 次：${sessions.map((r) => '${r.name}（${r.id}）').join(' → ')}', style: body.copyWith(height: 1.5))),
              _Row(
                '用时',
                Text(
                  [
                    '${turns > 0 ? turns.round() : roundsOf(steps).length} 轮',
                    tookText((head.endedAt ?? now) - head.hiredAt),
                    if (cny != null) '花了 ¥${cny.toStringAsFixed(2)}',
                  ].join(' · '),
                  style: body,
                ),
              ),
              if (head.spent case final spent? when spent.tokens > 0) _Row('用量', Text('${spent.tokens.round()} token', style: body)),
              if (summary != null && summary.isNotEmpty)
                _Row(
                  '最后一轮',
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(outcomeLabel[head.lastRun!.outcome]!, style: body),
                      Text(summary, style: body),
                    ],
                  ),
                ),
              if (_inTask)
                _Row(
                  '种植计划',
                  Row(
                    children: [
                      Expanded(child: Text(taskText, style: body)),
                      if (widget.onTask != null) PxButton.text('看计划', onPressed: widget.onTask),
                    ],
                  ),
                ),
              if (session?.conflict case final conflict?)
                _Row('冲突', Text('合进 ${conflict.base} 会冲突：${conflict.files.join('、')}', style: body.copyWith(color: Palette.berry))),
            ],
          ),
        ),
        if (issue != null) IssueRunsCard(frame: widget.frame, issue: issue.id, version: '${widget.state}:${session?.runs}:${session?.phase.runtimeType}'),
        if (changes != null) ...[
          const SizedBox(height: 12),
          Builder(
            builder: (context) {
              final c = changes.value;
              if (c == null) {
                return _section(
                  title: '改动',
                  child: Text(changes.isLoading ? '在读……' : '读不到改动。', style: body),
                );
              }
              final added = c.files.fold<double>(0, (n, f) => n + f.added).round();
              final removed = c.files.fold<double>(0, (n, f) => n + f.removed).round();
              return _section(
                title: '改动',
                aside: Text('${c.branch ?? ''} → ${c.base}'),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      '${c.commits.length} 个提交 · ${c.files.length} 个文件 · +$added -$removed${c.uncommitted.isNotEmpty ? ' · ${c.uncommitted.length} 个没提交' : ''}',
                      style: body,
                    ),
                    if (c.conflicts.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text('合进 ${c.base} 会冲突：${c.conflicts.join('、')}', style: body.copyWith(color: Palette.berry)),
                    ],
                    const SizedBox(height: 6),
                    for (final f in c.files.take(8))
                      Text(
                        '${f.path}  +${f.added.round()} -${f.removed.round()}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: KitText.mono.copyWith(fontSize: 11, color: Palette.bark800),
                      ),
                    if (c.files.length > 8) Text('还有 ${c.files.length - 8} 个文件', style: KitText.xs.copyWith(color: Palette.bark500)),
                  ],
                ),
              );
            },
          ),
        ],
        if (current.action != SessionAction.none)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.leaf300, .4),
              child: Row(
                children: [
                  ActionGlyph(current.action, size: 22),
                  const SizedBox(width: 8),
                  Text('正在${current.actionText ?? ''}', style: KitText.sm),
                  if (current.label.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Flexible(
                      child: Container(
                        color: Palette.cream50,
                        padding: const EdgeInsets.symmetric(horizontal: 6),
                        child: Text(current.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.mono),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        if (quiet || retrying)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.water, .15),
              child: Ticking(
                builder: (context, now) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(phaseText(head, now), style: KitText.sm),
                    if (quiet) Text('可能在跑很久的命令，也可能卡住了：看看下面的干活过程，不对就叫停。', style: xs),
                  ],
                ),
              ),
            ),
          ),
        const SizedBox(height: 12),
        _section(
          title: '干活过程',
          child: steps.isEmpty
              ? EmptyNote(head.endedAt == null ? '还没有步骤。' : '干活过程只留 30 天（配置里的 session.trajectory_days），这张工单的已经清掉了；它是谁做的、怎么关的还在上面。')
              : FoldedWorkLog(
                  steps: steps,
                  child: Ticking(
                    builder: (context, now) => WorkLog(steps: steps, now: now, tall: true, working: widget.state == IssueTag.working),
                  ),
                ),
        ),
        const SizedBox(height: 12),
        _section(
          title: '这一轮做了什么',
          child: recentSteps.isEmpty
              ? Text('还没动手。', style: KitText.sm.copyWith(color: Palette.bark600))
              : Ticking(
                  builder: (context, now) => Column(
                    children: [
                      for (final s in recentSteps)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Row(
                            children: [
                              ActionGlyph(s.action, size: 18),
                              const SizedBox(width: 8),
                              SizedBox(
                                width: 56,
                                child: Text(s.actionText ?? '', style: KitText.sm.copyWith(color: Palette.bark800)),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  s.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: KitText.mono.copyWith(color: Palette.bark600),
                                ),
                              ),
                              Text(ago(s.at, now), style: KitText.xs.copyWith(color: Palette.bark400)),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
        ),
        if ((play?.files ?? const []).isNotEmpty)
          _section(
            title: '碰过的文件',
            child: Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final f in _last(play!.files, 10))
                  Container(
                    color: Palette.cream200,
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    child: Text(f, style: KitText.mono.copyWith(color: Palette.bark800)),
                  ),
              ],
            ),
          ),
        if ((play?.commands ?? const []).isNotEmpty)
          _section(
            title: '跑过的命令',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final c in _last(play!.commands, 5))
                  Text(
                    '\$ $c',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.mono.copyWith(color: Palette.bark800),
                  ),
              ],
            ),
          ),
        if (open && session != null)
          _section(
            title: '带话',
            child: Row(
              children: [
                Expanded(
                  child: PxTextInput(
                    value: _word,
                    onChanged: (v) => setState(() => _word = v),
                    onSubmitted: (_) => _tell(),
                    enabled: !_busy,
                    placeholder: session.phase is PhaseWorking ? '干着活也能收到这句话' : '说一句，它接着做一轮',
                    semanticLabel: '给${session.name}带句话',
                  ),
                ),
                const SizedBox(width: 8),
                PxButton.text('带话', tone: PxTone.primary, onPressed: _busy || _word.trim().isEmpty ? null : _tell),
              ],
            ),
          )
        else if (!open && issue != null && !_inTask)
          _section(
            title: '重开',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('派同一个帮工档案的新帮工，在同一个项目里接着做这张工单。它会知道原来要做什么、上一次是怎么关的、最后一轮说了什么。', style: body.copyWith(height: 1.625)),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: PxTextInput(
                        value: _word,
                        onChanged: (v) => setState(() => _word = v),
                        onSubmitted: (_) => _reopen(),
                        enabled: !_busy,
                        placeholder: '这次要它做什么（不填就是接着做完）',
                        semanticLabel: '重开这张工单',
                      ),
                    ),
                    const SizedBox(width: 8),
                    PxButton.text('重开', tone: PxTone.primary, onPressed: _busy ? null : _reopen),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
    if (widget.frame == IssueFrame.workbench) return main;
    return LayoutBuilder(
      builder: (context, box) {
        final aside = _FarmAside(session: head, agent: agent);
        return box.maxWidth >= 560
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  aside,
                  const SizedBox(width: 16),
                  Expanded(child: main),
                ],
              )
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [aside, const SizedBox(height: 16), main]);
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.child);
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: KitText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}

/// The runs of an issue, read again whenever `version` changes.
class IssueRunsCard extends ConsumerStatefulWidget {
  const IssueRunsCard({super.key, required this.issue, required this.version, this.frame = IssueFrame.workbench});
  final String issue;
  final String version;
  final IssueFrame frame;

  @override
  ConsumerState<IssueRunsCard> createState() => IssueRunsCardState();
}

class IssueRunsCardState extends ConsumerState<IssueRunsCard> {
  late Future<List<Run>> _runs = _read();

  Future<List<Run>> _read() => ref.read(apiProvider).issue.runs(id: widget.issue);

  @override
  void didUpdateWidget(IssueRunsCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.version != widget.version || oldWidget.issue != widget.issue) setState(() => _runs = _read());
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<List<Run>>(
    future: _runs,
    builder: (context, snap) {
      final runs = snap.data ?? const <Run>[];
      if (runs.isEmpty) return const SizedBox.shrink();
      final now = DateTime.now().millisecondsSinceEpoch.toDouble();
      final body = KitText.sm.copyWith(color: Palette.bark800, height: 1.5);
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: _IssueSection(
          frame: widget.frame,
          title: '每次干活',
          aside: Text('${runs.length} 次'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [for (final r in runs.reversed) _Row(wallClockText(r.startedAt), Text(runText(r, now, tookText), style: body))],
          ),
        ),
      );
    },
  );
}

class _FarmAside extends ConsumerWidget {
  const _FarmAside({required this.session, required this.agent});
  final Session session;
  final Agent? agent;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final view = ref.watch(viewProvider);
    final plot = view == null ? const PlotView(crop: Crop.empty) : plotOf(view, session);
    final cast = castOf(agent?.look, session.agent);
    final station = stationOfSession(session);
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    return Container(
      width: 208,
      color: Palette.cream100,
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          SizedBox(
            height: 176,
            child: Stack(
              alignment: Alignment.bottomCenter,
              children: [
                if (atlas != null && atlas.has(cropSprite(plot.crop)))
                  Positioned(bottom: 0, child: Opacity(opacity: .9, child: _Sprite(atlas[cropSprite(plot.crop)], width: 176))),
                if (atlas != null) _Sprite(atlas['${lookOf(agent, session.agent, atlas.has)}-down'], height: 144),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(cropLabel[plot.crop]!, style: KitText.sm),
          Text('${speciesLabel[cast.species]} · ${outfitLabel[cast.outfit]}', textAlign: TextAlign.center, style: xs),
          Text('第 ${station + 1} 块地 · 第 ${session.runs.round()} 轮', style: xs),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

class _Sprite extends StatelessWidget {
  const _Sprite(this.sprite, {this.width, this.height});
  final SpriteInfo sprite;
  final double? width;
  final double? height;

  @override
  Widget build(BuildContext context) => Image.asset(
    sprite.asset,
    width: width ?? (height! * sprite.w / sprite.h),
    height: height ?? (width! * sprite.h / sprite.w),
    fit: BoxFit.contain,
    filterQuality: FilterQuality.none,
  );
}

class _Link extends StatelessWidget {
  const _Link(this.text, {required this.onTap});
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    builder: (context, s) => Text(
      text,
      style: KitText.xs.copyWith(color: Palette.leaf700, decoration: s.hovered || s.focused ? TextDecoration.underline : null),
    ),
  );
}

List<String> _last(List<String> all, int n) => all.length > n ? all.sublist(all.length - n) : all;

/// 聊清楚 → 安排活 → 完成, the one it is at marked.
class _StageRail extends StatelessWidget {
  const _StageRail(this.at);
  final Stage at;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 12),
    decoration: const BoxDecoration(border: Border.fromBorderSide(pxLine)),
    child: Row(
      children: [
        for (final s in Stage.values)
          Expanded(
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 6),
              alignment: Alignment.center,
              color: s == at
                  ? tint(Palette.wheat, .45)
                  : s.index < at.index
                  ? tint(Palette.leaf300, .5)
                  : null,
              child: Text(s.index < at.index ? '${s.label} ✓' : s.label, style: KitText.sm.copyWith(color: s == at ? Palette.bark900 : Palette.bark500)),
            ),
          ),
      ],
    ),
  );
}

/// One finding a line: what did not pass.
class _FindingsForm extends StatefulWidget {
  const _FindingsForm();

  @override
  State<_FindingsForm> createState() => _FindingsFormState();
}

class _FindingsFormState extends State<_FindingsForm> {
  String _text = '';

  List<String> get _lines => [
    for (final l in _text.split('\n'))
      if (l.trim().isNotEmpty) l.trim(),
  ];

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('一行一条：每条是一棵草，它会带着这些接着修一轮。', style: KitText.xs.copyWith(color: Palette.bark600)),
      const SizedBox(height: 8),
      PxTextArea(value: _text, onChanged: (v) => setState(() => _text = v), rows: 5, placeholder: '比如：看板拖卡还在调旧接口', semanticLabel: '验收意见'),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          PxButton.text('算了', onPressed: () => Navigator.of(context).pop()),
          const SizedBox(width: 8),
          PxButton.text('交回去修', tone: PxTone.danger, onPressed: _lines.isEmpty ? null : () => Navigator.of(context).pop(_lines)),
        ],
      ),
    ],
  );
}
