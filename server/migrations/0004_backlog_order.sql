-- The board's 待办 in the order the person puts them (rank, lowest first), each with how soon it matters.

alter table backlog add column priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low'));
alter table backlog add column rank integer not null default 0;
update backlog set rank = created_at;
