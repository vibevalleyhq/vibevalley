// The farm phone's game pad (web/src/phone/pad.ts): a cross and A, B under the screen, and the keys that stand for
// them. The game on screen attaches its handler to the handset's Pad; the handset's Focus routes the keys to it, so
// they are caught before the farm's own (tools, Esc) while a game is up.

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/widgets.dart';

enum PadButton { left, right, up, down, a, b }

/// A game's handler: a button went down or came up.
typedef PadHandler = void Function(PadButton button, bool down);

/// The one game listening: the pad's buttons and keys press into it.
class Pad {
  PadHandler? _current;

  void attach(PadHandler handler) => _current = handler;

  /// Lets go of `handler`, unless another game took the pad since.
  void detach(PadHandler handler) {
    if (_current == handler) _current = null;
  }

  void press(PadButton button, bool down) => _current?.call(button, down);

  bool get listening => _current != null;
}

final _keys = <LogicalKeyboardKey, PadButton>{
  LogicalKeyboardKey.arrowLeft: PadButton.left,
  LogicalKeyboardKey.arrowRight: PadButton.right,
  LogicalKeyboardKey.arrowUp: PadButton.up,
  LogicalKeyboardKey.arrowDown: PadButton.down,
  LogicalKeyboardKey.space: PadButton.a,
  LogicalKeyboardKey.keyZ: PadButton.a,
  LogicalKeyboardKey.keyX: PadButton.b,
  LogicalKeyboardKey.enter: PadButton.a,
};

/// Presses a key's button into the pad. A held A, B or up does not repeat (a jump, a slam, a turn per press); held
/// arrows the other ways do.
KeyEventResult padKey(Pad pad, KeyEvent e) {
  final button = _keys[e.logicalKey];
  if (button == null) return KeyEventResult.ignored;
  switch (e) {
    case KeyRepeatEvent():
      if (button != PadButton.a && button != PadButton.b && button != PadButton.up) pad.press(button, true);
    case KeyDownEvent():
      pad.press(button, true);
    case KeyUpEvent():
      pad.press(button, false);
  }
  return KeyEventResult.handled;
}

/// Hands the pad to a game while it is on screen (usePad).
mixin PadGame<T extends StatefulWidget> on State<T> {
  Pad get pad;
  void onPad(PadButton button, bool down);

  @override
  void initState() {
    super.initState();
    pad.attach(onPad);
  }

  @override
  void dispose() {
    pad.detach(onPad);
    super.dispose();
  }
}

/// A value the phone keeps while it is away (a game in progress, a best score): this session only.
class Kept<T> extends Notifier<T> {
  Kept(this.initial);
  final T initial;

  @override
  T build() => initial;

  void set(T value) => state = value;
}
