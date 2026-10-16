-- The board's 待办 (farm/backlog.go): jobs written down, not sent yet. A started one is deleted: it is a helper's
-- ticket from then on.

create table backlog (
  id          text primary key,
  text        text not null,
  project     text,
  agent       text,
  created_at  integer not null
);
