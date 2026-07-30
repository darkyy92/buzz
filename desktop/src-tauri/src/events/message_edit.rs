use buzz_core_pkg::kind::{KIND_STREAM_MESSAGE_EDIT, KIND_STREAM_THREAD_TITLE};
use nostr::{EventBuilder, EventId, Kind};
use uuid::Uuid;

use super::{check_content, emoji_tags, imeta_tags, mention_tags, tag};

const THREAD_TITLE_MARKER: &str = "buzz-thread-title";

/// Kind 40003 — edit message content and its body-coupled metadata.
pub fn build_message_edit(
    channel_id: Uuid,
    target_event_id: EventId,
    content: &str,
    media_tags: &[Vec<String>],
    custom_emoji_tags: &[Vec<String>],
    mentions: &[&str],
) -> Result<EventBuilder, String> {
    check_content(content)?;
    let mut tags = vec![
        tag(vec!["h", &channel_id.to_string()])?,
        tag(vec!["e", &target_event_id.to_hex()])?,
    ];
    tags.extend(mention_tags(mentions)?);
    imeta_tags(media_tags, &mut tags)?;
    emoji_tags(custom_emoji_tags, &mut tags)?;
    Ok(EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE_EDIT as u16), content).tags(tags))
}

/// Kind 40009 metadata-only NIP-14 title edit.
pub fn build_thread_title_edit(
    channel_id: Uuid,
    target_event_id: EventId,
    subject: &str,
) -> Result<EventBuilder, String> {
    if subject.chars().count() > 80 {
        return Err("thread title exceeds maximum length of 80 characters".into());
    }
    let tags = vec![
        tag(vec!["h", &channel_id.to_string()])?,
        tag(vec!["e", &target_event_id.to_hex()])?,
        tag(vec!["subject", subject])?,
        tag(vec!["t", THREAD_TITLE_MARKER])?,
    ];
    Ok(EventBuilder::new(Kind::Custom(KIND_STREAM_THREAD_TITLE as u16), "").tags(tags))
}

#[cfg(test)]
mod tests {
    use buzz_core_pkg::kind::{KIND_STREAM_MESSAGE_EDIT, KIND_STREAM_THREAD_TITLE};
    use nostr::{EventId, Keys, SecretKey};
    use uuid::Uuid;

    use super::{build_thread_title_edit, THREAD_TITLE_MARKER};

    #[test]
    fn thread_title_edit_is_metadata_only() {
        let channel = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let target =
            EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
                .unwrap();
        let builder = build_thread_title_edit(channel, target, "Release notes").unwrap();
        let key =
            SecretKey::from_hex("0000000000000000000000000000000000000000000000000000000000000003")
                .unwrap();
        let event = builder.sign_with_keys(&Keys::new(key)).unwrap();
        let tags: Vec<Vec<String>> = event
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect();
        assert_eq!(
            event.kind,
            nostr::Kind::Custom(KIND_STREAM_THREAD_TITLE as u16)
        );
        assert_ne!(
            event.kind,
            nostr::Kind::Custom(KIND_STREAM_MESSAGE_EDIT as u16)
        );
        assert_eq!(event.content, "");
        assert!(tags.contains(&vec!["subject".into(), "Release notes".into()]));
        assert!(tags.contains(&vec!["t".into(), THREAD_TITLE_MARKER.into()]));
    }

    #[test]
    fn thread_title_edit_rejects_overlong_subject() {
        let channel = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let target =
            EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
                .unwrap();
        assert!(build_thread_title_edit(channel, target, &"x".repeat(81)).is_err());
    }
}
