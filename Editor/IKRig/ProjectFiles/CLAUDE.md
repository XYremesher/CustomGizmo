# Peak Punchers — architecture map

Browser-based WebXR/Three.js multiplayer climbing game. No build step — plain
ES modules loaded directly by the browser. Run locally with a static file
server from this directory (e.g. `python -m http.server 8123`) and open
`ClimbGame.html`.

## File map

- **ClimbGame.html** — entry point. Contains the `Character` class (player
  rig: animation state machine, punch/combo/charge-punch logic, hit
  detection via `detectMeleeHits`, carry/throw animation blending), the
  start-screen overlay (`#start-overlay`, one-tap JOIN MULTIPLAYER), the
  debug panel HTML (sliders/checkboxes — see "Debug Vis" category), and
  wires `startGame()` from game_js.js to the canvas.
- **game_js.js** (~6500 lines) — the actual game loop, level geometry, and
  most gameplay systems, all inside one big `startGame()` closure sharing
  local state (`char`, `collidables`, `carryables`, `shooters`,
  `projectiles`, etc.) rather than passing it around. Notable pieces:
  - `buildStairsLevel()` — the main test level (stairs, ramps, shooters,
    the finish diamond `star`, jars/locks/keys, bump fields).
  - Carry/drop/throw: `carryBtn`/`dropBtn`/`throwBtn` handlers,
    `overlapsSolidCollidable`, `isSafeStandingSpot`, `attemptCarryAction`
    (gradual step-back before drop/throw near a wall).
  - `ShooterBox`/`class ShooterBox` — turret that fires projectiles on a
    server-synced timer; `intensity` ('low'/'medium'/'medium_high'/'high')
    drives both its color and the recoil/ragdoll reaction on hit.
  - Physics: per-frame carryable/collidable overlap resolution (X then Z,
    each substep), ground/wall raycasts via `rayDown`/`rayFwd`.
  - Live-tunable constants are almost all `window.X` globals with a
    matching panel slider (search the constant name in ClimbGame.html's
    `<input type="range">` list) — this is the normal way to balance feel
    without a code change.
- **multiplayer.js** — `MultiplayerClient`, talks to the room-based
  WebSocket relay (`Multiplayer/server/uws-server.js`). Mirrors
  hit/recoil/ragdoll reactions for real PvP punches (`_applyPunchEvent`) —
  keep this in sync with the equivalent AI-bot block in ClimbGame.html's
  `detectMeleeHits` when tuning combat.
- **remote_avatar.js** — `RemoteAvatar`, the visual stand-in for other
  connected players. Mixes in `RagdollPhysics` and `LegIK` (below) so
  remote players ragdoll/foot-plant identically to the local `Character`
  without a second copy of that logic.
- **ragdoll_physics.js** — `RagdollPhysics` (verlet ragdoll sim,
  `applyProceduralRecoil` for the recoil/lean reaction on a non-ragdoll
  hit, `initRagdoll`). Shared mixin: both `Character` (ClimbGame.html) and
  `RemoteAvatar` use it.
- **leg_ik.js** — `LegIK`, the analytic 2-bone leg solver. Same
  shared-mixin pattern as ragdoll_physics.js.
- **sandbag.js** — `Sandbag`, the punchable practice bag prop.
- **Multiplayer/server/uws-server.js** — the WebSocket relay (Node +
  uWebSockets.js). Generic room relay: `joinRoom`, `broadcast` (room-wide),
  `send` (targeted, e.g. a punch hit only goes to the victim). Start with
  `node uws-server.js` (port 8080 by default, dependencies already in
  `Multiplayer/server/node_modules`).
- **ClimbGame_better ragdoll.html** — an alternate/experimental HTML, not
  the one actually deployed/played. Don't assume changes here matter unless
  asked specifically about it.
- **sw.js** — minimal service worker, currently pass-through only (no
  caching logic) - registered from ClimbGame.html.

## Multiplayer / public link workflow

The client HTML is served from GitHub Pages
(`https://xyremesher.github.io/CustomGizmo/Editor/IKRig/ProjectFiles/ClimbGame.html`,
10-minute CDN cache) — only the WebSocket relay needs to run somewhere
reachable, since GitHub Pages can't host it. Workflow to get other people
playing:

1. `node Multiplayer/server/uws-server.js` (local, port 8080).
2. `npx cloudflared tunnel --url http://localhost:8080` — prints a
   `https://<random-words>.trycloudflare.com` quick-tunnel URL (no
   Cloudflare account needed, but no uptime guarantee either — it dies if
   this process is killed, and doesn't survive a machine/session restart).
3. Set `DEFAULT_MP_SERVER` in ClimbGame.html (search for it) to
   `wss://<that-tunnel-hostname>` — the start screen's JOIN MULTIPLAYER
   button connects to this with zero user input.
4. Commit + push so GitHub Pages picks it up (Pages itself also caches for
   up to 10 minutes — a hard refresh / incognito window rules out stale
   local browser cache when testing right after a push).

An `https://` page can only reach `wss://` (not plain `ws://`), which is
why the tunnel has to terminate TLS — this is what cloudflared's quick
tunnel gives you for free.

## Debug Vis checkboxes (panel pattern)

Every "Show X" checkbox in the Debug Vis category follows the same shape:
default unchecked, an array of the relevant Object3D/sprites collected at
level-build time, and a `change` listener that sets `.visible` (or
`style.display`) on all of them plus any new one created afterward reading
`document.getElementById('toggle-X').checked` at creation time. See
`toggle-angle-labels`/`rampAngleLabels` in game_js.js as the reference
implementation.

## Known-tricky areas (read the comments before changing)

- **Carry/drop/throw placement** — has to avoid landing an object
  overlapping a collidable, or the per-frame overlap-resolution physics
  shoves it sideways in one un-animated step next frame (reads as a
  teleport). See `overlapsSolidCollidable`'s comment.
- **Combat balance** (`detectMeleeHits` forceMagnitude, `intensity`
  thresholds, `window.staggerDamageMedium`/`staggerDamageMediumHigh`,
  `window.orangeRecoilForce`, `window.chargePunchKnockback`) — tuned so
  the full 7-hit combo (left+right+5) lands right at the edge of the
  100-point stagger pool without alone triggering ragdoll; a bit more
  punching after that empties it. Changing one of these numbers without
  re-deriving the total tends to break that balance in a non-obvious way -
  do the arithmetic, don't just nudge and guess.
- **Spine/turn-lean settling** — a known unresolved bug where hit
  recovery while carrying + turning can settle into a stale lean angle. A
  root-quaternion fix was tried and didn't solve it; the actual lean is
  applied to the spine bone (`char.setSlopeTilt`), not the root group,
  which stays pure-yaw.
