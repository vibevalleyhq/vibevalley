use super::{
    Endpoint, Error, Options, Principal, RpcError, Transport,
    wire::{Frame, Outbox, Reassembler},
};
use crate::{
    delta::{Op, PendingOps, Snapshot},
    watch::Event,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    task::JoinSet,
    time::{self, Instant},
};
use tokio_util::sync::CancellationToken;

struct Handle {
    commands: mpsc::UnboundedSender<Command>,
    stop: CancellationToken,
    reason: watch::Receiver<Option<Error>>,
    peer: Principal,
    sequence: AtomicU64,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[derive(Clone)]
pub struct Link(Arc<Handle>);
impl Link {
    pub fn peer(&self) -> &Principal {
        &self.0.peer
    }
    pub fn close(&self) {
        self.0.stop.cancel();
    }
    pub fn is_closed(&self) -> bool {
        self.0.stop.is_cancelled() || self.0.reason.borrow().is_some()
    }
    pub async fn closed(&self) -> Error {
        let mut why = self.0.reason.clone();
        let result = why.wait_for(Option::is_some).await;
        result.ok().and_then(|v| v.clone()).unwrap_or(Error::Closed)
    }
    fn id(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.0.sequence.fetch_add(1, Ordering::Relaxed))
    }
    pub async fn call(&self, method: impl Into<String>, params: Value, timeout: Option<Duration>) -> Result<Value, Error> {
        if timeout.is_some_and(|d| d.is_zero()) {
            return Err(Error::Deadline);
        }
        let id = self.id("r");
        let (tx, rx) = oneshot::channel();
        let timeout_ms = timeout.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX).max(1));
        self.0
            .commands
            .send(Command::Call {
                id: id.clone(),
                method: method.into(),
                params,
                timeout_ms,
                reply: tx,
            })
            .map_err(|_| Error::Closed)?;
        let mut guard = CancelCall(Some((id, self.0.commands.clone())));
        let result = match timeout {
            Some(d) => time::timeout(d, rx).await.map_err(|_| Error::Deadline)?,
            None => rx.await,
        }
        .map_err(|_| Error::Closed)?;
        guard.0 = None;
        result
    }
    pub fn watch(&self, target: impl Into<String>, from_rev: i64, initial: Option<Snapshot>) -> Result<RemoteWatch, Error> {
        let (box_, rx) = Mailbox::new(initial.unwrap_or_else(|| Snapshot::new(Value::Null)), from_rev);
        let id = self.id("w");
        self.0
            .commands
            .send(Command::Watch {
                id: id.clone(),
                target: target.into(),
                mailbox: box_.clone(),
                from_rev,
            })
            .map_err(|_| Error::Closed)?;
        Ok(RemoteWatch {
            mailbox: box_,
            ready: rx,
            scope: (self.0.commands.clone(), id),
            reason: self.0.reason.clone(),
        })
    }
}
struct CancelCall(Option<(String, mpsc::UnboundedSender<Command>)>);
impl Drop for CancelCall {
    fn drop(&mut self) {
        if let Some((id, tx)) = self.0.take() {
            let _ = tx.send(Command::Cancel(id));
        }
    }
}

struct Mail {
    rev: i64,
    snap: Snapshot,
    pending: PendingOps,
    has_event: bool,
    retired: bool,
    overflow: bool,
    end: Option<Error>,
}
#[derive(Clone)]
pub(super) struct Mailbox {
    mail: Arc<Mutex<Mail>>,
    ready: flume::Sender<()>,
}
impl Mailbox {
    pub(super) fn new(snap: Snapshot, rev: i64) -> (Self, flume::Receiver<()>) {
        let (ready, rx) = flume::bounded(1);
        (
            Self {
                mail: Arc::new(Mutex::new(Mail {
                    rev,
                    snap,
                    pending: PendingOps::new(10_000),
                    has_event: false,
                    retired: false,
                    overflow: false,
                    end: None,
                })),
                ready,
            },
            rx,
        )
    }
    fn push(&self, rev: i64, ops: Vec<Op>, retired: bool, overflow: bool) -> Result<(), Error> {
        let mut mail = self.mail.lock().unwrap();
        if retired {
            mail.pending.clear();
            mail.overflow = false;
        } else {
            mail.snap = mail.snap.apply(&ops).map_err(|e| Error::Protocol(e.to_string()))?;
            mail.pending.push(&ops);
            mail.overflow |= overflow;
        }
        mail.rev = rev;
        mail.retired = retired;
        mail.has_event = true;
        let _ = self.ready.try_send(());
        Ok(())
    }
    pub(super) fn deliver(&self, e: Event) {
        let mut m = self.mail.lock().unwrap();
        m.rev = e.rev;
        m.snap = e.snapshot;
        m.retired = e.retired;
        m.has_event = true;
        if e.retired {
            m.pending.clear();
            m.overflow = false;
        } else {
            m.pending.push(&e.ops);
            m.overflow |= e.overflow;
        }
        let _ = self.ready.try_send(());
    }
    pub(super) fn end(&self, error: Error) {
        self.mail.lock().unwrap().end = Some(error);
        let _ = self.ready.try_send(());
    }
    pub(super) fn cursor(&self) -> (i64, Snapshot, bool) {
        let m = self.mail.lock().unwrap();
        (m.rev, m.snap.clone(), m.retired)
    }
    pub(super) fn take(&self) -> Result<Option<Event>, Error> {
        let mut m = self.mail.lock().unwrap();
        if m.has_event {
            m.has_event = false;
            let snapshot = m.snap.clone();
            let (ops, overflow) = m.pending.drain(&snapshot);
            let overflow = overflow | std::mem::take(&mut m.overflow);
            return Ok(Some(Event {
                rev: m.rev,
                snapshot,
                ops,
                retired: m.retired,
                overflow,
            }));
        }
        if let Some(e) = &m.end {
            return Err(e.clone());
        }
        Ok(None)
    }
}

pub struct RemoteWatch {
    pub(super) mailbox: Mailbox,
    pub(super) ready: flume::Receiver<()>,
    scope: (mpsc::UnboundedSender<Command>, String),
    reason: watch::Receiver<Option<Error>>,
}
impl RemoteWatch {
    pub fn revision(&self) -> i64 {
        self.mailbox.cursor().0
    }
    pub async fn recv(&mut self) -> Result<Event, Error> {
        loop {
            if let Some(e) = self.mailbox.take()? {
                return Ok(e);
            }
            tokio::select! {
                biased;
                result = self.ready.recv_async()=>result.map_err(|_|Error::Closed)?,
                reason = self.reason.wait_for(Option::is_some)=> return Err(reason.ok().and_then(|r|r.clone()).unwrap_or(Error::Closed)),
            }
        }
    }
}
impl Drop for RemoteWatch {
    fn drop(&mut self) {
        let _ = self.scope.0.send(Command::StopWatch(self.scope.1.clone()));
    }
}

type Response = oneshot::Sender<Result<Value, Error>>;
enum Command {
    Call {
        id: String,
        method: String,
        params: Value,
        timeout_ms: u64,
        reply: Response,
    },
    Cancel(String),
    Watch {
        id: String,
        target: String,
        from_rev: i64,
        mailbox: Mailbox,
    },
    StopWatch(String),
}
#[derive(Clone)]
struct Writer {
    queue: Arc<Mutex<Outbox>>,
    ready: Arc<Notify>,
    max_frame: usize,
    max_message: usize,
}
impl Writer {
    fn push(&self, frame: Frame) -> Result<(), Error> {
        self.queue.lock().unwrap().push(frame, self.max_frame, self.max_message)?;
        self.ready.notify_one();
        Ok(())
    }
    async fn run(&self, tr: Transport) -> Result<(), Error> {
        loop {
            let bytes = self.queue.lock().unwrap().next();
            if let Some(bytes) = bytes {
                tr.send(bytes).await?;
            } else {
                self.ready.notified().await;
            }
        }
    }
}
enum Job {
    Rpc(String, u64, Result<Value, RpcError>),
    Watch(String, u64, Result<(), Error>),
}
struct Running {
    generation: u64,
    task: tokio::task::AbortHandle,
}
struct Session {
    endpoint: Endpoint,
    peer: Principal,
    writer: Writer,
    calls: HashMap<String, Response>,
    watches: HashMap<String, Mailbox>,
    serving: HashMap<String, Running>,
    publishing: HashMap<String, Running>,
    jobs: JoinSet<Job>,
    sequence: u64,
}
impl Session {
    fn command(&mut self, c: Command) -> Result<(), Error> {
        match c {
            Command::Call {
                id,
                method,
                params,
                timeout_ms,
                reply,
            } => {
                let sent = self.writer.push(Frame::RpcReq {
                    id: id.clone(),
                    method,
                    params,
                    timeout_ms,
                });
                if let Err(e) = sent {
                    let _ = reply.send(Err(e));
                } else {
                    self.calls.insert(id, reply);
                }
            }
            Command::Cancel(id) => {
                if self.calls.remove(&id).is_some() {
                    self.writer.push(Frame::RpcCancel { id })?;
                }
            }
            Command::Watch { id, target, mailbox, from_rev } => {
                self.writer.push(Frame::WatchOpen {
                    id: id.clone(),
                    target,
                    from_rev,
                })?;
                self.watches.insert(id, mailbox);
            }
            Command::StopWatch(id) => {
                if self.watches.remove(&id).is_some() {
                    self.writer.push(Frame::WatchStop { id })?;
                }
            }
        }
        Ok(())
    }
    fn dispatch(&mut self, f: Frame) -> Result<(), Error> {
        match f {
            Frame::Ping => self.writer.push(Frame::Pong)?,
            Frame::Pong => {}
            Frame::RpcRes { id, result, error } => {
                if let Some(tx) = self.calls.remove(&id) {
                    let _ = tx.send(error.map_or(Ok(result), |e| Err(e.into())));
                }
            }
            Frame::RpcCancel { id } => {
                if let Some(job) = self.serving.remove(&id) {
                    job.task.abort();
                }
            }
            Frame::RpcReq {
                id,
                method,
                params,
                timeout_ms,
            } => {
                let handler = self.endpoint.0.read().unwrap().methods.get(&method).cloned();
                let Some(handler) = handler else {
                    return self.writer.push(Frame::RpcRes {
                        id,
                        result: Value::Null,
                        error: Some(RpcError::new("not_found", format!("unknown method {method:?}"))),
                    });
                };
                self.sequence += 1;
                let generation = self.sequence;
                let job_id = id.clone();
                let peer = self.peer.clone();
                let task = self.jobs.spawn(async move {
                    let future = handler(peer, params);
                    let reply = if timeout_ms == 0 {
                        future.await
                    } else {
                        time::timeout(Duration::from_millis(timeout_ms), future)
                            .await
                            .unwrap_or_else(|_| Err(RpcError::new("deadline_exceeded", "deadline exceeded")))
                    };
                    Job::Rpc(job_id, generation, reply)
                });
                if let Some(old) = self.serving.insert(id, Running { generation, task }) {
                    old.task.abort();
                }
            }
            Frame::WatchOpen { id, target, from_rev } => {
                let (doc, resolve) = {
                    let routes = self.endpoint.0.read().unwrap();
                    (routes.watches.get(&target).cloned(), routes.resolve.clone())
                };
                let doc = match doc {
                    Some(doc) => Ok(Some(doc)),
                    None => match resolve {
                        Some(r) => r(&self.peer, &target),
                        None => Ok(None),
                    },
                };
                let doc = match doc {
                    Ok(Some(doc)) => doc,
                    missing => {
                        let error = missing
                            .err()
                            .unwrap_or_else(|| RpcError::new("not_found", format!("unknown watch target {target:?}")));
                        return self.writer.push(Frame::WatchEnd { id, error: Some(error) });
                    }
                };
                let mut sub = doc.watch(from_rev);
                self.sequence += 1;
                let generation = self.sequence;
                let job_id = id.clone();
                let writer = self.writer.clone();
                let task = self.jobs.spawn(async move {
                    let result = async {
                        while let Some(e) = sub.recv_async().await {
                            if e.retired || !e.ops.is_empty() {
                                writer.push(Frame::WatchPush {
                                    id: job_id.clone(),
                                    rev: e.rev,
                                    ops: e.ops,
                                    retired: e.retired,
                                    overflow: e.overflow,
                                })?;
                            }
                        }
                        Ok(())
                    }
                    .await;
                    Job::Watch(job_id, generation, result)
                });
                if let Some(old) = self.publishing.insert(id, Running { generation, task }) {
                    old.task.abort();
                }
            }
            Frame::WatchStop { id } => {
                if let Some(job) = self.publishing.remove(&id) {
                    job.task.abort();
                }
            }
            Frame::WatchEnd { id, error } => {
                if let Some(mail) = self.watches.remove(&id) {
                    mail.end(error.map_or(Error::Closed, Error::Rpc));
                }
            }
            Frame::WatchPush {
                id,
                rev,
                ops,
                retired,
                overflow,
            } => {
                if let Some(mail) = self.watches.get(&id)
                    && let Err(e) = mail.push(rev, ops, retired, overflow)
                {
                    mail.end(e);
                    self.watches.remove(&id);
                    self.writer.push(Frame::WatchStop { id })?;
                }
            }
            _ => return Err(Error::Protocol("unexpected control frame".into())),
        }
        Ok(())
    }
    fn finished(&mut self, job: Job) -> Result<(), Error> {
        match job {
            Job::Rpc(id, generation, outcome) if self.serving.get(&id).is_some_and(|r| r.generation == generation) => {
                self.serving.remove(&id);
                let (result, error) = match outcome {
                    Ok(v) => (v, None),
                    Err(e) => (Value::Null, Some(e)),
                };
                self.writer.push(Frame::RpcRes { id, result, error })?;
            }
            Job::Watch(id, generation, result) if self.publishing.get(&id).is_some_and(|r| r.generation == generation) => {
                self.publishing.remove(&id);
                self.writer.push(Frame::WatchEnd {
                    id,
                    error: result.err().map(|e| RpcError::new("internal", e.to_string())),
                })?;
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) fn start(endpoint: Endpoint, peer: Principal, transport: Transport, options: Options) -> Link {
    let (commands, mut rx) = mpsc::unbounded_channel();
    let stop = CancellationToken::new();
    let (reason_tx, reason) = watch::channel(None);
    let link = Link(Arc::new(Handle {
        commands,
        stop: stop.clone(),
        reason,
        peer: peer.clone(),
        sequence: AtomicU64::new(1),
    }));
    tokio::spawn(async move {
        let writer = Writer {
            queue: Default::default(),
            ready: Default::default(),
            max_frame: options.max_frame_bytes,
            max_message: options.max_message_bytes,
        };
        let mut session = Session {
            endpoint,
            peer,
            writer: writer.clone(),
            calls: Default::default(),
            watches: Default::default(),
            serving: Default::default(),
            publishing: Default::default(),
            jobs: JoinSet::new(),
            sequence: 0,
        };
        let writer_loop = writer.run(transport.clone());
        tokio::pin!(writer_loop);
        let mut last_seen = Instant::now();
        let mut assembler = Reassembler::default();
        let cadence = if options.heartbeat.is_zero() {
            Duration::from_secs(60)
        } else {
            options.heartbeat
        };
        let mut heartbeat = time::interval_at(Instant::now() + cadence, cadence);
        let exit: Result<(), Error> = async {
            loop {
                tokio::select! {
                    _=stop.cancelled()=>return Err(Error::Closed),
                    cmd=rx.recv()=>session.command(cmd.ok_or(Error::Closed)?)?,
                    wire=transport.recv()=>{
                        let bytes=wire?;
                        last_seen=Instant::now();
                        if let Some(frame)=assembler.receive(&bytes,options.max_message_bytes)? {session.dispatch(frame)?;}
                    }
                    job=session.jobs.join_next(), if !session.jobs.is_empty()=>{
                        if let Some(result)=job{
                            match result {
                                Ok(job)=>session.finished(job)?,
                                Err(e) if e.is_cancelled()=>{},
                                Err(e)=>return Err(Error::Protocol(e.to_string())),
                            }
                        }
                    }
                    result=&mut writer_loop=>return result,
                    _=heartbeat.tick(), if !options.heartbeat.is_zero()=>{
                        if !options.heartbeat_timeout.is_zero() && last_seen.elapsed()>options.heartbeat_timeout{return Err(Error::Heartbeat);}
                        session.writer.push(Frame::Ping)?;
                    }
                }
            }
        }
        .await;
        let error = exit.err().unwrap_or(Error::Closed);
        transport.close();
        stop.cancel();
        for (_, tx) in session.calls.drain() {
            let _ = tx.send(Err(error.clone()));
        }
        for (_, mail) in session.watches.drain() {
            mail.end(error.clone());
        }
        session.jobs.shutdown().await;
        reason_tx.send_replace(Some(error));
    });
    link
}
