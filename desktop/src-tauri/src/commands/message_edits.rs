use nostr::EventId;
use tauri::State;

use crate::{
    app_state::AppState,
    events,
    relay::submit_event,
};

#[tauri::command]
pub async fn edit_message(
    channel_id: String,
    event_id: String,
    content: String,
    media_tags: Vec<Vec<String>>,
    emoji_tags: Option<Vec<Vec<String>>>,
    // Only newly added mentions get a `p` tag, avoiding repeat wake-ups.
    mention_pubkeys: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let channel_uuid = uuid::Uuid::parse_str(&channel_id)
        .map_err(|_| format!("invalid channel UUID: {channel_id}"))?;
    let target_eid = EventId::from_hex(&event_id).map_err(|e| format!("invalid event ID: {e}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() && media_tags.is_empty() {
        return Err("edit must have content or attachments".into());
    }
    let emoji = emoji_tags.unwrap_or_default();
    let mentions = mention_pubkeys.unwrap_or_default();
    let mention_refs: Vec<&str> = mentions.iter().map(|value| value.as_str()).collect();
    let builder = events::build_message_edit(
        channel_uuid,
        target_eid,
        trimmed,
        &media_tags,
        &emoji,
        &mention_refs,
    )?;
    submit_event(builder, &state).await?;
    Ok(())
}

#[tauri::command]
pub async fn set_thread_title(
    channel_id: String,
    event_id: String,
    subject: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let channel_uuid = uuid::Uuid::parse_str(&channel_id)
        .map_err(|_| format!("invalid channel UUID: {channel_id}"))?;
    let target_eid = EventId::from_hex(&event_id).map_err(|e| format!("invalid event ID: {e}"))?;
    let subject = subject.trim();
    let builder = events::build_thread_title_edit(channel_uuid, target_eid, subject)?;
    submit_event(builder, &state).await?;
    Ok(())
}
