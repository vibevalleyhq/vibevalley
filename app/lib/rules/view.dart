import '../gen/vibevalley.dart';

String callerName(InboxItem call) => switch (call.from) {
  InboxFromHelper(:final name) => name,
  InboxFromManager() => '管家',
};
