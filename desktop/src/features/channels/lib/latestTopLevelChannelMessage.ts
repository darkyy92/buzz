import type { RelayEvent } from "@/shared/api/types";

import { isTimelineContentEvent } from "@/features/messages/lib/formatTimelineMessages";
import { getThreadReference } from "@/features/messages/lib/threading";

export function latestTopLevelChannelMessage(
  events: RelayEvent[],
): RelayEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      isTimelineContentEvent(event) &&
      getThreadReference(event.tags).parentId === null
    ) {
      return event;
    }
  }
  return null;
}
