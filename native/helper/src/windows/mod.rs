//! Windows backend: a `WH_KEYBOARD_LL` hook for keys and Core Audio session ducking for music players.

mod keys;
mod media;

use crate::keymap::{self, WINDOWS_KEYS};
use crate::protocol::{HelperMessage, PROTOCOL_VERSION};
use crate::{Backend, Log};
use std::sync::mpsc::Sender;

pub struct WindowsBackend {
	keys: Option<keys::HookKeys>,
	media: Option<media::Ducker>,
}

impl WindowsBackend {
	pub fn new(outbox: Sender<HelperMessage>, log: Log) -> Self {
		let keys = keys::HookKeys::start(outbox, log.clone())
			.map_err(|error| log.error(&format!("keyboard hook unavailable: {error}")))
			.ok();
		let media = media::Ducker::start(log.clone())
			.map_err(|error| log.warn(&format!("music ducking unavailable: {error}")))
			.ok();
		Self { keys, media }
	}
}

impl Backend for WindowsBackend {
	fn hello(&self) -> HelperMessage {
		let (keys, codes) = match self.keys {
			Some(_) => ("granted", keymap::codes(WINDOWS_KEYS)),
			None => ("unsupported", Vec::new()),
		};
		HelperMessage::Hello {
			protocol: PROTOCOL_VERSION,
			platform: "win32",
			keys,
			codes,
			media: self.media.is_some(),
		}
	}

	fn watch(&mut self, codes: &[&'static str]) {
		if let Some(keys) = &self.keys {
			keys.watch(codes);
		}
	}

	fn duck(&mut self, level: Option<f64>) {
		if let Some(media) = &self.media {
			media.request(level);
		}
	}

	fn shutdown(&mut self) {
		if let Some(keys) = &self.keys {
			keys.watch(&[]);
		}
		if let Some(media) = &self.media {
			media.restore_now();
		}
	}

	fn canonical(&self, code: &str) -> Option<&'static str> {
		self.keys.as_ref().and_then(|_| keymap::canonical(WINDOWS_KEYS, code))
	}
}
