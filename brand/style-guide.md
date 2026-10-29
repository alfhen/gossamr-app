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
| `brand/gossamr-icon.svg` | The app icon and the mark at 64 px and up |
| `brand/gossamr-icon-small.svg` | 16 to 32 px: the G with Pip as a single teal dot, no legs, no thread |
| `brand/pip.svg` | Pip alone, for places that are about Pip rather than about Gossamr |

The app icons in `src-tauri/icons/` are generated from these with `./scripts/app-icon.sh`. Never edit the PNGs.

### Rules

- Use the small version below 64 px, the favicon included. Pip's legs and thread blur at those sizes.
- Keep the mark on its ink square (`#14131d`). On a light page, the square itself gives the contrast; do not draw the G in dark ink on white.
- Clear space around the mark is at least a quarter of its width.
- Do not recolour the G or Pip, add gloss, gradients beyond the G's faint lavender, outlines or shadows, or rotate the mark.
- Do not separate Pip from its thread, or hang Pip anywhere but inside the G.
- Do not use gold or amber in the brand. Amber is the app's warning colour.

### Wordmark

"Gossamr", one word, capital G, no "e" before the final r. Set it in the system sans at semibold, in ink (`#1b1a2b` on light, `#eeedf8` on dark). Place the mark to its left at the height of the cap plus descender, with a gap of half the mark's width. Do not replace the wordmark's G with the mark.

## Colour

Gossamr is ink-indigo with one teal character. Every colour below is a token in `src/workspace/theme.css`.

### Brand core

| Name | Value | Role |
| --- | --- | --- |
| Ink | `#14131d` | The dark window, the icon's square, the site's dark sections |
| Silk | `#eeedf8` | The G, and text on ink |
| Lavender | `#c8c2ff` | The faint end of the G's gradient; never on its own as text |
| Pip teal | `#37d0c0` dark, `#0b8a86` light | Pip, and only Pip |
| Indigo | `#6a82ff` dark, `#4a5be0` light | The person's own actions: focus, selection, primary buttons, links |
| Violet | `#9a8bff` dark, `#5b4bd1` light | Pip's second colour: the end of its gradient and its legs |

### Interface tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `ws-win` | `#fcfbfe` | `#14131d` | Window and page background |
| `ws-side` | `#ecebf4` | `#1c1b2a` | Sidebar and rail |
| `ws-bar` | `#f4f3f9` | `#191826` | Bars, footers, quiet panels |
| `ws-ink` | `#1b1a2b` | `#eeedf8` | Body text |
| `ws-ink2` | `#575672` | `#b1b0c8` | Secondary text |
| `ws-ink3` | `#8c8ba6` | `#7b7a96` | Meta text: times, counts, hints |
| `ws-sep`, `ws-sep2` | indigo at 10% and 18% | lavender at 10% and 18% | Hairlines and borders |
| `ws-hover`, `ws-sel` | indigo at 5% and 7.5% | lavender at 7% and 10% | Hover and selected rows |
| `ws-accent` | `#4a5be0` | `#6a82ff` | The person's actions |
| `ws-pip`, `ws-pip2` | `#0b8a86`, `#5b4bd1` | `#37d0c0`, `#9a8bff` | Pip and Pip's drafts |
| `ws-done` | `#1f9d6a` | `#1f9d6a` | Done |
| `ws-blocked` | `#e0475b` | `#e0475b` | Failed, blocked |
| `ws-review` | `#8a55d6` | `#b48af0` | In review |
| `ws-warn` | `#c98a1b` | `#c98a1b` | Needs attention |

`ws-accent`, `ws-pip`, `ws-done`, `ws-blocked` and `ws-review` each have a `-soft` fill (10 to 22% opacity) for backgrounds behind their text. `ws-review-soft` is a slightly lighter purple than `ws-review`. `ws-warn` has no soft fill.

### Rules

- **Teal means Pip.** Pip's avatar, Pip's drafts (a dashed teal border on a teal-soft fill), the "Ask Pip" button. Nothing else is teal, so a person can see at a glance what Pip made.
- **Indigo means you.** Focus rings, selection, primary buttons and links.
- **State colours mean state.** Never use green, red, purple or amber for decoration.
- Set colours through the tokens, never as raw hex in components.
- Design both themes at once. The app follows the system setting unless the person picks one.

### Contrast

Measured against the window colour:

| | Light | Dark |
| --- | --- | --- |
| `ws-ink` | 16.6 | 15.9 |
| `ws-ink2` | 6.8 | 8.7 |
| `ws-ink3` | 3.2 | 4.4 |
| `ws-accent` | 5.3 | 5.5 |
| `ws-pip` | 4.1 | 9.6 |
| `ws-warn` | 2.9 | |

So: body and secondary text pass AA everywhere. `ws-ink3` and light-mode `ws-pip` are below 4.5, so use them for meta text, icons, borders and bold or large text, never for a sentence a person must read. `ws-warn` is for icons and fills; text about a warning stays in ink.

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

Two weights: regular and semibold (600). Bold is for counts in badges. Sentence case everywhere: titles, buttons, menus. No all-caps labels.

### On gossamr.app

The same family, so the site and the app feel like one thing. A larger scale for reading at a distance:

| Use | Size / line height | Weight |
| --- | --- | --- |
| Hero heading | 56 / 60 px (36 / 40 on phones) | 600, letter-spacing −0.02em |
| Section heading | 32 / 38 px (26 / 32) | 600, −0.01em |
| Lead paragraph | 21 / 32 px (18 / 28) | 400 |
| Body | 17 / 28 px | 400 |
| Small | 14 / 20 px | 400 |

Keep a line of body text under about 70 characters.

## Space, shape and depth

- **Spacing** steps by 4 px. Rows and controls mostly use 8 px gaps and 8 to 12 px side padding.
- **Corners:** 4 to 6 px on controls and rows, 6 to 10 px on cards and sheets, full rounding on pills, badges and avatars. The app icon's square uses the macOS shape.
- **Lines, not boxes.** Separate with `ws-sep` hairlines. Use a border only where something is a distinct object (a card, a field, a draft).
- **Shadow** only on things that float: popovers, the palette, toasts, Pip's launcher (`shadow-ws-pop`). Lists and cards lie flat.
- **Density:** the app is compact, like a Mac utility. The site can breathe: section padding of 96 to 128 px on desktop, 64 px on phones.

## Motion

Motion is quick and quiet in the interface and slow and gentle on Pip.

| Where | Duration | Easing |
| --- | --- | --- |
| A sheet slides in | 220 ms | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| A sheet slides out | 160 ms | ease-in |
| A popover appears | 150 ms | ease-out |
| Hover and focus colours | 120 ms | linear |

Pip's own vocabulary, in `src/workspace/pip.css`:

- **Dangle:** the launcher sways 5 px down and back over 5 s.
- **Bob:** while Pip works on an answer, it bobs 6 px every 0.6 s and its legs scuttle.
- **Blink** about every 5 s, and an occasional leg twitch every 7 to 9 s.
- **Gaze:** the eyes follow the pointer.

Cobwebs gather on cards in stages as a ticket goes untouched (after 2, 3, 5, 7 and 10 days; sooner for tickets waiting on someone). They are the one place Gossamr comments on the work, and only with a picture.

Every animation stops for `prefers-reduced-motion`, and Pip pauses while the window is hidden. Nothing important is said only through motion.

## Pip

Pip is Gossamr's one character: a round teal spider with two eyes, friendly rather than insect-like.

- **In the app**, Pip is the animated avatar (`PipAvatar.tsx`): a teal-to-violet body, eight legs, eyes that blink and follow the pointer.
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

- **Dark first.** The hero sits on ink `#14131d`, with the mark and the wordmark. Pip, inside the mark, is the hero's one teal thing. Light sections follow for reading, on `#fcfbfe`.
- **One teal thing per screen**, and it is Pip. Calls to action are indigo.
- **Real screenshots** of the app, in both themes, never mock-ups that the app doesn't match. Crop to one idea each: a draft card, Needs you, Pip's pane.
- **Claims must be true** and plain: drafts are the gate, the cache works offline, agents use your own Claude Code setup, it's for Jira and GitHub on macOS. Linear only once it ships.
- **Motion:** Pip may bob once on its thread as the page loads. The rest of the page does not move on scroll. Respect reduced motion.
- **Layout:** content at most 1120 px wide, text columns at most 680 px, 16 px side gutters on phones and no sideways scrolling.
- **Favicon:** the small mark (`gossamr-icon-small.svg`). The social image is the full mark on ink with the wordmark beside it.
- **Accessibility:** AA contrast for all text, a visible indigo focus ring, alt text that says what a screenshot shows, and every action reachable by keyboard.
