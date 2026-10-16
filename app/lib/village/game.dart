// The pixel village in Flame (web/src/pixel/scene.ts, with overlay.ts's hit regions): the map, the plots and what
// grows in them, the props, the manager and the dog (or cat), the helpers walking in from the gate to their beds and
// to the buildings their work takes them to, the effects over the plots (fx.dart), the yard's own life (life.dart),
// and the plants in front of the camera leaning with the pointer. What it shows comes from the server's folded state
// (FarmState, its view); the village only adds what moves with the clock: walking, strolling, poses, breathing, the
// dog's day. It is lit as the web page lights it (engine/pixi light.ts): the world is drawn once as painted and once
// with every sprite's normal map, and shaders/light.frag lights each art pixel from the sky and the lamps; what shines,
// the marks and the plants in front go over the lit picture. What can be clicked is worked out here, in the web
// page's order (overlay.ts): the helpers over the dog, over the things in the yard, over the plots; a click nothing
// takes pokes the yard.

import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui';

import 'package:flame/components.dart';
import 'package:flame/events.dart';
import 'package:flame/game.dart';
import 'package:flutter/foundation.dart' show ValueNotifier;

import '../gen/vibevalley.dart';
import '../shell/sfx.dart';
import '../sprites/atlas.dart';
import 'critters.dart' show PointLight;
import 'dog.dart';
import 'fx.dart';
import 'level.dart';
import 'life.dart';
import 'nav.dart';
import 'normals.dart';
import 'particles.dart';
import 'pass.dart';
import 'sky.dart';
import 'world.dart';
import '../rules/looks.dart';

export 'critters.dart' show PointLight;
export 'fx.dart' show BedFx;

/// Art pixels a second, and frames of the walk cycle a second (scene.ts).
const _walkSpeed = 42.0;
const _walkFps = 8.0;

/// The plants in front of the camera lean this many art pixels towards the pointer; the yard itself stays still.
const _nearLean = 3.0;

/// Helpers fade out at the gate when they leave, and are gone for good this long after they left (core site.ts).
const _fadeS = 0.8;
const _goneS = 3.6;

/// Helpers light their lanterns once it is this dark (night 0..1); the lamps' and the lanterns' colours.
const _lanternDark = 0.35;
const _lampColor = Color(0xFFFFC46E);
const _lanternColor = Color(0xFFFFD28C);

/// At most this many point lights go to the shader, the strongest first (light.ts MAX_LIGHTS).
const _maxLights = 32;

/// What helpers do at each building (design/pixel pose-*), frame by frame, and how fast the frames go (scene.ts).
const _placePose = {
  'bench': (['sit'], 1.0),
  'library': (['read'], 1.0),
  'workshop': (['hammer-1', 'hammer-2'], 3.0),
  'mast': (['tinker-1', 'tinker-2'], 1.5),
};

/// A hop when clicked, pixel by pixel, over this many seconds.
const _hop = [2.0, 4.0, 5.0, 4.0, 2.0, 1.0];
const _hopS = 0.3;

/// How often the core moves helpers between places and around their plots, seconds (village.ts, farm.ts TICK_MS).
const _whereTick = 0.3;
const _strollTick = 0.6;

/// One world day lasts ten real minutes and starts in the morning (core live.ts).
const _daySeconds = 600.0;

/// Rows of a shadow on the ground, and how dark the one right under the feet is.
const _shadowH = 4;
const _contactAlpha = 0.5;

/// What a hovered thing in the yard looks like: a quarter brighter (scene.ts LIT).
const _brighter = ColorFilter.matrix([1.25, 0, 0, 0, 0, 0, 1.25, 0, 0, 0, 0, 0, 1.25, 0, 0, 0, 0, 0, 1, 0]);

final _random = math.Random();

/// A sprite from the atlas, standing on its anchor (the point that touches the ground), crisp.
class AtlasSprite extends SpriteComponent {
  AtlasSprite(this._game, String name, {this.fixedAnchor, this.near = false}) : super(paint: Paint()..filterQuality = FilterQuality.none) {
    show(name);
  }

  final VillageGame _game;

  /// In front of the camera: out of the light's reach, drawn over the lit picture in the sky's colour.
  final bool near;

  /// An anchor of its own (the plants in front of the camera are pinned by their corners), else the picture's.
  final Anchor? fixedAnchor;
  String? _shown;
  double _h = 1;

  /// What it is drawn through as painted (a hovered thing in the yard is brighter; the plants in front are tinted).
  ColorFilter? filter;

  String? get shown => _shown;

  void show(String name) {
    if (_shown == name) return;
    _shown = name;
    final info = _game.atlas.has(name) ? _game.atlas[name] : _game.atlas['bear-farmer-down'];
    sprite = Sprite(_game.images.fromCache(info.asset));
    size = Vector2(info.w, info.h);
    _h = info.h;
    // The feet stand on the row under the anchor's pixel (sprites.ts anchorOf: (ay + 1) / h, in the drawing's pixels).
    anchor = fixedAnchor ?? Anchor(info.ax / info.w, (info.ay + 1 / _game.atlas.density) / info.h);
  }

  /// Taller by `rows` art pixels (shorter, when negative) with its feet where they are: one row shows twice (or once
  /// less). A breath that moved the whole picture would lift the feet off the ground (scene.ts rise).
  void rise(double rows) => scale.y = 1 + rows / _h;

  /// Its picture's box in the world, as drawn now, given where its parent stands.
  Rect boxIn([Vector2? origin]) {
    final w = size.x * scale.x.abs();
    final h = size.y * scale.y;
    final ax = scale.x < 0 ? 1 - anchor.x : anchor.x;
    final x = (origin?.x ?? 0) + position.x - ax * w;
    final y = (origin?.y ?? 0) + position.y - anchor.y * h;
    return Rect.fromLTWH(x, y, w, h);
  }

  @override
  void render(Canvas canvas) {
    switch (renderPass) {
      case RenderPass.color:
        if (near) return;
        paint.colorFilter = filter;
        super.render(canvas);
      case RenderPass.normals:
        // Its normal map in place of its picture (the mirrored one when it is drawn flipped).
        final normals = near ? null : _game._normals[_shown];
        if (normals == null) return;
        final image = scale.x < 0 ? normals.$2 : normals.$1;
        canvas.drawImageRect(
          image,
          Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
          size.toRect(),
          _game._normalPaint..color = Color.fromRGBO(0, 0, 0, opacity),
        );
      case RenderPass.near:
        if (!near) return;
        paint.colorFilter = filter;
        super.render(canvas);
      case RenderPass.glows || RenderPass.marks:
        return;
    }
  }
}

/// A shadow on the ground, centred where it is put (light.ts shadowTexture), drawn in the lit world.
class _Shadow extends PositionComponent {
  _Shadow(int w, int h) : _look = groundShadow(w, h);
  final Picture _look;
  double alpha = _contactAlpha;

  @override
  void render(Canvas canvas) {
    if (renderPass == RenderPass.color) drawLook(canvas, _look, 0, 0, alpha: alpha);
  }
}

/// What grounds something standing (scene.ts Footing): a dark patch right under its feet, and a fainter shadow cast
/// away from the sun, stretched from the feet sideways, never off them.
class _Footing {
  _Footing(int w) : contact = _Shadow(w, _shadowH), cast = _Shadow(w + 4, _shadowH);
  final _Shadow contact;
  final _Shadow cast;

  /// Lays the shadows of something standing at `at`.
  void fall(Pt at, _Lean lean, [double fade = 1]) {
    contact
      ..position = Vector2(at.x, at.y)
      ..alpha = _contactAlpha * fade;
    cast
      ..position = Vector2(at.x + lean.x, at.y)
      ..scale = Vector2(lean.stretch, 1)
      ..alpha = lean.cast * fade;
  }
}

/// How the sky lays shadows: how far the cast one is pushed (whole pixels), how much longer it is, how dark.
typedef _Lean = ({double x, double stretch, double cast});

/// Away from the sun, longer the lower it stands; faint by moonlight (scene.ts shadowLean).
_Lean _shadowLean(Sky sky) {
  final dx = sky.sunDir.$1;
  final dz = sky.sunDir.$3;
  final slant = 1 / math.max(dz, 0.35);
  // How far past the feet the shadow reaches; it is centred half that way, so its near end stays under them.
  final reach = (-dx * slant * 2.5).clamp(-6.0, 6.0);
  return (x: (reach / 2).roundToDouble(), stretch: 1 + reach.abs() / 8, cast: 0.3 * (0.35 + 0.65 * (1 - sky.night)));
}

/// The ring round a plot while it is pointed at (scene.ts ring).
class _Ring extends PositionComponent {
  _Ring(Rect r) : _r = r;
  final Rect _r;
  bool shown = false;

  @override
  void render(Canvas canvas) {
    if (!shown || renderPass != RenderPass.color) return;
    canvas.drawRect(
      _r.deflate(0.5),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..isAntiAlias = false
        ..color = const Color(0xFFFFE9A0),
    );
  }
}

class _Plot {
  _Plot(this.bed, this.sprite, this.ring);
  final Bed bed;
  final AtlasSprite sprite;
  final _Ring ring;
  bool ripe = false;
}

class _Prop {
  _Prop(this.spot, this.sprite, this.y);
  final String spot;
  final AtlasSprite sprite;
  final double y;
}

/// A helper as drawn: its node stands at its feet, with its two shadows and its body (scene.ts Actor).
class _Actor {
  _Actor(this.node, this.body, this.footing, this.walker, this.look, this.goal);
  final PositionComponent node;
  final AtlasSprite body;
  final _Footing footing;
  final Walker walker;

  /// Sprite name prefix: species and outfit, `<species>-<outfit>`.
  String look;
  Goal goal;

  /// The plot it works, for clicks on it.
  Bed? bed;
  int station = -1;

  /// When it left the farm (it walks to the gate, fades there, and is gone), and how long it has stood at the gate.
  double? leftAt;
  double goneFor = 0;
  double alpha = 1;

  /// When it was last clicked: it hops.
  double hopAt = -10;
  Whereabouts? where;
  Stroll? stroll;
}

/// What the village shows, from the server: the state, its view, and the agents (for each helper's looks).
class VillageData {
  const VillageData(this.state, this.view, this.agents);
  final FarmState state;
  final FarmView view;
  final Map<String, AgentProfile> agents;
}

/// What is under the pointer, in the order the web page stacks its hit regions (overlay.ts).
sealed class _Hit {
  const _Hit();
}

final class _HitHelper extends _Hit {
  const _HitHelper(this.id);
  final String id;
  @override
  bool operator ==(Object other) => other is _HitHelper && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

final class _HitDog extends _Hit {
  const _HitDog();
  @override
  bool operator ==(Object other) => other is _HitDog;
  @override
  int get hashCode => 1;
}

final class _HitSpot extends _Hit {
  const _HitSpot(this.spot);
  final String spot;
  @override
  bool operator ==(Object other) => other is _HitSpot && other.spot == spot;
  @override
  int get hashCode => spot.hashCode;
}

final class _HitPlot extends _Hit {
  const _HitPlot(this.bed);
  final int bed;
  @override
  bool operator ==(Object other) => other is _HitPlot && other.bed == bed;
  @override
  int get hashCode => bed;
}

/// Takes taps anywhere on the world (in world coordinates) for the game's hit regions.
class _Taps extends PositionComponent with TapCallbacks {
  _Taps(this._game, Vector2 size) : super(size: size, priority: -200000);
  final VillageGame _game;

  @override
  void onTapDown(TapDownEvent event) => _game._down(event.localPosition);

  @override
  void onTapUp(TapUpEvent event) => _game._up(event.localPosition, touch: event.deviceKind == PointerDeviceKind.touch);

  @override
  void onTapCancel(TapCancelEvent event) => _game._cancel();
}

class VillageGame extends FlameGame with PointerMoveCallbacks {
  VillageGame({required this.atlas, required this.village})
    : super(
        camera: CameraComponent.withFixedResolution(width: village.width, height: village.height),
      );

  final SpriteAtlas atlas;
  final VillageWorld village;
  VillageData? _data;

  /// The latest state from the server; the village catches up with it frame by frame.
  void show(VillageData data) => _data = data;

  /// What a click on the village hits, set by the farm screen: a bed (by index, 0..8: its plot or the helper on it),
  /// or a thing in the yard by its spot id (world.dart spotNames: shop, warehouse, tasks, log, plans, agents, manager,
  /// runtimes, skills).
  void Function(int bed)? onPlot;
  void Function(String spot)? onSpot;

  /// The bed and the spot under the pointer, for the cursor and the hover cards; null over neither (farm/ui.ts hover,
  /// pixel/ui.ts spotHover).
  final hoverBed = ValueNotifier<int?>(null);
  final hoverSpot = ValueNotifier<String?>(null);

  /// The pointer is pressed on a plot or the helper on one, for the cursor (farm/ui.ts pressing).
  final pressing = ValueNotifier<bool>(false);

  /// Every thing in the yard shows its name (⌥ held, or the first visit), set by the farm screen; the overlay reads it.
  final revealNames = ValueNotifier<bool>(false);

  /// The manager's look (prefs.managerLook: managerLooks) and the pet ('dog', 'ragdoll', 'bluecat': prefs.pet), set by
  /// the farm screen.
  final managerLook = ValueNotifier<String>('farmer');
  final pet = ValueNotifier<String>('dog');

  /// The voice is live: the dog sits up with you, as for a call.
  final voiceLive = ValueNotifier<bool>(false);

  /// Seconds the village has run, for the overlay's little animations.
  double get t => _t;

  /// The time of day, 0..1 (0.5 is noon): one world day lasts ten real minutes and starts in the morning (core
  /// live.ts, engine core/clock.ts). The HUD's clock reads it.
  double get tod => _tod;
  void setTimeOfDay(double tod) => _tod = ((tod % 1) + 1) % 1;

  /// How many times faster than real time the day goes; 0 pauses it (clock.ts setDaySpeed).
  double daySpeed = 1;

  /// Each helper's head, in art pixels, as drawn this frame: the overlay pins words there.
  final heads = <String, Pt>{};

  /// Ticks every frame, for what is drawn over the village.
  final frames = ValueNotifier<int>(0);

  /// An effect from the server's frames: a reward's coins jump out of its helper's plot. Level-ups, achievements and
  /// penalties are said over the page (web ui/FxLayer.tsx), not in the village.
  void play(GameEffect effect) {
    switch (effect) {
      case GameEffectReward(:final workerId, :final coins):
        final station = _actors[workerId]?.station ?? _stationOfHelper(workerId);
        final bed = bedOfStation(station);
        if (bed != null) _fx.coins(bed.index, coins);
      case GameEffectPenalty() || GameEffectLevelUp() || GameEffectAchievement():
        return;
    }
  }

  /// What a tool did to a bed (by index): drops, a puff, dust, the crop popping up (core farm.ts bedFx).
  void burst(BedFx kind, int bed) => _fx.burst(kind, bed);

  /// The pointer left the village: nothing is pointed at (village_view.dart VillageCanvas calls it).
  void pointerExit() {
    _pointer = null;
    _setHover(null);
  }

  final _plots = <_Plot>[];
  final _props = <_Prop>[];
  final _actors = <String, _Actor>{};
  late final AtlasSprite _manager;
  late final AtlasSprite _dog;
  late final _Footing _managerFooting;
  late final _Footing _dogFooting;
  final _pup = VillageDog();
  late final VillageLife _life;
  late final PlotFx _fx;
  final _near = <(AtlasSprite, Vector2)>[];
  double _t = 0;
  double _tod = 0.42;
  double _whereAt = 0;
  double _strollAt = 0;

  /// The light: the shader, each sprite's normal maps (as painted, and mirrored), the sky and the lights this frame.
  FragmentShader? _shader;
  final _normals = <String, (Image, Image)>{};
  bool _normalsReady = false;
  final _normalPaint = Paint()..filterQuality = FilterQuality.none;
  Sky _sky = skyAt(0.42);
  final _lights = <PointLight>[];

  /// The lamps' halos (alpha by the night and their flicker) and the lanterns helpers carry after dark, this frame.
  final _lampAlpha = <double>[];
  late final _lampHalos = [for (final l in village.lights) glow((l.r * 0.8).round(), _lampColor, add: true)];
  final _lanterns = <Pt>[];
  final _lanternHalo = glow(9, _lampColor, strength: 0.5, add: true);

  /// Where the plants in front lean, -1..1 each way, and where the pointer aims them (engine/pixi leanToPointer).
  final _lean = Vector2.zero();
  final _aim = Vector2.zero();

  /// The pointer over the world (art pixels), what it is on, and what it went down on.
  Vector2? _pointer;
  _Hit? _over;
  _Hit? _downOn;

  @override
  Color backgroundColor() => const Color(0xFF2B3320);

  /// Things further down the yard stand in front.
  static int _depth(double y) => (y * 10).round();

  Picture? _picture(String name, {double ax = 0.5, double ay = 0.5}) {
    if (!atlas.has(name)) return null;
    final info = atlas[name];
    return Picture(images.fromCache(info.asset), info.w, info.h, name: name, ax: ax, ay: ay);
  }

  (Image, Image)? _normalsOf(String name) => _normals[name];

  @override
  Future<void> onLoad() async {
    images.prefix = '';
    // Every drawing, once: poses change every frame and must be at hand.
    await images.loadAll([for (final n in atlas.names) atlas[n].asset]);
    camera.viewfinder.anchor = Anchor.topLeft;

    final map = images.fromCache(atlas['map'].asset);
    world.add(AtlasSprite(this, 'map')..priority = -100000);
    world.add(_Taps(this, Vector2(village.width, village.height)));

    // ── Plots ──
    for (final bed in beds) {
      final at = village.plotAt(bed.index);
      final sprite = AtlasSprite(this, 'plot-empty')
        ..position = Vector2(at.x, at.y)
        ..priority = _depth(at.y - plotH);
      final ring = _Ring(Rect.fromLTWH(at.x - plotW / 2 - 1, at.y - plotH - 4, plotW + 2, plotH + 5))..priority = sprite.priority + 5;
      world.addAll([sprite, ring]);
      _plots.add(_Plot(bed, sprite, ring));
    }

    // ── The manager and the dog, their shadows under them, below everything standing ──
    _manager = AtlasSprite(this, 'manager')
      ..position = Vector2(village.manager.x, village.manager.y)
      ..priority = _depth(village.manager.y);
    _dog = AtlasSprite(this, 'dog-sleep')
      ..position = Vector2(village.dog.x, village.dog.y)
      ..priority = _depth(village.dog.y);
    _managerFooting = _Footing(14);
    _dogFooting = _Footing(16);
    for (final (at, f) in [(village.manager, _managerFooting), (village.dog, _dogFooting)]) {
      f.cast.priority = _depth(at.y) - 6;
      f.contact.priority = _depth(at.y) - 5;
      world.addAll([f.cast, f.contact]);
    }
    world.addAll([_manager, _dog]);

    // ── Props: the things in the yard that open the farm's panels; each stands on a shadow right under it ──
    for (final p in village.props) {
      if (!atlas.has(p.sprite)) continue;
      final s = AtlasSprite(this, p.sprite)
        ..position = Vector2(p.at.x, p.at.y)
        ..priority = _depth(p.at.y);
      final foot = _Shadow(math.max(10, s.size.x * 0.9).round(), _shadowH + 1)
        ..position = Vector2(p.at.x, p.at.y - 1)
        ..priority = _depth(p.at.y) - 5;
      world.addAll([s, foot]);
      _props.add(_Prop(p.spot, s, p.at.y));
    }

    // The light: its shader now, the normal maps in the background (until they are ready, the village is drawn as painted).
    _shader = (await FragmentProgram.fromAsset('shaders/light.frag')).fragmentShader();
    _prepareNormals();

    // The plots' effects, then the yard's life, over everything standing in it.
    _fx = PlotFx(village: village, picture: _picture, normals: _normalsOf, density: atlas.density)..priority = 900000;
    _life = VillageLife(village: village, picture: _picture, normals: _normalsOf, map: (await map.toByteData())!, mapWidth: map.width, density: atlas.density)
      ..priority = 910000;
    world.addAll([_fx, _life]);

    // In front of the camera: plants framing the view, mostly out of the frame, so they frame the corners without
    // hiding the well, the pond or the houses; past the edges by far more than they lean (scene.ts).
    void plant(String name, double x, double y, Anchor anchor) {
      if (!atlas.has(name)) return;
      final s = AtlasSprite(this, name, fixedAnchor: anchor, near: true)
        ..position = Vector2(x, y)
        ..priority = 1000000;
      world.add(s);
      _near.add((s, Vector2(x, y)));
    }

    final w = village.width;
    final h = village.height;
    plant('fg-branch-left', -20, -30, Anchor.topLeft);
    plant('fg-branch-right', w + 20, -32, Anchor.topRight);
    plant('fg-bush-left', -30, h + 26, Anchor.bottomLeft);
    plant('fg-bush-right', w + 34, h + 32, Anchor.bottomRight);
    plant('fg-grass', w * 0.34, h + 16, Anchor.bottomCenter);
    plant('fg-fern', w * 0.6, h + 24, Anchor.bottomCenter);
  }

  int _stationOfHelper(String id) => (_data?.state.helpers.where((h) => h.id == id).firstOrNull?.play?.station ?? -1).toInt();

  // ── The pointer ────────────────────────────────────────────────────────────

  @override
  void onPointerMove(PointerMoveEvent event) {
    final p = event.canvasPosition;
    final c = canvasSize;
    if (c.x > 0 && c.y > 0) _aim.setValues(((p.x / c.x) * 2 - 1).clamp(-1, 1), ((p.y / c.y) * 2 - 1).clamp(-1, 1));
    _pointer = camera.globalToLocal(p);
    _setHover(_hitAt(_pointer!));
  }

  /// What is at `p` (world art pixels), the topmost first: helpers (the newest on top), the dog, the things in the
  /// yard, the plots (overlay.ts adds its regions in the reverse order).
  _Hit? _hitAt(Vector2 p) {
    final at = Offset(p.x, p.y);
    final data = _data;
    if (data != null) {
      final here = {for (final h in data.state.helpers) h.id};
      for (final MapEntry(:key, :value) in _actors.entries.toList().reversed) {
        if (here.contains(key) && value.leftAt == null && value.body.boxIn(value.node.position).contains(at)) return _HitHelper(key);
      }
    }
    if (_dog.boxIn().contains(at)) return const _HitDog();
    for (final MapEntry(key: spot, value: b) in village.spotBoxes.entries.toList().reversed) {
      if (p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 && p.y < b.y1) return _HitSpot(spot);
    }
    for (final plot in _plots.reversed) {
      final b = village.plotBox(plot.bed.index);
      if (p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 - 4 && p.y < b.y1 + 2) return _HitPlot(plot.bed.index);
    }
    return null;
  }

  int? _bedOf(_Hit? hit) => switch (hit) {
    _HitPlot(:final bed) => bed,
    _HitHelper(:final id) => _actors[id]?.bed?.index,
    _ => null,
  };

  /// The pointer moved onto `hit` (or off everything): what it left is told it is out, what it is on that it is over.
  void _setHover(_Hit? hit) {
    if (hit == _over) return;
    switch (_over) {
      case _HitPlot() || _HitHelper():
        final bed = _bedOf(_over);
        if (bed != null && hoverBed.value == bed) hoverBed.value = null;
        pressing.value = false;
      case _HitSpot(:final spot):
        if (hoverSpot.value == spot) hoverSpot.value = null;
      case _HitDog():
        _pup
          ..point(false)
          ..press(false);
      case null:
        break;
    }
    _over = hit;
    switch (hit) {
      case _HitPlot() || _HitHelper():
        final bed = _bedOf(hit);
        if (bed != null) hoverBed.value = bed;
      case _HitSpot(:final spot):
        hoverSpot.value = spot;
      case _HitDog():
        _pup.point(true);
      case null:
        break;
    }
  }

  void _down(Vector2 p) {
    _pointer = p.clone();
    final hit = _hitAt(p);
    _setHover(hit);
    _downOn = hit;
    switch (hit) {
      case _HitPlot() || _HitHelper():
        if (_bedOf(hit) != null) pressing.value = true;
      case _HitDog():
        _pup.press(true);
      case _HitSpot() || null:
        break;
    }
  }

  void _up(Vector2 p, {required bool touch}) {
    final hit = _hitAt(p);
    final down = _downOn;
    _downOn = null;
    pressing.value = false;
    if (hit is _HitDog) _pup.press(false);
    if (hit == down) _tap(hit, p);
    // A finger lifted is no longer over anything.
    if (touch) pointerExit();
  }

  void _cancel() {
    _downOn = null;
    pressing.value = false;
    _pup.press(false);
  }

  void _tap(_Hit? hit, Vector2 p) {
    switch (hit) {
      case _HitPlot(:final bed):
        onPlot?.call(bed);
      case _HitHelper(:final id):
        // Clicked, a helper hops; its plot answers as if clicked itself.
        final actor = _actors[id];
        if (actor == null) return;
        actor.hopAt = _t;
        final bed = actor.bed;
        if (bed != null) onPlot?.call(bed.index);
      case _HitSpot(:final spot):
        onSpot?.call(spot);
      case _HitDog():
        _petDog();
      case null:
        _life.poke(p.x, p.y);
    }
  }

  /// A pat: the dog does its next trick, a heart goes up, and it sounds like what it is (a cat purrs and meows).
  void _petDog() {
    final trick = _pup.pet(_t);
    final dog = village.dog;
    final cat = pet.value != 'dog';
    _life.heart(dog.x + 3, dog.y - 16);
    switch (trick) {
      case Trick.wake || Trick.wag:
        Sfx.play(cat ? 'purr' : 'pant');
      case Trick.bark:
        Sfx.play(cat ? 'meow' : 'woof');
      case Trick.jump:
        Sfx.play(cat ? 'mew' : 'yip');
      case Trick.belly:
        _life
          ..heart(dog.x - 4, dog.y - 12)
          ..heart(dog.x + 8, dog.y - 10);
        Sfx.play(cat ? 'purr' : 'pant');
    }
  }

  // ── A frame ────────────────────────────────────────────────────────────────

  @override
  void update(double dt) {
    super.update(dt);
    final step = dt.clamp(0, 0.1).toDouble();
    _t += step;
    if (daySpeed > 0) _tod = (_tod + step * daySpeed / _daySeconds) % 1;
    final data = _data;
    if (data == null) return;
    final state = data.state;
    final view = data.view;
    final level = view.level.level.round();
    final present = {for (final h in state.helpers) h.id: h};
    // Like Pixi's ticker, what is under a still pointer is found again as things move under it.
    if (_pointer != null && _downOn == null) _setHover(_hitAt(_pointer!));
    final hovered = hoverBed.value;

    Crop cropOf(Helper h) => view.plots[h.id]?.crop ?? Crop.sprout;

    // Plots: what grows, from the helper on it (or the one just leaving it); hovered it lifts a pixel, worked with a
    // tool it dips one.
    for (final p in _plots) {
      final bed = p.bed;
      final String crop;
      final unlock = bed.unlockLevel;
      if (unlock != null) {
        crop = level >= unlock ? 'flowering' : 'locked';
      } else {
        final worker = state.helpers.where((h) => h.play?.station.toInt() == bed.station).firstOrNull;
        final leaving = worker == null && _actors.values.any((a) => a.leftAt != null && a.station == bed.station);
        crop = leaving ? 'harvested' : (worker == null ? 'empty' : cropOf(worker).wire);
      }
      p.ripe = unlock == null && (crop == 'wheat' || crop == 'carrot');
      p.sprite.show('plot-$crop');
      final on = hovered == bed.index;
      p.ring.shown = on;
      final pressed = _fx.clock - (_fx.pressedAt[bed.index] ?? -1) < 0.15;
      p.sprite.y = village.plotAt(bed.index).y + (pressed ? 1 : (on ? -1 : 0));
    }

    // What a click would open lights up and lifts a pixel.
    final spot = hoverSpot.value;
    for (final p in _props) {
      p.sprite
        ..filter = p.spot == spot ? _brighter : null
        ..y = p.y - (p.spot == spot ? 1 : 0);
    }
    _manager.filter = spot == 'manager' ? _brighter : null;

    // The core's clocks: where each helper is among the buildings, and where it strolls around its plot.
    final moveOn = _t - _whereAt >= _whereTick;
    if (moveOn) _whereAt = _t;
    final stroll = _t - _strollAt >= _strollTick;
    if (stroll) _strollAt = _t;

    // Helpers: everyone on the farm walks to where it belongs; those gone walk to the gate and fade.
    final counts = <String, int>{};
    int crowd(String key) => counts[key] ?? 0;
    var queued = 0;
    for (final h in [...state.helpers]..sort((a, b) => a.id.compareTo(b.id))) {
      final station = (h.play?.station ?? -1).toInt();
      final crop = cropOf(h);
      final pose = poseOf(h, crop);
      final calls = plotCalls(crop);
      final queueIndex = station < 0 ? queued++ : 0;
      final look = lookOf(data.agents[h.agent], h.agent, atlas.has);
      var actor = _actors[h.id];
      if (actor != null && actor.leftAt != null) {
        // Back before it was gone: it is here again.
        actor
          ..leftAt = null
          ..goneFor = 0;
      }
      if (station >= 0 && actor != null) {
        // A newcomer walks in to its own plot first, whatever it is already busy with (village.ts moveOn).
        final where = actor.where ??= Whereabouts('plot', _t, _placeFor(h, crop), _t);
        if (moveOn) where.moveOn(_placeFor(h, crop), _t, urgent: calls);
        if (stroll) _strollOn(actor, h, crop, pose);
      } else if (actor != null) {
        actor
          ..where = null
          ..stroll = null;
      }
      final goal = village.goalOf(
        here: true,
        station: station,
        queueIndex: queueIndex,
        calls: calls,
        place: actor?.where?.place ?? 'plot',
        stroll: actor?.stroll,
        pose: pose,
        crowd: crowd,
      );
      counts[goal.key] = crowd(goal.key) + 1;
      if (actor == null) {
        actor = _newActor(look, goal);
        _actors[h.id] = actor;
        if (station >= 0) actor.where = Whereabouts('plot', _t, _placeFor(h, crop), _t);
      }
      actor
        ..look = look
        ..station = station
        ..bed = bedOfStation(station)
        ..goal = goal;
      actor.walker
        ..go(goal.at)
        ..step(step);
      _draw(actor, pose, station);
    }
    for (final MapEntry(key: id, value: actor) in _actors.entries.toList()) {
      if (present.containsKey(id)) continue;
      actor.leftAt ??= _t;
      if (_t - actor.leftAt! >= _goneS) {
        actor.node.removeFromParent();
        _actors.remove(id);
        continue;
      }
      actor.goal = Goal('gate', village.gate);
      actor.walker
        ..go(village.gate)
        ..step(step);
      _draw(actor, 'idle', actor.station);
      if (!actor.walker.walking) actor.goneFor += step;
    }
    for (final a in _actors.values) {
      a.alpha = math.max(0, 1 - a.goneFor / _fadeS);
      a.body.opacity = a.alpha;
    }

    _fx.step(step);

    // The manager talks and listens, bobbing as he talks and breathing slowly the rest of the time; his feet stay put.
    final mood = state.foreman;
    final chosen = managerLook.value;
    final base = chosen != 'farmer' && managerLooks.any((l) => l.id == chosen) && atlas.has('manager-$chosen') ? 'manager-$chosen' : 'manager';
    final managerPose = switch (mood) {
      ForemanState.speaking => '$base-talk',
      ForemanState.listening => '$base-listen',
      _ => base,
    };
    _manager.show(atlas.has(managerPose) ? managerPose : base);
    _manager.rise((mood == ForemanState.speaking ? frameAt(_t, 2, 4) : frameAt(_t, 2, 0.6)).toDouble());

    // The dog (or the cat in its poses) keeps its own day; it sits up for a call or the voice.
    final dogLook = _pup.look(_t, state.call == CallState.live || voiceLive.value);
    final awake = dogLook.picture != 'dog-sleep';
    final petName = pet.value;
    final petPicture = petName == 'dog' ? dogLook.picture : dogLook.picture.replaceFirst('dog-', '$petName-');
    _dog
      ..show(atlas.has(petPicture) ? petPicture : dogLook.picture)
      ..y = village.dog.y - dogLook.lift
      ..rise(dogLook.grow);

    // Light: the sky by the time of day; lamps flicker a little, in steps, their halo the glass.
    _sky = skyAt(_tod);
    final night = _sky.night;
    _lights.clear();
    _lampAlpha.clear();
    for (var i = 0; i < village.lights.length; i++) {
      final l = village.lights[i];
      final flicker = 0.9 + 0.1 * frameAt(_t + i * 0.37, 2, 3);
      _lampAlpha.add(night * flicker);
      _lights.add((x: l.at.x, y: l.at.y, z: 14, radius: l.r * 2.6, color: _lampColor, intensity: 1.3 * night * flicker));
    }
    // Shadows fall away from the sun; helpers carry lanterns after dark.
    final lean = _shadowLean(_sky);
    _managerFooting.fall(village.manager, lean);
    _dogFooting.fall(village.dog, lean);
    _lanterns.clear();
    for (final a in _actors.values) {
      a.footing.fall(const Pt(0, 0), lean, a.alpha);
      final lit = night > _lanternDark ? ((night - _lanternDark) / (1 - _lanternDark)) * a.alpha : 0.0;
      if (lit <= 0) continue;
      final side = a.walker.facing == 'left' ? -5.0 : 5.0;
      _lanterns.add(Pt(a.node.x + side - 1, a.node.y - 12));
      _lights.add((x: a.node.x + side, y: a.node.y - 11, z: 10, radius: 34, color: _lanternColor, intensity: 0.6 * lit));
    }

    // The yard's own life: what helpers are doing shows at the buildings they do it at.
    final busy = <String, int>{};
    final walkers = <Pt>[];
    for (final a in _actors.values) {
      if (a.walker.walking) {
        walkers.add(Pt(a.walker.x, a.walker.y));
      } else if (_placePose.containsKey(a.goal.key)) {
        busy[a.goal.key] = (busy[a.goal.key] ?? 0) + 1;
      }
    }
    final ripe = [
      for (final p in _plots)
        if (p.ripe) village.plotBox(p.bed.index),
    ];

    // The plants in front of the camera are out of the light's reach: they take the sky's colour, a little darker.
    // They lean towards the pointer, and drift a little on their own (leanToPointer: 70% the pointer, eased).
    final k = math.min(1.0, step * 2.5);
    _lean.x += (_aim.x * 0.7 + math.sin(_t * 0.13) * 0.3 - _lean.x) * k;
    _lean.y += (_aim.y * 0.7 + math.sin(_t * 0.09 + 1.3) * 0.3 - _lean.y) * k;
    final flat = flatLight(_sky);
    int c(double v) => (v * 0.82 * 255).round().clamp(0, 255);
    final tint = ColorFilter.mode(Color.fromARGB(255, c(flat.$1), c(flat.$2), c(flat.$3)), BlendMode.modulate);
    for (final (s, at) in _near) {
      s
        ..position = Vector2(at.x + (_lean.x * _nearLean).roundToDouble(), at.y + (_lean.y * _nearLean).roundToDouble())
        ..filter = _normalsReady ? tint : null;
    }
    _lights
      ..addAll(_fx.lights)
      ..addAll(_life.step(LifeFrame(t: _t, dt: step, night: night, walkers: walkers, busy: busy, ripe: ripe, dogAsleep: !awake)));

    heads
      ..clear()
      ..addAll({
        for (final MapEntry(:key, :value) in _actors.entries)
          if (present.containsKey(key)) key: Pt(value.walker.x.roundToDouble(), value.walker.y.roundToDouble() - 31),
      });
    frames.value++;
  }

  /// Where a helper wants to be now (village.ts placeFor): back at its plot when it calls, else where its work is.
  String _placeFor(Helper h, Crop crop) {
    if (plotCalls(crop)) return 'plot';
    final phase = h.phase;
    return phase is PhaseWorking ? placeOfAction(phase.doing.action) : 'plot';
  }

  /// Moves a helper on around its plot when what it does changes, and every few seconds anyway (farm.ts runStrolls).
  void _strollOn(_Actor actor, Helper h, Crop crop, String pose) {
    final allowed = spotsFor(h, crop, pose);
    final current = actor.stroll;
    if (current != null && allowed.contains(current.spot) && _t < current.until) return;
    // Somewhere else if there is anywhere else; the lawn has several places, so 'rest' may repeat.
    final options = current != null && allowed.length > 1 ? allowed.where((s) => s != current.spot || s == 'rest').toList() : allowed;
    final spot = options[_random.nextInt(options.length)];
    final (lo, hi) = strollDwell[h.phase is PhaseWorking ? 'working' : 'other']!;
    actor.stroll = Stroll(spot, _random.nextInt(restSpots), _t + lo + _random.nextDouble() * (hi - lo));
  }

  _Actor _newActor(String look, Goal goal) {
    final footing = _Footing(12);
    final body = AtlasSprite(this, '$look-down');
    final node = PositionComponent()..addAll([footing.cast, footing.contact, body]);
    footing.cast.priority = 0;
    footing.contact.priority = 1;
    body.priority = 2;
    // Everyone walks in from the gate.
    final walker = Walker(village.gate, _walkSpeed, village.nav.route)..go(goal.at);
    world.add(node);
    return _Actor(node, body, footing, walker, look, goal);
  }

  void _draw(_Actor actor, String pose, int station) {
    final w = actor.walker;
    final look = actor.look;
    final goal = actor.goal;
    actor.node
      ..position = Vector2(w.x.roundToDouble(), w.y.roundToDouble())
      ..priority = _depth(w.y);
    String name;
    var flip = false;
    // Off the ground (a jump), and how much taller it stands with its feet where they are (a breath, a stroke).
    var lift = 0.0;
    var grow = 0.0;
    String side(String f) => f == 'left' || f == 'right' ? 'side' : f;
    final atBuilding = _placePose.containsKey(goal.key);
    if (w.walking) {
      final dir = side(w.facing);
      final cycle = ['$dir-1', dir, '$dir-2', dir];
      name = '$look-${cycle[frameAt(_t, 4, _walkFps)]}';
      flip = w.facing == 'left';
    } else if (atBuilding && atlas.has('$look-${_placePose[goal.key]!.$1.first}')) {
      // At a building it does what is done there, on what is there: sits on the bench, reads at the library, hammers
      // at the anvil (from its side), works the radio's box at the mast. A pose of one frame breathes.
      final (frames, fps) = _placePose[goal.key]!;
      name = '$look-${frames[frameAt(_t, frames.length, fps)]}';
      flip = goal.facing == 'left';
      if (frames.length == 1) grow = frameAt(_t + station * 0.3, 2, 0.8).toDouble();
    } else {
      final facing = goal.facing ?? w.facing;
      switch (pose) {
        case 'work':
          // It dips with every stroke: into the soil at its plot (the pose with the tool), at what is there at a
          // building, facing it.
          name = atBuilding ? '$look-${side(facing)}' : '$look-work';
          flip = atBuilding && facing == 'left';
          grow = -frameAt(_t, 2, 3).toDouble();
        case 'cheer':
          name = '$look-cheer';
          // It jumps for joy.
          lift = frameAt(_t, 2, 2) * 2.0;
        case 'worry':
          name = '$look-worry';
        default:
          name = '$look-${side(facing)}';
          flip = facing == 'left';
          // A slow breath: one pixel, now and then.
          grow = frameAt(_t + station * 0.3, 2, 0.8).toDouble();
      }
    }
    final hop = _t - actor.hopAt;
    if (hop < _hopS) lift += _hop[((hop / _hopS) * _hop.length).floor().clamp(0, _hop.length - 1)];
    actor.body
      ..show(atlas.has(name) ? name : '$look-down')
      ..position = Vector2(0, -lift)
      ..scale = Vector2(flip ? -1 : 1, 1)
      ..rise(grow);
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  @override
  void renderTree(Canvas canvas) {
    final shader = _shader;
    // The canvas, in screen pixels (the game's `size` is the camera's art pixels).
    final w = canvasSize.x;
    final h = canvasSize.y;
    if (w <= 0 || h <= 0) return;
    final ww = village.width;
    final wh = village.height;
    final k = w / ww;
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..color = backgroundColor());
    if (shader == null || !_normalsReady) {
      // Until the light is ready, as painted.
      canvas.save();
      canvas.scale(k);
      renderPass = RenderPass.color;
      _renderWorld(canvas);
      _drawOver(canvas);
      canvas.restore();
      return;
    }
    final dpr = PlatformDispatcher.instance.views.first.devicePixelRatio;
    final cw = (w * dpr).round();
    final ch = (h * dpr).round();

    // The world as painted, at the screen's own pixels.
    renderPass = RenderPass.color;
    final paintedRec = PictureRecorder();
    final painted = Canvas(paintedRec)
      ..drawColor(backgroundColor(), BlendMode.src)
      ..scale(k * dpr);
    _renderWorld(painted);
    final color = paintedRec.endRecording().toImageSync(cw, ch);

    // The same with every sprite's normal map, at the drawings' density; what is not a sprite is lit as flat ground.
    renderPass = RenderPass.normals;
    final d = atlas.density;
    final normalsRec = PictureRecorder();
    final facing = Canvas(normalsRec)
      ..drawColor(const Color(0xFF8080FF), BlendMode.src)
      ..scale(d);
    _renderWorld(facing);
    final normals = normalsRec.endRecording().toImageSync((ww * d).round(), (wh * d).round());

    // The light (light.frag's uniforms, in its order).
    final sky = _sky;
    var i = 0;
    void put(double v) => shader.setFloat(i++, v);
    void put3((double, double, double) v) {
      put(v.$1);
      put(v.$2);
      put(v.$3);
    }

    put(w);
    put(h);
    put(ww);
    put(wh);
    put(cw.toDouble());
    put(ch.toDouble());
    put3(sky.ambient);
    put3(sky.sunDir);
    put3(sky.sun);
    put3(sky.mist);
    put(sky.mistAmount);
    put(sky.clouds);
    put(sky.grade.exposure);
    put(sky.grade.saturation);
    put(sky.grade.lift);
    put(sky.grade.vignette);
    put3(sky.grade.shadows);
    put3(sky.grade.highlights);
    put(_t);
    final shown =
        (_lights.where((l) => l.intensity > 0.01 && l.radius > 0).toList()..sort((a, b) => (b.intensity * b.radius).compareTo(a.intensity * a.radius)))
            .take(_maxLights)
            .toList();
    put(shown.length.toDouble());
    for (var n = 0; n < _maxLights; n++) {
      final l = n < shown.length ? shown[n] : null;
      put(l?.x ?? 0);
      put(l?.y ?? 0);
      put(l?.z ?? 0);
      put(l?.radius ?? 0);
    }
    for (var n = 0; n < _maxLights; n++) {
      final l = n < shown.length ? shown[n] : null;
      put(l == null ? 0 : l.color.r * l.intensity);
      put(l == null ? 0 : l.color.g * l.intensity);
      put(l == null ? 0 : l.color.b * l.intensity);
      put(0);
    }
    shader
      ..setImageSampler(0, color)
      ..setImageSampler(1, normals);
    canvas.drawRect(Rect.fromLTWH(0, 0, w, h), Paint()..shader = shader);

    canvas.save();
    canvas.scale(k);
    _drawOver(canvas);
    canvas.restore();
    renderPass = RenderPass.color;
    color.dispose();
    normals.dispose();
  }

  /// Over the lit picture, in art pixels (scene.ts's layers over the world): what shines (the yard's sparks and
  /// fireflies, the lamps' glass, the lanterns), the marks, then the plants in front of the camera.
  void _drawOver(Canvas canvas) {
    renderPass = RenderPass.glows;
    _renderWorld(canvas);
    _drawLamps(canvas);
    renderPass = RenderPass.marks;
    _renderWorld(canvas);
    renderPass = RenderPass.near;
    _renderWorld(canvas);
    renderPass = RenderPass.color;
  }

  /// The world drawn once into canvas, as the camera would: Flame's world expects its camera on the stack while it renders.
  void _renderWorld(Canvas canvas) {
    CameraComponent.currentCameras.add(camera);
    try {
      world.renderFromCamera(canvas);
    } finally {
      CameraComponent.currentCameras.removeLast();
    }
  }

  /// The glow around each lamp's glass, and the lanterns helpers carry: a warm 2×3 speck with a brighter heart in a
  /// soft glow, added.
  void _drawLamps(Canvas canvas) {
    for (var i = 0; i < village.lights.length && i < _lampAlpha.length; i++) {
      final l = village.lights[i];
      drawLook(canvas, _lampHalos[i], l.at.x, l.at.y, alpha: _lampAlpha[i], pass: RenderPass.glows);
    }
    final flame = Paint()..blendMode = BlendMode.plus;
    for (final at in _lanterns) {
      drawLook(canvas, _lanternHalo, at.x + 1, at.y + 1.5, pass: RenderPass.glows);
      canvas
        ..drawRect(Rect.fromLTWH(at.x, at.y, 2, 3), flame..color = const Color(0xFFFFB347))
        ..drawRect(Rect.fromLTWH(at.x, at.y + 1, 2, 1), flame..color = const Color(0xFFFFF1C2));
    }
  }
}

/// Nothing where a picture is not: an image's pixels are drawn premultiplied, so a transparent one must be all zero, or
/// its normal would be added onto the ground's.
Uint8List _clear(Uint8List rgba) {
  for (var i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] == 0) rgba.fillRange(i, i + 3, 0);
  }
  return rgba;
}

extension on VillageGame {
  /// Every sprite's normal maps, worked out once from its pixels in the background (the ground, the plots and the
  /// rest shaped as normals.dart says), then made into pictures.
  Future<void> _prepareNormals() async {
    final names = atlas.names.toList();
    final pixels = <String, (Uint8List, int, int)>{};
    for (final n in names) {
      final image = images.fromCache(atlas[n].asset);
      final bytes = await image.toByteData();
      if (bytes != null) pixels[n] = (bytes.buffer.asUint8List(), image.width, image.height);
    }
    final made = await Isolate.run(() {
      final out = <String, (Uint8List, Uint8List, int, int)>{};
      for (final MapEntry(key: n, value: (rgba, w, h)) in pixels.entries) {
        final options = n == 'map' ? groundNormals : (n.startsWith('plot-') ? lowNormals : spriteNormals);
        final normals = normalsOf(rgba, w, h, options);
        out[n] = (_clear(normals), _clear(mirrorNormals(normals)), w, h);
      }
      return out;
    });
    Future<Image> picture(Uint8List rgba, int w, int h) async {
      final buffer = await ImmutableBuffer.fromUint8List(rgba);
      final codec = await ImageDescriptor.raw(buffer, width: w, height: h, pixelFormat: PixelFormat.rgba8888).instantiateCodec();
      return (await codec.getNextFrame()).image;
    }

    for (final MapEntry(key: n, value: (normal, mirrored, w, h)) in made.entries) {
      _normals[n] = (await picture(normal, w, h), await picture(mirrored, w, h));
    }
    _normalsReady = true;
  }
}
