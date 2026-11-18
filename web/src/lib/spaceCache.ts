import type { QueryClient } from "@tanstack/react-query";
import type { SpaceView } from "./api";

// Remove member-only fields before refetching under the new identity.
export function scrubSpaceAfterRemint(queryClient: QueryClient, org: string, slug: string): void {
  const queryKey = ["space", org, slug];
  queryClient.setQueryData<SpaceView>(queryKey, (prev) =>
    prev ? { slug: prev.slug, name: prev.name, protected: prev.protected } : prev,
  );
  void queryClient.invalidateQueries({ queryKey });
}
