/**
 * Content script entry point.
 *
 * Owns the page: detection, scraping, the panel, and everything done to
 * Amazon's DOM. It never sees the API key; scoring goes through the service
 * worker.
 *
 * Fail-open is the rule. Every step is wrapped so that if anything here throws,
 * the page is left exactly as Amazon rendered it.
 */
import { collectReviews, DEFAULT_REVIEW_CAP } from "./collect.js";
import { decorateCard, reorderCards, setDimmed, undecorate } from "./decorate.js";
import { detectPage, type PageTarget } from "./page.js";
import { Panel, type PanelState } from "./panel.js";
import { PANEL_ANCHOR, queryFirst } from "./selectors.js";
import { hasSeeAllReviewsLink, scrapeProduct, scrapeReviewCards } from "./scrape.js";
import { customKey, type ActiveFilters } from "../questions/buildQuestions.js";
import {
  passesThreshold,
  presetVerdictKey,
  sortByMatch,
  verdictsFor,
  type AnswerMap,
  type ReviewVerdicts,
} from "../questions/combine.js";
import { PRESETS } from "../questions/presets.js";
import { formatCostUsd } from "../shared/cost.js";
import { sendMessage } from "../shared/messaging.js";
import type { ScoreResponse, SettingsResponse } from "../shared/messaging.js";
import type { ProductContext, Review } from "../shared/types.js";

/** Debounce for lazy-loaded cards, so a burst of mutations causes one pass. */
const MUTATION_DEBOUNCE_MS = 400;

class Sift {
  readonly #target: PageTarget;
  #product: ProductContext = { title: "", category: null };
  /** Every review we know about, by id. */
  readonly #reviews = new Map<string, Review>();
  /** The element each review was parsed from. */
  readonly #cards = new Map<string, Element>();
  /** Answers per review id, accumulated across passes. */
  readonly #answers = new Map<string, AnswerMap>();
  /** Reviews already sent for scoring under the current filters. */
  #scoredUnder = new Set<string>();

  #panel: Panel | null = null;
  #reviewCap = DEFAULT_REVIEW_CAP;
  #observer: MutationObserver | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #scoring = false;

  constructor(target: PageTarget) {
    this.#target = target;
  }

  async start(): Promise<void> {
    const settings = await sendMessage<SettingsResponse>({ type: "sift:settings" });
    if (settings && settings.enabledSites[this.#target.site] === false) return;

    this.#reviewCap = settings?.reviewCap ?? DEFAULT_REVIEW_CAP;
    this.#product = scrapeProduct(document);
    this.#ingest();

    if (this.#reviews.size === 0) return;

    this.#panel = new Panel(
      {
        custom: [],
        presets: [],
        threshold: settings?.defaultThreshold ?? 0.7,
        hideBelow: false,
      },
      {
        onChange: (state) => void this.#onFiltersChanged(state),
        // Threshold and hide are display-only: re-render, never re-score.
        onDisplayChange: (state) => this.#render(state),
      },
    );

    this.#mount();
    this.#observe();

    if (!settings?.hasApiKey) {
      this.#panel.setStatus("Add your TypeSafe API key in Sift's settings to start scoring.", true);
      return;
    }
    this.#panel.setStatus(`${this.#reviews.size} reviews found. Add a filter to score them.`);

    // Fetch more reviews in the background; scoring waits for a filter anyway.
    void this.#collectMore();
  }

  /**
   * Read every review card currently in the DOM into our maps.
   *
   * Reports both new reviews and cards Amazon re-rendered under an id we
   * already knew, because the second case loses our badges and needs a repaint
   * even though nothing needs scoring.
   */
  #ingest(): { added: number; replaced: number } {
    let added = 0;
    let replaced = 0;
    for (const { review, card } of scrapeReviewCards(document)) {
      const known = this.#cards.get(review.id);
      if (known !== card) {
        if (known) replaced += 1;
        this.#cards.set(review.id, card);
      }
      if (!this.#reviews.has(review.id)) {
        if (this.#reviews.size >= this.#reviewCap) continue;
        this.#reviews.set(review.id, review);
        added += 1;
      }
    }
    return { added, replaced };
  }

  /** Follow pagination, if the page offers it. Failure here is not an error. */
  async #collectMore(): Promise<void> {
    const result = await collectReviews({
      target: this.#target,
      initial: [...this.#reviews.values()],
      canPaginate: hasSeeAllReviewsLink(document),
      cap: this.#reviewCap,
    });
    for (const review of result.reviews) {
      if (!this.#reviews.has(review.id)) this.#reviews.set(review.id, review);
    }
    if (result.stopped === "blocked") {
      console.info(`[Sift] pagination stopped: ${result.detail ?? "blocked"}; scoring visible reviews only`);
    }
  }

  #mount(): void {
    if (!this.#panel) return;
    const anchor = queryFirst(document, PANEL_ANCHOR);
    if (anchor?.parentElement) anchor.parentElement.insertBefore(this.#panel.host, anchor);
    else document.body.prepend(this.#panel.host);
  }

  /** Watch for Amazon lazily rendering more review cards as the user scrolls. */
  #observe(): void {
    this.#observer = new MutationObserver(() => {
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => void this.#onMutation(), MUTATION_DEBOUNCE_MS);
    });
    this.#observer.observe(document.body, { childList: true, subtree: true });
  }

  async #onMutation(): Promise<void> {
    if (!this.#panel) return;
    const { added, replaced } = this.#ingest();

    // Sift's own writes are paused out of the observer, so anything left is
    // Amazon's. Still, a pass that changed nothing must not trigger a render:
    // that would mutate the DOM, wake the observer, and loop forever.
    if (added === 0 && replaced === 0) return;

    if (added === 0) {
      // Amazon re-rendered cards we already scored; repaint, do not re-score.
      this.#render(this.#panel.state);
      return;
    }

    const active = this.#activeFilters(this.#panel.state);
    if (active.custom.length + active.presets.length > 0) await this.#score(this.#panel.state);
  }

  #activeFilters(state: PanelState): ActiveFilters {
    return { custom: state.custom, presets: state.presets };
  }

  async #onFiltersChanged(state: PanelState): Promise<void> {
    // New filters mean new questions, so everything needs scoring again. The
    // cache makes previously answered questions free.
    this.#scoredUnder = new Set();
    await this.#score(state);
  }

  async #score(state: PanelState): Promise<void> {
    if (!this.#panel) return;
    const active = this.#activeFilters(state);

    if (active.custom.length === 0 && active.presets.length === 0) {
      this.#withObserverPaused(() => undecorate(document));
      this.#panel.setStatus(`${this.#reviews.size} reviews found. Add a filter to score them.`);
      return;
    }

    if (this.#scoring) return;
    this.#scoring = true;
    try {
      const pending = [...this.#reviews.values()].filter((review) => !this.#scoredUnder.has(review.id));
      if (pending.length === 0) {
        this.#render(state);
        return;
      }

      this.#panel.setStatus(`Scoring ${pending.length} reviews...`);
      const response = await sendMessage<ScoreResponse>({
        type: "sift:score",
        product: this.#product,
        reviews: pending,
        active,
      });

      if (!response) {
        this.#panel.setStatus("Sift could not reach its background worker. Reload the page to retry.", true);
        return;
      }
      if (response.error) {
        this.#panel.setStatus(response.error.message, true);
        return;
      }

      for (const [id, answers] of Object.entries(response.answers)) {
        this.#answers.set(id, answers);
        this.#scoredUnder.add(id);
      }

      this.#render(state);

      const { summary } = response;
      const failed = Object.values(summary.failures).reduce((total, count) => total + (count ?? 0), 0);
      this.#panel.setStatus(
        `${this.#answers.size}/${this.#reviews.size} reviews scored` +
          ` · ~${formatCostUsd(summary.estimatedCostUsd)} this page` +
          (summary.fullyCached > 0 ? ` · ${summary.fullyCached} from cache` : "") +
          (failed > 0 ? ` · ${failed} unscored` : ""),
        failed > 0,
      );
    } finally {
      this.#scoring = false;
    }
  }

  /**
   * Run a DOM-writing block without the observer seeing it.
   *
   * Every write below (badges, dimming, reordering) is a mutation inside the
   * subtree we watch. Without this, one render schedules the next and the page
   * never settles.
   */
  #withObserverPaused(write: () => void): void {
    this.#observer?.disconnect();
    try {
      write();
    } finally {
      // Drop records queued during the write, then resume.
      this.#observer?.takeRecords();
      if (this.#observer) this.#observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  /** Badge, dim and reorder from answers we already have. Never scores. */
  #render(state: PanelState): void {
    this.#withObserverPaused(() => this.#paint(state));
  }

  #paint(state: PanelState): void {
    const active = this.#activeFilters(state);
    const labels = this.#labels(state);

    const rows: Array<{ id: string; verdicts: ReviewVerdicts }> = [];
    for (const id of this.#reviews.keys()) {
      rows.push({ id, verdicts: verdictsFor(this.#answers.get(id) ?? {}, active) });
    }

    for (const row of rows) {
      const card = this.#cards.get(row.id);
      if (!card?.isConnected) continue;
      decorateCard(card, row.verdicts, labels);
      const passes = passesThreshold(row.verdicts, state.threshold);
      setDimmed(card, state.hideBelow && !passes);
    }

    // Reorder within each list container, so cards never jump between lists.
    const byContainer = new Map<Element, Element[]>();
    for (const row of sortByMatch(rows)) {
      const card = this.#cards.get(row.id);
      const container = card?.parentElement;
      if (!card?.isConnected || !container) continue;
      const list = byContainer.get(container) ?? [];
      list.push(card);
      byContainer.set(container, list);
    }
    for (const [container, order] of byContainer) reorderCards(container, order);
  }

  /** Short badge labels: the user's own words for custom filters. */
  #labels(state: PanelState): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const filter of state.custom) {
      labels[customKey(filter.id)] = truncate(filter.text, 28);
    }
    for (const preset of PRESETS) {
      if (state.presets.includes(preset.id)) labels[presetVerdictKey(preset.id)] = shortLabel(preset.id);
    }
    return labels;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Badges are small; presets get a short name rather than their full chip text. */
function shortLabel(presetId: string): string {
  switch (presetId) {
    case "durability":
      return "durability";
    case "sizing":
      return "sizing";
    case "shipping":
      return "shipping";
    case "fake":
      return "incentivised";
    default:
      return presetId;
  }
}

function main(): void {
  const target = detectPage(location.href);
  if (!target) return;
  const sift = new Sift(target);
  void sift.start().catch((error: unknown) => {
    // Never let a failure here change the page.
    console.warn("[Sift] disabled after an error:", error);
    undecorate(document);
  });
}

main();
