//! The watched-key state machine shared by the Windows and Linux key backends.
//!
//! Only watched codes are ever reported by name. Any other key (including every character key) is
//! anonymous: pressing it while a watched key is held produces one `chord` for that held code, once
//! per hold, so push-to-talk can tell a shortcut from a hold. Auto-repeat is filtered by tracking
//! down state.

use crate::keymap::is_modifier;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::protocol::HelperMessage;

#[derive(Debug, Default)]
pub struct WatchSet {
	/// Watched code → currently down.
	down: BTreeMap<&'static str, bool>,
	/// Held codes that already reported a `chord` during the current hold.
	chorded: BTreeSet<&'static str>,
}

impl WatchSet {
	pub fn is_empty(&self) -> bool {
		self.down.is_empty()
	}

	/// Replaces the watched set. Retained codes keep their down state; removed codes are forgotten
	/// without events; added codes start up, except modifiers, which take `modifier_down(code)`
	/// (reported as `key down` when held).
	pub fn replace(&mut self, codes: &[&'static str], modifier_down: impl Fn(&'static str) -> bool) -> Vec<HelperMessage> {
		let mut events = Vec::new();
		let mut next = BTreeMap::new();
		for &code in codes {
			if next.contains_key(code) {
				continue;
			}
			let down = match self.down.get(code) {
				Some(&down) => down,
				None if is_modifier(code) => {
					let down = modifier_down(code);
					if down {
						events.push(HelperMessage::Key { code, down: true });
					}
					down
				}
				None => false,
			};
			next.insert(code, down);
		}
		self.chorded.retain(|code| next.get(code).copied().unwrap_or(false));
		self.down = next;
		events
	}

	/// A native key went down; `code` is its name when it is a helper code, `None` for any other key.
	pub fn press(&mut self, code: Option<&'static str>) -> Vec<HelperMessage> {
		if let Some(code) = code {
			if self.down.get(code) == Some(&true) {
				return Vec::new(); // auto-repeat of a held watched key
			}
		}
		let mut events = Vec::new();
		for (&held, &down) in &self.down {
			if down && Some(held) != code && self.chorded.insert(held) {
				events.push(HelperMessage::Chord { code: held });
			}
		}
		if let Some(code) = code {
			if let Some(down) = self.down.get_mut(code) {
				*down = true;
				self.chorded.remove(code);
				events.push(HelperMessage::Key { code, down: true });
			}
		}
		events
	}

	/// A native key went up.
	pub fn release(&mut self, code: Option<&'static str>) -> Vec<HelperMessage> {
		let Some(code) = code else { return Vec::new() };
		match self.down.get_mut(code) {
			Some(down) if *down => {
				*down = false;
				self.chorded.remove(code);
				vec![HelperMessage::Key { code, down: false }]
			}
			_ => Vec::new(),
		}
	}
}

/// A `WatchSet` shared between the socket thread and a native event thread, plus the outbox events go to.
///
/// Every operation changes the set and enqueues its events under one lock, so the outbox order is
/// the order the transitions happened in: a concurrent release can never be enqueued before the
/// down a watch change reports for the same key.
pub struct Keys {
	set: Mutex<WatchSet>,
	outbox: Sender<HelperMessage>,
}

impl Keys {
	pub fn new(outbox: Sender<HelperMessage>) -> Arc<Self> {
		Arc::new(Self {
			set: Mutex::new(WatchSet::default()),
			outbox,
		})
	}

	fn lock(&self) -> MutexGuard<'_, WatchSet> {
		self.set.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	fn emit(&self, events: Vec<HelperMessage>) {
		for event in events {
			// The socket thread is gone only while the helper exits.
			let _ = self.outbox.send(event);
		}
	}

	/// `WatchSet::replace`; returns whether the set was empty before and is empty after.
	pub fn replace(&self, codes: &[&'static str], modifier_down: impl Fn(&'static str) -> bool) -> (bool, bool) {
		let mut set = self.lock();
		let was_empty = set.is_empty();
		let events = set.replace(codes, modifier_down);
		self.emit(events);
		(was_empty, set.is_empty())
	}

	pub fn press(&self, code: Option<&'static str>) {
		let mut set = self.lock();
		let events = set.press(code);
		self.emit(events);
	}

	pub fn release(&self, code: Option<&'static str>) {
		let mut set = self.lock();
		let events = set.release(code);
		self.emit(events);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn key(code: &'static str, down: bool) -> HelperMessage {
		HelperMessage::Key { code, down }
	}

	fn chord(code: &'static str) -> HelperMessage {
		HelperMessage::Chord { code }
	}

	fn watching(codes: &[&'static str]) -> WatchSet {
		let mut set = WatchSet::default();
		assert!(set.replace(codes, |_| false).is_empty());
		set
	}

	#[test]
	fn reports_watched_keys_and_filters_auto_repeat() {
		let mut set = watching(&["AltRight"]);
		assert_eq!(set.press(Some("AltRight")), vec![key("AltRight", true)]);
		assert!(set.press(Some("AltRight")).is_empty());
		assert_eq!(set.release(Some("AltRight")), vec![key("AltRight", false)]);
		assert!(set.release(Some("AltRight")).is_empty());
	}

	#[test]
	fn unwatched_keys_are_never_reported_by_name() {
		let mut set = watching(&["AltRight"]);
		assert!(set.press(Some("F5")).is_empty());
		assert!(set.press(None).is_empty());
		assert!(set.release(Some("F5")).is_empty());
		assert!(set.release(None).is_empty());
	}

	#[test]
	fn other_keys_during_a_hold_report_one_chord_per_hold() {
		let mut set = watching(&["AltRight"]);
		set.press(Some("AltRight"));
		assert_eq!(set.press(None), vec![chord("AltRight")]);
		assert!(set.release(None).is_empty());
		assert!(set.press(None).is_empty());
		assert!(set.press(Some("ShiftLeft")).is_empty());
		set.release(Some("AltRight"));
		set.press(Some("AltRight"));
		assert_eq!(set.press(None), vec![chord("AltRight")]);
	}

	#[test]
	fn replacing_the_watch_keeps_retained_down_state() {
		let mut set = watching(&["AltRight"]);
		set.press(Some("AltRight"));
		assert!(set.replace(&["AltRight", "F5"], |_| false).is_empty());
		assert!(set.press(Some("AltRight")).is_empty(), "still down: repeat is filtered");
		assert_eq!(set.release(Some("AltRight")), vec![key("AltRight", false)]);
		assert!(set.release(Some("F5")).is_empty(), "added non-modifier starts up");
	}

	#[test]
	fn removed_codes_are_forgotten_without_events() {
		let mut set = watching(&["AltRight", "F5"]);
		set.press(Some("F5"));
		assert!(set.replace(&["AltRight"], |_| true).is_empty());
		assert!(set.release(Some("F5")).is_empty());
		assert!(set.replace(&[], |_| true).is_empty());
		assert!(set.is_empty());
	}

	#[test]
	fn added_modifiers_take_the_hardware_state() {
		let mut set = watching(&["F5"]);
		let events = set.replace(&["F5", "ShiftLeft", "AltRight", "CapsLock"], |code| {
			code == "ShiftLeft" || code == "CapsLock"
		});
		assert_eq!(events, vec![key("ShiftLeft", true)], "CapsLock is not a modifier and starts up");
		assert_eq!(set.release(Some("ShiftLeft")), vec![key("ShiftLeft", false)]);
		assert!(set.release(Some("CapsLock")).is_empty());
	}
}
