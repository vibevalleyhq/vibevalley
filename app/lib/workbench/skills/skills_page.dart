import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../shared/faces.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import '../../rules/seeds.dart';

const _installed = 'installed:';

String _skillPath([String? id]) => id == null ? '/skills' : '/skills/${Uri.encodeComponent(id)}';

bool _matches(String query, List<String?> texts) {
  final hay = texts.whereType<String>().join('\n').toLowerCase();
  return query.toLowerCase().split(RegExp(r'\s+')).every(hay.contains);
}

class SkillsPage extends ConsumerStatefulWidget {
  const SkillsPage({super.key, this.id});
  final String? id;

  @override
  ConsumerState<SkillsPage> createState() => _SkillsPageState();
}

class _SkillsPageState extends ConsumerState<SkillsPage> {
  String _query = '';

  @override
  void initState() {
    super.initState();
    ref.invalidate(runtimeCatalogProvider);
    Future.microtask(() => ref.read(workbenchConfigProvider.notifier).refresh());
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(workbenchConfigProvider);
    if (config.error != null) return const ConfigProblem();
    final skills = config.skills;
    final runtimeState = ref.watch(runtimesProvider);
    final installed = installedSkills(runtimeState.value ?? const []);
    final id = widget.id;
    final shownInstalled = id != null && id.startsWith(_installed) ? installed.where((s) => s.name == id.substring(_installed.length)).firstOrNull : null;
    final creating = id == 'new';
    final selected = creating || shownInstalled != null
        ? null
        : (skills.where((s) => s.id == id).firstOrNull ?? (installed.isNotEmpty ? null : skills.firstOrNull));
    final first = id == null ? installed.firstOrNull : null;
    final q = _query.trim();
    final shownList = q.isEmpty
        ? installed
        : installed.where((s) => _matches(q, [s.name, s.description, ...s.runtimes.map((x) => runtimeName(x.runtime))])).toList();
    final shownSkills = q.isEmpty ? skills : skills.where((s) => _matches(q, [s.name, s.description, s.body])).toList();
    final small = KitText.xs.copyWith(color: Palette.bark500);

    Widget entry({required bool on, required String path, required String title, required String detail, required double vertical}) => KitTappable(
      onTap: () => workbenchGo(context, path),
      selected: on,
      semanticLabel: title,
      builder: (context, s) => Container(
        padding: EdgeInsets.symmetric(horizontal: 12, vertical: vertical),
        color: on ? Palette.leaf300.withValues(alpha: .6) : (s.hovered ? Palette.cream200 : null),
        foregroundDecoration: pxRing,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
            Text(
              detail,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: KitText.fine.copyWith(color: Palette.bark500),
            ),
          ],
        ),
      ),
    );

    final listColumn = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (runtimeState.hasError) const RuntimeProblem(),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
          child: Text(
            '这台电脑上装的 · ${q.isNotEmpty ? '${shownList.length} / ${installed.length}' : installed.length}',
            style: KitText.xs.copyWith(color: Palette.bark600),
          ),
        ),
        if (installed.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Text('农机还没报告装了哪些技能（或者还在读）。', style: small),
          ),
        if (installed.isNotEmpty && shownList.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Text('没有对得上的。', style: small),
          ),
        for (final s in shownList)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: entry(
              on: shownInstalled?.name == s.name || first?.name == s.name,
              path: _skillPath('$_installed${s.name}'),
              title: s.name,
              detail: s.runtimes.map((x) => runtimeName(x.runtime)).join('、'),
              vertical: 6,
            ),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 16, 8, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'VibeValley 自己的 · ${q.isNotEmpty ? '${shownSkills.length} / ${skills.length}' : skills.length}',
                  style: KitText.xs.copyWith(color: Palette.bark600),
                ),
              ),
              PxButton.text('新技能', tone: PxTone.primary, size: PxSize.sm, onPressed: () => workbenchGo(context, _skillPath('new'))),
            ],
          ),
        ),
        for (final s in shownSkills)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: entry(on: !creating && selected?.id == s.id, path: _skillPath(s.id), title: s.name, detail: s.description, vertical: 8),
          ),
      ],
    );
    Widget nav({required bool bounded}) => PxWindow(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(8, 4, 8, 8),
            child: Text('技能书', style: KitText.xl),
          ),
          PxTextInput(value: _query, onChanged: (v) => setState(() => _query = v), placeholder: '搜名字、说明、农机……', semanticLabel: '搜索技能', icon: 'button-search'),
          if (bounded) Flexible(child: SingleChildScrollView(child: listColumn)) else listColumn,
        ],
      ),
    );

    final Widget main;
    if (creating) {
      main = const _SkillEditor(key: ValueKey('new'));
    } else if ((shownInstalled ?? first) case final s?) {
      main = _InstalledCard(skill: s);
    } else if (selected != null) {
      main = _SkillEditor(key: ValueKey(selected.id), skill: selected);
    } else {
      main = Padding(
        padding: const EdgeInsets.all(32),
        child: Text('还没有技能。', style: KitText.sm.copyWith(color: Palette.bark500)),
      );
    }

    return LayoutBuilder(
      builder: (context, box) {
        if (box.maxWidth >= 1024) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 288,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height - 112),
                    child: nav(bounded: true),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: SingleChildScrollView(padding: const EdgeInsets.only(bottom: 6), child: main),
                ),
              ],
            ),
          );
        }
        return Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: PxScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [nav(bounded: false), const SizedBox(height: 12), main]),
          ),
        );
      },
    );
  }
}

Widget _sheet(Widget child) => Center(
  child: ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: 768),
    child: PxWindow(padding: const EdgeInsets.all(24), child: child),
  ),
);

/// Read-only: it lives with the runtime.
class _InstalledCard extends StatelessWidget {
  const _InstalledCard({required this.skill});
  final InstalledSkill skill;

  @override
  Widget build(BuildContext context) => _sheet(
    Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(skill.name, style: KitText.xl),
        const SizedBox(height: 4),
        Text('装在农机上的技能：用这些农机的帮工会自己按需加载，不用在档案里勾。要改它，去它的文件里改。', style: KitText.xs.copyWith(color: Palette.bark500)),
        if ((skill.description ?? '').isNotEmpty) ...[
          const SizedBox(height: 16),
          SelectableText(skill.description!, style: KitText.sm.copyWith(height: 1.625, color: Palette.bark800)),
        ],
        const SizedBox(height: 16),
        Text('哪些农机有它', style: KitText.xs.copyWith(color: Palette.bark600)),
        const SizedBox(height: 8),
        for (final x in skill.runtimes)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            color: Palette.cream100,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                RuntimeIcon(runtime: x.runtime, size: 28),
                const SizedBox(width: 10),
                SizedBox(width: 80, child: Text(runtimeName(x.runtime), style: KitText.sm)),
                Expanded(
                  child: Tooltip(
                    message: x.source ?? '',
                    child: Text(
                      x.source ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.mono.copyWith(color: Palette.bark500),
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    ),
  );
}

class _SkillEditor extends ConsumerStatefulWidget {
  const _SkillEditor({super.key, this.skill});

  final Skill? skill;

  @override
  ConsumerState<_SkillEditor> createState() => _SkillEditorState();
}

class _SkillEditorState extends ConsumerState<_SkillEditor> {
  late Skill _draft = widget.skill ?? const Skill(id: '', name: '', description: '', body: '');
  bool _sure = false;

  @override
  void didUpdateWidget(_SkillEditor old) {
    super.didUpdateWidget(old);
    final skill = widget.skill;
    if (skill != null && jsonEncode(skill.toJson()) != jsonEncode(old.skill?.toJson())) _draft = skill;
  }

  Skill _with({String? name, String? description, String? body}) =>
      Skill(id: _draft.id, name: name ?? _draft.name, description: description ?? _draft.description, body: body ?? _draft.body);

  Future<void> _save() async {
    final saved = await runAction(() => ref.read(workbenchConfigProvider.notifier).saveSkill(_with(name: _draft.name.trim())));
    if (saved != null && widget.skill == null && mounted) workbenchGo(context, _skillPath(saved.id));
  }

  Future<void> _delete(Skill skill) async {
    final done = await runAction(() async {
      await ref.read(workbenchConfigProvider.notifier).deleteSkill(skill.id);
      return true;
    });
    if (done == true && mounted) workbenchGo(context, _skillPath());
  }

  @override
  Widget build(BuildContext context) {
    final skill = widget.skill;
    final agents = ref.watch(workbenchConfigProvider.select((c) => c.agents));
    final draft = _draft;
    final dirty = skill == null || jsonEncode(skill.toJson()) != jsonEncode(draft.toJson());
    final users = skill == null ? const <Agent>[] : agents.where((a) => a.skills.contains(skill.id)).toList();
    return _sheet(
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              Text(draft.name.isEmpty ? '新技能' : draft.name, style: KitText.xl),
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (skill != null)
                    if (_sure) ...[
                      Text(users.isNotEmpty ? '${users.length} 个 agent 在用，删掉会从它们身上去掉。' : '删掉？', style: KitText.xs.copyWith(color: Palette.bark600)),
                      PxButton.text('删除', tone: PxTone.danger, onPressed: () => _delete(skill)),
                      PxButton.text('算了', onPressed: () => setState(() => _sure = false)),
                    ] else
                      PxButton.text('删除', onPressed: () => setState(() => _sure = true)),
                  PxButton.text('保存', tone: PxTone.primary, onPressed: !dirty || draft.name.trim().isEmpty || draft.body.trim().isEmpty ? null : _save),
                ],
              ),
            ],
          ),
          const SizedBox(height: 16),
          PxField(
            label: '名字',
            child: PxTextInput(
              value: draft.name,
              onChanged: (name) => setState(() => _draft = _with(name: name)),
              placeholder: '比如：先写测试',
              semanticLabel: '技能名字',
            ),
          ),
          const SizedBox(height: 16),
          PxField(
            label: '什么时候用',
            hint: const Text('一句话。按需加载技能的 runtime 先读这句，再决定要不要读正文。'),
            child: PxTextInput(
              value: draft.description,
              onChanged: (description) => setState(() => _draft = _with(description: description)),
              placeholder: '改行为之前，先补一个会失败的测试。',
              semanticLabel: '技能说明',
            ),
          ),
          const SizedBox(height: 16),
          PxField(
            label: '正文',
            hint: const Text('写成给 agent 看的指令（SKILL.md 的正文）。'),
            child: PxTextArea(
              value: draft.body,
              onChanged: (body) => setState(() => _draft = _with(body: body)),
              rows: 14,
              placeholder: '改任何行为之前，先写一个能复现问题的测试……',
              semanticLabel: '正文',
            ),
          ),
          const SizedBox(height: 16),
          PxField(
            label: '谁在用',
            child: users.isEmpty
                ? Text('还没有 agent 带这个技能。到 agent 的「技能」页签里勾上。', style: KitText.xs.copyWith(color: Palette.bark500))
                : Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final a in users)
                        KitTappable(
                          onTap: () => workbenchGo(context, '/agents/${Uri.encodeComponent(a.id)}'),
                          semanticLabel: a.name,
                          builder: (context, s) => Container(
                            color: s.hovered ? Palette.cream300 : Palette.cream200,
                            padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                AgentFace(look: a.look, id: a.id, size: 26),
                                const SizedBox(width: 6),
                                Text(a.name, style: KitText.sm.copyWith(color: Palette.bark800)),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
