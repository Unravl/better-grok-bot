//! `bgbw.exe`: a GUI-subsystem launcher for `bgb.exe` on Windows, used by the login Run value and the
//! agent restarts so no console window flashes. It starts `<dir of self>\bgb.exe` with the same
//! arguments under `CREATE_NO_WINDOW` (not `DETACHED_PROCESS`), so `bgb.exe` gets a hidden console
//! that its own children inherit, then exits without waiting.
//!
//! The child inherits no handles. Rust's `std::process::Command` always lets the child inherit every
//! inheritable handle of this process, so a pipe this process received (for example `cmd /c` capturing
//! output) would stay open in `bgb.exe` and in the long-lived agent it starts, and whoever reads that
//! pipe would wait for the agent to exit. `CreateProcessW` is therefore called directly with
//! `bInheritHandles = FALSE`.

#![cfg_attr(windows, windows_subsystem = "windows")]

/// The arguments part of a Windows command line: everything after the program name and the
/// whitespace that follows it. The program name is parsed as the CRT does: quotes toggle quoting,
/// backslashes are literal, and it ends at the first unquoted space or tab.
#[cfg_attr(not(windows), allow(dead_code))]
fn arguments_tail(line: &[u16]) -> &[u16] {
	const QUOTE: u16 = b'"' as u16;
	let blank = |c: u16| c == u16::from(b' ') || c == u16::from(b'\t');
	let mut i = 0;
	let mut quoted = false;
	while i < line.len() {
		let c = line[i];
		if c == QUOTE {
			quoted = !quoted;
		} else if !quoted && blank(c) {
			break;
		}
		i += 1;
	}
	while i < line.len() && blank(line[i]) {
		i += 1;
	}
	&line[i..]
}

#[cfg(windows)]
mod win {
	use std::ffi::c_void;

	pub type Handle = *mut c_void;

	pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

	#[repr(C)]
	pub struct StartupInfoW {
		pub cb: u32,
		pub reserved: *mut u16,
		pub desktop: *mut u16,
		pub title: *mut u16,
		pub x: u32,
		pub y: u32,
		pub x_size: u32,
		pub y_size: u32,
		pub x_count_chars: u32,
		pub y_count_chars: u32,
		pub fill_attribute: u32,
		pub flags: u32,
		pub show_window: u16,
		pub cb_reserved2: u16,
		pub reserved2: *mut u8,
		pub std_input: Handle,
		pub std_output: Handle,
		pub std_error: Handle,
	}

	#[repr(C)]
	pub struct ProcessInformation {
		pub process: Handle,
		pub thread: Handle,
		pub process_id: u32,
		pub thread_id: u32,
	}

	#[link(name = "kernel32")]
	extern "system" {
		pub fn GetCommandLineW() -> *const u16;
		#[allow(clippy::too_many_arguments)]
		pub fn CreateProcessW(
			application_name: *const u16,
			command_line: *mut u16,
			process_attributes: *const c_void,
			thread_attributes: *const c_void,
			inherit_handles: i32,
			creation_flags: u32,
			environment: *const c_void,
			current_directory: *const u16,
			startup_info: *const StartupInfoW,
			process_information: *mut ProcessInformation,
		) -> i32;
		pub fn CloseHandle(handle: Handle) -> i32;
	}
}

#[cfg(windows)]
fn main() {
	use std::os::windows::ffi::OsStrExt;

	let Ok(this) = std::env::current_exe() else { std::process::exit(1) };
	let bgb: Vec<u16> = this.with_file_name("bgb.exe").as_os_str().encode_wide().collect();

	// SAFETY: GetCommandLineW returns this process's NUL-terminated command line, valid for its lifetime.
	let own_line = unsafe {
		let start = win::GetCommandLineW();
		let mut len = 0;
		while *start.add(len) != 0 {
			len += 1;
		}
		std::slice::from_raw_parts(start, len)
	};

	// `"<bgb.exe>" <our arguments, verbatim>`: the child parses exactly the arguments we were given.
	let mut command_line = Vec::with_capacity(bgb.len() + own_line.len() + 4);
	command_line.push(u16::from(b'"'));
	command_line.extend_from_slice(&bgb);
	command_line.push(u16::from(b'"'));
	let tail = arguments_tail(own_line);
	if !tail.is_empty() {
		command_line.push(u16::from(b' '));
		command_line.extend_from_slice(tail);
	}
	command_line.push(0);
	let mut application = bgb;
	application.push(0);

	// SAFETY: both structs are plain C data for which all-zero is a valid (empty) value.
	let mut startup: win::StartupInfoW = unsafe { std::mem::zeroed() };
	startup.cb = std::mem::size_of::<win::StartupInfoW>() as u32;
	let mut info: win::ProcessInformation = unsafe { std::mem::zeroed() };
	// SAFETY: every pointer is valid for the call; `command_line` is mutable and NUL-terminated as
	// CreateProcessW requires; null attributes, environment and directory mean "inherit from us".
	let created = unsafe {
		win::CreateProcessW(
			application.as_ptr(),
			command_line.as_mut_ptr(),
			std::ptr::null(),
			std::ptr::null(),
			0,
			win::CREATE_NO_WINDOW,
			std::ptr::null(),
			std::ptr::null(),
			&startup,
			&mut info,
		)
	};
	if created == 0 {
		std::process::exit(1);
	}
	// SAFETY: CreateProcessW succeeded, so both handles are open and owned by us.
	unsafe {
		win::CloseHandle(info.thread);
		win::CloseHandle(info.process);
	}
	std::process::exit(0);
}

#[cfg(not(windows))]
fn main() {
	eprintln!("bgbw: Windows only; run bgb directly");
	std::process::exit(1);
}

#[cfg(test)]
mod tests {
	use super::arguments_tail;

	fn tail(line: &str) -> String {
		let wide: Vec<u16> = line.encode_utf16().collect();
		String::from_utf16(arguments_tail(&wide)).unwrap()
	}

	#[test]
	fn skips_a_quoted_program_name() {
		assert_eq!(
			tail(r#""C:\Users\a b\AppData\Local\BetterGrokBot\bin\bgbw.exe" --data-dir "C:\x y" login"#),
			r#"--data-dir "C:\x y" login"#
		);
	}

	#[test]
	fn skips_a_bare_program_name_and_its_blanks() {
		assert_eq!(tail("bgbw.exe \t agent --replace"), "agent --replace");
	}

	#[test]
	fn keeps_argument_escapes_verbatim() {
		assert_eq!(tail(r#"bgbw "a \"b\" c\\" d"#), r#""a \"b\" c\\" d"#);
	}

	#[test]
	fn program_name_only() {
		assert_eq!(tail(r#""C:\a b\bgbw.exe""#), "");
		assert_eq!(tail("bgbw.exe"), "");
	}

	#[test]
	fn quotes_inside_the_program_name_toggle() {
		assert_eq!(tail(r#"C:\a" "b\bgbw.exe x"#), "x");
	}
}
