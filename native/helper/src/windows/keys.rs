//! System-wide watched keys through a low-level keyboard hook (`WH_KEYBOARD_LL`) on a dedicated
//! thread with its own message loop. The hook is installed only while the watched set is non-empty.

use crate::keymap::{self, WINDOWS_KEYS};
use crate::protocol::HelperMessage;
use crate::watch::Keys;
use crate::Log;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
	CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
	PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const WM_HOOK_ON: u32 = WM_APP + 1;
const WM_HOOK_OFF: u32 = WM_APP + 2;

/// The hook procedure has no user data; it reaches the shared watch state through this.
static HOOK_TARGET: OnceLock<Arc<Keys>> = OnceLock::new();

pub struct HookKeys {
	keys: Arc<Keys>,
	thread_id: u32,
	log: Log,
}

impl HookKeys {
	pub fn start(outbox: Sender<HelperMessage>, log: Log) -> Result<Self, String> {
		let keys = Keys::new(outbox);
		HOOK_TARGET
			.set(Arc::clone(&keys))
			.map_err(|_| "the keyboard hook is already running".to_owned())?;
		let (ready, thread_id) = mpsc::channel();
		let thread_log = log.clone();
		std::thread::Builder::new()
			.name("keyboard-hook".into())
			.spawn(move || hook_thread(&ready, &thread_log))
			.map_err(|error| error.to_string())?;
		let thread_id = thread_id
			.recv()
			.map_err(|_| "the keyboard hook thread failed to start".to_owned())?;
		Ok(Self { keys, thread_id, log })
	}

	pub fn watch(&self, codes: &[&'static str]) {
		let (events, was_empty, is_empty) = {
			let mut set = self.keys.lock();
			let was_empty = set.is_empty();
			let events = set.replace(codes, modifier_down);
			(events, was_empty, set.is_empty())
		};
		self.keys.emit(events);
		if was_empty != is_empty {
			let message = if is_empty { WM_HOOK_OFF } else { WM_HOOK_ON };
			// SAFETY: posting a private message to our own hook thread's queue.
			if let Err(error) = unsafe { PostThreadMessageW(self.thread_id, message, WPARAM(0), LPARAM(0)) } {
				self.log.error(&format!("cannot reach the keyboard hook thread: {error}"));
			}
		}
	}
}

fn modifier_down(code: &'static str) -> bool {
	// SAFETY: GetAsyncKeyState only reads the asynchronous key state.
	keymap::native_for(WINDOWS_KEYS, code).is_some_and(|vk| unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000 != 0)
}

fn hook_thread(ready: &Sender<u32>, log: &Log) {
	let mut message = MSG::default();
	// SAFETY: plain Win32 calls on this thread; PeekMessageW creates its message queue before the
	// thread id is published, so posted messages are never lost.
	unsafe {
		let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
		let _ = ready.send(GetCurrentThreadId());
	}
	// SAFETY: a null module name returns this executable's handle.
	let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.ok().map(Into::into);
	let mut hook: Option<HHOOK> = None;
	// SAFETY: standard message loop; `message` outlives every call.
	while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
		match message.message {
			WM_HOOK_ON if hook.is_none() => match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0) } {
				Ok(installed) => {
					hook = Some(installed);
					log.info("keyboard hook installed");
				}
				Err(error) => log.error(&format!("cannot install the keyboard hook: {error}")),
			},
			WM_HOOK_OFF => {
				if let Some(installed) = hook.take() {
					// SAFETY: `installed` came from SetWindowsHookExW on this thread.
					let _ = unsafe { UnhookWindowsHookEx(installed) };
					log.info("keyboard hook removed");
				}
			}
			_ => {}
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
