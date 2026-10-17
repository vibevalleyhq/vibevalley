import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../shared/faces.dart';
import '../../shared/swatches.dart';
import '../shared/widgets.dart';
import '../../rules/cast.dart';

const stagePoses = [
  (pose: Pose.idle, label: '待命', crop: Crop.empty),
  (pose: Pose.walk, label: '走过来', crop: Crop.seeded),
  (pose: Pose.think, label: '琢磨', crop: Crop.sprout),
  (pose: Pose.work, label: '干活', crop: Crop.leafy),
  (pose: Pose.cheer, label: '做完', crop: Crop.wheat),
  (pose: Pose.worry, label: '长虫了', crop: Crop.withered),
];

class AgentLookPanel extends ConsumerWidget {
  const AgentLookPanel({super.key, required this.look, required this.id, required this.onChange});
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

class AgentStage extends ConsumerWidget {
  const AgentStage({super.key, required this.look, required this.id, required this.pose, required this.name, required this.role});
  final Look look;
  final String id;
  final Pose pose;
  final String name;
  final String role;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final cast = castOf(look, id);
    final shown = stagePoses.firstWhere((p) => p.pose == pose);
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
