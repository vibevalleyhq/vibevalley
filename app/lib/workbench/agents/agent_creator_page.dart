import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';
import '../../shared/swatches.dart';
import '../shared/rules.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import '../../rules/runtimes.dart';
import '../shared/trajectory.dart';
import 'agent_config.dart';
import 'agent_look.dart';

Agent newAgent(String runtime, List<RuntimeInfo> catalog, [Look? look]) {
  return Agent(
    id: '',
    name: '新的 ${runtimeName(catalog, runtime)}',
    role: '',
    enabled: true,
    runtime: runtime,
    model: '',
    effort: '',
    persona: '',
    personaMode: factsOf(runtimeOf(catalog, runtime)).refused[sessionAppendSystemPrompt] != null ? PersonaMode.prompt : PersonaMode.append,
    skills: const [],
    mcpServers: const [],
    disallowedTools: const [],
    env: const {},
    workdir: '',
    worktree: true,
    tags: const [],
    look: lookWith(look ?? randomLook(), outfit: Outfit.farmer),
  );
}

String _json(Agent? a) => a == null ? '' : jsonEncode(a.toJson());

class AgentCreatorPage extends ConsumerStatefulWidget {
  const AgentCreatorPage({super.key, required this.id, this.runtime});
  final String id;
  final String? runtime;

  @override
  ConsumerState<AgentCreatorPage> createState() => _AgentCreatorPageState();
}

class _AgentCreatorPageState extends ConsumerState<AgentCreatorPage> {
  Agent? _draft;

  bool get _isNew => widget.id == 'new';

  /// Only the route decides what is being edited.
  void _start(WorkbenchConfig config) {
    if (!config.loaded) return;
    if (_isNew) {
      // Named after its runtime, and given the persona the way that runtime takes it: both come with runtime.list.
      final catalog = ref.read(runtimesProvider).value;
      if (catalog == null) return;
      _draft = newAgent(widget.runtime ?? 'claude', catalog);
    } else {
      _draft = config.agent(widget.id);
    }
  }

  @override
  void initState() {
    super.initState();
    _start(ref.read(workbenchConfigProvider));
  }

  @override
  void didUpdateWidget(AgentCreatorPage old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id || old.runtime != widget.runtime) {
      _draft = null;
      _start(ref.read(workbenchConfigProvider));
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(workbenchConfigProvider);
    ref.listen(workbenchConfigProvider.select((c) => c.loaded), (was, loaded) {
      if (loaded && _draft == null) setState(() => _start(ref.read(workbenchConfigProvider)));
    });
    ref.listen(runtimesProvider.select((r) => r.hasValue), (was, has) {
      if (has && _draft == null) setState(() => _start(ref.read(workbenchConfigProvider)));
    });
    if (config.error != null) return const ConfigProblem();
    if (_isNew && _draft == null && ref.watch(runtimesProvider.select((r) => r.hasError))) return const RuntimeProblem();
    final note = ProText.sm.copyWith(color: ProColor.muted);
    if (!config.loaded) {
      return Padding(
        padding: const EdgeInsets.all(32),
        child: Text('读取配置…', style: note),
      );
    }
    final saved = config.agent(widget.id);
    if (!_isNew && saved == null) {
      return Padding(
        padding: const EdgeInsets.all(32),
        child: DefaultTextStyle(
          style: ProText.sm.copyWith(color: ProColor.muted),
          child: Row(
            children: [
              const Text('没有这个帮工。'),
              InlineLink('回到全部帮工', onTap: () => workbenchGo(context, '/agents')),
            ],
          ),
        ),
      );
    }
    final draft = _draft;
    if (draft == null) return const SizedBox.shrink();
    return _Creator(key: ValueKey(widget.id), draft: draft, saved: saved, isNew: _isNew, onDraft: (a) => setState(() => _draft = a));
  }
}

class _Creator extends ConsumerStatefulWidget {
  const _Creator({super.key, required this.draft, required this.saved, required this.isNew, required this.onDraft});
  final Agent draft;
  final Agent? saved;
  final bool isNew;
  final ValueChanged<Agent> onDraft;

  @override
  ConsumerState<_Creator> createState() => _CreatorState();
}

class _CreatorState extends ConsumerState<_Creator> {
  Pose _pose = Pose.idle;
  bool _saving = false;

  /// Its trajectories over the whole page in place of the profile; the draft stays as it was.
  bool _trajectories = false;

  Future<void> _save() async {
    final draft = widget.draft;
    setState(() => _saving = true);
    final name = draft.name.trim();
    final saved = await runAction(() => ref.read(workbenchConfigProvider.notifier).saveAgent(draft.copyWith(name: name.isEmpty ? '无名 agent' : name)));
    if (!mounted) return;
    setState(() => _saving = false);
    if (saved != null && widget.isNew) workbenchGo(context, '/agents/${Uri.encodeComponent(saved.id)}');
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(workbenchConfigProvider);
    final draft = widget.draft;
    final saved = widget.saved;
    final runtime = ref.watch(runtimeInfoProvider(draft.runtime));
    final issues = watchAgentIssues(ref, [draft])[draft.id] ?? const <AgentIssue>[];
    final dirty = widget.isNew || _json(saved) != _json(draft);
    final nameTaken = config.agents.any((a) => a.id != draft.id && a.name == draft.name.trim());
    void patch(Agent a) => widget.onDraft(a);

    final back = DefaultTextStyle(
      style: ProText.sm,
      child: InlineLink('← 全部帮工', color: ProColor.muted, onTap: () => workbenchGo(context, '/agents')),
    );
    final badge = widget.isNew
        ? const BadgeLabel('新的', hat: true)
        : dirty
        ? const BadgeLabel('没保存', hat: true)
        : const BadgeLabel('已保存');
    final actions = Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        if (!widget.isNew && saved != null) _DeleteButton(agent: saved),
        if (!widget.isNew && dirty && saved != null) ProButton.text('放弃改动', onPressed: () => patch(saved)),
        ProButton.text(_saving ? '保存中…' : (widget.isNew ? '捏好了，保存' : '保存'), tone: ProTone.primary, onPressed: !dirty || _saving || nameTaken ? null : _save),
      ],
    );
    final name = Text(draft.name.isEmpty ? '无名帮工' : draft.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.lg);
    final bar = Container(
      padding: const EdgeInsets.symmetric(vertical: 12),
      decoration: const BoxDecoration(border: Border(bottom: proLine)),
      child: LayoutBuilder(
        builder: (context, box) => box.maxWidth < 600
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(spacing: 12, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [back, badge]),
                  const SizedBox(height: 8),
                  name,
                  const SizedBox(height: 8),
                  actions,
                ],
              )
            : Row(
                children: [
                  back,
                  const SizedBox(width: 12),
                  Text('/', style: ProText.sm.copyWith(color: ProColor.faint)),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Row(
                      children: [
                        Flexible(child: name),
                        const SizedBox(width: 12),
                        badge,
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  actions,
                ],
              ),
      ),
    );

    final look = ProPanel(
      child: AgentLookPanel(
        look: draft.look,
        id: draft.id,
        onChange: (l) => patch(draft.copyWith(look: l)),
      ),
    );

    final stage = Container(
      clipBehavior: Clip.antiAlias,
      decoration: const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: BorderRadius.all(Radius.circular(8))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: AgentStage(look: draft.look, id: draft.id, pose: _pose, name: draft.name, role: draft.role),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              alignment: WrapAlignment.center,
              spacing: 6,
              runSpacing: 6,
              children: [for (final p in stagePoses) WorkbenchPill(label: p.label, on: _pose == p.pose, onTap: () => setState(() => _pose = p.pose))],
            ),
          ),
        ],
      ),
    );

    if (_trajectories) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            bar,
            const SizedBox(height: 12),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        DefaultTextStyle(
                          style: ProText.sm,
                          child: InlineLink('← 回到档案', color: ProColor.muted, onTap: () => setState(() => _trajectories = false)),
                        ),
                        const SizedBox(width: 12),
                        const Flexible(child: TrajectoryTitle('轨迹', about: '它派出去的每个帮工，从接活起的每一步：收到的话、用的每个工具（点一行看输入和输出）、说的话。收工以后步骤留 30 天，帮工本身一直列着。')),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Expanded(child: TrajectoryList(agent: draft.id)),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, box) {
        final wide = box.maxWidth >= 1024;
        final configCard = Container(
          clipBehavior: Clip.antiAlias,
          decoration: const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: BorderRadius.all(Radius.circular(8))),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: wide ? MainAxisSize.max : MainAxisSize.min,
            children: [
              AgentConfigTabs(
                draft: draft,
                runtime: runtime,
                patch: patch,
                nameTaken: nameTaken,
                isNew: widget.isNew,
                fill: wide,
                onTrajectories: () => setState(() => _trajectories = true),
              ),
              _Issues(issues: issues),
            ],
          ),
        );
        if (wide) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                bar,
                const SizedBox(height: 12),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(width: 304, child: SingleChildScrollView(child: look)),
                      const SizedBox(width: 12),
                      Expanded(
                        child: ConstrainedBox(constraints: const BoxConstraints(minHeight: 416), child: stage),
                      ),
                      const SizedBox(width: 12),
                      SizedBox(width: 432, child: configCard),
                    ],
                  ),
                ),
              ],
            ),
          );
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              bar,
              const SizedBox(height: 12),
              SizedBox(height: 416, child: stage),
              const SizedBox(height: 12),
              look,
              const SizedBox(height: 12),
              configCard,
            ],
          ),
        );
      },
    );
  }
}

class _DeleteButton extends ConsumerStatefulWidget {
  const _DeleteButton({required this.agent});
  final Agent agent;

  @override
  ConsumerState<_DeleteButton> createState() => _DeleteButtonState();
}

class _DeleteButtonState extends ConsumerState<_DeleteButton> {
  bool _sure = false;

  @override
  Widget build(BuildContext context) {
    if (!_sure) return ProButton.text('删除', onPressed: () => setState(() => _sure = true));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('删掉 ${widget.agent.name}？', style: ProText.sm.copyWith(color: ProColor.muted)),
        const SizedBox(width: 8),
        ProButton.text(
          '删除',
          tone: ProTone.danger,
          onPressed: () async {
            final done = await runAction(() async {
              await ref.read(workbenchConfigProvider.notifier).deleteAgent(widget.agent.id);
              return true;
            });
            if (done == true && context.mounted) workbenchGo(context, '/agents');
          },
        ),
        const SizedBox(width: 6),
        ProButton.text('算了', onPressed: () => setState(() => _sure = false)),
      ],
    );
  }
}

class _Issues extends StatelessWidget {
  const _Issues({required this.issues});
  final List<AgentIssue> issues;

  @override
  Widget build(BuildContext context) {
    const top = BoxDecoration(border: Border(top: proLine));
    if (issues.isEmpty) {
      return Container(
        decoration: top,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Marked(
          'mark-check',
          top: 4,
          child: Text('配置没问题，可以派活。', style: ProText.sm.copyWith(color: Palette.leaf700)),
        ),
      );
    }
    return Container(
      decoration: top,
      constraints: const BoxConstraints(maxHeight: 160),
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final i in issues)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Marked(
                  i.level == AgentIssueLevel.error ? 'mark-cross' : 'mark-warn',
                  top: 4,
                  child: Text(
                    '${i.level == AgentIssueLevel.error ? '派不出去：' : ''}${i.text}',
                    style: ProText.sm.copyWith(color: i.level == AgentIssueLevel.error ? Palette.berry : const Color(0xFFB8682A)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
