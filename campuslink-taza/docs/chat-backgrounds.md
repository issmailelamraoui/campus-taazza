# Academic chat backgrounds

The background uses the active normalized conversation channel and the authenticated
`selection.facultyId` / `selection.filiereId` in `CommunityPage`. It never uses a
message author's program, the first message, a translated label, or the chat title.

| Conversation | Background |
| --- | --- |
| `general`, `important` | Current faculty |
| `year-1`, `year-3`, `year-5` | Current program, validated against its faculty |
| Known faculty, missing or unregistered program | Current faculty |
| Unknown faculty or unsupported conversation type | Neutral academic |

Legacy `help`, `life`, `filiere`, and `semester-N` channels use the existing channel
normalizer. Year groups retain the same program background. The page's existing
invalid-URL fallback to General Chat is preserved.

## Rendering

`src/lib/chat-backgrounds.js` contains the theme registry and pure resolver.
Self-contained SVG tiles are served from `public/chat-backgrounds/`. All four
faculties and 17 existing programs have a dedicated pattern.
Each tile contains 64 main doodles and 32 smaller academic motifs, with varied
angles and spacing. Miniature motifs fit into free gaps without overlapping
the main drawings. Edge copies make drawings continuous across tile seams.

One CSS pseudo-element on `.community-history-wrap` masks the existing CampusLink
accent color with the selected SVG. The tile stays behind the message log without
adding messages, elements to the log, focus targets, scroll height, or pointer
handlers. Only the selected SVG is requested and the browser can cache it.
There is no animation, random runtime placement, bitmap wallpaper, or dependency.

Dark mode uses 17% opacity; light mode uses 14%, with 1.9px native SVG strokes
for more visible doodles. A canvas-colored backing behind the existing author
and time row keeps small text clear without affecting its position or size.
Message bubbles, composer, and header retain their existing styles. The 600 × 480
SVG is tiled at 420 × 336 CSS pixels on every screen, displaying roughly twice
as many small doodles per viewport as the previous native-size pattern.
Forced colors, reduced transparency preferences, and printing hide the decoration.
Browsers without CSS masking retain the existing plain background.

## Add a faculty or program

1. Add its canonical academic ID to the existing academic catalog as usual.
2. Add a self-contained transparent SVG tile to `public/chat-backgrounds/`.
   Use a `600 480` viewBox, path-based outline motifs, and no external resources.
3. Add the ID and theme ID to `FACULTY_CHAT_BACKGROUNDS` or
   `FILIERE_CHAT_BACKGROUNDS`. The theme catalog is derived from these maps.
4. Run the scope tests and browser checks below.

No changes to message storage, API contracts, permissions, or database schemas
are required for wallpapers.

## Verify

With the frontend running, use:

```sh
npm run test:chat-backgrounds
```

Set `CAMPUSLINK_TEST_URL` when the frontend is not at `http://127.0.0.1:5180`.
The browser scenarios mock the API and do not modify real accounts or messages.
Run `npm run build` for the production bundle.
