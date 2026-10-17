import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/farm_choice.dart';
import '../data/providers.dart';
import './mobile_notices.dart';
import 'channel.dart';
import 'command.dart';
import 'launcher.dart';
import 'notify.dart';

export 'command.dart';
export 'channel.dart' show DesktopChannel, desktopChannel;

const desktopTitleBar = 28.0;

/// In Electron's accelerator notation, which the Swift side parses.
const desktopVoiceShortcut = 'Alt+Shift+Space';

bool get isMacDesktop => !kIsWeb && Platform.isMacOS;

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

  /// 0: none to draw.
  final double titleBarHeight;

  final String title;

  final String voiceShortcut;

  final bool nativeVoice;

  final bool voiceDispatch;

  final Stream<HostCommand> commands;
}

final hostProvider = Provider<Desktop>(
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
  final _commands = StreamController<HostCommand>.broadcast();
  RunningServer? _server;
  bool _listening = false;

  Stream<HostCommand> get commands => _commands.stream;

  void _listen() {
    if (_listening) return;
    _listening = true;
    _channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'command':
          final command = HostCommand.fromJson(call.arguments);
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

  Future<void> notify(HostNotice notice) =>
      _invoke('notify', {'title': notice.title, 'body': notice.body, if (notice.open != null) 'command': notice.open!.toJson()});
}

String desktopHome(Map<String, String> env) => env['VIBEVALLEY_HOME'] ?? '${env['HOME'] ?? ''}/Library/Application Support/${desktopChannel.productName}';

String desktopWorkRoot(Map<String, String> env) => env['VIBEVALLEY_WORK_ROOT'] ?? '${env['HOME'] ?? ''}/vibevalley-work';

String? bundledServer(Map<String, String> env) {
  final given = env['VIBEVALLEY_SERVER_BIN'];
  if (given != null && given.isNotEmpty) return given;
  final beside = '${File(Platform.resolvedExecutable).parent.path}/vibevalley-server';
  return File(beside).existsSync() ? beside : null;
}

Future<void> startDesktop() async {
  if (!isMacDesktop) return;
  final host = DesktopHostChannel.instance.._listen();
  await host._invoke('setup', {'title': desktopChannel.titled('码农场物语')});
  if (farmChoice.value.useRemote) return;
  await startLocalFarm();
}

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
  final path = await loginShellPath(env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin');
  final launcher = ServerLauncher(
    binary: binary,
    // The rest of the configuration is the home's vibevalley.yaml; the login shell's PATH goes on top.
    environment: {...env, 'PATH': path, 'VIBEVALLEY_HOME': home, 'VIBEVALLEY_WORK_ROOT': desktopWorkRoot(env)},
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
