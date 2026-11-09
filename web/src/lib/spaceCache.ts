import type { QueryClient } from "@tanstack/react-query";
import type { SpaceView } from "./api";

/** A reminted identity must not retain the previous member’s private space fields. */
export function resetSpaceAfterIdentityChange(queryClient: QueryClient, org: string, slug: string): void {
  queryClient.setQueryData<SpaceView>(["space", org, slug], (previous) =>
    previous ? { slug: previous.slug, name: previous.name, protected: previous.protected } : previous,
  );
  void queryClient.invalidateQueries({ queryKey: ["space", org, slug] });
}
