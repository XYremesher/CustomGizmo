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
  `node uws-server.js` (port 8080 by default). `node_modules` is gitignored,
  so a fresh clone needs `npm install` in `Multiplayer/server` first — note
  that pulls uWebSockets.js straight from GitHub rather than the npm
  registry, as its package.json entry spells out.
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
- **Carry-stabilise damping runs in the character's YAW frame**
  (`Character.animate`, the `window.isCarryingObj` block). It smooths the
  carry clip's own bone motion so the upper body reads as steady and
  upright while walking. The frame it damps in is the whole design, and it
  has now been wrong twice in opposite directions - read this before
  changing it.

  Originally it cached each bone's WORLD orientation and took the
  character's turning back out by accumulating a frame-to-frame delta.
  World space holds the torso beautifully upright, but the accumulation
  meant any imprecision stayed in the cache forever: a hit taken while
  carrying left the body settled at an angle, leaning toward whatever
  direction was being pressed.

  The fix for that was root space - `char.group` times `fbxModel` - which
  removed the accumulation and did stop the post-hit lean. It also folded
  `fbxModel` into the frame on purpose, so slope and turn lean "passed
  through rather than being fought". That quietly gave away the
  uprightness: every lean the model has is handed straight back to the
  torso, and the carry visibly sagged and rocked.

  Now it is the yaw of `char.group` alone, rebuilt from the group's forward
  vector every frame. Yaw read fresh is the same subtraction as the delta
  accumulation without anything integrated, so there is nothing that can
  hold a residue; and with `fbxModel` outside the frame, its leans are
  damped rather than inherited. Both properties at once - the earlier two
  attempts each had one. Fighting those leans IS the job here: the legs may
  tilt into a slope, the chest should stay level over them.

  The two spine bones are LOCKED rather than damped - `applyDamping` takes a
  per-frame retention and they pass 1.0, which makes the slerp return the
  cache untouched, so they simply hold their cached orientation in the yaw
  frame. "Don't rotate" is a different instruction from "rotate less", and
  no retention short of 1 satisfies it; a low-pass always passes something,
  and at a run that something is visible however far the corner is moved.
  Both spine bones, or the chest is held while the bone under it still
  swings it around. The neck keeps a real damping instead - a head welded
  rigidly to a rigid torso reads as a mannequin being slid along.

  The ARMS are locked too, walked from each hand up to the chest and cached
  parent-first. Locking the torso alone still reads as the chest moving,
  because nothing above the spine had ever been damped and carry_upper went
  on swinging the shoulders through the whole run. Flattening those tracks
  in the clip cannot substitute: a clip holds LOCAL rotations, so the arms
  just inherit whatever the torso does. Held in the yaw frame - the same
  frame the torso is held in - they actually stop. This is also what steadies
  the carried object, which is positioned from the midpoint of the two hand
  bones, so no separate smoothing of the object is needed or wanted.

  The block's outer condition is `(isCarryingObj || isCarryStarting)`, and
  both halves are load-bearing. The two flags are mutually exclusive - the
  pickup sets one false and the other true in the same statement - so with
  only `isCarryingObj` the block never ran during carry_start and the
  `isCarryStarting` case in its own reset was dead code. `stabilizeWeight`
  then reached the first carrying frame still at its old value, which froze
  the caches instantly at the pose carry_start is cut off in (40% of the
  clip, see `carryStartSpeedMult`): the character crouched over the object
  and never lifted it. It is constructed at 0.0 for the same reason - 1.0
  asserted a settled hold that had never happened.

  `stabilizeWeight` is what makes a lock safe, and is the reason not to
  "simplify" it away. It multiplies into the retention, and ramps up over
  about a second after every re-seed, so while it climbs the cache is still
  tracking the live pose: what freezes is the SETTLED carry pose, not
  whatever half-finished transition was on screen when the cache was
  created. The ramp only approaches 1 asymptotically, so the lock is never
  quite absolute and keeps creeping toward the truth - a bad seed cannot
  outlive the carry.

  Kill switches from the original bisection are still in: `window.carryStabilizeOff`,
  `window.recoilVisualOff`, `window.slopeTiltOff`. Test them in COMBINATION -
  any single one left on can hold the fault by itself, so turning them off
  one at a time proves nothing. `lastGroupQuat` is dead and only cleared,
  never read. RemoteAvatar still has the old world-space version for
  companions and bots.

  Do NOT try to fix the carry sway with more rotation work. Four attempts
  were built and removed: a `carryDampStrength` slider, flattening the carry
  clip's upper-body tracks (`holdSpine` in `makeUpperBodyClip`), low-pass
  filtering the hand midpoint (`carryObjectSteady`), and the chest IK below.
  The first three all failed for one reason - everything above is ROTATION,
  and the chest's world POSITION is the pelvis's position plus the chain, so
  the hip bob translates the whole torso however rigid the rotations are
  held. Freezing the hand tracks fails the same way, the hands hanging off a
  chest the hips are carrying around.

- **Chest pin / spine CCD** (`Character.solveChestPin`) is the position half,
  and is OFF by default - `window.carryChestIKOff = false` enables it. It
  holds the chest at a fixed point in the model's local frame and bends the
  joints strictly between pelvis and chest (Spine and Spine1 on a Mixamo
  rig, found by walking parents rather than by name) to keep it there.

  It is off because it never looked right, not because it is wrong in
  principle - the lever arm is the problem. The chest origin is ~30cm from
  the Spine joint, so a few centimetres of correction costs tens of degrees
  of bend through the entire upper body. Its position error has to be tiny
  to be invisible, and the pin is leashed to 6cm for exactly that reason.
  Anything revisiting this should start by shortening the lever, not by
  tuning the leash.

  If it is turned back on: position first, orientation second, never both on
  the same bone. The solver owns the in-between joints, so `applyDamping`
  skips spine1 while it is on. Use the model's own `worldToLocal` /
  `localToWorld` rather than composing the frame by hand - `fbxModel` has its
  own position, rewritten every frame to hold the hips pivot, and rotates
  about its own origin, and getting that wrong turned a 10 degree lean into
  a 24cm error. Note `fbxModel.scale` is ~0.0065, so any distance written in
  local units is ~154x smaller than it reads.
