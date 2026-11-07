# Generated visual assets

Bitmap assets generated with OpenAI gpt-image through the Codex CLI built-in `image_gen` tool (`imagegen` skill). Rules: see `AGENTS.md` → Frontend and visuals. Generated images never appear inside live-data views; seat state, tickets' booking details and charts are always rendered in code.

Not generated, by decision: home hero photo (the hero is the live WebGL plan), sold-out row (the final hall is the truthful sold-out picture), seat upholstery texture (invisible at seat size), dashboard empty state (plain configuration UI), logo/favicon (code-native type).

## ticket-stub

- **File:** `apps/web/public/images/ticket-stub.webp` (1200×800, generated 2026-11-07; matches the prompt).
- **Used on:** booking confirmation screen (FR-07), with booking reference, seats, amount and time laid over it in HTML. The printable ticket itself is HTML/CSS.
- **Prompt:**

```text
Use case: product-mockup
Asset type: booking confirmation object, live HTML text overlaid later
Primary request: one blank cinema admission ticket, photographed perfectly straight-on, lying flat
Scene/backdrop: plain flat field of exactly #1a0f22, nothing else in frame
Subject: a single 2:1 rectangular ticket of smooth matte off-white card (#ece5f3), a perforated tear line one quarter from the right edge, a solid crimson (#d6335f) band along the left edge, otherwise completely blank
Style/medium: studio product photograph, long lens, no perspective distortion
Composition/framing: landscape 3:2 canvas; ticket centred, filling about 70% of the width, square-on to camera; large blank area left of the perforation reserved for overlaid text
Lighting/mood: one soft key light from top-left, soft neutral contact shadow below-right
Color palette: #1a0f22 field, #ece5f3 card, #d6335f band only
Materials/textures: smooth uncoated card, crisp die-cut edges, clean perforation holes
Constraints: no text, letters, numbers, barcode, QR code or logo anywhere; no watermark
Avoid: gold foil, holographic effects, stars, film reels, popcorn, tilt, curl, glow, vignette, paper grain, torn stub
```

## hold-expired

- **File:** `apps/web/public/images/hold-expired.webp` (720×720, generated 2026-11-07). The cushion came out folded down rather than sprung up; kept because the image is quiet and on-palette. Regenerate if the metaphor matters.
- **Used on:** customer booking page, beside the message that the hold expired and the seats are available again. The upholstery deliberately matches the available-seat colour.
- **Prompt:**

```text
Use case: photorealistic-natural
Asset type: empty-state illustration for an expired seat hold
Primary request: a single empty cinema tip-up seat whose cushion has just sprung back upright
Scene/backdrop: dark auditorium falling off to exactly #1a0f22 at every edge
Subject: one seat in focus; neighbouring seats cropped at frame edges and out of focus; no people
Style/medium: cinematic photograph, 50mm lens, shallow depth of field
Composition/framing: square 1:1, seat centred slightly low, three-quarter view from the aisle at seat height
Lighting/mood: cool pale light (#dce6ff) from an unseen screen, front-left, raking across the upholstery; quiet, still
Color palette: upholstery muted dusty mauve near #9a8aae, surroundings #1a0f22, no other hues
Materials/textures: worn mohair upholstery, dark painted metal armrests
Constraints: no text, seat numbers or signage; no watermark
Avoid: red velvet, gold trim, haze or light beams, lens flare, popcorn, drinks, film grain, people
```

## social-cover

- **File:** `apps/web/public/images/social-cover.webp` (1200×628 crop, generated 2026-11-07), the photographic layer; the title is composited in code for the Open Graph image.
- **Used on:** Open Graph / social preview until Week 4, when the cover can be rendered from a real recorded run instead.
- **Prompt:**

```text
Use case: product-mockup
Asset type: Open Graph cover photographic layer
Scene/backdrop: a dark cinema auditorium wall and floor, with a quiet continuous background near #1a0f22
Subject: one real upholstered cinema chair with its backrest and folded seat clearly visible
Style/medium: architectural product photography, realistic proportions and matte materials, not a toy-like 3D render
Composition/framing: wide landscape; chair occupies the right third, seen at a modest three-quarter angle; left half calm and empty for a separately composited title; all meaningful detail comfortably inside a 1.91:1 crop
Lighting/mood: a broad pale light from upper left describes the form, with a soft contact shadow and no theatrical beam
Color palette: background #1a0f22, restrained grey-lilac upholstery near #9a8aae, cool highlights near #dce6ff; no other accent colours
Materials/textures: woven fabric, matte painted metal, restrained wear
Constraints: one chair only; no seat number, reservation cue or implied purchase outcome; no text, logos or watermark
Avoid: floating objects, glossy plastic, chrome, neon, coloured glow, purple gradients, tickets, popcorn, people
```
