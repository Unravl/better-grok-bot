//! In-test bridge: a one-connection WebSocket server on 127.0.0.1 standing in for the agent's
//! `/helper` endpoint, and a real `bgb-helper` process connected to it.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

pub const TOKEN: &str = "integration-test-token";

pub struct Bridge {
	pub socket: WebSocket<TcpStream>,
	pub helper: Child,
}

impl Bridge {
	/// Starts the helper against a fresh listener and completes the authenticated upgrade.
	pub fn start() -> Self {
		let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
		let port = listener.local_addr().unwrap().port();
		let helper = Command::new(env!("CARGO_BIN_EXE_bgb-helper"))
			.env("BGB_BRIDGE_URL", format!("ws://127.0.0.1:{port}/helper"))
			.env("BGB_HELPER_TOKEN", TOKEN)
			.spawn()
			.expect("spawn bgb-helper");
		let (stream, _) = listener.accept().expect("helper connects");
		let socket = tungstenite::accept_hdr(stream, |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
			assert_eq!(request.uri().path(), "/helper");
			let authorization = request.headers().get("authorization").and_then(|value| value.to_str().ok());
			assert_eq!(authorization, Some(format!("Bearer {TOKEN}").as_str()));
			Ok(response)
		})
		.expect("upgrade");
		socket.get_ref().set_read_timeout(Some(Duration::from_millis(50))).unwrap();
		Self { socket, helper }
	}

	pub fn send(&mut self, message: Value) {
		self.socket.send(Message::text(message.to_string())).expect("send to helper");
	}

	pub fn watch(&mut self, codes: &[&str]) {
		self.send(json!({"type": "watch", "codes": codes}));
	}

	/// The next non-`log` message, or `None` after `timeout`.
	pub fn next(&mut self, timeout: Duration) -> Option<Value> {
		let deadline = Instant::now() + timeout;
		while Instant::now() < deadline {
			match self.socket.read() {
				Ok(Message::Text(text)) => {
					let value: Value = serde_json::from_str(text.as_str()).expect("helper sends JSON");
					if value["type"] != "log" {
						return Some(value);
					}
				}
				Ok(_) => {}
				Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
				Err(error) => panic!("bridge socket failed: {error}"),
			}
		}
		None
	}

	pub fn expect(&mut self, timeout: Duration) -> Value {
		self.next(timeout).expect("helper message within timeout")
	}

	/// Every non-`log` message that arrives within `window`.
	pub fn collect(&mut self, window: Duration) -> Vec<Value> {
		let deadline = Instant::now() + window;
		let mut messages = Vec::new();
		while let Some(message) = self.next(deadline.saturating_duration_since(Instant::now())) {
			messages.push(message);
		}
		messages
	}

	/// Closes the socket and returns the helper's exit status if it exits within `timeout`.
	pub fn close_and_wait(mut self, timeout: Duration) -> Option<ExitStatus> {
		let _ = self.socket.close(None);
		let _ = self.socket.flush();
		drop(self.socket);
		let deadline = Instant::now() + timeout;
		while Instant::now() < deadline {
			if let Some(status) = self.helper.try_wait().expect("try_wait") {
				return Some(status);
			}
			std::thread::sleep(Duration::from_millis(20));
		}
		let _ = self.helper.kill();
		None
	}
}

/// Gives the helper time to apply a `watch` (it polls its socket every 10 ms) before input is injected.
pub fn settle() {
	std::thread::sleep(Duration::from_millis(300));
}

/// The integration sequence shared by the X11 and Windows tests. `press`/`release` inject AltRight;
/// `tap_a` injects one press and release of the A key.
pub fn run_key_sequence(mut bridge: Bridge, press_alt_right: impl Fn(), release_alt_right: impl Fn(), tap_a: impl Fn()) {
	let hello = bridge.expect(Duration::from_secs(5));
	assert_eq!(hello["type"], "hello");
	assert_eq!(hello["protocol"], 4);
	assert_eq!(hello["keys"], "granted");
	assert!(hello["codes"].as_array().unwrap().iter().any(|code| code == "AltRight"));

	bridge.watch(&["AltRight"]);
	settle();
	press_alt_right();
	assert_eq!(
		bridge.expect(Duration::from_secs(2)),
		json!({"type": "key", "code": "AltRight", "down": true})
	);

	bridge.watch(&["AltRight", "F5"]);
	let after_replace = bridge.collect(Duration::from_millis(500));
	assert!(
		after_replace.is_empty(),
		"replacing the watch while held must not report anything: {after_replace:?}"
	);

	tap_a();
	let chords = bridge.collect(Duration::from_millis(700));
	assert_eq!(
		chords,
		vec![json!({"type": "chord", "code": "AltRight"})],
		"exactly one chord, and never the A key itself"
	);

	release_alt_right();
	assert_eq!(
		bridge.expect(Duration::from_secs(2)),
		json!({"type": "key", "code": "AltRight", "down": false})
	);

	let status = bridge
		.close_and_wait(Duration::from_secs(2))
		.expect("helper exits within 2 s after the socket closes");
	assert!(status.success(), "helper exit status {status}");
}
