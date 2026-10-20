import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../gen/vibevalley.dart';
import '../shared/faces.dart';
import '../shared/seed_bag.dart';
import '../shared/tags.dart';
import '../ui/pixel/pixel.dart';

/// The sowing bag on one of the farm's beds, in the pixel kit; what it offers and does is shared/seed_bag.dart.
class SeedForm extends SeedBag {
  const SeedForm({super.key, required super.onDone, super.station, super.project});

  @override
  ConsumerState<SeedForm> createState() => _SeedFormState();
}

class _SeedFormState extends ConsumerState<SeedForm> with SeedBagState<SeedForm> {
  @override
  Widget build(BuildContext context) {
    final (:projects, :project) = whereToSow();
    final label = PxText.xs.copyWith(color: Palette.bark600);
    if (project == null) return _ProjectPick(projects: projects, onPick: pickProject);
    final templates = templatesOf(project);
    final queued = queuedOf(project);
    final stack = templates.value?.stack.label ?? '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      '种在 $project',
                      style: PxText.base.copyWith(color: Palette.bark900),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (stack.isNotEmpty) ...[const SizedBox(width: 8), Text(stack, style: label)],
                ],
              ),
            ),
            if (projects.length > 1) PxButton.text('换个项目', size: PxSize.sm, onPressed: chooseProjectAgain),
          ],
        ),
        const SizedBox(height: 8),
        PxSegmented<SeedPocket>(
          value: pocket,
          options: [
            const SegmentOption(value: SeedPocket.seeds, label: '挑种子'),
            SegmentOption(value: SeedPocket.queued, label: queued.isEmpty ? '开工待办' : '开工待办 ${queued.length}'),
          ],
          onChanged: setPocket,
        ),
        const SizedBox(height: 12),
        if (pocket == SeedPocket.queued) _queuedList(queued, project, label) else ..._seedBag(templates, project, label),
      ],
    );
  }

  Widget _queuedList(List<Issue> queued, String project, TextStyle label) {
    if (queued.isEmpty) return Text('这个项目没有排着队的待办。院门外的种子袋就是它们。', style: label);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('排着队等空地的待办，按排上的先后；开工的是这张工单本身，不另写一张。', style: label),
        const SizedBox(height: 8),
        for (final i in queued)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                const SpriteIcon('icon-seeds', size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '#${i.number.round()} ${i.title}',
                    style: PxText.sm.copyWith(color: Palette.bark800),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                PxButton.text('开工', size: PxSize.sm, tone: PxTone.primary, onPressed: () => start(i, project)),
              ],
            ),
          ),
        if (refused case final why? when why.isNotEmpty) Text(why, style: label.copyWith(color: Palette.berry)),
      ],
    );
  }

  List<Widget> _seedBag(AsyncValue<ProjectTemplates> templates, String project, TextStyle label) {
    final (:agents, :who) = whoSows();
    final bag = templates.value;
    final (:recent, :kinds) = seedsShown(bag, filter);
    return [
      PxTextInput(value: filter, onChanged: setFilter, icon: 'button-filter', placeholder: '筛一筛：bug、测试、依赖……', semanticLabel: '筛种子'),
      const SizedBox(height: 10),
      if (templates.isLoading && bag == null) Text('在翻种子袋……', style: label),
      if (templates.hasError && bag == null) Text('种子袋没拿到：${templates.error}', style: label.copyWith(color: Palette.berry)),
      if (recent.isNotEmpty) ...[
        Text('最近', style: label),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [for (final r in recent) _SeedChip(text: r, on: text == r, onTap: () => take(r))],
        ),
        const SizedBox(height: 10),
      ],
      if (kinds.isNotEmpty) ...[
        Text('常见的活', style: label),
        const SizedBox(height: 6),
        for (final (:kind, :templates) in kinds)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 80,
                  child: Row(
                    children: [
                      SpriteIcon(kind.icon, size: 28),
                      const SizedBox(width: 4),
                      Text(kind.name, style: PxText.xs.copyWith(color: Palette.bark800)),
                    ],
                  ),
                ),
                Expanded(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final s in templates) _SeedChip(text: s.title, on: text == s.text, onTap: () => take(s.text, s.blank))],
                  ),
                ),
              ],
            ),
          ),
      ],
      if (bag != null && filter.trim().isNotEmpty && recent.isEmpty && kinds.isEmpty) ...[Text('没有对得上的种子：在下面自己写。', style: label), const SizedBox(height: 8)],
      const SizedBox(height: 4),
      Text('自己写', style: label),
      const SizedBox(height: 6),
      PxTextArea(value: text, selection: selection, focusNode: words, onChanged: setText, rows: 3, placeholder: '要做什么，做到什么程度算完', semanticLabel: '工单'),
      const SizedBox(height: 12),
      Text('谁来种', style: label),
      const SizedBox(height: 6),
      Semantics(
        label: '谁来种',
        child: Wrap(
          spacing: 4,
          runSpacing: 4,
          children: [
            _WhoTile(
              active: who == seedByManager,
              label: '管家挑',
              onTap: () => chooseWho(seedByManager),
              child: Container(
                width: 44,
                height: 44,
                color: Palette.cream200,
                alignment: Alignment.center,
                child: Text('?', style: PxText.lg.copyWith(color: Palette.bark600)),
              ),
            ),
            for (final a in agents) _WhoTile(active: who == a.id, label: a.name, onTap: () => chooseWho(a.id), child: AgentFaceOf(a.id, size: 44)),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Row(
        children: [
          Expanded(child: Text('管家会把这句话交给帮工，派在 $project 里；没开工的话会先开工。先起草：帮工读过代码写成工单，你看过再开工。', style: label)),
          const SizedBox(width: 8),
          PxButton.text('先起草', onPressed: canSow ? () => write(project, who) : null),
          const SizedBox(width: 8),
          PxButton.text('播种', tone: PxTone.primary, onPressed: canSow ? () => sow(project, who) : null),
        ],
      ),
      if (refused case final why? when why.isNotEmpty) ...[const SizedBox(height: 6), Text(why, style: label.copyWith(color: Palette.berry))],
    ];
  }
}

class _ProjectPick extends StatelessWidget {
  const _ProjectPick({required this.projects, required this.onPick});
  final List<String> projects;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final label = PxText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('种在哪个项目？', style: PxText.base.copyWith(color: Palette.bark900)),
        const SizedBox(height: 4),
        Text('这块空地还不属于哪个项目：先挑一个，种子按它的样子给。', style: label),
        const SizedBox(height: 10),
        if (projects.isEmpty) Text('还没有项目：先在工作台的「项目」页开一个。', style: label),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [for (final p in projects) _SeedChip(text: p, on: false, onTap: () => onPick(p))],
        ),
      ],
    );
  }
}

class _SeedChip extends StatelessWidget {
  const _SeedChip({required this.text, required this.on, required this.onTap});
  final String text;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: on,
    builder: (context, st) => Container(
      color: on ? Palette.leaf500 : (st.hovered ? Palette.cream300 : Palette.cream200),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Text(text, style: PxText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
    ),
  );
}

class _WhoTile extends StatelessWidget {
  const _WhoTile({required this.active, required this.label, required this.onTap, required this.child});
  final bool active;
  final String label;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: active,
    semanticLabel: label,
    builder: (context, s) => Container(
      width: 64,
      color: active ? tint(Palette.leaf300, .7) : (s.hovered ? Palette.cream200 : null),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          child,
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: PxText.xs.copyWith(color: Palette.bark800),
          ),
        ],
      ),
    ),
  );
}
