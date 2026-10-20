import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../game/tools.dart';
import '../village/tags.dart';
import '../data/providers.dart';
import '../data/remote.dart';
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../rules/issues.dart';
import '../rules/rounds.dart' show tookText;
import '../rules/time.dart';
import '../rules/cast.dart';
import '../sprites/atlas.dart';
import '../ui/pixel/pixel.dart';
import '../shared/composer.dart';
import '../shared/issue_state.dart';
import 'widgets.dart';
import '../shared/actions.dart';
import 'work_log.dart';
import '../shared/swatches.dart';
import 'composer.dart';

/// The farm's issue page (the plot's detail), drawn from IssueState; the workbench draws its own (workbench/issues/issue_panel.dart).
class IssueView extends ConsumerStatefulWidget {
  const IssueView({
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
    final busy = _busy;
    final commands = ref.read(farmCommandsProvider);
    final (label, run) = switch (o.act) {
      IssueAct.stop => ('叫停这一轮', () => _act(() => commands.stop(h.id))),
      IssueAct.resolve => ('让它解决冲突', () => _act(() => commands.resolve(h))),
      IssueAct.resume => ('接着做', () => _act(() => commands.water(h, resumeWords))),
      IssueAct.harvest => ('收获', () => _act(() => widget.onHarvest(h))),
      IssueAct.cure => ('接着修', () => _act(() => commands.cure(h))),
      IssueAct.close => ('关上', () => _act(() => widget.onClose(h))),
    };
    return PxButton.text(
      label,
      tone: o.act == IssueAct.close
          ? PxTone.danger
          : o.lead
          ? PxTone.primary
          : PxTone.plain,
      onPressed: busy ? null : run,
    );
  }

  @override
  Widget build(BuildContext context) {
    final graphs = ref.watch(graphsProvider);
    final s = IssueState.of(issue: widget.issue, sessions: widget.sessions, tag: widget.state, session: widget.session, graphs: graphs);
    final issue = s.issue;
    final head = s.head;
    final session = s.session;
    final changes = s.showsChanges ? ref.watch(issueChangesProvider(issue!.id)) : null;
    final steps = ref.watch(sessionEventsProvider(head.id)).value ?? const <SessionEvent>[];
    final body = PxText.sm.copyWith(color: Palette.bark800);
    final xs = PxText.xs.copyWith(color: Palette.bark600);
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final agent = (ref.watch(agentsProvider).value ?? const <String, Agent>{})[head.agent];
    final title = s.title;
    final description = s.description;
    final project = s.project;
    final current = s.current;
    final status = s.status;
    final weeds = s.weeds;
    final judging = s.judging;
    final talking = s.talking;
    final reopening = s.reopening;
    final bed = widget.onNavigate == null ? null : PxButton.text('在看板上看', icon: 'button-open', onPressed: widget.onNavigate);
    final actions = [
      if (session != null)
        for (final o in s.offers) _offer(o, session),
      ?bed,
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
              if (s.showsDoing) ...[ActionGlyph(current.action, size: 20), const SizedBox(width: 8)],
              Expanded(child: Text(status.head, style: PxText.base)),
            ],
          ),
          if (status.line case final line? when line.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(line, maxLines: 4, overflow: TextOverflow.ellipsis, style: body.copyWith(height: 1.5)),
          ],
          for (final a in status.list) Text('· $a', style: body),
          if (s.inTask) ...[const SizedBox(height: 4), Text(s.taskText, style: xs)],
        ],
      ),
    );

    final box = s.hasBox
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Composer(
                look: ComposerLook.inline,
                draft: _draft,
                minLines: judging ? 3 : 2,
                enabled: !_busy,
                enterSends: s.enterSends,
                mentions: talking,
                sendLabel: '带话',
                onSend: talking ? (text, key) => _tell(session!, text, key) : null,
                placeholder: s.placeholder,
                semanticLabel: s.boxLabel,
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
        if (description.isNotEmpty && description != title) _Row('要做的', PxReadText(description, color: Palette.bark800)),
        _Row('谁在做', Text(s.whoLine, style: body)),
        if (s.crewLine case final crew?) _Row('地上的人', Text(crew, style: body)),
        if (issue != null && s.acceptanceEditable)
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
                    onPressed: _busy || issue.acceptance == a || !s.open ? null : () => _setAcceptance(a),
                  ),
                if (issue.acceptedAt != null) Text('已验收 ${wallClockText(issue.acceptedAt!)}', style: PxText.xs.copyWith(color: Palette.leaf700)),
              ],
            ),
          ),
        if (s.pulled.isNotEmpty)
          _Row(
            '拔了的草',
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final f in s.pulled)
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
        if (head.branch != null) _Row('分支', Text(head.branch!, style: PxText.mono.copyWith(color: Palette.bark800))),
        if (head.worktree case final path?)
          _Row(
            'worktree',
            Row(
              children: [
                Expanded(child: SelectableText(path, style: PxText.mono)),
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
        _Row('做过', Text(s.historyLine, style: body.copyWith(height: 1.5))),
        _Row(
          '用时',
          Text(
            s.usedLine(steps: steps, now: now),
            style: body,
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (widget.onThread != null) PxButton.text('看工单串', size: PxSize.sm, onPressed: widget.onThread),
            if (s.inTask && widget.onTask != null) PxButton.text('看计划', size: PxSize.sm, onPressed: widget.onTask),
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
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(changesLine(c), style: body),
                  if (c.conflicts.isNotEmpty) Text('合进 ${c.base} 会冲突：${c.conflicts.join('、')}', style: body.copyWith(color: Palette.berry)),
                  const SizedBox(height: 6),
                  for (final f in c.files.take(12))
                    Text(
                      '${f.path}  +${f.added.round()} -${f.removed.round()}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: PxText.mono.copyWith(fontSize: 11, color: Palette.bark800),
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
            Expanded(child: Text(title, style: PxText.lg)),
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
              ? EmptyNote(noStepsText(head))
              : Ticking(
                  builder: (context, now) => WorkLog(steps: steps, now: now, tall: true, working: widget.state == IssueTag.working),
                ),
        ),
        if (issue != null)
          _Fold(
            label: '每次干活',
            child: IssueRunsCard(issue: issue.id, version: s.runsVersion),
          ),
        _Fold(label: '详情', child: details),
      ],
    );
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
    final body = PxText.sm.copyWith(color: Palette.bark800, height: 1.5);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(widget.checking ? '照验收标准看，看过一条勾一条' : '验收标准', style: PxText.xs.copyWith(color: Palette.bark600)),
        const SizedBox(height: 4),
        for (final (i, c) in widget.criteria.indexed)
          if (!widget.checking)
            Text('· $c', style: body)
          else
            Tappable(
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
        Tappable(
          onTap: () => setState(() => _open = !_open),
          semanticLabel: widget.label,
          builder: (_, st) => Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Transform.rotate(angle: _open ? 1.5708 : 0, child: const SpriteIcon('button-next', size: 12)),
                const SizedBox(width: 6),
                Text(widget.label, style: PxText.sm.copyWith(color: st.hovered ? Palette.bark900 : Palette.bark800)),
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
          child: Text(label, style: PxText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}

/// The runs of an issue, read again whenever `version` changes.
class IssueRunsCard extends ConsumerStatefulWidget {
  const IssueRunsCard({super.key, required this.issue, required this.version});
  final String issue;
  final String version;

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
      final body = PxText.sm.copyWith(color: Palette.bark800, height: 1.5);
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: FarmSection(
          title: '每次干活',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('${runs.length} 次'),
              for (final r in runs.reversed) _Row(wallClockText(r.startedAt), Text(runText(r, now, tookText), style: body)),
            ],
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
    final xs = PxText.xs.copyWith(color: Palette.bark600);
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
          Text(cropLabel[plot.crop]!, style: PxText.sm),
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
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    builder: (context, s) => Text(
      text,
      style: PxText.xs.copyWith(color: Palette.leaf700, decoration: s.hovered || s.focused ? TextDecoration.underline : null),
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
                  Text(s.label, style: PxText.sm.copyWith(color: s == at ? Palette.bark900 : Palette.bark500)),
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
