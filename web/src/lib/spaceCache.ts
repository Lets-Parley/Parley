import type { QueryClient } from "@tanstack/react-query";
import type { SpaceView } from "./api";

// Remove member-only fields before refetching under the new identity.
export async function scrubSpaceAfterRemint(queryClient: QueryClient, org: string, slug: string): Promise<void> {
  const queryKey = ["space", org, slug];
  // An already-settled response can still be waiting to update the cache.
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<SpaceView>(queryKey, (prev) =>
    prev ? { slug: prev.slug, name: prev.name, protected: prev.protected } : prev,
  );
  void queryClient.invalidateQueries({ queryKey });
}
