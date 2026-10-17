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

bool needsAsrKey(VoiceAsr asr) => asr is VoiceAsrMicrosoft;
bool needsLlmKey(VoiceLlm llm) => llm is VoiceLlmOpenai;
bool needsTtsKey(VoiceTts tts) => tts is VoiceTtsMicrosoft;

enum VoiceNumber { silenceMs, interruptMs, idleSeconds }

const voiceLimits = <VoiceNumber, ({int min, int max})>{
  VoiceNumber.silenceMs: (min: voiceSilenceMsMin, max: voiceSilenceMsMax),
  VoiceNumber.interruptMs: (min: voiceInterruptMsMin, max: voiceInterruptMsMax),
  VoiceNumber.idleSeconds: (min: voiceIdleSecondsMin, max: voiceIdleSecondsMax),
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

SettingsUpdateVoice asOverrides(VoiceSettings v) => SettingsUpdateVoice.fromJson(v.toJson());

const keyFrom = <KeySource, String>{KeySource.settings: '存在设置里', KeySource.config: '来自配置（vibevalley.yaml 或环境变量）'};
