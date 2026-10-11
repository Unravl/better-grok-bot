//! System-wide watched keys through a low-level keyboard hook (`WH_KEYBOARD_LL`) on a dedicated
//! thread with its own message loop. The hook is installed only while the watched set is non-empty.
//!
//! Watch changes are applied on the hook thread as well: the hook procedure runs on this thread's
//! message loop, so held modifiers sampled right after the hook is installed are ordered against key
//! events, and a release during activation is reported after the sampled down instead of being lost.
//! A hook that fails to install is reported as `access: denied` and retried with backoff while keys
//! are wanted; `access: granted` follows once it installs.

use crate::keymap::{self, WINDOWS_KEYS};
use crate::protocol::HelperMessage;
use crate::watch::Keys;
use crate::Log;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
	CallNextHookEx, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK,
	KBDLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER,
};

/// A watch request is queued on `HookKeys::requests`; apply the latest one.
const WM_WATCH: u32 = WM_APP + 1;
/// The first retry after the hook failed to install; each further failure doubles it up to the max.
const INSTALL_RETRY_MIN: Duration = Duration::from_secs(1);
const INSTALL_RETRY_MAX: Duration = Duration::from_secs(60);

/// The hook procedure has no user data; it reaches the shared watch state through this.
static HOOK_TARGET: OnceLock<Arc<Keys>> = OnceLock::new();

pub struct HookKeys {
	/// Watched sets for the hook thread, each announced by a `WM_WATCH` post.
	requests: Sender<Vec<&'static str>>,
	thread_id: u32,
	log: Log,
}

impl HookKeys {
	pub fn start(outbox: Sender<HelperMessage>, log: Log) -> Result<Self, String> {
		let keys = Keys::new(outbox.clone());
		HOOK_TARGET
			.set(Arc::clone(&keys))
			.map_err(|_| "the keyboard hook is already running".to_owned())?;
		let (requests, inbox) = mpsc::channel();
		let (ready, thread_id) = mpsc::channel();
		let thread_log = log.clone();
		std::thread::Builder::new()
			.name("keyboard-hook".into())
			.spawn(move || hook_thread(&ready, keys, inbox, outbox, thread_log))
			.map_err(|error| error.to_string())?;
		let thread_id = thread_id
			.recv()
			.map_err(|_| "the keyboard hook thread failed to start".to_owned())?;
		Ok(Self { requests, thread_id, log })
	}

	pub fn watch(&self, codes: &[&'static str]) {
		// The hook thread runs until the process exits.
		let _ = self.requests.send(codes.to_vec());
		// SAFETY: posting a private message to our own hook thread's queue.
		if let Err(error) = unsafe { PostThreadMessageW(self.thread_id, WM_WATCH, WPARAM(0), LPARAM(0)) } {
			self.log.error(&format!("cannot reach the keyboard hook thread: {error}"));
		}
	}
}

fn modifier_down(code: &'static str) -> bool {
	// SAFETY: GetAsyncKeyState only reads the asynchronous key state.
	keymap::native_for(WINDOWS_KEYS, code).is_some_and(|vk| unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000 != 0)
}

/// The hook thread's state; it lives on that thread only.
struct HookThread {
	keys: Arc<Keys>,
	requests: Receiver<Vec<&'static str>>,
	outbox: Sender<HelperMessage>,
	log: Log,
	module: Option<HINSTANCE>,
	/// The watched set last requested; the hook is wanted while it is non-empty.
	wanted: Vec<&'static str>,
	/// The installed hook. The shared watch set stays empty while this is `None`, so nothing is
	/// reported down without a hook to see its release.
	hook: Option<HHOOK>,
	/// The pending install retry (a thread timer id), while keys are wanted but the hook is not installed.
	retry_timer: Option<usize>,
	retry_delay: Duration,
	/// `access: denied` was sent and no install has succeeded since.
	denied: bool,
}

fn hook_thread(ready: &Sender<u32>, keys: Arc<Keys>, requests: Receiver<Vec<&'static str>>, outbox: Sender<HelperMessage>, log: Log) {
	let mut message = MSG::default();
	// SAFETY: plain Win32 calls on this thread; PeekMessageW creates its message queue before the
	// thread id is published, so posted messages are never lost.
	unsafe {
		let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
		let _ = ready.send(GetCurrentThreadId());
	}
	let mut thread = HookThread {
		keys,
		requests,
		outbox,
		log,
		// SAFETY: a null module name returns this executable's handle.
		module: unsafe { GetModuleHandleW(PCWSTR::null()) }.ok().map(Into::into),
		wanted: Vec::new(),
		hook: None,
		retry_timer: None,
		retry_delay: INSTALL_RETRY_MIN,
		denied: false,
	};
	// SAFETY: standard message loop; `message` outlives every call.
	while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
		match message.message {
			WM_WATCH => thread.watch_requested(),
			WM_TIMER if thread.retry_timer == Some(message.wParam.0) => thread.retry_install(),
			_ => {}
		}
	}
}

impl HookThread {
	fn watch_requested(&mut self) {
		// Each request replaces the whole set, so only the latest one matters.
		let Some(codes) = self.requests.try_iter().last() else { return };
		self.wanted = codes;
		if self.wanted.is_empty() {
			self.keys.replace(&[], modifier_down);
			self.cancel_retry();
			if let Some(installed) = self.hook.take() {
				// SAFETY: `installed` came from SetWindowsHookExW on this thread.
				let _ = unsafe { UnhookWindowsHookEx(installed) };
				self.log.info("keyboard hook removed");
			}
			return;
		}
		// A watch frame while a retry is pending (often the same set resent) waits for that retry.
		if self.hook.is_none() && self.retry_timer.is_none() {
			self.install();
		}
		self.report_wanted();
	}

	fn retry_install(&mut self) {
		self.cancel_retry();
		if self.wanted.is_empty() || self.hook.is_some() {
			return;
		}
		self.install();
		self.report_wanted();
	}

	/// Moves the shared watch set to `wanted` once the hook listens. Held modifiers are sampled here,
	/// after the hook is installed and before this thread pumps its next message: the hook procedure
	/// sees a release from now on only after this returns, and the asynchronous key state changes only
	/// once the hook has seen it, so the release is reported after the sampled down, never lost.
	fn report_wanted(&self) {
		if self.hook.is_some() {
			self.keys.replace(&self.wanted, modifier_down);
		}
	}

	fn install(&mut self) {
		// SAFETY: installs `hook_proc` for this thread's message loop; removed by UnhookWindowsHookEx.
		match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), self.module, 0) } {
			Ok(installed) => {
				self.hook = Some(installed);
				self.retry_delay = INSTALL_RETRY_MIN;
				self.log.info("keyboard hook installed");
				if std::mem::take(&mut self.denied) {
					let _ = self.outbox.send(HelperMessage::Access { keys: "granted" });
				}
			}
			Err(error) => {
				let delay = self.retry_delay;
				self.retry_delay = (delay * 2).min(INSTALL_RETRY_MAX);
				let message = format!("cannot install the keyboard hook: {error}; retrying in {} s", delay.as_secs());
				if self.denied {
					self.log.info(&message);
				} else {
					self.log.error(&message);
					self.denied = true;
					let _ = self.outbox.send(HelperMessage::Access { keys: "denied" });
				}
				self.schedule_retry(delay);
			}
		}
	}

	fn schedule_retry(&mut self, delay: Duration) {
		let elapse = u32::try_from(delay.as_millis()).unwrap_or(u32::MAX);
		// SAFETY: a thread timer (no window, no callback): its WM_TIMER arrives in this thread's queue.
		match unsafe { SetTimer(None, 0, elapse, None) } {
			0 => self.log.error("cannot schedule a keyboard hook retry"),
			id => self.retry_timer = Some(id),
		}
	}

	fn cancel_retry(&mut self) {
		if let Some(id) = self.retry_timer.take() {
			// SAFETY: `id` is a thread timer this thread created; killing it also drops its queued WM_TIMER.
			let _ = unsafe { KillTimer(None, id) };
		}
	}
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
	if code >= 0 {
		if let Some(keys) = HOOK_TARGET.get() {
			// SAFETY: for WH_KEYBOARD_LL with code >= 0, lparam points to a KBDLLHOOKSTRUCT.
			let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
			let name = u16::try_from(info.vkCode).ok().and_then(|vk| keymap::code_for(WINDOWS_KEYS, vk));
			match wparam.0 as u32 {
				WM_KEYDOWN | WM_SYSKEYDOWN => keys.press(name),
				WM_KEYUP | WM_SYSKEYUP => keys.release(name),
				_ => {}
			}
		}
	}
	// SAFETY: forwards the event unchanged; the hook only listens.
	unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
