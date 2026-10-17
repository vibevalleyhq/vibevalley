-- A delivery's launch is the run of the session it was handed in (w3#2), not the session: the name says so.
alter table delivery rename column session to launch;
