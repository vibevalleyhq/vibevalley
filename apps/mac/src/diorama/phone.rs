use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use serde::Serialize;
use vibevalley_protocol::InboxItem;

#[derive(Debug, Clone, Serialize)]
pub struct CallLog {
    pub call: InboxItem,
    pub answered: bool,
}

#[derive(Debug, Default)]
pub struct Phone {
    pub open: bool,
    pub unfolded: bool,
    pub large: bool,
    pub game: bool,
    pub active_call: bool,
    pub ringing: Option<InboxItem>,
    pub log: VecDeque<CallLog>,
    known: Option<HashSet<String>>,
    handled: HashSet<String>,
    opened_by_ring: bool,
    until: Option<Instant>,
}

impl Phone {
    pub fn feed(&mut self, calls: &[InboxItem], now: Instant) {
        let ids = calls.iter().map(|call| call.id.clone()).collect::<HashSet<_>>();
        let fresh = self
            .known
            .as_ref()
            .and_then(|known| calls.iter().find(|c| !known.contains(&c.id) && !self.handled.contains(&c.id)));
        self.known = Some(ids);
        if let Some(call) = fresh
            && !self.active_call
        {
            self.opened_by_ring |= !self.open;
            self.open = true;
            self.ringing = Some(call.clone());
            self.until = Some(now + Duration::from_secs(20));
        } else if self.ringing.as_ref().is_some_and(|r| !calls.iter().any(|c| c.id == r.id)) {
            self.end_ring();
        }
    }

    fn end_ring(&mut self) {
        if self.opened_by_ring {
            self.close();
        } else {
            self.silence();
        }
    }

    pub fn tick(&mut self, now: Instant) {
        if self.until.is_some_and(|until| now >= until) {
            self.end_ring();
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.unfolded = false;
        self.large = false;
        self.game = false;
        self.silence();
    }

    pub fn silence(&mut self) {
        self.ringing = None;
        self.until = None;
        self.opened_by_ring = false;
    }

    pub fn settle(&mut self, call: InboxItem, answered: bool) {
        if !self.handled.insert(call.id.clone()) {
            return;
        }
        if self.ringing.as_ref().is_some_and(|r| r.id == call.id) {
            if answered {
                self.silence();
            } else {
                self.end_ring();
            }
        }
        self.log.push_front(CallLog { call, answered });
        self.log.truncate(40);
    }

    pub fn missed<'a>(&'a self, calls: &'a [InboxItem]) -> impl Iterator<Item = &'a InboxItem> {
        calls.iter().filter(|c| !self.handled.contains(&c.id))
    }
}
