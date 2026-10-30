import { DeadEnd } from "../components/DeadEnd";

/** The catch-all route, and what a dead /s/{slug} link lands on. */
export function NotFoundPage() {
  return <DeadEnd title="Page not found" why="Check the address or return to your spaces." />;
}
