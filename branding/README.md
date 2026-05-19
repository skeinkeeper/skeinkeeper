# Branding

Logo and icon assets for Skeinkeeper. All files are released under the project's [Apache 2.0 license](../LICENSE) and may be used to refer to the project.

## Files

| File           | Size      | Use                                                                                   |
| -------------- | --------- | ------------------------------------------------------------------------------------- |
| `icon.png`     | 1254×1254 | Master file. Source of truth; downsample from this for new sizes.                     |
| `icon-512.png` | 512×512   | Apple touch icon; large app icons.                                                    |
| `icon-192.png` | 192×192   | Android home-screen icon; PWA manifest.                                               |
| `icon-64.png`  | 64×64     | Small UI placements; GitHub repo avatar.                                              |
| `favicon.png`  | 32×32     | Browser tab favicon.                                                                  |
| `wordmark.png` | 900×220   | Horizontal lockup with the Skeinkeeper name and tagline. README banner; social cards. |

## Design notes

The mark is three rings tightly bound in hemp twine, with loose draping loops and a trailing thread ending in a single crimson droplet — the three Fates, the skein, and the cut.

The wordmark sets _SKEINKEEPER_ in [Cinzel](https://fonts.google.com/specimen/Cinzel) Medium with generous tracking, and the tagline _Wyrd bið ful aræd_ in [EB Garamond](https://fonts.google.com/specimen/EB+Garamond) Italic. The lockup is rendered against pure black so the mark's background blends seamlessly with the canvas.

## Generating additional sizes

To produce a new size from the master:

```bash
python3 -c "from PIL import Image; Image.open('branding/icon.png').resize((SIZE, SIZE), Image.LANCZOS).save('branding/icon-SIZE.png', 'PNG', optimize=True)"
```

Replace `SIZE` with the pixel dimension you need.

## Don't

- Don't redraw or restyle the mark. If you need a variant for a specific context, open an issue.
- Don't recolor the mark. The palette is intentional.
- Don't use the wordmark in places where the mark alone would be clearer (favicons, small avatars).
