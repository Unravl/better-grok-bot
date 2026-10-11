//! Drives a real helper on Windows with `SendInput` (CI job `rust` on `windows-2025`). Runs only when
//! `BGB_WIN_IT=1`; otherwise it passes without doing anything. Without an interactive input desktop
//! (`SendInput` inserts nothing) it prints "skipped: no interactive input desktop" and passes.

mod common;

#[cfg(windows)]
mod input {
	use windows::Win32::UI::Input::KeyboardAndMouse::{
		SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY,
		VK_A, VK_F24, VK_RMENU,
	};

	fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> u32 {
		let input = INPUT {
			r#type: INPUT_KEYBOARD,
			Anonymous: INPUT_0 {
				ki: KEYBDINPUT {
					wVk: vk,
					wScan: 0,
					dwFlags: flags,
					time: 0,
					dwExtraInfo: 0,
				},
			},
		};
		// SAFETY: one fully initialized INPUT with its correct size.
		unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) }
	}

	/// Whether injected input reaches the input desktop (a key-up of an unpressed F24 is harmless).
	pub fn available() -> bool {
		key(VK_F24, KEYEVENTF_KEYUP) == 1
	}

	fn inject(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) {
		assert_eq!(key(vk, flags), 1, "SendInput inserted no event");
	}

	pub fn alt_right_down() {
		inject(VK_RMENU, KEYEVENTF_EXTENDEDKEY);
	}

	pub fn alt_right_up() {
		inject(VK_RMENU, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP);
	}

	pub fn tap_a() {
		inject(VK_A, KEYBD_EVENT_FLAGS(0));
		inject(VK_A, KEYEVENTF_KEYUP);
	}
}

#[test]
fn windows_background_keys() {
	if std::env::var("BGB_WIN_IT").as_deref() != Ok("1") {
		println!("skipped: set BGB_WIN_IT=1 on Windows to run");
		return;
	}
	run();
}

#[cfg(windows)]
fn run() {
	if !input::available() {
		println!("skipped: no interactive input desktop");
		return;
	}
	common::run_key_sequence(common::Bridge::start(), input::alt_right_down, input::alt_right_up, input::tap_a);
}

#[cfg(not(windows))]
fn run() {
	println!("skipped: Windows only");
}
