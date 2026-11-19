use super::{Endpoint, Error, Link, Options, Transport, session::Mailbox};
use crate::{delta::Snapshot, watch::Event};
use serde_json::Value;
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{sync::watch, time};
use tokio_util::sync::CancellationToken;

pub struct Client {
    active: watch::Receiver<Option<Link>>,
    stop: CancellationToken,
    done: CancellationToken,
}

impl Client {
    pub async fn connect<F, Fut>(endpoint: Endpoint, options: Options, dial: F) -> Result<Self, Error>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Transport, Error>> + Send + 'static,
    {
        Self::with_backoff(endpoint, options, dial, Duration::from_millis(20), Duration::from_millis(500)).await
    }

    pub async fn with_backoff<F, Fut>(endpoint: Endpoint, options: Options, dial: F, min_delay: Duration, max_delay: Duration) -> Result<Self, Error>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Transport, Error>> + Send + 'static,
    {
        let link = endpoint.connect(dial().await?, options.clone()).await?;
        let (tx, active) = watch::channel(Some(link.clone()));
        let stop = CancellationToken::new();
        let done = CancellationToken::new();
        let client = Client {
            active,
            stop: stop.clone(),
            done: done.clone(),
        };
        tokio::spawn(async move {
            let mut current = link;
            'connect: loop {
                tokio::select! {
                    _=stop.cancelled()=>{current.close();current.closed().await;break;}
                    _=current.closed()=>{}
                }
                tx.send_replace(None);
                let mut delay = min_delay;
                loop {
                    let attempt = async {
                        let transport = dial().await?;
                        endpoint.connect(transport, options.clone()).await
                    };
                    match tokio::select! {_=stop.cancelled()=>break 'connect, next=attempt=>next} {
                        Ok(next) => {
                            tx.send_replace(Some(next.clone()));
                            current = next;
                            break;
                        }
                        Err(_) => {
                            tokio::select! {_=stop.cancelled()=>break 'connect, _=time::sleep(delay)=>{}}
                            delay = delay.saturating_mul(2).min(max_delay.max(min_delay));
                        }
                    }
                }
            }
            tx.send_replace(None);
            done.cancel();
        });
        Ok(client)
    }

    pub fn active_link(&self) -> Option<Link> {
        self.active.borrow().clone().filter(|link| !link.is_closed())
    }
    pub async fn close(&self) {
        self.stop.cancel();
        self.done.cancelled().await;
    }
    pub async fn call(&self, method: impl Into<String>, params: Value, timeout: Option<Duration>) -> Result<Value, Error> {
        let mut rx = self.active.clone();
        let deadline = timeout.map(|d| time::Instant::now() + d);
        let connect = async {
            loop {
                if self.stop.is_cancelled() {
                    return Err(Error::Closed);
                }
                if let Some(link) = rx.borrow_and_update().clone().filter(|link| !link.is_closed()) {
                    return Ok(link);
                }
                tokio::select! {_=self.stop.cancelled()=>return Err(Error::Closed), r=rx.changed()=>r.map_err(|_|Error::Closed)?}
            }
        };
        let current = match deadline {
            Some(d) => time::timeout_at(d, connect).await.map_err(|_| Error::Deadline)??,
            None => connect.await?,
        };
        current
            .call(method, params, deadline.map(|d| d.saturating_duration_since(time::Instant::now())))
            .await
    }

    pub fn watch(&self, target: impl Into<String>) -> ClientWatch {
        let mut links = self.active.clone();
        let stop = self.stop.child_token();
        let (mailbox, ready) = Mailbox::new(Snapshot::new(Value::Null), 0);
        let watch = ClientWatch {
            mailbox: mailbox.clone(),
            ready,
            stop: stop.clone(),
        };
        let target = Arc::<str>::from(target.into());
        tokio::spawn(async move {
            let result: Result<(), Error> = async {
                loop {
                    let current = links.borrow_and_update().clone();
                    if let Some(current) = current {
                        let (rev, snap, _) = mailbox.cursor();
                        if let Ok(mut sub) = current.watch(target.to_string(), rev, Some(snap)) {
                            loop {
                                let incoming = tokio::select! {
                                    _=stop.cancelled()=>return Err(Error::Closed),
                                    e=sub.recv()=>e,
                                };
                                match incoming {
                                    Ok(e) => {
                                        let (last, _, retired) = mailbox.cursor();
                                        if e.rev > last || e.retired || retired {
                                            mailbox.deliver(e);
                                        }
                                    }
                                    Err(Error::Closed | Error::Transport(_) | Error::Heartbeat) => break,
                                    Err(e) => return Err(e),
                                }
                            }
                        }
                    }
                    tokio::select! {_=stop.cancelled()=>return Err(Error::Closed), r=links.changed()=>r.map_err(|_|Error::Closed)?}
                }
            }
            .await;
            mailbox.end(result.unwrap_err());
        });
        watch
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

pub struct ClientWatch {
    mailbox: Mailbox,
    ready: flume::Receiver<()>,
    stop: CancellationToken,
}
impl ClientWatch {
    pub fn revision(&self) -> i64 {
        self.mailbox.cursor().0
    }
    pub async fn recv(&mut self) -> Result<Event, Error> {
        loop {
            if let Some(e) = self.mailbox.take()? {
                return Ok(e);
            }
            self.ready.recv_async().await.map_err(|_| Error::Closed)?;
        }
    }
}
impl Drop for ClientWatch {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
