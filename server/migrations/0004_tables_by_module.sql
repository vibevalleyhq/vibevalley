-- Tables are named for the module that owns them, <module> or <module>_<thing> (AGENTS.md), so one module's table never
-- takes a name another needs. An index is named for its table; SQLite renames no index, so each is made again as it was.

alter table participant rename to channel_participant;
alter table conversation rename to channel_conversation;
alter table message rename to channel_message;
alter table mention rename to channel_mention;
alter table follow rename to channel_follow;
alter table read_cursor rename to channel_read_cursor;
alter table seen_mark rename to channel_seen_mark;
alter table message_delivery rename to channel_delivery;
alter table run rename to session_run;
alter table ledger rename to game_ledger;
alter table lan_gate rename to gate;
alter table lan_device rename to gate_device;

drop index conversation_by_name;
create unique index channel_conversation_by_name on channel_conversation (name) where name is not null;
drop index conversation_by_subject;
create index channel_conversation_by_subject on channel_conversation (subject_kind, subject_id);
drop index conversation_one_general;
create unique index channel_conversation_one_general on channel_conversation (kind) where kind = 'general';
drop index mention_by_target;
create index channel_mention_by_target on channel_mention (target_id, message_seq);
drop index message_by_conversation;
create index channel_message_by_conversation on channel_message (conversation_id, seq);
drop index message_by_sender;
create index channel_message_by_sender on channel_message (sender_id, seq);
drop index message_send_key;
create unique index channel_message_send_key on channel_message (sender_id, send_key) where send_key is not null;
drop index message_delivery_open;
create index channel_delivery_open on channel_delivery (recipient_id, message_seq) where state in ('pending', 'announced', 'handed');
drop index run_by_issue;
create index session_run_by_issue on session_run (issue, started_at);
drop index run_by_session;
create index session_run_by_session on session_run (session, started_at);
