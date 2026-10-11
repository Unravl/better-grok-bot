//! System-wide watched keys on X11 via XInput2 `XI_RawKeyPress`/`XI_RawKeyRelease` on the root window.
//! Raw events are selected only while the watched set is non-empty. Wayland sessions get no
//! background keys (no portable global key API).

use crate::keymap::{self, LINUX_KEYS};
use crate::protocol::HelperMessage;
use crate::watch::Keys;
use crate::Log;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use x11rb::connection::Connection;
use x11rb::protocol::xinput::{self, ConnectionExt as _, EventMask, XIEventMask};
use x11rb::protocol::xproto::Window;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

/// X11 keycodes are evdev codes + 8.
const X11_KEYCODE_OFFSET: u32 = 8;

/// Why this session can't watch keys in the background, if it can't.
pub fn unsupported_reason() -> Option<&'static str> {
	if std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland")) {
		return Some("Wayland session");
	}
	if std::env::var_os("DISPLAY").is_none_or(|value| value.is_empty()) {
		return Some("DISPLAY is not set");
	}
	None
}

pub struct X11Keys {
	connection: Arc<RustConnection>,
	root: Window,
	keys: Arc<Keys>,
	log: Log,
}

impl X11Keys {
	pub fn start(outbox: Sender<HelperMessage>, log: Log) -> Result<Self, String> {
		let (connection, screen) = x11rb::connect(None).map_err(|error| format!("cannot open the X display: {error}"))?;
		let root = connection.setup().roots[screen].root;
		let version = connection
			.xinput_xi_query_version(2, 2)
			.map_err(|error| error.to_string())?
			.reply()
			.map_err(|error| format!("XInput2 is not available: {error}"))?;
		if version.major_version < 2 {
			return Err(format!(
				"XInput {}.{} is too old (needs 2.0)",
				version.major_version, version.minor_version
			));
		}
		let connection = Arc::new(connection);
		let keys = Keys::new(outbox);
		let thread_connection = Arc::clone(&connection);
		let thread_keys = Arc::clone(&keys);
		std::thread::Builder::new()
			.name("x11-keys".into())
			.spawn(move || event_loop(&thread_connection, &thread_keys))
			.map_err(|error| error.to_string())?;
		Ok(Self {
			connection,
			root,
			keys,
			log,
		})
	}

	pub fn watch(&self, codes: &[&'static str]) {
		// Linux reports no reliable per-key hardware state here: added modifiers start up.
		let (events, was_empty, is_empty) = {
			let mut set = self.keys.lock();
			let was_empty = set.is_empty();
			let events = set.replace(codes, |_| false);
			(events, was_empty, set.is_empty())
		};
		self.keys.emit(events);
		if was_empty != is_empty {
			if let Err(error) = self.select(!is_empty) {
				self.log.error(&format!(
					"cannot {} raw key events: {error}",
					if is_empty { "deselect" } else { "select" }
				));
			} else {
				self.log.info(if is_empty { "raw key events off" } else { "raw key events on" });
			}
		}
	}

	fn select(&self, enabled: bool) -> Result<(), String> {
		let mask = if enabled {
			XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE
		} else {
			XIEventMask::from(0u32)
		};
		let masks = [EventMask {
			deviceid: u16::from(xinput::Device::ALL_MASTER),
			mask: vec![mask],
		}];
		self.connection
			.xinput_xi_select_events(self.root, &masks)
			.map_err(|error| error.to_string())?;
		self.connection.flush().map_err(|error| error.to_string())
	}
}

fn code_for_keycode(keycode: u32) -> Option<&'static str> {
	let evdev = keycode.checked_sub(X11_KEYCODE_OFFSET)?;
	keymap::code_for(LINUX_KEYS, u16::try_from(evdev).ok()?)
}

fn event_loop(connection: &RustConnection, keys: &Keys) {
	loop {
		match connection.wait_for_event() {
			Ok(Event::XinputRawKeyPress(event)) => keys.press(code_for_keycode(event.detail)),
			Ok(Event::XinputRawKeyRelease(event)) => keys.release(code_for_keycode(event.detail)),
			Ok(_) => {}
			Err(error) => {
				// Without X there are no keys to report; exit so the agent restarts the helper.
				eprintln!("bgb-helper: error: X connection lost: {error}");
				std::process::exit(1);
			}
		}
	}
}
