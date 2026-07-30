const HEX_EVENT_ID = /^[0-9a-f]{64}$/i;

/**
 * Resolve the single canonical target of a message mutation.
 *
 * Relay authorization uses the same contract: exactly one `e` tag containing
 * a 32-byte hexadecimal event id. Ambiguous mutations fail closed.
 */
export function getSingleMessageMutationTargetId(
  tags: string[][],
): string | null {
  const eventTags = tags.filter((tag) => tag[0] === "e");
  if (eventTags.length !== 1) return null;
  const targetId = eventTags[0]?.[1];
  return typeof targetId === "string" && HEX_EVENT_ID.test(targetId)
    ? targetId
    : null;
}
