// vibevalley on a phone (iOS, Android): system notifications for what the farm calls the person about, by the desktop
// app's rules (desktop/notify.dart: a helper's turn done or failed, a conflict, a playbook ripe or stuck, someone
// naming the person, an achievement, an error). Shown only while the app runs away from the screen: in front, the farm
// says it itself. iOS suspends an app soon after it leaves the screen, so a notification comes only in that while
// (connectors reach the person when the app is closed). On Android a foreground service keeps the app, and the farm's
// stream, alive while it is in the background. Tapping a notification opens what it is about, as a DesktopCommand
// through desktopProvider's commands.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../desktop/command.dart';
import '../desktop/notify.dart';

/// Whether this is the app on a phone.
bool get isPhone => !kIsWeb && (Platform.isIOS || Platform.isAndroid);

/// The Android foreground service's notification id (0 is not allowed for one).
const _linkId = 1;

const _farmChannel = AndroidNotificationDetails('farm', '农场', channelDescription: '帮工做完活、没做成、叫你的时候', importance: Importance.high, priority: Priority.high);

const _linkChannel = AndroidNotificationDetails(
  'link',
  '连着农场',
  channelDescription: 'VibeValley 在后台连着农场，好在帮工做完活时通知你',
  importance: Importance.low,
  priority: Priority.low,
  ongoing: true,
  showWhen: false,
);

class PhoneNotices {
  PhoneNotices._();
  static final instance = PhoneNotices._();

  final _plugin = FlutterLocalNotificationsPlugin();
  late final _commands = StreamController<DesktopCommand>.broadcast(onListen: _flush);

  /// A command from the notification that opened the app, held until a screen listens.
  DesktopCommand? _pending;
  bool _ready = false;
  bool _linked = false;
  int _next = 100;

  /// What tapping a notification opens.
  Stream<DesktopCommand> get commands => _commands.stream;

  /// Sets notifications up and asks the person to allow them, before the first frame; nothing off a phone.
  Future<void> start() async {
    if (!isPhone || _ready) return;
    try {
      await _plugin.initialize(
        settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher'), iOS: DarwinInitializationSettings()),
        onDidReceiveNotificationResponse: (r) => open(r.payload),
      );
      await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      final launch = await _plugin.getNotificationAppLaunchDetails();
      if (launch?.didNotificationLaunchApp ?? false) open(launch!.notificationResponse?.payload);
      _ready = true;
    } on Object catch (e) {
      debugPrint('vibevalley: notifications: $e');
    }
  }

  /// A tapped notification's payload (a DesktopCommand's JSON) as a command, held until a screen listens.
  @visibleForTesting
  void open(String? payload) {
    if (payload == null || payload.isEmpty) return;
    DesktopCommand? command;
    try {
      command = DesktopCommand.fromJson(jsonDecode(payload));
    } on Object {
      return;
    }
    if (command == null) return;
    if (_commands.hasListener) {
      _commands.add(command);
    } else {
      _pending = command;
    }
  }

  void _flush() {
    final held = _pending;
    _pending = null;
    if (held != null) scheduleMicrotask(() => _commands.add(held));
  }

  Future<void> show(DesktopNotice notice) async {
    if (!_ready) return;
    try {
      await _plugin.show(
        id: _next++,
        title: notice.title,
        body: notice.body,
        notificationDetails: const NotificationDetails(android: _farmChannel, iOS: DarwinNotificationDetails()),
        payload: notice.open == null ? null : jsonEncode(notice.open!.toJson()),
      );
    } on Object catch (e) {
      debugPrint('vibevalley: notify: $e');
    }
  }

  /// Android: keeps the app alive in the background (a foreground service, with its quiet notification), or lets it go.
  Future<void> keepLinked(bool on) async {
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (!_ready || android == null || on == _linked) return;
    _linked = on;
    try {
      if (on) {
        await android.startForegroundService(
          id: _linkId,
          title: 'VibeValley 连着农场',
          body: '帮工做完活、叫你的时候会通知你',
          notificationDetails: _linkChannel,
          foregroundServiceTypes: {AndroidServiceForegroundType.foregroundServiceTypeRemoteMessaging},
        );
      } else {
        await android.stopForegroundService();
      }
    } on Object catch (e) {
      debugPrint('vibevalley: foreground service: $e');
    }
  }
}

/// Follows the farm for the phone's notifications while the app runs: every frame's new calls, achievement effects
/// and error notices, notified while the app is away from the screen; on Android, the link kept while it is away.
final phoneFollowProvider = Provider<void>((ref) {
  if (!isPhone) return;
  final notices = PhoneNotices.instance;
  final bell = CallBell();
  bool away() => WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed;
  void tell(DesktopNotice? notice) {
    if (notice != null && away()) unawaited(notices.show(notice));
  }

  ref.listen(stateFrameProvider, (_, next) {
    final frame = next.value;
    if (frame == null) return;
    // Every frame rings the bell, in front too: a call seen on the screen is not notified later.
    for (final call in bell.ring(frame.frame.inbox)) {
      tell(noticeForCall(call));
    }
  });
  ref.listen(effectsProvider, (_, next) => tell(next.value == null ? null : noticeForEffect(next.value!)));
  ref.listen(sideEventsProvider, (_, next) => tell(next.value == null ? null : noticeForEvent(next.value!)));
  final lifecycle = AppLifecycleListener(onPause: () => unawaited(notices.keepLinked(true)), onResume: () => unawaited(notices.keepLinked(false)));
  ref.onDispose(lifecycle.dispose);
});
