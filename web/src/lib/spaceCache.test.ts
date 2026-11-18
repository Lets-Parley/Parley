import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import type { SpaceView } from "./api";
import { scrubSpaceAfterRemint } from "./spaceCache";

it("scrubs a member response that settles while cleanup starts", async () => {
  const queryClient = new QueryClient();
  const publicSpace: SpaceView = { slug: "platform-team", name: "Platform Team", protected: true };
  let resolveResponse!: (view: SpaceView) => void;
  const response = new Promise<SpaceView>((resolve) => {
    resolveResponse = resolve;
  });
  const queryKey = ["space", "acme", "platform-team"];
  const lookup = queryClient.fetchQuery({ queryKey, queryFn: () => response });

  resolveResponse({ ...publicSpace, passcode: "TEAM49" });
  // Let the retryer resolve before the query publishes the response.
  await Promise.resolve().then(() => scrubSpaceAfterRemint(queryClient, "acme", "platform-team"));
  await lookup;

  expect(queryClient.getQueryData(queryKey)).toEqual(publicSpace);
});
