// The farm screen (web/src/pixel/PixelFarm.tsx): the pixel village at a whole-number scale in the middle of the window,
// covering it with a little cut off the edges when the window's shape is not the village's (village/framing.dart), or
// on the village dimmed when it cannot; the words over it, the HUD at the edges of what shows of it, the chat window
// at the lower right, the FX and the farm's panels over all of it. A click on a plot uses the tool in hand there (aimTool says what it would do, applyTool does
// it) and opens what it asks for; a click on a thing in the yard opens its panel or page. Over the village the cursor
// is the tool in hand. ⌥ held shows every thing's name; the first visit shows them for a while by itself. The number
// keys pick a tool, Esc puts it down and then opens the menu. The phone and the desktop app send the screen to a
// helper's bed, the plan board or the achievements.
//
// The screen may stay mounted, hidden, under the desk's pages (its tickers off), and the title screen may lie over it:
// it takes keys only while it is what is on screen.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/providers.dart';
import '../desk/chat/chat_state.dart' show chatActionsProvider, chatOpenProvider;
import '../desk/shared/state.dart' show workStepsProvider;
import '../desktop/desktop.dart';
import '../farm/chat_window.dart';
import '../farm/cursors.dart';
import '../farm/panels.dart';
import '../farm/work_log.dart';
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

/// Remembers that the yard's names were shown once, so the first visit shows them and later ones do not.
const namesSeenKey = 'vibevalley.pixel.names-seen';

/// How long the first visit shows every name.
const firstNamesTime = Duration(milliseconds: 6000);

class FarmPage extends ConsumerStatefulWidget {
  const FarmPage({super.key});

  @override
  ConsumerState<FarmPage> createState() => _FarmPageState();
}

class _FarmPageState extends ConsumerState<FarmPage> {
  /// The voice call, made the first time it is needed (never in dispose: ref is gone by then).
  VoiceCall? _call;
  VoiceCall get call => _call ??= VoiceCall(
    ref.read(serverProvider),
    agentPick: () {
      final pick = ref.read(prefsProvider).pick;
      return pick == 'auto' ? null : pick;
    },
  )..addListener(_voice);
  VillageGame? _game;
  final _subs = <StreamSubscription<Object?>>[];
  late final AppLifecycleListener _life;

  /// Where the pointer is over the village (for the drawn cursor), null when it is not.
  final _pointer = ValueNotifier<Offset?>(null);
  Timer? _namesTimer;
  var _namesChecked = false;

  @override
  void initState() {
    super.initState();
    installTurnSteps();
    HardwareKeyboard.instance.addHandler(_onKey);
    // Leave the window and the names hide (the web page's blur).
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

  /// Whether the farm is what is on screen: not hidden under a desk page, not under the title screen.
  bool get _active => mounted && TickerMode.valuesOf(context).enabled && !ref.read(titleOpenProvider);

  // ── Clicks in the village ──────────────────────────────────────────────────

  /// A click on a plot (or on the helper working it): use the tool in hand there, then open what it asks for.
  Future<void> _clickPlot(int index) async {
    final bed = beds[index];
    final state = ref.read(farmProvider);
    final view = ref.read(viewProvider);
    if (state == null || view == null) return;
    final worker = bed.unlockLevel == null ? stationOf(state.helpers, bed.station) : null;
    final plot = bed.unlockLevel != null ? lockedPlot(bed, view.level.level.round()) : plotOf(view, worker);
    if (aimTool(ref.read(heldToolProvider), bed, worker, plot, view.level.level.round()).ok) Sfx.play('tap');
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
      case ToolInspect(:final workerId):
        ref.read(selectedProvider.notifier).set(workerId);
      case ToolWater(:final workerId):
        ref.read(wateringProvider.notifier).set(workerId);
      case ToolReview(:final workerId):
        ref.read(reviewingProvider.notifier).set(workerId);
    }
  }

  /// A click on a thing in the yard: the panel or page it stands for.
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

  // ── Where the phone and the desktop app send the screen ────────────────────

  void _openHelper(String id) => ref.read(selectedProvider.notifier).set(id);

  void _openPlans(String? playbook) {
    if (playbook != null) ref.read(planShownProvider.notifier).set(playbook);
    ref.read(panelProvider.notifier).set(FarmPanel.plans);
  }

  /// What a notification opens is on the farm: the farm is brought in front first (from a desk page, from the title
  /// screen), else it would open where nobody sees it.
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
      case DesktopOpenWorker(:final id):
        _openHelper(id);
      case DesktopOpenChat(:final conversation):
        ref.read(chatOpenProvider.notifier).set(true);
        fire(ref.read(chatActionsProvider).showChat(conversation));
      case DesktopOpenPlans(:final playbook):
        _openPlans(playbook);
      case DesktopOpenAchievements():
        ref.read(panelProvider.notifier).set(FarmPanel.tasks);
    }
  }

  // ── Keys ───────────────────────────────────────────────────────────────────

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
    // Every thing in the yard says its name while ⌥ is held.
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

  /// On the first visit every name shows for a few seconds by itself, with a toast saying so.
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
    // The debug console's clock and 打开帮工, once this build is done (no provider changes while building).
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
              openHelper: _openHelper,
            ),
          );
    });
    return game;
  }

  @override
  Widget build(BuildContext context) {
    final atlas = ref.watch(atlasProvider).value;
    final village = ref.watch(villageProvider).value;
    final state = ref.watch(farmProvider);
    final view = ref.watch(viewProvider);
    final agents = ref.watch(agentsProvider).value ?? const <String, AgentProfile>{};
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
        case PhoneTargetHelper(:final id):
          _openHelper(id);
        case PhoneTargetPlans(:final playbook):
          _openPlans(playbook);
        case null:
          break;
      }
    });
    // Steps come as events for every helper; kept from the start, so a panel opened later has the newest.
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
                onSay: (text) => ref.read(serverProvider).api.farm.say(body: SayRequest(text: text)),
              );
              return _farm(window, game, village, atlas, state, view, held, hotspots, chat);
            },
          ),
        ),
      ),
    );
  }

  /// The village filling box, its HUD and panels over it, and the chat in its corner.
  Widget _farm(
    BoxConstraints box,
    VillageGame game,
    VillageWorld village,
    SpriteAtlas atlas,
    FarmState state,
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
        // Where the village leaves the window bare: the village itself, larger and dimmed.
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
        // The HUD at the edges of what shows of the village, inside the window.
        Positioned.fromRect(
          rect: shown,
          child: VillageHud(game: game, call: call),
        ),
        // The chat keeps its own corner of the window.
        Positioned(right: 12, bottom: 12, child: chat),
        Positioned.fill(
          child: FxLayer(call: call, effects: ref.watch(farmEffectsProvider), notices: ref.watch(farmNoticesProvider)),
        ),
        const Positioned.fill(child: FarmPanels()),
      ],
    );
  }

  /// The cursor over the village, by name (PixelFarm.tsx useStageCursor).
  String _cursorName(VillageGame game, FarmState state, FarmView view, Tool tool) {
    final index = game.hoverBed.value;
    final bed = index == null || index < 0 || index >= beds.length ? null : beds[index];
    Aim? aim;
    if (bed != null) {
      final level = view.level.level.round();
      final worker = bed.unlockLevel == null ? stationOf(state.helpers, bed.station) : null;
      aim = aimTool(tool, bed, worker, bed.unlockLevel != null ? lockedPlot(bed, level) : plotOf(view, worker), level);
    }
    return stageCursor(tool: tool, aim: aim, overSpot: game.hoverSpot.value != null, pressed: game.pressing.value);
  }
}

/// Around a village that cannot cover the window: the village's own picture spread over the window, dimmed into the
/// ground's colour, so the bars read as more of the land rather than a frame.
class _Surroundings extends StatelessWidget {
  const _Surroundings({required this.asset});
  final String asset;

  @override
  Widget build(BuildContext context) => ColorFiltered(
    colorFilter: ColorFilter.mode(Palette.ground.withValues(alpha: 0.72), BlendMode.srcATop),
    child: Image.asset(asset, fit: BoxFit.cover, filterQuality: FilterQuality.none),
  );
}
