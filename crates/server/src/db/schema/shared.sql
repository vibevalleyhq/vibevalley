create table if not exists seq_counter (
  name        text primary key,
  last_number integer not null
);
