# Tetherloop — Store Listing Copy

Portal-ready copy for CrazyGames, Poki, GameDistribution, Y8, itch.io and the Telegram Mini App listing. Rules: lead with **hold to heat, loop to bank, duel a friend**; the word "swing" is banned in every language and every asset (design risk mitigation: clone perception). Numbers in the copy (2.4 s, +50%, x5, 250 KB) come from the design document; verify them against the shipped build before publishing (`scripts/pack.sh` prints the size).

---

## Title

**Tetherloop**

## Tagline (one line)

Hold to heat. Loop to bank. Duel a friend.

## Short description (80 characters max)

```
Hold to heat, loop to bank, duel a friend in a one-button zero-G climb.
```

71 characters.

## Long description

Hold to heat, loop to bank, duel a friend.

Tetherloop is a one-button climb through a zero-gravity cosmos. Hold anywhere and your comet fires a tether at the planet under the reticle, then whips around it at constant speed. Release and you fly off on the tangent toward the next planet. That is the entire control scheme. Everything else is timing.

Holding is never free. Every moment on the tether builds Heat: the line turns from cyan to white to amber to red, embers stream off your comet, and a click train speeds up in your ears. Hold for 2.4 seconds and you burn. Release hot and you launch up to 50% faster and earn a HOT SHOT bonus. The hotter you dare, the farther you fly.

Style points stack while you move: grazing a planet's surface, hot releases, long shots, and a chain multiplier that climbs to x5. All of it sits in an unbanked pool floating beside your comet, pulsing faster as it grows. The only way to keep it is to hold through one full loop around a planet. The loop BANKS the pool. Die with points unbanked and the results card tells you exactly what you left on the table. One REWIND per run puts you back on your last tether with that pool intact.

Your score is altitude plus banked style. Altitude and banked points can never be lost, so a mistake never zeroes your run.

Every run draws a glowing trajectory behind you. At the end, that trajectory becomes a share card and a duel link. Send it to a friend: they get the same planets in the same order, a line marking the exact altitude where you fell, and a faint ghost of your path. Beat the score and the card flips to "You beat ALI by 37 m", with your own path attached as the next challenge. No account, no server, no sign-up. The whole challenge lives in the link.

The Daily Cosmos hands everyone the same seed each UTC day, with Bronze, Silver and Gold medals at fixed thresholds and a streak ring that pays double dust every seventh day. Three daily missions reward dust; dust buys eight comet trails, or watch a short ad to try any trail for a session. Five skies unlock with lifetime altitude.

Each tether plays the next note of a seeded pentatonic melody, so a skilled run sounds like a finished song. The music gains a kick, hats and an arpeggio as your chain climbs, and collapses the instant you die.

Everything you see and hear is generated in real time: no image, font or audio files, under 250 KB, portrait and widescreen, playable offline and in a private window.

Hold. Heat. Loop. Bank. Then send the link.

**Features**

- One action: hold and release. Touch, mouse, keyboard or gamepad.
- Heat: the longer you hold, the faster you launch, until you burn.
- Loop to bank: a full 360° orbit locks in your style points.
- Backend-free duel links with the challenger's death line and ghost path.
- Daily Cosmos with medals, streaks and three daily missions.
- Eight comet trails, five skies, a melody that your own tethers play.
- Portrait and 16:9, works offline, no account required.

(545 words including the feature list; portal limit 300–600.)

## Tags (10)

`one-button` · `arcade` · `endless` · `space` · `physics` · `high-score` · `daily-challenge` · `skill` · `casual` · `2d`

## Category suggestions

| Portal | Primary | Secondary |
|---|---|---|
| CrazyGames | Casual | Arcade / Skill |
| Poki | Skill | Arcade |
| GameDistribution | Arcade | Skill |
| Y8 | Arcade | Skill |
| itch.io | Action (genre) | tags above |
| Telegram Mini App | Games | — |

Category names are suggestions; pick the closest entry the portal's form offers.

## Controls text

> **Hold** anywhere (touch, any mouse button, Space / W / Up / Enter / any letter key, or gamepad A) to fire a tether at the planet under the reticle and orbit it. **Release** to fly off on the tangent. Hold through a **full loop** to bank your style points. **Esc** pauses. There is no aiming with the pointer: when you press decides where you orbit.

Short form for character-limited fields: `Hold to tether, release to fly, loop to bank.`

## Age rating note

Suitable for all ages: no violence, no blood, no text chat, no user-generated content beyond a 1–12 character nickname (letters and digits only) shown only to people the player sends a link to. The game is **not directed to children under 13**; declare "children-directed: no" on portal forms. When hosted on an ad-supported portal, the game shows optional rewarded video ads and paced interstitials through the portal's SDK. No real-money gambling: in-game dust is earned by play or by watching a rewarded ad, no loot boxes, no randomized rewards. No in-app purchases in version 1.

## Required assets per portal

Sizes below marked **(sourced)** come from the research notes; everything else is "check the portal's current form".

| Portal | Assets | Source |
|---|---|---|
| GameDistribution | Thumbnail **512×512** and **512×384** (both mandatory; minimum 3 sizes), cover **512×512**, **≥ 3** gameplay screenshots **(sourced)** | [GD developer guidelines](https://static.gamedistribution.com/developer/developers-guidelines.html) |
| CrazyGames | **Check the developer portal's current requirements.** Prepare in advance: 512×512 square cover (shared with GD), a 16:9 cover, ≥ 3 screenshots, the 5-second GIF | not in notes |
| Poki | Check the submission form at developers.poki.com | not in notes |
| Y8 | Check the upload form at y8.com/upload | not in notes |
| itch.io | Cover image at the size the upload form recommends, ≥ 3 screenshots, the GIF as the first screenshot | not in notes |
| Telegram (/newapp) | Photo and optional GIF at the sizes BotFather states in the chat | not in notes |

Assets the game produces itself, free: the **1080×1080 share card** (social posts, Shorts cover) and **9:16 screen recordings** at 1080×1920 (Shorts / TikTok), captured directly from the portrait build.

Screenshot set (capture from the build, portrait 540×960 logical, export at 2× = 1080×1920 and a 16:9 1920×1080 landscape set):

1. Mid-hold at heat ≈ 0.8: amber-red tether, embers, heat arc near the tick, POOL label pulsing.
2. The instant of a LOOP: particle ring, expanding circle, "BANKED +184" text.
3. Results card: "You left 412 on the table", REWIND button with its shrinking ring.
4. A duel run: "ALI fell here" line, ghost path, "ALI 1,240" chip under the score.
5. Share card screen with the full glowing trajectory.
6. Landscape 16:9 frame showing the world filling the width and the side HUD panels.

## 5-second GIF storyboard — loop-bank burst over a glowing trajectory

Source: 540×960 portrait build, Indigo theme, Ember trail, `?d=` of a Daily seed with a planet of r ≤ 140 px reachable in the first 10 s (a loop needs r ≤ 160 px). Record at 60 fps, export GIF at 20 fps. Deliver three crops from the same take: 1:1 (540×540 centred on the comet), 16:9 (960×540, starfield fills the sides), 9:16 (full frame). Silent; every beat below must read without audio. Keep the file under the portal's stated limit; if none is stated, under 3 MB (estimate).

| Time | Frame | Reads as |
|---|---|---|
| 0.0–0.8 s | Comet in flight, orange trail, faint 2 px path line already glowing behind it. Reticle brackets lock onto the next planet; the dotted orbit-preview circle is **green**. | "One target, one choice: when." |
| 0.8–1.2 s | Press. 60 ms hit-stop, 2 px shake, 8 sparks, the tether snaps taut in **cyan**. Comet whips onto the circle at constant speed. | "Hold = tether." |
| 1.2–2.8 s | Hold. Tether colour ramps cyan → white → amber; embers stream backward along the orbit; the heat arc around the comet fills past the white 0.7 tick; the POOL label "+92 x2.5" pulses faster; the vignette darkens slightly. | "Holding costs something." |
| 2.8–3.3 s | The comet passes 360°. **LOOP**: 60-particle ring, expanding stroke circle 0 → 220 px, 1.04 zoom pulse, "LOOP" then "BANKED +184" scale-bounce in; the M pill drops back to white 1.0. | "A full loop banks it." |
| 3.3–4.2 s | Release at heat ≈ 0.85: hot whistle (visual: brighter, longer trail, "HOT SHOT" label), comet flies on the tangent; the camera follows and the full glowing trajectory of the run is visible beneath. | "Hot release = fast launch." |
| 4.2–5.0 s | Hard cut to the share card: the same trajectory, SCORE, "BEAT ME" badge, the short URL. Hold 0.5 s, then loop back to frame 1 (the comet's position at 0.0 s matches the final flight direction, so the GIF loops seamlessly). | "Send the link." |

Thumbnail (still) for portals: freeze frame at 2.9 s (the BANK burst) over the glowing trajectory; the 512×512 crop is centred on the ring.

---

## Türkçe

**Slogan**

Tut, ısın. Tur at, bankala. Arkadaşına meydan oku.

**Kısa açıklama (en fazla 80 karakter)**

```
Tek tuş, sıfır yerçekimi: tut ısın, tur at bankala, arkadaşına meydan oku.
```

74 karakter.
