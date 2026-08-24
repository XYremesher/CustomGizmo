import * as THREE from 'three';

const _tempVec1 = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempQuat2 = new THREE.Quaternion();
const _tempMat4 = new THREE.Matrix4();
const _fwdVec = new THREE.Vector3(0, 0, 1);
const _zeroVec = new THREE.Vector3();
const _recoilStep = new THREE.Vector3();
// Below this the lean is invisible, so it is treated as gone rather than left
// to decay asymptotically forever. Same value and same reasoning as
// RemoteAvatar's RECOIL_SETTLE_THRESHOLD, which already applies this test to
// these exact two vectors before it trusts its stabilize cache.
const RECOIL_ZERO_EPS = 0.01;

// Scratch objects reused by applyHingeLimit / updateRagdoll so the 20-iteration
// constraint solver doesn't allocate fresh Vector3/Quaternion/Box3 every call.
const _hingeV1 = new THREE.Vector3();
const _hingeV2 = new THREE.Vector3();
const _hingeAxis = new THREE.Vector3();
const _hingeQuat = new THREE.Quaternion();
const _particleBox = new THREE.Box3();
const _prevPos = new THREE.Vector3();
const _boxSize = new THREE.Vector3();

// ---- Broad phase ----
// The collision step used to walk the WHOLE collidables array for every
// particle on every solver iteration: 20 iterations x ~15 particles x however
// many collidables the level has. In the forest that is ~205 objects, so
// ~61,000 getObstacleBox calls per ragdoll per frame, and with three bots and
// three companions able to go down at once, ~370,000.
//
// Almost all of that is answering "is this tree on the far side of the map
// touching us?" over and over. A ragdoll spans maybe two metres, so one pass
// per frame over the array - testing each object's box against the ragdoll's
// own padded bounds - leaves a handful of genuine candidates, and the 300
// inner iterations then run against those instead. The per-object boxes are
// cached in the same pass, so getObstacleBox is called once per object per
// frame rather than 300 times.
const _ragdollAABB = new THREE.Box3();
// Grown as needed and kept - a ragdoll is rarely near more than a few things,
// and reusing the entries keeps the solver allocation-free the way the rest of
// these scratch objects do.
const _candidates = [];
let _candidateCount = 0;
function _candidate(i) {
    if (!_candidates[i]) _candidates[i] = {
        obj: null, isSphere: false, isTrunk: false, radius: 0,
        tris: null, triCount: 0, box: new THREE.Box3()
    };
    return _candidates[i];
}

// ---- Tree trunks ----
// A tree is the one obstacle whose bounding box is useless: the box wraps the
// whole canopy, and the narrow phase resolves a penetration along the box's
// SMALLEST overlap axis, which for that box means being shoved tens of units
// to whichever outer face happens to be nearest. That is why trees are marked
// softObstacle and skipped - but skipping left NOTHING in their place, so a
// body sent flying by a charge punch went straight through.
//
// It collides against the trunk's REAL triangles. A cylinder was tried first
// and is not enough: fitted to Tree.glb it comes out at radius 0.454 (0.568 on
// a scale-1.25 tree), which is honest for the shaft but the trunk mesh carries
// its branches too, and those reach past 2.0 - four times wider. A body
// crossing the tree at branch height passed the cylinder by without touching
// it. The mesh is only ~48 triangles, so testing it directly costs little and
// is exactly right instead of approximately right.
//
// Triangles are baked to WORLD space once per collider and cached. The model
// carries a baked rotation on its root node which the forest folds into its
// merged geometry but the village trees keep on the node, so geometry space is
// not the same frame for the two - world space is, and it folds in scale,
// rotation and position for free. Lazy, so only a tree a ragdoll actually
// reaches is ever baked, and only once. Trees never move (levelGroup has no
// transform), so the cache cannot go stale.
const _triV = new THREE.Vector3();
function _bakeTrunkTris(obj) {
    const geo = obj.userData.trunkGeo;
    const pos = geo && geo.getAttribute && geo.getAttribute('position');
    if (!pos || pos.count < 3) return null;
    const idx = geo.index;
    const triCount = ((idx ? idx.count : pos.count) / 3) | 0;
    if (triCount < 1) return null;
    const m = obj.matrixWorld;
    const out = new Float32Array(triCount * 9);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let t = 0; t < triCount; t++) {
        for (let k = 0; k < 3; k++) {
            const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
            _triV.fromBufferAttribute(pos, vi).applyMatrix4(m);
            const o = t * 9 + k * 3;
            out[o] = _triV.x; out[o + 1] = _triV.y; out[o + 2] = _triV.z;
            if (_triV.x < minX) minX = _triV.x;
            if (_triV.y < minY) minY = _triV.y;
            if (_triV.z < minZ) minZ = _triV.z;
            if (_triV.x > maxX) maxX = _triV.x;
            if (_triV.y > maxY) maxY = _triV.y;
            if (_triV.z > maxZ) maxZ = _triV.z;
        }
    }
    return { tris: out, count: triCount, box: new THREE.Box3(
        new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ)) };
}
// The debug overlay draws from this, so what is on screen is the very shape
// the solver tests against rather than a second implementation that could
// agree with the art while disagreeing with the physics.
export function trunkTrisOf(obj) {
    if (!obj || !obj.userData) return null;
    if (obj.userData._trunkTris === undefined) obj.userData._trunkTris = _bakeTrunkTris(obj);
    return obj.userData._trunkTris;
}
// Live counters for the Debug Vis overlay - reading the solver cannot say
// whether the branch FIRES, and "no candidate" and "candidate but no push" are
// two different bugs that look identical in motion.
export const trunkStats = { candidates: 0, pushes: 0, frame: 0 };

// Closest point on triangle abc to p, written into out. Ericson, Real-Time
// Collision Detection - the standard Voronoi-region walk, which is what makes
// an edge-on or corner-on contact resolve correctly instead of snapping to the
// face plane.
const _ctA = new THREE.Vector3(), _ctB = new THREE.Vector3(), _ctC = new THREE.Vector3();
const _trunkClosest = new THREE.Vector3(), _trunkDelta = new THREE.Vector3();
const _trunkPush = new THREE.Vector3();
const _triN = new THREE.Vector3(), _swDir = new THREE.Vector3();
const _swE1 = new THREE.Vector3(), _swE2 = new THREE.Vector3();
const _swP = new THREE.Vector3(), _swQ = new THREE.Vector3(), _swT = new THREE.Vector3();
const _swHitN = new THREE.Vector3(), _swHitA = new THREE.Vector3();

// Segment oldPos->pos against the trunk's triangles (Moller-Trumbore, both
// faces). This exists because a shell test alone cannot hold a trunk: the wood
// is ~0.57 wide and a torso particle is 0.22, so a particle in the middle has
// NO triangle within its own radius and reports no contact at all - it simply
// crosses. Catching the crossing itself is the only test that does not care how
// thick the obstacle is or how fast the body is going.
//
// Returns true when it moved the particle.
function _sweepTrunk(p, cand) {
    _swDir.subVectors(p.pos, p.oldPos);
    const travel = _swDir.length();
    if (travel < 1e-6) return false;
    const tris = cand.tris;
    let bestT = Infinity;
    for (let t = 0; t < cand.triCount; t++) {
        const o = t * 9;
        _ctA.set(tris[o], tris[o + 1], tris[o + 2]);
        _ctB.set(tris[o + 3], tris[o + 4], tris[o + 5]);
        _ctC.set(tris[o + 6], tris[o + 7], tris[o + 8]);
        _swE1.subVectors(_ctB, _ctA);
        _swE2.subVectors(_ctC, _ctA);
        _swP.crossVectors(_swDir, _swE2);
        const det = _swE1.dot(_swP);
        // Parallel to the triangle - no crossing to find.
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        _swT.subVectors(p.oldPos, _ctA);
        const u = _swT.dot(_swP) * inv;
        if (u < 0 || u > 1) continue;
        _swQ.crossVectors(_swT, _swE1);
        const v = _swDir.dot(_swQ) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = _swE2.dot(_swQ) * inv;
        if (tt < 0 || tt > 1 || tt >= bestT) continue;
        bestT = tt;
        _swHitN.crossVectors(_swE1, _swE2).normalize();
        _swHitA.copy(_ctA);
    }
    if (bestT === Infinity) return false;
    // Which side the particle STARTED on decides what to do, not which way it
    // is travelling. Started outside: block it, that is the crossing this test
    // exists to stop. Started inside: let it go - it is escaping, and holding
    // it at the surface would seal it in. Getting an already-trapped particle
    // out is the shell push's job, and it pushes outward.
    _swT.subVectors(p.oldPos, _swHitA);
    if (_swT.dot(_swHitN) < 0) return false;
    _swT.copy(p.oldPos).addScaledVector(_swDir, bestT).addScaledVector(_swHitN, p.radius + 0.01);
    p.pos.copy(_swT);
    // Kill the velocity component heading into the surface, keep the rest so
    // the body slides along the trunk rather than sticking to it.
    _swDir.subVectors(p.pos, p.oldPos);
    const into = _swDir.dot(_swHitN);
    if (into < 0) _swDir.addScaledVector(_swHitN, -into);
    p.oldPos.copy(p.pos).sub(_swDir);
    return true;
}

const _ctAB = new THREE.Vector3(), _ctAC = new THREE.Vector3(), _ctAP = new THREE.Vector3();
const _ctBP = new THREE.Vector3(), _ctCP = new THREE.Vector3();
function _closestOnTri(p, a, b, c, out) {
    _ctAB.subVectors(b, a);
    _ctAC.subVectors(c, a);
    _ctAP.subVectors(p, a);
    const d1 = _ctAB.dot(_ctAP), d2 = _ctAC.dot(_ctAP);
    if (d1 <= 0 && d2 <= 0) return out.copy(a);
    _ctBP.subVectors(p, b);
    const d3 = _ctAB.dot(_ctBP), d4 = _ctAC.dot(_ctBP);
    if (d3 >= 0 && d4 <= d3) return out.copy(b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(_ctAB, d1 / (d1 - d3));
    _ctCP.subVectors(p, c);
    const d5 = _ctAB.dot(_ctCP), d6 = _ctAC.dot(_ctCP);
    if (d6 >= 0 && d5 <= d6) return out.copy(c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(_ctAC, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        return out.copy(b).addScaledVector(_ctCP.subVectors(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    }
    const denom = 1 / (va + vb + vc);
    return out.copy(a).addScaledVector(_ctAB, vb * denom).addScaledVector(_ctAC, vc * denom);
}

// How far a particle can travel during one frame's solve. The bounds are
// measured once, before the iterations, so they have to cover where the
// particles END UP too - anything less and a limb could swing into something
// that was culled at the top of the frame.
const RAGDOLL_BROAD_MARGIN = 1.0;

// ---- Cost knobs ----
// Trimmed from 0.02 / 0.4 / 0.8 / 1.6. The high tier is the one that matters:
// it is the knockdown you actually see, and it was lying limp for a second and
// a half after it had already come to rest.
window.ragdollTimeLow = 0.02;
window.ragdollTimeMedium = 0.3;
window.ragdollTimeMediumHigh = 0.6;
window.ragdollTimeHigh = 1.1;
// How many of the 20 solver iterations also resolve collision.
//
// All 20 used to. That is what keeps a limb out of a wall DURING the solve,
// but the passes that decide where the body actually comes to rest are the
// last ones - the earlier ones are re-resolving contacts that the next
// constraint pass is about to move anyway. Running collision on the final 8
// leaves the constraint solver its full 20 passes and still ends the frame
// penetration-free, because collision is the last thing each iteration does.
//
// The floor clamp is NOT part of this - it runs every iteration regardless.
// It costs nothing (no array walk) and it is what stops a body sinking.
window.ragdollCollisionIters = 8;

export const RagdollPhysics = {
    getParticle(id) {
        if (!this._particleMap) {
            this._particleMap = new Map();
            this.ragdollParticles.forEach(p => this._particleMap.set(p.id, p));
        }
        return this._particleMap.get(id);
    },

    initRagdoll(initialVelocity = new THREE.Vector3(), intensity = 'high') {
        if (!this.fbxModel || this.isRagdoll) return;

        if (this.isLocalPlayer && window.forceDropCarriedObject) {
            window.forceDropCarriedObject(initialVelocity.clone().multiplyScalar(1.5));
            window.isCarryingObj = false;
        }
        
        this.lastSpineWorld = null;
        this.lastSpine1World = null;
        this.lastNeckWorld = null;
        this.lastGroupQuat = null;
        this.stabilizeWeight = 1.0;
        this.hitRecoveryTimer = 0;

        this.fbxModel.updateMatrixWorld(true);
        this.currentRagdollIntensity = intensity;

        // How long the body stays limp before it is allowed to start getting
        // up. This is the single biggest lever on ragdoll cost, because it is
        // a FRAME COUNT: the solver runs every frame the character is down, so
        // shortening the high tier from 1.6s to 1.1s is ~30 fewer full solves
        // per knockdown at 60fps.
        //
        // Only a floor, not a ceiling - beginStandUp additionally waits until
        // the character is actually near the ground (see the caller), so a
        // body still falling keeps simulating however long the fall takes.
        // Cutting these therefore shortens the lying-there part, not the fall.
        let velocityModifier = 1.0;
        if (intensity === 'low') {
            this.ragdollMaxTime = window.ragdollTimeLow;
            velocityModifier = 0.05; 
        } else if (intensity === 'medium') {
            this.ragdollMaxTime = window.ragdollTimeMedium;
            velocityModifier = 0.25;
        } else if (intensity === 'medium_high') {
            this.ragdollMaxTime = window.ragdollTimeMediumHigh;
            velocityModifier = 0.4;
        } else {
            this.ragdollMaxTime = window.ragdollTimeHigh;
            velocityModifier = 0.55;
        }

        // How hard a knockdown may throw a body.
        //
        // Was a hardcoded 15, which put a knocked-down enemy 6.3 units away
        // before it even landed - three body-widths, so a punch read as a
        // cannon. 7.5 halves that to about 3.2: still clearly thrown, but it
        // comes down where you can follow it up.
        //
        // Derived rather than dialled: the launch is written below as
        // velocity * 0.016 per frame and the solver decays each step by
        // ragdollDamping, so the horizontal travel is v * 0.016 / (1 - damping)
        // until the body meets the floor - about 37 frames at 144fps for a
        // hip-height fall.
        const launchMax = window.ragdollLaunchMax !== undefined ? window.ragdollLaunchMax : 7.5;
        const modifiedVelocity = initialVelocity.clone().multiplyScalar(velocityModifier);
        modifiedVelocity.clampLength(0.0, launchMax);

        this.ragdollParticles.forEach((p) => {
            if (p.bone) {
                p.bone.getWorldPosition(p.pos);
                const nX = (Math.random() - 0.5) * 2.0 * velocityModifier;
                const nY = (Math.random() - 0.5) * 2.0 * velocityModifier;
                const nZ = (Math.random() - 0.5) * 2.0 * velocityModifier;
                // NOTE, and it is a real one: this 0.016 is a 60fps frame, and
                // the solver's damping decays PER FRAME rather than per
                // second. The two together make how far a body flies depend on
                // the frame rate - the same hit throws it 1.7 units at 30fps,
                // 3.2 at 60 and 6.3 at 144. A phone and a desktop are playing
                // different games.
                //
                // Not changed here on purpose. Making it frame-rate
                // independent means passing delta in AND making the damping
                // time-based (Math.pow(damping, delta*60)), and that damping
                // is documented as matching a known-stable reference build -
                // every previous attempt to touch it made the joints jitter.
                // It wants doing deliberately, with the ragdoll watched, not
                // as a side effect of tuning a distance.
                _tempVec1.set(nX, nY, nZ).add(modifiedVelocity).multiplyScalar(0.016);
                p.oldPos.copy(p.pos).sub(_tempVec1);
            }
        });

        this.ragdollConstraints = [];
        const addDist = (id1, id2) => {
            const p1 = this.getParticle(id1);
            const p2 = this.getParticle(id2);
            if (p1 && p2 && p1.bone && p2.bone) this.ragdollConstraints.push({ p1, p2, dist: p1.pos.distanceTo(p2.pos) });
        };

        addDist('hips', 'spine'); addDist('spine', 'head');
        addDist('spine', 'lShoulder'); addDist('lShoulder', 'lElbow'); addDist('lElbow', 'lHand');
        addDist('spine', 'rShoulder'); addDist('rShoulder', 'rElbow'); addDist('rElbow', 'rHand');
        addDist('hips', 'lThigh'); addDist('lThigh', 'lKnee'); addDist('lKnee', 'lFoot');
        addDist('hips', 'rThigh'); addDist('rThigh', 'rKnee'); addDist('rKnee', 'rFoot');
        addDist('lShoulder', 'rShoulder'); addDist('lThigh', 'rThigh');

        const getBone = (id) => this.getParticle(id)?.bone;

        // Each link aims ONE bone along the segment p1 -> p2, and the bone it
        // aims is the one that STARTS at p1. Four of these always did that;
        // the two limb ends aimed the bone at p2 instead - the hand for
        // elbow -> hand, the foot for knee -> foot.
        //
        // That is what left hands mangled. The forearm was then never rotated
        // at all, so it stayed in whatever pose the last clip left it, and the
        // hand - its child, so already carried to the wrong place - was given
        // the rotation the FOREARM should have had. Wrong position and wrong
        // orientation, on a bone that ends up right in front of the camera.
        // beginStandUp bakes the pose it finds, so the break survived getting
        // back up.
        //
        // The knee -> foot link had the identical mistake and is fixed with
        // it; a shin that never rotates is the same defect, just less obvious
        // at ankle height than at the wrists.
        this.ragdollLinks = [
            { p1: 'hips', p2: 'spine', bone: getBone('hips') }, { p1: 'spine', p2: 'head', bone: getBone('spine') },
            { p1: 'lShoulder', p2: 'lElbow', bone: getBone('lShoulder') }, { p1: 'lElbow', p2: 'lHand', bone: getBone('lElbow') },
            { p1: 'rShoulder', p2: 'rElbow', bone: getBone('rShoulder') }, { p1: 'rElbow', p2: 'rHand', bone: getBone('rElbow') },
            { p1: 'lThigh', p2: 'lKnee', bone: getBone('lThigh') }, { p1: 'lKnee', p2: 'lFoot', bone: getBone('lKnee') },
            { p1: 'rThigh', p2: 'rKnee', bone: getBone('rThigh') }, { p1: 'rKnee', p2: 'rFoot', bone: getBone('rKnee') }
        ];

        this.ragdollLinks.forEach(link => {
            if (link.bone) {
                const p1 = this.getParticle(link.p1);
                const p2 = this.getParticle(link.p2);
                if (p1 && p2) {
                    link.initialDir = p2.pos.clone().sub(p1.pos).normalize();
                    link.initialQuat = link.bone.getWorldQuaternion(new THREE.Quaternion());
                } else link.bone = null;
            }
        });

        if (this.activeAction) this.activeAction.stop();
        if (this.activeUpperAction) this.activeUpperAction.stop();
        this.activeUpperAction = null;

        this.isRagdoll = true; this.isStandingUp = false; this.standUpFinished = false; this.ragdollTimer = 0;
    },

    applyProceduralRecoil(projectileVelocity, intensity) {
        const localVelocity = projectileVelocity.clone().applyQuaternion(this.group.quaternion.clone().invert());
        const localDir = localVelocity.clone().normalize();
        
        let impulseMagnitude = 12.0;
        if (intensity === 'low') impulseMagnitude = 6.0;
        else if (intensity === 'medium') impulseMagnitude = 12.0;
        else if (intensity === 'medium_high') {
            impulseMagnitude = window.orangeRecoilForce;
            this.recoilVelocity.y += (Math.random() - 0.5) * 2.0 * impulseMagnitude * 1.2;
        }

        this.recoilVelocity.x += localDir.z * impulseMagnitude;
        this.recoilVelocity.z += -localDir.x * impulseMagnitude;
        // Whole-character yaw snap, separate from the spine-only lean above
        // - this used to be exactly what the OLD recovery-turn did (facing
        // travel direction), which was removed because it always spun the
        // character's back toward whoever hit them regardless of which
        // side the hit came from. This is different: a quick, self-
        // decaying twist purely for impact emphasis (applied to fbxModel in
        // setSlopeTilt, not this.group's actual facing), independent of
        // movement direction - the recovery step's own direction
        // (hitRecoveryDir, set below) stays a fixed world-space vector
        // unaffected by this, so a hit from the side twisting the visual
        // model doesn't send the character stepping the wrong way. Same
        // raw-impulse-as-velocity convention as recoilVelocity.x/z above.
        this.hitTwistVelocity += -localDir.x * impulseMagnitude;

        this.lastSpineWorld = null;
        this.lastSpine1World = null;
        this.lastNeckWorld = null;
        this.lastGroupQuat = null;
        this.stabilizeWeight = 0.0;

        // Kick off a real recovery step (see game_js.js's movement block
        // and Character's own hitRecoveryTimer/hitRecoveryDir fields) for
        // any hit strong enough to actually stagger, not just a light tap -
        // 'low' intensity (impulseMagnitude 6.0) stays a pure upper-body
        // recoil with no footwork. Direction is the incoming hit's own
        // horizontal travel direction (projectileVelocity, not the
        // already-local-and-rotated localDir above) - a real push shoves
        // you further along the direction it's already travelling, not
        // sideways to it.
        const HIT_RECOVERY_MIN_IMPULSE = 8.0;
        // Both live-tunable via panel sliders (window.hitRecoveryDelay,
        // window.hitRecoveryDuration - see their init in game_js.js).
        // hitRecoveryTimer starts at DURATION+DELAY together; the recoil
        // lean above (recoilVelocity/recoilRotation) already starts
        // building immediately regardless, but game_js.js's movement block
        // only treats the timer as "step now" once it's counted down into
        // just the last DURATION seconds - so the character visibly bends
        // first, then steps toward wherever that bend is. Fixed fallbacks
        // only matter if read before game_js.js's own init has run.
        const hitRecoveryDelay = window.hitRecoveryDelay !== undefined ? window.hitRecoveryDelay : 0.02;
        const hitRecoveryDuration = window.hitRecoveryDuration !== undefined ? window.hitRecoveryDuration : 0.35;
        if (impulseMagnitude >= HIT_RECOVERY_MIN_IMPULSE && this.hitRecoveryDir) {
            this.hitRecoveryDir.set(projectileVelocity.x, 0, projectileVelocity.z);
            if (this.hitRecoveryDir.lengthSq() > 0.0001) {
                this.hitRecoveryDir.normalize();
                this.hitRecoveryTimer = hitRecoveryDuration + hitRecoveryDelay;
                // Read by game_js.js's movement block to scale the actual
                // step speed (and so the ground it covers) with how hard
                // this specific hit was - a 'medium_high' hit (tunable via
                // window.orangeRecoilForce, can go well past 'medium's flat
                // 12.0) should stagger noticeably further than a hit right
                // at the recovery threshold, not the same fixed-distance
                // step regardless of intensity.
                this.hitRecoveryStrength = impulseMagnitude;
                // ---- Combo hold ----
                // Every blow that lands restarts a full-strength stagger
                // step, and inside a combo those steps SUM. Measured: one
                // medium blow covers 0.50-0.61 units depending on how far
                // apart the clip spaces its hits, so the six light blows of
                // the full string shove a target 3.0-3.7 units back - while
                // it is stunned and so cannot walk in again. Reach is
                // hitRadius + 1.0 = 1.7 from the hand, which sits ~0.8 ahead
                // of the body, and separation holds a body at 1.15, so there
                // are about 1.3 units of room. The string spends that by its
                // third blow and the rest of it swings at empty air, which is
                // exactly what "the last combo attacks don't land unless I
                // walk forward" is.
                //
                // So each further blow of the same string covers less ground.
                // What is damped is ONLY the ground covered: the timer above
                // is still refreshed, so the stun-lock is unchanged, and the
                // recoil lean and twist are untouched, so every blow still
                // visibly rocks them. 0.35^n floored at 0.08 spends ~1.0 unit
                // across the six, which fits the room with a little left for
                // the pacing of whichever clip is playing.
                //
                // LIGHT blows only. 'medium_high' is the combo's finisher and
                // 'high' is a knockdown - those are the payoff for landing
                // the whole string and are supposed to send them flying.
                // Damping them would take away the reward for the thing this
                // exists to make possible.
                const chainGap = window.comboHoldGap !== undefined ? window.comboHoldGap : 0.6;
                // Longer than the pause between two blows of a string,
                // shorter than the time it takes someone knocked back to walk
                // in again - so a fresh approach starts a fresh chain instead
                // of continuing the one that pushed them away.
                const nowT = performance.now() / 1000;
                if (this._holdChainAt === undefined || (nowT - this._holdChainAt) > chainGap) this._holdChain = 0;
                this._holdChainAt = nowT;
                if (intensity === 'medium') {
                    const decay = window.comboHoldDecay !== undefined ? window.comboHoldDecay : 0.35;
                    const floor = window.comboHoldMin !== undefined ? window.comboHoldMin : 0.08;
                    this.hitRecoveryPush = Math.max(floor, Math.pow(decay, this._holdChain || 0));
                } else {
                    this.hitRecoveryPush = 1;
                }
                this._holdChain = (this._holdChain || 0) + 1;
            }
        }
    },

    updateRecoil(delta) {
        this.recoilVelocity.lerp(_zeroVec, 15 * delta);
        this.recoilRotation.lerp(_zeroVec, 10 * delta);
        this.recoilRotation.add(_recoilStep.copy(this.recoilVelocity).multiplyScalar(delta));
        // Exponential decay never actually reaches zero, and applyRecoilVisual
        // feeds whatever is left into the spine, spine1 and neck EVERY frame -
        // so the tail of a hit is a permanent sliver of lean rather than a
        // fading one, and the body never quite straightens up again. Cutting
        // it once it is below the visible threshold is what actually ends the
        // lean. Both halves have to go: leaving the velocity alive would keep
        // feeding the rotation on the next line.
        if (this.recoilRotation.lengthSq() + this.recoilVelocity.lengthSq()
            < RECOIL_ZERO_EPS * RECOIL_ZERO_EPS) {
            this.recoilRotation.set(0, 0, 0);
            this.recoilVelocity.set(0, 0, 0);
        }
        // Same spring-damper shape as recoilVelocity/recoilRotation above,
        // just scalar - drives the whole-character impact twist (see
        // applyProceduralRecoil and setSlopeTilt's hitTwistAngle param).
        this.hitTwistVelocity = THREE.MathUtils.lerp(this.hitTwistVelocity, 0, 15 * delta);
        this.hitTwistAngle = THREE.MathUtils.lerp(this.hitTwistAngle, 0, 10 * delta);
        this.hitTwistAngle += this.hitTwistVelocity * delta;
        // Same cut-off, same reason - this one is fed to setSlopeTilt, so its
        // residue is a permanent twist rather than a permanent lean.
        if (Math.abs(this.hitTwistAngle) + Math.abs(this.hitTwistVelocity) < RECOIL_ZERO_EPS) {
            this.hitTwistAngle = 0;
            this.hitTwistVelocity = 0;
        }
    },

    detectFallDirection() {
        const hipsP = this.getParticle('hips');
        const spineP = this.getParticle('spine');
        const headP = this.getParticle('head');
        if (!hipsP || !spineP) return 'front';

        _tempVec1.set(0, 0, 1).applyQuaternion(this.group.quaternion);
        _tempVec1.y = 0; _tempVec1.normalize();

        _tempVec2.subVectors(spineP.pos, hipsP.pos);
        _tempVec2.y = 0; _tempVec2.normalize();

        if (headP) {
            _tempVec3.subVectors(headP.pos, hipsP.pos);
            _tempVec3.y = 0; _tempVec3.normalize();
        } else _tempVec3.copy(_tempVec2);

        return _tempVec1.dot(_tempVec3) > 0 ? 'front' : 'back';
    },

    captureRagdollPose() {
        const tracks = [];
        const dur = this.ragdollPoseDuration;
        this.fbxModel.traverse(child => {
            if (child.isBone) {
                const q = child.quaternion;
                tracks.push(new THREE.QuaternionKeyframeTrack(child.name + '.quaternion', [0, dur], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]));
                if (child === this.hips || child === this.rootBone) {
                    const p = child.position;
                    tracks.push(new THREE.VectorKeyframeTrack(child.name + '.position', [0, dur], [p.x, p.y, p.z, p.x, p.y, p.z]));
                }
            }
        });
        const clip = new THREE.AnimationClip('ragdoll_pose', dur, tracks);
        const action = this.mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true;
        return action;
    },

    beginStandUp(floorY) {
        if (!this.isRagdoll) return;

        if (this.currentRagdollIntensity === 'low') {
            this.isRagdoll = false; this.isStandingUp = false; this.standUpFinished = true;
            if (this.fbxModel) this.fbxModel.position.set(0, 0, 0);
            this.fadeToAction('idle', 0.1);
            return;
        }

        const direction = this.detectFallDirection();
        this.standUpDirection = direction;

        const hipsP = this.getParticle('hips');
        const spineP = this.getParticle('spine');

        const globalTransforms = new Map();
        this.fbxModel.traverse(c => {
            if (c.isBone) {
                globalTransforms.set(c, {
                    pos: c.getWorldPosition(new THREE.Vector3()),
                    quat: c.getWorldQuaternion(new THREE.Quaternion()),
                    scl: c.getWorldScale(new THREE.Vector3())
                });
            }
        });

        const hipsWorldPos = hipsP ? hipsP.pos.clone() : this.group.position.clone();
        this.group.position.set(hipsWorldPos.x, floorY, hipsWorldPos.z);

        if (hipsP && spineP) {
            _tempVec1.subVectors(spineP.pos, hipsP.pos);
            _tempVec1.y = 0;
            if (_tempVec1.lengthSq() > 0.001) {
                _tempVec1.normalize();
                if (direction === 'back') _tempVec1.negate();
                this.group.quaternion.setFromUnitVectors(_fwdVec, _tempVec1);
            }
        }
        this.group.updateMatrixWorld(true);

        this.fbxModel.traverse(c => {
            if (c.isBone) {
                const gt = globalTransforms.get(c);
                _tempMat4.copy(c.parent.matrixWorld).invert();
                const worldMat = new THREE.Matrix4().compose(gt.pos, gt.quat, gt.scl);
                const localMat = new THREE.Matrix4().multiplyMatrices(_tempMat4, worldMat);
                localMat.decompose(c.position, c.quaternion, new THREE.Vector3());
                c.updateMatrixWorld(true);
            }
        });

        if (this.fbxModel) {
            this.fbxModel.position.set(0, 0, 0);
            this.standUpTransStartX = 0; this.standUpTransStartY = 0; this.standUpTransStartZ = 0;
        }

        const ragdollAction = this.captureRagdollPose();
        ragdollAction.play();

        this.isRagdoll = false; this.isStandingUp = true; this.standUpFinished = false;
        const animName = direction === 'front' ? 'standup_front' : 'standup_back';
        if (!this.actions[animName]) {
            this.isStandingUp = false; this.standUpDirection = 'none'; return;
        }

        const standUpAction = this.actions[animName];
        standUpAction.reset();
        standUpAction.setEffectiveWeight(1);
        standUpAction.setEffectiveTimeScale(this.standupSpeed);
        standUpAction.time = Math.min(this.standupStartTime, standUpAction.getClip().duration - 0.1); 
        standUpAction.play();
        standUpAction.crossFadeFrom(ragdollAction, this.standupCrossfade, false);
        this.activeAction = standUpAction;
    },

    // Simplified back to a plain angle-limit clamp (no torso-relative
    // knee/elbow/hip bias, no lateral anti-splay correction) to match the
    // known-stable reference build ("ClimbGame_better ragdoll.html") - that
    // extra correction was tuned down to lateralStiffness=0 anyway (the user's
    // preferred setting), so removing the mechanism entirely shouldn't change
    // the feel, but does remove one more thing fighting the hinge/distance
    // solver every iteration.
    applyHingeLimit(id1, id2, id3, minAngle, maxAngle) {
        const p1 = this.getParticle(id1);
        const p2 = this.getParticle(id2);
        const p3 = this.getParticle(id3);
        if (!p1 || !p2 || !p3) return;

        const v1 = _hingeV1.subVectors(p1.pos, p2.pos);
        const v2 = _hingeV2.subVectors(p3.pos, p2.pos);
        const d1 = v1.length();
        const d2 = v2.length();
        if (d1 < 0.001 || d2 < 0.001) return;

        v1.normalize();
        v2.normalize();

        const dot = v1.dot(v2);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (angle < minAngle || angle > maxAngle) {
            const targetAngle = Math.max(minAngle, Math.min(maxAngle, angle));
            const axis = _hingeAxis.crossVectors(v1, v2).normalize();
            if (axis.lengthSq() < 0.001) axis.set(0, 1, 0);
            const q = _hingeQuat.setFromAxisAngle(axis, targetAngle - angle);
            v2.applyQuaternion(q).normalize().multiplyScalar(d2);
            p3.pos.copy(p2.pos).add(v2);
        }
    },

    updateRagdoll(delta, collidables, floorY) {
        if (!this.isRagdoll) return;
        this.ragdollTimer += delta;
        // Callers that do not track a floor at all still get the old
        // world-origin behaviour rather than falling forever.
        const ragdollFloor = (typeof floorY === 'number') ? floorY : 0;
        // The head's collider follows the head-size slider. Its radius is
        // baked when the rig is built, but window.headScale is applied every
        // frame to the head BONE - so a scaled-up head kept colliding with a
        // default-sized sphere and sank into the floor and through walls.
        // Read each frame rather than at initRagdoll, so dragging the slider
        // while something is lying there updates it too. baseRadius is stashed
        // on first use so repeated scaling compounds off the original, not off
        // last frame's result.
        const headP = this.getParticle('head');
        if (headP) {
            if (headP.baseRadius === undefined) headP.baseRadius = headP.radius;
            headP.radius = headP.baseRadius * (window.headScale !== undefined ? window.headScale : 1);
        }
        // Matches the known-stable reference build ("ClimbGame_better ragdoll.html"):
        // a light, uniform damping and no velocity/displacement clamp at all.
        // Today's attempts to fix "falls from height look floaty" by
        // decoupling gravity from damping (and later substepping to
        // compensate) kept making the joints jitter/spin worse - turns out
        // the simpler original approach was already the stable one; the
        // floaty-fall complaint is instead handled by not letting
        // beginStandUp fire until the character is actually near the ground.
        const gravity = 30; const damping = window.ragdollDamping !== undefined ? window.ragdollDamping : 0.98;

        this.ragdollParticles.forEach(p => {
            const tempX = p.pos.x, tempY = p.pos.y, tempZ = p.pos.z;
            p.pos.x += (p.pos.x - p.oldPos.x) * damping;
            p.pos.y += (p.pos.y - p.oldPos.y) * damping - gravity * delta * delta;
            p.pos.z += (p.pos.z - p.oldPos.z) * damping;
            p.oldPos.set(tempX, tempY, tempZ);
        });

        // ---- Broad phase, once per frame (see _candidates) ----
        _ragdollAABB.makeEmpty();
        let broadMaxRadius = 0;
        for (let i = 0; i < this.ragdollParticles.length; i++) {
            const p = this.ragdollParticles[i];
            _ragdollAABB.expandByPoint(p.pos);
            if (p.radius > broadMaxRadius) broadMaxRadius = p.radius;
        }
        _ragdollAABB.expandByScalar(broadMaxRadius + RAGDOLL_BROAD_MARGIN);
        _candidateCount = 0;
        for (let i = 0; i < collidables.length; i++) {
            const obj = collidables[i];
            if (obj === window.ground) continue;
            const cand = _candidate(_candidateCount);
            if (obj.geometry && (obj.geometry.type === 'SphereGeometry' || obj.geometry.constructor.name === 'SphereGeometry')) {
                const radius = obj.geometry.parameters.radius || 6;
                // Sphere test is cheap enough to do exactly rather than via a box.
                if (_ragdollAABB.distanceToPoint(obj.position) > radius) continue;
                cand.obj = obj; cand.isSphere = true; cand.isTrunk = false; cand.radius = radius;
                _candidateCount++;
                continue;
            }
            // A trunk is the one softObstacle whose real shape is known and
            // cheap, so it collides against its own triangles instead of being
            // dropped outright. See _bakeTrunkTris - skipping trees entirely is
            // what let a charge punch send a body straight through them.
            if (obj.userData && obj.userData.isTreeTrunk) {
                const baked = trunkTrisOf(obj);
                // The trunk's own bounds, not the whole tree's - this is the
                // wood, canopy excluded, so the box IS roughly the shape here
                // and is a fair broad-phase reject.
                if (!baked || !baked.box.intersectsBox(_ragdollAABB)) continue;
                cand.obj = obj; cand.isSphere = false; cand.isTrunk = true;
                cand.tris = baked.tris; cand.triCount = baked.count;
                _candidateCount++;
                if (window.trunkVizOn) trunkStats.candidates++;
                continue;
            }
            // softObstacle means "my bounding box is not my shape" - it is set
            // on trees, the lake banks and whole authored level meshes. The
            // narrow phase below resolves a penetration by pushing the
            // particle out along the box's SMALLEST overlap axis, which is
            // meaningless for those: for a level exported as one mesh the box
            // is the entire structure, so a body falling anywhere inside its
            // footprint gets shoved to the nearest outer face - tens of units
            // straight up if that happens to be the top. That is the "flung
            // into the air while falling" case.
            //
            // The rest of the game already refuses to trust these boxes (see
            // isVerticalSpaceClear); the ragdoll was the one place still doing
            // it. Landing is unaffected - that comes from floorY, which is a
            // real raycast against the actual surface.
            if (obj.userData && obj.userData.softObstacle) continue;
            // Written straight into the candidate's own box so a rejected
            // object costs nothing beyond the one getObstacleBox call, and an
            // accepted one is already cached for the 300 inner iterations.
            if (window.getObstacleBox) window.getObstacleBox(obj, cand.box);
            else continue;
            if (!cand.box.intersectsBox(_ragdollAABB)) continue;
            cand.obj = obj; cand.isSphere = false; cand.isTrunk = false;
            _candidateCount++;
        }

        // ---- Swept pass, once per frame ----
        // Before the iterations, while oldPos->pos is still this frame's actual
        // motion (inside the loop the constraint solver has already moved
        // things and the segment stops meaning "where the body travelled").
        // This is what stops a body crossing a trunk outright; the per-iteration
        // shell test below only handles resting against one.
        for (let ci = 0; ci < _candidateCount; ci++) {
            const cand = _candidates[ci];
            if (!cand.isTrunk) continue;
            for (let pi = 0; pi < this.ragdollParticles.length; pi++) {
                if (_sweepTrunk(this.ragdollParticles[pi], cand) && window.trunkVizOn) trunkStats.pushes++;
            }
        }

        const collisionIters = window.ragdollCollisionIters !== undefined ? window.ragdollCollisionIters : 8;
        const collisionFrom = 20 - Math.max(1, Math.min(20, Math.round(collisionIters)));
        for (let iter = 0; iter < 20; iter++) {
            const resolveCollision = iter >= collisionFrom;
            this.ragdollConstraints.forEach(c => {
                _tempVec1.subVectors(c.p2.pos, c.p1.pos);
                const dist = _tempVec1.length();
                if (dist > 0.0001) {
                    const offset = _tempVec1.multiplyScalar(((dist - c.dist) / dist) * 0.5);
                    c.p1.pos.add(offset);
                    c.p2.pos.sub(offset);
                }
            });

            this.applyHingeLimit('lThigh', 'lKnee', 'lFoot', 0.1, 2.3);
            this.applyHingeLimit('rThigh', 'rKnee', 'rFoot', 0.1, 2.3);
            this.applyHingeLimit('lShoulder', 'lElbow', 'lHand', 0.1, 2.5);
            this.applyHingeLimit('rShoulder', 'rElbow', 'rHand', 0.1, 2.5);
            this.applyHingeLimit('spine', 'hips', 'lThigh', 0.5, 2.0);
            this.applyHingeLimit('spine', 'hips', 'rThigh', 0.5, 2.0);

            this.ragdollParticles.forEach(p => {
                    // floorY, not 0. This clamp is what stops a ragdoll
                    // sinking, and it was hardcoded to the world origin - so a
                    // body falling through open space had every particle
                    // snapped back up to y=0, which reads as being flung
                    // upward out of the fall. -Infinity (no ground anywhere
                    // below) makes the comparison false and the body simply
                    // keeps falling, which is the point.
                    if (p.pos.y < ragdollFloor + p.radius) {
                        p.pos.y = ragdollFloor + p.radius;
                        // Absorb the vertical velocity on landing instead of just
                        // repositioning: oldPos.y still reflected the pre-landing
                        // (falling) height, so next frame's implicit velocity
                        // would still read as "falling", clamp again, forever -
                        // a non-decaying jitter now that Y motion isn't damped.
                        p.oldPos.y = p.pos.y;
                        p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                        p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                    }

                    if (!resolveCollision) return;

                    const particleBox = _particleBox;
                    _boxSize.set(p.radius * 2, p.radius * 2, p.radius * 2);
                    particleBox.setFromCenterAndSize(p.pos, _boxSize);

                    for (let ci = 0; ci < _candidateCount; ci++) {
                        const cand = _candidates[ci];
                        const obj = cand.obj;

                        if (cand.isSphere) {
                            const radius = cand.radius;
                            const dist = p.pos.distanceTo(obj.position);
                            const minDist = radius + p.radius;
                            if (dist < minDist) {
                                const prevPos = _prevPos.copy(p.pos);
                                const normal = _tempVec3.subVectors(p.pos, obj.position).normalize();
                                p.pos.copy(obj.position).addScaledVector(normal, minDist);
                                const displacement = _tempVec1.subVectors(p.pos, prevPos);
                                p.oldPos.add(displacement);
                                // Resting on top of a sphere is the only case that
                                // matters here (same non-decaying jitter risk as
                                // the floor/box cases below) - only kill vertical
                                // velocity, horizontal contact should keep sliding.
                                if (normal.y > 0.5) p.oldPos.y = p.pos.y;
                            }
                            continue;
                        }

                        if (cand.isTrunk) {
                            // Resting contact against the trunk's real
                            // triangles. Two things here are not the obvious
                            // choice, and both were bugs first:
                            //
                            // The direction is the triangle's own FACE NORMAL,
                            // not (particle - closest point). For a closed
                            // volume that vector points from the surface into
                            // the interior whenever the particle is inside, so
                            // pushing along it drives the particle DEEPER - and
                            // a body squeezed along the inside of a trunk rides
                            // up it, which is the "slides to the treetop" case.
                            //
                            // The SHALLOWEST overlap wins, not the deepest. The
                            // depth here is measured along each face's normal,
                            // so the smallest one is the nearest way out; taking
                            // the largest would eject the body through the far
                            // side of the trunk.
                            const tris = cand.tris;
                            let bestDepth = Infinity;
                            for (let t = 0; t < cand.triCount; t++) {
                                const o = t * 9;
                                _ctA.set(tris[o], tris[o + 1], tris[o + 2]);
                                _ctB.set(tris[o + 3], tris[o + 4], tris[o + 5]);
                                _ctC.set(tris[o + 6], tris[o + 7], tris[o + 8]);
                                // Cheap reject before the Voronoi walk.
                                if (Math.min(_ctA.x, _ctB.x, _ctC.x) - p.pos.x > p.radius) continue;
                                if (p.pos.x - Math.max(_ctA.x, _ctB.x, _ctC.x) > p.radius) continue;
                                if (Math.min(_ctA.y, _ctB.y, _ctC.y) - p.pos.y > p.radius) continue;
                                if (p.pos.y - Math.max(_ctA.y, _ctB.y, _ctC.y) > p.radius) continue;
                                if (Math.min(_ctA.z, _ctB.z, _ctC.z) - p.pos.z > p.radius) continue;
                                if (p.pos.z - Math.max(_ctA.z, _ctB.z, _ctC.z) > p.radius) continue;
                                // Proximity still comes from the closest point,
                                // so a particle beside a face rather than over
                                // it is correctly left alone.
                                _closestOnTri(p.pos, _ctA, _ctB, _ctC, _trunkClosest);
                                if (_trunkDelta.subVectors(p.pos, _trunkClosest).lengthSq() >= p.radius * p.radius) continue;
                                _triN.crossVectors(
                                    _ctAB.subVectors(_ctB, _ctA), _ctAC.subVectors(_ctC, _ctA));
                                if (_triN.lengthSq() < 1e-12) continue;
                                _triN.normalize();
                                const depth = p.radius - _trunkDelta.subVectors(p.pos, _ctA).dot(_triN);
                                if (depth <= 0 || depth >= bestDepth) continue;
                                bestDepth = depth;
                                _trunkPush.copy(_triN);
                            }
                            if (bestDepth === Infinity) continue;
                            const prevPos = _prevPos.copy(p.pos);
                            p.pos.addScaledVector(_trunkPush, bestDepth);
                            if (window.trunkVizOn) trunkStats.pushes++;
                            // Carry the correction into oldPos so the contact
                            // does not read as velocity next frame, same as
                            // every other branch here.
                            p.oldPos.add(_trunkDelta.subVectors(p.pos, prevPos));
                            // Lying on a branch is a real resting contact, so
                            // kill vertical velocity the way the floor and box
                            // branches do - otherwise it bounces forever.
                            if (_trunkPush.y > 0.5) p.oldPos.y = p.pos.y;
                            particleBox.setFromCenterAndSize(p.pos, _boxSize);
                            continue;
                        }

                        // Cached by the broad phase above - the obstacles do
                        // not move while the solver runs, so recomputing this
                        // 300 times per object was pure waste.
                        const obstacleBox = cand.box;

                        if (particleBox.intersectsBox(obstacleBox)) {
                            const prevPos = _prevPos.copy(p.pos);
                            const overlapX = Math.min(particleBox.max.x - obstacleBox.min.x, obstacleBox.max.x - particleBox.min.x);
                            const overlapY = Math.min(particleBox.max.y - obstacleBox.min.y, obstacleBox.max.y - particleBox.min.y);
                            const overlapZ = Math.min(particleBox.max.z - obstacleBox.min.z, obstacleBox.max.z - particleBox.min.z);

                            let correctedY = false;
                            if (overlapX < overlapY && overlapX < overlapZ) {
                                p.pos.x += Math.sign(p.pos.x - obj.position.x) * overlapX;
                            } else if (overlapY < overlapX && overlapY < overlapZ) {
                                p.pos.y += Math.sign(p.pos.y - obj.position.y) * overlapY;
                                correctedY = true;
                                if (Math.sign(p.pos.y - obj.position.y) > 0) {
                                    p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                                    p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                                }
                            } else {
                                p.pos.z += Math.sign(p.pos.z - obj.position.z) * overlapZ;
                            }

                            const displacement = _tempVec3.subVectors(p.pos, prevPos);
                            if (displacement.lengthSq() > 0.0001) p.oldPos.add(displacement);
                            // oldPos.add above preserves velocity through the
                            // correction (fine for X/Z sliding), but for a Y (top
                            // surface) landing that just perpetuates a non-decaying
                            // bounce - kill vertical velocity here instead.
                            if (correctedY) p.oldPos.y = p.pos.y;
                            particleBox.setFromCenterAndSize(p.pos, _boxSize);
                        }
                    }
                });
        }

        const hipsP = this.getParticle('hips');
        if (hipsP && this.hips) {
            this.hips.position.copy(this.hips.parent.worldToLocal(_tempVec1.copy(hipsP.pos)));
            this.hips.updateMatrixWorld(true);
        }
        
        this.ragdollLinks.forEach(link => {
            if (link.bone) {
                const p1 = this.getParticle(link.p1);
                const p2 = this.getParticle(link.p2);
                if (p1 && p2) {
                    _tempVec1.subVectors(p2.pos, p1.pos).normalize();
                    if (link.initialDir && _tempVec1.lengthSq() > 0.1 && link.initialDir.lengthSq() > 0.1) {
                        _tempQuat.setFromUnitVectors(link.initialDir, _tempVec1);
                        _tempQuat.multiply(link.initialQuat);
                        const parentWorldQuat = link.bone.parent.getWorldQuaternion(new THREE.Quaternion());
                        link.bone.quaternion.copy(parentWorldQuat.invert().multiply(_tempQuat));
                        link.bone.updateMatrixWorld(true);
                    }
                }
            }
        });
    },

    updateStandUp(delta) {
        if (!this.isStandingUp) return false;
        if (this.standUpFinished) {
            this.isStandingUp = false; this.standUpDirection = 'none'; this.standUpFinished = false;
            return true;
        }
        return false;
    },

    syncColliders() {
        if (!this.ragdollColliderGroup.visible) return;
        this.ragdollParticles.forEach(p => {
            if (p.mesh && p.bone) {
                if (!this.isRagdoll) p.bone.getWorldPosition(p.mesh.position);
                else p.mesh.position.copy(p.pos);
                p.bone.getWorldQuaternion(p.mesh.quaternion);
            }
        });
    }
};