//! `bgbw.exe`: a GUI-subsystem launcher for `bgb.exe` on Windows, used by the login Run value and the
//! agent restarts so no console window flashes. It starts `<dir of self>\bgb.exe` with the same
//! arguments under `CREATE_NO_WINDOW` (not `DETACHED_PROCESS`), so `bgb.exe` gets a hidden console
//! that its own children inherit, then exits without waiting.

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
	use std::os::windows::process::CommandExt;
	use std::process::{Command, Stdio};

	const CREATE_NO_WINDOW: u32 = 0x0800_0000;

	let Ok(this) = std::env::current_exe() else { std::process::exit(1) };
	let spawned = Command::new(this.with_file_name("bgb.exe"))
		.args(std::env::args_os().skip(1))
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.creation_flags(CREATE_NO_WINDOW)
		.spawn();
	std::process::exit(if spawned.is_ok() { 0 } else { 1 });
}

#[cfg(not(windows))]
fn main() {
	eprintln!("bgbw: Windows only; run bgb directly");
	std::process::exit(1);
}
