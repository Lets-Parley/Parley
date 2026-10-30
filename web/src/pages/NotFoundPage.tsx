import { useEffect } from "react";
import { DeadEnd } from "../components/DeadEnd";

/** The catch-all route, and what a dead /s/{slug} link lands on. */
export function NotFoundPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found";
    return () => {
      document.title = previous;
    };
  }, []);
  return <DeadEnd title="Page not found" why="Check the address or return to your spaces." />;
}
