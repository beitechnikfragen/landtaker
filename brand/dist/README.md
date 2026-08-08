# Landtaker Logo Pack & Social Kit

Generated — do not edit by hand. Everything here is built from the master SVGs
in `brand/images/logo/` by:

```bash
python brand/src/make_logo_pack.py
```

Change a master, rerun, commit the result. Editing a file in `dist/` directly
means the next build silently reverts it.

Licence: see `brand/LICENSE`. These assets are **not** under the AGPL that
covers the source, and are not to be reused outside Landtaker.

## Palette

| Role   | Hex       | Used for                      |
| ------ | --------- | ----------------------------- |
| Light  | `#e8ecef` | Outlines, rims, wordmark      |
| Ink    | `#0d1013` | Fills, dark backgrounds       |
| Orange | `#ff8a1f` | The single accent (territory) |
| Slate  | `#333c45` | Hairline seams only           |

## Lockups

| Name                | Use                                              |
| ------------------- | ------------------------------------------------ |
| `mark`              | Icon alone — avatars, favicons, app icon         |
| `wordmark`          | Text alone — where the icon already appears      |
| `lockup-horizontal` | Icon + text side by side — headers, wide banners |
| `lockup-stacked`    | Icon above text — square and tall formats        |

## Variants

| Variant      | Use                                                     |
| ------------ | ------------------------------------------------------- |
| `color`      | Default. Full artwork, for dark backgrounds.            |
| `on-light`   | Light outlines swapped to ink, for light backgrounds.   |
| `mono-light` | One-colour silhouette in `#e8ecef`, cut-outs preserved. |
| `mono-ink`   | One-colour silhouette in `#0d1013`.                     |

The mono variants are a real silhouette with the interior detail punched out —
not a flat recolour, which would weld the outlines to the fill and turn the mark
into a blob. Use them for embroidery, single-colour print, stamps, and anywhere
the artwork must survive one ink.

## Layout

```
svg/<lockup>/<lockup>-<variant>.svg      vector, scales to anything
png/<lockup>/<lockup>-<variant>-<N>w.png raster at N px wide
favicon/                                 favicon-16 … 512, .ico, apple-touch
social/plain/                            logo on brand ink + orange rule
social/light/                            logo on #e8ecef + orange rule
social/map/                              logo over a dimmed map backdrop
social/transparent/                      logo only, no canvas
```

## Social sizes

| File             | Size      | Where                      |
| ---------------- | --------- | -------------------------- |
| `avatar-400`     | 400×400   | Discord, X, generic        |
| `avatar-512`     | 512×512   | Steam, YouTube             |
| `avatar-1024`    | 1024×1024 | High-dpi source            |
| `og-1200x630`    | 1200×630  | Open Graph / link previews |
| `x-banner`       | 1500×500  | X header                   |
| `youtube-banner` | 2048×1152 | YouTube channel art        |
| `discord-banner` | 960×540   | Discord server banner      |
| `post-square`    | 1080×1080 | Instagram, feed posts      |
| `post-story`     | 1080×1920 | Stories, Shorts, Reels     |

The YouTube banner keeps everything inside the 1546×423 safe box, so it survives
the crop on phones — the full 2048×1152 is only ever shown on desktop.

## Favicons

Sizes below 32px use a reduced cut of the mark — shield plus territory, with the
map seams, rocket and cloud removed. At 16px those details average into mush and
the icon stops being recognisable; the reduced version holds the silhouette and
the accent colour, which is what identifies it at tab size. 32px and up use the
full artwork.

`apple-touch-icon.png` is deliberately opaque: iOS composites transparent icons
onto white, which erases the light outlines.
