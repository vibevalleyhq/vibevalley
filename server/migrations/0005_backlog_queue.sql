-- A 待办 waiting for a free bed (farm/backlog.go): since when; null when it is not waiting.

alter table backlog add column queued_at integer;
