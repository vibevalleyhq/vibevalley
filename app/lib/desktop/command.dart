// The protocol's schema is not among the generated shapes, so its five cases are written here once, with its JSON form.

sealed class DesktopCommand {
  const DesktopCommand();

  /// null for anything else (a newer app's command).
  static DesktopCommand? fromJson(Object? j) {
    if (j is! Map) return null;
    return switch (j['type']) {
      'voice' => const DesktopVoice(),
      'session' when j['id'] is String => DesktopOpenSession(j['id'] as String),
      'chat' when j['conversation'] is String => DesktopOpenChat(j['conversation'] as String),
      'plans' when j['playbook'] is String => DesktopOpenPlans(j['playbook'] as String),
      'achievements' => const DesktopOpenAchievements(),
      _ => null,
    };
  }

  Map<String, Object> toJson();
}

final class DesktopVoice extends DesktopCommand {
  const DesktopVoice();
  @override
  Map<String, Object> toJson() => {'type': 'voice'};
}

final class DesktopOpenSession extends DesktopCommand {
  const DesktopOpenSession(this.id);
  final String id;
  @override
  Map<String, Object> toJson() => {'type': 'session', 'id': id};
  @override
  bool operator ==(Object other) => other is DesktopOpenSession && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

final class DesktopOpenChat extends DesktopCommand {
  const DesktopOpenChat(this.conversation);
  final String conversation;
  @override
  Map<String, Object> toJson() => {'type': 'chat', 'conversation': conversation};
  @override
  bool operator ==(Object other) => other is DesktopOpenChat && other.conversation == conversation;
  @override
  int get hashCode => conversation.hashCode;
}

final class DesktopOpenPlans extends DesktopCommand {
  const DesktopOpenPlans(this.playbook);
  final String playbook;
  @override
  Map<String, Object> toJson() => {'type': 'plans', 'playbook': playbook};
  @override
  bool operator ==(Object other) => other is DesktopOpenPlans && other.playbook == playbook;
  @override
  int get hashCode => playbook.hashCode;
}

final class DesktopOpenAchievements extends DesktopCommand {
  const DesktopOpenAchievements();
  @override
  Map<String, Object> toJson() => {'type': 'achievements'};
}
