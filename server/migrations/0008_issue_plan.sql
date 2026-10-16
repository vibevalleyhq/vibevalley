-- A playbook (种植计划) is a parent issue with a plan; its steps are its sub-issues, each blocked by the steps it
-- needs. The plan and the step are JSON (protocol.IssuePlan, protocol.IssueStep); blocked_by a JSON list of issue ids.
-- The playbooks themselves come over from farm.json when the farm starts (tickets/issues.go adoptPlaybooks). An issue a
-- schedule made (a recurring issue's occurrence) says which.

alter table issue add column parent text references issue (id) on delete cascade;
alter table issue add column blocked_by text;
alter table issue add column plan text;
alter table issue add column step text;
alter table issue add column schedule integer;

create index issue_by_parent on issue (parent);
