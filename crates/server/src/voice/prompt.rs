//! What a call says to a model (`voice/prompt`).

const SPOKEN: &str = "口语，先说结论；不念代码、路径、命令和长列表。";

/// What a MOSS call's own model is told: how to open, and that farm work
/// goes through the orchestrator.
pub fn moss_instructions(greeting: &str) -> String {
    let tail = "涉及农场现状、工单、帮工或派活时调用 ask_orchestrator。";
    if greeting.is_empty() {
        tail.to_string()
    } else {
        format!("开场先简短问候：「{greeting}」。{tail}")
    }
}

/// What the MOSS model reads of its one tool.
pub const ASK_ORCHESTRATOR: &str =
    "Consult the farm's orchestrator whenever the user asks about farm status, issues, helpers, memories, notes, or wants work dispatched.";
pub const ASK_ORCHESTRATOR_QUESTION: &str = "The user's exact request or question for the orchestrator.";

/// Dictation-only persona/instructions so MOSS Live streams input transcripts without replying aloud.
pub const ASR_PERSONA: &str = "语音听写助手。";
pub const ASR_INSTRUCTIONS: &str = "仅把用户的语音输入转写为文字，不要说话、不要回复、不要编造内容。";

/// Lightweight post-stop transcript polish prompt: punctuation restoration + filler/repetition cleanup.
pub const ASR_POLISH_SYSTEM: &str = "你是语音听写校对助手。只做轻量文本润色：补充或修正标点符号，去掉口头禅和无实义填充词（如“呃”“啊”“嗯”“那个”“就是说”“um”“uh”等）以及口吃重复，保持原意、人称、术语、代码标识符和语种不变。不要回答问题，不要扩写、总结或改变语气，只输出润色后的纯文本。";

/// What the orchestrator is given to tell the user on the call: everything
/// that waited, as one; a call that answers a ring opens with what rang.
pub fn on_call_line(texts: &[String], ring: Option<&str>) -> String {
    let list = texts.iter().map(|t| format!("- {t}")).collect::<Vec<_>>().join("\n");
    if let Some(ring) = ring {
        let more = if list.is_empty() {
            String::new()
        } else {
            format!("\n这期间又有：\n{list}")
        };
        let how = if texts.is_empty() { "一两句，" } else { "合成一段说，" };
        return format!("用户接起了你打的电话。你打电话是为了这件事：{ring}{more}\n先开口说这些：{how}{SPOKEN}");
    }
    let how = if texts.len() > 1 {
        format!("这 {} 件合成一段说，一件一句，", texts.len())
    } else {
        "一两句，".to_string()
    };
    format!("【要告诉用户】\n{list}\n\n用户正在和你通电话，你的回答会念给用户听：{how}{SPOKEN}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_orchestrator_is_asked_for_one_answer_of_everything_that_waited() {
        let one = on_call_line(&["A 做完了".into()], None);
        assert!(one.starts_with("【要告诉用户】\n- A 做完了\n\n") && one.contains("一两句，口语"), "{one}");
        let two = on_call_line(&["A".into(), "B".into()], None);
        assert!(two.contains("- A\n- B") && two.contains("这 2 件合成一段说"), "{two}");
        let ring = on_call_line(&[], Some("#3 等你验收"));
        assert!(
            ring.starts_with("用户接起了你打的电话。你打电话是为了这件事：#3 等你验收\n先开口说这些：一两句，"),
            "{ring}"
        );
        assert!(on_call_line(&["又一件".into()], Some("x")).contains("\n这期间又有：\n- 又一件\n先开口说这些：合成一段说，"));
        assert_eq!(moss_instructions(""), "涉及农场现状、工单、帮工或派活时调用 ask_orchestrator。");
        assert!(moss_instructions("来啦").starts_with("开场先简短问候：「来啦」。"));
    }
}
