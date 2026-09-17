/**
 * What Sift does to Amazon's own DOM: a badge per review, dimming, reordering.
 *
 * Three rules hold everywhere here:
 *   - Nothing is ever deleted. Low-scoring reviews are dimmed, never removed,
 *     so the user can always see what was filtered out.
 *   - Reordering moves the existing cards. Amazon's own listeners, images and
 *     expanders keep working because the nodes are never recreated.
 *   - Everything is reversible. `undecorate` restores the page exactly.
 *
 * Badges are styled inline rather than with a stylesheet: an inline style beats
 * Amazon's selectors without an `!important` arms race, and injecting one shadow
 * root per review card would be far heavier for three hundred reviews.
 */
import { REVIEW_FIELD, queryFirst } from "./selectors.js";
import { badgeStep, isFlagOnly, type BadgeStep, type ReviewVerdicts } from "../questions/combine.js";

/** Marks anything Sift added, so cleanup never has to guess. */
const BADGE_ATTR = "data-sift-badge";
const DIM_ATTR = "data-sift-dimmed";

/** Colour steps at 0.5 / 0.7 / 0.85, plus grey for unsure. */
const STEP_COLOURS: Record<BadgeStep, { bg: string; fg: string; border: string }> = {
  unsure: { bg: "#f0f2f2", fg: "#565959", border: "#d5d9d9" },
  low: { bg: "#f7fafa", fg: "#6c7778", border: "#d5d9d9" },
  medium: { bg: "#fef3e7", fg: "#8a5300", border: "#f5c78e" },
  high: { bg: "#e9f6ec", fg: "#12683a", border: "#a7d8b8" },
  top: { bg: "#12683a", fg: "#ffffff", border: "#12683a" },
};

function styleBadge(el: HTMLElement, step: BadgeStep): void {
  const colours = STEP_COLOURS[step];
  el.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:4px",
    "margin:0 6px 4px 0",
    "padding:1px 7px",
    "border-radius:999px",
    "font-size:11px",
    "line-height:1.6",
    "font-weight:700",
    "font-family:inherit",
    "white-space:nowrap",
    "vertical-align:middle",
    `background:${colours.bg}`,
    `color:${colours.fg}`,
    `border:1px solid ${colours.border}`,
  ].join(";");
}

/**
 * Place badges immediately after the star rating, whatever it is nested in.
 * Appending to the rating's parent would drop them at the end of that block,
 * which on some cards is the whole review.
 */
function placeBadges(card: Element, container: Element): void {
  const rating = queryFirst(card, REVIEW_FIELD.rating);
  if (rating) rating.after(container);
  else card.prepend(container);
}

/** Remove Sift's badges from one card. */
function clearBadges(card: Element): void {
  for (const badge of Array.from(card.querySelectorAll(`[${BADGE_ATTR}]`))) badge.remove();
}

export interface BadgeLabels {
  /** Verdict key -> short label shown on the badge. */
  labels: Record<string, string>;
}

/**
 * Render one badge per active filter on a review card.
 *
 * An unsure verdict shows the word "unsure", never the probability: showing a
 * number for an answer that close to a coin flip would imply a confidence the
 * model did not report.
 */
export function decorateCard(card: Element, verdicts: ReviewVerdicts, labels: Record<string, string>): void {
  clearBadges(card);

  const container = card.ownerDocument.createElement("span");
  container.setAttribute(BADGE_ATTR, "container");
  container.style.cssText = "display:inline-flex;flex-wrap:wrap;align-items:center;margin-left:6px";

  let rendered = 0;
  for (const [key, verdict] of Object.entries(verdicts.byFilter)) {
    if (verdict.kind === "unscored") continue;
    const step = badgeStep(verdict);
    if (step === null) continue;

    const badge = card.ownerDocument.createElement("span");
    badge.setAttribute(BADGE_ATTR, key);
    styleBadge(badge, step);

    const label = labels[key] ?? key;
    const value =
      verdict.kind === "unsure" ? "unsure" : `${Math.round(verdict.probability * 100)}%`;
    badge.textContent = isFlagOnly(key) ? `⚠ ${label} ${value}` : `${label} ${value}`;
    badge.title =
      verdict.kind === "unsure"
        ? `Sift could not tell: the model put this near an even chance. (${label})`
        : `${label}: ${(verdict.probability * 100).toFixed(0)}% likely`;

    container.append(badge);
    rendered += 1;
  }

  if (rendered === 0) {
    // Nothing usable came back: say so quietly rather than showing a fake score.
    const badge = card.ownerDocument.createElement("span");
    badge.setAttribute(BADGE_ATTR, "unscored");
    styleBadge(badge, "unsure");
    badge.textContent = "unscored";
    badge.title = "Sift could not score this review.";
    container.append(badge);
  }

  placeBadges(card, container);
}

/** Dim a review rather than hiding it, so nothing ever silently disappears. */
export function setDimmed(card: Element, dimmed: boolean): void {
  const el = card as HTMLElement;
  if (dimmed) {
    if (el.getAttribute(DIM_ATTR) === "1") return;
    el.setAttribute(DIM_ATTR, "1");
    // Remember what was there so undecorate can put it back exactly.
    el.setAttribute("data-sift-prev-opacity", el.style.opacity);
    el.style.opacity = "0.35";
  } else {
    if (el.getAttribute(DIM_ATTR) !== "1") return;
    el.removeAttribute(DIM_ATTR);
    el.style.opacity = el.getAttribute("data-sift-prev-opacity") ?? "";
    el.removeAttribute("data-sift-prev-opacity");
  }
}

/**
 * Reorder cards in place, in the order given.
 *
 * `append` on an element already in the DOM moves it rather than copying, so
 * the original nodes, their listeners and their loaded images all survive.
 * Cards not named in `order` keep their relative position at the end.
 */
export function reorderCards(container: Element, order: readonly Element[]): void {
  const known = new Set(order);
  const rest = Array.from(container.children).filter((child) => !known.has(child));
  for (const card of order) {
    if (card.parentElement === container) container.append(card);
  }
  for (const card of rest) container.append(card);
}

/** Restore the page to exactly how Amazon rendered it. */
export function undecorate(root: ParentNode): void {
  for (const badge of Array.from(root.querySelectorAll(`[${BADGE_ATTR}]`))) badge.remove();
  for (const card of Array.from(root.querySelectorAll(`[${DIM_ATTR}]`))) setDimmed(card, false);
}
