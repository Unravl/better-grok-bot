//! `KeyboardEvent.code` ↔ native key codes, covering exactly `HELPER_CODES.win32` / `HELPER_CODES.linux`
//! in `sdk/helper.ts`. Every helper reports these codes only; any other key is anonymous (it can only
//! trigger a `chord`).

/// `KeyboardEvent.code` → Windows virtual-key code (left/right-specific, as `KBDLLHOOKSTRUCT.vkCode` reports).
#[cfg_attr(not(windows), allow(dead_code))]
pub const WINDOWS_KEYS: &[(&str, u16)] = &[
	("ShiftLeft", 0xA0),
	("ShiftRight", 0xA1),
	("ControlLeft", 0xA2),
	("ControlRight", 0xA3),
	("AltLeft", 0xA4),
	("AltRight", 0xA5),
	("MetaLeft", 0x5B),
	("MetaRight", 0x5C),
	("CapsLock", 0x14),
	("NumLock", 0x90),
	("ScrollLock", 0x91),
	("F1", 0x70),
	("F2", 0x71),
	("F3", 0x72),
	("F4", 0x73),
	("F5", 0x74),
	("F6", 0x75),
	("F7", 0x76),
	("F8", 0x77),
	("F9", 0x78),
	("F10", 0x79),
	("F11", 0x7A),
	("F12", 0x7B),
	("F13", 0x7C),
	("F14", 0x7D),
	("F15", 0x7E),
	("F16", 0x7F),
	("F17", 0x80),
	("F18", 0x81),
	("F19", 0x82),
	("F20", 0x83),
	("F21", 0x84),
	("F22", 0x85),
	("F23", 0x86),
	("F24", 0x87),
	("Pause", 0x13),
	("Insert", 0x2D),
	("ContextMenu", 0x5D),
	("MediaPlayPause", 0xB3),
	("MediaStop", 0xB2),
	("MediaTrackNext", 0xB0),
	("MediaTrackPrevious", 0xB1),
	("AudioVolumeMute", 0xAD),
];

/// `KeyboardEvent.code` → Linux evdev code (X11 keycode = evdev + 8).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const LINUX_KEYS: &[(&str, u16)] = &[
	("AltLeft", 56),
	("AltRight", 100),
	("ControlLeft", 29),
	("ControlRight", 97),
	("ShiftLeft", 42),
	("ShiftRight", 54),
	("MetaLeft", 125),
	("MetaRight", 126),
	("CapsLock", 58),
	("NumLock", 69),
	("ScrollLock", 70),
	("F1", 59),
	("F2", 60),
	("F3", 61),
	("F4", 62),
	("F5", 63),
	("F6", 64),
	("F7", 65),
	("F8", 66),
	("F9", 67),
	("F10", 68),
	("F11", 87),
	("F12", 88),
	("F13", 183),
	("F14", 184),
	("F15", 185),
	("F16", 186),
	("F17", 187),
	("F18", 188),
	("F19", 189),
	("F20", 190),
	("F21", 191),
	("F22", 192),
	("F23", 193),
	("F24", 194),
	("Pause", 119),
	("Insert", 110),
	("ContextMenu", 127),
	("MediaPlayPause", 164),
	("MediaStop", 166),
	("MediaTrackNext", 163),
	("MediaTrackPrevious", 165),
	("AudioVolumeMute", 113),
];

/// Modifier codes: added to a watch set, they take the current hardware state where the OS can tell.
const MODIFIERS: &[&str] = &[
	"AltLeft",
	"AltRight",
	"ControlLeft",
	"ControlRight",
	"ShiftLeft",
	"ShiftRight",
	"MetaLeft",
	"MetaRight",
];

pub fn is_modifier(code: &str) -> bool {
	MODIFIERS.contains(&code)
}

/// The canonical (static) spelling of `code` if `table` covers it.
pub fn canonical(table: &'static [(&'static str, u16)], code: &str) -> Option<&'static str> {
	table.iter().find(|(name, _)| *name == code).map(|(name, _)| *name)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn native_for(table: &'static [(&'static str, u16)], code: &str) -> Option<u16> {
	table.iter().find(|(name, _)| *name == code).map(|(_, native)| *native)
}

pub fn code_for(table: &'static [(&'static str, u16)], native: u16) -> Option<&'static str> {
	table.iter().find(|(_, value)| *value == native).map(|(name, _)| *name)
}

pub fn codes(table: &'static [(&'static str, u16)]) -> Vec<&'static str> {
	table.iter().map(|(name, _)| *name).collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::collections::BTreeSet;

	/// `HELPER_CODES.win32` and `HELPER_CODES.linux` from `sdk/helper.ts`: every `WATCHABLE_CODES`
	/// entry except `Fn`.
	const SDK_NON_MAC_CODES: &[&str] = &[
		"AltLeft",
		"AltRight",
		"ControlLeft",
		"ControlRight",
		"ShiftLeft",
		"ShiftRight",
		"MetaLeft",
		"MetaRight",
		"CapsLock",
		"NumLock",
		"ScrollLock",
		"F1",
		"F2",
		"F3",
		"F4",
		"F5",
		"F6",
		"F7",
		"F8",
		"F9",
		"F10",
		"F11",
		"F12",
		"F13",
		"F14",
		"F15",
		"F16",
		"F17",
		"F18",
		"F19",
		"F20",
		"F21",
		"F22",
		"F23",
		"F24",
		"Pause",
		"Insert",
		"ContextMenu",
		"MediaPlayPause",
		"MediaStop",
		"MediaTrackNext",
		"MediaTrackPrevious",
		"AudioVolumeMute",
	];

	fn assert_exact_bijection(table: &'static [(&'static str, u16)]) {
		let expected: BTreeSet<&str> = SDK_NON_MAC_CODES.iter().copied().collect();
		let names: BTreeSet<&str> = table.iter().map(|(name, _)| *name).collect();
		assert_eq!(names, expected, "keymap must cover exactly HELPER_CODES");
		assert_eq!(names.len(), table.len(), "duplicate code in keymap");
		let natives: BTreeSet<u16> = table.iter().map(|(_, native)| *native).collect();
		assert_eq!(natives.len(), table.len(), "two codes share one native key");
		for (name, native) in table {
			assert_eq!(code_for(table, *native), Some(*name));
			assert_eq!(native_for(table, name), Some(*native));
		}
	}

	#[test]
	fn windows_keymap_covers_exactly_helper_codes_win32() {
		assert_exact_bijection(WINDOWS_KEYS);
	}

	#[test]
	fn linux_keymap_covers_exactly_helper_codes_linux() {
		assert_exact_bijection(LINUX_KEYS);
	}

	#[test]
	fn character_keys_are_never_mapped() {
		for code in ["KeyA", "Digit1", "Space", "Enter", "Fn"] {
			assert_eq!(canonical(WINDOWS_KEYS, code), None);
			assert_eq!(canonical(LINUX_KEYS, code), None);
		}
		// Windows 'A' and evdev KEY_A are anonymous.
		assert_eq!(code_for(WINDOWS_KEYS, 0x41), None);
		assert_eq!(code_for(LINUX_KEYS, 30), None);
	}
}
