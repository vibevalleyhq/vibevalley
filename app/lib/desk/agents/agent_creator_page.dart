import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../shared/faces.dart';
import '../shared/looks.dart';
import '../shared/memory_panels.dart';
import '../shared/rules.dart';
import '../shared/state.dart';
import '../shared/widgets.dart';
import '../shared/work_log.dart';
import '../../rules/index.dart';
import '../../rules/looks.dart';
import '../../rules/seeds.dart';

const _stagePoses = [
  (pose: Pose.idle, label: '待命', crop: Crop.empty),
  (pose: Pose.walk, label: '走过来', crop: Crop.seeded),
  (pose: Pose.think, label: '琢磨', crop: Crop.sprout),
  (pose: Pose.work, label: '干活', crop: Crop.leafy),
  (pose: Pose.cheer, label: '做完', crop: Crop.wheat),
  (pose: Pose.worry, label: '长虫了', crop: Crop.withered),
];

AgentProfile newAgent(String runtime, Set<String> taken, [Look? look]) {
  var n = 1;
  while (taken.contains('agent-$n')) {
    n++;
  }
  return AgentProfile(
    id: 'agent-$n',
    name: '新的 ${runtimeName(runtime)}',
    role: '',
    enabled: true,
    runtime: runtime,
    model: '',
    effort: '',
    persona: '',
    personaMode: factsOf(runtime).refused[SessionOption.appendSystemPrompt] != null ? PersonaMode.prompt : PersonaMode.append,
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

String _json(AgentProfile? a) => a == null ? '' : jsonEncode(a.toJson());

class AgentCreatorPage extends ConsumerStatefulWidget {
  const AgentCreatorPage({super.key, required this.id, this.runtime});
  final String id;
  final String? runtime;

  @override
  ConsumerState<AgentCreatorPage> createState() => _AgentCreatorPageState();
}

class _AgentCreatorPageState extends ConsumerState<AgentCreatorPage> {
  AgentProfile? _draft;

  bool get _isNew => widget.id == 'new';

  /// Only the route decides what is being edited.
  void _start(DeskConfig config) {
    if (!config.loaded) return;
    if (_isNew) {
      _draft = newAgent(widget.runtime ?? 'claude', {for (final a in config.agents) a.id});
    } else {
      _draft = config.agent(widget.id);
    }
  }

  @override
  void initState() {
    super.initState();
    _start(ref.read(deskConfigProvider));
  }

  @override
  void didUpdateWidget(AgentCreatorPage old) {
    super.didUpdateWidget(old);
    if (old.id != widget.id || old.runtime != widget.runtime) {
      _draft = null;
      _start(ref.read(deskConfigProvider));
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(deskConfigProvider);
    ref.listen(deskConfigProvider.select((c) => c.loaded), (was, loaded) {
      if (loaded && _draft == null) setState(() => _start(ref.read(deskConfigProvider)));
    });
    final note = KitText.sm.copyWith(color: Palette.bark500);
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
          style: KitText.sm.copyWith(color: Palette.bark600),
          child: Row(
            children: [
              const Text('没有这个帮工。'),
              DeskLink('回到全部帮工', onTap: () => deskGo(context, '/agents')),
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
  final AgentProfile draft;
  final AgentProfile? saved;
  final bool isNew;
  final ValueChanged<AgentProfile> onDraft;

  @override
  ConsumerState<_Creator> createState() => _CreatorState();
}

class _CreatorState extends ConsumerState<_Creator> {
  Pose _pose = Pose.idle;
  bool _saving = false;

  Future<void> _save() async {
    final draft = widget.draft;
    setState(() => _saving = true);
    final name = draft.name.trim();
    final ok = await deskRun(() async {
      await ref.read(deskConfigProvider.notifier).saveAgent(draft.copyWith(name: name.isEmpty ? '无名 agent' : name));
      return true;
    });
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok == true && widget.isNew) deskGo(context, '/agents/${Uri.encodeComponent(draft.id)}');
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(deskConfigProvider);
    final draft = widget.draft;
    final saved = widget.saved;
    final runtime = config.runtime(draft.runtime);
    final issues = agentIssues(draft, runtime);
    final dirty = widget.isNew || _json(saved) != _json(draft);
    final nameTaken = config.agents.any((a) => a.id != draft.id && a.name == draft.name.trim());
    void patch(AgentProfile a) => widget.onDraft(a);

    final bar = PxWindow(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Container(
            foregroundDecoration: pxRing,
            child: DefaultTextStyle(
              style: KitText.sm.copyWith(color: Palette.bark600),
              child: DeskLink('← 全部帮工', color: Palette.bark600, onTap: () => deskGo(context, '/agents')),
            ),
          ),
          const SizedBox(width: 12),
          Text('/', style: KitText.sm.copyWith(color: Palette.cream300)),
          const SizedBox(width: 12),
          Expanded(
            child: Row(
              children: [
                Flexible(
                  child: Text(draft.name.isEmpty ? '无名帮工' : draft.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.lg),
                ),
                const SizedBox(width: 12),
                if (widget.isNew) const DeskBadge('新的', hat: true) else if (dirty) const DeskBadge('没保存', hat: true) else const DeskBadge('已保存'),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (!widget.isNew && saved != null) _DeleteButton(agent: saved),
              if (!widget.isNew && dirty && saved != null) PxButton.text('放弃改动', onPressed: () => patch(saved)),
              PxButton.text(
                _saving ? '保存中…' : (widget.isNew ? '捏好了，保存' : '保存'),
                tone: PxTone.primary,
                onPressed: !dirty || _saving || nameTaken ? null : _save,
              ),
            ],
          ),
        ],
      ),
    );

    final look = PxWindow(
      padding: const EdgeInsets.all(16),
      child: _LookPanel(
        look: draft.look,
        id: draft.id,
        onChange: (l) => patch(draft.copyWith(look: l)),
      ),
    );

    final stage = PxWindow(
      clip: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: _Stage(look: draft.look, id: draft.id, pose: _pose, name: draft.name, role: draft.role),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              alignment: WrapAlignment.center,
              spacing: 6,
              runSpacing: 6,
              children: [for (final p in _stagePoses) DeskPill(label: p.label, on: _pose == p.pose, onTap: () => setState(() => _pose = p.pose))],
            ),
          ),
        ],
      ),
    );

    return LayoutBuilder(
      builder: (context, box) {
        final wide = box.maxWidth >= 1024;
        final configCard = PxWindow(
          clip: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: wide ? MainAxisSize.max : MainAxisSize.min,
            children: [
              _ConfigTabs(draft: draft, runtime: runtime, patch: patch, nameTaken: nameTaken, isNew: widget.isNew, fill: wide),
              _Issues(issues: issues),
            ],
          ),
        );
        if (wide) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                bar,
                const SizedBox(height: 12),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(width: 304, child: PxScrollView(child: look)),
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
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
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
  final AgentProfile agent;

  @override
  ConsumerState<_DeleteButton> createState() => _DeleteButtonState();
}

class _DeleteButtonState extends ConsumerState<_DeleteButton> {
  bool _sure = false;

  @override
  Widget build(BuildContext context) {
    if (!_sure) return PxButton.text('删除', onPressed: () => setState(() => _sure = true));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('删掉 ${widget.agent.name}？', style: KitText.xs.copyWith(color: Palette.bark600)),
        const SizedBox(width: 6),
        PxButton.text(
          '删除',
          tone: PxTone.danger,
          onPressed: () async {
            final done = await deskRun(() async {
              await ref.read(deskConfigProvider.notifier).deleteAgent(widget.agent.id);
              return true;
            });
            if (done == true && context.mounted) deskGo(context, '/agents');
          },
        ),
        const SizedBox(width: 6),
        PxButton.text('算了', onPressed: () => setState(() => _sure = false)),
      ],
    );
  }
}

class _LookPanel extends ConsumerWidget {
  const _LookPanel({required this.look, required this.id, required this.onChange});
  final Look look;
  final String id;
  final ValueChanged<Look> onChange;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final cast = castOf(look, id);
    Widget grid(List<Widget> tiles) => LayoutBuilder(
      builder: (context, box) {
        final w = (box.maxWidth - 3 * 6) / 4;
        return Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [for (final t in tiles) SizedBox(width: w, child: t)],
        );
      },
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: PxButton(
            onPressed: () => onChange(randomLook()),
            child: const Row(mainAxisSize: MainAxisSize.min, children: [SpriteIcon('button-replay', size: 16), SizedBox(width: 6), Text('随机一个')]),
          ),
        ),
        const SizedBox(height: 20),
        PxField(
          label: '在农场里是',
          hint: const Text('只是长相：同一个 runtime 可以是不同的动物。'),
          child: grid([
            for (final species in Species.values)
              _Tile(
                active: cast.species == species,
                label: speciesLabel[species]!,
                onTap: () => onChange(lookWith(look, species: species)),
                child: CastFace(cast: (species: species, outfit: cast.outfit), size: 48),
              ),
          ]),
        ),
        const SizedBox(height: 20),
        PxField(
          label: '穿什么',
          child: grid([
            for (final outfit in Outfit.values)
              _Tile(
                active: cast.outfit == outfit,
                label: outfitLabel[outfit]!,
                onTap: () => onChange(lookWith(look, outfit: outfit)),
                child: SizedBox(
                  height: 64,
                  child: atlas == null
                      ? null
                      : Image.asset(
                          castSprite(atlas, (species: cast.species, outfit: outfit), Pose.idle).asset,
                          height: 64,
                          fit: BoxFit.contain,
                          filterQuality: FilterQuality.none,
                        ),
                ),
              ),
          ]),
        ),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.active, required this.onTap, required this.label, required this.child});
  final bool active;
  final VoidCallback onTap;
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => DeskChoice(
    active: active,
    onTap: onTap,
    tooltip: label,
    semanticLabel: label,
    padding: const EdgeInsets.fromLTRB(4, 4, 4, 6),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        child,
        const SizedBox(height: 2),
        Text(label, style: KitText.fine.copyWith(color: active ? Palette.leaf700 : Palette.bark500)),
      ],
    ),
  );
}

class _Stage extends ConsumerWidget {
  const _Stage({required this.look, required this.id, required this.pose, required this.name, required this.role});
  final Look look;
  final String id;
  final Pose pose;
  final String name;
  final String role;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final cast = castOf(look, id);
    final shown = _stagePoses.firstWhere((p) => p.pose == pose);
    final bed = atlas != null && atlas.has(cropSprite(shown.crop)) ? atlas[cropSprite(shown.crop)] : null;
    final pill = Palette.cream50;
    return Container(
      decoration: const BoxDecoration(
        gradient: RadialGradient(center: Alignment(0, -.1), radius: .6, colors: [Color(0xFFC7DD9A), Color(0xFF9CC069), Color(0xFF7EA64F)], stops: [0, .6, 1]),
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: SizedBox(
                width: 384,
                height: 288,
                child: Stack(
                  children: [
                    if (bed != null)
                      Positioned(
                        bottom: 24,
                        left: 192 - 288 * .62,
                        width: 288,
                        child: Image.asset(bed.asset, width: 288, fit: BoxFit.fitWidth, filterQuality: FilterQuality.none),
                      ),
                    if (atlas != null)
                      Builder(
                        builder: (context) {
                          final sp = pose == Pose.walk ? walkFrames(atlas, cast).first : castSprite(atlas, cast, pose);
                          final k = 224 / sp.h;
                          return Positioned(
                            left: 384 - 96 - sp.ax * k,
                            top: 288 - 8 - sp.ay * k,
                            child: PoseSprite(key: ValueKey(pose), cast: cast, pose: pose, height: 224),
                          );
                        },
                      ),
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 16,
            child: IgnorePointer(
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                    decoration: BoxDecoration(color: pill.withValues(alpha: .9), boxShadow: kitDrop),
                    child: Text(name.isEmpty ? '无名 agent' : name, style: KitText.lg),
                  ),
                  if (role.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(top: 4),
                      constraints: const BoxConstraints(maxWidth: 384),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      color: pill.withValues(alpha: .7),
                      child: Text(
                        role,
                        textAlign: TextAlign.center,
                        style: KitText.xs.copyWith(color: Palette.bark800),
                      ),
                    ),
                ],
              ),
            ),
          ),
          Positioned(
            top: 12,
            right: 16,
            child: IgnorePointer(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                color: pill.withValues(alpha: .7),
                child: Text('${speciesLabel[cast.species]} · ${outfitLabel[cast.outfit]} · 下面换动作', style: KitText.fine.copyWith(color: Palette.bark800)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

enum _Tab { who, runtime, persona, skills, tools, env, memory, trajectories }

class _ConfigTabs extends StatefulWidget {
  const _ConfigTabs({required this.draft, required this.runtime, required this.patch, required this.nameTaken, required this.isNew, required this.fill});
  final AgentProfile draft;
  final RuntimeInfo? runtime;
  final ValueChanged<AgentProfile> patch;
  final bool nameTaken;
  final bool isNew;

  final bool fill;

  @override
  State<_ConfigTabs> createState() => _ConfigTabsState();
}

class _ConfigTabsState extends State<_ConfigTabs> {
  _Tab _tab = _Tab.who;

  @override
  Widget build(BuildContext context) {
    final draft = widget.draft;
    final patch = widget.patch;
    final facts = factsOf(draft.runtime);
    final tabs = [
      (_Tab.who, '身份'),
      (_Tab.runtime, '能力'),
      (_Tab.persona, '人设'),
      (_Tab.skills, '技能'),
      (_Tab.tools, '工具'),
      (_Tab.env, '环境'),
      if (!widget.isNew) (_Tab.memory, '记性'),
      if (!widget.isNew) (_Tab.trajectories, '轨迹'),
    ];
    final tab = tabs.any((t) => t.$1 == _tab) ? _tab : _Tab.who;
    final envRefused = facts.refused[SessionOption.env];
    final children = switch (tab) {
      _Tab.who => [
        PxField(
          label: '名字',
          error: widget.nameTaken ? '已经有同名的 agent 了' : null,
          hint: const Text('管家和字幕里都叫这个名字，说话时也可以直接点名。'),
          child: PxTextInput(
            value: draft.name,
            onChanged: (name) => patch(draft.copyWith(name: name)),
            semanticLabel: '名字',
          ),
        ),
        PxField(
          label: '职责',
          hint: const Text('一句话。管家挑人时会读。'),
          child: PxTextInput(
            value: draft.role,
            onChanged: (role) => patch(draft.copyWith(role: role)),
            placeholder: '比如：写接口、改 server、跑 Go 测试',
            semanticLabel: '职责',
          ),
        ),
        PxField(
          label: '适合的活',
          hint: const Text('用户的话里出现这些词，管家选「自动」时就优先派它。回车添加。'),
          child: PxChipsInput(
            value: draft.tags,
            onChanged: (tags) => patch(draft.copyWith(tags: tags)),
            placeholder: '前端、测试、文档…',
          ),
        ),
        PxSwitchField(
          label: '启用',
          checked: draft.enabled,
          onChanged: (enabled) => patch(draft.copyWith(enabled: enabled)),
          hint: '停用后管家不会派它，名字点到也会拒绝。',
        ),
      ],
      _Tab.runtime => [_RuntimeChoice(draft: draft, patch: patch), ..._modelAndEffort(draft, widget.runtime, patch), _RuntimeFacts(runtime: draft.runtime)],
      _Tab.persona => _personaEditor(draft, patch),
      _Tab.skills => [_SkillPicker(draft: draft, runtime: widget.runtime, patch: patch)],
      _Tab.tools => _toolsEditor(draft, widget.runtime, patch),
      _Tab.env => [
        PxField(
          label: '默认项目',
          hint: const Text('工作目录（VIBEVALLEY_WORK_ROOT）下的一个文件夹。管家派活没说项目时用它；留空时派活必须说在哪个项目。'),
          child: PxTextInput(
            value: draft.workdir,
            onChanged: (workdir) => patch(draft.copyWith(workdir: workdir)),
            placeholder: '比如 clock-in',
            mono: true,
            semanticLabel: '默认项目',
          ),
        ),
        PxSwitchField(
          label: '每个帮工一个 git worktree',
          checked: draft.worktree,
          onChanged: (worktree) => patch(draft.copyWith(worktree: worktree)),
          hint: '每个帮工在自己的分支上改，几个帮工不会互相覆盖；收获时合进项目。关掉就直接在项目里改，没有分支可合。',
        ),
        PxField(
          label: '环境变量',
          error: envRefused != null && draft.env.isNotEmpty ? envRefused : null,
          hint: Text(envRefused ?? '叠加在 runtime 设置的环境变量之上。'),
          child: PxKeyValueEditor(
            value: draft.env,
            onChanged: (env) => patch(draft.copyWith(env: env)),
            enabled: envRefused == null,
          ),
        ),
      ],
      _Tab.memory => [MemoryPanel(agent: draft.id)],
      _Tab.trajectories => [TrajectoryList(agent: draft.id)],
    };
    final panel = Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: 16), children[i]],
        ],
      ),
    );
    final head = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Palette.cream300)),
      ),
      child: DeskTabs<_Tab>(value: tab, tabs: tabs, onChanged: (t) => setState(() => _tab = t)),
    );
    if (!widget.fill) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [head, panel]);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          head,
          Expanded(child: SingleChildScrollView(child: panel)),
        ],
      ),
    );
  }
}

class _RuntimeChoice extends ConsumerWidget {
  const _RuntimeChoice({required this.draft, required this.patch});
  final AgentProfile draft;
  final ValueChanged<AgentProfile> patch;

  void _choose(String id) {
    final facts = factsOf(id);
    final cannotTakeSystemPrompt = facts.refused[SessionOption.appendSystemPrompt] != null || facts.refused[SessionOption.systemPrompt] != null;
    // A persona the new runtime can't take as a system prompt goes into each job instead.
    patch(
      draft.copyWith(
        runtime: id,
        model: '',
        effort: '',
        personaMode: draft.personaMode != PersonaMode.prompt && cannotTakeSystemPrompt ? PersonaMode.prompt : draft.personaMode,
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runtimes = ref.watch(deskConfigProvider.select((c) => c.runtimes));
    return PxField(
      label: 'Runtime',
      hint: const Text('换 runtime 会清掉模型和推理强度；长相（动物和衣服）不变。'),
      child: LayoutBuilder(
        builder: (context, box) {
          final w = (box.maxWidth - 6) / 2;
          return Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final p in runtimePresets)
                SizedBox(
                  width: w,
                  child: () {
                    final info = runtimes.where((r) => r.id == p.id).firstOrNull;
                    final installation = info?.installation;
                    final available = installation is InstallationAvailable;
                    final ok = available && info!.settings.enabled;
                    final active = draft.runtime == p.id;
                    final status = available ? (info!.settings.enabled ? (installation.version ?? '可用') : '已停用') : '这台机器上没有';
                    return DeskChoice(
                      active: active,
                      onTap: () => _choose(p.id),
                      semanticLabel: p.label,
                      padding: const EdgeInsets.all(8),
                      child: Row(
                        children: [
                          RuntimeIcon(runtime: p.id, size: 32, muted: !ok),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  p.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: KitText.sm.copyWith(color: active ? Palette.leaf700 : Palette.bark900),
                                ),
                                Text(
                                  status,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: KitText.fine.copyWith(color: ok ? Palette.bark500 : Palette.berry),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    );
                  }(),
                ),
            ],
          );
        },
      ),
    );
  }
}

List<Widget> _modelAndEffort(AgentProfile draft, RuntimeInfo? runtime, ValueChanged<AgentProfile> patch) {
  final models = runtime?.models ?? const <ModelEntry>[];
  final defaultModel = runtime?.settings.defaultModel ?? '';
  final fallback = defaultModel.isNotEmpty ? defaultModel : (models.where((m) => m.isDefault).firstOrNull?.id ?? '');
  final want = draft.model.isNotEmpty ? draft.model : fallback;
  final model = models.where((m) => m.id == want).firstOrNull;
  final refusedEffort = factsOf(draft.runtime).refused[SessionOption.effort];
  final levels = model?.effortLevels ?? const <String>[];
  return [
    PxField(
      label: '模型',
      hint: models.isEmpty ? const Text('这个 runtime 现在报不出模型列表。') : null,
      child: PxPick(
        value: draft.model,
        onChanged: (m) => patch(draft.copyWith(model: m, effort: '')),
        placeholder: 'runtime 默认${fallback.isNotEmpty ? '（$fallback）' : ''}',
        options: [for (final m in models) PickOption(value: m.id, label: m.name, detail: m.effortLevels.isNotEmpty ? '${m.effortLevels.length} 档推理' : '')],
        enabled: models.isNotEmpty,
        semanticLabel: '模型',
      ),
    ),
    PxField(
      label: '推理强度',
      hint: Text(refusedEffort ?? (levels.isEmpty ? '${model?.name ?? '这个模型'}没有推理强度可选。' : '默认由 runtime 决定。')),
      child: PxSegmented<String>(
        value: draft.effort,
        onChanged: (effort) => patch(draft.copyWith(effort: effort)),
        options: [
          const SegmentOption(value: '', label: '默认'),
          for (final l in levels) SegmentOption(value: l, label: l, disabled: refusedEffort != null),
        ],
      ),
    ),
  ];
}

class _RuntimeFacts extends StatelessWidget {
  const _RuntimeFacts({required this.runtime});
  final String runtime;

  @override
  Widget build(BuildContext context) {
    final facts = factsOf(runtime);
    final line = KitText.xs.copyWith(color: Palette.bark600);
    return PxCard(
      title: '${runtimeName(runtime)} 能做什么',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Marked(facts.steer ? 'mark-check' : 'mark-cross', child: Text(facts.steer ? '能在干活时接话（steer）' : '干活时不能插话，话会排到这一轮之后', style: line)),
          const SizedBox(height: 6),
          Text(facts.inProcess ? '· 跑在 server 进程里（Node SDK）' : '· 作为单独的命令行进程运行', style: line),
          for (final MapEntry(key: option, value: reason) in facts.refused.entries) ...[
            const SizedBox(height: 6),
            Text.rich(
              TextSpan(
                text: '不接受 ',
                children: [
                  TextSpan(
                    text: option,
                    style: KitText.mono.copyWith(color: Palette.bark600),
                  ),
                  TextSpan(text: '：$reason'),
                ],
              ),
              style: line.copyWith(color: Palette.bark500),
            ),
          ],
        ],
      ),
    );
  }
}

const _personaModes = [
  (value: PersonaMode.append, label: '追加到系统提示', detail: '保留 runtime 自带的工作方式，在后面加上人设。大多数情况选这个。', option: SessionOption.appendSystemPrompt),
  (value: PersonaMode.replace, label: '替换系统提示', detail: '整段换掉 runtime 自带的系统提示。只有你清楚自己在做什么时才用。', option: SessionOption.systemPrompt),
  (value: PersonaMode.prompt, label: '写进工单开头', detail: '每张工单前面加上人设。所有 runtime 都能用，但会被长对话冲淡。', option: null),
];

List<Widget> _personaEditor(AgentProfile draft, ValueChanged<AgentProfile> patch) {
  final facts = factsOf(draft.runtime);
  final mode = _personaModes.where((m) => m.value == draft.personaMode).firstOrNull;
  return [
    PxField(
      label: '人设',
      hint: const Text('它是谁、怎么干活、什么不做。会按下面的方式交给 runtime。'),
      child: PxTextArea(
        value: draft.persona,
        onChanged: (persona) => patch(draft.copyWith(persona: persona)),
        rows: 9,
        placeholder: '你是一个谨慎的后端工程师。先读懂现有代码再动手……',
        semanticLabel: '人设',
      ),
    ),
    PxField(
      label: '交给 runtime 的方式',
      hint: mode == null ? null : Text(mode.detail),
      child: PxSegmented<PersonaMode>(
        value: draft.personaMode,
        onChanged: (personaMode) => patch(draft.copyWith(personaMode: personaMode)),
        options: [
          for (final m in _personaModes)
            SegmentOption(
              value: m.value,
              label: m.label,
              disabled: m.option != null && facts.refused[m.option] != null,
              title: m.option == null ? null : facts.refused[m.option],
            ),
        ],
      ),
    ),
  ];
}

class _SkillPicker extends ConsumerWidget {
  const _SkillPicker({required this.draft, required this.runtime, required this.patch});
  final AgentProfile draft;
  final RuntimeInfo? runtime;
  final ValueChanged<AgentProfile> patch;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final skills = ref.watch(deskConfigProvider.select((c) => c.skills));
    void toggle(String id) => patch(
      draft.copyWith(
        skills: draft.skills.contains(id)
            ? [
                for (final s in draft.skills)
                  if (s != id) s,
              ]
            : [...draft.skills, id],
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PxField(
          label: '技能库',
          aside: DeskLink('管理技能库 →', onTap: () => deskGo(context, '/skills')),
          hint: const Text('选中的技能跟人设一起交给帮工，每个技能一节。'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final s in skills)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: DeskChoice(
                    active: draft.skills.contains(s.id),
                    onTap: () => toggle(s.id),
                    semanticLabel: s.name,
                    padding: const EdgeInsets.all(10),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 16,
                          height: 16,
                          margin: const EdgeInsets.only(top: 2),
                          alignment: Alignment.center,
                          color: Palette.cream300,
                          child: draft.skills.contains(s.id) ? const SpriteIcon('mark-check', size: 14) : null,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(s.name, style: KitText.sm),
                              Text(s.description, style: KitText.xs.copyWith(color: Palette.bark500)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        PxField(
          label: '${runtimeName(draft.runtime)} 自己装的技能',
          hint: const Text('runtime 自己报告的，在这台机器上已经能用，不用在这里勾。'),
          child: _Inventory(entries: runtime?.skills),
        ),
      ],
    );
  }
}

List<Widget> _toolsEditor(AgentProfile draft, RuntimeInfo? runtime, ValueChanged<AgentProfile> patch) {
  final facts = factsOf(draft.runtime);
  final mcpRefused = facts.refused[SessionOption.mcpServers];
  final toolsRefused = facts.refused[SessionOption.disallowedTools];
  final tools = runtime?.tools;
  return [
    PxField(
      label: 'MCP 服务器',
      hint: Text(mcpRefused ?? '开 session 时交给 runtime（oar 的 SessionOptions.mcpServers）。'),
      error: mcpRefused != null && draft.mcpServers.isNotEmpty ? mcpRefused : null,
      child: _McpList(
        value: draft.mcpServers,
        onChanged: (mcpServers) => patch(draft.copyWith(mcpServers: mcpServers)),
        disabled: mcpRefused != null,
      ),
    ),
    PxField(
      label: '禁用的工具',
      hint: Text(toolsRefused ?? '这些工具这个 agent 不能用。下面 runtime 报告的工具点一下就能加进来。'),
      error: toolsRefused != null && draft.disallowedTools.isNotEmpty ? toolsRefused : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PxChipsInput(
            value: draft.disallowedTools,
            onChanged: (disallowedTools) => patch(draft.copyWith(disallowedTools: disallowedTools)),
            placeholder: '比如 WebSearch',
            enabled: toolsRefused == null,
          ),
          if (tools != null && toolsRefused == null) ...[
            const SizedBox(height: 6),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final t in tools.where((t) => !draft.disallowedTools.contains(t.name)))
                  KitTappable(
                    onTap: () => patch(draft.copyWith(disallowedTools: [...draft.disallowedTools, t.name])),
                    semanticLabel: '+ ${t.name}',
                    builder: (context, s) => Container(
                      color: s.hovered ? Palette.cream200 : Palette.cream50,
                      foregroundDecoration: pxRing,
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      child: Text('+ ${t.name}', style: KitText.mono.copyWith(height: 1.5, color: s.hovered ? Palette.bark900 : Palette.bark600)),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    ),
    PxField(
      label: '${runtimeName(draft.runtime)} 自己连的 MCP',
      hint: const Text('runtime 自己报告的，和上面加的叠在一起。'),
      child: _Inventory(entries: runtime?.mcpServers),
    ),
  ];
}

String _mcpName(McpServer s) => switch (s) {
  McpServerStdio(:final name) => name,
  McpServerHttp(:final name) => name,
};

class _McpList extends StatefulWidget {
  const _McpList({required this.value, required this.onChanged, required this.disabled});
  final List<McpServer> value;
  final ValueChanged<List<McpServer>> onChanged;
  final bool disabled;

  @override
  State<_McpList> createState() => _McpListState();
}

class _McpListState extends State<_McpList> {
  String _type = 'stdio';
  String _name = '';
  String _target = '';

  void _add() {
    final name = _name.trim();
    final target = _target.trim();
    if (name.isEmpty || target.isEmpty) return;
    final words = target.split(RegExp(r'\s+'));
    final McpServer server = _type == 'stdio'
        ? McpServerStdio(name: name, command: words.first, args: words.sublist(1), env: const {})
        : McpServerHttp(name: name, url: target, headers: const {});
    widget.onChanged([
      for (final s in widget.value)
        if (_mcpName(s) != name) s,
      server,
    ]);
    setState(() {
      _name = '';
      _target = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final disabled = widget.disabled;
    return Opacity(
      opacity: disabled ? .5 : 1,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final s in widget.value)
            Container(
              margin: const EdgeInsets.only(bottom: 6),
              color: Palette.cream50,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Container(
                    color: Palette.cream300,
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Text(switch (s) {
                      McpServerStdio() => 'stdio',
                      McpServerHttp() => 'http',
                    }, style: KitText.xs.copyWith(color: Palette.bark600)),
                  ),
                  const SizedBox(width: 8),
                  Text(_mcpName(s), style: KitText.xs),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      switch (s) {
                        McpServerStdio(:final command, :final args) => [command, ...args].join(' '),
                        McpServerHttp(:final url) => url,
                      },
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.mono.copyWith(color: Palette.bark500),
                    ),
                  ),
                  KitTappable(
                    onTap: disabled
                        ? null
                        : () => widget.onChanged([
                            for (final x in widget.value)
                              if (_mcpName(x) != _mcpName(s)) x,
                          ]),
                    semanticLabel: '删除 ${_mcpName(s)}',
                    builder: (context, st) => Text('删除', style: KitText.xs.copyWith(color: st.hovered ? Palette.berry : Palette.bark600)),
                  ),
                ],
              ),
            ),
          Row(
            children: [
              PxSegmented<String>(
                value: _type,
                onChanged: (t) => setState(() => _type = t),
                options: const [
                  SegmentOption(value: 'stdio', label: 'stdio'),
                  SegmentOption(value: 'http', label: 'http'),
                ],
              ),
              const SizedBox(width: 6),
              Flexible(
                flex: 2,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 112),
                  child: PxTextInput(value: _name, onChanged: (v) => setState(() => _name = v), placeholder: '名字', enabled: !disabled, semanticLabel: 'MCP 名字'),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                flex: 5,
                child: PxTextInput(
                  value: _target,
                  onChanged: (v) => setState(() => _target = v),
                  placeholder: _type == 'stdio' ? 'npx -y @scope/server' : 'https://…/mcp',
                  enabled: !disabled,
                  mono: true,
                  semanticLabel: 'MCP 命令或地址',
                ),
              ),
              const SizedBox(width: 6),
              PxButton.text('添加', onPressed: disabled || _name.trim().isEmpty || _target.trim().isEmpty ? null : _add),
            ],
          ),
        ],
      ),
    );
  }
}

class _Inventory extends StatelessWidget {
  const _Inventory({required this.entries});
  final List<InventoryEntry>? entries;

  @override
  Widget build(BuildContext context) {
    final quiet = KitText.xs.copyWith(color: Palette.bark500);
    final list = entries;
    if (list == null) return Text('这个 runtime 不报告这一项。', style: quiet);
    if (list.isEmpty) return Text('没有。', style: quiet);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final e in list)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Flexible(
                  child: Text(
                    e.name,
                    style: KitText.mono.copyWith(
                      color: e.enabled == false ? Palette.bark500 : Palette.bark800,
                      decoration: e.enabled == false ? TextDecoration.lineThrough : null,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(e.description ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: quiet),
                ),
                if (e.source != null) ...[
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(e.source!, maxLines: 1, overflow: TextOverflow.ellipsis, style: quiet),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _Issues extends StatelessWidget {
  const _Issues({required this.issues});
  final List<AgentIssue> issues;

  @override
  Widget build(BuildContext context) {
    const top = BoxDecoration(
      border: Border(top: BorderSide(color: Palette.cream300)),
    );
    if (issues.isEmpty) {
      return Container(
        decoration: top,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Marked(
          'mark-check',
          top: 0,
          child: Text('配置没问题，可以派活。', style: KitText.xs.copyWith(color: Palette.leaf700)),
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
                  i.level == IssueLevel.error ? 'mark-cross' : 'mark-warn',
                  top: 4,
                  child: Text(
                    '${i.level == IssueLevel.error ? '派不出去：' : ''}${i.text}',
                    style: KitText.xs.copyWith(height: 1.625, color: i.level == IssueLevel.error ? Palette.berry : const Color(0xFFB8682A)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
