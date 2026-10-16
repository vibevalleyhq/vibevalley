// The farm's panels (web/src/farm/Panels.tsx): a bed's details with its work steps, the seed bag, the watering can,
// the harvest review, and what things in the yard open: the warehouse, the tasks, the log, the shop, the manager's
// looks and the plan board; and the game menu. Each is open while its state says so (game/state.dart), as on the web
// page, and drawn over the farm in the farm dialog's frame.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../desk/chat/chat_state.dart' show chatActionsProvider, chatOpenProvider;
import '../desk/shared/state.dart' show projectNamesProvider, workStepsProvider;
import '../desk/shared/work_log.dart' show WorkLog;
import '../game/commands.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../shell/sfx.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider;
import '../village/world.dart' show lookOf;
import 'achievements.dart';
import 'bits.dart';
import 'harvest.dart';
import 'menu.dart';
import 'plans.dart';
import '../rules/chat.dart';
import '../rules/tickets.dart' show ticketTitle;
import '../rules/warehouse.dart';
import '../rules/farm.dart';
import '../rules/index.dart';
import '../rules/looks.dart';
import '../rules/playbook.dart';
import '../rules/seeds.dart';

/// Every panel and dialog of the farm, each over the farm while open.
class FarmPanels extends ConsumerWidget {
  const FarmPanels({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final helpers = ref.watch(farmProvider.select((s) => s?.helpers)) ?? const <Helper>[];
    Helper? byId(String? id) => id == null ? null : helpers.where((h) => h.id == id).firstOrNull;
    final selected = byId(ref.watch(selectedProvider));
    final reviewing = byId(ref.watch(reviewingProvider));
    final sowing = ref.watch(sowingProvider);
    final watering = byId(ref.watch(wateringProvider));
    final panel = ref.watch(panelProvider);
    final menu = ref.watch(menuOpenProvider);
    return Stack(
      children: [
        if (selected != null)
          FarmLayer(
            key: const ValueKey('plot'),
            title: '${selected.name}的地',
            size: FarmDialogSize.lg,
            onClose: () => ref.read(selectedProvider.notifier).set(null),
            child: PlotDetail(worker: selected, onDone: () => ref.read(selectedProvider.notifier).set(null)),
          ),
        if (reviewing != null)
          FarmLayer(
            key: const ValueKey('harvest'),
            title: '收获${reviewing.name}的地',
            icon: 'icon-harvest',
            size: FarmDialogSize.lg,
            onClose: () => ref.read(reviewingProvider.notifier).set(null),
            child: HarvestReview(key: ValueKey(reviewing.id), worker: reviewing, onDone: () => ref.read(reviewingProvider.notifier).set(null)),
          ),
        if (sowing != null)
          FarmLayer(
            key: const ValueKey('sow'),
            title: '播种 · 第 ${sowing + 1} 块地',
            icon: 'icon-harvest',
            size: FarmDialogSize.md,
            onClose: () => ref.read(sowingProvider.notifier).set(null),
            child: SeedForm(station: sowing, onDone: () => ref.read(sowingProvider.notifier).set(null)),
          ),
        if (watering != null)
          FarmLayer(
            key: const ValueKey('water'),
            title: '给${watering.name}浇水',
            icon: 'icon-water',
            size: FarmDialogSize.sm,
            onClose: () => ref.read(wateringProvider.notifier).set(null),
            child: WaterForm(worker: watering, onDone: () => ref.read(wateringProvider.notifier).set(null)),
          ),
        if (panel != null)
          FarmLayer(
            key: ValueKey('panel-${panel.name}'),
            title: _panelTitle[panel]!.$1,
            icon: _panelTitle[panel]!.$2,
            size: panel == FarmPanel.shop
                ? FarmDialogSize.sm
                : panel == FarmPanel.manager
                ? FarmDialogSize.md
                : FarmDialogSize.lg,
            onClose: () => ref.read(panelProvider.notifier).set(null),
            child: switch (panel) {
              FarmPanel.warehouse => const Warehouse(),
              FarmPanel.tasks => const Tasks(),
              FarmPanel.log => const FarmLog(),
              FarmPanel.shop => const Shop(),
              FarmPanel.manager => const ManagerLooks(),
              FarmPanel.plans => const Plans(),
            },
          ),
        if (menu)
          FarmLayer(
            key: const ValueKey('menu'),
            title: '菜单',
            icon: 'icon-wrench',
            size: FarmDialogSize.md,
            onClose: () => ref.read(menuOpenProvider.notifier).set(false),
            child: const GameMenu(),
          ),
      ],
    );
  }
}

const _panelTitle = {
  FarmPanel.shop: ('商店', 'icon-shop'),
  FarmPanel.warehouse: ('仓库', 'icon-crate'),
  FarmPanel.tasks: ('任务与成就', 'icon-tasks'),
  FarmPanel.log: ('农场日志', 'icon-log'),
  FarmPanel.manager: ('管家和宠物', 'manager-face'),
  FarmPanel.plans: ('种植计划', 'machine-seeder'),
};

/// A farm dialog over the farm: the backdrop (bark at 30%, a click on it closes), the card fading and growing in.
class FarmLayer extends StatefulWidget {
  const FarmLayer({super.key, required this.title, required this.size, required this.onClose, required this.child, this.icon});
  final String title;
  final FarmDialogSize size;
  final VoidCallback onClose;
  final Widget child;
  final String? icon;

  @override
  State<FarmLayer> createState() => _FarmLayerState();
}

class _FarmLayerState extends State<FarmLayer> {
  // The dialog takes the keyboard as it opens, so Esc reaches it (a modal route's focus, as the web page's dialog).
  final _scope = FocusScopeNode(debugLabel: 'farm dialog');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scope.requestFocus();
    });
  }

  @override
  void dispose() {
    _scope.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Positioned.fill(
    child: CallbackShortcuts(
      bindings: {const SingleActivator(LogicalKeyboardKey.escape): widget.onClose},
      child: FocusScope(
        node: _scope,
        // The backdrop fades in; the card fades and grows from 95% (only the card: the backdrop always covers the farm).
        child: TweenAnimationBuilder<double>(
          tween: Tween(begin: 0, end: 1),
          duration: const Duration(milliseconds: 150),
          builder: (context, t, _) => Opacity(
            opacity: t,
            child: Stack(
              children: [
                Positioned.fill(
                  child: Semantics(
                    label: '关上',
                    button: true,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: widget.onClose,
                      child: ColoredBox(color: Palette.bark900.withValues(alpha: .3)),
                    ),
                  ),
                ),
                Transform.scale(
                  scale: .95 + .05 * t,
                  child: Semantics(
                    scopesRoute: true,
                    namesRoute: true,
                    explicitChildNodes: true,
                    label: widget.title,
                    child: FarmDialog(title: Text(widget.title), size: widget.size, icon: widget.icon, onClose: widget.onClose, child: widget.child),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

// ── 田地详情 ──────────────────────────────────────────────────────────────────

class PlotDetail extends ConsumerStatefulWidget {
  const PlotDetail({super.key, required this.worker, required this.onDone});
  final Helper worker;
  final VoidCallback onDone;

  @override
  ConsumerState<PlotDetail> createState() => _PlotDetailState();
}

class _PlotDetailState extends ConsumerState<PlotDetail> {
  var _text = '';

  @override
  void initState() {
    super.initState();
    // The server keeps every step: loaded in full when the panel opens, kept up by step events.
    ref.read(workStepsProvider.notifier).load(widget.worker.id).then((_) {}, onError: (Object _) {});
  }

  void _send() {
    if (_text.trim().isEmpty) return;
    fire(ref.read(farmCommandsProvider).water(widget.worker, _text));
    setState(() => _text = '');
  }

  @override
  Widget build(BuildContext context) {
    final worker = widget.worker;
    final atlas = ref.watch(atlasProvider).value;
    final agent = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{})[worker.agent];
    final view = ref.watch(viewProvider);
    final plot = view == null ? const PlotView(crop: Crop.empty) : plotOf(view, worker);
    final cast = castOf(agent?.look, worker.agent);
    final log = ref.watch(workStepsProvider.select((all) => all[worker.id]));
    final hasThread = ref.watch(farmProvider.select((s) => jobThreadOf(s?.chat, worker.id)?.id));
    final station = stationOfHelper(worker);
    final working = isBusy(worker);
    final current = doingOf(worker);
    final need = needOf(worker);
    final conflict = need is NeedConflict ? need.conflict : null;
    final play = worker.play;
    final history = (play?.history ?? const <ActionStep>[]);
    final steps = history.sublist(history.length > 12 ? history.length - 12 : 0).reversed.toList();
    final commands = ref.read(farmCommandsProvider);
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    final aside = Container(
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
                if (atlas != null) _Sprite(atlas['${lookOf(agent, worker.agent, atlas.has)}-down'], height: 144),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(cropLabel[plot.crop]!, style: KitText.sm),
          Text('${speciesLabel[cast.species]} · ${outfitLabel[cast.outfit]} · ${runtimeName(worker.runtime)}', textAlign: TextAlign.center, style: xs),
          if (agent != null && agent.model.isNotEmpty) Text(agent.model, style: xs),
          Text('第 ${station + 1} 块地 · 第 ${worker.turns.round()} 轮', style: xs),
          if (worker.spent != null) Text('花了 ${spentText(worker.spent!)}', style: xs),
          const SizedBox(height: 8),
          _Link('看${agent?.name ?? '它'}的档案', onTap: () => context.go('/agents/${Uri.encodeComponent(worker.agent)}')),
        ],
      ),
    );
    final main = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (worker.project != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Tinted(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      KitTappable(
                        onTap: () => context.go('/projects/${Uri.encodeComponent(worker.project!)}'),
                        tooltip: '看这个项目：种了什么、一年的耕作日历',
                        builder: (context, s) => FarmTag(
                          '项目 ${worker.project}',
                          fill: s.hovered ? const Color(0xFFB6844E) : const Color(0xFFA5743F),
                          ink: Palette.cream50,
                          goes: true,
                        ),
                      ),
                      if (worker.branch != null) FarmTag(worker.branch!, ink: Palette.bark800),
                      Text('收获时这条分支会合进项目', style: KitText.xs.copyWith(color: Palette.bark400)),
                      KitTappable(
                        onTap: () => context.go('/tickets/${Uri.encodeComponent(worker.id)}'),
                        tooltip: '这块地上的这次种植，在工单看板上：几轮、用时、改动',
                        builder: (context, s) => FarmTag('在看板上看', fill: s.hovered ? Palette.cream300 : Palette.cream200, ink: Palette.bark800, goes: true),
                      ),
                    ],
                  ),
                  if (worker.worktree != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(
                        children: [
                          Text('worktree', style: xs),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Tooltip(
                              message: worker.worktree!,
                              child: Text(
                                worker.worktree!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: KitText.mono.copyWith(color: Palette.bark800),
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          KitTappable(
                            onTap: () => Clipboard.setData(ClipboardData(text: worker.worktree ?? '')),
                            builder: (context, s) =>
                                FarmTag('复制路径', fill: s.hovered ? Palette.cream300 : Palette.cream200, ink: Palette.bark800, icon: 'button-copy'),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        if (worker.playbook != null) PlanLine(worker: worker, onDone: widget.onDone),
        Text(worker.task, style: KitText.sm),
        if (current.action != WorkerAction.none)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.leaf300, .4),
              child: Row(
                children: [
                  ActionGlyph(current.action, size: 22),
                  const SizedBox(width: 8),
                  Text('正在${actionMeaning[current.action]}', style: KitText.sm),
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
        if (need is NeedQuiet || need is NeedRetrying)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.water, .15),
              child: Ticking(
                builder: (context, now) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(phaseText(worker, now), style: KitText.sm),
                    if (need is NeedQuiet) Text('可能在跑很久的命令，也可能卡住了：看看下面的干活过程，不对就叫停。', style: xs),
                  ],
                ),
              ),
            ),
          ),
        if (conflict != null && !working)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: tint(Palette.berry, .12),
              child: Row(
                children: [
                  Expanded(
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: '合进 ${conflict.base} 会冲突：',
                            style: const TextStyle(color: Palette.berry),
                          ),
                          TextSpan(text: conflict.files.join('、'), style: KitText.mono),
                        ],
                      ),
                      style: KitText.sm,
                    ),
                  ),
                  const SizedBox(width: 8),
                  PxButton.text('让它解决冲突', tone: PxTone.danger, onPressed: () => fire(commands.water(worker, conflictTask(conflict.base, conflict.files)))),
                ],
              ),
            ),
          ),
        if (worker.last != null && !working)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tinted(
              color: worker.last!.outcome == Outcome.failed ? tint(Palette.berry, .12) : tint(Palette.wheat, .2),
              child: Text(
                '${outcomeLabel[worker.last!.outcome]}：${worker.last!.summary}',
                style: KitText.sm.copyWith(color: worker.last!.outcome == Outcome.failed ? Palette.berry : Palette.bark900),
              ),
            ),
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (plot.crop == Crop.withered) PxButton.text('杀虫：接着修', tone: PxTone.danger, onPressed: () => fire(commands.cure(worker))),
            if (canHarvest(worker) && worker.playbook == null)
              PxButton.text(
                '收获…',
                tone: PxTone.primary,
                onPressed: () {
                  // Look at what it would merge first.
                  ref.read(reviewingProvider.notifier).set(worker.id);
                  widget.onDone();
                },
              ),
            if (worker.phase is PhaseWorking) PxButton.text('叫停', onPressed: () => fire(commands.stop(worker.id))),
            if (hasThread != null)
              PxButton.text(
                '看工单串',
                onPressed: () {
                  // In the farm's chat window, opened.
                  fire(ref.read(chatActionsProvider).showJobThread(worker.id));
                  ref.read(chatOpenProvider.notifier).set(true);
                  widget.onDone();
                },
              ),
            PxButton.text(
              '请它收工',
              onPressed: () {
                fire(commands.dismiss(worker.id));
                widget.onDone();
              },
            ),
          ],
        ),
        const SizedBox(height: 12),
        Container(
          color: Palette.cream100,
          padding: const EdgeInsets.fromLTRB(6, 4, 4, 4),
          child: Row(
            children: [
              const SpriteIcon('icon-water', size: 28),
              const SizedBox(width: 6),
              Expanded(
                child: PxTextInput(
                  value: _text,
                  onChanged: (v) => setState(() => _text = v),
                  onSubmitted: (_) => _send(),
                  placeholder: worker.phase is PhaseWorking ? '浇水：干着活也能收到这句话' : '浇水：带句话，它会接着干',
                  semanticLabel: '给${worker.name}带句话',
                ),
              ),
              const SizedBox(width: 8),
              PxButton.text('浇水', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : _send),
            ],
          ),
        ),
        if (log != null && log.isNotEmpty)
          FarmSection(
            title: '干活过程',
            child: Ticking(
              builder: (context, now) => WorkLog(
                steps: log,
                now: now,
                working: worker.phase is PhaseWorking,
                onComment: (step, text) => ref.read(farmCommandsProvider).water(worker, text, on: step),
              ),
            ),
          )
        else
          FarmSection(
            title: '这一轮做了什么',
            child: steps.isEmpty
                ? Text('还没动手。', style: KitText.sm.copyWith(color: Palette.bark600))
                : Ticking(
                    builder: (context, now) => Column(
                      children: [
                        for (final s in steps)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Row(
                              children: [
                                ActionGlyph(s.action, size: 18),
                                const SizedBox(width: 8),
                                SizedBox(
                                  width: 56,
                                  child: Text(actionMeaning[s.action]!, style: KitText.sm.copyWith(color: Palette.bark800)),
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
          FarmSection(
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
          FarmSection(
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
      ],
    );
    return LayoutBuilder(
      builder: (context, box) => box.maxWidth >= 560
          ? Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                aside,
                const SizedBox(width: 16),
                Expanded(child: main),
              ],
            )
          : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [aside, const SizedBox(height: 16), main]),
    );
  }
}

List<String> _last(List<String> all, int n) => all.length > n ? all.sublist(all.length - n) : all;

/// A sprite at a width or a height, crisp.
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

/// A playbook's helper: which playbook, which step, and the way to its board.
class PlanLine extends ConsumerWidget {
  const PlanLine({super.key, required this.worker, required this.onDone});
  final Helper worker;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tag = worker.playbook;
    final pb = tag == null ? null : playbookOf(ref.watch(plansProvider), tag.id);
    if (tag == null || pb == null) return const SizedBox.shrink();
    final node = tag.node == null ? null : nodeOf(pb, tag.node!);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Tinted(
        color: tint(Palette.wheat, .25),
        child: Row(
          children: [
            Expanded(
              child: node != null
                  ? Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: '种植计划「${pb.title}」的一步：'),
                          TextSpan(text: node.title),
                          const TextSpan(text: '。做完自动合进计划分支，收获整个计划时才进主分支。'),
                        ],
                      ),
                      style: KitText.xs,
                    )
                  : Text('在拆种植计划「${pb.title}」：只读代码，不改文件。', style: KitText.xs),
            ),
            const SizedBox(width: 8),
            KitTappable(
              onTap: () {
                ref.read(planShownProvider.notifier).set(pb.id);
                ref.read(panelProvider.notifier).set(FarmPanel.plans);
                onDone();
              },
              builder: (context, s) => FarmTag('看计划', fill: s.hovered ? Palette.cream100 : Palette.cream50, ink: Palette.leaf700),
            ),
          ],
        ),
      ),
    );
  }
}

// ── 播种袋 ────────────────────────────────────────────────────────────────────

class SeedForm extends ConsumerStatefulWidget {
  const SeedForm({super.key, required this.station, required this.onDone});
  final int station;
  final VoidCallback onDone;

  @override
  ConsumerState<SeedForm> createState() => _SeedFormState();
}

class _SeedFormState extends ConsumerState<SeedForm> {
  String? _who;
  var _text = '';

  @override
  Widget build(BuildContext context) {
    final agents = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{}).values.where((a) => a.enabled).toList();
    final pick = ref.watch(prefsProvider.select((p) => p.pick));
    final who = _who ?? (agents.any((a) => a.id == pick) ? pick : 'auto');
    // What you sent before (newest first), then jobs for your projects (core farm.ts seedsFor).
    final asked = askedOf(ref.watch(farmProvider));
    final seeds = seedsFor(asked, ref.watch(projectNamesProvider).value ?? const []);
    void sow() {
      if (_text.trim().isEmpty) return;
      Sfx.play('plant');
      fire(ref.read(farmCommandsProvider).plant(widget.station, _text, who == 'auto' ? null : who));
      widget.onDone();
    }

    final label = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('种子（工单）', style: label),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in seeds)
              KitTappable(
                onTap: () => setState(() => _text = s),
                selected: _text == s,
                builder: (context, st) => Container(
                  color: _text == s ? Palette.leaf500 : (st.hovered ? Palette.cream300 : Palette.cream200),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Text(s, style: KitText.xs.copyWith(color: _text == s ? Palette.cream50 : Palette.bark800)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        PxTextArea(value: _text, onChanged: (v) => setState(() => _text = v), rows: 3, placeholder: '或者自己写：要做什么，做到什么程度', semanticLabel: '工单'),
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
              for (final a in agents) _WhoTile(active: who == a.id, label: a.name, onTap: () => setState(() => _who = a.id), child: AgentFace(a.id, size: 44)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: Text('管家会把这句话交给帮工；没开工的话会先开工。', style: label)),
            const SizedBox(width: 8),
            PxButton.text('播种', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : sow),
          ],
        ),
      ],
    );
  }
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

// ── 浇水 ──────────────────────────────────────────────────────────────────────

const _dropsOfAdvice = ['改动小一点', '先别动测试', '做完跟我说一声', '顺便补个测试'];

class WaterForm extends ConsumerStatefulWidget {
  const WaterForm({super.key, required this.worker, required this.onDone});
  final Helper worker;
  final VoidCallback onDone;

  @override
  ConsumerState<WaterForm> createState() => _WaterFormState();
}

class _WaterFormState extends ConsumerState<WaterForm> {
  var _text = '';

  void _send() {
    if (_text.trim().isEmpty) return;
    fire(ref.read(farmCommandsProvider).water(widget.worker, _text));
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.worker;
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(w.phase is PhaseWorking ? '它正在干活，这句话会在下一步之前收到。' : '它现在没在干活，这句话会让它接着干一轮。', style: KitText.sm.copyWith(color: Palette.bark800)),
        const SizedBox(height: 4),
        Text('这句话记在它的工单串里，它回的话也在那儿。', style: xs),
        const SizedBox(height: 4),
        Text('现在的活：${w.task}', style: xs),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in _dropsOfAdvice)
              KitTappable(
                onTap: () => setState(() => _text = s),
                builder: (context, st) => Container(
                  color: st.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Text(s, style: KitText.xs.copyWith(color: Palette.bark800)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        PxTextInput(
          value: _text,
          onChanged: (v) => setState(() => _text = v),
          onSubmitted: (_) => _send(),
          autofocus: true,
          placeholder: '带句话……',
          semanticLabel: '给${w.name}带句话',
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: PxButton.text('浇水', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : _send),
        ),
      ],
    );
  }
}

// ── 管家和宠物 ─────────────────────────────────────────────────────────────────

/// Who the manager is: pick a look, and the pet by the door; the farm, the chat and the title screen follow at once.
class ManagerLooks extends ConsumerWidget {
  const ManagerLooks({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final prefs = ref.watch(prefsProvider);
    final current = prefs.managerLook ?? 'farmer';
    final has = atlas?.has ?? (_) => false;
    Widget tile({required bool chosen, required bool ready, required VoidCallback onTap, required List<Widget> children}) => KitTappable(
      onTap: ready ? onTap : null,
      selected: chosen,
      builder: (context, s) => Opacity(
        opacity: ready ? 1 : .5,
        child: Container(
          decoration: BoxDecoration(
            color: chosen ? tint(Palette.leaf300, .6) : (s.hovered ? Palette.cream200 : Palette.cream100),
            border: chosen ? Border.all(color: Palette.leaf500, width: 2) : null,
          ),
          padding: const EdgeInsets.all(10),
          child: Column(children: children),
        ),
      ),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('挑一个你喜欢的管家，农场和对话里马上换上。', style: KitText.sm.copyWith(color: Palette.bark900)),
        const SizedBox(height: 12),
        GridView.count(
          crossAxisCount: 3,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: .62,
          children: [
            for (final look in managerLooks)
              tile(
                chosen: look.id == current,
                ready: lookReady(look.id, has),
                onTap: () => ref.read(prefsProvider.notifier).setManagerLook(look.id),
                children: [
                  SizedBox(height: 112, child: atlas == null ? null : SpriteIcon(managerSprite(look.id, '', has), size: 112)),
                  const SizedBox(height: 6),
                  Text(look.name, style: KitText.sm),
                  Text(
                    lookReady(look.id, has) ? look.blurb : '还在画……',
                    textAlign: TextAlign.center,
                    style: KitText.xs.copyWith(color: Palette.bark600),
                  ),
                ],
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text('宠物', style: KitText.sm),
        const SizedBox(height: 8),
        Row(
          children: [
            for (final (i, p) in pets.indexed) ...[
              if (i > 0) const SizedBox(width: 10),
              Expanded(
                child: tile(
                  chosen: p == prefs.petOrDog,
                  ready: has('$p-awake'),
                  onTap: () => ref.read(prefsProvider.notifier).setPet(p),
                  children: [
                    SizedBox(height: 64, child: has('$p-awake') ? SpriteIcon('$p-awake', size: 64) : null),
                    const SizedBox(height: 6),
                    Text(petName[p]!, style: KitText.sm),
                    if (!has('$p-awake')) Text('还在画……', style: KitText.xs.copyWith(color: Palette.bark600)),
                  ],
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}

// ── 仓库、日志、商店 ───────────────────────────────────────────────────────────

/// The warehouse: what was harvested into the main branch, a job or a whole playbook, the latest first. A job opens
/// its ticket on the desk; a playbook, the plan board.
class Warehouse extends ConsumerWidget {
  const Warehouse({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stored = harvestedOf(ref.watch(farmProvider));
    if (stored.isEmpty) return const FarmEmpty('仓库还空着。收获进主分支的活会放在这里。');
    final plans = ref.watch(plansProvider);
    final agents = ref.watch(agentsProvider).value ?? const <String, AgentProfile>{};
    final now = DateTime.now().millisecondsSinceEpoch;
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth >= 600 ? (box.maxWidth - 8) / 2 : box.maxWidth;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final i in stored)
              SizedBox(
                width: w,
                child: KitTappable(
                  onTap: () {
                    if (i.plan != null) {
                      ref.read(planShownProvider.notifier).set(i.id);
                      ref.read(panelProvider.notifier).set(FarmPanel.plans);
                    } else {
                      context.go('/tickets/${Uri.encodeComponent(i.id)}');
                    }
                  },
                  semanticLabel: ticketTitle(i, plans),
                  builder: (context, s) => Container(
                    color: s.hovered ? Palette.cream200 : Palette.cream100,
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SpriteIcon(i.plan != null ? 'icon-plan' : 'icon-harvest', size: 40),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(ticketTitle(i, plans), maxLines: 2, overflow: TextOverflow.ellipsis, style: KitText.sm),
                              const SizedBox(height: 4),
                              Text(
                                [
                                  if (i.plan != null) '种植计划',
                                  if (i.agent case final a?) agents[a]?.name ?? a,
                                  ?i.project,
                                  if (i.closedAt case final at?) '${ago(at, now)}收的',
                                ].join(' · '),
                                style: KitText.xs.copyWith(color: Palette.bark600),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

const _outcomeTag = {
  Outcome.completed: ('做完', Color(0xFFEFCF92), Palette.bark900),
  Outcome.failed: ('没过', Color(0xFFF0CDA6), Palette.berry),
  Outcome.interrupted: ('叫停', Palette.cream200, Palette.bark600),
};

/// One row of the farm log: something said on the square, or a job that ended.
sealed class _Row {
  const _Row(this.at);
  final double at;
}

final class _SaidRow extends _Row {
  const _SaidRow(this.message) : super(0);
  final ChatMessage message;
  @override
  double get at => message.at;
}

final class _ReportRow extends _Row {
  const _ReportRow(this.report) : super(0);
  final ChatMessage report;
  @override
  double get at => report.at;
}

/// 农场日志: you and the manager on the square, and every turn a helper reported (its report in the chat), newest first. The web page weaves in the
/// lines of voice calls too; this client's captions carry no times, so the log keeps to the typed ones.
class FarmLog extends ConsumerWidget {
  const FarmLog({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(farmProvider);
    final look = ref.watch(prefsProvider.select((p) => p.managerLook)) ?? 'farmer';
    final chat = s?.chat;
    final rows = <_Row>[
      for (final m in messagesIn(chat, squareOf(chat)?.id ?? -1))
        if (m.kind == MessageKind.chat && (m.fromKind == SenderKind.user || m.fromKind == SenderKind.foreman)) _SaidRow(m),
      for (final r in turnReportsOf(s)) _ReportRow(r),
    ]..sort((a, b) => b.at.compareTo(a.at));
    if (rows.isEmpty) return const FarmEmpty('还没有事。开工以后，你和管家说的话、谁做完了什么，都记在这里。');
    final shown = rows.take(80).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, row) in shown.indexed) ...[
          if (i > 0) const DashedLine(),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 44,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      clockOf(row.at),
                      textAlign: TextAlign.right,
                      style: KitText.xs.copyWith(color: Palette.bark400),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                ...switch (row) {
                  _SaidRow(:final message) => _said(message, look),
                  _ReportRow(:final report) => _report(report, issueOfRun(s, report.helper ?? report.from)),
                },
              ],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _said(ChatMessage m, String look) {
    final you = m.fromKind == SenderKind.user;
    return [
      if (you)
        Container(
          width: 32,
          height: 32,
          color: Palette.leaf500,
          alignment: Alignment.center,
          child: Text('你', style: KitText.xs.copyWith(color: Palette.cream50)),
        )
      else
        ManagerFaceOf(size: 32, look: look),
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Who(
              name: you ? '你' : '管家',
              tag: FarmTag(you ? '说' : (m.final_ ? '答' : '正在说'), ink: Palette.bark600),
            ),
            const SizedBox(height: 2),
            PxMarkdown(m.text, style: KitText.sm.copyWith(color: you ? Palette.bark900 : Palette.bark800)),
          ],
        ),
      ),
    ];
  }

  List<Widget> _report(ChatMessage r, Issue? issue) {
    final outcome = r.outcome ?? Outcome.completed;
    final (text, fill, ink) = _outcomeTag[outcome]!;
    return [
      AgentFace(r.agent ?? '', size: 32),
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Who(
              name: r.name,
              tag: FarmTag(text, fill: fill, ink: ink),
            ),
            const SizedBox(height: 2),
            if (issue != null) Text(issue.title, style: KitText.sm),
            Text(
              r.text,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: KitText.xs.copyWith(color: outcome == Outcome.failed ? Palette.berry : Palette.bark600),
            ),
            if (r.spent != null) Text('这一轮花了 ${spentText(r.spent!)}', style: KitText.xs.copyWith(color: Palette.bark400)),
          ],
        ),
      ),
    ];
  }
}

class _Who extends StatelessWidget {
  const _Who({required this.name, required this.tag});
  final String name;
  final Widget tag;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(name, style: KitText.sm),
      const SizedBox(width: 6),
      tag,
    ],
  );
}

const _shop = [
  (name: '稻草人', price: 200, icon: 'icon-scarecrow', note: '吓跑乌鸦，好看'),
  (name: '新种子包', price: 300, icon: 'icon-seeds', note: '常用工单模板'),
  (name: '彩旗', price: 400, icon: 'icon-bunting', note: '挂在篱笆上'),
  (name: '狗窝', price: 600, icon: 'icon-doghouse', note: '给管家的狗'),
];

class Shop extends ConsumerWidget {
  const Shop({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final coins = (ref.watch(farmProvider.select((s) => s?.progress?.coins)) ?? 0).round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('商店还在装修，下一版开张。现在有 $coins 金币，先攒着。', style: KitText.sm.copyWith(color: Palette.bark800)),
        const SizedBox(height: 12),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 8,
          crossAxisSpacing: 8,
          childAspectRatio: 3.2,
          children: [
            for (final item in _shop)
              Opacity(
                opacity: .8,
                child: Container(
                  color: Palette.cream100,
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    children: [
                      SpriteIcon(item.icon, size: 36),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(item.name, style: KitText.sm),
                            Text(
                              item.note,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: KitText.xs.copyWith(color: Palette.bark600),
                            ),
                          ],
                        ),
                      ),
                      const SpriteIcon('icon-coin', size: 16),
                      Text('${item.price}', style: KitText.sm.copyWith(color: Palette.bark800)),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}
