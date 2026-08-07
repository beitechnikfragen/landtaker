# UI mockups

Static design mockups for the Landtaker UI redesign. These are **not** part of
the app — nothing imports them and no build step touches them. They exist as
the reference the real screens were built against, so a later change can be
checked against the intent rather than guessed at.

| File          | Screen                                                  |
| ------------- | ------------------------------------------------------- |
| `home.html`   | Home page: hero, account rail, map-led lobby cards      |
| `ingame.html` | In-game HUD: standings, event feed, control bar, radial |

## Viewing them

They need to be served over HTTP — opening them from the filesystem leaves the
images blank, because `file://` blocks the sibling asset loads.

```bash
cd docs/design/mockups && python -m http.server 8899
```

Then open `http://localhost:8899/home.html`.

## What is real and what is not

The mockups predate the implementation and were drawn before the data model
was checked, so parts of them describe data that does not exist:

- The home rail's **season block** has no backing data. Wins, losses and recent
  matches _do_ exist and are served by `/users/@me`.
- The in-game HUD's **event feed** is real — the game already carries 22
  message types across 5 categories, see `TIER_1_TYPES` in
  `src/client/hud/layers/EventsDisplay.ts`.
- Copy in the mockups ("Take the map. Hold it.", "Deploy") is placeholder.
  The shipped UI keeps the existing translated strings instead.

Treat them as layout and visual reference, not as a specification.
