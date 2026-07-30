import { invokeTauri } from "@/shared/api/tauri";

export async function editMessage(
  channelId: string,
  eventId: string,
  content: string,
  mediaTags?: string[][],
  emojiTags?: string[][],
  mentionPubkeys?: string[],
): Promise<void> {
  await invokeTauri("edit_message", {
    channelId,
    eventId,
    content,
    mediaTags: mediaTags ?? [],
    emojiTags: emojiTags ?? [],
    mentionPubkeys: mentionPubkeys ?? null,
  });
}

/** Publish a metadata-only NIP-14 title edit. Empty title clears it. */
export async function setThreadTitle(
  channelId: string,
  eventId: string,
  subject: string,
): Promise<void> {
  await invokeTauri("set_thread_title", { channelId, eventId, subject });
}
