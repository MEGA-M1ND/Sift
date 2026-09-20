/**
 * End-to-end check of the built extension, with no network.
 *
 *   npm run build && npm run e2e
 *
 * Loads dist/ into Chromium, serves a fixture as a real amazon.in URL so the
 * manifest's match patterns and detectPage() are genuinely exercised, and
 * intercepts api.typesafe.ai with a local stub. Proves the panel mounts, scores,
 * badges, dims and reorders. The probabilities come from the stub, not Jev.
 */
import { readFileSync } from "node:fs";
import { chromium, type BrowserContext } from "playwright";

const DIST = new URL("../dist", import.meta.url).pathname;
const FIXTURE = readFileSync(new URL("../fixtures/amazon-in-product-reviews.html", import.meta.url), "utf8");
const PRODUCT_URL = "https://www.amazon.in/AcmeDrive-Drill/dp/B0BDHWDR12/ref=sr_1_3";

/** Keyword stub standing in for the model, so the run is deterministic. */
function stubAnswers(body: string): unknown {
  const { state, questions, model } = JSON.parse(body) as {
    state: { review: { title: string; body: string } };
    questions: Record<string, { type: string; criteria?: unknown }>;
    model?: string;
  };
  const text = `${state.review.title} ${state.review.body}`.toLowerCase();
  const has = (...words: string[]) => words.some((word) => text.includes(word));

  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      let p = 0.05;
      if (name.startsWith("custom:")) p = has("battery", "charge") ? 0.93 : 0.06;
      else if (name.includes("generic_praise")) p = text.length < 120 ? 0.82 : 0.1;
      else if (name.includes("free_or_discounted")) p = has("discounted price", "exchange for") ? 0.96 : 0.03;
      else if (name.includes("tone_mismatch")) p = 0.5;
      answers[name] = { type: "noul", noul: p };
    } else {
      const level = has("month ten", "carpentry", "eighteen months") ? 1.9 : 0.6;
      answers[name] = {
        type: "score",
        score: level,
        confidence: 0.86,
        legend: {},
        probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
      };
    }
  }
  return { model: model ?? "stub", answers, usage: { input_tokens: 420, output_tokens: 0 } };
}

async function extensionId(context: BrowserContext): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const worker = context.serviceWorkers()[0];
    if (worker) return new URL(worker.url()).host;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the extension's service worker never started");
}

async function main(): Promise<void> {
  // Extensions need full Chromium, not the headless shell. This environment
  // pins a prebuilt one; CI installs its own and leaves CHROMIUM_PATH unset.
  const executablePath = process.env.CHROMIUM_PATH;

  const context = await chromium.launchPersistentContext("", {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--headless=new",
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-sandbox",
    ],
  });

  const failures: string[] = [];
  const check = (label: string, ok: boolean) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };

  try {
    // Serve the fixture as a genuine amazon.in URL, so the manifest's match
    // patterns and detectPage() both do their real work.
    await context.route("https://www.amazon.in/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE }),
    );
    // Stand in for the API. The service worker's fetch is routed too.
    await context.route("https://api.typesafe.ai/**", async (route) => {
      const body = route.request().postData() ?? "{}";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubAnswers(body)),
      });
    });

    const id = await extensionId(context);
    console.log(`\nextension id: ${id}\n`);

    // Enter the API key and the other settings through the real settings page.
    const options = await context.newPage();
    // domcontentloaded, not load: the page is ready once its module runs, and
    // waiting on every subresource made this flake.
    await options.goto(`chrome-extension://${id}/src/options/index.html`, { waitUntil: "domcontentloaded" });
    await options.waitForSelector("#key");
    await options.fill("#key", "test-key-not-a-real-one");
    await options.fill("#cap", "150");
    await options.fill("#confirm", "0.01");
    await options.evaluate(() => {
      const slider = document.querySelector<HTMLInputElement>("#threshold")!;
      slider.value = "0.62";
      slider.dispatchEvent(new Event("input"));
    });
    await options.uncheck("#site-com");
    await options.click("#save");
    await options.waitForFunction(() => document.querySelector("#status")?.textContent === "Saved.");
    check("settings page saves the API key and options", true);

    // Reload: settings must survive, or nothing the user sets here is real.
    await options.reload();
    await options.waitForSelector("#key");
    const persisted = await options.evaluate(() => ({
      key: document.querySelector<HTMLInputElement>("#key")!.value,
      cap: document.querySelector<HTMLInputElement>("#cap")!.value,
      confirm: document.querySelector<HTMLInputElement>("#confirm")!.value,
      threshold: document.querySelector<HTMLInputElement>("#threshold")!.value,
      siteCom: document.querySelector<HTMLInputElement>("#site-com")!.checked,
      siteIn: document.querySelector<HTMLInputElement>("#site-in")!.checked,
    }));
    console.log(`  persisted: ${JSON.stringify(persisted)}`);
    check("settings survive a reload", persisted.key === "test-key-not-a-real-one" &&
      persisted.cap === "150" && persisted.threshold === "0.62" && persisted.siteCom === false &&
      persisted.confirm === "0.01");

    // Put amazon.com back on, and the key masked, before the screenshot.
    await options.check("#site-com");
    await options.click("#save");
    await options.waitForFunction(() => document.querySelector("#status")?.textContent === "Saved.");
    await options.screenshot({ path: "docs/settings.png", fullPage: true });
    await options.close();

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.text().includes("[Sift]")) console.log(`  page: ${message.text()}`);
    });
    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });

    const panel = page.locator("#sift-panel-host");
    await panel.waitFor({ state: "attached", timeout: 15_000 });
    check("panel mounts on a /dp/ page", true);

    // The panel lives in a shadow root; Playwright pierces it automatically.
    check(
      "panel sits above the reviews list",
      await page.evaluate(() => {
        const host = document.querySelector("#sift-panel-host");
        const list = document.querySelector("#cm_cr-review_list");
        return !!host && !!list && !!(host.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
      }),
    );

    check("no badges before a filter is added", (await page.locator("[data-sift-badge]").count()) === 0);

    // Type a filter and score.
    await panel.locator("input[type=text]").fill("battery dies within a year");
    await panel.locator("button.add").click();

    await page.waitForFunction(
      () => document.querySelectorAll("[data-sift-badge]").length > 0,
      undefined,
      { timeout: 20_000 },
    );
    check("badges appear after scoring", true);

    const badgeTexts = await page.locator("[data-sift-badge]:not([data-sift-badge=container])").allTextContents();
    console.log(`  badges: ${JSON.stringify(badgeTexts)}`);
    check("a high-confidence match is shown as a percentage", badgeTexts.some((t) => /9\d%/.test(t)));

    // The battery review should now be first in the list.
    const firstTitle = await page.evaluate(() => {
      const first = document.querySelector('#cm_cr-review_list [data-hook="review"]');
      return first?.querySelector('[data-hook="review-title"]')?.textContent?.trim() ?? "";
    });
    console.log(`  first review after sort: ${JSON.stringify(firstTitle)}`);
    check("the battery review is reordered to the top", firstTitle.includes("Battery was dead"));

    // Turn on the flag preset and confirm it does not steal the top spot.
    await panel.locator(".chips.presets button", { hasText: "incentivised" }).click();
    await page.waitForTimeout(2500);
    const firstAfterFlag = await page.evaluate(() => {
      const first = document.querySelector('#cm_cr-review_list [data-hook="review"]');
      return first?.querySelector('[data-hook="review-title"]')?.textContent?.trim() ?? "";
    });
    console.log(`  first review with the flag chip on: ${JSON.stringify(firstAfterFlag)}`);
    check("the fake-review flag does not outrank the real match", firstAfterFlag.includes("Battery was dead"));
    check(
      "flagged review carries a warning badge",
      (await page.locator("[data-sift-badge='preset:fake']").allTextContents()).some((t) => t.includes("⚠")),
    );

    // Dim below threshold.
    await panel.locator("input.hide").check();
    await page.waitForTimeout(600);
    const dimmed = await page.locator("[data-sift-dimmed='1']").count();
    console.log(`  dimmed cards: ${dimmed}`);
    check("hide-below-threshold dims rather than deletes", dimmed > 0);
    check(
      "dimmed reviews are still in the DOM",
      (await page.locator('#cm_cr-review_list [data-hook="review"]').count()) === 6,
    );

    // Sift's own badge writes are DOM mutations; if the MutationObserver reacts
    // to them the page renders forever. Count mutations once everything settled.
    await page.waitForTimeout(1500);
    const churn = await page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver((records) => { count += records.length; });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      observer.disconnect();
      return count;
    });
    console.log(`  DOM mutations in 3s once idle: ${churn}`);
    check("the page settles instead of re-rendering forever", churn < 20);

    const status = await panel.locator(".status").textContent();
    console.log(`  status line: ${JSON.stringify(status?.trim())}`);
    check("status line reports scored count and cost", /reviews scored/.test(status ?? ""));

    await page.screenshot({ path: "docs/panel.png", fullPage: true });
    console.log("\n  screenshot: docs/panel.png");

    // ---- the spend confirmation ----
    // Set the threshold to zero so any spend at all has to be confirmed.
    const opts2 = await context.newPage();
    await opts2.goto(`chrome-extension://${id}/src/options/index.html`, { waitUntil: "domcontentloaded" });
    await opts2.waitForSelector("#confirm");
    await opts2.fill("#confirm", "0");
    await opts2.click("#save");
    await opts2.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("Saved"));
    await opts2.close();

    const page2 = await context.newPage();
    await page2.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });
    const panel2 = page2.locator("#sift-panel-host");
    await panel2.waitFor({ state: "attached", timeout: 15_000 });

    let scoredBeforeConfirm = 0;
    await page2.locator("#sift-panel-host input[type=text]").fill("battery dies within a year");
    await page2.locator("#sift-panel-host button.add").click();
    await page2.waitForSelector("#sift-panel-host button.action:not([hidden])", { timeout: 10_000 });

    const prompt = await panel2.locator(".status").textContent();
    console.log(`  confirm prompt: ${JSON.stringify(prompt?.trim())}`);
    check("a spend above the limit asks before scoring", /Score \d+ reviews against \d+ questions\?/.test(prompt ?? ""));
    check("the prompt names a cost", /About <?\$/.test(prompt ?? ""));

    // Nothing may have been scored while the prompt is up.
    await page2.waitForTimeout(1200);
    scoredBeforeConfirm = await page2.locator("[data-sift-badge]").count();
    console.log(`  badges while awaiting confirmation: ${scoredBeforeConfirm}`);
    check("nothing is scored until the user agrees", scoredBeforeConfirm === 0);

    // Capture the prompt itself, not the state after agreeing to it.
    await page2.screenshot({ path: "docs/confirm.png", fullPage: true });

    await page2.locator("#sift-panel-host button.action").click();
    await page2.waitForFunction(() => document.querySelectorAll("[data-sift-badge]").length > 0, undefined, {
      timeout: 20_000,
    });
    check("pressing Score runs the scoring", true);
    await page2.close();

    // ---- the hard per-page ceiling ----
    const opts3 = await context.newPage();
    await opts3.goto(`chrome-extension://${id}/src/options/index.html`, { waitUntil: "domcontentloaded" });
    await opts3.waitForSelector("#ceiling");
    // A ceiling below what one chunk costs, so the very first chunk is refused.
    await opts3.fill("#confirm", "0");
    await opts3.fill("#ceiling", "0.00002");
    await opts3.click("#save");
    await opts3.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("Saved"));
    await opts3.close();

    const page4 = await context.newPage();
    await page4.goto(PRODUCT_URL, { waitUntil: "domcontentloaded" });
    await page4.locator("#sift-panel-host").waitFor({ state: "attached", timeout: 15_000 });
    await page4.locator("#sift-panel-host input[type=text]").fill("battery dies within a year");
    await page4.locator("#sift-panel-host button.add").click();
    // Past the confirmation first.
    await page4.waitForSelector("#sift-panel-host button.action:not([hidden])", { timeout: 10_000 });
    await page4.locator("#sift-panel-host button.action").click();

    await page4.waitForFunction(
      () =>
        document
          .querySelector("#sift-panel-host")
          ?.shadowRoot?.querySelector(".status")
          ?.textContent?.includes("page limit"),
      undefined,
      { timeout: 20_000 },
    );
    const capped = await page4.locator("#sift-panel-host .status").textContent();
    console.log(`  at the ceiling: ${JSON.stringify(capped?.trim())}`);
    check("a run stops at the page spend limit", /page limit/.test(capped ?? ""));
    check("the limit message says how much was spent", /spent/.test(capped ?? ""));
    check(
      "nothing was scored, because the first chunk already crossed the limit",
      (await page4.locator("[data-sift-badge]").count()) === 0,
    );

    const continueLabel = await page4.locator("#sift-panel-host button.action").textContent();
    console.log(`  offered action: ${JSON.stringify(continueLabel?.trim())}`);
    check("a Continue button is offered", continueLabel?.trim() === "Continue");
    await page4.screenshot({ path: "docs/ceiling.png", fullPage: true });

    // Continue grants one more limit's worth, which is enough for this page.
    await page4.locator("#sift-panel-host button.action").click();
    await page4.waitForFunction(() => document.querySelectorAll("[data-sift-badge]").length > 0, undefined, {
      timeout: 20_000,
    });
    check("Continue grants another limit's worth and the run finishes", true);
    await page4.close();

    // NOTE: viewport ordering is unit-tested rather than checked here. The
    // fixture has four reviews, all on screen and all in one chunk, so the page
    // cannot distinguish the orderings; test/resume.test.ts covers it properly.

    // NOTE: the worker-eviction path is NOT exercised here. Content scripts run
    // in an isolated world with their own `chrome` object, so a page-side patch
    // of chrome.runtime.sendMessage never reaches them, and faking it would test
    // nothing real. The retry and chunking logic is unit-tested instead, in
    // test/resume.test.ts.
  } finally {
    await context.close();
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("all checks passed");
  }
}

await main();
