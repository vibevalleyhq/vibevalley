// vibevalley's desktop app on macOS, the Dart half (the Swift half is macos/Runner: the window with its title bar hidden,
// the menu bar icon, notifications, the global voice shortcut, single instance, opening at login). See docs/desktop.md:
// the farm runs inside the app (launcher.dart), the menu bar says what goes on,
// notifications tell what waits while the farm is not in front of you, and quitting stops the farm cleanly.
//
// main.dart awaits `startDesktop()` before runApp (the farm's address must be known before the first provider reads
// it) and puts `DesktopHost` around the app. Screens read `desktopProvider`: the title bar to draw and the commands
// to run (the voice shortcut, a notification clicked).

import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/farm_choice.dart';
import '../data/providers.dart';
import '../mobile/notices.dart';
import 'channel.dart';
import 'command.dart';
import 'launcher.dart';
import 'notify.dart';

export 'command.dart';
export 'channel.dart' show DesktopChannel, desktopChannel;

/// The title bar the farm draws (the system's is hidden; its traffic lights sit on this one).
const desktopTitleBar = 28.0;

/// The global shortcut that starts and ends a voice call with the manager, in Electron's accelerator notation.
const desktopVoiceShortcut = 'Alt+Shift+Space';

/// Whether this is the macOS desktop app (the window's title bar is the farm's to draw).
bool get isMacDesktop => !kIsWeb && Platform.isMacOS;

/// The voice shortcut as a Mac writes it: Alt+Shift+Space → ⌥⇧Space (web/src/desktop.ts shortcutText).
String shortcutText(String accelerator) => accelerator
    .split('+')
    .map(
      (key) => switch (key) {
        'Alt' || 'Option' => '⌥',
        'Shift' => '⇧',
        'Control' || 'Ctrl' => '⌃',
        'Command' || 'Cmd' || 'CommandOrControl' || 'CmdOrCtrl' => '⌘',
        _ => key,
      },
    )
    .join();

/// What the screens need of the desktop app (protocol desktop.ts DesktopBridge, as Dart).
class Desktop {
  const Desktop({
    required this.isDesktop,
    required this.titleBarHeight,
    required this.title,
    required this.voiceShortcut,
    required this.nativeVoice,
    required this.voiceDispatch,
    required this.commands,
  });

  /// Not the desktop app (a phone, a test): no title bar, no commands.
  static const none = Desktop(
    isDesktop: false,
    titleBarHeight: 0,
    title: '码农场物语',
    voiceShortcut: '',
    nativeVoice: false,
    voiceDispatch: true,
    commands: Stream.empty(),
  );

  final bool isDesktop;

  /// How tall the farm draws the window's title bar; 0: none to draw.
  final double titleBarHeight;

  /// The window's name, its channel after it: 「码农场物语 · Alpha」.
  final String title;

  /// The global voice shortcut, in Electron's accelerator notation (shortcutText makes ⌥⇧Space of it).
  final String voiceShortcut;

  /// The app captures and plays the call itself (the Agora SDK in lib/voice), not a web page.
  final bool nativeVoice;

  /// Transcripts go to the manager to dispatch work.
  final bool voiceDispatch;

  /// What the farm's screens run: the voice shortcut and the menu bar's 和管家说话 (DesktopVoice), a notification
  /// clicked (open a bed, a conversation, a playbook, the achievements).
  final Stream<DesktopCommand> commands;
}

final desktopProvider = Provider<Desktop>(
  (ref) => isMacDesktop
      ? Desktop(
          isDesktop: true,
          titleBarHeight: desktopTitleBar,
          title: desktopChannel.titled('码农场物语'),
          voiceShortcut: desktopVoiceShortcut,
          nativeVoice: true,
          voiceDispatch: true,
          commands: DesktopHostChannel.instance.commands,
        )
      // A phone has no window to manage; its notifications open things the same way (mobile/notices.dart).
      : isPhone
      ? Desktop(
          isDesktop: false,
          titleBarHeight: 0,
          title: Desktop.none.title,
          voiceShortcut: '',
          nativeVoice: false,
          voiceDispatch: true,
          commands: PhoneNotices.instance.commands,
        )
      : Desktop.none,
);

/// The Swift side, over the method channel `vibevalley/desktop`.
///
/// Dart → Swift: setup {title}, server {pid}, tray {title, lines}, notify {title, body, command?}, fatal {title, text}.
/// Swift → Dart: command {the protocol's JSON}, quit (stop the farm; the app quits once this returns).
class DesktopHostChannel {
  DesktopHostChannel._();
  static final instance = DesktopHostChannel._();

  static const _channel = MethodChannel('vibevalley/desktop');
  final _commands = StreamController<DesktopCommand>.broadcast();
  RunningServer? _server;
  bool _listening = false;

  Stream<DesktopCommand> get commands => _commands.stream;

  void _listen() {
    if (_listening) return;
    _listening = true;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'command':
          final command = DesktopCommand.fromJson(call.arguments);
          if (command != null) _commands.add(command);
          return null;
        case 'quit':
          await _server?.stop();
          return null;
      }
      throw MissingPluginException(call.method);
    });
  }

  Future<void> _invoke(String method, [Object? arguments]) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on MissingPluginException {
      // Not the macOS runner (a test): nothing to tell.
    } on PlatformException catch (e) {
      debugPrint('vibevalley desktop: $method: ${e.message}');
    }
  }

  Future<void> tray(TraySummary summary) => _invoke('tray', {'title': summary.title, 'lines': summary.lines});

  Future<void> notify(DesktopNotice notice) =>
      _invoke('notify', {'title': notice.title, 'body': notice.body, if (notice.open != null) 'command': notice.open!.toJson()});
}

/// Where VibeValley keeps the farm on this Mac: VIBEVALLEY_HOME, else ~/Library/Application Support/vibevalley (a
/// channel's own folder for alpha and beta).
String desktopHome(Map<String, String> env) => env['VIBEVALLEY_HOME'] ?? '${env['HOME'] ?? ''}/Library/Application Support/${desktopChannel.productName}';

/// Where the helpers work: VIBEVALLEY_WORK_ROOT, else ~/vibevalley-work.
String desktopWorkRoot(Map<String, String> env) => env['VIBEVALLEY_WORK_ROOT'] ?? '${env['HOME'] ?? ''}/vibevalley-work';

/// The server in the bundle (tool/build-macos.sh puts it beside the app's executable); VIBEVALLEY_SERVER_BIN instead.
String? bundledServer(Map<String, String> env) {
  final given = env['VIBEVALLEY_SERVER_BIN'];
  if (given != null && given.isNotEmpty) return given;
  final beside = '${File(Platform.resolvedExecutable).parent.path}/vibevalley-server';
  return File(beside).existsSync() ? beside : null;
}

/// Starts the desktop app's half before the first frame: tells the window its title, and starts the farm inside the
/// app unless the app uses another machine's farm (data/farm_choice.dart), --dart-define=VIBEVALLEY_SERVER names one, or
/// the bundle has no server (a `flutter run` without it, which then uses VIBEVALLEY_SERVER's default). When the farm
/// cannot start, says why and quits.
Future<void> startDesktop() async {
  if (!isMacDesktop) return;
  final host = DesktopHostChannel.instance.._listen();
  await host._invoke('setup', {'title': desktopChannel.titled('码农场物语')});
  if (farmChoice.value.useRemote) return;
  await startLocalFarm();
}

/// Starts the farm inside the app when it is not running yet: at startup, or when the app goes back to this
/// machine's farm from another's. The farm keeps running while the app uses another machine's.
Future<void> startLocalFarm() async {
  if (!isMacDesktop || embeddedServerAddress != null) return;
  final host = DesktopHostChannel.instance.._listen();
  if (const String.fromEnvironment('VIBEVALLEY_SERVER').isNotEmpty) return;
  final env = Platform.environment;
  final binary = bundledServer(env);
  if (binary == null) {
    debugPrint('vibevalley desktop: no server in the bundle; using $serverAddress');
    return;
  }
  final home = desktopHome(env);
  await Directory(home).create(recursive: true);
  final fromHome = await _readEnvFile('$home/.env');
  final path = await loginShellPath(env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin');
  final launcher = ServerLauncher(
    binary: binary,
    // The home .env under this process's environment (set values win), the login shell's PATH on top.
    environment: {...fromHome, ...env, 'PATH': path, 'VIBEVALLEY_HOME': home, 'VIBEVALLEY_WORK_ROOT': desktopWorkRoot(env)},
    logFile: File('${env['HOME'] ?? ''}/Library/Logs/${desktopChannel.productName}/server.log'),
    workingDirectory: home,
  );
  try {
    final server = await launcher.start();
    host._server = server;
    embeddedServerAddress = server.url.toString();
    await host._invoke('server', {'pid': server.pid, 'url': embeddedServerAddress});
  } on ServerFailed catch (e) {
    await host._invoke('fatal', {'title': desktopChannel.titled('码农场物语开不了门'), 'text': e.reason});
  }
}

Future<Map<String, String>> _readEnvFile(String path) async {
  try {
    return parseEnv(await File(path).readAsString());
  } on Object {
    return const {};
  }
}

/// Follows the farm for the menu bar and the notifications while the app runs: the summary from every frame, a
/// notification for each new call, achievement and error. Swift shows a notification only while the farm's window
/// is not in front (in front, the farm says it itself).
final desktopFollowProvider = Provider<void>((ref) {
  if (!ref.watch(desktopProvider).isDesktop) return;
  final host = DesktopHostChannel.instance;
  final bell = CallBell();
  var shown = TraySummary.opening;
  unawaited(host.tray(shown));
  ref.listen(stateFrameProvider, (_, next) {
    final frame = next.value;
    if (frame == null) return;
    final summary = traySummary(frame.state, frame.frame.inbox);
    if (summary != shown) {
      shown = summary;
      unawaited(host.tray(summary));
    }
    for (final call in bell.ring(frame.frame.inbox)) {
      unawaited(host.notify(noticeForCall(call)));
    }
  });
  ref.listen(effectsProvider, (_, next) {
    final notice = next.value == null ? null : noticeForEffect(next.value!);
    if (notice != null) unawaited(host.notify(notice));
  });
  ref.listen(sideEventsProvider, (_, next) {
    final notice = next.value == null ? null : noticeForEvent(next.value!);
    if (notice != null) unawaited(host.notify(notice));
  });
});

/// Around the app in main.dart: keeps the menu bar and the notifications (the Mac's, a phone's) following the farm.
class DesktopHost extends ConsumerWidget {
  const DesktopHost({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(desktopFollowProvider);
    ref.watch(phoneFollowProvider);
    return child;
  }
}
