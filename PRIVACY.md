# Privacy policy

Last updated: 20 September 2026

Sift is a browser extension with no backend. There is no server belonging to this
project, so there is nothing of yours for it to hold.

## What leaves your browser

One thing, and only when you add a filter.

When you type a filter or turn on a preset chip, Sift sends each review on the page
to `https://api.typesafe.ai/v1/systemone` to be scored. Each request contains:

- the review's title, body, star rating, date, verified-purchase flag and
  helpful-vote count
- the product's title and category
- the questions your filters produced
- your TypeSafe API key, as an `Authorization` header

That is the whole request. Reviewer names are not collected, because no question
Sift asks needs them.

Nothing is sent until you add a filter. Opening a product page with no filters
active sends nothing.

## Where it goes

To TypeSafe, and nowhere else. TypeSafe's handling of that data is governed by their
own terms, which you accept when you get an API key from them.

Sift sends nothing to any other host. There is no analytics service, no error
reporting service, no remote configuration, no update feed beyond the browser's own
extension updates.

## What stays on your machine

Stored in `chrome.storage.local`, which is local to your browser profile:

- **Your API key.** It is read only by the extension's service worker and sent only
  to `api.typesafe.ai`. The page you are browsing never sees it.
- **Cached answers.** The probability each question returned, keyed by a SHA-256
  hash of the review id and the question text. Capped at 5,000 entries, oldest
  dropped first. This is what makes a repeat visit free.
- **Your settings.** Review cap, default threshold, which sites are enabled.

Clear the cached answers any time with **Clear cache** on the settings page.
Removing the extension removes all of it.

## What Sift does not do

- No analytics or telemetry of any kind.
- No tracking across sites. It runs only on `amazon.in` and `amazon.com`, and only
  on product and review pages.
- No accounts, no sign-in, no identifiers.
- No selling or sharing of anything, because nothing is collected to sell or share.
- No reading of your Amazon account, orders, addresses or payment details. Sift
  reads the review text rendered on the page and nothing else.

## Permissions, and why each one exists

| Permission | Why |
| --- | --- |
| `storage` | Holding your key, settings and cached answers locally. |
| `https://api.typesafe.ai/*` | The one host reviews are sent to for scoring. |
| Content script on `amazon.in` and `amazon.com` | Reading the reviews on the page and drawing the panel and badges. |

There is no `tabs` permission, no `<all_urls>`, and no background network access to
anything other than TypeSafe.

## Children

Sift is not directed at children and collects nothing from anyone.

## Changes

Any change to this policy will be committed to this repository, so the history is
public and diffable.

## Contact

Open an issue at https://github.com/MEGA-M1ND/Sift/issues.
