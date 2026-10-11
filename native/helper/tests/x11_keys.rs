//! Drives a real helper on an X server with `xdotool` (CI job `linux-it`, Xvfb). Runs only when
//! `BGB_X11_IT=1`; otherwise it passes without doing anything.

mod common;

#[cfg(target_os = "linux")]
fn xdotool(args: &[&str]) {
	let status = std::process::Command::new("xdotool")
		.args(args)
		.status()
		.expect("xdotool is installed");
	assert!(status.success(), "xdotool {args:?} failed");
}

#[test]
fn x11_background_keys() {
	if std::env::var("BGB_X11_IT").as_deref() != Ok("1") {
		println!("skipped: set BGB_X11_IT=1 on Linux with an X server to run");
		return;
	}
	run();
}

#[cfg(target_os = "linux")]
fn run() {
	common::run_key_sequence(
		common::Bridge::start(),
		|| xdotool(&["keydown", "Alt_R"]),
		|| xdotool(&["keyup", "Alt_R"]),
		|| xdotool(&["key", "a"]),
	);
}

#[cfg(not(target_os = "linux"))]
fn run() {
	println!("skipped: Linux only");
}
