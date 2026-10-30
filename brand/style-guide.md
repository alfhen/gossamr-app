# Gossamr style guide

How Gossamr looks, moves and speaks, in the app and on gossamr.app. The values here come from the app's own code; where the code and this guide disagree, fix one of them.

A visual version of this guide, with the colours, the icon and the type set out, is [style-guide.html](style-guide.html). It renders from disk with no network.

## The idea

Gossamer is the fine silk of a spider's web. Gossamr takes the many fine threads of a person's work (tickets, branches, agents, pull requests) and holds them in one light, strong web, with Pip at the centre.

The personality is **calm, quiet, precise, and a little playful**. Gossamr is a tool a person lives in all day. It is never loud, and it never sells itself as "AI". The play is small and earned: Pip blinks, and cobwebs gather on tickets nobody has touched.

## Logo

### The mark

A silk **G**, with **Pip**, a small teal spider, hanging into the G on a hairline thread. Pip is the only bright point.

| File | Use |
| --- | --- |
| `brand/gossamr-icon.svg` | The app icon: ink square, a silk-glass G and Pip as a dew bead |
| `brand/gossamr-icon-small.svg` | 16 to 32 px: the same icon with Pip as a single dew bead, no legs, no thread |
| `brand/pip.svg` | Pip alone, for places that are about Pip rather than about Gossamr |

The app icon is the one place the mark takes gloss: the G is frosted silk with a bright edge and a soft shadow, and the ink square carries a faint teal glow behind Pip. It uses plain gradients and no SVG filters, because WebKit renders filters at low resolution. Where the mark appears in one colour or on a page, it stays flat.

The app icons in `src-tauri/icons/` are generated from these with `./scripts/app-icon.sh`. Never edit the PNGs.

### Rules

- Use the small version below 64 px, the favicon included. Pip's legs and thread blur at those sizes.
- Keep the mark on its ink square (`#14131d`). On a light page, the square itself gives the contrast; do not draw the G in dark ink on white.
- Clear space around the mark is at least a quarter of its width.
- Do not recolour the G or Pip, add gloss, gradients beyond the G's faint lavender, outlines or shadows, or rotate the mark. The app icon is the only exception to the gloss rule.
- Do not separate Pip from its thread, or hang Pip anywhere but inside the G.
- Do not use gold or amber in the brand. Amber is the app's warning colour.

### Wordmark

"Gossamr", one word, capital G, no "e" before the final r. Set it in the system sans at semibold, in ink (`#2b2621` on light, `#e9e2d6` on dark). Place the mark to its left at the height of the cap plus descender, with a gap of half the mark's width. Do not replace the wordmark's G with the mark.

## Colour

Gossamr is warm silk with one teal character: ivory in light, warm charcoal in dark, and indigo for the person. Every colour below is a token in `src/workspace/theme.css`.

### Brand core

| Name | Value | Role |
| --- | --- | --- |
| Ink | `#14131d` | The icon's square and the site's dark sections |
| Silk | `#eeedf8` | The G, and text on ink |
| Lavender | `#c8c2ff` | The faint end of the G's gradient; never on its own as text |
| Pip teal | `#76c8cb` dark, `#16737a` light | Dew teal: Pip, and only Pip |
| Indigo | `#8f98f0` dark, `#4b55c0` light | The person's own actions: focus, selection, primary buttons, links |
| Violet | `#a99cf0` dark, `#5f54b8` light | Pip's second colour: the end of its gradient and its legs |

### Interface tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `ws-win` | `#faf7f2` | `#1c1a17` | Window and page background |
| `ws-side` | `#efe9e0` | `#24211d` | Sidebar and rail |
| `ws-card` | `#fffdf9` | `#2b2723` | Board cards: a step above the lane they sit in |
| `ws-sheet` | `#fffdf9` | `#24211d` | The peek and Pip's pane bodies |
| `ws-bar` | `#f5f0e8` | `#201d1a` | Bars, footers, quiet panels |
| `ws-ink` | `#2b2621` | `#e9e2d6` | Body text |
| `ws-ink2` | `#5e564c` | `#b6ad9f` | Secondary text |
| `ws-ink3` | `#776e62` | `#90877b` | Meta text: times, counts, hints |
| `ws-sep`, `ws-sep2` | brown at 11% and 19% | cream at 9% and 16% | Hairlines and borders |
| `ws-hover`, `ws-sel` | brown at 5% and 8% | cream at 5% and 8% | Hover and selected rows |
| `ws-accent` | `#4b55c0` | `#8f98f0` | The person's actions |
| `ws-pip`, `ws-pip2` | `#16737a`, `#5f54b8` | `#76c8cb`, `#a99cf0` | Pip and Pip's drafts |
| `ws-done` | `#2e7d4f` | `#6dbf8b` | Done |
| `ws-blocked` | `#bf4339` | `#e77d72` | Failed, blocked |
| `ws-review` | `#7d4cb8` | `#bf9cec` | In review |
| `ws-warn` | `#b07614` | `#d6a04a` | Needs attention |
| `glass-tint` | silk `#f6e2c4` at 14% | silk `#ffe4be` at 5% | The faint colour over glass |
| `glass-tint-pip` | Dew teal `#76c8cb` at 12% | Dew teal at 6% | The same, on Pip's surfaces |
| `glass-body`, `glass-body-regular` | ivory at 22% and 58% | warm charcoal at 38% and 60% | Clear and regular glass body |
| `glass-filter` | `blur(6px) saturate(1.5) brightness(1.04)` | `blur(8px) saturate(1.4) brightness(0.92)` | What the glass does to the backdrop |
| `glass-rim`, `glass-rim-pip` | warm white ring, 95% to 5% to 55% | cream ring, 45% to 2% to 22%; teal on Pip | The 1 px edge light |
| `glass-inner`, `glass-inner-pip` | warm white at 75% above, ink at 6% below | cream at 16% above; teal on Pip | Light inside the edge |
| `glass-depth` | `0 10px 30px` brown at 16% | `0 12px 40px` black at 50% | The shadow |
| `glass-lens`, `glass-lens-rim` (and `-pip`) | ivory at 45%, rim warm white at 85% | cream at 8%, rim at 28%; teal on Pip | Selection inside glass |
| `glass-body-control` | ivory at 62% | cream at 7% | The body of a control's glass, a little stronger than a floating layer's |
| `ctl-depth` | `0 1px 2px` and `0 3px 10px -3px` brown at 10% and 16% | `0 1px 2px` and `0 4px 12px -4px` black at 50% and 60% | The small shadow under a control |
| `thumb-glass` | ivory at 90% | cream at 16% | The lens that slides in a segmented control |
| `prominent` | `#4b55c0` | `#4b55c0` | The fill of the one main action; white text on it reaches 6:1 in both themes |
| `well-shade`, `bead-top`, `bead-bottom` | brown at 7% inside; white at 28% above, ink at 18% below | black at 35% inside; white at 20% above, black at 25% below | A sunken switch track, and the light on a prominent fill |
| `bead-gloss`, `silk-top` | white at 50% on the top edge; white at 95% | white at 6%; lavender at 8% | The light on a small bead, and on the top edge of a lens or raised surface |
| `spring-dew`, `spring-silk` (and `-ms`) | 340 ms, no bounce; 770 ms, 4% give | the same | Easing for controls; the full set is in the proposal below |

`ws-accent`, `ws-pip`, `ws-done`, `ws-blocked` and `ws-review` each have a `-soft` fill (10 to 22% opacity) for backgrounds behind their text. `ws-review-soft` is a slightly lighter purple than `ws-review`. Done moved from 156 to 145 degrees of hue, a leaf green, because Pip's Dew teal sits at 184 degrees: the gap is now 39 degrees, up from 20, so the two read apart at a glance. `ws-warn` has no soft fill.

### Rules

- **Teal means Pip.** Pip's avatar, Pip's drafts (a dashed teal border on a teal-soft fill), the "Ask Pip" button. Nothing else is teal, so a person can see at a glance what Pip made.
- **Indigo means you.** Focus rings, selection, primary buttons and links.
- **State colours mean state.** Never use green, red, purple or amber for decoration.
- Set colours through the tokens, never as raw hex in components.
- Design both themes at once. The app follows the system setting unless the person picks one.

### Contrast

Measured against the window colour (`ws-win`):

| | Light | Dark |
| --- | --- | --- |
| `ws-ink` | 14.0 | 13.5 |
| `ws-ink2` | 6.7 | 7.8 |
| `ws-ink3` | 4.7 | 4.9 |
| `ws-accent` | 5.8 | 6.5 |
| `ws-pip` | 5.2 | 9.0 |
| `ws-done` | 4.7 | 7.8 |
| `ws-blocked` | 4.8 | 6.3 |
| `ws-review` | 5.5 | 7.6 |
| `ws-warn` | 3.6 | 7.4 |

So: against the window, body, secondary and meta text, indigo, blocked and review pass AA in both themes. Light-mode `ws-ink3` on `ws-side` and `ws-bar` is about 4.2, so in the sidebar and rail it stays for short meta only. Light-mode `ws-warn` is below 4.5 too: it is for icons and fills, and text about a warning stays in ink.

## Type

### In the app

The system font: `system-ui, -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif`, and `ui-monospace, "SF Mono", Menlo, monospace` for code, keys and ids.

| Token | Size | Use |
| --- | --- | --- |
| `text-xs` | 11 px | Meta: times, counts, badges, footers |
| `text-sm` | 12 px | Most UI text: rows, buttons, cards |
| `text-base` | 13 px | Reading text: ticket bodies, Pip's answers |
| `text-lg` | 15 px | Section and sheet titles |
| `text-xl` | 21 px | Screen titles, rarely |
| Label | 12 px (`text-sm`), semibold, `ws-ink2` | Section and group labels above lists and fields |

Two weights: regular and semibold (600). Bold is for counts in badges. Sentence case everywhere: titles, buttons, menus, labels. No all-caps and no letter-spacing on labels.

Screen and sheet titles (the project title in the header, Settings and its sections, Inbox, Work, Connect GitHub, the peek's ticket and draft titles, Pip's name in the pane) are set in SF Pro Rounded through `font-display` (`--font-display`). Each keeps the size it already has (13 to 22 px); the size table is for body text. Group headings in the palette use the label style, `ws-ink2`. Status lozenges are 12 px. Everything else stays in the system text face.

### On gossamr.app

Headings, like the app's titles, are set in SF Pro Rounded (`ui-rounded`), the Mac's rounded system face. Its round strokes and terminals match the silk G and Pip, and it is still the system family, so the site and the app feel like one thing. Body text stays in SF Pro Text. Safari and the app's WebKit have `ui-rounded`; other browsers fall back to the regular system face, which is fine.

The scale is a perfect fourth (×1.333) from 17 px:

| Use | Size / line height | Face and weight |
| --- | --- | --- |
| Hero heading | 71 / 72 px (53 / 56 on phones) | Rounded, 600, letter-spacing −0.03em |
| Section heading | 40 / 48 px (30 / 38) | Rounded, 600, −0.015em |
| Subheading | 23 / 30 px (21 / 28) | Rounded, 600 |
| Lead paragraph | 23 / 34 px (19 / 29) | Text, 400 |
| Body | 17 / 28 px | Text, 400 |
| Small | 13 / 20 px | Text, 400 |

Keep a line of body text under about 70 characters.

## Space, shape and depth

- **Spacing** steps by 4 px. Rows and controls mostly use 8 px gaps and 8 to 12 px side padding.
- **Corners:** full rounding on controls, pills, badges and avatars; 6 to 7 px (`rounded-md`) on rows and menu items; 10 px on cards; 14 to 16 px on sheets. The app icon's square uses the macOS shape.
- **Lines, not boxes.** Separate with `ws-sep` hairlines. Use a border only where something is a distinct object (a card, a field, a draft).
  - The peek's sections (Description, Links, Development, Comments, History) are not boxes: a hairline above each, a sentence-case 12px header with a count bead, and the content below. Comments are rows divided by hairlines. The comment field stays a sunken well.
  - The peek and Pip's pane are floating sheets: 8 px in from the window's edges, 16 px corners, a `ws-sheet` body, the glass rim and the glass depth. Their headers stay put while the content scrolls under a 16 px fade. The peek's header holds the ticket key alone, a Segmented control that jumps between sections and a ButtonGroup that expands or closes it; the parent ticket is in the body. Pip's header stays teal glass and its chips use the lens. The classes are `ws-sheet` (the body, rim and depth), `ws-sheet-head` (the header; `data-under` drops its hairline once the content scrolls) and `ws-sheet-fade`. The agent run sheet and the other agent sheets use the same shell. The section control shows no selected segment, because it jumps and does not track the scroll, and it carries no section icons.
  - In Pip's pane your messages sit in an indigo lens bubble. Pip's answers are plain text beside a small Pip, with no bubble. The composer stays pinned at the bottom, with the input in a sunken well.
  - Agents are rows, on Work and in Pip's pane: one state bead (indigo where the agent needs you, never teal), role and key, title, branch or last line, plain row actions (Open in Terminal, Stop, Archive) on one wrapping line, and tokens and age at the end. Work's groups are headed by their name with a hairline under it. A group's header ends with its agent count ("3 agents"). A group that holds something for you says "N need you" in its header, with the count in an indigo bead; it has no coloured bar down its side.
  - A selected list row is an indigo lens: `ws-accent-soft` fill, an inset 1px ring of `ws-accent` at 30%, and `silk-top`. A selected card takes the indigo ring. Selection is yours, so it is never teal.
  - State is a bead and a word: an 8 px glossy bead in the state's colour (grey to do, indigo active or needs you, green done, purple review, red blocked, amber failed), then its name in `ws-ink2` at 12px. Status shows this way in list rows, cards, board columns and workstream headings; the tint behind the word is gone, and a count that needs you stays a filled indigo bead.
  - The board's workflow is a thread: one hairline with a bead per stage, sized by its ticket count (6 px, plus 4 px per ticket up to five), the count beside the name, and the moves it allows as its title. A long name wraps to two centred lines; past that the thread scrolls sideways rather than let names overlap.
  - The rail is a glass column inset 6 px from the window's edge (the clear glass fill and rim, no blur, so its tooltips stay fixed). Projects are glossy beads in their full colours. One lens with an indigo rim slides to the current button on `spring-dew`; its icon buttons show the hover lens.
  - Settings groups (connections, watched projects) are hairline groups. Fields, and lists that scroll, keep their box.
- **Shadow** on things that float: popovers, the palette, toasts, Pip's launcher (`shadow-ws-pop`). Controls sit just above their surface and cast a small one (`ctl-depth`). Lists and cards lie flat.
- **Raised and sunken.** Board lanes are wells: `ws-side`, `well-shade` and a `ws-sep` hairline. Cards are raised: `ws-card`, a hairline and `silk-top`, with no shadow at rest. Nearer is lighter in dark, so a card is lighter than its lane in both themes. A stale card's wither tint is mixed over `ws-card` (95%, 90% and 84% card over the three stages, with `#c9a66b` in light and the darker `#8a7248` in dark), so it reads in both.
- **Density:** the app is compact, like a Mac utility. The site can breathe: section padding of 96 to 128 px on desktop, 64 px on phones.

## Motion

Motion in Gossamr has two speeds. The interface moves **quickly and quietly**, so the person never waits for it. Pip and the cobweb spiders move **slowly and gently**, because they are alive. Nothing else in Gossamr has a personality.

### Principles

1. **Motion explains where things are.** The peek slides in from the right because it lives on the right. A menu drops from the button that opened it. If a movement doesn't say where something came from or went, leave it out.
2. **Quick for the interface, slow for life.** Interface motion finishes within 220 ms. Pip and the spiders take seconds.
3. **One thing moves at a time.** Don't stagger lists, cascade cards or animate several regions together.
4. **A loop means working.** Only work in progress loops: the ring on a running agent's dot, Pip spinning its web while it answers, a pending switch's spinner. When the work stops, so does the motion. Pip's idle life (dangle, blink, twitch) is the one exception, and it is slow and irregular on purpose.
5. **No bounce in the interface.** Overshoot and swing belong to Pip and the spiders only.
6. **Never move what the person is reading.** New entries don't push the timeline under the reader's eyes, and counts change without animation.
7. **Motion is never the only signal.** Every state it shows is also shown in words or colour, so turning motion off loses nothing.

### Tokens

The app sets these values directly in its CSS today. On gossamr.app, and in new app CSS, use these names:

| Token | Value | For |
| --- | --- | --- |
| `--motion-instant` | 120 ms | Hover, focus, colour changes, Pip's gaze |
| `--motion-quick` | 150 ms | Popovers, menus, the palette |
| `--motion-standard` | 220 ms | Sheets and panes entering |
| `--motion-exit` | 160 ms | Sheets and panes leaving: exits are shorter than entrances |
| `--motion-settle` | 500 ms | Slow fades: a cobweb clearing, the wither tint changing (600 ms) |
| `--ease-enter` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Things arriving: fast start, soft landing |
| `--ease-exit` | `ease-in` | Things leaving: they accelerate away |
| `--ease-out` | `ease-out` | Small things appearing: popovers, the ring |
| `--ease-life` | `ease-in-out` | Pip and the spiders |

Distances stay small: 40 px for a sheet, 6 px and a 0.98 scale for a popover, 1 px for a hover lift, 5 to 7 px for Pip and the spiders.

### Patterns

| Element | In | Out | Notes |
| --- | --- | --- | --- |
| Peek sheet | Slides 40 px from the right and fades in, 220 ms, enter easing | Slides 40 px right and fades, 160 ms, ease-in | `ws-peek-in`, `ws-peek-out` |
| Popover, menu, palette, dialog | Drops 6 px, scales from 0.98, fades in, 150 ms, ease-out | Disappears at once | `ws-pop` |
| Card hover | Lifts 1 px and gains a soft shadow, 120 ms | Settles back, 120 ms | Not on rows in a list, which include agent rows (they only tint) |
| Selection, hover row, focus ring | Colour change, 120 ms, or none | | Focus rings appear at once |
| Resize handle | The indigo line fades in, 120 ms | | |
| Running agent | A ring grows from the status dot and fades, 1.8 s, ease-out, looping | Stops when the run stops | The only motion on a working run |
| Pending control | A small spinner inside the control | Replaced by the result | Only inside the switch or button that is waiting |
| Pip at work | A web in the answer's place: eight spokes, then the spiral, with Pip crawling it in and back out, a dew bead, 6 s, looping | Lifts 14 px and fades, 500 ms, as the answer appears | `pip-work`, `pip-web-*`, `pip-crawl` in `pip.css`. A spider word (Spinning, Weaving, Untangling, Following a thread, Tying a knot, Mending the web, Gathering dew, Testing the silk, Casting a line, Reeling in) changes every 2.6 s in shuffled order, never the same twice running, and is hidden from screen readers. Under it a plain line of what Pip is doing, with the time after 5 s, is a polite live region. With the pane closed a glass chip beside the launcher carries the same word |
| Cobweb on hover or selection | | Shrinks to 0.4, turns −10° and fades, 500 ms | It clears the card for the person to read |
| Wither tint | Deepens across 600 ms as a stage is reached | | |

### Pip

Pip's motion, in `src/workspace/pip.css`, is what makes Pip a character rather than an icon.

| Motion | Timing | When |
| --- | --- | --- |
| Dangle | 5 px down and back over 5 s, ease-in-out | The launcher, while idle |
| Bob | 6 px up and back every 0.6 s | While Pip works on an answer |
| Scuttle | Legs squash and stretch every 0.3 s | With the bob |
| Blink | A quick close at the end of each 5 s cycle | Always |
| Twitch | One leg turns 8° at the end of a 7 s cycle, another at the end of a 9 s cycle | Always |
| Gaze | The pupils follow the pointer, 120 ms | Always |

The blink and the two twitches run on different periods, so Pip never repeats exactly. Pip reacts to the person but never asks for attention: no waving, no jumping, no motion on new messages. Pip freezes while the window is hidden.

### Cobweb spiders

The spiders on a stale card's web, in `src/components/Cobweb.tsx`, rest for 5 to 18 s at random, then make one move:

| Move | Duration |
| --- | --- |
| Drop down the thread | 2.4 s |
| Climb up the thread | 2 s |
| Swing on the thread | 2.2 s |
| Turn | 1.6 s |
| Twitch the legs | 0.7 s |
| Crawl to another spot (45% of moves) | Climb up the thread in 500 ms, walk at 150 ms per unit (at least 900 ms), drop back in 500 ms |

The cobweb is the one place Gossamr comments on the work, and only with a picture. Cobwebs gather in stages as a ticket goes untouched: after 2, 3, 5, 7 and 10 days, or after 1, 3, 5, 7 and 10 days for a ticket waiting on someone.

### Reduced motion

With `prefers-reduced-motion`, every animation and transition in the app stops, and each one becomes a still state:

| Motion | Becomes |
| --- | --- |
| Sheets, popovers | Appear and disappear in place |
| Running agent's ring | A plain dot in the state's colour |
| Spinners | A still ring |
| Pip | Sits still with open eyes; while it works, the web is drawn and still with Pip on it, the words change without fading and the line still says what Pip is doing ("Reading what happened") |
| Cobweb spiders | Stay at their perch |

Pip and the spiders also pause whenever the window is hidden, whatever the setting.

### On gossamr.app

- **Loading:** one orchestrated moment. The web's threads draw in from the corner over 1.6 s with `--ease-enter`, each starting 60 ms after the last. The dew beads appear as it finishes. Then Pip drops into the G: the thread unspools as Pip lowers 150 px over 1.07 s on `--spring-drop`. After that, only the blink.
- **Scrolling:** nothing moves on scroll. No parallax, no fade-ups, no pinned animations.
- **Hover:** links and buttons change colour in `--motion-instant`. Buttons may lift 1 px; nothing larger.
- **Video:** screen recordings of the real app at real speed, at most 15 s, muted, looping, with a poster frame. Never speed up a recording or add a fake cursor.
- **Reduced motion:** Pip is already in the G when the page loads, and videos show their poster with a play button.

## Controls

Buttons, toggles, segmented controls and search fields are silk glass, grouped into capsules the way the Mac groups toolbar buttons. Use the components in `src/components/`; do not write a local button style. The classes are in `src/components/controls.css`.

| Component | Use |
| --- | --- |
| `Button` | `variant` is `secondary` (clear glass, the default), `primary` (indigo, the one main action on a screen), `quiet`, `pip`, `pipSolid`, `plain` or `danger`. `size` is `sm` (22 px, in rows), `md` (28 px, in bars) or `lg` (32 px, in dialogs and sheets). |
| `ButtonGroup` | Related actions in one capsule with hairlines between them. Needs a `label`. |
| `Segmented` | One choice of several, or a toggle of one. A glass track with a lens that slides on `--spring-dew`. `kind="radio"` is a radio group and the arrow keys move it; the default is a row of pressed buttons. |
| `Switch` | A sunken track that turns indigo when on. The knob turns to a clear lens while held. |
| `SearchField` | A glass capsule for finding things in a list. |

- **Clear glass** is the default button, with the tint, rim and inner light of the glass. In dark its body is cream at 7%, so a control reads as nearer than its bar.
- **Prominent** is always indigo, because the main action is yours. Pip's buttons never take the fill: a tinted fill turns muddy on the warm ground. `pipSolid` exists only for Ask in Pip's own pane.
- **Ask Pip** is the `pip` variant (clear glass with Pip's colour on the label, glyph and edge) in a bar or card, and `plain` with `pip` in a list row. It is never a filled button outside Pip's pane.
- **Plain in rows.** Glass is for bars, sheet headers and dialogs. In a list where the same actions repeat on every row, use `plain`: text and an icon until you point at it.
- **Quiet for what was a link.** An action that used to be an underlined link ("Sync now", "Reset", "Dismiss") is `quiet`: plain text that takes the hover wash. A link that goes somewhere, such as a ticket key or a page on GitHub, stays a link.
- **Icon-only buttons** use `iconOnly` and need an `aria-label`. They are square at the button's height.
- **Raw buttons that stay:** links that go somewhere, card rows and image thumbnails keep their own styling. Anything else with a border, a fill or an underline uses `Button`.
- **Groups.** Stop or remove actions stand alone, set apart from the group beside them, so they are hard to hit by accident. Mark them `destructive`; confirm with `danger`. Its label is white on the light red and dark ink on the lighter dark red (`ws-on-blocked`), so it reaches 4.5:1 in both themes.
- **No blur on controls.** They draw the glass layers without `backdrop-filter`, which spares WebKit a compositing layer for each of a screen's buttons. Over a flat colour it looks the same.
- **No glass on glass.** Inside `ws-glass` (the palette, menus, toasts, Pip's header) a control is a lens.
- **Reduce transparency** makes them solid and keeps their rim; the held switch knob turns solid white.
- Pressing a button, a switch or a segmented control swells it slightly on `--spring-silk`. Under reduced motion it does not move: the swell, the thumb scale and the held knob all stay still.
- The boxes you write in, such as a comment or Pip's box, stay solid wells, because they hold content.

## Proposal: dew and silk glass

**Silk glass (step 3) and controls (step 5) are built; the rest is not.** Springs, dew interactions, reduced-motion handling and threads are still a proposal, so the motion above describes Gossamr as it is. Silk glass is described below as it ships. This section proposes how its motion and surfaces could become more fluid, inspired by dew on a spider's web and by Apple's Liquid Glass. It keeps the principles above; where it changes one, it says so.

### The idea

A web at dawn is the calmest moving thing there is. Dew gathers on the threads, each bead pulled round by surface tension. When a bead grows heavy enough, it lets go and falls, and the thread springs back. Gossamr's work moves the same way: drafts gather, and when the person approves one it lets go and goes out to Jira or GitHub.

Liquid Glass adds the material: floating controls made of a clear, slightly thick glass that bends the content beneath it, catches light on its edge, and flows into new shapes rather than cutting between them.

### 1. Springs instead of curves

Replace the fixed durations and Bézier curves with springs. A spring has no fixed end time, keeps its speed when it is interrupted, and comes to rest the way real things do. CSS can express a spring as a `linear()` easing sampled from the spring's curve:

| Spring | Feel | Settles in | Overshoot | Use |
| --- | --- | --- | --- | --- |
| `--spring-dew` | Firm, no bounce | 340 ms (98% by 220 ms) | None | Sheets, popovers, the palette, hover |
| `--spring-silk` | Soft, a breath of give | 770 ms | 4% | Floating glass layers, Pip's pane, toasts |
| `--spring-drop` | Elastic, alive | 1.07 s | 12.5% | Pip, a bead forming, a thread springing back |

```css
:root {
  --spring-dew: linear(0, 0.12, 0.333, 0.531, 0.686, 0.796, 0.87, 0.919, 0.95, 0.97, 0.982, 0.989, 0.993, 0.996, 0.998, 1);
  --spring-dew-ms: 340ms;
  --spring-silk: linear(0, 0.071, 0.231, 0.418, 0.596, 0.745, 0.86, 0.941, 0.993, 1.023, 1.036, 1.038, 1.035, 1.028, 1.021, 1.014, 1.009, 1.005, 1.002, 1, 0.999, 0.999, 0.999, 1);
  --spring-silk-ms: 770ms;
  --spring-drop: linear(0, 0.086, 0.283, 0.517, 0.736, 0.91, 1.031, 1.099, 1.125, 1.121, 1.099, 1.07, 1.041, 1.017, 1, 0.989, 0.985, 0.984, 0.986, 0.99, 0.994, 0.997, 0.999, 1.001, 1.002, 1.002, 1.002, 1);
  --spring-drop-ms: 1070ms;
  --fall: cubic-bezier(0.11, 0, 0.5, 0); /* gravity: slow to let go, then faster and faster */
}
```

The values are sampled from damped springs: dew is critically damped with a 0.24 s response, silk is damped to 0.72 with a 0.5 s response, and drop to 0.55 with a 0.55 s response. This keeps principle 5 for the interface, since dew has no overshoot. Silk's 4% is a give you feel rather than see, and only drop visibly bounces, which keeps that for living things.

### 2. Dew interactions

| Moment | Today | Proposed |
| --- | --- | --- |
| **Approving a draft** | The card leaves the list | The card **beads**: it draws in to 96% with rounder corners over 120 ms (surface tension). Then it **falls**: 16 px down and fading over 260 ms on `--fall`. The cards below close the gap with `--spring-dew`. The approval reads as a drop letting go. |
| **Skipping or dismissing** | The card leaves the list | The card **evaporates**: it fades and blurs to 4 px over 200 ms, without falling. Nothing was sent, so nothing falls. |
| **Pip makes a draft** | The draft appears | A hairline **thread** draws from Pip's pane to the new card over 400 ms, and a bead forms on the card with `--spring-drop` (scale 0.9 to 1). The thread then fades. Each draft shows where it came from, once. |
| **A new need** | The count changes | The Needs you badge **swells** once, 1 to 1.12 and back on `--spring-drop`, like a bead taking on water. The number itself doesn't animate. |
| **A running agent** | A ring grows from the dot every 1.8 s | A **ripple**: two thin rings, 0.6 s apart, spread and fade over 2.4 s, like a drop landing on still water. Slower and calmer than the ring. |
| **Pip's launcher on hover** | It scales to 108% and tilts | The thread **stretches**: Pip lowers 3 px on `--spring-silk`, as if the person's attention weighs on the silk, and rises again on leave. |
| **Opening a menu or the palette** | Drops 6 px and scales from 0.98 | It **flows from its source**: it starts as a pill the size of the button that opened it and grows into the menu on `--spring-dew`, with the corners settling last. This is Liquid Glass's morph, for the one moment it explains something. |
| **Peek sheet** | Slides 40 px | It slides on `--spring-dew`, and its content follows 30 ms behind the frame, a small **follow-through** that makes the sheet feel like one liquid body rather than a moving box. |

Principle 3 holds: each of these is one element moving, and the follow-through and the closing gap are parts of the same movement.

### 3. Silk glass

A material for the things that float above the work: the palette, menus, popovers, toasts, Pip's pane header and the Ask Pip chip, and the site's navigation. Lists, cards and reading text stay solid. Glass is for controls, never for content.

Pip's launcher is not glass. Pip hangs free on its thread, with only its soft violet shadow, because Pip is a character, not a control in a frame.

Liquid Glass is mostly clear. It takes its colour from what is behind it, blurs only lightly (6 to 8 px) so shapes still show through, and catches light on its rim. Silk glass follows that, with one brand touch: a faint silk tint, warm in both themes.

| Layer | Light | Dark |
| --- | --- | --- |
| Body | Ivory at 22%, with silk `#f6e2c4` at 14% over it | Warm charcoal `#1c1a17` at 38%, with silk `#ffe4be` at 5% over it |
| Backdrop | `blur(6px) saturate(1.5) brightness(1.04)` | `blur(8px) saturate(1.4) brightness(0.92)` |
| Rim | A 1 px light that is brightest at the top-left corner (warm white at 95%), fades to 5% along the sides, and glows again at the bottom-right (55%) | The same in cream: 45%, 2%, 22% |
| Inner light | `inset 0 1px 1px` warm white at 75%, `inset 0 -1px 1px` ink at 6% | `inset 0 1px 1px` cream at 16% |
| Depth | `0 10px 30px` brown at 16% | `0 12px 40px` black at 50% |
| Selection inside | A clear lens: ivory at 45% with its own rim | Cream at 8% with its own rim |
| Pip's surfaces | Dew teal `#76c8cb` instead of silk, at the same strengths | Teal instead of silk |

**How to use it.** The classes are in `src/workspace/glass.css`, and the colours are the `glass-*` tokens in `theme.css`.

- `ws-glass` is the material. Put it on the floating layer itself, never on the element that scrolls.
- `ws-glass-regular` raises the body to ivory at 58% or charcoal at 60%. Use it on any layer that holds `ws-ink2` text, because `ws-ink2` on clear glass misses 4.5:1 over accent and status fills.
- `ws-glass-pip` turns the tint, rim and light teal. Add it to `ws-glass` on Pip's surfaces only.
- `ws-glass-lens` is the selection lens. Put it on the active or selected row.
- `ws-glass-item` gives a row inside glass the lens on hover and keyboard focus.

`ws-glass` does not set `position`, so menus keep their `absolute` or `fixed` utility. A static element needs Tailwind's `relative` added, so the rim has something to sit in. Because `backdrop-filter` makes the panel the anchor for fixed descendants, don't put a fixed child inside glass.

Where it is used:

| Surface | Classes |
| --- | --- |
| Command palette | `ws-glass ws-glass-regular`, rows `ws-glass-lens` |
| Menus: card actions, filter, project list, rail menu, move menu | `ws-glass ws-glass-regular`, rows `ws-glass-item` |
| Rail watched-list popover | `ws-glass ws-glass-regular` |
| Rail tooltips | `ws-glass ws-glass-regular` |
| Toasts | `ws-glass ws-glass-regular` |
| Ask Pip chip | `ws-glass ws-glass-pip ws-glass-regular` |
| Pip pane header | `ws-glass ws-glass-pip ws-glass-regular` |

**Text on glass** is full-strength: `ws-ink` for labels, `ws-ink2` for hints, never `ws-ink3`, and at least medium weight below 14 px.

**Glass needs something behind it.** Over a plain window it reads as a clean, light panel, which is fine. It comes alive over content: the board's cards, the coloured status pills, the dark theme's ink, and on the site, screenshots and the hero's glow. Don't add colour behind glass just to show it off.

**Refraction:** Liquid Glass also bends the content behind its edges like a lens. On the web that takes an SVG filter in `backdrop-filter`, which WebKit, the engine the macOS app runs on, doesn't apply at the time of writing. So in the app, silk glass is tint, blur and light, with no lens. On gossamr.app, refraction can be an enhancement for browsers that support it, on the hero and the navigation only.

**Rules for glass**

- Text on glass must still reach 4.5:1 against the worst content that can sit behind it. If it can't, raise the body to the "regular" strength (ivory at 58%, charcoal at 60%) or make the layer solid.
- When the person turns on Reduce transparency, glass becomes solid `ws-win` and keeps its rim and depth. The app reads the macOS setting itself and follows it as it changes, because WebKit doesn't report `prefers-reduced-transparency`; the site uses that media query where the browser reports it. Glass is solid where `backdrop-filter` is not supported too.
- Never stack glass on glass.
- Teal only on Pip's surfaces, so "teal means Pip" still holds.

### 4. Reduced motion, still

Under `prefers-reduced-motion`, none of the above moves. A bead doesn't fall; the card is simply gone, and the Undo toast says what happened. The ripple is a still dot, and the morph is an instant appearance. Glass stays, because it doesn't move.

### 5. How to get there

1. **Tokens:** add the springs and `--fall` to `theme.css`, and move `ws-pop` and `ws-peek-*` onto `--spring-dew`. This is the smallest step, and the whole app already feels more fluid after it.
2. **Dew:** approve as a falling bead, skip as evaporation, the badge swell and the ripple. One PR, with an e2e check that each still ends in the same state with reduced motion on.
3. **Silk glass (done):** the palette and menus first, then toasts and Pip's pane header. Measure the scroll frame rate on a long list with a menu open before going further.
4. **Threads:** the line from Pip to a new draft, and the morph from source.
5. **gossamr.app:** the hero's Pip drop on `--spring-drop`, refraction on the hero's glass, and the site's navigation in silk glass.

Each step can be stopped without leaving the app half fluid: every step stands on its own.

## Pip

Pip is Gossamr's one character: a round teal spider with two eyes, friendly rather than insect-like.

- **In the app**, Pip is the animated avatar (`PipAvatar.tsx`), drawn as a dew bead: a teal-to-violet body with a soft highlight and a white rim that catches light, a smaller bead for a head, a small smile, eight thin legs, and eyes whose pupils carry a catchlight and follow the pointer. Gloss belongs to Pip's bead and the app icon only; the flat mark stays flat.
- **In text**, Pip has its own glyph (`PipGlyph.tsx`): a spider on its thread, with a bead and two eyes cut out of it. It takes the colour of the text around it and is 1em tall, so it stands where a symbol would: the Pip button in the rail, Pip's drafts and their badges, "Ask Pip" in the palette, on a text selection, on the Work and ticket buttons and in a run result, and the "Pip asks you" box. The four-point spark stays only for a run that is working. It replaced the four-point star (✦), which says "AI" on every product that uses it. Gossamr never sells itself as AI, so what marks Pip's work is Pip.
- **In the brand**, Pip is the flat mark (`brand/pip.svg`): a flat teal body, two eyes, four legs.
- Pip appears where Pip acts or speaks: the launcher, the pane, Pip's drafts. It is not decoration, and it never appears on errors as a joke.
- Pip is "Pip", never "the AI", "the bot" or "the assistant" in the interface.

## Voice

Gossamr writes like a careful colleague: plain, short and exact.

- **Address the person as "you".** Pip is "Pip". Agents are "agents", with their role as a label: "the reviewer".
- **Use the app's own words**, always the same way: workstream, agent, draft, Needs you, Inbox, Work, Board, List.
- **One idea per sentence**, in the active voice. Say what happened and what the person can do.
- **One line per empty state.** No explainers, no glossary. Pip explains anything else when asked.
- **Say two facts once, in Settings,** and nowhere else:
  - Gossamr posts nothing to Jira or GitHub until you approve it.
  - Agents run with your own Claude Code settings, so they can push branches and use your own tools.
- **One status word** per workstream: Needs you, Failed, Running, Done or Idle.
- **Buttons are verbs** that name the result: "Approve", "Post review", "Open in Terminal", "Ask Pip".
- **Errors** say what failed and what to do next, without blame and without apology: "Claude asks you once per folder before it will work there."
- **Keys** are written as the Mac shows them: ⌘J, ⌘K, ↵, Esc, F6, and single letters in lower case (j, k).

Avoid: "magic", "supercharge", "seamless", "effortless", "AI-powered", "revolutionise", exclamation marks, emoji in the interface, and anything Gossamr cannot actually do.

| Not this | This |
| --- | --- |
| Oops! Something went wrong 😕 | Couldn't reach Jira. Check your connection, then Sync now. |
| Let our AI supercharge your workflow | Tell Pip what you want done. |
| You have no items in this view yet. Items will appear here once... | Nothing needs you. |
| Click here to approve the draft | Approve |

## Keyboard

Gossamr is keyboard-first, and the site should show it.

- Every shortcut lives in one table, `src/lib/keys.ts`; handlers, footers and the keys shown on buttons read it.
- Plain keys never fire while the person types in a field.
- Show a key where its action is, in the mono font on a `ws-bar` chip with a `ws-sep2` border.
- The keys worth showing first: ⌘J for Pip, ⌘K to jump, j and k to move, ↵ to open, Esc to close.

## gossamr.app

The site is the app's front door, so it uses the app's colours, type and voice, and shows the real app.

- **Dark first.** The hero sits on ink `#14131d`: a silk web drawn in from the top-right corner, with glass dew beads on its threads, and the mark and the wordmark set left. Pip, inside the mark, is the hero's one teal thing. Light sections follow for reading, on `#fcfbfe`. The style guide's own page shows this hero.
- **Not cards.** Prose is set as prose and definition lists. Boxes are for things a person can touch: demos, screenshots, controls.
- **One teal thing per screen**, and it is Pip. Calls to action are indigo.
- **Real screenshots** of the app, in both themes, never mock-ups that the app doesn't match. Crop to one idea each: a draft card, Needs you, Pip's pane.
- **Claims must be true** and plain: drafts are the gate, the cache works offline, agents use your own Claude Code setup, it's for Jira and GitHub on macOS. Linear only once it ships.
- **Motion:** as set out under [Motion, on gossamr.app](#on-gossamrapp-1). The web draws in, then Pip drops into the G once, and nothing moves on scroll.
- **Layout:** content at most 1120 px wide, text columns at most 680 px, 16 px side gutters on phones and no sideways scrolling.
- **Favicon:** the small mark (`gossamr-icon-small.svg`). The social image is the full mark on ink with the wordmark beside it.
- **Accessibility:** AA contrast for all text, a visible indigo focus ring, alt text that says what a screenshot shows, and every action reachable by keyboard.
