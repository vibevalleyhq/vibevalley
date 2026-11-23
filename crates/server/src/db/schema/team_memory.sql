create table if not exists memory (
    id text primary key,
    agent text not null,
    kind text not null,
    body text not null,
    repo text,
    session text,
    author text not null,
    created_at integer not null,
    updated_at integer not null,
    recalled integer not null default 0,
    recalled_at integer
);
create index if not exists memory_agent on memory (agent, created_at);
create unique index if not exists memory_issue_session on memory (agent, session) where kind = 'issue';
