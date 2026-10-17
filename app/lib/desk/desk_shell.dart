import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../shared/faces.dart';
import '../gen/vibevalley.dart';
import '../rules/cast.dart';
import '../data/ui_state.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import 'places.dart';

const deskHead = 66.0;

class _Pix extends ConsumerWidget {
  const _Pix(this.name);
  final String name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null || !atlas.has(name)) return const SizedBox.square(dimension: 26);
    return SizedBox.square(dimension: 26, child: FittedBox(child: PixelSprite(atlas[name], scale: 1)));
  }
}

Widget placeIcon(Place p) => p == Place.agents ? CastFace(cast: castOf(null, 'backend'), size: 26) : _Pix(p.icon);

class Desk extends StatelessWidget {
  const Desk({super.key, required this.place, required this.child});
  final Place? place;
  final Widget child;

  // A Material under the pages: text fields and ink need one, and it gives the page's text its style.
  @override
  Widget build(BuildContext context) => Material(
    color: Palette.cream50,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Rail(here: place),
        Expanded(
          child: place == Place.chat ? child : _ConfigDesk(place: place, child: child),
        ),
      ],
    ),
  );
}

class _Rail extends ConsumerWidget {
  const _Rail({required this.here});
  final Place? here;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Container(
    width: 64,
    decoration: const BoxDecoration(
      color: Palette.bark600,
      border: Border(right: pxLine),
    ),
    child: LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: IntrinsicHeight(
            child: Column(
              children: [
                SizedBox(
                  height: deskHead,
                  child: Center(
                    child: _Slot(
                      label: '回农场',
                      framed: true,
                      fill: Palette.wheat,
                      onTap: () => context.go('/'),
                      child: const ClipRect(child: DeskManagerFace(size: 38)),
                    ),
                  ),
                ),
                for (final p in Place.values) ...[
                  _Slot(label: '${p.label} · ${p.hint}', framed: p == here, fill: Palette.cream50, onTap: () => context.go(p.path), child: placeIcon(p)),
                  const SizedBox(height: 8),
                ],
                const Spacer(),
                _Slot(label: '回农场', onTap: () => context.go('/'), child: const _Pix('icon-seeds')),
                const SizedBox(height: 8),
                _Slot(
                  label: '设置（钥匙）',
                  onTap: () {
                    context.go('/');
                    ref.read(titleOpenProvider.notifier).show();
                  },
                  child: const _Pix('icon-wrench'),
                ),
                const SizedBox(height: 12),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class _Slot extends StatelessWidget {
  const _Slot({required this.label, required this.onTap, required this.child, this.framed = false, this.fill});
  final String label;
  final VoidCallback onTap;
  final Widget child;
  final bool framed;
  final Color? fill;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: label,
    waitDuration: const Duration(milliseconds: 400),
    child: KitTappable(
      onTap: onTap,
      semanticLabel: label,
      builder: (context, s) => Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: framed
            ? BoxDecoration(
                color: fill,
                border: Border.all(color: Palette.bark900, width: 2),
                boxShadow: kitDrop,
              )
            : BoxDecoration(color: s.hovered ? Palette.bark800 : null),
        child: child,
      ),
    ),
  );
}

class _ConfigDesk extends ConsumerWidget {
  const _ConfigDesk({required this.place, required this.child});
  final Place? place;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final farm = ref.watch(stateProvider);
    final live = farm?.call == CallState.live;
    final working = farm?.sessions.where((h) => h.phase is PhaseWorking).length ?? 0;
    final p = place;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: deskHead,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          decoration: const BoxDecoration(border: Border(bottom: pxLine)),
          child: Row(
            children: [
              if (p != null) ...[
                placeIcon(p),
                const SizedBox(width: 12),
                Text(p.label, style: KitText.lg),
                const SizedBox(width: 12),
                Text(p.hint, style: KitText.xs.copyWith(color: Palette.bark500)),
              ],
              const Spacer(),
              PxButton(
                size: PxSize.custom,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                onPressed: () => context.go('/'),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(width: 8, height: 8, color: live ? Palette.leaf500 : Palette.cream300),
                    const SizedBox(width: 6),
                    Text(live ? '开工中 · $working 个在干活' : '没开工', style: KitText.xs),
                  ],
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: Padding(padding: const EdgeInsets.only(top: 12), child: child),
        ),
      ],
    );
  }
}
