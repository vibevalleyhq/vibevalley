-- An issue's inputs (issue/intake.ts): held until the issue can take them, forwarded to its session, or returned.
-- They read the trigger they are (session_trigger) and how far its delivery got (session_delivery); they write only here.

-- name: HoldIssueTrigger :exec
insert into issue_input (trigger_id, issue_id, created_at) values (sqlc.arg(trigger_id), sqlc.arg(issue_id), sqlc.arg(created_at))
on conflict (trigger_id) do nothing;

-- name: ExistingIssueInput :one
select m.issue_id, m.state, m.session_id, t.trigger_json
from issue_input m join session_trigger t on t.id = m.trigger_id where m.trigger_id = sqlc.arg(trigger_id);

-- name: InputReceipt :one
-- How far an input's delivery to a session got: none when it was never delivered there.
select d.state, d.dropped_why from session_delivery d where d.session_id = sqlc.arg(session_id) and d.envelope_id = sqlc.arg(trigger_id);

-- name: DeliveredTrigger :one
-- The trigger a session's delivery carries: what a helper hands back names the delivery.
select (d.payload_json::jsonb -> 'trigger' ->> 'id')::text as trigger_id
from session_delivery d where d.session_id = sqlc.arg(session_id) and d.envelope_id = sqlc.arg(envelope_id);

-- name: InputsOfIssue :many
-- bound: live input ownership for one issue; consumption remains in session_delivery.
select m.trigger_id, m.issue_id, m.state, m.session_id, m.reason, t.trigger_json
from issue_input m join session_trigger t on t.id = m.trigger_id
where m.issue_id = sqlc.arg(issue_id) and m.state <> 'returned' order by m.position;

-- name: PendingIssueInputs :many
-- bound: inputs that need closing or forwarding to the issue's current recipient.
select m.trigger_id, m.issue_id, m.state, m.session_id, m.reason, t.trigger_json
from issue_input m join session_trigger t on t.id = m.trigger_id
left join session_delivery d on d.session_id = m.session_id and d.envelope_id = m.trigger_id
where m.issue_id = sqlc.arg(issue_id) and m.state <> 'returned'
  and (
    (sqlc.arg(closing)::boolean and (t.trigger_json::jsonb -> 'actor' ->> 'kind' <> 'user' or d.state is distinct from 'consumed'))
    or (not sqlc.arg(closing)::boolean and (
      m.state = 'held' or m.session_id is null
      or (sqlc.narg(recipient)::text is not null and m.session_id <> sqlc.narg(recipient)
        and (d.state is null or d.state in ('pending', 'handed') or (d.state = 'dropped' and d.dropped_why in ('left', 'reassigned'))))
    ))
  )
order by m.position;

-- name: HoldIssueInput :exec
update issue_input set state = 'held', reason = sqlc.narg(reason) where trigger_id = sqlc.arg(trigger_id)
  and (state = 'held' or (state = 'forwarded' and session_id is null));

-- name: ForwardIssueInput :exec
update issue_input set state = 'forwarded', session_id = sqlc.arg(session_id), reason = null
where trigger_id = sqlc.arg(trigger_id) and state <> 'returned';

-- name: ReturnIssueInput :exec
update issue_input set state = 'returned', reason = sqlc.arg(reason)
where trigger_id = sqlc.arg(trigger_id) and state <> 'returned';

-- name: InputsOfQueuedIssues :many
-- bound: non-returned inputs for open queued issues.
select m.issue_id, t.trigger_json
from issue_input m join session_trigger t on t.id = m.trigger_id
join issue i on i.id = m.issue_id
where i.queued_at is not null and i.closed_at is null and m.state <> 'returned'
order by m.issue_id, (t.trigger_json::jsonb -> 'meta' -> 'dispatch' = 'true') desc nulls last, m.position;

-- name: SupersedeDispatch :exec
update issue_input as m set state = 'returned', reason = 'superseded'
from session_trigger as t
where m.trigger_id = t.id and m.issue_id = sqlc.arg(issue_id) and m.trigger_id <> sqlc.arg(trigger_id)
  and t.trigger_json::jsonb -> 'meta' -> 'dispatch' = 'true' and m.state <> 'returned';

-- name: RetireQueuedDispatches :exec
update issue_input as m set state = 'returned', reason = 'unqueued'
from session_trigger as t
where m.trigger_id = t.id and m.issue_id = sqlc.arg(issue_id) and m.state = 'held'
  and t.trigger_json::jsonb -> 'meta' -> 'dispatch' = 'true';
