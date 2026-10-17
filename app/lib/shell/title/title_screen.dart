import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../glyphs.dart';
import '../sfx.dart';
import 'motion.dart';
import 'scene.dart';
import 'title_stage.dart';
import 'title_state.dart';

enum _Item { start, cont, settings }

const _ink = Color(0xFF3A2A18);
const _picked = Color(0xFFFFE9A8);
const _deep = [Shadow(color: _ink, offset: Offset(4, 4))];
const _soft = [Shadow(color: _ink, offset: Offset(2, 2))];

class TitleScreen extends ConsumerStatefulWidget {
  const TitleScreen({super.key});

  @override
  ConsumerState<TitleScreen> createState() => _TitleScreenState();
}

class _TitleScreenState extends ConsumerState<TitleScreen> with SingleTickerProviderStateMixin {
  _Item? _at;
  bool _panel = false;
  String? _note;
  late final AnimationController _clock = AnimationController(vsync: this, duration: const Duration(days: 1))..forward();

  /// What is focused under it passes the keys up here first, before the app's arrow-key traversal and Enter-to-activate could act on them.
  final _focus = FocusNode(debugLabel: 'title');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _clock.dispose();
    super.dispose();
  }

  bool get _canContinue => hasFarm(ref.read(farmProvider));

  List<({_Item id, String label, bool enabled})> _items(bool canContinue) => [
    (id: _Item.start, label: '开始游戏', enabled: true),
    (id: _Item.cont, label: '继续游戏', enabled: canContinue),
    (id: _Item.settings, label: '设置', enabled: true),
  ];

  _Item _current(bool canContinue) => _at ?? (canContinue ? _Item.cont : _Item.start);

  void _choose(_Item item) {
    Sfx.play('tap');
    final title = ref.read(titleOpenProvider.notifier);
    switch (item) {
      case _Item.start:
        // The manager cannot think without DeepSeek's key: ask for it first.
        if (!managerReady(ref.read(settingsProvider))) {
          setState(() {
            _note = '管家要 DeepSeek 的 API Key 才能干活：先在这里填上。';
            _panel = true;
          });
          return;
        }
        title.enterFarm(start: true);
      case _Item.cont:
        if (_canContinue) title.enterFarm(start: false);
      case _Item.settings:
        setState(() {
          _note = null;
          _panel = !_panel;
        });
    }
  }

  bool _onKey(KeyEvent e) {
    if (e is! KeyDownEvent || !mounted) return false;
    if (_panel) {
      if (e.logicalKey == LogicalKeyboardKey.escape) {
        setState(() => _panel = false);
        return true;
      }
      return false;
    }
    final canContinue = _canContinue;
    final open = _items(canContinue).where((i) => i.enabled).toList();
    final here = open.indexWhere((i) => i.id == _current(canContinue));
    if (e.logicalKey == LogicalKeyboardKey.arrowDown || e.logicalKey == LogicalKeyboardKey.arrowUp) {
      final step = e.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : open.length - 1;
      setState(() => _at = open[(here + step) % open.length].id);
      Sfx.play('pick');
      return true;
    }
    if (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) {
      _choose(_current(canContinue));
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final canContinue = hasFarm(ref.watch(farmProvider));
    final at = _current(canContinue);
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 640;
    final items = _items(canContinue);
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: (_, e) => _onKey(e) ? KeyEventResult.handled : KeyEventResult.ignored,
      child: Semantics(
        container: true,
        label: '码农场物语 首页',
        child: ColoredBox(
          color: const Color(0xFF2A1D2E),
          child: Stack(
            fit: StackFit.expand,
            children: [
              TitleStage(scene: startScene()),
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: math.min(736, size.width * 0.7),
                child: const DecoratedBox(
                  decoration: BoxDecoration(gradient: LinearGradient(colors: [Color(0xBF1E1424), Color(0x591E1424), Color(0x001E1424)])),
                ),
              ),
              SingleChildScrollView(
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: size.height),
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: size.width * 0.06, vertical: 32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AnimatedBuilder(
                          animation: _clock,
                          builder: (context, child) {
                            final t = _seconds;
                            final dy = cssKeyframes([(0, 0), (0.5, -5), (1, 0)], cssProgress(t, 5), cssEaseInOut);
                            return Transform.translate(offset: Offset(0, dy), child: child);
                          },
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '码农场物语',
                                style: TextStyle(
                                  fontFamily: pixelFont,
                                  fontSize: (size.width * 0.06).clamp(40, 72),
                                  height: 1,
                                  color: Palette.cream50,
                                  shadows: _deep,
                                ),
                              ),
                              const SizedBox(height: 12),
                              const Text(
                                '一群写代码的小动物，等你来派活',
                                style: TextStyle(fontFamily: pixelFont, fontSize: 24, color: Palette.cream100, shadows: _soft),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(height: wide ? 40 : 32),
                        Flex(
                          direction: wide ? Axis.horizontal : Axis.vertical,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 224,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  for (var i = 0; i < items.length; i++) ...[
                                    if (i > 0) const SizedBox(height: 12),
                                    _MenuButton(
                                      label: items[i].label,
                                      enabled: items[i].enabled,
                                      picked: at == items[i].id && items[i].enabled,
                                      delay: i * 0.09,
                                      clock: _clock,
                                      onHover: () => setState(() => _at = items[i].id),
                                      onTap: () => _choose(items[i].id),
                                    ),
                                  ],
                                  if (!canContinue) ...[
                                    const SizedBox(height: 12),
                                    const Padding(
                                      padding: EdgeInsets.symmetric(horizontal: 4),
                                      child: Text(
                                        '还没有农场可以继续：先开始游戏。',
                                        style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream100, shadows: _soft),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                            if (_panel) ...[
                              SizedBox(width: wide ? 32 : 0, height: wide ? 0 : 24),
                              SizedBox(
                                width: wide ? math.min(416, size.width - 352) : size.width * 0.88,
                                child: SettingsPanel(note: _note, onClose: () => setState(() => _panel = false)),
                              ),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  double get _seconds => (_clock.lastElapsedDuration?.inMicroseconds ?? 0) / 1e6;
}

class _MenuButton extends StatelessWidget {
  const _MenuButton({
    required this.label,
    required this.enabled,
    required this.picked,
    required this.delay,
    required this.clock,
    required this.onHover,
    required this.onTap,
  });
  final String label;
  final bool enabled;
  final bool picked;
  final double delay;
  final AnimationController clock;
  final VoidCallback onHover;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final button = MouseRegion(
      onEnter: enabled ? (_) => onHover() : null,
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.forbidden,
      child: KitTappable(
        onTap: enabled ? onTap : null,
        semanticLabel: label,
        builder: (context, state) => AnimatedSlide(
          offset: Offset(picked ? 8 / 224 : 0, 0),
          duration: const Duration(milliseconds: 150),
          child: Transform.translate(
            offset: state.pressed ? const Offset(1, 1) : Offset.zero,
            child: Opacity(
              opacity: enabled ? 1 : 0.45,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                decoration: BoxDecoration(
                  color: picked ? _picked : const Color(0xFFF3E2B8),
                  border: Border.all(color: _ink, width: 2),
                  boxShadow: const [BoxShadow(color: Color(0x993A2A18), offset: Offset(2, 2))],
                ),
                foregroundDecoration: state.focused ? BoxDecoration(border: Border.all(color: Palette.leaf500, width: 2)) : null,
                child: Row(
                  children: [
                    SizedBox(
                      width: 16,
                      child: Visibility.maintain(
                        visible: picked,
                        child: const Text(
                          '▶',
                          softWrap: false,
                          overflow: TextOverflow.visible,
                          style: TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, color: Palette.berry),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      label,
                      style: const TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, color: Palette.bark900),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return AnimatedBuilder(
      animation: clock,
      builder: (context, child) {
        final e = (clock.lastElapsedDuration?.inMicroseconds ?? 0) / 1e6 - delay;
        final p = e <= 0 ? 0.0 : (e >= 0.45 ? 1.0 : cssSteps(e / 0.45, 5));
        return Opacity(
          opacity: p,
          child: Transform.translate(offset: Offset(-28 * (1 - p), 0), child: child),
        );
      },
      child: button,
    );
  }
}

const _from = {KeySource.settings: '存在设置里', KeySource.config: '来自配置（vibevalley.yaml 或环境变量）'};

String _keyLine(KeyStatus k) => k.source != null ? '在用 ${k.hint ?? ''}（${_from[k.source]}）' : '还没有';

enum _Key { deepseekApiKey, agoraAppId, agoraAppCertificate }

class SettingsPanel extends ConsumerStatefulWidget {
  const SettingsPanel({super.key, this.note, required this.onClose});
  final String? note;
  final VoidCallback onClose;

  @override
  ConsumerState<SettingsPanel> createState() => _SettingsPanelState();
}

class _SettingsPanelState extends ConsumerState<SettingsPanel> {
  final _deepseek = TextEditingController();
  final _certificate = TextEditingController();
  TextEditingController? _appId;
  final _cleared = <_Key>{};
  String? _error;
  bool _saved = false;
  bool _busy = false;

  @override
  void dispose() {
    _deepseek.dispose();
    _certificate.dispose();
    _appId?.dispose();
    super.dispose();
  }

  void _clear(_Key key) => setState(() {
    _cleared.add(key);
    _saved = false;
  });

  Future<void> _submit(SettingsStatus status) async {
    // A key cleared and not typed again goes as '' (the server forgets it).
    String? value(_Key k, String typed) => typed.trim().isNotEmpty ? typed.trim() : (_cleared.contains(k) ? '' : null);
    final appId = _appId?.text.trim();
    final update = SettingsUpdate(
      deepseekApiKey: value(_Key.deepseekApiKey, _deepseek.text),
      agoraAppId: appId != null && appId != (status.agoraAppId.value ?? '') ? appId : (_cleared.contains(_Key.agoraAppId) ? '' : null),
      agoraAppCertificate: value(_Key.agoraAppCertificate, _certificate.text),
    );
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(settingsProvider.notifier).save(update);
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
      return;
    }
    if (!mounted) return;
    Sfx.play('open');
    setState(() {
      _busy = false;
      _deepseek.clear();
      _certificate.clear();
      _appId?.dispose();
      _appId = null;
      _cleared.clear();
      _saved = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(settingsProvider);
    if (status == null) {
      return _Panel(
        onClose: widget.onClose,
        child: const Text(
          '在问服务端……',
          style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark800),
        ),
      );
    }
    final appId = _appId ??= TextEditingController(text: status.agoraAppId.value ?? '');
    void changed(String _) => setState(() => _saved = false);
    return _Panel(
      onClose: widget.onClose,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.note != null) ...[
            Container(
              color: _picked,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Text(
                widget.note!,
                style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark900),
              ),
            ),
            const SizedBox(height: 16),
          ],
          _KeyField(
            label: 'DeepSeek API Key',
            help: _Link('platform.deepseek.com', Uri.parse('https://platform.deepseek.com/api_keys')),
            line: _cleared.contains(_Key.deepseekApiKey) ? '存的时候清掉' : _keyLine(status.deepseekApiKey),
            canClear: status.deepseekApiKey.source == KeySource.settings && !_cleared.contains(_Key.deepseekApiKey),
            onClear: () => _clear(_Key.deepseekApiKey),
            child: _SecretInput(controller: _deepseek, placeholder: 'sk-…（不改就空着）', label: 'DeepSeek API Key', onChanged: changed),
          ),
          const SizedBox(height: 16),
          _KeyField(
            label: 'Agora App ID',
            help: _Link('console.agora.io', Uri.parse('https://console.agora.io/')),
            line: _cleared.contains(_Key.agoraAppId)
                ? '存的时候清掉'
                : status.agoraAppId.source != null
                ? '（${_from[status.agoraAppId.source]}）'
                : '还没有',
            canClear: status.agoraAppId.source == KeySource.settings && !_cleared.contains(_Key.agoraAppId),
            onClear: () => _clear(_Key.agoraAppId),
            child: _Input(controller: appId, placeholder: '32 位，比如 0123…cdef', label: 'Agora App ID', onChanged: changed),
          ),
          const SizedBox(height: 16),
          _KeyField(
            label: 'Agora App Certificate',
            help: const Text(
              '和 App ID 在同一个项目里',
              style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark500),
            ),
            line: _cleared.contains(_Key.agoraAppCertificate) ? '存的时候清掉' : _keyLine(status.agoraAppCertificate),
            canClear: status.agoraAppCertificate.source == KeySource.settings && !_cleared.contains(_Key.agoraAppCertificate),
            onClear: () => _clear(_Key.agoraAppCertificate),
            child: _SecretInput(controller: _certificate, placeholder: '不改就空着', label: 'Agora App Certificate', onChanged: changed),
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(
              _error!,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.berry),
            ),
          ],
          if (_saved) ...[
            const SizedBox(height: 16),
            const Text(
              '存好了，马上就用上。',
              style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.leaf700),
            ),
          ],
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: Tooltip(
                  message: status.file,
                  child: Text(
                    status.file,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.mono.copyWith(color: Palette.bark500),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              KitTappable(
                onTap: _busy ? null : () => unawaited(_submit(status)),
                semanticLabel: '保存',
                builder: (context, state) => Opacity(
                  opacity: _busy ? 0.5 : 1,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                    decoration: BoxDecoration(
                      color: state.hovered ? Palette.leaf600 : Palette.leaf500,
                      border: Border.all(color: Palette.bark900, width: 2),
                    ),
                    foregroundDecoration: state.focused ? BoxDecoration(border: Border.all(color: Palette.leaf700, width: 2)) : null,
                    child: const Text(
                      '保存',
                      style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream50),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.child, required this.onClose});
  final Widget child;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    label: '设置',
    child: Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: const Color(0xFFF3E2B8),
        border: Border.all(color: _ink, width: 2),
        boxShadow: const [BoxShadow(color: Color(0x993A2A18), offset: Offset(2, 2))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  '设置',
                  style: TextStyle(fontFamily: pixelFont, fontSize: 24, color: Palette.bark900),
                ),
              ),
              KitTappable(
                onTap: onClose,
                semanticLabel: '关上设置',
                builder: (context, state) => Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: PixelMark.cross(size: 14, color: state.hovered ? Palette.bark900 : Palette.bark600),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    ),
  );
}

class _KeyField extends StatelessWidget {
  const _KeyField({required this.label, required this.help, required this.line, required this.canClear, required this.onClear, required this.child});
  final String label;
  final Widget help;
  final String line;
  final bool canClear;
  final VoidCallback onClear;
  final Widget child;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark900),
            ),
          ),
          help,
        ],
      ),
      const SizedBox(height: 4),
      child,
      const SizedBox(height: 4),
      Row(
        children: [
          Expanded(
            child: Text(
              line,
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark600),
            ),
          ),
          if (canClear)
            KitTappable(
              onTap: onClear,
              semanticLabel: '清掉',
              builder: (context, _) => const Text(
                '清掉',
                style: TextStyle(
                  fontFamily: pixelFont,
                  fontSize: 12,
                  color: Palette.berry,
                  decoration: TextDecoration.underline,
                  decorationColor: Palette.berry,
                ),
              ),
            ),
        ],
      ),
    ],
  );
}

class _Link extends StatelessWidget {
  const _Link(this.text, this.uri);
  final String text;
  final Uri uri;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () => kitOpenLink?.call(uri),
    semanticLabel: text,
    builder: (context, _) => Text(
      text,
      style: const TextStyle(
        fontFamily: pixelFont,
        fontSize: 12,
        color: Palette.bark500,
        decoration: TextDecoration.underline,
        decorationColor: Palette.bark500,
      ),
    ),
  );
}

InputDecoration _decoration(String placeholder) => InputDecoration(
  hintText: placeholder,
  hintStyle: KitText.mono.copyWith(color: Palette.bark400),
  isDense: true,
  filled: true,
  fillColor: Palette.cream50,
  contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
  border: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.bark800, width: 2),
  ),
  enabledBorder: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.bark800, width: 2),
  ),
  focusedBorder: const OutlineInputBorder(
    borderRadius: BorderRadius.zero,
    borderSide: BorderSide(color: Palette.leaf600, width: 2),
  ),
);

class _Input extends StatelessWidget {
  const _Input({required this.controller, required this.placeholder, required this.label, required this.onChanged, this.obscure = false});
  final TextEditingController controller;
  final String placeholder;
  final String label;
  final ValueChanged<String> onChanged;
  final bool obscure;

  @override
  Widget build(BuildContext context) => Semantics(
    label: label,
    textField: true,
    child: TextField(
      controller: controller,
      onChanged: onChanged,
      obscureText: obscure,
      autocorrect: false,
      enableSuggestions: false,
      style: KitText.mono,
      decoration: _decoration(placeholder),
    ),
  );
}

class _SecretInput extends StatefulWidget {
  const _SecretInput({required this.controller, required this.placeholder, required this.label, required this.onChanged});
  final TextEditingController controller;
  final String placeholder;
  final String label;
  final ValueChanged<String> onChanged;

  @override
  State<_SecretInput> createState() => _SecretInputState();
}

class _SecretInputState extends State<_SecretInput> {
  bool _shown = false;

  @override
  Widget build(BuildContext context) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: _Input(controller: widget.controller, placeholder: widget.placeholder, label: widget.label, onChanged: widget.onChanged, obscure: !_shown),
        ),
        KitTappable(
          onTap: () => setState(() => _shown = !_shown),
          semanticLabel: _shown ? '藏起来' : '看一眼',
          builder: (context, _) => Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            decoration: const BoxDecoration(
              color: Palette.cream200,
              border: Border(
                top: BorderSide(color: Palette.bark800, width: 2),
                right: BorderSide(color: Palette.bark800, width: 2),
                bottom: BorderSide(color: Palette.bark800, width: 2),
              ),
            ),
            child: Text(
              _shown ? '藏' : '看',
              style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark800),
            ),
          ),
        ),
      ],
    ),
  );
}
