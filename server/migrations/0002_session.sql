-- A delivery's launch is the run of the session it was handed in (w3#2), not the session: the name says so.
alter table delivery rename column session to launch;

-- Worker is called Session (.agents/notes/proposed/architecture/2026-10-17-worker-is-a-session.md): what held a worker's id
-- holds a session's, and a participant speaking for an agent is kind 'agent'.

alter table issue_worker rename to issue_session;
alter table issue_session rename column worker to session;
drop index issue_worker_by_issue;
create index issue_session_by_issue on issue_session (issue, started_at);

alter table run rename column worker to session;
drop index run_by_worker;
create index run_by_session on run (session, started_at);

alter table memory rename column worker to session;

-- participant is built again for its new kinds; the tables that reference it keep the name (foreign keys are off while a
-- migration runs, migrations.go).
create table participant_new (
  id         text primary key,
  kind       text not null check (kind in ('user', 'manager', 'agent', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  integer not null,
  left_at    integer,
  check ((kind = 'agent') = (agent_id is not null))
);
insert into participant_new (id, kind, name, agent_id, runtime, joined_at, left_at)
  select id, case kind when 'worker' then 'agent' else kind end, name, agent_id, runtime, joined_at, left_at from participant;
drop table participant;
alter table participant_new rename to participant;

-- The JSON kept in rows names the session as the shapes now do.
update ledger set payload = replace(replace(payload, '"workerId":', '"sessionId":'), '"worker":', '"session":')
  where payload like '%"worker%';
update playbook_event set payload = replace(payload, '"worker":', '"session":') where payload like '%"worker":%';
update message set meta = replace(replace(meta, '"workers":', '"sessions":'), '"worker":', '"session":') where meta like '%"worker%';
