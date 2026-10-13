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

const TEXT_ENTRY_TAGS = new Set(["TEXTAREA", "SELECT"]);
const INPUT_TYPES_WITHOUT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

function isTextEntry(target: unknown): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[contenteditable]:not([contenteditable='false'])")) return true;
  if (TEXT_ENTRY_TAGS.has(target.tagName)) return true;
  return target.tagName === "INPUT" && !INPUT_TYPES_WITHOUT_TEXT.has((target as HTMLInputElement).type);
}

export function swallowHeldActivation(event: {
  key: string;
  repeat: boolean;
  target: unknown;
  preventDefault: () => void;
  stopPropagation: () => void;
}): void {
  if (!event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
  if (isTextEntry(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}
