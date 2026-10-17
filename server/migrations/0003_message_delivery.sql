-- delivery is message_delivery: a message's delivery to each recipient, not any other thing delivered.
alter table delivery rename to message_delivery;
drop index delivery_open;
create index message_delivery_open on message_delivery (recipient_id, message_seq) where state in ('pending', 'announced', 'handed');
