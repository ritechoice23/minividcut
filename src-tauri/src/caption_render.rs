use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Deserialize, Serialize)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub words: Vec<TimedWord>,
}

#[derive(Deserialize, Serialize)]
pub struct TimedWord {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Deserialize)]
pub struct CaptionTrack {
    pub cues: Vec<Cue>,
    pub style: Style,
}

#[derive(Deserialize)]
pub struct Style {
    preset: Preset,
    position: Position,
    size: Size,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Preset {
    Classic,
    Boxed,
    Serif,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Position {
    Top,
    Middle,
    Bottom,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Size {
    Small,
    Medium,
    Large,
}

fn time(centiseconds: u64) -> String {
    let hours = centiseconds / 360_000;
    let minutes = centiseconds / 6_000 % 60;
    let seconds = centiseconds / 100 % 60;
    format!(
        "{hours}:{minutes:02}:{seconds:02}.{:02}",
        centiseconds % 100
    )
}

impl CaptionTrack {
    pub fn ass(&self, width: u32, height: u32, duration: f64) -> String {
        let (font, bold, border, outline) = match self.style.preset {
            Preset::Classic => ("Arial", -1, 1, 0.065),
            Preset::Boxed => ("Arial", -1, 3, 0.18),
            Preset::Serif => ("Georgia", 0, 1, 0.06),
        };
        let size = match self.style.size {
            Size::Small => 0.030,
            Size::Medium => 0.037,
            Size::Large => 0.046,
        };
        // libass font size uses font metrics, so scale to match CSS em sizing.
        let size = f64::from(width)
            * size
            * if height > width { 1.6 } else { 1.0 }
            * if matches!(self.style.preset, Preset::Serif) {
                1.14
            } else {
                1.12
            };
        let outline = size * outline;
        let (align, vertical) = match self.style.position {
            Position::Top => (8, 0.10),
            Position::Middle => (5, 0.0),
            Position::Bottom => (2, if height > width { 0.17 } else { 0.10 }),
        };
        let margin = width * 8 / 100;
        let margin_v = (f64::from(height) * vertical).round() as u32;
        let mut ass = format!(
            "[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
             [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
             Style: Caption,{font},{size:.2},&H00FFFFFF,&H00FFFFFF,&H30101010,&H30101010,{bold},0,0,0,100,100,0,0,{border},{outline:.2},0,{align},{margin},{margin},{margin_v},1\n\n\
             [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        );
        for cue in &self.cues {
            let start = (cue.start.clamp(0.0, duration) * 100.0).round() as u64;
            let end = (cue.end.clamp(0.0, duration) * 100.0).round() as u64;
            if end <= start || cue.text.trim().is_empty() {
                continue;
            }
            let text = cue
                .text
                .replace('\\', "\\​")
                .replace('{', "｛")
                .replace('}', "｝")
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .replace('\n', "\\N")
                .replace('\0', "");
            let _ = writeln!(
                ass,
                "Dialogue: 0,{},{},Caption,,0,0,0,,{text}",
                time(start),
                time(end)
            );
        }
        ass
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ass_clamps_times_and_treats_user_text_as_literal() {
        let track: CaptionTrack = serde_json::from_value(serde_json::json!({
            "style": { "preset": "boxed", "position": "bottom", "size": "medium" },
            "cues": [{ "start": -2, "end": 9, "text": "Hello, {\\pos(2,2)}\nWorld" }]
        }))
        .unwrap();
        let ass = track.ass(1080, 1920, 3.0);
        assert!(ass.contains("PlayResX: 1080\nPlayResY: 1920"));
        assert!(ass.contains(
            "Dialogue: 0,0:00:00.00,0:00:03.00,Caption,,0,0,0,,Hello, ｛\\​pos(2,2)｝\\NWorld"
        ));
    }
}
