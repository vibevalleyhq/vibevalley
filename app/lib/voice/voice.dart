// Talking to the manager: the server hands out the call (appId, channel, uid, one token for RTC and RTM) and starts
// Agora's conversational AI agent in it; the client only joins with the Agora Flutter SDK. The microphone stays open,
// as on the phone: the agent hears when you stop, and you can talk over it. Muting is a button.
//
// LiveCaptions and the agent's state come over the RTC data stream (the server starts the agent with captions:
// 'datastream'; captions.dart): Agora's Flutter RTM package is Android and iOS only.

import 'dart:convert';
import 'dart:io';

import 'package:agora_rtc_engine/agora_rtc_engine.dart';
import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';

import 'captions.dart';
import '../gen/vibevalley.dart';
import '../data/server.dart';

enum CallPhase { idle, connecting, live, ending }

class VoiceCall extends ChangeNotifier {
  VoiceCall(this.server, {this.agentPick}) {
    // What you say is work for the farm, as on the web page (core voice.ts): each finished sentence goes to the manager
    // through /api/dispatch; the voice agent does the talking.
    captions.onHeard = (text) => server.api.farm
        .dispatch(
          body: SayRequest(text: text, agent: agentPick?.call()),
        )
        .catchError((Object _) {});
  }

  final VibeValleyServer server;

  /// The agent the friends bar picked for new jobs; null: the manager's pick.
  final String? Function()? agentPick;
  CallPhase phase = CallPhase.idle;
  bool muted = false;
  bool agentHere = false;
  final captions = LiveCaptions();

  /// The agent's own state (message.state): listening, thinking, speaking, silent, idle.
  String? get agentState => captions.agentState;
  String? problem;

  /// From pressing 开工 to the agent joining the channel: the number to compare with the web client.
  Duration? connectTime;

  // What reaches us, to tell a silent call apart from captions that do not decode.
  int packets = 0;
  int messages = 0;
  int micLevel = 0;
  int managerLevel = 0;
  String? lastPacket;

  RtcEngine? _engine;
  int _loudestMic = 0;
  int _loudestManager = 0;
  int _levelsAt = 0;

  /// The call's steps on this machine, for working out a call that went wrong: ~/Library/Logs/vibevalley/voice.log on
  /// macOS. Steps, counts and errors only: never what was said, never a token.
  static final File? _log = () {
    final home = Platform.environment['HOME'];
    if (!Platform.isMacOS || home == null) return null;
    final dir = Directory('$home/Library/Logs/vibevalley');
    try {
      dir.createSync(recursive: true);
      return File('${dir.path}/voice.log');
    } catch (_) {
      return null;
    }
  }();

  static void _note(String line) {
    try {
      _log?.writeAsStringSync('${DateTime.now().toIso8601String()} $line\n', mode: FileMode.append);
    } catch (_) {}
  }

  String? _agentId;

  Future<void> start() async {
    if (phase != CallPhase.idle) return;
    _set(CallPhase.connecting, problem: null);
    final watch = Stopwatch()..start();
    try {
      if (defaultTargetPlatform == TargetPlatform.iOS || defaultTargetPlatform == TargetPlatform.android) {
        if (!(await Permission.microphone.request()).isGranted) throw VibeValleyApiError(0, null, '没有麦克风权限');
      }
      _note('call: asking for a session');
      final session = await server.api.voice.session();
      _note('call: session for ${session.channel}, uid ${session.uid}');
      final engine = createAgoraRtcEngine();
      _engine = engine;
      // Set up as Shengwang's official Flutter quickstart does (conversational-ai-quickstart-native/flutter).
      await engine.initialize(RtcEngineContext(appId: session.appId, channelProfile: ChannelProfileType.channelProfileLiveBroadcasting));
      engine.registerEventHandler(
        RtcEngineEventHandler(
          onUserJoined: (_, remoteUid, _) {
            _note('rtc: $remoteUid joined after ${watch.elapsedMilliseconds} ms');
            agentHere = true;
            connectTime ??= watch.elapsed;
            notifyListeners();
          },
          onUserOffline: (_, remoteUid, reason) {
            _note('rtc: $remoteUid left ($reason)');
            agentHere = false;
            notifyListeners();
          },
          onError: (code, message) {
            _note('rtc error: $code $message');
            problem = '声网：$code $message';
            notifyListeners();
          },
          onStreamMessage: (_, remoteUid, streamId, data, _, _) {
            final text = utf8.decode(data, allowMalformed: true);
            packets++;
            lastPacket = text.length > 80 ? '${text.substring(0, 80)}…' : text;
            final was = captions.agentState;
            if (captions.feed(text)) messages++;
            if (captions.agentState != was) _note('agent: ${captions.agentState}');
            // Every 20th packet: how many came and how many decoded, to tell silence from captions that do not decode.
            if (packets == 1 || packets % 20 == 0) _note('stream: $packets packets from $remoteUid/$streamId, $messages messages');
            notifyListeners();
          },
          onStreamMessageError: (_, remoteUid, streamId, code, missed, cached) {
            _note('stream error from $remoteUid/$streamId: $code, missed $missed');
            debugPrint('vibevalley stream error from $remoteUid/$streamId: $code missed $missed');
            problem = '字幕流出错：$code（丢了 $missed 个）';
            notifyListeners();
          },
          onJoinChannelSuccess: (connection, elapsed) => _note('rtc: joined ${connection.channelId} as ${connection.localUid} in $elapsed ms'),
          onConnectionStateChanged: (_, state, reason) => _note('rtc: connection $state ($reason)'),
          onLocalAudioStateChanged: (_, state, reason) => _note('rtc: microphone $state ($reason)'),
          // The token lasts an hour: a fresh one for the same channel and uid before it runs out (agora.ts renewToken).
          onTokenPrivilegeWillExpire: (connection, _) async {
            try {
              final fresh = await server.api.voice.renew(
                body: RenewRequest(channel: session.channel, uid: session.uid),
              );
              await _engine?.renewToken(fresh.token);
            } catch (e) {
              problem = '令牌续期失败：$e';
              notifyListeners();
            }
          },
          onAudioVolumeIndication: (_, speakers, _, _) {
            for (final s in speakers) {
              if (s.uid == 0) {
                micLevel = s.volume ?? 0;
                _loudestMic = micLevel > _loudestMic ? micLevel : _loudestMic;
              } else {
                managerLevel = s.volume ?? 0;
                _loudestManager = managerLevel > _loudestManager ? managerLevel : _loudestManager;
              }
            }
            // The loudest levels (0..255) every 3 s: a microphone that stays at 0 while you talk is sending silence.
            if (watch.elapsedMilliseconds - _levelsAt >= 3000) {
              _note('levels: you $_loudestMic, manager $_loudestManager');
              _levelsAt = watch.elapsedMilliseconds;
              _loudestMic = 0;
              _loudestManager = 0;
            }
            notifyListeners();
          },
        ),
      );
      await engine.enableAudio();
      await engine.setAudioScenario(AudioScenarioType.audioScenarioAiClient);
      // The quickstart's audio settings for talking to an agent: AI echo cancellation and noise suppression in their
      // low-latency mode; nlpAlgRoute 1 is for a loudspeaker (0 for headsets).
      for (final p in const [
        '{"che.audio.aec.split_srate_for_48k":16000}',
        '{"che.audio.sf.enabled":true}',
        '{"che.audio.sf.stftType":6}',
        '{"che.audio.sf.ainlpLowLatencyFlag":1}',
        '{"che.audio.sf.ainsLowLatencyFlag":1}',
        '{"che.audio.sf.procChainMode":1}',
        '{"che.audio.sf.nlpDynamicMode":1}',
        '{"che.audio.sf.nlpAlgRoute":1}',
        // Automatic gain, as a browser's getUserMedia has it on by default: a laptop's microphone at a low input volume
        // otherwise reaches the agent too quietly for its voice detection to hear anyone talk.
        '{"che.audio.agc.enable":true}',
      ]) {
        await engine.setParameters(p);
      }
      await engine.enableAudioVolumeIndication(interval: 300, smooth: 3, reportVad: true);
      // Joined with the number the uid string holds, as the web client does (rtc.join(…, Number(uid))): the agent
      // listens to that uid only, and a user account would be given another number, so the agent never hears us.
      await engine.joinChannel(
        token: session.token,
        channelId: session.channel,
        uid: int.parse(session.uid),
        options: const ChannelMediaOptions(clientRoleType: ClientRoleType.clientRoleBroadcaster, publishMicrophoneTrack: true, autoSubscribeAudio: true),
      );
      // Twice the captured level (0..400): with the gain above, a quiet microphone still reaches the agent.
      await engine.adjustRecordingSignalVolume(200);
      // Captions over the RTC data stream: Agora's Flutter RTM package is Android and iOS only.
      _note('call: asking for the voice agent');
      _agentId = (await server.api.voice.start(
        body: StartRequest(channel: session.channel, uid: session.uid, captions: VoiceCaptions.datastream),
      )).agentId;
      _note('call: agent $_agentId started after ${watch.elapsedMilliseconds} ms');
      _set(CallPhase.live);
    } catch (e) {
      _note('call failed: $e');
      await _teardown();
      _set(CallPhase.idle, problem: '$e');
    }
  }

  Future<void> mute(bool on) async {
    if (phase != CallPhase.live || muted == on) return;
    muted = on;
    notifyListeners();
    await _engine?.muteLocalAudioStream(on);
  }

  Future<void> end() async {
    if (phase == CallPhase.idle) return;
    _note('call: hung up ($packets packets, $messages messages)');
    _set(CallPhase.ending);
    await _teardown();
    _set(CallPhase.idle);
  }

  Future<void> _teardown() async {
    final agent = _agentId;
    _agentId = null;
    if (agent != null) await server.api.voice.stop(body: VoiceAgent(agentId: agent)).catchError((_) {});
    final engine = _engine;
    _engine = null;
    muted = false;
    agentHere = false;
    captions.clear();
    packets = 0;
    messages = 0;
    micLevel = 0;
    managerLevel = 0;
    lastPacket = null;
    if (engine != null) {
      await engine.leaveChannel();
      await engine.release();
    }
  }

  void _set(CallPhase next, {Object? problem = _keep}) {
    phase = next;
    if (problem != _keep) this.problem = problem as String?;
    notifyListeners();
  }

  static const _keep = Object();

  @override
  void dispose() {
    _teardown();
    super.dispose();
  }
}
