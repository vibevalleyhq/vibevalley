import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../data/voice.dart';
import '../chat/chat_state.dart' show chatOpenProvider;
import '../data/remote.dart' show agentsProvider;
import 'chat_window.dart';
import 'cursors.dart';
import 'panels.dart';
import '../game/commands.dart';
import '../game/destinations.dart';
import '../game/tools.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../phone/phone.dart';
import '../debug/debug_commands.dart';
import '../debug/debug_panel.dart' show typing;
import '../shared/farm_sounds.dart';
import '../game/effects.dart';
import '../data/prefs.dart';
import '../audio/sfx.dart';
import '../data/ui_state.dart';
import '../sprites/atlas.dart';
import '../ui/pixel/pixel.dart';
import '../village/world.dart' show VillageWorld;
import '../village/game.dart';
import 'first_visit.dart';
import 'input.dart';
import '../village/hud.dart';
import '../village/framing.dart';
import '../village/village_view.dart';
import '../voice/voice.dart';

const firstNamesTime = Duration(milliseconds: 6000);

class FarmPage extends ConsumerStatefulWidget {
  const FarmPage({super.key});

  @override
  ConsumerState<FarmPage> createState() => _FarmPageState();
}

class _FarmPageState extends ConsumerState<FarmPage> {
  VoiceCall get call => ref.read(voiceCallProvider);
  VillageGame? _game;
  final _subs = <StreamSubscription<Object?>>[];
  late final AppLifecycleListener _life;

  final _pointer = ValueNotifier<Offset?>(null);
  Timer? _namesTimer;
  var _namesChecked = false;

  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
    _life = AppLifecycleListener(onInactive: _hideNames, onHide: _hideNames);
    _subs.add(
      ref.read(farmEffectsProvider).listen((e) {
        _game?.play(e);
        if (e is GameEffectReward) ref.read(rewardsProvider.notifier).push(e);
      }),
    );
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    _life.dispose();
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _namesTimer?.cancel();
    _pointer.dispose();
    super.dispose();
  }

  bool get _active => mounted && TickerMode.valuesOf(context).enabled && !ref.read(titleOpenProvider);

  Future<void> _clickPlot(int index) async {
    final bed = beds[index];
    final commands = ref.read(farmCommandsProvider);
    final aim = commands.aim(bed);
    if (aim.aim.ok) Sfx.play('tap');
    final ToolResult got;
    try {
      got = await commands.act(aim);
    } on Object {
      // The server said no: its notice says why.
      return;
    }
    if (!mounted) return;
    switch (got) {
      case ToolRefused() || ToolDone():
        return;
      case ToolSow(:final station):
        ref.read(farmOverlaysProvider.notifier).sow(station);
      case ToolInspect(:final sessionId):
        ref.read(farmOverlaysProvider.notifier).select(sessionId);
      case ToolWater(:final sessionId):
        ref.read(farmOverlaysProvider.notifier).water(sessionId);
      case ToolReview(:final sessionId):
        ref.read(farmOverlaysProvider.notifier).review(sessionId);
    }
  }

  void _openSpot(YardPlace place) {
    Sfx.play('open');
    if (place.panel case final panel?) ref.read(farmOverlaysProvider.notifier).panel(panel);
    if (place.route case final route?) context.go(route);
  }

  void _openSession(String id) => ref.read(farmOverlaysProvider.notifier).select(id);

  void _openTaskBoard(String? graph) {
    if (graph != null) ref.read(graphShownProvider.notifier).set(graph);
    ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.taskBoard);
  }

  bool get _anyLayer => ref.read(farmOverlaysProvider).any;

  bool _onKey(KeyEvent e) {
    final keys = HardwareKeyboard.instance;
    final action = farmKey(
      key: e.logicalKey,
      keyDown: e is KeyDownEvent,
      active: _active,
      typing: typing(),
      meta: keys.isMetaPressed,
      control: keys.isControlPressed,
      alt: keys.isAltPressed,
      layersOpen: _anyLayer,
      held: ref.read(heldToolProvider),
    );
    switch (action) {
      case null:
        return false;
      case FarmReveal(:final down):
        _game?.revealNames.value = down;
        return false;
      case FarmCloseTool():
        ref.read(heldToolProvider.notifier).set(Tool.hand);
        return true;
      case FarmOpenMenu():
        Sfx.play('open');
        ref.read(farmOverlaysProvider.notifier).menu(true);
        return true;
      case FarmPickTool(:final tool):
        ref.read(heldToolProvider.notifier).set(tool);
        return true;
    }
  }

  void _hideNames() => _game?.revealNames.value = false;

  Future<void> _firstVisit() async {
    _namesChecked = true;
    final seen = await markNamesSeen();
    if (seen || !mounted) return;
    _game?.revealNames.value = true;
    _namesTimer = Timer(firstNamesTime, _hideNames);
    toasts.add(title: '院子里挂着木牌的都能点', description: '按住 ⌥（Alt）随时看所有名字；Esc 菜单里也列着', timeout: firstNamesTime);
  }

  VillageGame _gameFor(SpriteAtlas atlas, VillageWorld village) {
    final game = VillageGame(atlas: atlas, village: village);
    game
      ..onPlot = ((bed) => unawaited(_clickPlot(bed)))
      ..onSpot = _openSpot;
    // Once this build is done: no provider changes while building.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref
          .read(debugHooksProvider.notifier)
          .set(
            DebugHooks(
              tod: () => game.tod,
              setTod: game.setTimeOfDay,
              daySpeed: () => game.daySpeed,
              setDaySpeed: (n) => game.daySpeed = n,
              openSession: _openSession,
            ),
          );
    });
    return game;
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(voiceCallProvider);
    final atlas = ref.watch(atlasProvider).value;
    final village = ref.watch(villageProvider).value;
    final state = ref.watch(stateProvider);
    final view = ref.watch(viewProvider);
    final agents = ref.watch(agentsProvider).value ?? const <String, Agent>{};
    final problem = ref.watch(streamProblemProvider).value;
    final prefs = ref.watch(prefsProvider);
    final titleOpen = ref.watch(titleOpenProvider);

    ref.listen(bedFxProvider, (prev, next) {
      final seen = {for (final f in prev ?? const <BedFxEntry>[]) f.id};
      for (final f in next) {
        if (!seen.contains(f.id)) _game?.burst(f.kind, f.bed);
      }
    });
    ref.listen(phoneTargetProvider, (_, target) {
      switch (target) {
        case PhoneTargetSession(:final id):
          _openSession(id);
        case PhoneTargetTaskBoard(:final graph):
          _openTaskBoard(graph);
        case null:
          break;
      }
    });

    if (atlas == null || village == null || state == null || view == null) {
      return Scaffold(
        backgroundColor: Palette.ground,
        body: Center(
          child: Text(
            problem == null ? '在等农场……（server 开着吗？）' : '连上了，但拿不到状态：$problem\n（服务端要是改过代码，得重启）',
            textAlign: TextAlign.center,
            style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream200),
          ),
        ),
      );
    }
    final game = _game ??= _gameFor(atlas, village);
    game
      ..show(VillageData(state, view, agents))
      ..managerLook.value = prefs.managerLook ?? 'farmer'
      ..pet.value = prefs.petOrDog
      ..voiceLive.value = call.phase == CallPhase.live;
    if (!_namesChecked && !titleOpen) unawaited(_firstVisit());

    final held = ref.watch(heldToolProvider);
    final fx = ref.watch(bedFxProvider);
    final hotspots = ref.watch(cursorHotspotsProvider).value;
    final open = {...ref.watch(farmOverlaysProvider).soundFlags, 'friends': ref.watch(friendsOpenProvider), 'chat': ref.watch(chatOpenProvider)};

    return FarmSounds(
      tool: held.name,
      bedFx: [for (final f in fx) (id: f.id, kind: f.kind.name)],
      open: open,
      call: call,
      effects: ref.watch(farmEffectsProvider),
      child: Scaffold(
        backgroundColor: Palette.ground,
        body: Semantics(
          label: '码农场物语的像素农场',
          container: true,
          child: LayoutBuilder(
            builder: (context, window) {
              final chat = ChatWindow(state: state, atlas: atlas, agents: agents, call: call);
              return _farm(window, game, village, atlas, held, hotspots, chat);
            },
          ),
        ),
      ),
    );
  }

  Widget _farm(BoxConstraints box, VillageGame game, VillageWorld village, SpriteAtlas atlas, Tool held, Map<String, Offset>? hotspots, Widget chat) {
    final framing = frameVillage(box.biggest, Size(village.width, village.height));
    final scale = framing.scale;
    final shown = framing.shown;
    final bars = shown.size != box.biggest;
    return Stack(
      children: [
        if (bars) Positioned.fill(child: _Surroundings(asset: atlas['map'].asset)),
        Positioned.fromRect(
          rect: framing.box,
          child: Stack(
            children: [
              Positioned.fill(
                child: MouseRegion(
                  opaque: false,
                  onHover: (e) => _pointer.value = e.localPosition,
                  onExit: (_) => _pointer.value = null,
                  child: ListenableBuilder(
                    listenable: Listenable.merge([game.hoverBed, game.hoverSpot, game.pressing]),
                    builder: (context, _) {
                      final name = _cursorName(game, held);
                      return VillageCanvas(game: game, cursor: hotspots?[name] != null ? SystemMouseCursors.none : systemCursorOf(name));
                    },
                  ),
                ),
              ),
              Positioned.fill(
                child: VillageOverlay(game: game, scale: scale),
              ),
              if (hotspots != null)
                Positioned.fill(
                  child: IgnorePointer(
                    child: ListenableBuilder(
                      listenable: Listenable.merge([_pointer, game.hoverBed, game.hoverSpot, game.pressing]),
                      builder: (context, _) {
                        final at = _pointer.value;
                        final name = _cursorName(game, held);
                        final spot = hotspots[name];
                        return Stack(
                          children: [if (at != null && spot != null) CursorPicture(name: name, at: at, hotspot: spot)],
                        );
                      },
                    ),
                  ),
                ),
            ],
          ),
        ),
        Positioned.fromRect(
          rect: shown,
          child: VillageHud(game: game, call: call),
        ),
        Positioned(right: 12, bottom: 12, child: chat),
        Positioned.fill(
          child: FxLayer(call: call, effects: ref.watch(farmEffectsProvider)),
        ),
        const Positioned.fill(child: FarmPanels()),
      ],
    );
  }

  String _cursorName(VillageGame game, Tool tool) {
    final index = game.hoverBed.value;
    final bed = index == null || index < 0 || index >= beds.length ? null : beds[index];
    final aim = bed == null ? null : ref.read(farmCommandsProvider).aim(bed);
    return stageCursor(tool: aim?.tool ?? tool, aim: aim?.aim, overSpot: game.hoverSpot.value != null, pressed: game.pressing.value);
  }
}

/// So the bars read as more of the land rather than a frame.
class _Surroundings extends StatelessWidget {
  const _Surroundings({required this.asset});
  final String asset;

  @override
  Widget build(BuildContext context) => ColorFiltered(
    colorFilter: ColorFilter.mode(Palette.ground.withValues(alpha: 0.72), BlendMode.srcATop),
    child: Image.asset(asset, fit: BoxFit.cover, filterQuality: FilterQuality.none),
  );
}
