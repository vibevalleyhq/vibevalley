import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/ui_state.dart';
import '../data/voice.dart';
import '../ui/pixel/pixel.dart';
import 'chat_widgets.dart';
import '../voice/dictation.dart';

/// What a dictation button shows and does now; each kit draws it.
typedef DictationLook = ({String glyph, String tip, bool recording, VoidCallback? onPressed});

/// Tap to start talking, tap again to stop: the words go into the original input field, for the owner to read before sending.
/// It owns the dictation's target; [builder] only draws the button.
class DictationControl extends ConsumerStatefulWidget {
  const DictationControl({super.key, required this.controller, required this.builder});
  final TextEditingController controller;
  final Widget Function(BuildContext context, DictationLook look) builder;

  @override
  ConsumerState<DictationControl> createState() => _DictationControlState();
}

class _DictationControlState extends ConsumerState<DictationControl> {
  late DictationTarget _target;
  DictationTarget _forController(TextEditingController controller) => DictationTarget((words) => insertDictated(controller, words));
  @override
  void initState() {
    super.initState();
    _target = _forController(widget.controller);
  }

  @override
  void didUpdateWidget(covariant DictationControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.controller, widget.controller)) {
      _target.dispose();
      _target = _forController(widget.controller);
    }
  }

  @override
  void dispose() {
    _target.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dictation = ref.watch(dictationProvider);
    // Unknown until the settings are read; the server says what is missing then.
    final settings = ref.watch(settingsProvider);
    final off = settings != null && settings.dictation.url.isEmpty;
    final (glyph, tip) = switch (dictation.phase) {
      _ when off => ('button-record', '听写还没配：在「声音」页的「听写」里填地址和模型'),
      DictationPhase.idle => ('button-record', dictation.problem == null ? '听写：点一下开始说，再点一下停' : '上次没认出来：${dictation.problem}'),
      DictationPhase.recording => ('button-stop', '在听…再点一下停'),
      DictationPhase.transcribing => ('button-wait', '在认字…'),
    };
    return widget.builder(context, (
      glyph: glyph,
      tip: tip,
      recording: dictation.phase == DictationPhase.recording,
      onPressed: off || dictation.phase == DictationPhase.transcribing ? null : () => dictation.toggle(_target),
    ));
  }
}

/// The pixel kit's dictation button.
class DictationButton extends StatelessWidget {
  const DictationButton({super.key, required this.controller, this.size = 28});
  final TextEditingController controller;
  final double size;

  @override
  Widget build(BuildContext context) => DictationControl(
    controller: controller,
    builder: (context, d) => PxButton(
      size: PxSize.custom,
      tone: d.recording ? PxTone.danger : PxTone.plain,
      tooltip: d.tip,
      semanticLabel: '听写',
      onPressed: d.onPressed,
      child: SizedBox.square(
        dimension: size,
        child: Center(child: Glyph(d.glyph)),
      ),
    ),
  );
}

/// Puts dictated words at the cursor, or at the end when the field has none.
void insertDictated(TextEditingController text, String words) {
  final value = text.value;
  final at = value.selection.isValid ? value.selection.start : value.text.length;
  final end = value.selection.isValid ? value.selection.end : value.text.length;
  final before = value.text.substring(0, at);
  // A space only between two Latin words: Chinese runs on without one.
  final ascii = RegExp(r'[A-Za-z0-9]');
  final gap = before.isNotEmpty && ascii.hasMatch(before[before.length - 1]) && ascii.hasMatch(words[0]) ? ' ' : '';
  final inserted = '$gap$words';
  text.value = TextEditingValue(
    text: before + inserted + value.text.substring(end),
    selection: TextSelection.collapsed(offset: at + inserted.length),
  );
}
