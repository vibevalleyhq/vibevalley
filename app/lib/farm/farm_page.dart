import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/providers.dart';
import '../chat/chat_state.dart' show chatActionsProvider, chatOpenProvider;
import '../data/remote.dart' show agentsProvider, workStepsProvider;
import '../desktop/desktop.dart';
import 'chat_window.dart';
import 'cursors.dart';
import 'panels.dart';
import 'work_log.dart';
import '../game/commands.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../phone/phone.dart';
import '../shell/debug/debug_commands.dart';
import '../shell/debug/debug_panel.dart' show typing;
import '../shell/farm_sounds.dart' hide BedFx;
import '../shell/fx_layer.dart';
import '../shell/prefs.dart';
import '../shell/sfx.dart';
import '../shell/title/title_state.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../village/world.dart' show VillageWorld;
import '../village/game.dart';
import '../village/hud.dart';
import '../village/framing.dart';
import '../village/village_view.dart';
import '../voice/voice.dart';

const namesSeenKey = 'vibevalley.pixel.names-seen';

const firstNamesTime = Duration(milliseconds: 6000);

class FarmPage extends ConsumerStatefulWidget {
  const FarmPage({super.key});

  @override
  ConsumerState<FarmPage> createState() => _FarmPageState();
}

class _FarmPageState extends ConsumerState<FarmPage> {
  /// Made the first time it is needed, never in dispose: ref is gone by then.
  VoiceCall? _call;
  VoiceCall get call => _call ??= VoiceCall(
    ref.read(apiProvider),
    agentPick: () {
      final pick = ref.read(prefsProvider).pick;
      return pick == 'auto' ? null : pick;
    },
  )..addListener(_voice);
  VillageGame? _game;
  final _subs = <StreamSubscription<Object?>>[];
  late final AppLifecycleListener _life;

  final _pointer = ValueNotifier<Offset?>(null);
  Timer? _namesTimer;
  var _namesChecked = false;

  @override
  void initState() {
    super.initState();
    installTurnSteps();
    HardwareKeyboard.instance.addHandler(_onKey);
    _life = AppLifecycleListener(onInactive: _hideNames, onHide: _hideNames);
    _subs
      ..add(
        ref.read(farmEffectsProvider).listen((e) {
          _game?.play(e);
          if (e is GameEffectReward) ref.read(rewardsProvider.notifier).push(e);
        }),
      )
      ..add(ref.read(desktopProvider).commands.listen(_command));
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
    _call
      ?..removeListener(_voice)
      ..dispose();
    super.dispose();
  }

  void _voice() {
    if (mounted) setState(() {});
    _game?.voiceLive.value = call.phase == CallPhase.live;
  }

  bool get _active => mounted && TickerMode.valuesOf(context).enabled && !ref.read(titleOpenProvider);

  Future<void> _clickPlot(int index) async {
    final bed = beds[index];
    final state = ref.read(stateProvider);
    final view = ref.read(viewProvider);
    if (state == null || view == null) return;
    final session = bed.unlockLevel == null ? stationOf(state.sessions, bed.station) : null;
    final plot = bed.unlockLevel != null ? lockedPlot(bed, view.level.level.round()) : plotOf(view, session);
    if (aimTool(ref.read(heldToolProvider), bed, session, plot, view.level.level.round()).ok) Sfx.play('tap');
    final ToolResult result;
    try {
      result = await ref.read(farmCommandsProvider).applyTool(bed);
    } on Object {
      // The server said no: its notice says why.
      return;
    }
    if (!mounted) return;
    switch (result) {
      case ToolRefused() || ToolDone():
        return;
      case ToolSow(:final station):
        ref.read(sowingProvider.notifier).set(station);
      case ToolInspect(:final sessionId):
        ref.read(selectedProvider.notifier).set(sessionId);
      case ToolWater(:final sessionId):
        ref.read(wateringProvider.notifier).set(sessionId);
      case ToolReview(:final sessionId):
        ref.read(reviewingProvider.notifier).set(sessionId);
    }
  }

  void _openSpot(String spot) {
    Sfx.play('open');
    switch (spot) {
      case 'shop':
        ref.read(panelProvider.notifier).set(FarmPanel.shop);
      case 'warehouse':
        ref.read(panelProvider.notifier).set(FarmPanel.warehouse);
      case 'tasks':
        ref.read(panelProvider.notifier).set(FarmPanel.tasks);
      case 'log':
        ref.read(panelProvider.notifier).set(FarmPanel.log);
      case 'plans':
        ref.read(panelProvider.notifier).set(FarmPanel.plans);
      case 'manager':
        ref.read(panelProvider.notifier).set(FarmPanel.manager);
      case 'agents':
        context.go('/agents');
      case 'runtimes':
        context.go('/runtimes');
      case 'skills':
        context.go('/skills');
    }
  }

  void _openSession(String id) => ref.read(selectedProvider.notifier).set(id);

  void _openPlans(String? playbook) {
    if (playbook != null) ref.read(planShownProvider.notifier).set(playbook);
    ref.read(panelProvider.notifier).set(FarmPanel.plans);
  }

  /// The farm is brought in front first (from a desk page, from the title screen), else it would open where nobody sees it.
  void _toFarm() {
    ref.read(titleOpenProvider.notifier).enterFarm(start: false);
    final router = GoRouter.maybeOf(context);
    if (router != null && router.routerDelegate.currentConfiguration.uri.path != '/') router.go('/');
  }

  void _command(DesktopCommand c) {
    if (!mounted) return;
    if (c is! DesktopVoice) _toFarm();
    switch (c) {
      case DesktopVoice():
        unawaited(call.phase == CallPhase.idle ? call.start() : call.end());
      case DesktopOpenSession(:final id):
        _openSession(id);
      case DesktopOpenChat(:final conversation):
        ref.read(chatOpenProvider.notifier).set(true);
        fire(ref.read(chatActionsProvider).showChat(conversation));
      case DesktopOpenPlans(:final playbook):
        _openPlans(playbook);
      case DesktopOpenAchievements():
        ref.read(panelProvider.notifier).set(FarmPanel.tasks);
    }
  }

  bool get _anyLayer =>
      ref.read(menuOpenProvider) ||
      ref.read(panelProvider) != null ||
      ref.read(selectedProvider) != null ||
      ref.read(sowingProvider) != null ||
      ref.read(wateringProvider) != null ||
      ref.read(reviewingProvider) != null;

  bool _onKey(KeyEvent e) {
    if (!_active) return false;
    final keys = HardwareKeyboard.instance;
    if (e.logicalKey == LogicalKeyboardKey.altLeft || e.logicalKey == LogicalKeyboardKey.altRight || e.logicalKey == LogicalKeyboardKey.alt) {
      _game?.revealNames.value = keys.isAltPressed;
      return false;
    }
    if (e is! KeyDownEvent || keys.isMetaPressed || keys.isControlPressed || keys.isAltPressed || typing()) return false;
    if (e.logicalKey == LogicalKeyboardKey.escape) {
      // A dialog takes its own Esc; then the tool goes down; then the menu opens.
      if (_anyLayer) return false;
      if (ref.read(heldToolProvider) != Tool.hand) {
        ref.read(heldToolProvider.notifier).set(Tool.hand);
      } else {
        Sfx.play('open');
        ref.read(menuOpenProvider.notifier).set(true);
      }
      return true;
    }
    final tool = toolForKey(e.logicalKey);
    if (tool == null) return false;
    ref.read(heldToolProvider.notifier).set(tool);
    return true;
  }

  void _hideNames() => _game?.revealNames.value = false;

  Future<void> _firstVisit() async {
    _namesChecked = true;
    var seen = true;
    try {
      final store = await SharedPreferences.getInstance();
      seen = store.containsKey(namesSeenKey);
      await store.setString(namesSeenKey, '1');
    } on Object {
      // Storage is off: no first-visit names, the rest works.
    }
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
        if (!seen.contains(f.id)) _game?.burst(BedFx.values[f.kind.index], f.bed);
      }
    });
    ref.listen(phoneTargetProvider, (_, target) {
      switch (target) {
        case PhoneTargetSession(:final id):
          _openSession(id);
        case PhoneTargetPlans(:final playbook):
          _openPlans(playbook);
        case null:
          break;
      }
    });
    // Kept from the start, so a panel opened later has the newest.
    ref.listen(workStepsProvider, (_, _) {});

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
    final open = {
      'panel': ref.watch(panelProvider) != null,
      'selected': ref.watch(selectedProvider) != null,
      'sowing': ref.watch(sowingProvider) != null,
      'watering': ref.watch(wateringProvider) != null,
      'friends': ref.watch(friendsOpenProvider),
      'chat': ref.watch(chatOpenProvider),
    };

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
              final chat = ChatWindow(
                state: state,
                atlas: atlas,
                agents: agents,
                call: call,
                onSay: (text) => ref.read(apiProvider).channel.say(body: SayRequest(text: text)),
              );
              return _farm(window, game, village, atlas, state, view, held, hotspots, chat);
            },
          ),
        ),
      ),
    );
  }

  Widget _farm(
    BoxConstraints box,
    VillageGame game,
    VillageWorld village,
    SpriteAtlas atlas,
    CoreState state,
    FarmView view,
    Tool held,
    Map<String, Offset>? hotspots,
    Widget chat,
  ) {
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
                      final name = _cursorName(game, state, view, held);
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
                        final name = _cursorName(game, state, view, held);
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

  String _cursorName(VillageGame game, CoreState state, FarmView view, Tool tool) {
    final index = game.hoverBed.value;
    final bed = index == null || index < 0 || index >= beds.length ? null : beds[index];
    Aim? aim;
    if (bed != null) {
      final level = view.level.level.round();
      final session = bed.unlockLevel == null ? stationOf(state.sessions, bed.station) : null;
      aim = aimTool(tool, bed, session, bed.unlockLevel != null ? lockedPlot(bed, level) : plotOf(view, session), level);
    }
    return stageCursor(tool: tool, aim: aim, overSpot: game.hoverSpot.value != null, pressed: game.pressing.value);
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
