// Reading the frame's view (packages/protocol/src/view.ts shapes): who is calling (web/src/phone/Phone.tsx callerName).

import '../gen/vibevalley.dart';

/// The caller's name: the helper's, or 管家.
String callerName(InboxItem call) => switch (call.from) {
  InboxFromHelper(:final name) => name,
  InboxFromManager() => '管家',
};
