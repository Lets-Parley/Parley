const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "checkbox", "radio", "switch", "tab", "option"]);

export function isNeutralFocusTarget(element: Element): boolean {
  if (element.hasAttribute("data-neutral-control")) return true;
  if (INTERACTIVE_TAGS.has(element.tagName)) return false;
  if (INTERACTIVE_ROLES.has(element.getAttribute("role") ?? "")) return false;
  return !(element instanceof HTMLElement && element.isContentEditable);
}

export function focusNeutral(candidates: (HTMLElement | null | undefined)[]): HTMLElement | null {
  const landing = candidates.find(
    (candidate): candidate is HTMLElement => Boolean(candidate?.isConnected) && isNeutralFocusTarget(candidate as HTMLElement),
  );
  if (!landing) return null;
  landing.focus({ preventScroll: true });
  return landing;
}

export function preventsKeyRepeat(event: { key: string; repeat: boolean; preventDefault: () => void }): void {
  if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
}
