//! Linux backend: X11 keys through XInput2 raw events. Media ducking on Linux runs in the agent
//! (`pactl`), so `hello.media` is false and `duck` is ignored.

mod keys;

use crate::keymap::{self, LINUX_KEYS};
use crate::protocol::{HelperMessage, PROTOCOL_VERSION};
use crate::{Backend, Log};
use std::sync::mpsc::Sender;

pub struct LinuxBackend {
	keys: Option<keys::X11Keys>,
}

impl LinuxBackend {
	pub fn new(outbox: Sender<HelperMessage>, log: Log) -> Self {
		let keys = match keys::unsupported_reason() {
			Some(reason) => {
				log.info(&format!("background keys unsupported: {reason}"));
				None
			}
			None => match keys::X11Keys::start(outbox, log.clone()) {
				Ok(keys) => Some(keys),
				Err(error) => {
					log.warn(&format!("background keys unavailable: {error}"));
					None
				}
			},
		};
		Self { keys }
	}
}

impl Backend for LinuxBackend {
	fn hello(&self) -> HelperMessage {
		let (keys, codes) = match self.keys {
			Some(_) => ("granted", keymap::codes(LINUX_KEYS)),
			None => ("unsupported", Vec::new()),
		};
		HelperMessage::Hello {
			protocol: PROTOCOL_VERSION,
			platform: "linux",
			keys,
			codes,
			media: false,
		}
	}

	fn watch(&mut self, codes: &[&'static str]) {
		if let Some(keys) = &self.keys {
			keys.watch(codes);
		}
	}

	fn duck(&mut self, _level: Option<f64>) {}

	fn shutdown(&mut self) {
		if let Some(keys) = &self.keys {
			keys.watch(&[]);
		}
	}

	fn canonical(&self, code: &str) -> Option<&'static str> {
		self.keys.as_ref().and_then(|_| keymap::canonical(LINUX_KEYS, code))
	}
}
