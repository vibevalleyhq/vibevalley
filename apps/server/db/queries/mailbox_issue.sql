-- name: HoldIssueTrigger :exec
insert into mailbox_issue (trigger_id, issue_id, created_at) values (sqlc.arg(trigger_id), sqlc.arg(issue_id), sqlc.arg(created_at))
on conflict (trigger_id) do nothing;

-- name: ExistingIssueInput :one
select m.issue_id, m.state, m.session_id, t.trigger_json
from mailbox_issue m join mailbox_trigger t on t.id = m.trigger_id where m.trigger_id = sqlc.arg(trigger_id);

-- name: IssueInputs :many
-- bound: live input ownership for one issue; consumption remains in mailbox_delivery.
select m.trigger_id, m.issue_id, m.state, m.session_id, m.reason, t.trigger_json
from mailbox_issue m join mailbox_trigger t on t.id = m.trigger_id
where m.issue_id = sqlc.arg(issue_id) and m.state <> 'returned' order by t.routing_position;

-- name: PendingIssueInputs :many
-- bound: inputs that need closing or forwarding to the issue's current recipient.
select m.trigger_id, m.issue_id, m.state, m.session_id, m.reason, t.trigger_json
from mailbox_issue m join mailbox_trigger t on t.id = m.trigger_id
left join mailbox_delivery d on d.session_id = m.session_id and d.envelope_id = m.trigger_id
where m.issue_id = sqlc.arg(issue_id) and m.state <> 'returned'
  and (
    (sqlc.arg(closing)::boolean and (t.trigger_json -> 'actor' ->> 'kind' <> 'owner' or d.state is not 'consumed'))
    or (not sqlc.arg(closing)::boolean and (
      m.state = 'held' or m.session_id is null
      or (sqlc.narg(recipient)::text is not null and m.session_id <> sqlc.narg(recipient)
        and (d.state is null or d.state in ('pending', 'handed') or (d.state = 'dropped' and d.dropped_why in ('left', 'reassigned'))))
    ))
  )
order by t.routing_position;

-- name: HoldIssueInput :exec
update mailbox_issue set state = 'held', reason = sqlc.narg(reason) where trigger_id = sqlc.arg(trigger_id)
  and (state = 'held' or (state = 'forwarded' and session_id is null));

-- name: ForwardIssueInput :exec
update mailbox_issue set state = 'forwarded', session_id = sqlc.arg(session_id), reason = null
where trigger_id = sqlc.arg(trigger_id) and state <> 'returned';

-- name: ReturnIssueInput :exec
update mailbox_issue set state = 'returned', reason = sqlc.arg(reason)
where trigger_id = sqlc.arg(trigger_id) and state <> 'returned';

-- name: QueuedInputs :many
-- bound: non-returned inputs for open queued issues.
select m.issue_id, t.trigger_json
from mailbox_issue m join mailbox_trigger t on t.id = m.trigger_id
join issue i on i.id = m.issue_id
where i.queued_at is not null and i.closed_at is null and m.state <> 'returned'
order by m.issue_id, (t.trigger_json -> 'meta' -> 'dispatch' = 'true') desc nulls last, t.routing_position;

-- name: SupersedeDispatch :exec
update mailbox_issue as m set state = 'returned', reason = 'superseded'
from mailbox_trigger as t
where m.trigger_id = t.id and m.issue_id = sqlc.arg(issue_id) and m.trigger_id <> sqlc.arg(trigger_id)
  and t.trigger_json -> 'meta' -> 'dispatch' = 'true' and m.state <> 'returned';

-- name: RetireQueuedDispatches :exec
update mailbox_issue as m set state = 'returned', reason = 'unqueued'
from mailbox_trigger as t
where m.trigger_id = t.id and m.issue_id = sqlc.arg(issue_id) and m.state = 'held'
  and t.trigger_json -> 'meta' -> 'dispatch' = 'true';

