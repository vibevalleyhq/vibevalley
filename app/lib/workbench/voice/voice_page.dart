import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/remote.dart' show watchSettingsProblem;
import '../../gen/vibevalley.dart';
import '../../data/ui_state.dart' show settingsProvider;
import '../../ui/kit/kit.dart';
import '../shared/layout.dart';
import 'voice_rules.dart';
import 'voice_samples.dart';
import '../shared/widgets.dart';

const _areaLabel = <Area, String>{Area.uS: '美国', Area.eU: '欧洲', Area.aP: '亚太', Area.cN: '中国大陆'};
const _languageLabel = <Language, String>{
  Language.zhCN: '普通话',
  Language.zhHK: '粤语（香港）',
  Language.zhTW: '中文（台湾）',
  Language.enUS: '英语（美国）',
  Language.jaJP: '日语',
  Language.koKR: '韩语',
};

/// What each starts with when picked: the one in use if it is the same vendor, else these.
const _asrLabel = {'ares': '声网 ARES', 'deepgram': 'Deepgram', 'microsoft': '微软'};
const _llmLabel = {'vibevalley': '农场的管家', 'agora': '声网托管', 'deepseek': 'DeepSeek', 'openai': '自己的接口'};
const _ttsLabel = {'minimax': 'MiniMax', 'openai': 'OpenAI', 'microsoft': '微软'};

const _asrStart = <String, VoiceAsr>{
  'ares': VoiceAsrAres(),
  'deepgram': VoiceAsrDeepgram(model: Model.nova3),
  'microsoft': VoiceAsrMicrosoft(region: 'eastasia'),
};
const _llmStart = <String, VoiceLlm>{
  'vibevalley': VoiceLlmVibeValley(),
  'agora': VoiceLlmAgora(model: VoiceLlmAgoraModel.gpt41Mini),
  'deepseek': VoiceLlmDeepseek(model: 'deepseek-chat'),
  'openai': VoiceLlmOpenai(url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini'),
};
const _ttsStart = <String, VoiceTts>{
  'minimax': VoiceTtsMinimax(model: VoiceTtsMinimaxModel.speech26Turbo, voiceId: 'Chinese (Mandarin)_Gentle_Youth'),
  'openai': VoiceTtsOpenai(voice: Voice.nova),
  'microsoft': VoiceTtsMicrosoft(region: 'eastasia', voiceName: 'zh-CN-XiaoxiaoNeural'),
};

String _vendor(Object stage) => switch (stage) {
  VoiceAsr a => a.toJson()['vendor'] as String,
  VoiceLlm l => l.toJson()['vendor'] as String,
  VoiceTts t => t.toJson()['vendor'] as String,
  _ => '',
};

List<SegmentOption<String>> _options(Map<String, String> labels) => [for (final e in labels.entries) SegmentOption(value: e.key, label: e.value)];

enum _Key { agoraAppId, agoraAppCertificate, asrKey, llmKey, ttsKey }

enum VoicePart { line, agent }

/// What 恢复默认 on one page touches.
VoiceSettings withPart(VoicePart part, VoiceSettings onto, VoiceSettings from) => switch (part) {
  VoicePart.line => voiceWith(
    onto,
    area: from.area,
    language: from.language,
    asr: from.asr,
    llm: from.llm,
    silenceMs: from.silenceMs,
    interruptMs: from.interruptMs,
    idleSeconds: from.idleSeconds,
  ),
  VoicePart.agent => voiceWith(onto, persona: from.persona, greeting: from.greeting, failureMessage: from.failureMessage, tts: from.tts),
};

class VoiceSettingsPage extends StatelessWidget {
  const VoiceSettingsPage({super.key});

  @override
  Widget build(BuildContext context) => const VoiceSettingsForm(part: VoicePart.line);
}

class VoiceSettingsForm extends ConsumerStatefulWidget {
  const VoiceSettingsForm({super.key, required this.part});
  final VoicePart part;

  @override
  ConsumerState<VoiceSettingsForm> createState() => _VoiceSettingsFormState();
}

class _VoiceSettingsFormState extends ConsumerState<VoiceSettingsForm> {
  String? _failed;

  @override
  void initState() {
    super.initState();
    ref.read(settingsProvider.notifier).load().catchError((Object e) {
      if (mounted) setState(() => _failed = '$e');
    });
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(settingsProvider);
    if (status == null) {
      return Padding(
        padding: const EdgeInsets.all(32),
        child: Text(_failed != null ? '问不到服务端的设置（$_failed）。服务端是不是旧版本？重启一下再来。' : '在问服务端……', style: KitText.sm.copyWith(color: Palette.bark500)),
      );
    }
    return _VoiceForm(key: ValueKey(status.file), status: status, part: widget.part);
  }
}

class _VoiceForm extends ConsumerStatefulWidget {
  const _VoiceForm({super.key, required this.status, required this.part});
  final SettingsStatus status;
  final VoicePart part;

  @override
  ConsumerState<_VoiceForm> createState() => _VoiceFormState();
}

class _VoiceFormState extends ConsumerState<_VoiceForm> {
  late VoiceSettings _draft = widget.status.voice;
  late String _appId = widget.status.agoraAppId.value ?? '';
  final _secrets = <_Key, String>{};
  final _cleared = <_Key>{};
  String? _error;
  bool _saved = false;
  bool _busy = false;

  SettingsStatus get _status => widget.status;

  void _touched() => _saved = false;
  void _set(VoiceSettings next) => setState(() {
    _draft = next;
    _touched();
  });

  bool get _voiceDirty => !sameVoice(_draft, _status.voice);
  bool get _appIdDirty => _appId.trim() != (_status.agoraAppId.value ?? '');
  bool get _dirty => _voiceDirty || _appIdDirty || _secrets.values.any((v) => v.trim().isNotEmpty) || _cleared.isNotEmpty;

  Future<void> _save() async {
    final update = <String, Object?>{};
    for (final key in _cleared) {
      update[key.name] = '';
    }
    if (_appIdDirty && !_cleared.contains(_Key.agoraAppId)) update['agoraAppId'] = _appId.trim();
    for (final MapEntry(:key, :value) in _secrets.entries) {
      if (value.trim().isNotEmpty) update[key.name] = value.trim();
    }
    // Only this part's fields, over the settings as they are now: the other part may have been saved meanwhile.
    if (_voiceDirty) update['voice'] = asOverrides(withPart(widget.part, _status.voice, _draft)).toJson();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(settingsProvider.notifier).save(SettingsUpdate.fromJson(update));
      if (!mounted) return;
      setState(() {
        _busy = false;
        _secrets.clear();
        _cleared.clear();
        _saved = true;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
    }
  }

  void _undo() => setState(() {
    _draft = _status.voice;
    _appId = _status.agoraAppId.value ?? '';
    _secrets.clear();
    _cleared.clear();
    _error = null;
  });

  Widget _clearButton(_Key key) => TextLink(
    '清掉',
    underline: true,
    color: Palette.berry,
    onTap: () => setState(() {
      _cleared.add(key);
      _touched();
    }),
  );

  Widget _secret(_Key name, String label, KeyStatus current) => PxField(
    label: label,
    hint: Text(_cleared.contains(name) ? '存的时候清掉' : (current.source != null ? '在用 ${current.hint ?? ''}（${keyFrom[current.source]}）' : '还没有')),
    aside: current.source == KeySource.settings && !_cleared.contains(name) ? _clearButton(name) : null,
    child: SecretInput(
      value: _secrets[name] ?? '',
      label: label,
      onChanged: (v) => setState(() {
        _secrets[name] = v;
        _touched();
      }),
    ),
  );

  Widget _number(VoiceNumber key) {
    final limit = voiceLimits[key]!;
    final label = VoiceLabel.numbers[key]!;
    return PxField(
      label: label,
      hint: Text('${limit.min} 到 ${limit.max}，默认 ${_int(numberOf(_status.voiceDefaults, key))}'),
      child: PxTextInput(
        value: _int(numberOf(_draft, key)),
        onChanged: (t) => _set(withNumber(_draft, key, (int.tryParse(t.replaceAll(RegExp(r'\D'), '')) ?? 0).toDouble())),
        mono: true,
        semanticLabel: label,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final part = widget.part;
    final status = _status;
    final problem = watchSettingsProblem(ref, SettingsUpdate(voice: asOverrides(_draft)));
    final atDefaults = sameVoice(_draft, withPart(part, _draft, status.voiceDefaults));
    final bar = PxWindow(
      paper: Palette.cream50,
      padding: const EdgeInsets.all(12),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          if (_error != null)
            Text(_error!, style: KitText.sm.copyWith(color: Palette.berry))
          else if (problem != null)
            Text(problem, style: KitText.sm.copyWith(color: Palette.berry))
          else if (_saved)
            Text('存好了，下一通电话就用上。', style: KitText.sm.copyWith(color: Palette.leaf700))
          else
            Text(_dirty ? '有没存的改动。' : '都存着。', style: KitText.xs.copyWith(color: Palette.bark500)),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              PxButton.text('恢复默认', onPressed: atDefaults ? null : () => _set(withPart(part, _draft, status.voiceDefaults))),
              const SizedBox(width: 8),
              PxButton.text('撤销', onPressed: _dirty ? _undo : null),
              const SizedBox(width: 8),
              PxButton.text(_busy ? '在存…' : '保存', tone: PxTone.primary, onPressed: !_dirty || problem != null || _busy ? null : _save),
            ],
          ),
        ],
      ),
    );
    Widget column(List<Widget> children) => Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 896),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: children),
      ),
    );
    return switch (part) {
      VoicePart.line => Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        child: Column(
          children: [
            Expanded(child: SingleChildScrollView(child: column(_line(context)))),
            const SizedBox(height: 12),
            column([bar]),
          ],
        ),
      ),
      VoicePart.agent => column([..._agent(context), const SizedBox(height: 12), bar]),
    };
  }

  List<Widget> _line(BuildContext context) {
    final status = _status;
    final draft = _draft;
    final asr = draft.asr;
    final llm = draft.llm;
    final ready = status.agoraAppId.source != null && status.agoraAppCertificate.source != null;
    final muted = KitText.xs.copyWith(color: Palette.bark500);
    return [
      PxWindow(
        paper: Palette.cream50,
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('声音', style: KitText.xl),
            Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: '管家用声网的对话式 AI 听你说话、开口回答。这里配线路：凭据、怎么听、用哪个大模型，都可以用声网托管的（不用别的 key），也可以换成自己的服务。管家的人设、开场白和音色在'),
                  WidgetSpan(
                    alignment: PlaceholderAlignment.baseline,
                    baseline: TextBaseline.alphabetic,
                    child: TextLink('管家页', style: KitText.sm, onTap: () => workbenchGo(context, '/manager/voice')),
                  ),
                  const TextSpan(text: '。'),
                ],
              ),
              style: KitText.sm.copyWith(color: Palette.bark600),
            ),
            const SizedBox(height: 4),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                ready ? TintTag('能接通', fill: okTag.fill, ink: okTag.ink) : TintTag('还缺凭据', fill: badTag.fill, ink: badTag.ink),
                Text('改了以后，下一通电话生效', style: muted),
                Tooltip(
                  message: status.file,
                  child: Text(
                    status.file,
                    style: KitText.mono.copyWith(color: Palette.bark500),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      PxCard(
        title: '凭据',
        aside: TextLink('声网控制台 →', onTap: () => openLink('https://console.agora.io/')),
        child: Cols(
          columns: 2,
          children: [
            PxField(
              label: 'App ID',
              hint: Text(_cleared.contains(_Key.agoraAppId) ? '存的时候清掉' : (status.agoraAppId.source != null ? keyFrom[status.agoraAppId.source]! : '还没有')),
              aside: status.agoraAppId.source == KeySource.settings && !_cleared.contains(_Key.agoraAppId) ? _clearButton(_Key.agoraAppId) : null,
              child: PxTextInput(
                value: _appId,
                onChanged: (v) => setState(() {
                  _appId = v;
                  _touched();
                }),
                placeholder: '32 位十六进制',
                mono: true,
                semanticLabel: 'Agora App ID',
              ),
            ),
            _secret(_Key.agoraAppCertificate, 'App Certificate', status.agoraAppCertificate),
            PxField(
              label: VoiceLabel.area,
              hint: const Text('Agora 接口的区域，选离服务端近的；中国大陆的项目选中国大陆。'),
              child: Align(
                alignment: Alignment.centerLeft,
                child: PxSegmented<Area>(
                  value: draft.area,
                  options: [for (final a in Area.values) SegmentOption(value: a, label: _areaLabel[a]!)],
                  onChanged: (area) => _set(voiceWith(draft, area: area)),
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      PxCard(
        title: '听',
        aside: const Text('识别 · VAD 断句'),
        child: Cols(
          columns: 2,
          children: [
            PxField(
              label: VoiceLabel.asr,
              hint: Text(asr is VoiceAsrMicrosoft ? '微软 Azure 语音，用自己的 key。' : '声网托管，不用别的 key。'),
              child: Align(
                alignment: Alignment.centerLeft,
                child: PxSegmented<String>(
                  value: _vendor(asr),
                  options: _options(_asrLabel),
                  onChanged: (v) => _set(voiceWith(draft, asr: _vendor(asr) == v ? asr : _asrStart[v])),
                ),
              ),
            ),
            PxField(
              label: VoiceLabel.language,
              hint: const Text('听哪种话。人设里也写明用这种话回答。'),
              child: PxPick(
                value: draft.language.wire,
                options: [for (final l in voiceLanguages) PickOption(value: l.wire, label: _languageLabel[l]!, detail: l.wire)],
                onChanged: (l) {
                  if (l.isNotEmpty) _set(voiceWith(draft, language: Language.fromJson(l)));
                },
                placeholder: '语言',
                semanticLabel: '语言',
              ),
            ),
            if (asr case VoiceAsrDeepgram(:final model))
              PxField(
                label: 'Deepgram 模型',
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: PxSegmented<Model>(
                    value: model,
                    options: [for (final m in deepgramModels) SegmentOption(value: m, label: m.wire)],
                    onChanged: (model) => _set(voiceWith(draft, asr: VoiceAsrDeepgram(model: model))),
                  ),
                ),
              ),
            if (asr case VoiceAsrMicrosoft(:final region)) ...[
              PxField(
                label: 'Azure 区域',
                hint: const Text('语音资源所在的区域，比如 eastasia、eastus。'),
                child: PxTextInput(
                  value: region,
                  onChanged: (region) => _set(voiceWith(draft, asr: VoiceAsrMicrosoft(region: region))),
                  mono: true,
                  semanticLabel: '识别的 Azure 区域',
                ),
              ),
              if (needsAsrKey(asr)) _secret(_Key.asrKey, '微软语音的 key', status.asrKey),
            ],
            _number(VoiceNumber.silenceMs),
            _number(VoiceNumber.interruptMs),
            _number(VoiceNumber.idleSeconds),
          ],
        ),
      ),
      const SizedBox(height: 12),
      PxCard(
        title: '想',
        aside: Text(_llmLabel[_vendor(llm)]!),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            PxField(
              label: VoiceLabel.llm,
              hint: Text(_llmHint(llm, status)),
              child: Align(
                alignment: Alignment.centerLeft,
                child: PxSegmented<String>(
                  value: _vendor(llm),
                  options: _options(_llmLabel),
                  onChanged: (v) => _set(voiceWith(draft, llm: _vendor(llm) == v ? llm : _llmStart[v])),
                ),
              ),
            ),
            ...switch (llm) {
              VoiceLlmAgora(:final model) => [
                const SizedBox(height: 16),
                PxField(
                  label: '模型',
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: PxSegmented<VoiceLlmAgoraModel>(
                      value: model,
                      options: [for (final m in voiceModels) SegmentOption(value: m, label: m.wire)],
                      onChanged: (model) => _set(voiceWith(draft, llm: VoiceLlmAgora(model: model))),
                    ),
                  ),
                ),
              ],
              VoiceLlmDeepseek(:final model) => [
                const SizedBox(height: 16),
                PxField(
                  label: '模型',
                  hint: const Text('DeepSeek 的模型名。'),
                  child: PxTextInput(
                    value: model,
                    onChanged: (model) => _set(voiceWith(draft, llm: VoiceLlmDeepseek(model: model))),
                    mono: true,
                    semanticLabel: 'DeepSeek 模型',
                    suggestions: const ['deepseek-chat'],
                  ),
                ),
              ],
              VoiceLlmOpenai(:final url, :final model) => [
                const SizedBox(height: 16),
                Cols(
                  columns: 2,
                  children: [
                    PxField(
                      label: '地址',
                      hint: const Text('OpenAI 兼容的 chat completions 完整地址。'),
                      child: PxTextInput(
                        value: url,
                        onChanged: (url) => _set(
                          voiceWith(
                            draft,
                            llm: VoiceLlmOpenai(url: url, model: model),
                          ),
                        ),
                        mono: true,
                        semanticLabel: '大模型地址',
                      ),
                    ),
                    PxField(
                      label: '模型',
                      child: PxTextInput(
                        value: model,
                        onChanged: (model) => _set(
                          voiceWith(
                            draft,
                            llm: VoiceLlmOpenai(url: url, model: model),
                          ),
                        ),
                        mono: true,
                        semanticLabel: '大模型名',
                      ),
                    ),
                    if (needsLlmKey(llm)) _secret(_Key.llmKey, '接口的 key', status.llmKey),
                  ],
                ),
              ],
              VoiceLlmVibeValley() => const <Widget>[],
            },
          ],
        ),
      ),
    ];
  }

  List<Widget> _agent(BuildContext context) {
    final status = _status;
    final draft = _draft;
    final tts = draft.tts;
    return [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Text.rich(
          TextSpan(
            children: [
              const TextSpan(text: '打电话时管家怎么开口、用什么声音。凭据、怎么听、用哪个大模型在'),
              WidgetSpan(
                alignment: PlaceholderAlignment.baseline,
                baseline: TextBaseline.alphabetic,
                child: TextLink('声音', style: KitText.xs, onTap: () => workbenchGo(context, '/voice')),
              ),
              const TextSpan(text: '页。'),
            ],
          ),
          style: KitText.xs.copyWith(color: Palette.bark600),
        ),
      ),
      const SizedBox(height: 12),
      PxCard(
        title: '开口',
        aside: const Text('人设 · 开场白'),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            PxField(
              label: VoiceLabel.persona,
              hint: Text(draft.llm is VoiceLlmVibeValley ? '「想」选了农场的管家：它自己接电话，用的是它自己的提示词，这段人设不用。' : '语音管家是谁、怎么说话。他看不到地里，派活由本机的管家做；写明别编进度。'),
              child: PxTextArea(
                value: draft.persona,
                onChanged: (persona) => _set(voiceWith(draft, persona: persona)),
                rows: 8,
                semanticLabel: '人设',
              ),
            ),
            const SizedBox(height: 16),
            Cols(
              columns: 2,
              children: [
                PxField(
                  label: VoiceLabel.greeting,
                  hint: const Text('接通时先说的一句。'),
                  child: PxTextInput(
                    value: draft.greeting,
                    onChanged: (greeting) => _set(voiceWith(draft, greeting: greeting)),
                    semanticLabel: '开场白',
                  ),
                ),
                PxField(
                  label: VoiceLabel.failureMessage,
                  hint: const Text('大模型出错时说的一句。'),
                  child: PxTextInput(
                    value: draft.failureMessage,
                    onChanged: (failureMessage) => _set(voiceWith(draft, failureMessage: failureMessage)),
                    semanticLabel: '出错时说',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      PxCard(
        title: '说',
        aside: Text(_ttsLabel[_vendor(tts)]!),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Cols(
              columns: 2,
              children: [
                PxField(
                  label: VoiceLabel.tts,
                  hint: Text(tts is VoiceTtsMicrosoft ? '微软 Azure 语音，用自己的 key。' : '声网托管，不用别的 key。'),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: PxSegmented<String>(
                      value: _vendor(tts),
                      options: _options(_ttsLabel),
                      onChanged: (v) => _set(voiceWith(draft, tts: _vendor(tts) == v ? tts : _ttsStart[v])),
                    ),
                  ),
                ),
                ...switch (tts) {
                  VoiceTtsMinimax(:final model, :final voiceId) => [
                    PxField(
                      label: '合成模型',
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: PxSegmented<VoiceTtsMinimaxModel>(
                          value: model,
                          options: [for (final m in voiceTtsModels) SegmentOption(value: m, label: m.wire)],
                          onChanged: (model) => _set(
                            voiceWith(
                              draft,
                              tts: VoiceTtsMinimax(model: model, voiceId: voiceId),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                  VoiceTtsOpenai(:final voice) => [
                    PxField(
                      label: '音色',
                      hint: const Text('OpenAI tts-1 的音色。'),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: PxSegmented<Voice>(
                          value: voice,
                          options: [for (final v in openaiVoices) SegmentOption(value: v, label: v.wire)],
                          onChanged: (voice) => _set(voiceWith(draft, tts: VoiceTtsOpenai(voice: voice))),
                        ),
                      ),
                    ),
                  ],
                  VoiceTtsMicrosoft(:final region, :final voiceName) => [
                    PxField(
                      label: 'Azure 区域',
                      child: PxTextInput(
                        value: region,
                        onChanged: (region) => _set(
                          voiceWith(
                            draft,
                            tts: VoiceTtsMicrosoft(region: region, voiceName: voiceName),
                          ),
                        ),
                        mono: true,
                        semanticLabel: '合成的 Azure 区域',
                      ),
                    ),
                    PxField(
                      label: '音色',
                      hint: const Text('Azure 的神经网络音色名，比如 zh-CN-XiaoxiaoNeural。'),
                      child: PxTextInput(
                        value: voiceName,
                        onChanged: (voiceName) => _set(
                          voiceWith(
                            draft,
                            tts: VoiceTtsMicrosoft(region: region, voiceName: voiceName),
                          ),
                        ),
                        mono: true,
                        semanticLabel: '微软音色',
                        suggestions: microsoftVoices,
                      ),
                    ),
                    if (needsTtsKey(tts)) _secret(_Key.ttsKey, '微软语音的 key', status.ttsKey),
                  ],
                },
              ],
            ),
            if (tts case VoiceTtsMinimax(:final model, :final voiceId)) ...[
              const SizedBox(height: 16),
              PxField(
                label: '音色',
                hint: const Text('点名字选它，点左边的播放键先听一句；也可以在下面填别的 MiniMax 系统音色 id。'),
                child: MiniMaxVoices(
                  value: voiceId,
                  onChanged: (voiceId) => _set(
                    voiceWith(
                      draft,
                      tts: VoiceTtsMinimax(model: model, voiceId: voiceId),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Cols(
                columns: 2,
                children: [
                  PxField(
                    label: '音色 id',
                    child: PxTextInput(
                      value: voiceId,
                      onChanged: (voiceId) => _set(
                        voiceWith(
                          draft,
                          tts: VoiceTtsMinimax(model: model, voiceId: voiceId),
                        ),
                      ),
                      mono: true,
                      semanticLabel: '音色 id',
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    ];
  }
}

String _int(double n) => n == n.roundToDouble() ? n.toInt().toString() : n.toString();

String _llmHint(VoiceLlm llm, SettingsStatus status) => switch (llm) {
  VoiceLlmVibeValley() => '田头上那个管家本人接电话：看得到地里，自己派活，记得你们说过的话。声网经隧道（cloudflared）访问本机的一个接口，只有这一个接口对外，每通电话一把钥匙。',
  VoiceLlmAgora() => '声网托管的模型，不用别的 key。',
  VoiceLlmDeepseek() =>
    status.deepseekApiKey.source != null ? '用农场的 DeepSeek key（${keyFrom[status.deepseekApiKey.source]}）。' : '用农场的 DeepSeek key，现在还没有：去首页「设置」填。',
  VoiceLlmOpenai() => '任何 OpenAI 兼容的接口：通义、Kimi、自己部署的……',
};

class SecretInput extends StatefulWidget {
  const SecretInput({super.key, required this.value, required this.onChanged, required this.label, this.placeholder = '不改就空着'});
  final String value;
  final ValueChanged<String> onChanged;
  final String label;
  final String placeholder;

  @override
  State<SecretInput> createState() => _SecretInputState();
}

class _SecretInputState extends State<SecretInput> {
  bool _shown = false;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: PxTextInput(
          value: widget.value,
          onChanged: widget.onChanged,
          placeholder: widget.placeholder,
          semanticLabel: widget.label,
          mono: true,
          well: true,
          obscure: !_shown,
        ),
      ),
      const SizedBox(width: 8),
      PxButton.text(_shown ? '藏' : '看', semanticLabel: _shown ? '藏起来' : '看一眼', onPressed: () => setState(() => _shown = !_shown)),
    ],
  );
}

class MiniMaxVoices extends StatefulWidget {
  const MiniMaxVoices({super.key, required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

  @override
  State<MiniMaxVoices> createState() => _MiniMaxVoicesState();
}

class _MiniMaxVoicesState extends State<MiniMaxVoices> {
  String? _playing;

  @override
  void dispose() {
    final playing = _playing;
    _playing = null;
    if (playing != null) Samples.stop();
    super.dispose();
  }

  void _play(String id, String asset) {
    if (_playing == id) return Samples.stop();
    setState(() => _playing = id);
    Samples.play(asset, () {
      if (mounted && _playing == id) setState(() => _playing = null);
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final columns = MediaQuery.sizeOf(context).width >= 640 ? 3 : 2;
      final width = (box.maxWidth - 6 * (columns - 1)) / columns;
      return Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final v in minimaxVoices)
            SizedBox(
              width: width,
              child: _VoiceChip(
                label: v.label,
                id: v.id,
                chosen: v.id == widget.value,
                playing: _playing == v.id,
                onPlay: switch (voiceSample(v.id)) {
                  final asset? => () => _play(v.id, asset),
                  null => null,
                },
                onChoose: () => widget.onChanged(v.id),
              ),
            ),
        ],
      );
    },
  );
}

class _VoiceChip extends StatelessWidget {
  const _VoiceChip({required this.label, required this.id, required this.chosen, required this.playing, required this.onPlay, required this.onChoose});
  final String label;
  final String id;
  final bool chosen;
  final bool playing;
  final VoidCallback? onPlay;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: null,
    builder: (context, _) => Container(
      color: chosen ? Palette.leaf300.withValues(alpha: .5) : Palette.cream50,
      foregroundDecoration: chosen ? pxRing : null,
      child: Row(
        children: [
          KitTappable(
            onTap: onPlay,
            tooltip: onPlay != null ? '试听：$defaultGreeting' : '没有样音',
            semanticLabel: playing ? '停下 $label' : '试听 $label',
            builder: (context, s) => Opacity(
              opacity: onPlay == null ? .3 : 1,
              child: Container(
                width: 32,
                height: 32,
                alignment: Alignment.center,
                foregroundDecoration: pxRing,
                child: SpriteIcon(playing ? 'button-stop' : 'button-play', size: 20),
              ),
            ),
          ),
          Expanded(
            child: KitTappable(
              onTap: onChoose,
              tooltip: id,
              selected: chosen,
              builder: (context, s) => Container(
                color: !chosen && s.hovered ? Palette.cream200 : null,
                foregroundDecoration: pxRing,
                padding: const EdgeInsets.fromLTRB(0, 6, 8, 6),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: KitText.sm.copyWith(color: chosen ? Palette.leaf700 : Palette.bark900),
                ),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
