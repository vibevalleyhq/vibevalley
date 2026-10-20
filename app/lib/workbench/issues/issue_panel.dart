import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/providers.dart';
import '../../data/remote.dart';
import '../../game/commands.dart';
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../rules/rounds.dart' show tookText;
import '../../rules/time.dart';
import '../../shared/composer.dart' show ComposerDraft;
import '../../shared/issue_state.dart';
import '../../ui/pro/pro.dart';
import '../shared/composer.dart';
import '../shared/widgets.dart';
import '../shared/work_log.dart';
import 'issues_page.dart' show issueTagColor;
import 'issue_sheet.dart';

/// The workbench's issue page, drawn from IssueState: the status and what it needs first, the rest folded. The farm draws
/// its own (shared/issue_view.dart).
class IssuePanel extends ConsumerStatefulWidget {
  const IssuePanel({
    super.key,
    required this.issue,
    required this.sessions,
    required this.state,
    required this.session,
    this.reload,
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
  final Future<void> Function(Session) onHarvest;
  final Future<void> Function(Session) onClose;
  final VoidCallback? onThread;
  final VoidCallback? onNavigate;
  final VoidCallback? onTask;

  @override
  ConsumerState<IssuePanel> createState() => _IssuePanelState();
}

class _IssuePanelState extends ConsumerState<IssuePanel> {
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

  /// A pass, or a fail whose findings are what the box says: one weed a line.
  Future<void> _accept(bool pass) async {
    final issue = widget.issue;
    if (issue == null) return;
    if (pass) return _act(() => _api.issue.accept(id: issue.id, body: const IssueAcceptRequest(pass: true)));
    final lines = findingsOf(_draft.text.text);
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

  Widget _offer(IssueOffer o, Session h) {
    final commands = ref.read(farmCommandsProvider);
    final (label, run) = switch (o.act) {
      IssueAct.stop => ('叫停这一轮', () => _act(() => commands.stop(h.id))),
      IssueAct.resolve => ('让它解决冲突', () => _act(() => commands.resolve(h))),
      IssueAct.resume => ('接着做', () => _act(() => commands.water(h, resumeWords))),
      IssueAct.harvest => ('收获', () => _act(() => widget.onHarvest(h))),
      IssueAct.cure => ('接着修', () => _act(() => commands.cure(h))),
      IssueAct.close => ('关上', () => _act(() => widget.onClose(h))),
    };
    return ProButton.text(
      label,
      // Only the lead is filled; 关上 asks again in its own dialog, so it need not shout here.
      tone: o.lead ? ProTone.primary : ProTone.plain,
      onPressed: _busy ? null : run,
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = IssueState.of(issue: widget.issue, sessions: widget.sessions, tag: widget.state, session: widget.session, graphs: ref.watch(graphsProvider));
    final issue = s.issue;
    final head = s.head;
    final session = s.session;
    final changes = s.showsChanges ? ref.watch(issueChangesProvider(issue!.id)) : null;
    final steps = ref.watch(sessionEventsProvider(head.id)).value ?? const <SessionEvent>[];
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final agent = (ref.watch(agentsProvider).value ?? const <String, Agent>{})[head.agent];
    final status = s.status;
    final project = s.project;
    final bed = widget.onNavigate == null ? null : ProButton.text('去农场看这块地', icon: 'button-open', onPressed: widget.onNavigate);
    final actions = [
      if (session != null)
        for (final o in s.offers) _offer(o, session),
      ?bed,
    ];

    final statusBox = Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(color: status.tone.withValues(alpha: .16), borderRadius: const BorderRadius.all(Radius.circular(8))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (s.showsDoing) ...[ActionGlyph(s.current.action, size: 18), const SizedBox(width: 8)],
              Expanded(
                child: Text(status.head, style: ProText.base.copyWith(fontWeight: FontWeight.w600)),
              ),
            ],
          ),
          if (status.line case final line? when line.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(line, maxLines: 4, overflow: TextOverflow.ellipsis, style: ProText.sm),
          ],
          for (final a in status.list) Text('· $a', style: ProText.sm),
          if (s.inTask) ...[const SizedBox(height: 6), Text(s.taskText, style: ProText.meta)],
        ],
      ),
    );

    final box = s.hasBox
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              WorkbenchComposer(
                draft: _draft,
                minLines: s.judging ? 3 : 2,
                enabled: !_busy,
                enterSends: s.enterSends,
                mentions: s.talking,
                sendLabel: '带话',
                onSend: s.talking ? (text, key) => _tell(session!, text, key) : null,
                placeholder: s.placeholder,
                semanticLabel: s.boxLabel,
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (s.judging) ...[
                    ProButton.text('验收通过', tone: ProTone.primary, onPressed: _busy ? null : () => _accept(true)),
                    ProButton.text('没过，照上面修', tone: ProTone.danger, onPressed: _busy || _draft.empty ? null : () => _accept(false)),
                  ],
                  if (s.reopening) ProButton.text('重开', tone: ProTone.primary, onPressed: _busy ? null : _reopen),
                ],
              ),
            ],
          )
        : null;

    final more = <Widget>[
      if (s.crewLine case final crew?) ProProperty('地上的人', Text(crew)),
      if (agent?.model case final model? when model.isNotEmpty) ProProperty('模型', Text(model)),
      ProProperty('档案', TextLink('看${agent?.name ?? head.name}的档案', onTap: () => context.go('/agents/${Uri.encodeComponent(head.agent)}'))),
      if (head.branch != null) ProProperty('分支', Text(head.branch!, style: ProText.mono)),
      if (head.worktree case final path?)
        ProProperty(
          'worktree',
          Row(
            children: [
              Expanded(child: SelectableText(path, maxLines: 2, style: ProText.mono)),
              ProButton.icon(
                'button-copy',
                semanticLabel: '复制路径',
                tooltip: '复制路径',
                onPressed: () => Clipboard.setData(ClipboardData(text: path)),
              ),
            ],
          ),
        ),
      if (issue != null) ProProperty('开单', Text(wallClockText(issue.createdAt))),
      if (issue?.closedAt != null) ProProperty('关单', Text(wallClockText(issue!.closedAt!))),
      ProProperty('做过', Text(s.historyLine)),
      ProProperty('用时', Text(s.usedLine(steps: steps, now: now))),
      if (s.pulled.isNotEmpty)
        ProProperty(
          '拔了的草',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final f in s.pulled)
                Text(
                  f.text,
                  style: ProText.sm.copyWith(color: ProColor.faint, decoration: TextDecoration.lineThrough),
                ),
            ],
          ),
        ),
    ];
    // The few asked about every time stay in sight; the rest are behind 更多.
    final side = <Widget>[
      for (final a in actions) Padding(padding: const EdgeInsets.only(bottom: 8), child: a),
      if (actions.isNotEmpty) const SizedBox(height: 8),
      ProProperty(
        '状态',
        Row(
          children: [
            ProDot(issueTagColor(widget.state), size: 8),
            const SizedBox(width: 8),
            Flexible(child: Text(widget.state.label)),
          ],
        ),
      ),
      ProProperty('谁在做', Text(s.whoLine)),
      if (project != null) ProProperty('项目', TextLink(project, onTap: () => context.go('/projects/${Uri.encodeComponent(project)}'))),
      if (issue != null && s.acceptanceEditable)
        ProProperty(
          '验收',
          ProPick(
            quiet: true,
            value: issue.acceptance.name,
            placeholder: '看一眼就收',
            semanticLabel: '验收',
            enabled: !_busy && s.open,
            options: const [
              PickOption(value: 'glance', label: '看一眼就收'),
              PickOption(value: 'required', label: '必须过验收'),
            ],
            onChanged: (v) => _setAcceptance(v == 'required' ? Acceptance.required : Acceptance.glance),
          ),
          boxed: true,
        ),
      if (issue?.acceptedAt case final at?) ProProperty('验收过', Text(wallClockText(at), style: ProText.sm.copyWith(color: Palette.leaf700))),
      const SizedBox(height: 4),
      ProMore(children: more),
      if (widget.onThread != null || (s.inTask && widget.onTask != null)) ...[
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (widget.onThread != null) ProButton.text('看工单串', size: ProSize.sm, onPressed: widget.onThread),
            if (s.inTask && widget.onTask != null) ProButton.text('看计划', size: ProSize.sm, onPressed: widget.onTask),
          ],
        ),
      ],
    ];

    final changesView = changes == null
        ? null
        : Builder(
            builder: (context) {
              final c = changes.value;
              if (c == null) return Text(changes.isLoading ? '在读……' : '读不到改动。', style: ProText.sm.copyWith(color: ProColor.muted));
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(changesLine(c), style: ProText.sm),
                  if (c.conflicts.isNotEmpty) Text('合进 ${c.base} 会冲突：${c.conflicts.join('、')}', style: ProText.sm.copyWith(color: Palette.berry)),
                  const SizedBox(height: 8),
                  for (final f in c.files.take(12))
                    Text('${f.path}  +${f.added.round()} -${f.removed.round()}', maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.mono),
                  if (c.files.length > 12) Text('还有 ${c.files.length - 12} 个文件', style: ProText.meta),
                ],
              );
            },
          );

    final heading = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (issue != null) ...[IssueStages(stageOf(issue.status)), const SizedBox(height: 16)],
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11),
          child: Text(s.title, style: ProText.xl),
        ),
        if (s.description.isNotEmpty && s.description != s.title)
          Padding(padding: const EdgeInsets.fromLTRB(11, 8, 11, 0), child: ProClampedMarkdown(s.description)),
      ],
    );
    final main = <Widget>[
      statusBox,
      if (s.weeds.isNotEmpty) ...[
        const SizedBox(height: 10),
        for (final f in s.weeds)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text('草 · ${f.text}', style: ProText.sm.copyWith(color: Palette.berry)),
          ),
      ],
      if (issue?.criteria case final criteria? when criteria.isNotEmpty) ...[
        const SizedBox(height: 12),
        // Folded to its count; it opens itself when the work comes back for review, to be ticked one by one.
        ProFold(
          label: '验收标准',
          summary: '${criteria.length} 条 · ${criteria.first}',
          open: s.judging,
          child: _Criteria(criteria: criteria, checking: s.judging),
        ),
      ],
      if (box != null) ...[const SizedBox(height: 16), box],
      const SizedBox(height: 20),
      if (changesView != null) ProFold(label: '改动', summary: changes?.value == null ? null : changesLine(changes!.value!), child: changesView),
      ProFold(
        label: '干活过程',
        summary: steps.isEmpty ? null : _stepsLine(steps),
        last: issue == null,
        child: steps.isEmpty
            ? EmptyNote(noStepsText(head))
            : Ticking(
                builder: (context, now) => WorkLog(steps: steps, now: now, tall: true, working: widget.state == IssueTag.working),
              ),
      ),
      if (issue != null)
        ProFold(
          label: '每次干活',
          summary: s.historyLine,
          last: true,
          child: IssueRuns(issue: issue.id, version: s.runsVersion),
        ),
    ];
    return IssueSheet(heading: heading, main: main, side: side);
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
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text(
        widget.checking ? '照验收标准看，看过一条勾一条' : '验收标准',
        style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
      ),
      const SizedBox(height: 6),
      for (final (i, c) in widget.criteria.indexed)
        if (!widget.checking)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text('· $c', style: ProText.sm),
          )
        else
          Tappable(
            onTap: () => setState(() => _ticked.contains(i) ? _ticked.remove(i) : _ticked.add(i)),
            semanticLabel: c,
            selected: _ticked.contains(i),
            builder: (_, st) => Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
              decoration: BoxDecoration(color: st.hovered ? ProColor.hover : null, borderRadius: proRadius),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 16,
                    height: 16,
                    margin: const EdgeInsets.only(top: 2, right: 10),
                    decoration: BoxDecoration(
                      color: _ticked.contains(i) ? Palette.leaf300.withValues(alpha: .5) : ProColor.page,
                      border: Border.all(color: _ticked.contains(i) ? Palette.leaf600 : (st.hovered ? ProColor.muted : ProColor.faint)),
                      borderRadius: const BorderRadius.all(Radius.circular(4)),
                    ),
                    alignment: Alignment.center,
                    child: _ticked.contains(i) ? const SpriteIcon('mark-check', size: 12, semanticLabel: '看过了') : null,
                  ),
                  Expanded(
                    child: Text(c, style: ProText.sm.copyWith(color: _ticked.contains(i) ? ProColor.muted : ProColor.ink)),
                  ),
                ],
              ),
            ),
          ),
    ],
  );
}

/// A second-level part: folded until asked for.
/// A label and its value, the label in a narrow muted column.
class KeyRow extends StatelessWidget {
  const KeyRow(this.label, this.child, {super.key});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 80,
          child: Text(label, style: ProText.sm.copyWith(color: ProColor.muted)),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: DefaultTextStyle(style: ProText.sm, child: child),
        ),
      ],
    ),
  );
}

/// The runs of an issue, read again whenever `version` changes; nothing until there is one.
class IssueRuns extends ConsumerStatefulWidget {
  const IssueRuns({super.key, required this.issue, required this.version, this.section = false});
  final String issue;
  final String version;

  /// A section of its own titled 每次干活, for a page without the folds.
  final bool section;

  @override
  ConsumerState<IssueRuns> createState() => _IssueRunsState();
}

class _IssueRunsState extends ConsumerState<IssueRuns> {
  late Future<List<Run>> _runs = _read();

  Future<List<Run>> _read() => ref.read(apiProvider).issue.runs(id: widget.issue);

  @override
  void didUpdateWidget(IssueRuns oldWidget) {
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
      final rows = [for (final r in runs.reversed) KeyRow(wallClockText(r.startedAt), Text(runText(r, now, tookText)))];
      if (widget.section) {
        return Padding(
          padding: const EdgeInsets.only(top: 20),
          child: WorkbenchSection(
            title: '每次干活',
            count: runs.length,
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: rows),
          ),
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('${runs.length} 次', style: ProText.meta),
          ),
          ...rows,
        ],
      );
    },
  );
}

/// 聊清楚 → 安排活 → 完成, the one it is at marked.
class IssueStages extends StatelessWidget {
  const IssueStages(this.at, {super.key});
  final Stage at;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      for (final s in Stage.values) ...[
        if (s.index > 0)
          Expanded(
            child: Container(height: 1, margin: const EdgeInsets.symmetric(horizontal: 8), color: s.index <= at.index ? Palette.leaf500 : ProColor.line),
          ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (s.index < at.index) SpriteIcon('mark-check', size: 12, semanticLabel: '${s.label}做完了') else ProDot(s == at ? Palette.wheat : ProColor.line),
            const SizedBox(width: 6),
            ProWeightText(
              s.label,
              style: ProText.sm.copyWith(color: s == at ? ProColor.ink : (s.index < at.index ? Palette.leaf700 : ProColor.faint)),
              strong: s == at,
            ),
          ],
        ),
      ],
    ],
  );
}

/// The head of what opens over the board: its title, and beside it what state it is in.
class IssueHeading extends StatelessWidget {
  const IssueHeading(this.title, {super.key, this.aside, this.big = false});
  final String title;
  final Widget? aside;

  /// An issue's own title, not a form's name.
  final bool big;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: Text(title, style: big ? ProText.xl : ProText.lg)),
      if (aside != null) ...[
        const SizedBox(width: 12),
        Padding(
          padding: EdgeInsets.only(top: big ? 6 : 4),
          child: DefaultTextStyle(style: ProText.meta, child: aside!),
        ),
      ],
    ],
  );
}

/// A work log folded to one line: how many steps, and how many of them used a tool when any did.
String _stepsLine(List<SessionEvent> steps) {
  final tools = steps.where((e) => e.type == SessionEventType.toolCall).length;
  return tools == 0 ? '${steps.length} 步' : '${steps.length} 步 · 用了 $tools 个工具';
}
