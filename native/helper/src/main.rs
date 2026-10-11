//! Better Grok Bot helper for Windows and Linux (protocol v4, `sdk/helper.ts`).
//!
//! The agent spawns this process on demand with `BGB_BRIDGE_URL` (`ws://127.0.0.1:<port>/helper`) and
//! `BGB_HELPER_TOKEN`. It connects once, sends `hello`, then watches only the keys the agent asks for
//! (always a subset of `HELPER_CODES`) and, on Windows, ducks music players. When the socket closes or
//! the agent sends `quit`, it releases any duck (restoring volumes at once) and exits 0; the agent
//! restarts it when it is needed again. macOS uses the Swift `Better Grok Bot Helper.app` instead.
//!
//! Threads: the socket thread owns the WebSocket and polls it with a short read timeout, sending
//! queued outgoing messages between reads; native key events arrive on a backend thread and reach
//! the socket thread through an mpsc channel.

// macOS builds only the "unsupported" entry point; the shared modules are exercised by unit tests there.
#![cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]

mod keymap;
mod protocol;
mod watch;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
#[path = "windows/mod.rs"]
mod win;

use protocol::{AgentMessage, HelperMessage};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::AUTHORIZATION;
use tungstenite::{Message, WebSocket};

/// How long one socket read waits before queued key events are sent: the worst-case added latency.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// What a platform provides to the socket loop.
pub trait Backend {
	fn hello(&self) -> HelperMessage;
	/// Replaces the watched set with `codes` (already validated against the platform keymap).
	fn watch(&mut self, codes: &[&'static str]);
	/// `None` releases (fading back up); `Some(level)` ducks to `level` (0–1).
	fn duck(&mut self, level: Option<f64>);
	/// Clears the watched set and restores ducked players at once.
	fn shutdown(&mut self);
	/// Maps an agent-supplied code to this platform's static spelling; `None` = not watchable here.
	fn canonical(&self, code: &str) -> Option<&'static str>;
}

/// Writes helper log lines to stderr (the agent appends them to its log) and forwards warnings and
/// errors to the agent as `log` messages.
#[derive(Clone)]
pub struct Log {
	outbox: Sender<HelperMessage>,
}

impl Log {
	pub fn info(&self, message: &str) {
		eprintln!("bgb-helper: {message}");
	}

	pub fn warn(&self, message: &str) {
		self.forward("warn", message);
	}

	pub fn error(&self, message: &str) {
		self.forward("error", message);
	}

	fn forward(&self, level: &'static str, message: &str) {
		eprintln!("bgb-helper: {level}: {message}");
		let _ = self.outbox.send(HelperMessage::Log {
			level,
			message: message.to_owned(),
		});
	}
}

#[cfg(target_os = "linux")]
fn create_backend(outbox: Sender<HelperMessage>, log: Log) -> Result<Box<dyn Backend>, String> {
	Ok(Box::new(linux::LinuxBackend::new(outbox, log)))
}

#[cfg(windows)]
fn create_backend(outbox: Sender<HelperMessage>, log: Log) -> Result<Box<dyn Backend>, String> {
	Ok(Box::new(win::WindowsBackend::new(outbox, log)))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn create_backend(_outbox: Sender<HelperMessage>, _log: Log) -> Result<Box<dyn Backend>, String> {
	Err("this helper runs on Windows and Linux only; macOS uses Better Grok Bot Helper.app".into())
}

fn env(name: &str) -> Result<String, String> {
	std::env::var(name)
		.ok()
		.filter(|value| !value.is_empty())
		.ok_or_else(|| format!("{name} is not set"))
}

fn connect(url: &str, token: &str) -> Result<WebSocket<TcpStream>, String> {
	let mut request = url
		.into_client_request()
		.map_err(|error| format!("invalid BGB_BRIDGE_URL {url}: {error}"))?;
	let bearer = format!("Bearer {token}")
		.parse()
		.map_err(|_| "BGB_HELPER_TOKEN is not a valid header value".to_owned())?;
	request.headers_mut().insert(AUTHORIZATION, bearer);
	let host = request
		.uri()
		.host()
		.ok_or_else(|| format!("BGB_BRIDGE_URL {url} has no host"))?
		.to_owned();
	let port = request.uri().port_u16().unwrap_or(80);
	let stream = TcpStream::connect((host.as_str(), port)).map_err(|error| format!("cannot connect to {host}:{port}: {error}"))?;
	stream.set_nodelay(true).map_err(|error| error.to_string())?;
	let (socket, _) = tungstenite::client(request, stream).map_err(|error| format!("bridge handshake failed: {error}"))?;
	socket
		.get_ref()
		.set_read_timeout(Some(POLL_INTERVAL))
		.map_err(|error| error.to_string())?;
	Ok(socket)
}

enum Exit {
	Quit,
	Closed,
}

fn send(socket: &mut WebSocket<TcpStream>, message: &HelperMessage) -> Result<(), tungstenite::Error> {
	socket.send(Message::text(message.to_json()))
}

fn serve(socket: &mut WebSocket<TcpStream>, backend: &mut dyn Backend, inbox: &Receiver<HelperMessage>, log: &Log) -> Exit {
	if let Err(error) = send(socket, &backend.hello()) {
		log.info(&format!("cannot send hello: {error}"));
		return Exit::Closed;
	}
	loop {
		match socket.read() {
			Ok(Message::Text(text)) => match AgentMessage::parse(text.as_str()) {
				Some(AgentMessage::Watch { codes }) => {
					let valid: Vec<&'static str> = codes.iter().filter_map(|code| backend.canonical(code)).collect();
					backend.watch(&valid);
				}
				Some(AgentMessage::Duck { ducked, level }) => backend.duck(protocol::duck_level(ducked, level)),
				Some(AgentMessage::Quit) => return Exit::Quit,
				None => log.info("ignored an unknown message"),
			},
			Ok(Message::Close(_)) => return Exit::Closed,
			Ok(_) => {}
			Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
			Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Exit::Closed,
			Err(error) => {
				log.info(&format!("socket error: {error}"));
				return Exit::Closed;
			}
		}
		while let Ok(message) = inbox.try_recv() {
			if let Err(error) = send(socket, &message) {
				log.info(&format!("socket error: {error}"));
				return Exit::Closed;
			}
		}
	}
}

fn run() -> Result<(), String> {
	let (outbox, inbox) = mpsc::channel();
	let log = Log { outbox: outbox.clone() };
	let mut backend = create_backend(outbox, log.clone())?;
	let url = env("BGB_BRIDGE_URL")?;
	let token = env("BGB_HELPER_TOKEN")?;
	let mut socket = connect(&url, &token)?;
	log.info(&format!("connected to {url} (pid {})", std::process::id()));
	let exit = serve(&mut socket, backend.as_mut(), &inbox, &log);
	backend.shutdown();
	match exit {
		Exit::Quit => {
			log.info("quit requested; exiting");
			let _ = socket.close(None);
			let _ = socket.flush();
		}
		Exit::Closed => log.info("bridge connection closed; exiting"),
	}
	Ok(())
}

fn main() {
	if let Err(error) = run() {
		eprintln!("bgb-helper: {error}");
		std::process::exit(1);
	}
}
