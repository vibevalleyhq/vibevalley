-- Go a2c1851ab, generated from durable/store operations at 1700000000000 ms.
INSERT INTO "durable_conversation" VALUES('from-go','','',0,4,8,'test-model','{}',1700000000000,1700000000000);
INSERT INTO "durable_conversation" VALUES('branch','p','from-go',2,1,3,'test-model','{}',1700000000000,1700000000000);
INSERT INTO "durable_document" VALUES('global','x','pi.governance',1,'{"budget":42}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',1,'pi.user','{"n":1}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',2,'pi.user','{"n":2}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',3,'pi.user','{"n":3}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',4,'pi.user','{"n":4}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',5,'pi.user','{"n":5}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',6,'pi.user','{"n":6}',1700000000000);
INSERT INTO "durable_entry" VALUES('from-go',7,'pi.compaction','{"level":"hard","baseHeadSeq":1,"fromSeq":1,"cutSeq":3,"summary":"three earlier turns"}',1700000000000);
INSERT INTO "durable_signal" VALUES('018bcfe5-6800-7d10-b197-d7cd2bde9d0f',1,'p','pi.submission_settled','question','{"conversationId":"from-go","requestId":"request","result":{"ok":true},"status":"done","submissionId":"question"}',0,0,1700000000000);
INSERT INTO "durable_submission" VALUES('question','from-go','request','prompt','done','{"text":"work"}','p','{"ok":true}',1700000000000,1700000000000);
INSERT INTO "durable_task" VALUES('p','from-go','','','answer',0,'sleeping','',0,5,'resumed','{}',0,'','[]','pi.submission_settled','{}','{}','',1700000000000,1700000000000);
