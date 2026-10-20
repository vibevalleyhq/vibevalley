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
import 'composer.dart';
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
  final _draft = ComposerDraft();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _draft.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  VibeValleyApi get _api => ref.read(apiProvider);

  Future<void> _act(Future<void> Function() act) async {
    setState(() => _busy = true);
    await runAction(act);
    if (!mounted) return;
    await widget.reload?.call();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _tell(Session session, String text, String key) async {
    await ref.read(farmCommandsProvider).water(session, text, sendKey: key);
    await widget.reload?.call();
  }

  Future<void> _reopen() async {
    setState(() => _busy = true);
    final got = await runAction(
      () => _api.issue.status(
        id: widget.issue!.id,
        body: IssueStatusRequest(status: IssueStatus.todo, text: _draft.said),
      ),
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (got?.sessions.lastOrNull case final session?) {
      _draft.clear();
      toasts.add(type: ToastType.info, title: '工单重开了', description: '$session 接着做。');
      await widget.reload?.call();
    }
  }

  Future<void> _close(Session session) => _act(() => widget.onClose(session));

  /// A pass, or a fail whose findings are what the box says: one weed a line.
  Future<void> _accept(bool pass) async {
    final issue = widget.issue;
    if (issue == null) return;
    if (pass) return _act(() => _api.issue.accept(id: issue.id, body: const IssueAcceptRequest(pass: true)));
    final lines = [
      for (final l in _draft.text.text.split('\n'))
        if (l.trim().isNotEmpty) l.trim(),
    ];
    if (lines.isEmpty) return;
    await _act(
      () => _api.issue.accept(
        id: issue.id,
        body: IssueAcceptRequest(pass: false, findings: lines),
      ),
    );
    if (mounted) _draft.clear();
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

  bool get _inTask => widget.issue != null ? issueInTask(widget.issue!, widget.session) : widget.session?.graph != null;

  /// A task's step has none of its own: it goes with its task.
  List<Widget> _actions(Session? session) {
    final busy = _busy;
    final bed = widget.onNavigate == null
        ? null
        : PxButton.text(widget.frame == IssueFrame.farm ? '在看板上看' : '去农场看这块地', icon: 'button-open', onPressed: widget.onNavigate);
    if (_inTask) return [?bed];
    return switch ((widget.state, session)) {
      (IssueTag.working, final h?) => [
        PxButton.text('叫停这一轮', onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).stop(h.id))),
        PxButton.text('关上', tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (IssueTag.waiting, final h?) when h.conflict != null => [
        PxButton.text('让它解决冲突', tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).resolve(h))),
        PxButton.text('关上', tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
      (IssueTag.waiting, final h?) when h.lastRun?.outcome == Outcome.interrupted => [
        PxButton.text('接着做', tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).water(h, '上一轮停在了半路，接着把它做完。'))),
        PxButton.text('收获', onPressed: busy ? null : () => _act(() => widget.onHarvest(h))),
        PxButton.text('关上', tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      (IssueTag.waiting, final h?) => [
        // Every issue has an acceptance; the server leaves done out of moves until a required one has passed.
        if (h.lastRun?.outcome != Outcome.failed && (widget.issue?.moves.contains(IssueStatus.done) ?? true))
          PxButton.text('收获', tone: PxTone.primary, onPressed: busy ? null : () => _act(() => widget.onHarvest(h))),
        if (h.lastRun?.outcome == Outcome.failed)
          PxButton.text('接着修', tone: PxTone.primary, onPressed: busy ? null : () => _act(() => ref.read(farmCommandsProvider).cure(h))),
        PxButton.text('关上', tone: PxTone.danger, onPressed: busy ? null : () => _close(h)),
        ?bed,
      ],
      _ => const [],
    };
  }

  /// What is going on, in one line and what it needs: the first thing the owner reads.
  ({String head, String? line, List<String> list, Color tone}) _status(Issue? issue, Session head, Session? session, Doing current) {
    final phase = head.phase;
    final who = head.name;
    final round = head.runs > 0 ? '第 ${head.runs.round()} 轮' : null;
    final summary = head.lastRun?.summary;
    final asks = issue?.asks ?? const <String>[];
    if (asks.isNotEmpty && session != null) {
      return (head: '缺肥：$who在等你回答', line: '在下面说一句就算回答。', list: asks, tone: Palette.wheat);
    }
    if (session?.conflict case final conflict?) {
      return (head: '合进 ${conflict.base} 会冲突', line: conflict.files.join('、'), list: const [], tone: Palette.berry);
    }
    switch (widget.state) {
      case IssueTag.working:
        final doing = current.action == SessionAction.none ? '在干活' : '正在${current.actionText ?? ''}';
        final quiet = phase is PhaseWorking && phase.quietSince != null;
        return (
          head: '$who $doing${round == null ? '' : '（$round）'}',
          line: quiet ? '很久没动静：可能在跑很久的命令，也可能卡住了。' : (current.label.isEmpty ? null : current.label),
          list: const [],
          tone: Palette.leaf300,
        );
      case IssueTag.waiting:
        if (head.lastRun?.outcome == Outcome.failed) return (head: '这一轮没做成', line: summary, list: const [], tone: Palette.berry);
        if (head.lastRun?.outcome == Outcome.interrupted) return (head: '停在了半路', line: summary, list: const [], tone: Palette.wheat);
        if (issue?.acceptedAt != null) return (head: '验收过了，可以收获', line: summary, list: const [], tone: Palette.leaf300);
        return (head: '等你验收 · $who交回来了${round == null ? '' : '（$round）'}', line: summary, list: const [], tone: Palette.wheat);
      default:
        final closed = issue?.closedAt;
        return (
          head: closed == null ? widget.state.label : '${widget.state.label} · ${wallClockText(closed)}',
          line: summary,
          list: const [],
          tone: Palette.cream200,
        );
    }
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
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    final turns = (session ?? head).runs;
    final cny = (session ?? head).spent?.cny;
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
    final project = issue?.project ?? head.project;
    final current = doingOf(head);
    final status = _status(issue, head, session, current);
    final weeds = issue?.findings.where((f) => f.pulled != true).toList() ?? const <Finding>[];
    // The verdict goes with the box: 没过 sends what it says as the findings.
    final judging =
        issue != null &&
        !_inTask &&
        widget.state == IssueTag.waiting &&
        session != null &&
        session.conflict == null &&
        issue.acceptedAt == null &&
        head.lastRun?.outcome != Outcome.failed;
    final talking = open && session != null;
    final reopening = !open && issue != null && !_inTask;
    final crew = [
      for (final s in sessions)
        if (!sessions.takeWhile((x) => x != s).any((x) => x.agent == s.agent)) s,
    ];

    final statusBox = Container(
      padding: const EdgeInsets.all(12),
      color: tint(status.tone, .3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (widget.state == IssueTag.working && current.action != SessionAction.none) ...[
                ActionGlyph(current.action, size: 20),
                const SizedBox(width: 8),
              ],
              Expanded(child: Text(status.head, style: KitText.base)),
            ],
          ),
          if (status.line case final line? when line.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(line, maxLines: 4, overflow: TextOverflow.ellipsis, style: body.copyWith(height: 1.5)),
          ],
          for (final a in status.list) Text('· $a', style: body),
          if (_inTask) ...[const SizedBox(height: 4), Text(taskText, style: xs)],
        ],
      ),
    );

    final box = talking || reopening
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Composer(
                look: ComposerLook.inline,
                draft: _draft,
                minLines: judging ? 3 : 2,
                enabled: !_busy,
                // 没过 reads the box one finding a line, so Enter starts a line while it is judged.
                enterSends: !judging,
                mentions: talking,
                sendLabel: '带话',
                onSend: talking ? (text, key) => _tell(session, text, key) : null,
                placeholder: judging
                    ? '没过就写哪里要修，一行一条；也可以只带句话'
                    : reopening
                    ? '这次要它做什么（不填就是接着做完）'
                    : session!.phase is PhaseWorking
                    ? '干着活也能收到这句话'
                    : '说一句，它接着做一轮',
                semanticLabel: reopening ? '重开这张工单' : '给${head.name}带句话',
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (judging) ...[
                    PxButton.text('验收通过', tone: PxTone.primary, onPressed: _busy ? null : () => _accept(true)),
                    PxButton.text('没过，照上面修', tone: PxTone.danger, onPressed: _busy || _draft.empty ? null : () => _accept(false)),
                  ],
                  if (reopening) PxButton.text('重开', tone: PxTone.primary, onPressed: _busy ? null : _reopen),
                  ...actions,
                ],
              ),
            ],
          )
        : actions.isEmpty
        ? null
        : Wrap(spacing: 8, runSpacing: 8, children: actions);

    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (description.isNotEmpty && description != title) _Row('要做的', Text(description, style: body)),
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
        if (issue != null && issue.findings.any((f) => f.pulled == true))
          _Row(
            '拔了的草',
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final f in issue.findings.where((f) => f.pulled == true))
                  Text(
                    '已拔 · ${f.text}',
                    style: body.copyWith(color: Palette.bark400, decoration: TextDecoration.lineThrough),
                  ),
              ],
            ),
          ),
        if (agent?.model case final model? when model.isNotEmpty) _Row('模型', Text(model, style: body)),
        _Row('档案', _Link('看${agent?.name ?? head.name}的档案', onTap: () => context.go('/agents/${Uri.encodeComponent(head.agent)}'))),
        if (project != null) _Row('项目', _Link(project, onTap: () => context.go('/projects/${Uri.encodeComponent(project)}'))),
        if (head.branch != null) _Row('分支', Text(head.branch!, style: KitText.mono.copyWith(color: Palette.bark800))),
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
              if (head.spent case final spent? when spent.tokens > 0) '${spent.tokens.round()} token',
            ].join(' · '),
            style: body,
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (widget.onThread != null) PxButton.text('看工单串', size: PxSize.sm, onPressed: widget.onThread),
            if (_inTask && widget.onTask != null) PxButton.text('看计划', size: PxSize.sm, onPressed: widget.onTask),
          ],
        ),
      ],
    );

    final changesView = changes == null
        ? null
        : Builder(
            builder: (context) {
              final c = changes.value;
              if (c == null) return Text(changes.isLoading ? '在读……' : '读不到改动。', style: body);
              final added = c.files.fold<double>(0, (n, f) => n + f.added).round();
              final removed = c.files.fold<double>(0, (n, f) => n + f.removed).round();
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '${c.branch ?? ''} → ${c.base} · ${c.commits.length} 个提交 · +$added -$removed${c.uncommitted.isNotEmpty ? ' · ${c.uncommitted.length} 个没提交' : ''}',
                    style: body,
                  ),
                  if (c.conflicts.isNotEmpty) Text('合进 ${c.base} 会冲突：${c.conflicts.join('、')}', style: body.copyWith(color: Palette.berry)),
                  const SizedBox(height: 6),
                  for (final f in c.files.take(12))
                    Text(
                      '${f.path}  +${f.added.round()} -${f.removed.round()}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.mono.copyWith(fontSize: 11, color: Palette.bark800),
                    ),
                  if (c.files.length > 12) Text('还有 ${c.files.length - 12} 个文件', style: xs),
                ],
              );
            },
          );
    final fileCount = changes?.value?.files.length;

    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (issue != null) StageRail(stageOf(issue.status)),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(title, style: KitText.lg)),
            const SizedBox(width: 8),
            Text(widget.state.label, style: xs),
          ],
        ),
        if (project != null) Text(project, style: xs),
        const SizedBox(height: 12),
        statusBox,
        if (weeds.isNotEmpty) ...[const SizedBox(height: 8), for (final f in weeds) Text('草 · ${f.text}', style: body.copyWith(color: Palette.berry))],
        if (issue?.criteria case final criteria? when criteria.isNotEmpty) ...[const SizedBox(height: 8), _Criteria(criteria: criteria, checking: judging)],
        if (box != null) ...[const SizedBox(height: 12), box],
        const SizedBox(height: 16),
        if (changesView != null) _Fold(label: fileCount == null ? '改动' : '改动（$fileCount 个文件）', child: changesView),
        _Fold(
          label: '干活过程',
          child: steps.isEmpty
              ? EmptyNote(head.endedAt == null ? '还没有步骤。' : '干活过程只留 30 天（配置里的 session.trajectory_days），这张工单的已经清掉了。')
              : Ticking(
                  builder: (context, now) => WorkLog(steps: steps, now: now, tall: true, working: widget.state == IssueTag.working),
                ),
        ),
        if (issue != null)
          _Fold(
            label: '每次干活',
            child: IssueRunsCard(frame: widget.frame, issue: issue.id, version: '${widget.state}:${session?.runs}:${session?.phase.runtimeType}'),
          ),
        _Fold(label: '详情', child: details),
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

/// The issue's criteria; while it is judged, each can be ticked off as the owner checks it (on this page only).
class _Criteria extends StatefulWidget {
  const _Criteria({required this.criteria, required this.checking});
  final List<String> criteria;
  final bool checking;

  @override
  State<_Criteria> createState() => _CriteriaState();
}

class _CriteriaState extends State<_Criteria> {
  final _ticked = <int>{};

  @override
  Widget build(BuildContext context) {
    final body = KitText.sm.copyWith(color: Palette.bark800, height: 1.5);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(widget.checking ? '照验收标准看，看过一条勾一条' : '验收标准', style: KitText.xs.copyWith(color: Palette.bark600)),
        const SizedBox(height: 4),
        for (final (i, c) in widget.criteria.indexed)
          if (!widget.checking)
            Text('· $c', style: body)
          else
            KitTappable(
              onTap: () => setState(() => _ticked.contains(i) ? _ticked.remove(i) : _ticked.add(i)),
              semanticLabel: c,
              selected: _ticked.contains(i),
              builder: (_, st) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 16,
                      height: 16,
                      margin: const EdgeInsets.only(top: 2, right: 8),
                      decoration: BoxDecoration(
                        color: Palette.cream50,
                        border: Border.all(color: st.hovered ? Palette.bark600 : Palette.bark400, width: 2),
                      ),
                      alignment: Alignment.center,
                      child: _ticked.contains(i) ? const SpriteIcon('mark-check', size: 12, semanticLabel: '看过了') : null,
                    ),
                    Expanded(
                      child: Text(c, style: _ticked.contains(i) ? body.copyWith(color: Palette.bark500) : body),
                    ),
                  ],
                ),
              ),
            ),
      ],
    );
  }
}

/// A second-level part: folded until asked for.
class _Fold extends StatefulWidget {
  const _Fold({required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  State<_Fold> createState() => _FoldState();
}

class _FoldState extends State<_Fold> {
  var _open = false;

  @override
  Widget build(BuildContext context) => Container(
    decoration: const BoxDecoration(border: Border(top: pxLine)),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        KitTappable(
          onTap: () => setState(() => _open = !_open),
          semanticLabel: widget.label,
          builder: (_, st) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Transform.rotate(angle: _open ? 1.5708 : 0, child: const SpriteIcon('button-next', size: 12)),
                const SizedBox(width: 6),
                Text(widget.label, style: KitText.sm.copyWith(color: st.hovered ? Palette.bark900 : Palette.bark800)),
              ],
            ),
          ),
        ),
        if (_open) Padding(padding: const EdgeInsets.only(bottom: 12), child: widget.child),
      ],
    ),
  );
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
    // No setState: a build follows didUpdateWidget, and setState's callback must not return the Future it assigns.
    if (oldWidget.version != widget.version || oldWidget.issue != widget.issue) _runs = _read();
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

/// 聊清楚 → 安排活 → 完成, the one it is at marked.
class StageRail extends StatelessWidget {
  const StageRail(this.at, {super.key});
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
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(s.label, style: KitText.sm.copyWith(color: s == at ? Palette.bark900 : Palette.bark500)),
                  // The pixel font has no ✓: a stage behind it is marked with the sprite.
                  if (s.index < at.index) ...[const SizedBox(width: 4), SpriteIcon('mark-check', size: 12, semanticLabel: '${s.label}做完了')],
                ],
              ),
            ),
          ),
      ],
    ),
  );
}
