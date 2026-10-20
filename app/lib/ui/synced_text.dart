import 'package:flutter/widgets.dart';

/// Follows a controlled `value` without moving the caret while the user types.
class SyncedText {
  SyncedText(String value) : controller = TextEditingController(text: value);
  final TextEditingController controller;

  /// `at`: where the cursor goes when the text is replaced from outside; the end when not given.
  void follow(String value, [TextSelection? at]) {
    if (controller.text == value) return;
    controller.value = TextEditingValue(
      text: value,
      selection: at ?? TextSelection.collapsed(offset: value.length),
    );
  }
}
