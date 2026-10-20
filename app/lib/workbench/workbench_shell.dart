import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../shared/faces.dart';
import '../gen/vibevalley.dart';
import '../rules/cast.dart';
import '../sprites/atlas.dart';
import '../ui/pro/pro.dart';
import 'places.dart';

const workbenchHead = 66.0;

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

class Workbench extends StatelessWidget {
  const Workbench({super.key, required this.place, required this.child});
  final Place? place;
  final Widget child;

  // A Material under the pages: text fields and ink need one, and it gives the page's text its style.
  @override
  Widget build(BuildContext context) => ProScope(
    child: Material(
      color: ProColor.page,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Rail(here: place),
          Expanded(
            child: place == Place.chat ? child : _ConfigDesk(place: place, child: child),
          ),
        ],
      ),
    ),
  );
}

class _Rail extends ConsumerWidget {
  const _Rail({required this.here});
  final Place? here;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Container(
    width: 64,
    color: Palette.bark800,
    child: LayoutBuilder(
      builder: (context, box) => SingleChildScrollView(
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: box.maxHeight),
          child: IntrinsicHeight(
            child: Column(
              children: [
                SizedBox(
                  height: workbenchHead,
                  child: Center(
                    child: _Slot(
                      label: '回农场',
                      framed: true,
                      fill: Palette.wheat,
                      onTap: () => context.go('/'),
                      child: const ClipRect(child: WorkbenchManagerFace(size: 38)),
                    ),
                  ),
                ),
                for (final p in Place.values.where((p) => p != Place.settings)) ...[
                  _Slot(
                    label: '${p.label} · ${p.hint}',
                    framed: p == here,
                    fill: const Color(0x33FFFAF0),
                    onTap: () => context.go(p.path),
                    child: placeIcon(p),
                  ),
                  const SizedBox(height: 8),
                ],
                const Spacer(),
                _Slot(
                  label: '${Place.settings.label} · ${Place.settings.hint}',
                  framed: here == Place.settings,
                  fill: const Color(0x33FFFAF0),
                  onTap: () => context.go(Place.settings.path),
                  child: placeIcon(Place.settings),
                ),
                const SizedBox(height: 8),
                _Slot(label: '回农场', onTap: () => context.go('/'), child: const _Pix('icon-seeds')),
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
    child: Tappable(
      onTap: onTap,
      semanticLabel: label,
      builder: (context, s) => ProFocusRing(
        on: s.focused,
        radius: 10,
        child: Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: framed ? fill : (s.hovered ? const Color(0x22FFFAF0) : null),
            borderRadius: const BorderRadius.all(Radius.circular(10)),
          ),
          child: child,
        ),
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
          height: workbenchHead,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          decoration: const BoxDecoration(border: Border(bottom: proLine)),
          child: LayoutBuilder(
            builder: (context, box) {
              final compact = box.maxWidth < 520;
              final status = live ? '开工中 · $working 个在干活' : '没开工';
              return Row(
                children: [
                  if (p != null) ...[
                    placeIcon(p),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(p.label, style: ProText.lg, maxLines: 1, overflow: TextOverflow.ellipsis),
                          ),
                          if (!compact) ...[
                            const SizedBox(width: 12),
                            Flexible(
                              child: Text(p.hint, style: ProText.meta, maxLines: 1, overflow: TextOverflow.ellipsis),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                  ] else
                    const Spacer(),
                  ProButton(
                    size: ProSize.sm,
                    semanticLabel: status,
                    onPressed: () => context.go('/'),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        ProDot(live ? Palette.leaf500 : ProColor.faint, size: 8),
                        const SizedBox(width: 6),
                        Text(compact && live ? '$working 个在干活' : status, style: ProText.xs),
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ),
        Expanded(
          child: Padding(padding: const EdgeInsets.only(top: 12), child: child),
        ),
      ],
    );
  }
}
