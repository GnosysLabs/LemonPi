# LemonPi marketing site

A standalone, dark "night lemonade" marketing site for LemonPi — near-black
surfaces, vivid lemon yellow, hot-pink/orchid accents, Geist type. It is a
vanilla Vite project, fully self-contained inside `marketing-site/`, and is
not part of the LemonPi Tauri app or its pnpm workspace.

## Status

Complete. The site is a single page that flows hero → marquee → manifesto
(`#how-it-works`) → capability bento (`#inside`) → capability index →
architecture (`#architecture`) → trust (`#trust`) → requirements →
get started (`#get-started`) → footer, plus a keyboard/screen-reader-operable
Windows SmartScreen info dialog. Out of scope by design (see "Deliberately
not done" below): legal/privacy pages, analytics, a GitHub API release
resolver, and a canonical domain.

## Getting started

```bash
pnpm install
pnpm dev       # http://127.0.0.1:4321
```

Other scripts:

```bash
pnpm build     # emits dist/
pnpm preview   # serves dist/ at http://127.0.0.1:4321
```

The dev/preview server always binds `127.0.0.1:4321` with `--strictPort` so it
never silently jumps to another port.

## Project layout

```
index.html                  single-page shell: header, hero, marquee, manifesto
                             (#how-it-works), capability bento (#inside),
                             capability index, architecture (#architecture),
                             trust (#trust), requirements, get started
                             (#get-started), footer, Windows SmartScreen dialog
src/main.js                 font/CSS imports, header + reveal observers, mobile nav
                             overlay, Windows SmartScreen dialog
src/styles/tokens.css       palette, type scale, easing, radii, gradients — the
                             only file allowed to contain raw color/size literals
src/styles/base.css         reset, grain overlay, skip link, focus states
src/styles/components.css   eyebrow, section, bezel (double-bezel cards), buttons,
                             text-gradient
src/styles/layout.css       floating header/nav, mobile overlay, footer
src/styles/sections.css     hero, marquee, manifesto, capability bento, capability
                             index, architecture, trust, requirements, get started,
                             the Windows modal, and the reduced-motion kill-switch
public/favicon.svg          original lemon-slice-on-a-dark-plate icon (not a
                             renamed PNG); referenced as the primary <link rel="icon">
public/og.png                1200×630 social preview card, rendered from the site's
                             own hero styling (see "Favicon and OG status" below)
public/lemonpi-mark.png     primary lemon mark (from ../assets/iconlp.png)
public/lemonpi-pi-wordmark.png  secondary "Built for Pi" mark (spells "Pi", not "LemonPi")
```

## Design system notes

- **Fonts:** `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`,
  pinned to the same `5.3.0` versions used by the LemonPi desktop app.
- **Tokens:** every color, spacing, radius, and easing curve used anywhere in
  the site is declared once in `src/styles/tokens.css`. Don't hard-code hex
  values in other files.
- **Motion:** all transitions use `--ease-heavy` or `--ease-expo` (custom
  cubic-beziers), never `linear`/`ease-in-out`, except the marquee's constant-
  speed scroll, which needs `linear` to stay seamless. Everything animates via
  `transform`/`opacity` only. Scroll reveals use `IntersectionObserver`, never
  a `scroll` listener.
- **Reduced motion:** `prefers-reduced-motion: reduce` is handled at the end
  of `src/styles/sections.css` (the last imported stylesheet) and disables
  every animation/transition and forces reveals to their resolved state.
- **No-JS baseline:** `[data-reveal]` only hides content once `main.js` adds a
  `.js` class to `<html>`. If JavaScript fails to load, the page renders fully
  visible and readable.

## Brand mark decision

`assets/piwm.png` reads "Pi", not "LemonPi", so it is used only as a
secondary "Built for Pi" attribution mark in the footer. The primary identity
is `assets/iconlp.png` (the lemon slice) placed on a rounded plate next to the
live text "LemonPi" set in Geist Variable, per the plan's default direction.

## Navigation anchors

The mobile overlay and the footer's Product column point at every real,
on-page section: `#how-it-works`, `#inside`, `#architecture`, `#trust`, and
`#get-started`. The desktop floating pill intentionally shows a shorter list
(`How it works`, `Inside`, `Trust`, `Get started`) so it never wraps or
overflows at the 860–1024px range where it's tightest — `#architecture`
stays reachable via scrolling, the footer, and the mobile overlay.

Each anchor target section carries `tabindex="-1"` and a `scroll-margin-top`
(see `sections.css`) so the mobile overlay's internal-link focus handoff
(close overlay → scroll → focus target, see `main.js`) works for any of them
without per-link special-casing — the handoff logic is generic over every
`a[href^="#"]` inside `.nav-overlay`. Add the same two things
(`tabindex="-1"`, `scroll-margin-top`) to any future anchor target.

## Claim-sourcing rule

**Every sentence of hero, marquee, footer, and narrative-section copy must be
traceable to `/Users/christopher/Dev/LemonPi/README.md`.** Do not add sandboxing,
encryption, privacy, telemetry, or performance claims. If you add copy that
touches trust or permissions, it must carry the verbatim guardrail from that
README:

> Pi and its extensions still execute with the user's operating-system
> permissions. LemonPi is a UI and process boundary, not a sandbox.

See "Release and requirements guardrails" below for the full release-honesty
rule — it supersedes and expands the short version that used to live here.

## Trust section

`#trust` presents the two real project-trust choices from the root README
(`Trust and open` → `--approve`, `Open safely` → `--no-approve`) as two
contrasting bezel cards, followed by a full-width, prominent-but-calm
disclaimer panel containing this sentence **verbatim** — never paraphrased,
never buried below the fold of the section:

> Pi and its extensions still execute with the user's operating-system
> permissions. LemonPi is a UI and process boundary, not a sandbox.

If you ever touch `#trust` copy, diff the disclaimer text against the root
README's "Project trust" section before committing.

## Release and requirements guardrails

The LemonPi repo has **no published release and no git tag yet**. This site
keeps two facts visually and textually separate so they never contradict:

1. **What the app itself targets** (Requirements section): macOS, Windows,
   and Linux, per the root README's "Requirements" list.
2. **What the planned first release targets** (Get started section): Apple
   Silicon macOS and Windows x64 only, per the root README's "Manual v0.1.1
   release procedure." Linux is deliberately absent from Get started.

Rules that keep this honest:

- Every release-related link points at the stable
  `https://github.com/GnosysLabs/LemonPi/releases` index, **never**
  `/releases/latest` and **never** a direct asset filename — both would be
  wrong or 404 until a release actually exists.
- CTA labels read "View releases," never "Download" or "Get LemonPi" — those
  imply an artifact is available today.
- The hero status line, the Get started lead paragraph, and the Get started
  closing note all say this is an early build with no public release claimed
  by the site. Keep those three in sync if you touch any of them.
- The Requirements section carries an explicit note ("The app itself targets
  macOS, Windows, and Linux. The planned first release targets Apple Silicon
  macOS and Windows x64 only—see Get started.") specifically so the two
  lists never read as contradictory.
- Every sentence about the first release uses explicitly planned/future
  wording ("planned first release," "planned installer," "release target")
  rather than present tense ("is built for," "the installer is") — present
  tense reads as if an artifact already exists, which it doesn't.
- **When a release is actually published:** update the CTA copy/links, the
  hero status line, and the Get started cards together; only then consider
  reintroducing a version number, a direct `/releases/latest` link, or a
  Linux card.

## Windows SmartScreen dialog

`data-windows-open` (in the Get started section's Windows card) opens an
accessible dialog built only from the root README's "Manual v0.1.1 release
procedure" section (the planned NSIS installer will be updater-signed but may
remain Authenticode `NotSigned`, so SmartScreen may warn that it's
unrecognized; three steps — open the installer, click More info, click Run
anyway; managed PCs may remove "Run anyway"). Its own CTA is "View releases,"
not a download link.

The dialog's description deliberately stops at what the root README states.
It does **not** add an interpretive line like "that's a signing-reputation
warning, not a malware detection" — that framing is plausible but isn't in
the root README, so it exceeds the claim-sourcing rule. Don't reintroduce it
or any other malware/security characterization.

Implementation notes (`src/main.js`, `src/styles/sections.css`):

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby`/`aria-describedby`,
  hidden via the `hidden` attribute when closed (removed from the a11y tree).
- Opens/closes on click, `Escape`, and backdrop click; traps `Tab`/`Shift+Tab`
  inside the dialog; restores focus to the triggering button on close.
- Unlike the mobile nav overlay (which keeps its own header toggle operable
  on purpose), this is a true top-level modal: `#main`, `.site-footer`,
  `.site-header`, and `.nav-overlay` all become `inert` while it's open, with
  no exceptions, and `inert` is removed again on close.
- Deliberately duplicates the mobile nav overlay's open/close/trap pattern
  instead of extracting a shared helper, so the already-approved nav logic
  stays untouched.
- Uses `var(--z-modal)` (`80`), the top of the documented z-index scale in
  `tokens.css` (`grain 60 < overlay 70 < header 75 < modal 80`), so it always
  renders above the floating header and the mobile overlay.
- If you add a `width` to `.modal__panel` again, put it on `.modal` instead
  (the direct flex child of `.modal-backdrop`) — putting a `min(Npx, 100%)`
  width on a descendant of an auto-sized flex item creates a circular
  percentage dependency that silently stretches the dialog to full width.

## Favicon and OG status

- `public/favicon.svg` is original geometry (a rounded dark plate with an
  8-segment lemon-slice cross-section), not a renamed copy of `iconlp.png`.
  It's the primary `<link rel="icon">`; `lemonpi-mark.png` stays as an
  `alternate icon` fallback for user agents that don't support SVG favicons.
- `public/og.png` (1200×630) was rendered from a standalone HTML file reusing
  the site's real hero styling, palette, and fonts (dark void background,
  fizz glows, gradient headline, lemon mark, Geist/Geist Mono) — not a stock
  image or a screenshot of the live page.
- `og:title`, `og:description`, `og:type`, `og:site_name`, and the Twitter
  title/description equivalents are set. `twitter:card` is `summary`, not
  `summary_large_image` — the large-image card type implies a valid
  `twitter:image`, and this site has no valid *absolute* image URL to give it
  without a confirmed domain. **`og:url`, `<link rel="canonical">`, and an
  absolute `og:image`/`twitter:image` URL are intentionally omitted** —
  inventing a domain here would produce a broken or misleading social
  preview. `index.html` has a comment marking exactly where to add all of
  these (including switching `twitter:card` back to `summary_large_image`)
  once a domain is confirmed; `og.png` itself already exists at `/og.png`
  (1200×630) and needs no further work at that point.

## Deliberately not done

Out of scope for this site, on purpose — do not add these without an explicit
new instruction:

- Legal/privacy/terms pages, analytics, cookies.
- A GitHub API release resolver that rewrites CTA hrefs to a specific asset;
  every release link stays the stable `/releases` index.
- Direct platform download URLs or `/releases/latest`.
- `og:url`, `<link rel="canonical">`, or an absolute `og:image` URL (no
  confirmed domain — see "Favicon and OG status").
- Sandboxing, encryption, privacy, telemetry, or benchmark/performance claims.
- Describing the unbuilt LemonPi bridge extension (the root README's "next
  integration milestone") as shipped.
- Real app screenshots (the hero and capability cards are styled markup, not
  captures — no screenshots exist in the repo to use).

## Isolation

This directory is standalone: its own `package.json`, its own lockfile
(generated by `pnpm install` run from inside `marketing-site/`), and its own
`node_modules`/`dist`, both git-ignored. There is no `pnpm-workspace.yaml` at
the LemonPi repo root, so installing here never touches the root
`pnpm-lock.yaml`. Do not edit anything outside `marketing-site/`.
