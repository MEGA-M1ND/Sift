/**
 * The Sift panel, injected in a Shadow root directly above the reviews section.
 *
 * Shadow DOM is not decoration here: Amazon's stylesheet is enormous and would
 * otherwise reach into every element we add, and our styles would leak back out
 * onto the page. The shadow boundary makes both impossible.
 *
 * Vanilla DOM, no framework. The panel owns no scoring state; it renders what it
 * is given and reports what the user did.
 */
import { MAX_CUSTOM_FILTERS, PRESETS } from "../questions/presets.js";
import type { CustomFilter } from "../questions/buildQuestions.js";

export interface PanelState {
  custom: CustomFilter[];
  presets: string[];
  threshold: number;
  hideBelow: boolean;
}

export interface PanelCallbacks {
  onChange(state: PanelState): void;
  /** Only threshold/hide changed: re-render, but do not re-score. */
  onDisplayChange(state: PanelState): void;
}

const STYLES = `
  :host { all: initial; }
  .sift {
    font: 13px/1.45 "Amazon Ember", Arial, sans-serif;
    color: #0f1111;
    border: 1px solid #d5d9d9;
    border-radius: 8px;
    padding: 12px 14px;
    margin: 16px 0;
    background: #fff;
  }
  .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
  .name { font-weight: 700; font-size: 14px; }
  .tag { color: #565959; font-size: 12px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row + .row { margin-top: 10px; }
  input[type="text"] {
    flex: 1 1 260px; min-width: 180px; padding: 7px 10px;
    border: 1px solid #888c8c; border-radius: 6px; font: inherit;
  }
  input[type="text"]:focus { outline: 2px solid #007185; outline-offset: 1px; border-color: #007185; }
  button {
    font: inherit; padding: 7px 12px; border-radius: 6px;
    border: 1px solid #d5d9d9; background: #f7fafa; cursor: pointer;
  }
  button:hover { background: #eef1f1; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px; font-size: 12px;
    border: 1px solid #d5d9d9; background: #f7fafa; cursor: pointer;
  }
  .chip[aria-pressed="true"] { background: #007185; border-color: #007185; color: #fff; }
  .chip.custom { background: #e8f3f4; border-color: #007185; cursor: default; }
  .chip .x { font-weight: 700; cursor: pointer; padding: 0 2px; }
  .chip .x:hover { color: #c7511f; }
  .controls { color: #565959; font-size: 12px; }
  .controls label { display: inline-flex; align-items: center; gap: 6px; }
  input[type="range"] { width: 140px; }
  .val { font-variant-numeric: tabular-nums; font-weight: 700; color: #0f1111; }
  .statusRow { display: flex; align-items: center; gap: 10px; margin-top: 10px; min-height: 26px; }
  .status { color: #565959; font-size: 12px; }
  .status.warn { color: #b12704; }
  button.action { background: #ffd814; border-color: #fcd200; font-weight: 700; padding: 5px 14px; }
  button.action[hidden] { display: none; }
  .hint { color: #565959; font-size: 11px; margin-top: 6px; }
`;

/** The panel host element, plus its shadow root. */
export class Panel {
  readonly host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #callbacks: PanelCallbacks;
  #state: PanelState;

  #input!: HTMLInputElement;
  #addButton!: HTMLButtonElement;
  #activeChips!: HTMLElement;
  #presetChips!: HTMLElement;
  #slider!: HTMLInputElement;
  #sliderValue!: HTMLElement;
  #hideToggle!: HTMLInputElement;
  #status!: HTMLElement;
  #action!: HTMLButtonElement;
  #onAction: (() => void) | null = null;

  constructor(initial: PanelState, callbacks: PanelCallbacks) {
    this.#state = { ...initial };
    this.#callbacks = callbacks;

    this.host = document.createElement("div");
    this.host.id = "sift-panel-host";
    this.#root = this.host.attachShadow({ mode: "open" });
    this.#render();
  }

  get state(): PanelState {
    return { ...this.#state };
  }

  #render(): void {
    const style = document.createElement("style");
    style.textContent = STYLES;

    const wrap = document.createElement("div");
    wrap.className = "sift";
    wrap.innerHTML = `
      <div class="head">
        <span class="name">Sift</span>
        <span class="tag">score every review against a plain-English filter</span>
      </div>
      <div class="row">
        <input type="text" part="input" placeholder="e.g. battery dies within a year" aria-label="Add a filter">
        <button class="add" type="button">Add filter</button>
      </div>
      <div class="row chips active" aria-label="Active filters"></div>
      <div class="row chips presets" aria-label="Preset filters"></div>
      <div class="row controls">
        <label>Match at least
          <input type="range" min="0" max="1" step="0.01" aria-label="Match threshold">
          <span class="val"></span>
        </label>
        <label><input type="checkbox" class="hide"> Hide below threshold</label>
      </div>
      <div class="statusRow">
        <span class="status" role="status" aria-live="polite"></span>
        <button class="action" type="button" hidden></button>
      </div>
    `;

    this.#root.append(style, wrap);

    this.#input = wrap.querySelector("input[type=text]")!;
    this.#addButton = wrap.querySelector("button.add")!;
    this.#activeChips = wrap.querySelector(".chips.active")!;
    this.#presetChips = wrap.querySelector(".chips.presets")!;
    this.#slider = wrap.querySelector("input[type=range]")!;
    this.#sliderValue = wrap.querySelector(".val")!;
    this.#hideToggle = wrap.querySelector("input.hide")!;
    this.#status = wrap.querySelector(".status")!;
    this.#action = wrap.querySelector("button.action")!;
    this.#action.addEventListener("click", () => {
      const handler = this.#onAction;
      this.setStatus("", false);
      handler?.();
    });

    this.#addButton.addEventListener("click", () => this.#addFilter());
    this.#input.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") {
        event.preventDefault();
        this.#addFilter();
      }
    });

    this.#slider.value = String(this.#state.threshold);
    this.#slider.addEventListener("input", () => {
      this.#state.threshold = Number(this.#slider.value);
      this.#sliderValue.textContent = this.#state.threshold.toFixed(2);
      // Re-thresholding is a display change: never re-run inference for it.
      this.#callbacks.onDisplayChange(this.state);
    });

    this.#hideToggle.checked = this.#state.hideBelow;
    this.#hideToggle.addEventListener("change", () => {
      this.#state.hideBelow = this.#hideToggle.checked;
      this.#callbacks.onDisplayChange(this.state);
    });

    this.#renderPresets();
    this.#renderActive();
    this.#sliderValue.textContent = this.#state.threshold.toFixed(2);
  }

  #addFilter(): void {
    const text = this.#input.value.trim();
    if (!text) return;
    if (this.#state.custom.length >= MAX_CUSTOM_FILTERS) {
      this.setStatus(`At most ${MAX_CUSTOM_FILTERS} filters at once. Remove one first.`, true);
      return;
    }
    if (this.#state.custom.some((filter) => filter.text.toLowerCase() === text.toLowerCase())) {
      this.#input.value = "";
      return;
    }
    this.#state.custom = [...this.#state.custom, { id: newFilterId(), text }];
    this.#input.value = "";
    this.#renderActive();
    this.#callbacks.onChange(this.state);
  }

  #removeFilter(id: string): void {
    this.#state.custom = this.#state.custom.filter((filter) => filter.id !== id);
    this.#renderActive();
    this.#callbacks.onChange(this.state);
  }

  #togglePreset(id: string): void {
    this.#state.presets = this.#state.presets.includes(id)
      ? this.#state.presets.filter((preset) => preset !== id)
      : [...this.#state.presets, id];
    this.#renderPresets();
    this.#callbacks.onChange(this.state);
  }

  #renderActive(): void {
    this.#activeChips.textContent = "";
    for (const filter of this.#state.custom) {
      const chip = document.createElement("span");
      chip.className = "chip custom";
      const label = document.createElement("span");
      label.textContent = filter.text;
      const remove = document.createElement("span");
      remove.className = "x";
      remove.textContent = "×";
      remove.setAttribute("role", "button");
      remove.setAttribute("aria-label", `Remove filter: ${filter.text}`);
      remove.addEventListener("click", () => this.#removeFilter(filter.id));
      chip.append(label, remove);
      this.#activeChips.append(chip);
    }
    this.#addButton.disabled = this.#state.custom.length >= MAX_CUSTOM_FILTERS;
  }

  #renderPresets(): void {
    this.#presetChips.textContent = "";
    for (const preset of PRESETS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = preset.label;
      const on = this.#state.presets.includes(preset.id);
      chip.setAttribute("aria-pressed", String(on));
      if (preset.flagOnly) chip.title = "Flags reviews; does not affect ranking or hiding";
      chip.addEventListener("click", () => this.#togglePreset(preset.id));
      this.#presetChips.append(chip);
    }
  }

  /**
   * The single status line: counts, cost, or one unobtrusive failure message.
   *
   * An optional button turns it into something the user can act on. That is
   * deliberately the same mechanism for "this will cost money, press Score" and
   * for "scoring was interrupted, press Resume": both are a sentence and one
   * button, and neither should be a modal over someone's shopping.
   */
  setStatus(text: string, warn = false, action?: { label: string; onClick: () => void }): void {
    this.#status.textContent = text;
    this.#status.classList.toggle("warn", warn);

    if (action) {
      this.#onAction = action.onClick;
      this.#action.textContent = action.label;
      this.#action.hidden = false;
    } else {
      this.#onAction = null;
      this.#action.hidden = true;
    }
  }
}

/** Prefixed and random, so a custom filter id can never collide with a preset id. */
export function newFilterId(): string {
  const random =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `u_${random}`;
}
