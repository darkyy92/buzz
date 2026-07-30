use nostr::{EventBuilder, EventId, Kind};
use uuid::Uuid;

use super::{check_content, emoji_tags, imeta_tags, mention_tags, tag};

const THREAD_TITLE_MARKER: &str = "buzz-thread-title";

/// Kind 40003 — edit mutable message metadata and an optional NIP-14 title.
pub fn build_message_edit(
    channel_id: Uuid,
    target_event_id: EventId,
    content: &str,
    media_tags: &[Vec<String>],
    custom_emoji_tags: &[Vec<String>],
    mentions: &[&str],
    subject: Option<&str>,
) -> Result<EventBuilder, String> {
    check_content(content)?;
    if subject.is_some_and(|value| value.chars().count() > 80) {
        return Err("thread title exceeds maximum length of 80 characters".into());
    }
    let mut tags = vec![
        tag(vec!["h", &channel_id.to_string()])?,
        tag(vec!["e", &target_event_id.to_hex()])?,
    ];
    tags.extend(mention_tags(mentions)?);
    imeta_tags(media_tags, &mut tags)?;
    emoji_tags(custom_emoji_tags, &mut tags)?;
    if let Some(subject) = subject {
        tags.push(tag(vec!["subject", subject])?);
        tags.push(tag(vec!["t", THREAD_TITLE_MARKER])?);
    }
    Ok(EventBuilder::new(Kind::Custom(40003), content).tags(tags))
}

#[cfg(test)]
mod tests {
    use nostr::{EventId, Keys, SecretKey};
    use uuid::Uuid;

    use super::{build_message_edit, THREAD_TITLE_MARKER};

    #[test]
    fn emits_nip14_subject_and_query_marker() {
        let channel = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let target =
            EventId::from_hex("d24da132115ca0a46233cf4c2ad8338fbf914250cbcaa9181a6dd59533cb5ac1")
                .unwrap();
        let builder = build_message_edit(
            channel,
            target,
            "unchanged body",
            &[],
            &[],
            &[],
            Some("Release notes"),
        )
        .unwrap();
        let key = SecretKey::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000003",
        )
        .unwrap();
        let event = builder.sign_with_keys(&Keys::new(key)).unwrap();
        let tags: Vec<Vec<String>> =
            event.tags.iter().map(|tag| tag.as_slice().to_vec()).collect();
        assert!(tags.contains(&vec!["subject".into(), "Release notes".into()]));
        assert!(tags.contains(&vec!["t".into(), THREAD_TITLE_MARKER.into()]));
    }
}
