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

- **Ragdoll vs trees: a shell test cannot hold an obstacle thicker than the
  particle.** Trees are `softObstacle` because their bounding box wraps the
  canopy, so the box narrow phase would fling bodies at the nearest outer
  face - but skipping them left nothing at all, and a charge punch sent bodies
  straight through. Three attempts, three separate lessons:

  1. A fitted CYLINDER is not enough. Measured off `Tree.glb` the trunk shaft
     is radius 0.454 (0.568 on a scale-1.25 tree) and that number is correct,
     but `TreeBody` carries its branches too and those reach past 2.0. A body
     crossing at branch height missed the cylinder entirely. The mesh is only
     48 triangles - test it directly instead of approximating it.
  2. Push direction must come from the FACE NORMAL, never from
     `particle - closestPoint`. For a closed volume that vector points from the
     surface *into* the interior whenever the particle is inside, so the push
     drives it deeper; a body squeezed along the inside of a trunk rides up it,
     which is the "slides to the treetop" symptom. Depth then comes from the
     signed plane distance, and the SHALLOWEST overlap wins - the deepest would
     eject the body through the far side. (Winding is outward: 40 of 48 face
     normals point away from the centroid, the other 8 being branch
     concavities where that test is meaningless.)
  3. Even correct per-triangle contact passes through. Trunk half-width is
     0.57, the torso particle radius 0.22, so a particle in the middle has no
     triangle within its own radius and reports no contact at all. The fix is a
     SWEPT segment test (`_sweepTrunk`, Möller-Trumbore) run once per frame
     *before* the solver iterations, while `oldPos -> pos` still means "where
     the body travelled" - inside the loop the constraint solver has already
     moved things. It blocks only ENTRY, decided by which side the particle
     started on; blocking exit too would seal a trapped particle in.

  Bake the triangles to WORLD space and cache per object. The model has a baked
  rotation on its root node which the forest folds into its merged geometry but
  the village trees keep on the node, so geometry space is not the same frame
  for the two. `levelGroup` has no transform, so a world cache cannot go stale.

- **Every ground raycast must skip `isTreeCollider`.** A canopy is a perfectly
  good hit for a downward ray, so a body arcing up near a tree reads the
  canopy's top as its floor and stands up in the treetop. `_ragdollFloorY`
  (remote_avatar.js) and the player's own ragdoll floor scan both missed this;
  the rest of the game already had the guard.

- **Companion "arrived at the takeoff" tests need HEIGHT, not just distance.**
  `dTk` is horizontal only and the takeoff crumb sits at the foot of the wall,
  so a companion that had just topped out was half a metre from it in x/z
  while metres above it - read as arrived, re-entered the replay, and got
  placed back at the recorded grip. It then shimmied and climbed the same wall
  again. `_compTakeoffT` latches the takeoff found before the climb, so
  nothing else noticed it had gone stale. The re-entry is gated on
  `_compJustClimbedT` too now, the way leaping already was.

  Note also that `_compMode` never takes the value `'shimmy'` - the sliding
  along a ledge is implemented inside the `'hang'` branch via
  `_compShimmyOffset`. The mode string in the union comment is vestigial; the
  behaviour is real.

- **Do NOT interpolate the companion replay between crumbs.** Tried twice,
  and both times it cost the ledge grab outright. The replay snaps the
  companion to whichever crumb is at or after the wanted moment, and every
  decision downstream - `_hangTop`, `findFreeGrip`, the exit test - is
  measured from that same crumb. Putting the BODY between two crumbs splits
  the logic from the thing it is reasoning about, so the grip gets computed
  for a place the companion is not. The stepping that interpolation was meant
  to smooth is real (crumbs at `COMP_TRAIL_HZ`, picture at 144) and the
  affordable half of the fix is a denser sample rate, which is why that
  constant is 60. A proper fix means the companion simulating its own climb
  rather than replaying samples - the replay is the ONE part of the wall
  behaviour that is not already the player's own mechanism.

- **Every path that commits a companion to a ledge grip goes through
  `findFreeGrip`.** `hangSpotTaken` on its own is not a guarantee - it used to
  be consulted from exactly one place, the ground jump-grab, while the path
  companions actually use to follow a climb is the REPLAY, which committed to
  whatever grip the recorded crumb implied with no occupancy test at all. Two
  companions retracing the same climb therefore always chose the same grip and
  hung inside each other. The replay's own lateral search de-conflicts the
  TOP-OUT landing, which is a different question, and left the grips
  overlapping. `_compMode = 'shimmy'` is meanwhile never assigned anywhere:
  the machinery, the save/restore, the debug row and `hangSpotTaken`'s own
  branch for it all exist, but nothing enters the mode, so there is no sliding
  along a ledge and `hang_left`/`hang_right` never play.

- **`RemoteAvatar` adds its group to `scene`, not `levelGroup`.** So
  `buildLevel`'s wipe (`while (levelGroup.children.length)`) does not touch
  bots, companions or the village NPC - they survive every level change,
  still in the scene and still driven by `updateAiBots`/`updateCompanions`
  every frame. Switching from Level 1 into the forest ran Level 1's cast
  alongside the forest's own, which is why that switch cost far more than
  loading the forest directly and took so long to recover. `buildLevel`
  clears them through `removeAiBot`/`removeCompanion` now (over copies - both
  splice the live array). The `villageNpcAvatar` dispose a few lines below was
  the same bug already fixed for one avatar; anything else added straight to
  `scene` belongs in this list too.

- **The broad phase must never drop what it cannot measure.**
  `getNearColliders` culled on `o.geometry.boundingSphere` and skipped
  anything without geometry - which silently deleted every `THREE.Group`
  collidable from the near list. The StarKey and the lock are both groups
  (`buildStarAssembly` / `createLockInstance`), so neither reached
  `solidCollidables` at all: no ray could hit them and no carry target could
  be found however close you stood. It was a regression from adding the broad
  phase; before it, `collidables` was used directly and groups worked.
  Groups are measured with `Box3.setFromObject` now, and anything that still
  cannot be measured is KEPT rather than culled.

- **Raycasts against carryables/collidables must pass `recursive = true`.**
  `intersectObjects(list)` defaults to non-recursive and tests only the listed
  objects, and a `THREE.Group` has no geometry of its own - so anything
  registered as a group is invisible to the ray however close you stand. The
  StarKey is a group (`buildStarAssembly` returns one holding base, container
  and star), which is why no key was ever offered as a carry target while the
  jars, being plain meshes, always were. The tell is the walk from the hit up
  to its carryable ancestor right after the ray: that only makes sense if hits
  arrive on child meshes.

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

  The held reference comes from the CARRY CLIP, not from the live character -
  `Character.getCarryPoseRef`, sampled at `window.carryPoseTime` (default 0).
  Sampling live meant the reference was whatever pose was on screen when the
  ramp closed, and a looping clip is at an arbitrary phase by then, so the
  same pickup came out upright once and leaning back the next time. From the
  clip it is identical every carry, and the blend has a fixed target from
  frame one rather than chasing a capture that is still moving.

  It is returned in the YAW FRAME to match what `applyDamping` caches, and
  the derivation is why no live transform is read: a bone's world
  orientation is group * fbxModel * every local rotation down the chain,
  `fbxModel` rests at `_identityQuat` and the group is pure yaw, so the
  yaw-frame orientation is just the product of local rotations from
  `fbxModel` down to the bone. Bones the clip does not animate use the bind
  pose captured at load (`userData._restQuat`) - for the hips that means
  standing straight, which is the right thing to hang an upright carry pose
  off. `carryRefOk` is false if the clip is missing, and the old live capture
  is then used as a fallback; that fallback is the frame-one pose, mid
  pickup, so it must keep easing in with the ramp rather than locking at once.

  DO NOT HOLD THE HIPS' POSITION. It was tried, to stop the jump clips'
  large hip translation from carrying the locked torso around with it, and
  it wrecks the lower body: the jump clips' leg ROTATIONS are authored
  against a pelvis that crouches and extends, so pinning the pelvis leaves
  those rotations flailing on their own. The hips' position track has to
  keep playing. Absorbing its effect on the upper body without moving the
  legs means bending the spine chain instead - the chest pin below - and
  that has its own lever-arm problem. There is no free version of this.

  A HIT AND A PICKUP ARE NOT THE SAME EVENT, and the reset branch keeps them
  apart. A pickup/drop/throw clears the caches, because a new hold has to be
  built. A hit only drops `stabilizeWeight` and leaves the caches alone: a
  hit does not change what the carry pose is. Clearing them on a hit means
  re-capturing the hold from whatever pose exists when recoil falls under
  the threshold - a body still on its way back up, quite possibly leaning
  wherever movement was being pressed - and a lock then keeps that forever.
  That is the post-hit warp, and it is the same mistake the old 0.988
  damping hid by slowly creeping out of a bad capture.

  THERE IS NO RECOIL THRESHOLD ANYWHERE IN THIS PATH, and every attempt to
  keep one turned into a step the eye could see. The damping gate carried
  `!recoilStillSettling` for a long time, which did not scale the hold down
  during a hit - it switched the whole thing off, while the weight was
  already climbing back as the recoil decayed. At the crossing the hold
  reappeared at whatever weight it had reached, which is 65-83% of it inside
  a single frame, identical for a heavy blow and a light one. That is the
  click, and it is why smoothing the weight curve alone never removed it.
  `stabilizeWeight` is the only control now; it is near zero at the peak of a
  hit, so running the damping every frame writes back essentially the live
  pose and the recoil reads exactly as before. `recoilPeakMag` clears at an
  exact zero (updateRecoil snaps recoil to one under RECOIL_ZERO_EPS) rather
  than at a threshold, where `hold` is already exactly 1 so nothing changes -
  clearing it at a threshold was a second discontinuity, and worst for light
  hits, whose peak is barely above it.

  `stabilizeWeight`'s target tracks the RECOIL MAGNITUDE. Pinning the weight at zero until
  recoil crossed 0.01 and only then ramping made the return a discrete
  event - the body swung out, visibly stopped, and only then did the chest
  travel back to the held pose, which reads as a click. Two motions with a
  pause between them. Tracking the decay means the chest returns while the
  recoil is still decaying: one continuous motion. Scaled against the hit's
  own peak (`recoilPeakMag`) so light and heavy blows both release fully and
  both recover over their own decay, smoothstepped for zero rate of change
  at each end, and lerped fast out / slow in (12.0 vs 3.0) so the blow lands
  instantly while the recovery stays unhurried.

  `retention` and `stabilizeWeight` are therefore two different things and
  must stay separate. `retention` is how fast the HELD REFERENCE follows the
  animation (1 = never = lock). `stabilizeWeight` is how much of the hold
  reaches the bone right now, and touches the reference only via
  `carryHoldSeeded`. When they were multiplied into one factor, a weight
  below 1 dragged the reference toward whatever the recoiling body was
  doing, and the lock kept it. `carryHoldSeeded` is the one exception: until
  the hold is established the reference does follow the live pose, easing in
  with the ramp, so what freezes is the settled carry pose rather than the
  half-finished pickup crouch.

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

- **The carry branch's self-heal tests isScheduled(), never isRunning().**
  `isRunning()` is false for a LoopOnce clip that has clamped, because
  `clampWhenFinished` pauses it - but a clamped action is still scheduled and
  still applying its last frame, which is the entire point of it. Reading
  that as "the mixer dropped this" nulled `activeAction`, so the next
  `fadeToAction` no longer matched its own same-action guard and reset the
  clip to time 0. JumpStart.fbx is about a quarter second and a jump outlives
  it, so the clip clamped mid-air and restarted from frame 0, snapping the
  hips from the end of the jump animation back to its start: the carry jump
  click. The probe caught it as jump_start_lower at time 0.01 with yVelocity
  already down to 1.3 - a clip re-playing, not a clip playing.
  `isScheduled()` asks the question actually intended (is it still in the
  mixer's active list), is false only when the mixer has genuinely let go -
  the fade race this was written for - and stays true through a clamp.

- **fadeToAction/fadeToUpperAction only fadeIn when something is fading OUT.**
  `fadeIn` starts an action at weight 0, which is right against a
  simultaneous `fadeOut` (the two sum to 1 across the blend) and wrong when
  the outgoing action is already gone. It can be gone: a LoopOnce clip with
  `clampWhenFinished` reports `isRunning() === false` once clamped, and the
  carrying branch's self-heal nulls `activeAction` on exactly that, so the
  next call has no `previousAction` to fade out. The tracks are then under-
  weighted for a frame, and `PropertyMixer.apply()` blends a track toward its
  BIND POSE by `1 - totalWeight` whenever the total is under 1. Measured on a
  jump: lower-body total 0.03, hips ~97% bind for one frame, and since the
  upper body is locked in rotation but hangs off the hips for POSITION, the
  hands and the carried object dropped 60cm and sprang back - the carry jump
  click. A landing frame in the same run had a healthy 0.93 + 0.07 and moved
  0.039. Snapping to full weight with no outgoing action is correct, not just
  safe: there is nothing to blend with, so a blend can only be with the bind
  pose.

- **The carried object is placed TWICE per frame, and the second one is the
  real one.** The placement in the carry block runs before `char.animate()`,
  so it reads hand bones the mixer has not posed yet - it is always a frame
  behind. At a constant speed that is a fixed sub-centimetre offset and
  invisible; a jump changes vertical velocity in one step, so a whole frame
  of it appears at takeoff and vanishes at landing (~13cm at 60fps and an
  ~8u/s launch). The corrective re-place sits after `applyLegIK`, which is
  after `setSlopeTilt` - that rotates `fbxModel` and shifts its position to
  hold the hips pivot, both of which move the hands in world space, so
  placing merely after `animate` would not be enough. Only the steady carry
  is corrected; carry_start lerps toward the midpoint over its own duration
  and does not care about a stale frame.

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
