// The protocol's schema is not among the generated shapes, so its five cases are written here once, with its JSON form.

sealed class HostCommand {
  const HostCommand();

  /// null for anything else (a newer app's command).
  static HostCommand? fromJson(Object? j) {
    if (j is! Map) return null;
    return switch (j['type']) {
      'voice' => const HostVoice(),
      'session' when j['id'] is String => HostOpenSession(j['id'] as String),
      'chat' when j['conversation'] is String => HostOpenChat(j['conversation'] as String),
      'plans' when j['playbook'] is String => HostOpenPlans(j['playbook'] as String),
      'achievements' => const HostOpenAchievements(),
      _ => null,
    };
  }

  Map<String, Object> toJson();
}

final class HostVoice extends HostCommand {
  const HostVoice();
  @override
  Map<String, Object> toJson() => {'type': 'voice'};
}

final class HostOpenSession extends HostCommand {
  const HostOpenSession(this.id);
  final String id;
  @override
  Map<String, Object> toJson() => {'type': 'session', 'id': id};
  @override
  bool operator ==(Object other) => other is HostOpenSession && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

final class HostOpenChat extends HostCommand {
  const HostOpenChat(this.conversation);
  final String conversation;
  @override
  Map<String, Object> toJson() => {'type': 'chat', 'conversation': conversation};
  @override
  bool operator ==(Object other) => other is HostOpenChat && other.conversation == conversation;
  @override
  int get hashCode => conversation.hashCode;
}

final class HostOpenPlans extends HostCommand {
  const HostOpenPlans(this.playbook);
  final String playbook;
  @override
  Map<String, Object> toJson() => {'type': 'plans', 'playbook': playbook};
  @override
  bool operator ==(Object other) => other is HostOpenPlans && other.playbook == playbook;
  @override
  int get hashCode => playbook.hashCode;
}

final class HostOpenAchievements extends HostCommand {
  const HostOpenAchievements();
  @override
  Map<String, Object> toJson() => {'type': 'achievements'};
}
