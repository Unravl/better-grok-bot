//! Wire format of `sdk/helper.ts` protocol v4 (JSON text frames).

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 4;

/// Agent → helper.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AgentMessage {
	/// Replaces the whole watched set; `[]` disables the hook.
	Watch {
		codes: Vec<String>,
	},
	/// `level` 0–1; release = `{ducked:false, level:1}`.
	Duck {
		ducked: bool,
		level: f64,
	},
	Quit,
}

impl AgentMessage {
	/// `None` for anything that is not a valid v4 agent message (ignored by the helper).
	pub fn parse(text: &str) -> Option<Self> {
		serde_json::from_str(text).ok()
	}
}

/// Helper → agent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum HelperMessage {
	Hello {
		protocol: u8,
		platform: &'static str,
		keys: &'static str,
		codes: Vec<&'static str>,
		media: bool,
	},
	/// Key access changed after `hello`: `"denied"` / `"granted"`. Only Windows sends it (its
	/// keyboard hook failed to install / installed after a failure).
	#[cfg_attr(not(windows), allow(dead_code))]
	Access {
		keys: &'static str,
	},
	Key {
		code: &'static str,
		down: bool,
	},
	Chord {
		code: &'static str,
	},
	Log {
		level: &'static str,
		message: String,
	},
}

impl HelperMessage {
	pub fn to_json(&self) -> String {
		serde_json::to_string(self).expect("helper messages always serialize")
	}
}

/// The duck level a `duck` message asks for: `None` = released, else clamped to 0–1.
pub fn duck_level(ducked: bool, level: f64) -> Option<f64> {
	if !ducked || !level.is_finite() {
		return None;
	}
	Some(level.clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_agent_messages_and_ignores_unknown_ones() {
		assert_eq!(
			AgentMessage::parse(r#"{"type":"watch","codes":["AltRight","F5"]}"#),
			Some(AgentMessage::Watch {
				codes: vec!["AltRight".into(), "F5".into()]
			})
		);
		assert_eq!(
			AgentMessage::parse(r#"{"type":"duck","ducked":true,"level":0.25}"#),
			Some(AgentMessage::Duck { ducked: true, level: 0.25 })
		);
		assert_eq!(AgentMessage::parse(r#"{"type":"quit"}"#), Some(AgentMessage::Quit));
		assert_eq!(AgentMessage::parse(r#"{"type":"watch","keyCode":61}"#), None);
		assert_eq!(AgentMessage::parse(r#"{"type":"reboot"}"#), None);
		assert_eq!(AgentMessage::parse("not json"), None);
	}

	#[test]
	fn hello_matches_the_sdk_shape() {
		let hello = HelperMessage::Hello {
			protocol: PROTOCOL_VERSION,
			platform: "linux",
			keys: "unsupported",
			codes: vec![],
			media: false,
		};
		let value: serde_json::Value = serde_json::from_str(&hello.to_json()).unwrap();
		assert_eq!(
			value,
			serde_json::json!({"type":"hello","protocol":4,"platform":"linux","keys":"unsupported","codes":[],"media":false})
		);
		let chord: serde_json::Value = serde_json::from_str(&HelperMessage::Chord { code: "AltRight" }.to_json()).unwrap();
		assert_eq!(chord, serde_json::json!({"type":"chord","code":"AltRight"}));
		let access: serde_json::Value = serde_json::from_str(&HelperMessage::Access { keys: "denied" }.to_json()).unwrap();
		assert_eq!(access, serde_json::json!({"type":"access","keys":"denied"}));
	}

	#[test]
	fn duck_level_clamps_and_releases() {
		assert_eq!(duck_level(true, 0.5), Some(0.5));
		assert_eq!(duck_level(true, 3.0), Some(1.0));
		assert_eq!(duck_level(true, -1.0), Some(0.0));
		assert_eq!(duck_level(false, 0.2), None);
		assert_eq!(duck_level(true, f64::NAN), None);
	}
}
