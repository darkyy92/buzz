import { normalizeThreadTitle } from "@/features/threads/namedThreads";

export type SetThreadTitleInput = {
  channelId: string;
  rootId: string;
  title: string;
};

export async function persistThreadTitle(
  input: SetThreadTitleInput,
  deps: {
    persist: (
      channelId: string,
      rootId: string,
      title: string,
    ) => Promise<void>;
    refresh: () => Promise<unknown>;
  },
): Promise<string> {
  const title = normalizeThreadTitle(input.title);
  await deps.persist(input.channelId, input.rootId, title);
  await deps.refresh();
  return title;
}
