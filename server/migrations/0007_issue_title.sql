-- An issue has a title and a description, as Linear's: the title is the first line of what it said that says something,
-- the description the rest.

alter table issue add column title text not null default '';
alter table issue rename column text to description;

update issue set description = trim(description, ' ' || char(9) || char(10) || char(13));
update issue set
  title = trim(case when instr(description, char(10)) > 0 then substr(description, 1, instr(description, char(10)) - 1) else description end, ' ' || char(9) || char(13)),
  description = case when instr(description, char(10)) > 0 then trim(substr(description, instr(description, char(10)) + 1), ' ' || char(9) || char(10) || char(13)) else '' end;
