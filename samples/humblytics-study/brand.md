# Humblytics homepage: brand study

Taken from humblytics.com on November 13, 2026 (desktop, 1440 px wide), using the browser's computed styles. This is a reference for structure and craft. Their logo, words, customer logos, quotes and screenshots belong to them and aren't reused in the MagpieReply sample.

## The feel

Quiet, gray and precise, with one hot accent. Almost everything is near-black text on light gray. A single orange-red is kept for the main button, one phrase in the headline and the data that matters. Every claim is shown as a small, realistic product mock rather than an illustration.

## Color

| Role | Value |
|---|---|
| Page background | `#F5F5F5` |
| Raised panels (hero frame, final CTA frame) | `#FAFAFA` fading to `#F5F5F5` |
| Cards and mock windows | `#FFFFFF` |
| Card wells (step and feature cards) | `#F4F5F7` |
| Text, headings | `#171717` |
| Text, body | `#404040` |
| Text, secondary | `#525252`, `#737373` |
| Text, faint | `#A3A3A3` |
| Lines | `#E5E5E5`, `#D4D4D4` |
| Secondary button | `#EFEFEF` |
| Accent (headline phrase, bars, logo pixel) | `#DF4000` |
| Accent button | `#C72E00` (hover darker, about `#B33300`) |
| Accent soft fills | `#FFF4ED`, `#FFE1CC` |
| Success dot and check | green, about `#12B76A` |

About 90% of the page is gray. The accent shows up about five times per screen.

## Type

- **Font:** Inter for everything (variable, 100 to 900). Caveat (handwritten) is loaded for small notes. Mona Sans is loaded but barely used.
- **Weight:** headings are 500, never bold. That restraint is a big part of the look.

| Use | Size / line height | Tracking |
|---|---|---|
| H1 | 48 / 52 | -1.68 px (-0.035em) |
| H2 | 36 / 42 | -1.08 px (-0.03em) |
| H3 (card titles) | 20 / 28 | -0.2 px |
| Lede | 17 / 30 | normal |
| Body | 15 to 16 | normal |
| Labels in mocks | 11 to 13 | normal |
| Group labels (FAQ) | 12, uppercase, wide tracking | +0.1em |
| Big stats | about 96 px, weight 400 | tight |

## Shape and depth

- **Corners:** 8 px for buttons and inputs, 12 px for mock windows, 16 px for cards, 24 px for the big framed panels. Badges and tags use 5 to 6 px. Avatars are round.
- **Borders:** almost none. Edges come from 1 px ring shadows (`0 0 0 1px rgba(0,0,0,.06)`) plus a soft drop (`0 6px 14px -6px rgba(0,0,0,.14)`). The accent button area gets a warm glow (`0 24px 48px -16px rgba(150,45,0,.22)`).
- **Texture:** dot grids at the edges of cards, and a pixel-square mosaic as the footer's last row. The logo itself is a pixel staircase with one accent pixel.

## Components

- **Nav:** sits inside the rounded hero frame. Logo on the left, centered links with chevrons for menus, then "Log in", a white "Connect agent" pill-ish button with a menu, and the accent "Start free" button.
- **Buttons:** 15 px, weight 500, 40 to 44 px tall. Dark `#171717` is the primary action in forms and section headers. Accent fill for "Start free" and sign-up. Light gray `#EFEFEF` for secondary.
- **URL form:** a wide white input with a globe icon, paired with a dark button ("Audit my page"). It appears in the hero and again in the closing CTA.
- **Section header:** H2 and one-line lede on the left, a dark button on the right, on the same baseline.
- **Step and feature cards:** a gray well with a number or a small tinted icon tag, a title, one line, then a realistic white mock window that is cut off at the bottom edge.
- **Mock windows:** fake browser bars, chat transcripts with checkmarked steps, A/B result tables, funnel bars, heatmap dots, attribution rows, each labeled "Example data".
- **Comparison:** "The old way" (gray, slightly messy stacked rows with day counts and waiting tags) next to "With Humblytics" (white, tidy rows with times and green checks, ending in one big accent button: "Yes, start test 1").
- **Pricing:** two white cards inside one gray frame, each a list of price rows separated by hairlines, ending with a full-width button.
- **FAQ:** heading and a "Copy as Markdown" button on the left. On the right, questions grouped under small uppercase labels, each row with a plus icon.
- **Footer:** a bordered table. The top row holds the logo, tagline and social links. Below are 4 columns of links in cells, then a bottom row of cells (copyright, changelog, FAQ, privacy, terms, DPA, AI info), then the pixel mosaic.

## Page structure

1. Hero frame: nav, two-line H1 with the second line in accent, a lede with inline app icons, the URL form, an "works with any agent" line and a pricing fine print line.
2. Proof strip: 8 customer logos in gray, then one line with an avatar, a short quote, a name and a result.
3. How it works: section header, then 4 numbered step cards in a 2 by 2 grid, each with a mock.
4. Results: section header, then one big stat with a long quote on the left and two smaller stat-and-quote blocks on the right, plus "See all customer stories".
5. Features: section header, then 4 tagged feature cards in a 2 by 2 grid (A/B tests, funnels, heatmaps, revenue attribution).
6. Old way vs new way: two side-by-side panels.
7. Pricing: "Start testing for free", two plan cards.
8. FAQ: grouped questions.
9. Closing CTA frame: H2, lede, the URL form again, the same two small lines.
10. Footer table and pixel mosaic.

## Voice

Short, plain sentences about outcomes ("Turn more of your traffic into revenue", "Find the fix, test it, keep the winner"). Numbers everywhere, always with a unit and a source ("Example data", "revenue in 90 days"). Second person. The product is framed as doing the work while you approve ("You do one thing").
