# Fixtures

## Read this before trusting a passing parser test

The two `.html` files here are **synthetic**. They were hand-built to match the
markup pattern described in `src/content/selectors.ts`, because `amazon.in` and
`amazon.com` are blocked by this project's network egress policy and no real page
could be fetched or saved.

That has a consequence worth being blunt about:

> **These fixtures test parser logic, not selector accuracy.**

If a selector in `selectors.ts` is wrong about real Amazon, the fixture here is
wrong in exactly the same way, and the test still passes. Passing tests prove that
normalisation, fallback chains, deduplication, malformed-card handling and the cap
behave correctly. They prove nothing at all about whether Sift extracts reviews
from a live page.

## Replacing these with real pages

This is the step that turns the tests into evidence. It takes about two minutes.

1. Open a product page on `amazon.in` or `amazon.com` while logged in.
2. Save it with **File -> Save Page As -> Web Page, Complete** (or copy
   `document.documentElement.outerHTML` from DevTools, which is smaller and
   usually enough).
3. Strip personal data before saving it into the repo: search the HTML for your
   own name, delivery address, order ids and the `session-id` / `ubid` cookies,
   and remove them. Reviewer names of other customers are not needed by any
   question Sift asks, so delete those too.
4. Save as `fixtures/amazon-in-product-reviews.html` (or `amazon-com-dp.html`),
   replacing the synthetic file.
5. Run the checker:

   ```sh
   npm run check-fixture -- fixtures/amazon-in-product-reviews.html
   ```

   It prints which selector candidate matched each field, how many review cards
   were found, and how many were dropped. Any field reporting `MISS` is a selector
   that needs fixing in `src/content/selectors.ts`.

6. Re-run `npm test`. The parser tests assert on counts and values, so real
   fixtures with different content will need their expected numbers updated; the
   checker output tells you what they should be.

## Current files

| File | Origin | Models |
| --- | --- | --- |
| `amazon-in-product-reviews.html` | synthetic | `/product-reviews/` list page, `amazon.in` date format |
| `amazon-com-dp.html` | synthetic | `/dp/` detail page, `amazon.com` date format, reviews block |

Both deliberately include awkward cases: a card with no rating, a card with no
body at all, a duplicate review id, singular "One person found this helpful",
and a title anchor that also contains the star-rating text.
