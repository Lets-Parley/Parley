import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const EASE_SETTLE = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_TRAVEL = "cubic-bezier(0.4, 0, 0.2, 1)";
const RISE_MS = 280;
const SET_MS = 260;
const DRAW_ON_MS = 460;
const PULSE_MS = 620;
const TRACKING_MS = 720;
const FLIP_ID = "fan-reflow";
const ORIGIN_SPREAD = 0.2;
const SAME_ROW_TOLERANCE = 24;
const ARROW_STEM = 18;
const GHOST_PREFIX = "ghost:";

export type LayoutBox = { left: number; top: number; width: number; height: number };
export type SpringTuning = { stiffness: number; damping: number };

const DEAL_SPRING: SpringTuning = { stiffness: 230, damping: 19 };
const REFLOW_SPRING: SpringTuning = { stiffness: 320, damping: 32 };
const MARKER_SPRING: SpringTuning = { stiffness: 250, damping: 21 };
const STAMP_SPRING: SpringTuning = { stiffness: 520, damping: 20 };
const SPRING_FRAME_MS = 1000 / 60;
const SPRING_MAX_FRAMES = 84;
const SPRING_SUBSTEPS = 4;

const sampledSprings = new Map<string, number[]>();

export function springSamples(tuning: SpringTuning): number[] {
  const cacheKey = `${tuning.stiffness}/${tuning.damping}`;
  const cached = sampledSprings.get(cacheKey);
  if (cached) return cached;
  const samples = [0];
  const stepSeconds = SPRING_FRAME_MS / 1000 / SPRING_SUBSTEPS;
  let position = 0;
  let velocity = 0;
  for (let frame = 1; frame <= SPRING_MAX_FRAMES; frame += 1) {
    for (let substep = 0; substep < SPRING_SUBSTEPS; substep += 1) {
      velocity += (tuning.stiffness * (1 - position) - tuning.damping * velocity) * stepSeconds;
      position += velocity * stepSeconds;
    }
    if (Math.abs(1 - position) < 0.002 && Math.abs(velocity) < 0.03) break;
    samples.push(position);
  }
  samples.push(1);
  sampledSprings.set(cacheKey, samples);
  return samples;
}

function animateSpring(
  element: Element,
  tuning: SpringTuning,
  keyframeAt: (progress: number, frameIndex: number) => Keyframe,
  delayMs = 0,
): Animation {
  const samples = springSamples(tuning);
  return element.animate(samples.map(keyframeAt), {
    duration: (samples.length - 1) * SPRING_FRAME_MS,
    delay: delayMs,
    easing: "linear",
  });
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function canAnimate(element: Element): boolean {
  return typeof element.animate === "function";
}

function layoutBoxOf(element: HTMLElement, scope: HTMLElement): LayoutBox {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = element;
  while (node && node !== scope) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return { left, top, width: element.offsetWidth, height: element.offsetHeight };
}

function translationInFlight(element: HTMLElement): { x: number; y: number } {
  const isReflowing = element.getAnimations().some((animation) => animation.id === FLIP_ID);
  if (!isReflowing) return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  return { x: matrix.m41, y: matrix.m42 };
}

function plateOf(element: HTMLElement): HTMLElement | null {
  return element.querySelector<HTMLElement>(":scope > [data-fan-plate]");
}

function isInStackedRow(element: HTMLElement): boolean {
  const row = element.parentElement;
  return Boolean(row && getComputedStyle(row).flexDirection === "column");
}

function playEntrance(element: HTMLElement, box: LayoutBox, origin: LayoutBox | null) {
  const entrance = element.dataset.fanEnter;
  if (entrance === "deal" && origin && isInStackedRow(element)) {
    animateSpring(element, DEAL_SPRING, (progress, frameIndex) => ({
      transform: `translateX(${-22 * (1 - progress)}px)`,
      opacity: Math.min(1, frameIndex / 4),
    }));
  } else if (entrance === "deal" && origin) {
    const offsetX = origin.left + origin.width / 2 - (box.left + box.width / 2);
    const offsetY = origin.top + origin.height - (box.top + box.height / 2);
    const tilt = Math.abs(offsetX) < 8 ? -3 : Math.sign(offsetX) * -Math.min(9, 3 + Math.abs(offsetX) / 60);
    const flight = animateSpring(element, DEAL_SPRING, (progress, frameIndex) => {
      const remaining = 1 - progress;
      return {
        transform: `translate(${offsetX * remaining}px, ${offsetY * remaining}px) rotate(${tilt * remaining}deg) scale(${0.3 + 0.7 * progress})`,
        opacity: Math.min(1, frameIndex / 3),
      };
    });
    const plate = plateOf(element);
    const flightMs = flight.effect?.getComputedTiming().duration;
    if (plate && typeof flightMs === "number" && !element.matches(".is-ghost")) {
      plate.animate([{ boxShadow: "var(--shadow-lift)" }, {}], { duration: flightMs, easing: EASE_SETTLE });
    }
  } else if (entrance === "rise") {
    element.animate(
      [
        { transform: "translateY(14px)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: RISE_MS, easing: EASE_SETTLE },
    );
  } else if (entrance === "fade") {
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RISE_MS, easing: EASE_SETTLE });
  }
}

function playInkSetting(element: HTMLElement) {
  const plate = plateOf(element);
  if (plate) {
    plate.animate([{ backgroundColor: "transparent", boxShadow: "0 0 0 rgb(0 0 0 / 0)" }, {}], {
      duration: SET_MS,
      easing: EASE_SETTLE,
    });
  }
  animateSpring(element, DEAL_SPRING, (progress) => ({ scale: String(1.045 - 0.045 * progress) }));
  for (const control of element.querySelectorAll(".fan-actions, .fan-corner, .fan-grip")) {
    control.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SET_MS, easing: EASE_SETTLE });
  }
}

export function inheritedBox(
  element: HTMLElement,
  before: Map<string, LayoutBox>,
  presentKeys: Set<string>,
  claimedKeys: Set<string>,
): LayoutBox | undefined {
  const heirOf = element.dataset.fanHeir;
  if (heirOf && before.has(heirOf) && !presentKeys.has(heirOf) && !claimedKeys.has(heirOf)) {
    claimedKeys.add(heirOf);
    return before.get(heirOf);
  }
  if (element.dataset.fanGhost === undefined) return undefined;
  for (const [key, box] of before) {
    if (key.startsWith(GHOST_PREFIX) && !presentKeys.has(key) && !claimedKeys.has(key)) return box;
  }
  return undefined;
}

function reflow(scope: HTMLElement, before: Map<string, LayoutBox>, shouldAnimate: boolean): Map<string, LayoutBox> {
  const after = new Map<string, LayoutBox>();
  const shifts = new Map<HTMLElement, { x: number; y: number }>();
  const originElement = scope.querySelector<HTMLElement>("[data-fan-origin]");
  const origin = originElement ? layoutBoxOf(originElement, scope) : null;
  const elements = [...scope.querySelectorAll<HTMLElement>("[data-fan-item]")];
  const presentKeys = new Set(elements.map((element) => element.dataset.fanItem ?? ""));
  const claimedKeys = new Set<string>();
  for (const element of elements) {
    const key = element.dataset.fanItem ?? "";
    const box = layoutBoxOf(element, scope);
    after.set(key, box);
    if (!shouldAnimate || !canAnimate(element)) continue;
    const ownBox = before.get(key);
    const previous = ownBox ?? inheritedBox(element, before, presentKeys, claimedKeys);
    if (!previous) {
      if (!element.closest("[data-fan-quiet]")) playEntrance(element, box, origin);
      continue;
    }
    const isSetFromGhost = !ownBox && element.dataset.fanGhost === undefined;
    if (isSetFromGhost) playInkSetting(element);
    const carrier = element.parentElement?.closest<HTMLElement>("[data-fan-item]");
    const carried = (carrier && shifts.get(carrier)) || { x: 0, y: 0 };
    const drift = translationInFlight(element);
    const layoutShift = { x: previous.left - box.left, y: previous.top - box.top };
    shifts.set(element, layoutShift);
    const shiftX = layoutShift.x - carried.x + drift.x;
    const shiftY = layoutShift.y - carried.y + drift.y;
    const tuning = element.dataset.fanItem === "table-marker" ? MARKER_SPRING : REFLOW_SPRING;
    if (Math.abs(shiftX) > 1 || Math.abs(shiftY) > 1) {
      element.getAnimations().forEach((animation) => {
        if (animation.id === FLIP_ID) animation.cancel();
      });
      const animation = animateSpring(element, tuning, (progress) => ({
        transform: `translate(${shiftX * (1 - progress)}px, ${shiftY * (1 - progress)}px)`,
      }));
      animation.id = FLIP_ID;
    }
    const plate = plateOf(element);
    const isResized = Math.abs(previous.width - box.width) > 1 || Math.abs(previous.height - box.height) > 1;
    if (plate && isResized && box.width > 0 && box.height > 0) {
      const widthRatio = previous.width / box.width;
      const heightRatio = previous.height / box.height;
      animateSpring(plate, REFLOW_SPRING, (progress) => ({
        transform: `scale(${widthRatio + (1 - widthRatio) * progress}, ${heightRatio + (1 - heightRatio) * progress})`,
      }));
    }
  }
  return after;
}

export function useFanReflow(scopeRef: RefObject<HTMLElement | null>, isMotionHeld: () => boolean): () => void {
  const boxes = useRef(new Map<string, LayoutBox>());
  const hasSettled = useRef(false);
  const measuredWidth = useRef(0);
  const holdCheck = useRef(isMotionHeld);
  const hasRunThisCommit = useRef(false);
  const run = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope || hasRunThisCommit.current) return;
    hasRunThisCommit.current = true;
    queueMicrotask(() => {
      hasRunThisCommit.current = false;
    });
    const shouldAnimate = hasSettled.current && !holdCheck.current() && !prefersReducedMotion();
    boxes.current = reflow(scope, boxes.current, shouldAnimate);
    measuredWidth.current = scope.offsetWidth;
    hasSettled.current = true;
  }, [scopeRef]);
  useLayoutEffect(() => {
    holdCheck.current = isMotionHeld;
    run();
  });
  useEffect(() => {
    const scope = scopeRef.current;
    if (!scope || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (scope.offsetWidth === measuredWidth.current) return;
      measuredWidth.current = scope.offsetWidth;
      boxes.current = reflow(scope, boxes.current, false);
    });
    observer.observe(scope);
    return () => observer.disconnect();
  }, [scopeRef]);
  return run;
}

function millisecondsNow(): number {
  return performance.now();
}

export function useMotionHold(shouldHold: boolean, holdMs: number): () => boolean {
  const heldUntil = useRef(0);
  useEffect(() => {
    if (shouldHold) heldUntil.current = millisecondsNow() + holdMs;
  }, [shouldHold, holdMs]);
  return useCallback(() => millisecondsNow() < heldUntil.current, []);
}

export function playEstimateStamp(slot: HTMLElement | null) {
  if (!slot || !canAnimate(slot) || prefersReducedMotion()) {
    if (slot && canAnimate(slot)) slot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "linear" });
    return;
  }
  const fallFrames = 7;
  const fallMs = fallFrames * SPRING_FRAME_MS;
  const fall: Keyframe[] = Array.from({ length: fallFrames }, (_, frameIndex) => {
    const descent = (frameIndex / fallFrames) ** 2;
    return {
      transform: `rotate(${-13 + 11 * descent}deg) scale(${2.3 - 1.42 * descent})`,
      opacity: Math.min(1, 0.15 + descent * 1.6),
    };
  });
  const rebound: Keyframe[] = springSamples(STAMP_SPRING).map((progress) => ({
    transform: `rotate(-2deg) scale(${0.88 + 0.12 * progress})`,
    opacity: 1,
  }));
  slot.animate([...fall, ...rebound], {
    duration: (fall.length + rebound.length - 1) * SPRING_FRAME_MS,
    easing: "linear",
  });
  slot.animate(
    [
      { boxShadow: "var(--shadow-rest), 0 0 0 0 color-mix(in srgb, var(--color-settled) 55%, transparent)" },
      { boxShadow: "var(--shadow-rest), 0 0 0 15px color-mix(in srgb, var(--color-settled) 0%, transparent)" },
    ],
    { duration: 560, delay: fallMs, easing: EASE_SETTLE },
  );
  const card = slot.closest<HTMLElement>(".fan-card");
  if (card) {
    animateSpring(card, STAMP_SPRING, (progress) => ({ translate: `0 ${3 * (1 - progress)}px` }), fallMs);
  }
  const caption = slot.nextElementSibling;
  if (caption && canAnimate(caption)) {
    caption.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RISE_MS, delay: fallMs, easing: EASE_SETTLE, fill: "backwards" });
  }
}

export function playArrival(element: Element | null) {
  if (!element || !canAnimate(element) || prefersReducedMotion()) return;
  animateSpring(element, DEAL_SPRING, (progress, frameIndex) => ({
    scale: String(0.82 + 0.18 * progress),
    opacity: Math.min(1, frameIndex / 3),
  }));
}

export type WireCard = { id: string; element: HTMLElement; isDashed: boolean; isLive: boolean };
export type WireLink = { id: string; blockerId: string; dependentId: string; isUnsettled: boolean };
export type WirePlan = {
  origin: HTMLElement | null;
  cards: WireCard[];
  links: WireLink[];
  hasGrips: boolean;
  arrowId: string;
};
export type DragLine = {
  fromId: string;
  clientX: number;
  clientY: number;
  snapToId: string | null;
  isRefused: boolean;
};
export type WireTrace = { cardId: string; edgeId: string | null };

type Point = { x: number; y: number };
type Anchor = { centerX: number; top: number; bottom: number; width: number };
type Sway = {
  offsetX: number;
  offsetY: number;
  velocityX: number;
  velocityY: number;
  lastCenterX: number;
  lastTop: number;
};
type ThreadEnd = Point & { stem: number; velocityX: number; velocityY: number; velocityStem: number };
type PendingLink = { blockerId: string; dependentId: string; expiresAt: number };

const SWAY_STIFFNESS = 150;
const SWAY_DAMPING = 11;
const SWAY_LAG = 0.5;
const SWAY_LIMIT = 46;
const SWAY_REST = 0.15;
const THREAD_STIFFNESS = 560;
const THREAD_DAMPING = 40;
const PENDING_LINK_MS = 2500;
const PENDING_GRACE_MS = 400;
const MAX_FRAME_SECONDS = 1 / 30;

function visibleBoxOf(element: HTMLElement): DOMRect {
  return (plateOf(element) ?? element).getBoundingClientRect();
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

export function coveredHeight(content: { bottom: number }, cover: { top: number }): number {
  return Math.max(0, content.bottom - cover.top);
}

export const TRAY_CLEARANCE_PX = 12;
export const TRAY_SETTLE_MS = 320;

type VerticalSpan = { top: number; bottom: number };

export function permittedScroll(wanted: number, keptInView: VerticalSpan[], area: VerticalSpan): number {
  let distance = wanted;
  for (const kept of keptInView) {
    if (distance > 0) distance = Math.min(distance, Math.max(0, kept.top - area.top - TRAY_CLEARANCE_PX));
    else if (distance < 0 && kept.top >= area.top && kept.bottom <= area.bottom) {
      distance = Math.max(distance, -Math.max(0, area.bottom - kept.bottom - TRAY_CLEARANCE_PX));
    }
  }
  return distance;
}

export function trayFreeArea(): VerticalSpan {
  const tray = document.querySelector("[data-poker-hand]");
  if (!tray) return { top: 0, bottom: window.innerHeight };
  const trayBox = tray.getBoundingClientRect();
  if (trayBox.top >= 0 && trayBox.top <= window.innerHeight) return { top: 0, bottom: trayBox.top };
  const position = getComputedStyle(tray).position;
  const isHeldToViewport = position === "fixed" || position === "sticky";
  return { top: 0, bottom: window.innerHeight - (isHeldToViewport ? trayBox.height : 0) };
}

export function roundScroll(area: VerticalSpan, target: VerticalSpan, roundTop: VerticalSpan | null): number {
  let wanted = roundTop && roundTop.top < area.top ? roundTop.top - area.top - TRAY_CLEARANCE_PX : 0;
  if (target.bottom - wanted > area.bottom) wanted = target.bottom - area.bottom + TRAY_CLEARANCE_PX;
  if (target.top - wanted < area.top) wanted = target.top - area.top - TRAY_CLEARANCE_PX;
  return wanted;
}

export function primaryRoundControl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-round-verdict] button");
}

function isPageHeldStill(): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return false;
  const isTextField =
    focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.tagName === "SELECT" || focused.isContentEditable;
  return isTextField || Boolean(focused.closest("dialog[open], [role='dialog']"));
}

export function scrollRoundBy(
  wanted: number,
  alsoKeptInView: (Element | null | undefined)[] = [],
  isFocusKeptInView = true,
): void {
  if (wanted === 0 || isPageHeldStill()) return;
  const focused = isFocusKeptInView ? document.activeElement : null;
  const kept = [primaryRoundControl(), focused && focused !== document.body ? focused : null, ...alsoKeptInView]
    .filter((element): element is Element => Boolean(element))
    .map((element) => element.getBoundingClientRect());
  const distance = permittedScroll(wanted, kept, trayFreeArea());
  if (Math.abs(distance) >= 1) window.scrollBy({ top: distance });
}

export function bringRoundIntoView(roundTop: Element | null, region: Element | null = null): void {
  const anchor = primaryRoundControl() ?? region;
  if (!anchor) return;
  const area = trayFreeArea();
  const regionBox = region?.getBoundingClientRect();
  const doesRegionFit = Boolean(regionBox && regionBox.bottom - regionBox.top <= area.bottom - area.top);
  const target = doesRegionFit && regionBox ? regionBox : anchor.getBoundingClientRect();
  scrollRoundBy(roundScroll(area, target, roundTop?.getBoundingClientRect() ?? null), [], false);
}

export function scrollClearOfTray(content: Element | null): void {
  if (!content) return;
  const shown = content.getBoundingClientRect();
  const area = trayFreeArea();
  const hidden = Math.max(0, shown.bottom - area.bottom);
  const doesFit = shown.bottom - shown.top <= area.bottom - area.top;
  const roomAbove = Math.max(0, shown.top - area.top - TRAY_CLEARANCE_PX);
  if (hidden > 0) scrollRoundBy(doesFit ? Math.min(hidden + TRAY_CLEARANCE_PX, roomAbove) : hidden + TRAY_CLEARANCE_PX);
  else if (shown.top < area.top) scrollRoundBy(shown.top - area.top - TRAY_CLEARANCE_PX);
}

export function useClearOfTray(isShown: boolean, content: RefObject<Element | null>): void {
  useEffect(() => {
    if (!isShown) return;
    const timer = window.setTimeout(() => scrollClearOfTray(content.current), TRAY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [isShown, content]);
}

export function isBelowAnotherCard(
  card: { top: number },
  others: Iterable<{ bottom: number }>,
): boolean {
  for (const other of others) if (other.bottom <= card.top) return true;
  return false;
}

export function tetherPath(
  originX: number,
  originY: number,
  cardX: number,
  cardTop: number,
  swayX = 0,
  swayY = 0,
): string {
  const middle = (originY + cardTop) / 2 + swayY;
  return `M${originX},${originY} C${originX + swayX * 0.35},${middle} ${cardX + swayX},${middle} ${cardX},${cardTop}`;
}

export function threadPath(start: Point, end: Point, stem: number): string {
  const stemY = end.y + stem;
  const dip = Math.max(start.y, stemY) + 22 + Math.min(26, Math.abs(end.x - start.x) * 0.08);
  return `M${start.x},${start.y} C${start.x},${dip} ${end.x},${dip} ${end.x},${stemY} L${end.x},${end.y}`;
}

export function arrowLanding(
  blocker: { centerX: number },
  dependent: { centerX: number; bottom: number; width: number },
  slot: number,
  slotCount: number,
): Point {
  const towardBlocker = blocker.centerX < dependent.centerX ? -1 : 1;
  return {
    x: dependent.centerX + towardBlocker * dependent.width * 0.28 + (slot - (slotCount - 1) / 2) * 12,
    y: dependent.bottom + 2,
  };
}

export function crossRowPath(start: Point, end: Point, stem: number): string {
  const stemY = end.y + stem;
  const bend = (start.y + stemY) / 2;
  return `M${start.x},${start.y} C${start.x},${bend} ${end.x},${bend} ${end.x},${stemY} L${end.x},${end.y}`;
}

export function dependencyPath(
  blocker: { centerX: number; top: number; bottom: number; width: number },
  dependent: { centerX: number; top: number; bottom: number; width: number },
  slot: number,
  slotCount: number,
  startDrop: number,
): string {
  const landing = arrowLanding(blocker, dependent, slot, slotCount);
  if (Math.abs(blocker.bottom - dependent.bottom) <= SAME_ROW_TOLERANCE) {
    return threadPath({ x: blocker.centerX, y: blocker.bottom + startDrop }, landing, ARROW_STEM);
  }
  if (blocker.bottom < dependent.bottom) {
    return crossRowPath(
      { x: blocker.centerX, y: blocker.bottom + startDrop },
      { x: landing.x, y: dependent.top - 2 },
      -ARROW_STEM,
    );
  }
  const towardDependent = dependent.centerX < blocker.centerX ? -1 : 1;
  return crossRowPath(
    { x: blocker.centerX + towardDependent * blocker.width * 0.28, y: blocker.top - startDrop },
    landing,
    ARROW_STEM,
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

export class FanWires {
  private readonly paths = new Map<string, SVGPathElement>();
  private readonly pulses = new Map<string, SVGPathElement>();
  private readonly sways = new Map<string, Sway>();
  private readonly announcedLinks = new Set<string>();
  private readonly queuedPulses = new Set<string>();
  private readonly drawingOn = new Set<string>();
  private frame = 0;
  private trackUntil = 0;
  private lastDrawAt = 0;
  private isLively = false;
  private plan: WirePlan | null = null;
  private trace: WireTrace | null = null;
  private dragLine: DragLine | null = null;
  private threadEnd: ThreadEnd | null = null;
  private isRecoiling = false;
  private pendingLink: PendingLink | null = null;
  private readonly layer: SVGSVGElement;
  private readonly frontLayer: SVGSVGElement;
  private readonly isStacked: () => boolean;

  constructor(layer: SVGSVGElement, frontLayer: SVGSVGElement, isStacked: () => boolean) {
    this.layer = layer;
    this.frontLayer = frontLayer;
    this.isStacked = isStacked;
  }

  setPlan(plan: WirePlan) {
    this.plan = plan;
    this.track();
  }

  setTrace(trace: WireTrace | null) {
    if (trace?.cardId === this.trace?.cardId && trace?.edgeId === this.trace?.edgeId) return;
    this.trace = trace;
    this.draw();
  }

  announceLink(linkId: string) {
    this.announcedLinks.add(linkId);
  }

  pulseTether(cardId: string) {
    this.queuedPulses.add(`tether:${cardId}`);
  }

  setDragLine(dragLine: DragLine) {
    this.dragLine = dragLine;
    this.isRecoiling = false;
    this.track(0);
  }

  releaseDrag(outcome: "linked" | "dropped") {
    const released = this.dragLine;
    if (!released) return;
    if (outcome === "linked" && released.snapToId) {
      this.pendingLink = {
        blockerId: released.fromId,
        dependentId: released.snapToId,
        expiresAt: performance.now() + PENDING_LINK_MS,
      };
      this.dragLine = null;
      this.threadEnd = null;
    } else if (prefersReducedMotion()) {
      this.dragLine = null;
      this.threadEnd = null;
    } else {
      this.isRecoiling = true;
    }
    this.track(0);
  }

  settlePendingLink() {
    if (!this.pendingLink) return;
    this.pendingLink.expiresAt = Math.min(this.pendingLink.expiresAt, performance.now() + PENDING_GRACE_MS);
    this.track(PENDING_GRACE_MS + 50);
  }

  track(durationMs = TRACKING_MS) {
    this.draw();
    if (typeof requestAnimationFrame !== "function") return;
    this.trackUntil = Math.max(this.trackUntil, performance.now() + durationMs);
    if (this.frame) return;
    const step = () => {
      this.draw();
      this.frame = performance.now() < this.trackUntil || this.isLively ? requestAnimationFrame(step) : 0;
    };
    this.frame = requestAnimationFrame(step);
  }

  dispose() {
    if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.paths.forEach((path) => path.remove());
    this.paths.clear();
    this.pulses.forEach((pulse) => pulse.remove());
    this.pulses.clear();
  }

  private swayOf(cardId: string, anchor: Anchor, elapsedSeconds: number, canSway: boolean): Sway {
    let sway = this.sways.get(cardId);
    if (!sway) {
      sway = { offsetX: 0, offsetY: 0, velocityX: 0, velocityY: 0, lastCenterX: anchor.centerX, lastTop: anchor.top };
      this.sways.set(cardId, sway);
    }
    const movedX = anchor.centerX - sway.lastCenterX;
    const movedY = anchor.top - sway.lastTop;
    sway.lastCenterX = anchor.centerX;
    sway.lastTop = anchor.top;
    if (!canSway) {
      sway.offsetX = 0;
      sway.offsetY = 0;
      sway.velocityX = 0;
      sway.velocityY = 0;
      return sway;
    }
    sway.offsetX = clamp(sway.offsetX - movedX * SWAY_LAG, SWAY_LIMIT);
    sway.offsetY = clamp(sway.offsetY - movedY * SWAY_LAG * 0.5, SWAY_LIMIT / 2);
    sway.velocityX += (-SWAY_STIFFNESS * sway.offsetX - SWAY_DAMPING * sway.velocityX) * elapsedSeconds;
    sway.velocityY += (-SWAY_STIFFNESS * sway.offsetY - SWAY_DAMPING * sway.velocityY) * elapsedSeconds;
    sway.offsetX += sway.velocityX * elapsedSeconds;
    sway.offsetY += sway.velocityY * elapsedSeconds;
    const isAtRest =
      Math.abs(sway.offsetX) + Math.abs(sway.offsetY) < SWAY_REST &&
      Math.abs(sway.velocityX) + Math.abs(sway.velocityY) < SWAY_REST * 20;
    if (isAtRest) {
      sway.offsetX = 0;
      sway.offsetY = 0;
      sway.velocityX = 0;
      sway.velocityY = 0;
    } else {
      this.isLively = true;
    }
    return sway;
  }

  private pullThread(start: Point, goal: Point & { stem: number }, elapsedSeconds: number, canSpring: boolean): ThreadEnd {
    const end = this.threadEnd ?? { x: start.x, y: start.y, stem: 0, velocityX: 0, velocityY: 0, velocityStem: 0 };
    this.threadEnd = end;
    if (!canSpring) {
      end.x = goal.x;
      end.y = goal.y;
      end.stem = goal.stem;
      return end;
    }
    end.velocityX += (THREAD_STIFFNESS * (goal.x - end.x) - THREAD_DAMPING * end.velocityX) * elapsedSeconds;
    end.velocityY += (THREAD_STIFFNESS * (goal.y - end.y) - THREAD_DAMPING * end.velocityY) * elapsedSeconds;
    end.velocityStem += (THREAD_STIFFNESS * (goal.stem - end.stem) - THREAD_DAMPING * end.velocityStem) * elapsedSeconds;
    end.x += end.velocityX * elapsedSeconds;
    end.y += end.velocityY * elapsedSeconds;
    end.stem = Math.max(0, end.stem + end.velocityStem * elapsedSeconds);
    return end;
  }

  private place(key: string, className: string, shape: string, arrowId?: string, entrance?: "draw" | "pulse") {
    let path = this.paths.get(key);
    const isNew = !path;
    if (!path) {
      path = document.createElementNS(SVG_NS, "path");
      this.paths.set(key, path);
      (key === "drag" ? this.frontLayer : this.layer).append(path);
    }
    if (path.getAttribute("class") !== className) path.setAttribute("class", className);
    if (path.getAttribute("d") !== shape) path.setAttribute("d", shape);
    const canPlay = isNew && canAnimate(path) && typeof path.getTotalLength === "function" && !prefersReducedMotion();
    if (canPlay && entrance === "draw") {
      const length = path.getTotalLength();
      this.drawingOn.add(key);
      const drawOn = path.animate(
        [
          { strokeDasharray: `${length}`, strokeDashoffset: length },
          { strokeDasharray: `${length}`, strokeDashoffset: 0 },
        ],
        { duration: DRAW_ON_MS, easing: EASE_SETTLE },
      );
      const finishDrawing = () => {
        this.drawingOn.delete(key);
        this.draw();
      };
      drawOn.finished.then(finishDrawing, finishDrawing);
    } else if (canPlay && entrance === "pulse") {
      this.queuedPulses.add(key);
    }
    if (arrowId && !this.drawingOn.has(key)) path.setAttribute("marker-end", `url(#${arrowId})`);
    else path.removeAttribute("marker-end");
  }

  private pulse(key: string) {
    const source = this.paths.get(key);
    if (!source || !canAnimate(source) || typeof source.getTotalLength !== "function" || prefersReducedMotion()) return;
    this.pulses.get(key)?.remove();
    const pulse = document.createElementNS(SVG_NS, "path");
    pulse.setAttribute("class", key.startsWith("tether:") ? "fan-pulse is-live" : "fan-pulse");
    pulse.setAttribute("d", source.getAttribute("d") ?? "");
    this.layer.append(pulse);
    this.pulses.set(key, pulse);
    const length = source.getTotalLength();
    const dash = Math.min(36, length * 0.4);
    const travel = pulse.animate(
      [
        { strokeDasharray: `${dash} ${length + dash}`, strokeDashoffset: dash, opacity: 1 },
        { opacity: 1, offset: 0.75 },
        { strokeDasharray: `${dash} ${length + dash}`, strokeDashoffset: -length, opacity: 0 },
      ],
      { duration: PULSE_MS, easing: EASE_TRAVEL },
    );
    const finishPulse = () => {
      pulse.remove();
      if (this.pulses.get(key) === pulse) this.pulses.delete(key);
    };
    travel.finished.then(finishPulse, finishPulse);
  }

  draw() {
    const plan = this.plan;
    const drawn = new Set<string>();
    const now = performance.now();
    const elapsedSeconds = this.lastDrawAt ? Math.min(MAX_FRAME_SECONDS, (now - this.lastDrawAt) / 1000) : 0;
    this.lastDrawAt = now;
    this.isLively = false;
    if (plan && plan.origin && !this.isStacked()) {
      const canSpring = !prefersReducedMotion();
      const trace = this.dragLine ? null : this.trace;
      const frame = this.layer.getBoundingClientRect();
      const originBox = visibleBoxOf(plan.origin);
      const originCenter = originBox.left + originBox.width / 2 - frame.left;
      const originY = originBox.bottom - frame.top;
      const anchors = new Map<string, Anchor>();
      for (const card of plan.cards) {
        if (!card.element.isConnected) continue;
        const box = visibleBoxOf(card.element);
        if (box.width === 0) continue;
        anchors.set(card.id, { centerX: box.left + box.width / 2 - frame.left, top: box.top - frame.top, bottom: box.bottom - frame.top, width: box.width });
      }
      for (const card of plan.cards) {
        const anchor = anchors.get(card.id);
        if (!anchor || isBelowAnotherCard(anchor, anchors.values())) continue;
        const key = `tether:${card.id}`;
        drawn.add(key);
        const sway = this.swayOf(card.id, anchor, elapsedSeconds, canSpring);
        const originX = originCenter + (anchor.centerX - originCenter) * ORIGIN_SPREAD;
        this.place(
          key,
          "fan-tether" +
            (card.isDashed ? " is-dashed" : "") +
            (card.isLive ? " is-live" : "") +
            (trace?.cardId === card.id ? " is-traced" : ""),
          tetherPath(originX, originY, anchor.centerX, anchor.top, sway.offsetX, sway.offsetY),
        );
      }
      const startDrop = plan.hasGrips ? 8 : 3;
      const pending = this.pendingLink;
      let isPendingDrawn = false;
      for (const link of plan.links) {
        const blocker = anchors.get(link.blockerId);
        const dependent = anchors.get(link.dependentId);
        if (!blocker || !dependent) continue;
        const sameTarget = plan.links.filter((other) => other.dependentId === link.dependentId && anchors.has(other.blockerId));
        const key = `arc:${link.id}`;
        drawn.add(key);
        const isPendingArrival = pending?.blockerId === link.blockerId && pending.dependentId === link.dependentId;
        if (isPendingArrival) isPendingDrawn = true;
        const isTraced = trace
          ? trace.edgeId
            ? trace.edgeId === link.id
            : trace.cardId === link.blockerId || trace.cardId === link.dependentId
          : false;
        this.place(
          key,
          "fan-arc" + (link.isUnsettled ? " is-unsettled" : "") + (trace ? (isTraced ? " is-traced" : " is-dimmed") : ""),
          dependencyPath(blocker, dependent, sameTarget.indexOf(link), sameTarget.length, startDrop),
          plan.arrowId,
          isPendingArrival ? "pulse" : this.announcedLinks.has(link.id) && !link.isUnsettled ? "draw" : undefined,
        );
      }
      if (isPendingDrawn || (pending && now > pending.expiresAt)) this.pendingLink = null;
      const heldLink = this.pendingLink;
      const heldBlocker = heldLink ? anchors.get(heldLink.blockerId) : undefined;
      const heldDependent = heldLink ? anchors.get(heldLink.dependentId) : undefined;
      if (heldLink && heldBlocker && heldDependent) {
        const waitingCount = plan.links.filter((other) => other.dependentId === heldLink.dependentId && anchors.has(other.blockerId)).length;
        drawn.add("pending");
        this.isLively = true;
        this.place(
          "pending",
          "fan-arc is-pending",
          dependencyPath(heldBlocker, heldDependent, waitingCount, waitingCount + 1, startDrop),
          plan.arrowId,
        );
      }
      const dragLine = this.dragLine;
      const source = dragLine ? anchors.get(dragLine.fromId) : undefined;
      if (dragLine && source) {
        const start = { x: source.centerX, y: source.bottom + startDrop };
        const snapTarget = dragLine.snapToId ? anchors.get(dragLine.snapToId) : undefined;
        const snapCount = snapTarget
          ? plan.links.filter((other) => other.dependentId === dragLine.snapToId && anchors.has(other.blockerId)).length
          : 0;
        const goal = this.isRecoiling
          ? { ...start, stem: 0 }
          : snapTarget
            ? { ...arrowLanding(source, snapTarget, snapCount, snapCount + 1), stem: ARROW_STEM }
            : { x: dragLine.clientX - frame.left, y: dragLine.clientY - frame.top, stem: 0 };
        const end = this.pullThread(start, goal, elapsedSeconds, canSpring);
        const hasRecoiled = this.isRecoiling && Math.hypot(end.x - start.x, end.y - start.y) < 4;
        if (hasRecoiled) {
          this.dragLine = null;
          this.threadEnd = null;
          this.isRecoiling = false;
        } else {
          drawn.add("drag");
          this.isLively = true;
          const isSnapped = Boolean(snapTarget) && !this.isRecoiling;
          this.place(
            "drag",
            "fan-arc is-dragging" + (isSnapped ? " is-snapped" : "") + (dragLine.isRefused ? " is-refused" : ""),
            threadPath(start, end, end.stem),
            isSnapped && end.stem > ARROW_STEM / 2 ? plan.arrowId : undefined,
          );
        }
      }
    }
    this.announcedLinks.clear();
    for (const [key, path] of this.paths) {
      if (drawn.has(key)) continue;
      path.remove();
      this.paths.delete(key);
      this.drawingOn.delete(key);
    }
    for (const key of this.queuedPulses) this.pulse(key);
    this.queuedPulses.clear();
    for (const [key, pulse] of this.pulses) {
      const shape = this.paths.get(key)?.getAttribute("d");
      if (shape) {
        pulse.setAttribute("d", shape);
      } else {
        pulse.remove();
        this.pulses.delete(key);
      }
    }
    for (const cardId of this.sways.keys()) {
      if (!drawn.has(`tether:${cardId}`)) this.sways.delete(cardId);
    }
  }
}
