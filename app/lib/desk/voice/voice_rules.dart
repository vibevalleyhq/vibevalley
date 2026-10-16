// The voice line's choices and rules, a port of server/internal/protocol/voice.go and settings.go: what each stage
// offers, the limits on the numbers, why settings cannot be saved, the overrides over the defaults and how a key is
// shown. Change them there and here together.

import 'dart:convert';

import '../../gen/vibevalley.dart';

const deepgramModels = Model.values;
const voiceTtsModels = VoiceTtsMinimaxModel.values;
const openaiVoices = Voice.values;
const voiceModels = VoiceLlmAgoraModel.values;
const voiceLanguages = Language.values;

/// Any other id can be typed.
const minimaxVoices = <({String id, String label})>[
  (id: 'Chinese (Mandarin)_Gentle_Youth', label: '温润青年'),
  (id: 'male-qn-qingse', label: '青涩青年'),
  (id: 'male-qn-jingying', label: '精英青年'),
  (id: 'male-qn-badao', label: '霸道青年'),
  (id: 'male-qn-daxuesheng', label: '青年大学生'),
  (id: 'female-shaonv', label: '少女'),
  (id: 'female-yujie', label: '御姐'),
  (id: 'female-chengshu', label: '成熟女性'),
  (id: 'female-tianmei', label: '甜美女性'),
  (id: 'presenter_male', label: '男性主持人'),
  (id: 'presenter_female', label: '女性主持人'),
  (id: 'audiobook_male_1', label: '男性有声书'),
  (id: 'audiobook_female_1', label: '女性有声书'),
];

/// Any other name can be typed.
const microsoftVoices = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'en-US-JennyNeural', 'en-US-GuyNeural'];

const defaultGreeting = '来啦！今天想种点什么？';

bool needsAsrKey(VoiceAsr asr) => asr is VoiceAsrMicrosoft;
bool needsLlmKey(VoiceLlm llm) => llm is VoiceLlmOpenai;
bool needsTtsKey(VoiceTts tts) => tts is VoiceTtsMicrosoft;

enum VoiceNumber { silenceMs, interruptMs, idleSeconds }

const voiceLimits = <VoiceNumber, ({int min, int max})>{
  VoiceNumber.silenceMs: (min: 200, max: 2000),
  VoiceNumber.interruptMs: (min: 80, max: 1000),
  VoiceNumber.idleSeconds: (min: 10, max: 600),
};

abstract final class VoiceLabel {
  static const area = '区域';
  static const language = '语言';
  static const asr = '识别';
  static const llm = '大模型';
  static const tts = '合成';
  static const persona = '人设';
  static const greeting = '开场白';
  static const failureMessage = '出错时说';
  static const numbers = <VoiceNumber, String>{
    VoiceNumber.silenceMs: '停顿多久算说完（毫秒）',
    VoiceNumber.interruptMs: '说多久能打断他（毫秒）',
    VoiceNumber.idleSeconds: '没人时多久离开（秒）',
  };
}

double numberOf(VoiceSettings v, VoiceNumber k) => switch (k) {
  VoiceNumber.silenceMs => v.silenceMs,
  VoiceNumber.interruptMs => v.interruptMs,
  VoiceNumber.idleSeconds => v.idleSeconds,
};

VoiceSettings voiceWith(
  VoiceSettings v, {
  Area? area,
  Language? language,
  VoiceAsr? asr,
  VoiceLlm? llm,
  VoiceTts? tts,
  String? persona,
  String? greeting,
  String? failureMessage,
  double? silenceMs,
  double? interruptMs,
  double? idleSeconds,
}) => VoiceSettings(
  area: area ?? v.area,
  language: language ?? v.language,
  asr: asr ?? v.asr,
  llm: llm ?? v.llm,
  tts: tts ?? v.tts,
  persona: persona ?? v.persona,
  greeting: greeting ?? v.greeting,
  failureMessage: failureMessage ?? v.failureMessage,
  silenceMs: silenceMs ?? v.silenceMs,
  interruptMs: interruptMs ?? v.interruptMs,
  idleSeconds: idleSeconds ?? v.idleSeconds,
);

VoiceSettings withNumber(VoiceSettings v, VoiceNumber k, double n) => switch (k) {
  VoiceNumber.silenceMs => voiceWith(v, silenceMs: n),
  VoiceNumber.interruptMs => voiceWith(v, interruptMs: n),
  VoiceNumber.idleSeconds => voiceWith(v, idleSeconds: n),
};

bool sameVoice(VoiceSettings a, VoiceSettings b) => jsonEncode(a.toJson()) == jsonEncode(b.toJson());

SettingsUpdateVoice voiceOverrides(VoiceSettings defaults, VoiceSettings settings) {
  final d = defaults.toJson();
  final s = settings.toJson();
  return SettingsUpdateVoice.fromJson({
    for (final key in d.keys)
      if (jsonEncode(s[key]) != jsonEncode(d[key])) key: s[key],
  });
}

SettingsUpdateVoice asOverrides(VoiceSettings v) => SettingsUpdateVoice.fromJson(v.toJson());

String? voiceProblem(SettingsUpdateVoice v) {
  final asr = v.asr;
  if (asr is VoiceAsrMicrosoft && asr.region.trim().isEmpty) return '微软识别要填区域，比如 eastasia';
  final llm = v.llm;
  if ((llm is VoiceLlmDeepseek && llm.model.trim().isEmpty) || (llm is VoiceLlmOpenai && llm.model.trim().isEmpty)) return '大模型要填模型名';
  if (llm is VoiceLlmOpenai && !RegExp(r'^https?://\S+$').hasMatch(llm.url.trim())) {
    return '大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions';
  }
  final tts = v.tts;
  if (tts is VoiceTtsMinimax && tts.voiceId.trim().isEmpty) return '音色不能空着：选一个或填 MiniMax 的音色 id';
  if (tts is VoiceTtsMicrosoft && (tts.region.trim().isEmpty || tts.voiceName.trim().isEmpty)) return '微软合成要填区域和音色名';
  if (v.persona != null && v.persona!.trim().isEmpty) return '管家的人设不能空着';
  for (final k in VoiceNumber.values) {
    final n = switch (k) {
      VoiceNumber.silenceMs => v.silenceMs,
      VoiceNumber.interruptMs => v.interruptMs,
      VoiceNumber.idleSeconds => v.idleSeconds,
    };
    final limit = voiceLimits[k]!;
    if (n != null && !(n == n.roundToDouble() && n >= limit.min && n <= limit.max)) return '${VoiceLabel.numbers[k]}要在 ${limit.min} 到 ${limit.max} 之间';
  }
  return null;
}

String keyHint(String key) => '…${key.length > 4 ? key.substring(key.length - 4) : key}';

final _agora = RegExp(r'^[0-9a-f]{32}$', caseSensitive: false);

String? settingsProblem(SettingsUpdate u) {
  final deepseek = u.deepseekApiKey?.trim() ?? '';
  if (deepseek.isNotEmpty && (RegExp(r'\s').hasMatch(deepseek) || deepseek.length < 8)) return 'DeepSeek 的 API Key 看着不对：一串不带空格的字，通常以 sk- 开头';
  final appId = u.agoraAppId?.trim() ?? '';
  if (appId.isNotEmpty && !_agora.hasMatch(appId)) return 'Agora 的 App ID 是 32 位的十六进制，在声网控制台的项目里找';
  final certificate = u.agoraAppCertificate?.trim() ?? '';
  if (certificate.isNotEmpty && !_agora.hasMatch(certificate)) return 'Agora 的 App Certificate 是 32 位的十六进制，在声网控制台的项目里找';
  for (final key in [u.asrKey, u.llmKey, u.ttsKey]) {
    if (RegExp(r'\s').hasMatch(key?.trim() ?? '')) return '语音服务的 key 里不该有空格';
  }
  return u.voice == null ? null : voiceProblem(u.voice!);
}

const keyFrom = <KeySource, String>{KeySource.settings: '存在设置里', KeySource.env: '来自环境变量', KeySource.pi: '用的是 pi 里配的'};

String keyLine(KeyStatus k) => k.source != null ? '在用 ${k.hint ?? ''}（${keyFrom[k.source]}）' : '还没有';
