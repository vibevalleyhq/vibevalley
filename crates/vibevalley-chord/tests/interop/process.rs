use std::{
    io::{BufRead, BufReader},
    process::Child,
    sync::mpsc,
    time::Duration,
};

pub struct Peer(pub Child);

impl Peer {
    pub fn ready_line(&mut self) -> String {
        let stdout = self.0.stdout.take().expect("peer stdout");
        let (ready, line) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut text = String::new();
            let read = BufReader::new(stdout).read_line(&mut text).map(|_| text);
            let _ = ready.send(read);
        });
        let text = line.recv_timeout(Duration::from_secs(20)).expect("peer did not announce a listener").unwrap();
        assert!(!text.trim().is_empty(), "peer exited before announcing its listener");
        text
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
