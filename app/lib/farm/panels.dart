import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../data/prefs.dart';
import '../ui/kit/kit.dart';
import 'achievements.dart';
import '../shared/harvest.dart';
import 'menu.dart';
import 'plans.dart';
import '../rules/looks.dart';
import '../shared/tags.dart';
import 'farm_log.dart';
import 'plot_detail.dart';
import 'seed_forms.dart';

class FarmPanels extends ConsumerWidget {
  const FarmPanels({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(stateProvider.select((s) => s?.sessions)) ?? const <Session>[];
    Session? byId(String? id) => id == null ? null : sessions.where((h) => h.id == id).firstOrNull;
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
            child: PlotDetail(session: selected, onDone: () => ref.read(selectedProvider.notifier).set(null)),
          ),
        if (reviewing != null)
          FarmLayer(
            key: const ValueKey('harvest'),
            title: '收获${reviewing.name}的地',
            icon: 'icon-harvest',
            size: FarmDialogSize.lg,
            onClose: () => ref.read(reviewingProvider.notifier).set(null),
            child: HarvestReview(key: ValueKey(reviewing.id), session: reviewing, onDone: () => ref.read(reviewingProvider.notifier).set(null)),
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
            child: WaterForm(session: watering, onDone: () => ref.read(wateringProvider.notifier).set(null)),
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

/// A click on the backdrop closes it.
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
  // The dialog takes the keyboard as it opens, so Esc reaches it.
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
        // Only the card grows: the backdrop always covers the farm.
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
    final coins = (ref.watch(stateProvider.select((s) => s?.progress?.coins)) ?? 0).round();
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
