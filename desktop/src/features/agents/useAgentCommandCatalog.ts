import * as React from "react";

import {
  getAgentCommandCatalog,
  subscribeAgentCommandCatalog,
} from "./agentCommandCatalog";

export function useAgentCommandCatalog(
  ownerPubkey: string | null,
  relayUrl: string | null,
) {
  return React.useSyncExternalStore(
    subscribeAgentCommandCatalog,
    () => getAgentCommandCatalog(ownerPubkey, relayUrl),
    () => getAgentCommandCatalog(null, null),
  );
}
