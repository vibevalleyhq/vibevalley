// Sprite names are the pixel drawings' (assets/pixel): idle is -down, think is -side, walk is -down-1.

import 'dart:math' as math;
import 'dart:ui' show Color;

import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../rules/looks.dart';

final swatches = (
  body: ['#f3e9da', '#e9e6de', '#e7e6fb', '#d3efe8', '#dfe4ea', '#f4e6d4', '#b9c4d1', '#3d434a', '#2a2e33', '#f6d8c8'],
  trim: ['#d9774f', '#24282d', '#6c70d8', '#2f9d8f', '#5b6470', '#b0503f', '#3a404a', '#d8dadc', '#c79a2e', '#8a5cc4'],
  hat: ['#f2b53a', '#e8804f', '#f4f3ee', '#2f3438', '#d9534f', '#4f86d9', '#9580e6', '#45bf8c', '#a9b4c2', '#ff8fb1'],
  eye: [fallbackPreset.look.eye, '#ffd25e', '#9dffb0', '#ff9de2', '#ffffff', '#ff7a5c'],
);

T _one<T>(math.Random rand, List<T> items) => items[rand.nextInt(items.length)];

Look randomLook([math.Random? random]) {
  final rand = random ?? math.Random();
  return Look(
    species: _one(rand, Species.values),
    outfit: _one(rand, Outfit.values),
    build: _one(rand, Build.values),
    head: _one(rand, Head.values),
    body: _one(rand, swatches.body),
    trim: _one(rand, swatches.trim),
    hat: _one(rand, swatches.hat),
    eye: _one(rand, swatches.eye),
  );
}

/// The generated Look has no copyWith.
Look lookWith(Look l, {Species? species, Outfit? outfit}) =>
    Look(species: species ?? l.species, outfit: outfit ?? l.outfit, build: l.build, head: l.head, body: l.body, trim: l.trim, hat: l.hat, eye: l.eye);

enum Pose { idle, walk, think, work, cheer, worry }

String _pixelPose(Pose pose) => switch (pose) {
  Pose.idle => 'down',
  Pose.think => 'side',
  Pose.walk => 'down-1',
  Pose.work => 'work',
  Pose.cheer => 'cheer',
  Pose.worry => 'worry',
};

/// Its outfit's, else the farmer's, else the farmer standing.
SpriteInfo castSprite(SpriteAtlas atlas, Cast cast, Pose pose) {
  final s = cast.species.wire;
  final p = _pixelPose(pose);
  return atlas.first(['$s-${cast.outfit.wire}-$p', '$s-farmer-$p', '$s-farmer-down']);
}

String castPrefix(SpriteAtlas atlas, Cast cast) => _prefixOf(cast, atlas.has);

/// An agent's sprite prefix: its animal and outfit (castOf), as far as the sprites go.
String lookOf(Agent? agent, String agentId, bool Function(String) has) => _prefixOf(castOf(agent?.look, agentId), has);

String _prefixOf(Cast cast, bool Function(String) has) {
  final s = cast.species.wire;
  return ['$s-${cast.outfit.wire}', '$s-farmer', 'bear-farmer'].firstWhere((l) => has('$l-down'), orElse: () => 'bear-farmer');
}

const walkFps = 7;

/// Without a cycle for this outfit, the stepping pose and the standing pose take turns.
List<SpriteInfo> walkFrames(SpriteAtlas atlas, Cast cast) {
  final base = '${cast.species.wire}-${cast.outfit.wire}-down';
  if (atlas.has('$base-1')) {
    return [
      atlas['$base-1'],
      atlas[base],
      atlas.first(['$base-2', base]),
      atlas[base],
    ];
  }
  return [castSprite(atlas, cast, Pose.walk), castSprite(atlas, cast, Pose.idle)];
}

/// The young farmer stands in for a look not painted yet.
String managerFaceSprite(SpriteAtlas atlas, String look) => atlas.has('manager-$look-face') ? 'manager-$look-face' : 'manager-face';

Color hexColor(String hex) {
  final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
  return v == null || hex.length != 7 ? const Color(0xFFF1E8D8) : Color(0xFF000000 | v);
}
