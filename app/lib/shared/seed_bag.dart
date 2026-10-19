import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../data/remote.dart' show projectNamesProvider, projectSeedsProvider;
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../data/prefs.dart';
import '../audio/sfx.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import '../rules/issues.dart' show queuedIn;
import 'faces.dart';
import 'tags.dart';

/// The sowing bag: the server's seeds for the project (project.seeds), its queued todos, or the owner's own words.
/// Both skins open it: the farm on one of its beds, the project map on an island's empty spot.
class SeedForm extends ConsumerStatefulWidget {
  const SeedForm({super.key, required this.onDone, this.station, this.project});
  final VoidCallback onDone;

  /// The farm plot it sows on; null from the map, where the server picks the plot.
  final int? station;

  /// Where it sows (the island's project). Without one: the project last sown in, the only one, or it asks first.
  final String? project;

  @override
  ConsumerState<SeedForm> createState() => _SeedFormState();
}

enum _Bag { seeds, queued }

class _SeedFormState extends ConsumerState<SeedForm> {
  String? _who;
  String? _project;
  var _choosing = false;
  var _bag = _Bag.seeds;
  var _text = '';
  TextSelection? _selection;
  var _filter = '';
  String? _refused;
  final _words = FocusNode(debugLabel: 'seed words');

  @override
  void dispose() {
    _words.dispose();
    super.dispose();
  }

  void _take(String text, [SeedBlank? blank]) {
    setState(() {
      _text = text;
      _selection = blank == null ? null : TextSelection(baseOffset: blank.start.round(), extentOffset: blank.end.round());
    });
    _words.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final known = ref.watch(projectNamesProvider);
    final projects = known.value ?? const <String>[];
    // Trusted while the list loads; dropped once the list says the project is gone.
    final last = switch (ref.watch(prefsProvider.select((p) => p.lastProject))) {
      final p? when !known.hasValue || projects.contains(p) => p,
      _ => null,
    };
    final project = _choosing ? null : _project ?? widget.project ?? last ?? (projects.length == 1 ? projects.single : null);
    final label = KitText.xs.copyWith(color: Palette.bark600);
    if (project == null) {
      return _ProjectPick(
        projects: projects,
        onPick: (p) => setState(() {
          _project = p;
          _choosing = false;
        }),
      );
    }
    final seeds = ref.watch(projectSeedsProvider(project));
    final queued = queuedIn(ref.watch(stateProvider)?.issues ?? const <Issue>[], project);
    final stack = seeds.value?.stack.label ?? '';
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
                      style: KitText.base.copyWith(color: Palette.bark900),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (stack.isNotEmpty) ...[const SizedBox(width: 8), Text(stack, style: label)],
                ],
              ),
            ),
            if (projects.length > 1) PxButton.text('换个项目', size: PxSize.sm, onPressed: () => setState(() => _choosing = true)),
          ],
        ),
        const SizedBox(height: 8),
        PxSegmented<_Bag>(
          value: _bag,
          options: [
            const SegmentOption(value: _Bag.seeds, label: '挑种子'),
            SegmentOption(value: _Bag.queued, label: queued.isEmpty ? '开工待办' : '开工待办 ${queued.length}'),
          ],
          onChanged: (b) => setState(() => _bag = b),
        ),
        const SizedBox(height: 12),
        if (_bag == _Bag.queued) _queuedList(queued, project, label) else ..._seedBag(seeds, project, label),
      ],
    );
  }

  Widget _queuedList(List<Issue> queued, String project, TextStyle label) {
    Future<void> start(Issue i) async {
      final got = await ref.read(farmCommandsProvider).startQueued(i.id, station: widget.station);
      if (!mounted) return;
      if (got.ok) {
        ref.read(prefsProvider.notifier).setLastProject(project);
        Sfx.play('plant');
        widget.onDone();
      } else {
        setState(() => _refused = got.text);
      }
    }

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
                    style: KitText.sm.copyWith(color: Palette.bark800),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 8),
                PxButton.text('开工', size: PxSize.sm, tone: PxTone.primary, onPressed: () => start(i)),
              ],
            ),
          ),
        if (_refused case final why? when why.isNotEmpty) Text(why, style: label.copyWith(color: Palette.berry)),
      ],
    );
  }

  List<Widget> _seedBag(AsyncValue<ProjectSeeds> seeds, String project, TextStyle label) {
    final agents = (ref.watch(agentsProvider).value ?? const <String, Agent>{}).values.where((a) => a.enabled).toList();
    final pick = ref.watch(prefsProvider.select((p) => p.pick));
    final who = _who ?? (agents.any((a) => a.id == pick) ? pick : 'auto');
    void sow() {
      if (_text.trim().isEmpty) return;
      Sfx.play('plant');
      ref.read(prefsProvider.notifier).setLastProject(project);
      fire(ref.read(farmCommandsProvider).plant(_text, station: widget.station, agent: who == 'auto' ? null : who, project: project));
      widget.onDone();
    }

    // Not sown now: the words become an issue in the backlog, a helper drafts it, and its detail opens on the board.
    Future<void> write() async {
      if (_text.trim().isEmpty) return;
      final router = GoRouter.maybeOf(context);
      try {
        final got = await writeIssue(ref.read(apiProvider).issue, text: _text, project: project, agent: who == 'auto' ? null : who);
        if (got.refused.isNotEmpty) toasts.add(type: ToastType.info, title: '先没起草', description: got.refused);
        ref.read(prefsProvider.notifier).setLastProject(project);
        widget.onDone();
        router?.go('/issues/${Uri.encodeComponent(got.issue.id)}');
      } on Object catch (e) {
        if (mounted) setState(() => _refused = e is VibeValleyApiError ? e.reason : '$e');
      }
    }

    final q = _filter.trim().toLowerCase();
    bool shown(String title) => q.isEmpty || title.toLowerCase().contains(q);
    final bag = seeds.value;
    final recent = [
      for (final r in bag?.recent ?? const <String>[])
        if (shown(r)) r,
    ];
    final kinds = [
      for (final k in bag?.kinds ?? const <SeedKind>[])
        if (k.seeds.where((s) => shown(s.title) || shown(k.name)).toList() case final rows when rows.isNotEmpty) (kind: k, seeds: rows),
    ];
    return [
      PxTextInput(value: _filter, onChanged: (v) => setState(() => _filter = v), icon: 'button-filter', placeholder: '筛一筛：bug、测试、依赖……', semanticLabel: '筛种子'),
      const SizedBox(height: 10),
      if (seeds.isLoading && bag == null) Text('在翻种子袋……', style: label),
      if (seeds.hasError && bag == null) Text('种子袋没拿到：${seeds.error}', style: label.copyWith(color: Palette.berry)),
      if (recent.isNotEmpty) ...[
        Text('最近', style: label),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [for (final r in recent) _SeedChip(text: r, on: _text == r, onTap: () => _take(r))],
        ),
        const SizedBox(height: 10),
      ],
      if (kinds.isNotEmpty) ...[
        Text('常见的活', style: label),
        const SizedBox(height: 6),
        for (final (:kind, :seeds) in kinds)
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
                      Text(kind.name, style: KitText.xs.copyWith(color: Palette.bark800)),
                    ],
                  ),
                ),
                Expanded(
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final s in seeds) _SeedChip(text: s.title, on: _text == s.text, onTap: () => _take(s.text, s.blank))],
                  ),
                ),
              ],
            ),
          ),
      ],
      if (bag != null && q.isNotEmpty && recent.isEmpty && kinds.isEmpty) ...[Text('没有对得上的种子：在下面自己写。', style: label), const SizedBox(height: 8)],
      const SizedBox(height: 4),
      Text('自己写', style: label),
      const SizedBox(height: 6),
      PxTextArea(
        value: _text,
        selection: _selection,
        focusNode: _words,
        onChanged: (v) => setState(() => _text = v),
        rows: 3,
        placeholder: '要做什么，做到什么程度算完',
        semanticLabel: '工单',
      ),
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
              active: who == 'auto',
              label: '管家挑',
              onTap: () => setState(() => _who = 'auto'),
              child: Container(
                width: 44,
                height: 44,
                color: Palette.cream200,
                alignment: Alignment.center,
                child: Text('?', style: KitText.lg.copyWith(color: Palette.bark600)),
              ),
            ),
            for (final a in agents) _WhoTile(active: who == a.id, label: a.name, onTap: () => setState(() => _who = a.id), child: AgentFaceOf(a.id, size: 44)),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Row(
        children: [
          Expanded(child: Text('管家会把这句话交给帮工，派在 $project 里；没开工的话会先开工。先起草：帮工读过代码写成工单，你看过再开工。', style: label)),
          const SizedBox(width: 8),
          PxButton.text('先起草', onPressed: _text.trim().isEmpty ? null : write),
          const SizedBox(width: 8),
          PxButton.text('播种', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : sow),
        ],
      ),
      if (_refused case final why? when why.isNotEmpty) ...[const SizedBox(height: 6), Text(why, style: label.copyWith(color: Palette.berry))],
    ];
  }
}

class _ProjectPick extends StatelessWidget {
  const _ProjectPick({required this.projects, required this.onPick});
  final List<String> projects;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final label = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('种在哪个项目？', style: KitText.base.copyWith(color: Palette.bark900)),
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
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    selected: on,
    builder: (context, st) => Container(
      color: on ? Palette.leaf500 : (st.hovered ? Palette.cream300 : Palette.cream200),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Text(text, style: KitText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
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
  Widget build(BuildContext context) => KitTappable(
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
            style: KitText.xs.copyWith(color: Palette.bark800),
          ),
        ],
      ),
    ),
  );
}
