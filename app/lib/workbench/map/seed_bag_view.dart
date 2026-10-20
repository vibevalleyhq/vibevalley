import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../shared/faces.dart';
import '../../shared/seed_bag.dart';
import '../../ui/pro/pro.dart';

/// The sowing bag opened on an island's empty spot, in the pro kit; what it offers and does is shared/seed_bag.dart.
class MapSeedForm extends SeedBag {
  const MapSeedForm({super.key, required super.onDone, super.project});

  @override
  ConsumerState<MapSeedForm> createState() => _MapSeedFormState();
}

class _MapSeedFormState extends ConsumerState<MapSeedForm> with SeedBagState<MapSeedForm> {
  @override
  Widget build(BuildContext context) {
    final (:projects, :project) = whereToSow();
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
                      style: ProText.base.copyWith(fontWeight: FontWeight.w600),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (stack.isNotEmpty) ...[const SizedBox(width: 8), Text(stack, style: ProText.meta)],
                ],
              ),
            ),
            if (projects.length > 1) ProButton.text('换个项目', size: ProSize.sm, tone: ProTone.quiet, onPressed: chooseProjectAgain),
          ],
        ),
        const SizedBox(height: 12),
        ProSegmented<SeedPocket>(
          value: pocket,
          options: [
            const SegmentOption(value: SeedPocket.seeds, label: '挑种子'),
            SegmentOption(value: SeedPocket.queued, label: queued.isEmpty ? '开工待办' : '开工待办 ${queued.length}'),
          ],
          onChanged: setPocket,
        ),
        const SizedBox(height: 16),
        if (pocket == SeedPocket.queued) _queuedList(queued, project) else ..._seedBag(templates, project),
      ],
    );
  }

  Widget _queuedList(List<Issue> queued, String project) {
    if (queued.isEmpty) return Text('这个项目没有排着队的待办。院门外的种子袋就是它们。', style: ProText.sm.copyWith(color: ProColor.muted));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('排着队等空地的待办，按排上的先后；开工的是这张工单本身，不另写一张。', style: ProText.meta),
        const SizedBox(height: 8),
        for (final i in queued)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 6),
            decoration: const BoxDecoration(border: Border(bottom: proLine)),
            child: Row(
              children: [
                const SpriteIcon('icon-seeds', size: 20),
                const SizedBox(width: 8),
                Text('#${i.number.round()}', style: ProText.sm.copyWith(color: ProColor.muted)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(i.title, style: ProText.sm, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
                const SizedBox(width: 8),
                ProButton.text('开工', size: ProSize.sm, tone: ProTone.primary, onPressed: () => start(i, project)),
              ],
            ),
          ),
        if (refused case final why? when why.isNotEmpty) ...[const SizedBox(height: 8), Text(why, style: ProText.sm.copyWith(color: Palette.berry))],
      ],
    );
  }

  List<Widget> _seedBag(AsyncValue<ProjectTemplates> templates, String project) {
    final (:agents, :who) = whoSows();
    final bag = templates.value;
    final (:recent, :kinds) = seedsShown(bag, filter);
    final label = ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600);
    return [
      ProTextInput(value: filter, onChanged: setFilter, icon: 'button-filter', placeholder: '筛一筛：bug、测试、依赖……', semanticLabel: '筛种子'),
      const SizedBox(height: 12),
      if (templates.isLoading && bag == null) Text('在翻种子袋……', style: ProText.meta),
      if (templates.hasError && bag == null) Text('种子袋没拿到：${templates.error}', style: ProText.sm.copyWith(color: Palette.berry)),
      if (recent.isNotEmpty) ...[
        Text('最近', style: label),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [for (final r in recent) _SeedChip(text: r, on: text == r, onTap: () => take(r))],
        ),
        const SizedBox(height: 12),
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
                  width: 88,
                  child: Row(
                    children: [
                      SpriteIcon(kind.icon, size: 24),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          kind.name,
                          style: ProText.xs.copyWith(fontWeight: FontWeight.w500),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
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
      if (bag != null && filter.trim().isNotEmpty && recent.isEmpty && kinds.isEmpty) ...[
        Text('没有对得上的种子：在下面自己写。', style: ProText.meta),
        const SizedBox(height: 8),
      ],
      const SizedBox(height: 4),
      Text('自己写', style: label),
      const SizedBox(height: 6),
      ProTextArea(value: text, selection: selection, focusNode: words, onChanged: setText, rows: 3, placeholder: '要做什么，做到什么程度算完', semanticLabel: '工单'),
      const SizedBox(height: 16),
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
                width: 40,
                height: 40,
                decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
                alignment: Alignment.center,
                child: Text('?', style: ProText.lg.copyWith(color: ProColor.muted)),
              ),
            ),
            for (final a in agents) _WhoTile(active: who == a.id, label: a.name, onTap: () => chooseWho(a.id), child: AgentFaceOf(a.id, size: 40)),
          ],
        ),
      ),
      const SizedBox(height: 16),
      Text('管家会把这句话交给帮工，派在 $project 里；没开工的话会先开工。先起草：帮工读过代码写成工单，你看过再开工。', style: ProText.meta),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          ProButton.text('先起草', onPressed: canSow ? () => write(project, who) : null),
          const SizedBox(width: 8),
          ProButton.text('播种', tone: ProTone.primary, onPressed: canSow ? () => sow(project, who) : null),
        ],
      ),
      if (refused case final why? when why.isNotEmpty) ...[const SizedBox(height: 8), Text(why, style: ProText.sm.copyWith(color: Palette.berry))],
    ];
  }
}

class _ProjectPick extends StatelessWidget {
  const _ProjectPick({required this.projects, required this.onPick});
  final List<String> projects;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text('种在哪个项目？', style: ProText.base.copyWith(fontWeight: FontWeight.w600)),
      const SizedBox(height: 4),
      Text('这块空地还不属于哪个项目：先挑一个，种子按它的样子给。', style: ProText.meta),
      const SizedBox(height: 12),
      if (projects.isEmpty) Text('还没有项目：先在工作台的「项目」页开一个。', style: ProText.meta),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [for (final p in projects) _SeedChip(text: p, on: false, onTap: () => onPick(p))],
      ),
    ],
  );
}

/// A seed to take: a rounded chip, filled leaf once taken.
class _SeedChip extends StatelessWidget {
  const _SeedChip({required this.text, required this.on, required this.onTap});
  final String text;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: on,
    builder: (context, st) => ProFocusRing(
      on: st.focused,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        decoration: BoxDecoration(
          color: on ? ProColor.accent : (st.hovered ? ProColor.selected : ProColor.page),
          border: on ? Border.all(color: const Color(0x00000000)) : const Border.fromBorderSide(proLine),
          borderRadius: proRadius,
        ),
        child: Text(
          text,
          style: ProText.xs.copyWith(color: on ? Palette.paper : ProColor.ink, fontWeight: on ? FontWeight.w500 : null),
        ),
      ),
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
    builder: (context, s) => ProFocusRing(
      on: s.focused,
      radius: 8,
      child: Container(
        width: 64,
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(
          color: active ? ProColor.selected : (s.hovered ? ProColor.hover : null),
          borderRadius: const BorderRadius.all(Radius.circular(8)),
        ),
        child: Column(
          children: [
            child,
            const SizedBox(height: 4),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ProText.xs.copyWith(fontWeight: active ? FontWeight.w600 : null),
            ),
          ],
        ),
      ),
    ),
  );
}
