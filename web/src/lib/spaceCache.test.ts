import { expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { SpaceView } from "./api";
import { resetSpaceAfterIdentityChange } from "./spaceCache";

it("drops member fields before refetching and ignores a late prior-identity response", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["space", "acme", "team"];
  const publicSpace: SpaceView = { slug: "team", name: "Team", protected: true };
  const privateSpace: SpaceView = {
    ...publicSpace, passcode: "SECRET", members: [], sessions: [],
    visibility: "private", kinds: ["poker"], kindOptions: [], orgSlug: "acme",
  };
  queryClient.setQueryData(key, privateSpace);
  let finishOld: (data: SpaceView) => void = () => {};
  let finishNew: (data: SpaceView) => void = () => {};
  let reads = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: () => new Promise<SpaceView>((resolve) => {
      if (++reads === 1) finishOld = resolve;
      else finishNew = resolve;
    }),
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    resetSpaceAfterIdentityChange(queryClient, "acme", "team");
    expect(queryClient.getQueryData(key)).toEqual(publicSpace);
    finishOld(privateSpace);
    await Promise.resolve();
    await Promise.resolve();
    expect(queryClient.getQueryData(key)).toEqual(publicSpace);
    finishNew(publicSpace);
    await queryClient.refetchQueries({ queryKey: key }, { cancelRefetch: false });
    expect(queryClient.getQueryData(key)).toEqual(publicSpace);
  } finally {
    unsubscribe();
    queryClient.clear();
  }
});

it("does not create cached data when the space is absent", () => {
  const queryClient = new QueryClient();
  resetSpaceAfterIdentityChange(queryClient, "acme", "team");
  expect(queryClient.getQueryData(["space", "acme", "team"])).toBeUndefined();
  queryClient.clear();
});
