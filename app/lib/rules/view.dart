import '../gen/vibevalley.dart';

String callerName(InboxItem call) => switch (call.from) {
  InboxFromSession(:final name) => name,
  InboxFromManager() => '管家',
};
