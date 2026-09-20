# Chrome Web Store listing — draft

Copy for the Web Store developer dashboard. Nothing here has been submitted;
treat it as a draft to edit, not final copy.

---

## Name

Sift — filter Amazon reviews in plain English

(45 characters; the limit is 45.)

## Short description

Ask for the reviews you want in plain English. Sift scores every review on the
page and sorts by how well it matches.

(132 characters; the limit is 132.)

## Category

Shopping

## Detailed description

Amazon shows you 1,400 reviews and a search box that matches words. If you want
"the ones where the battery died within a year", word search will not get you
there — "battery" appears in half of them, and the reviews you want are the ones
describing a thing, not containing a term.

Sift takes the question you actually have.

Type "battery dies within a year" into the Sift bar above the reviews. Every
review on the page is scored on how well it matches, tagged with a probability,
and sorted so the strongest matches are first. Add a second filter. Move the
threshold. Dim everything below it.

WHAT YOU CAN ASK FOR

• Anything you can type. Up to five filters at once.
• Built-in chips for common questions: durability and breakage, sizing and fit,
  reviews that are really about shipping rather than the product, and reviews
  that read as incentivised.
• Every review also gets a usefulness rating, used to break ties, so a detailed
  review beats a one-line one at the same match strength.

THE INCENTIVISED-REVIEW CHIP

It is not one "is this fake?" guess. Three separate signals are measured — praise
with no specifics, a disclosure that the product was free or discounted, and a
tone that does not fit the star rating — and combined in code. It flags reviews;
it never reorders them. A review admitting it was incentivised is a warning about
that review, not an answer to what you searched for.

WHEN IT IS NOT SURE, IT SAYS SO

If the model lands near an even chance, the badge reads "unsure" in grey rather
than showing a number. A precise-looking percentage on a coin-flip answer would
be a lie about how much is known.

NOTHING IS EVER HIDDEN FROM YOU

Low-scoring reviews are dimmed, never removed. You can always see what was
filtered out and why.

WHAT IT COSTS

You bring your own TypeSafe API key. Scoring a 300-review page costs roughly a
third of a cent, and results are cached, so returning to the same product costs
nothing at all. There is no subscription and no payment to us.

PRIVACY

Review text is sent to api.typesafe.ai to be scored, and to nowhere else. No
analytics, no telemetry, no remote config, no backend. Your API key is stored in
your browser and is never exposed to the page you are visiting. Sift runs only on
amazon.in and amazon.com product and review pages.

Full policy: https://github.com/MEGA-M1ND/Sift/blob/main/PRIVACY.md
Source: https://github.com/MEGA-M1ND/Sift

REQUIREMENTS

A TypeSafe API key, from typesafe.ai. Sift does not work without one, and says so
plainly rather than failing quietly.

## Permission justifications

Each answers the "why do you need this?" prompt in the dashboard.

**storage**
Stores the user's own API key, their settings, and cached model answers locally in
the browser. The cache is what makes a repeat visit to a product page cost nothing.
No data is stored anywhere else.

**Host permission: https://api.typesafe.ai/***
The single API the extension calls. Review text is sent there to be scored. The
request is made from the service worker so the user's API key is never exposed to
the visited page.

**Content script: amazon.in and amazon.com**
Reads the review text already rendered on product and review pages, and draws the
filter panel and per-review badges. Host-level match patterns are required because
an Amazon product URL carries a product-name slug before the /dp/ segment, which a
narrower match pattern cannot express. The extension checks the URL itself and does
nothing at all on any page that is not a product or review page.

## Single purpose statement

Sift has one purpose: to let a shopper filter and rank the customer reviews on an
Amazon product page by describing, in plain English, what they are looking for.

## Data disclosures

For the "Privacy practices" tab.

| Question | Answer |
| --- | --- |
| Collects personally identifiable information | No |
| Collects health information | No |
| Collects financial and payment information | No |
| Collects authentication information | No |
| Collects personal communications | No |
| Collects location | No |
| Collects web history | No |
| Collects user activity | No |
| Collects website content | **Yes** — public review text from the page is sent to api.typesafe.ai to be scored. It is not stored on any server belonging to this extension, which has no server. |

Certifications, all of which hold:

- Not being sold to third parties, outside of approved use cases.
- Not being used or transferred for purposes unrelated to the item's single purpose.
- Not being used or transferred to determine creditworthiness or for lending purposes.

## Assets still needed

- [x] Icons at 16, 32, 48 and 128px, generated from `src/icons/icon.svg` and
      declared in the manifest. Replace with real artwork if you want something
      less utilitarian.
- [ ] At least one 1280×800 screenshot. `docs/panel.png` is close but was taken
      against a test fixture; retake it on a real product page.
- [ ] Small promo tile, 440×280.
- [ ] The 30-second demo recording. Shot list is in the README.

## Before submitting

- [ ] Verify the selectors against live Amazon (`npm run check-fixture`). Shipping
      a review filter that finds no reviews is the one unrecoverable first
      impression.
- [ ] Run `npm run smoke` against the real API and sanity-check calibration.
- [ ] Set the four `CWS_*` repository secrets if you want the release workflow to
      publish. That job has never run.
