//! Music ducking through Core Audio sessions on the default render endpoint, with the semantics of
//! the macOS helper's Apple Events ducker:
//! - the first duck records each player session's volume as its original and sets
//!   `original × level`; a new level while ducked re-sets `original × level` at once;
//! - a release fades back to the original in 8 steps, the first at once and the rest 85 ms apart;
//!   a duck during the fade ends it and goes straight to its level;
//! - before every change, a session whose volume moved more than 0.02 from what the helper last set
//!   was changed by the user: the helper leaves it alone and stops managing it;
//! - exit restores at once.
//!
//! COM objects live on one dedicated thread; the socket thread only sends it commands.

use crate::Log;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
	eMultimedia, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
	MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

/// Executable names of the players `duck` lowers (only sessions that already exist; nothing is launched).
const PLAYERS: &[&str] = &["Spotify.exe", "AppleMusic.exe", "iTunes.exe"];
/// Session volume is a 0–1 float; a reading within this of what the helper set is untouched.
const VOLUME_TOLERANCE: f32 = 0.02;
const FADE_STEPS: u32 = 8;
const FADE_STEP_INTERVAL: Duration = Duration::from_millis(85);
/// How long `restore_now` waits for the media thread before the helper exits anyway.
const RESTORE_TIMEOUT: Duration = Duration::from_secs(3);

enum Command {
	Request(Option<f64>),
	RestoreNow(Sender<()>),
}

pub struct Ducker {
	commands: Sender<Command>,
}

impl Ducker {
	pub fn start(log: Log) -> Result<Self, String> {
		let (commands, inbox) = mpsc::channel();
		let (ready, started) = mpsc::channel();
		std::thread::Builder::new()
			.name("media-ducker".into())
			.spawn(move || media_thread(&inbox, &ready, log))
			.map_err(|error| error.to_string())?;
		started.recv().map_err(|_| "the media thread failed to start".to_owned())??;
		Ok(Self { commands })
	}

	/// `None` releases (fading up); `Some(level)` ducks to `level` of each original volume.
	pub fn request(&self, level: Option<f64>) {
		let _ = self.commands.send(Command::Request(level));
	}

	/// Restores every lowered player without a fade; returns once done (or after a timeout).
	pub fn restore_now(&self) {
		let (done, finished) = mpsc::channel();
		if self.commands.send(Command::RestoreNow(done)).is_ok() {
			let _ = finished.recv_timeout(RESTORE_TIMEOUT);
		}
	}
}

struct Record {
	name: String,
	volume: ISimpleAudioVolume,
	/// The volume before the first duck; restored on release.
	original: f32,
	/// What the helper set last, for the "the user moved it" check.
	last_set: f32,
}

enum SetOutcome {
	Set,
	/// The user moved the volume or the session is gone: the helper stops managing it.
	Dropped,
}

struct DuckState {
	enumerator: IMMDeviceEnumerator,
	log: Log,
	/// The wanted level, `None` = not ducked.
	target: Option<f64>,
	/// The level the players were last converged to, `None` = not ducked (or fading back).
	applied: Option<f64>,
	/// The sessions the helper lowered; non-empty while `applied` is `None` = a fade is running.
	records: Vec<Record>,
	fade_steps_done: u32,
	fading: bool,
}

fn media_thread(inbox: &Receiver<Command>, ready: &Sender<Result<(), String>>, log: Log) {
	// SAFETY: initializes COM for this thread only; balanced by CoUninitialize below.
	if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
		let _ = ready.send(Err(format!("COM initialization failed: {error}")));
		return;
	}
	// SAFETY: creates the system audio device enumerator.
	let enumerator: IMMDeviceEnumerator = match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
		Ok(enumerator) => enumerator,
		Err(error) => {
			let _ = ready.send(Err(format!("no audio device enumerator: {error}")));
			// SAFETY: matches the successful CoInitializeEx above.
			unsafe { CoUninitialize() };
			return;
		}
	};
	let _ = ready.send(Ok(()));
	let mut state = DuckState {
		enumerator,
		log,
		target: None,
		applied: None,
		records: Vec::new(),
		fade_steps_done: 0,
		fading: false,
	};
	loop {
		let command = if state.fading {
			match inbox.recv_timeout(FADE_STEP_INTERVAL) {
				Ok(command) => Some(command),
				Err(RecvTimeoutError::Timeout) => None,
				Err(RecvTimeoutError::Disconnected) => break,
			}
		} else {
			match inbox.recv() {
				Ok(command) => Some(command),
				Err(_) => break,
			}
		};
		match command {
			Some(Command::Request(level)) => {
				state.target = level;
				state.settle();
			}
			Some(Command::RestoreNow(done)) => {
				state.restore_now();
				let _ = done.send(());
			}
			None => state.fade_step(),
		}
	}
	state.restore_now();
	drop(state);
	// SAFETY: every COM object of this thread was dropped with `state`.
	unsafe { CoUninitialize() };
}

impl DuckState {
	fn settle(&mut self) {
		if self.target == self.applied {
			return;
		}
		match self.target {
			Some(level) if self.applied.is_none() && self.records.is_empty() => self.duck(level),
			Some(level) => {
				self.fading = false;
				self.relevel(level);
			}
			None => {
				self.fade_steps_done = 0;
				self.fading = true;
				self.fade_step();
			}
		}
		self.applied = self.target;
	}

	fn duck(&mut self, level: f64) {
		for (name, volume) in self.player_sessions() {
			// SAFETY: `volume` is a live ISimpleAudioVolume of this thread.
			let original = match unsafe { volume.GetMasterVolume() } {
				Ok(original) => original,
				Err(error) => {
					self.log.warn(&format!("duck: {name}: cannot read its volume: {error}"));
					continue;
				}
			};
			let value = scaled(original, level);
			// SAFETY: as above; a null event context is allowed.
			if let Err(error) = unsafe { volume.SetMasterVolume(value, std::ptr::null()) } {
				self.log.warn(&format!("duck: {name}: cannot set its volume: {error}"));
				continue;
			}
			self.log
				.info(&format!("duck: {name} volume {original:.2} -> {value:.2} (level {level})"));
			self.records.push(Record {
				name,
				volume,
				original,
				last_set: value,
			});
		}
		if self.records.is_empty() {
			self.log.info(&format!("duck: no player lowered (level {level})"));
		}
	}

	fn relevel(&mut self, level: f64) {
		let log = &self.log;
		self.records.retain_mut(|record| {
			let value = scaled(record.original, level);
			match set_if_unchanged(record, value, log) {
				SetOutcome::Set => {
					log.info(&format!(
						"duck: {} volume {:.2} -> {value:.2} (level {level})",
						record.name, record.last_set
					));
					record.last_set = value;
					true
				}
				SetOutcome::Dropped => false,
			}
		});
	}

	/// One step of the restore fade: moves each session 1/(steps left) of the way back to its original.
	fn fade_step(&mut self) {
		let steps_left = FADE_STEPS.saturating_sub(self.fade_steps_done).max(1);
		self.fade_steps_done += 1;
		let log = &self.log;
		self.records.retain_mut(|record| {
			let value = if steps_left == 1 {
				record.original
			} else {
				record.last_set + (record.original - record.last_set) / steps_left as f32
			};
			match set_if_unchanged(record, value, log) {
				SetOutcome::Set => {
					if steps_left == 1 {
						log.info(&format!("duck: {} volume restored to {:.2}", record.name, record.original));
					}
					record.last_set = value;
					steps_left > 1
				}
				SetOutcome::Dropped => false,
			}
		});
		self.fading = !self.records.is_empty();
	}

	fn restore_now(&mut self) {
		for record in &self.records {
			if let SetOutcome::Set = set_if_unchanged(record, record.original, &self.log) {
				self.log
					.info(&format!("duck: {} volume restored to {:.2} at once", record.name, record.original));
			}
		}
		self.records.clear();
		self.target = None;
		self.applied = None;
		self.fading = false;
	}

	/// Live sessions of the player executables on the default render endpoint.
	fn player_sessions(&self) -> Vec<(String, ISimpleAudioVolume)> {
		// SAFETY: plain Core Audio queries on this thread's COM objects.
		let result = unsafe {
			(|| -> windows::core::Result<Vec<(String, ISimpleAudioVolume)>> {
				let device = self.enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
				let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
				let sessions = manager.GetSessionEnumerator()?;
				let mut found = Vec::new();
				for index in 0..sessions.GetCount()? {
					let Ok(control) = sessions.GetSession(index) else { continue };
					if control.GetState().is_ok_and(|state| state == AudioSessionStateExpired) {
						continue;
					}
					let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
						continue;
					};
					let Ok(pid) = control2.GetProcessId() else { continue };
					let Some(name) = process_name(pid) else { continue };
					if !PLAYERS.iter().any(|player| player.eq_ignore_ascii_case(&name)) {
						continue;
					}
					if let Ok(volume) = control.cast::<ISimpleAudioVolume>() {
						found.push((name, volume));
					}
				}
				Ok(found)
			})()
		};
		result.unwrap_or_else(|error| {
			self.log.warn(&format!("duck: cannot list audio sessions: {error}"));
			Vec::new()
		})
	}
}

fn scaled(original: f32, level: f64) -> f32 {
	(f64::from(original) * level).clamp(0.0, 1.0) as f32
}

/// Sets `value` if the session is still (± tolerance) at what the helper last set.
fn set_if_unchanged(record: &Record, value: f32, log: &Log) -> SetOutcome {
	// SAFETY: `record.volume` is a live ISimpleAudioVolume of the media thread (the only caller).
	let current = match unsafe { record.volume.GetMasterVolume() } {
		Ok(current) => current,
		Err(error) => {
			log.info(&format!("duck: {} is gone ({error}); nothing to set", record.name));
			return SetOutcome::Dropped;
		}
	};
	if (current - record.last_set).abs() > VOLUME_TOLERANCE {
		log.info(&format!(
			"duck: {} volume is {current:.2}, not {:.2}: the user changed it; left alone",
			record.name, record.last_set
		));
		return SetOutcome::Dropped;
	}
	// SAFETY: as above.
	match unsafe { record.volume.SetMasterVolume(value, std::ptr::null()) } {
		Ok(()) => SetOutcome::Set,
		Err(error) => {
			log.warn(&format!("duck: {}: cannot set its volume: {error}", record.name));
			SetOutcome::Dropped
		}
	}
}

/// File name of the process image, e.g. `Spotify.exe`.
fn process_name(pid: u32) -> Option<String> {
	if pid == 0 {
		return None;
	}
	// SAFETY: the handle is closed below; the buffer outlives the call and `size` is its length.
	unsafe {
		let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
		let mut buffer = [0u16; 1024];
		let mut size = buffer.len() as u32;
		let queried = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size);
		let _ = CloseHandle(process);
		queried.ok()?;
		let path = String::from_utf16_lossy(&buffer[..size as usize]);
		Path::new(&path).file_name().map(|name| name.to_string_lossy().into_owned())
	}
}
