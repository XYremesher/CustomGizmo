import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RagdollPhysics } from './ragdoll_physics.js';

const BASE_URL = 'https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/';

const REMOTE_ANIMS = [
    { name: 'idle', file: 'Idle.fbx' },
    { name: 'walk', file: 'Walking.fbx' },
    { name: 'run', file: 'Running.fbx' },
    { name: 'jump_start', file: 'JumpStart.fbx' },
    { name: 'fall', file: 'JumpMidAir.fbx' },
    { name: 'land', file: 'Landing.fbx' },
    { name: 'hang_idle', file: 'Hanging%20Idle.fbx' },
    { name: 'climb', file: 'Freehang%20Climb.fbx' },
    { name: 'push', file: 'Push.fbx' },
    { name: 'pull', file: 'Pull.fbx' },
    { name: 'carry_start', file: 'Carry_Start.fbx' },
    { name: 'carry', file: 'Carry.fbx' },
    { name: 'throw', file: 'Throw.fbx' },
    { name: 'punch_left', file: 'Combat/Punch_Left.fbx' },
    { name: 'punch_right', file: 'Combat/Punch_Right.fbx' },
    { name: 'punch_combo', file: 'Combat/Punch_Combo.fbx' },
    { name: 'punch_charge', file: 'Combat/Punch_Charge.fbx' },
    { name: 'punch_walk', file: 'PunchWalk.fbx' },
    { name: 'standup_front', file: 'StandUp_Front.fbx' },
    { name: 'standup_back', file: 'StandUp_Back.fbx' },
    { name: 'slide', file: 'Slide.fbx' }
];

// punch_walk deliberately excluded - see the matching comment in
// ClimbGame.html's setupActionProperties, it needs to loop for a sustained
// walk cycle instead of freezing after one stride.
const ONE_SHOT_ANIMS = new Set(['jump_start', 'climb', 'land', 'throw', 'carry_start', 'punch_left', 'punch_right', 'punch_combo', 'punch_charge_hold', 'punch_charge_punch', 'standup_front', 'standup_back']);
const LOWER_SPLIT_ANIMS = ['idle', 'walk', 'run'];

function processClip(clip) {
    let minTime = Infinity;
    clip.tracks.forEach(track => { if (track.times.length > 0) minTime = Math.min(minTime, track.times[0]); });
    if (minTime > 0 && minTime !== Infinity) {
        clip.tracks.forEach(track => { for (let i = 0; i < track.times.length; i++) track.times[i] -= minTime; });
        clip.duration -= minTime;
    }
    return clip;
}

// Mirrors Character's upper/lower track split in the HTML file: while carrying,
// legs keep playing the normal movement clip and only the upper body (spine/
// arms/hands) is overridden by the carry pose, so the two clips must animate
// disjoint track sets to run on the mixer at the same time without fighting.
function isUpperBodyTrack(trackName) {
    const lowerName = trackName.toLowerCase();
    const upperKeywords = ['spine', 'neck', 'head', 'shoulder', 'arm', 'forearm', 'hand', 'finger', 'clavicle', 'chest'];
    const lowerKeywords = ['upleg', 'leg', 'foot', 'toe', 'hips', 'pelvis'];
    if (lowerKeywords.some(k => lowerName.includes(k))) return false;
    return upperKeywords.some(k => lowerName.includes(k));
}

function makeLowerBodyClip(originalClip) {
    const tracks = originalClip.tracks.filter(t => !isUpperBodyTrack(t.name)).map(t => t.clone());
    return new THREE.AnimationClip(originalClip.name + '_lower', originalClip.duration, tracks);
}

function makeUpperBodyClip(originalClip) {
    const tracks = originalClip.tracks.filter(t => isUpperBodyTrack(t.name)).map(t => t.clone());
    return new THREE.AnimationClip(originalClip.name + '_upper', originalClip.duration, tracks);
}

const _stabQuat = new THREE.Quaternion();
const _stabQuat2 = new THREE.Quaternion();
const _ragdollRayOrigin = new THREE.Vector3();
const _ragdollDownVec = new THREE.Vector3(0, -1, 0);
const _ragdollRaycaster = new THREE.Raycaster();
const _recoilEuler = new THREE.Euler();
const _recoilQOffset = new THREE.Quaternion();
const _recoilScratchQuat = new THREE.Quaternion();
const _recoilIdentity = new THREE.Quaternion();

// A deliberately minimal, physics-free stand-in for another player's Character.
// It only knows how to move toward the latest network sample and play the
// matching animation clip - no ledge/ragdoll/combat logic at all.
export class RemoteAvatar {
    constructor(scene, threeTone, id) {
        this.id = id;
        this.scene = scene;
        this.group = new THREE.Group();
        scene.add(this.group);

        this.mixer = null;
        this.actions = {};
        this.activeAction = null;
        this.activeUpperAction = null;
        this.isLoaded = false;

        this.targetPos = new THREE.Vector3();
        this.targetQuat = new THREE.Quaternion();
        this.hasTarget = false;
        this.stateName = 'idle';
        this.carryUpper = false;

        this.spine = null;
        this.spine1 = null;
        this.neck = null;
        this.stabilizeWeight = 0.0;
        this.lastSpineWorld = null;
        this.lastSpine1World = null;
        this.lastNeckWorld = null;
        this.lastGroupQuat = null;

        this.leftHandBone = null;
        this.rightHandBone = null;
        this.heldMesh = null;
        this._leftHandPos = new THREE.Vector3();
        this._rightHandPos = new THREE.Vector3();
        this._handMid = new THREE.Vector3();

        this.hitFlashUniforms = [];
        this.hitFlashTimer = 0;
        this.hitFlashDuration = 0.15;
        this.hitFlashStrength = 1.0;

        // Set via setColor() once a broadcast tells us this player's assigned
        // color (see MultiplayerClient) - stored even before the model loads
        // so the very first material created already uses it, not the
        // fallback blue, if the color arrives first.
        this.bodyMaterials = [];
        this.bodyMeshes = [];
        this.bodyColor = null;

        // Cosmetic-only mirrors of CombatController's swing-particle/charge-glow
        // effects in the HTML file: the local puncher already sends its punch
        // animation state (punch_left/right/combo/punch_charge_hold/punch_charge_punch,
        // see game_js.js's networkStateName), so this avatar can reproduce the same
        // particle timing purely from its own mixer clock, no extra network data needed.
        this.chargeEffect = null;
        this._pendingChargeMature = false;
        this._lastPunchAnim = null;
        this._punchHitFlags = [false, false, false, false, false];
        // Mirrors CombatController's punchTimer/chargeDuration maturity
        // tracking (ClimbGame.html) instead of reading time off whichever of
        // punch_charge_hold/punch_walk clip is currently active - punch_walk
        // loops (has to, for a sustained walk cycle), so its own .time
        // cycles back to 0 repeatedly and would make the energy ball reset
        // every stride if read directly. Counts up for as long as stateName
        // is either charge-hold variant, carrying over across a mid-charge
        // switch between them the same way the real puncher's own does.
        this._chargeElapsed = 0;
        this._chargeDuration = 1;
        this._wasChargeHoldState = false;

        // Ragdoll runs the same RagdollPhysics module Character uses, mixed into
        // this class below - triggered by a lightweight one-shot network event
        // (velocity + intensity, see MultiplayerClient._applyRagdollEvent), never
        // by streaming joint positions. Each client simulates it independently.
        this.hips = null;
        this.rootBone = null;
        this.isRagdoll = false;
        this.ragdollParticles = [];
        this.ragdollConstraints = [];
        this.ragdollLinks = [];
        this.ragdollTimer = 0;
        this.ragdollMaxTime = 2.5;
        this.currentRagdollIntensity = 'high';
        this.standUpDirection = 'none';
        this.isStandingUp = false;
        this.standUpFinished = false;
        this.standupStartTime = 0.20;
        this.standupSpeed = 1.2;
        this.standupCrossfade = 0.45;
        this.ragdollPoseDuration = 0.15;
        this._standupCorrectionPos = null;
        this._standupCorrectionQuat = null;

        // Lightweight "flinch" reaction for non-ragdoll hits (low/medium/medium_high
        // intensity), also from RagdollPhysics: a decaying rotational impulse on
        // spine/spine1/neck, no particles or floor collision involved.
        this.recoilRotation = new THREE.Vector3();
        this.recoilVelocity = new THREE.Vector3();
        this.defaultSpineQuat = null;
        this.defaultSpine1Quat = null;
        this.defaultNeckQuat = null;

        const loader = new FBXLoader();
        loader.load(BASE_URL + 'StickMan.fbx', (object) => {
            this.fbxModel = object;
            object.scale.setScalar(0.0065);

            object.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    if (child.material) {
                        const mainMat = new THREE.MeshToonMaterial({ color: this.bodyColor !== null ? this.bodyColor : 0x66aaff, gradientMap: threeTone });
                        this.bodyMaterials.push(mainMat);
                        this.bodyMeshes.push(child);
                        const rimUniform = { value: 0.0 };
                        mainMat.onBeforeCompile = (shader) => {
                            shader.uniforms.rimIntensity = rimUniform;
                            shader.vertexShader = shader.vertexShader
                                .replace(
                                    '#include <common>',
                                    `#include <common>
                                    varying vec3 vRimNormal;
                                    varying vec3 vRimViewDir;`
                                )
                                .replace(
                                    '#include <project_vertex>',
                                    `#include <project_vertex>
                                    vRimNormal = normalize(transformedNormal);
                                    vRimViewDir = normalize(-mvPosition.xyz);`
                                );
                            shader.fragmentShader = shader.fragmentShader
                                .replace(
                                    '#include <common>',
                                    `#include <common>
                                    uniform float rimIntensity;
                                    varying vec3 vRimNormal;
                                    varying vec3 vRimViewDir;`
                                )
                                .replace(
                                    '#include <dithering_fragment>',
                                    `#include <dithering_fragment>
                                    float rimFactor = 1.0 - max(dot(normalize(vRimNormal), normalize(vRimViewDir)), 0.0);
                                    rimFactor = pow(rimFactor, 2.0) * rimIntensity;
                                    gl_FragColor.rgb += vec3(1.0) * rimFactor;`
                                );
                        };
                        child.material = mainMat;
                        this.hitFlashUniforms.push(rimUniform);
                    }
                }
                if (child.isBone) {
                    const name = child.name.toLowerCase();
                    if (name.includes('spine1')) this.spine1 = child;
                    else if (name.includes('spine')) this.spine = child;
                    if (name.includes('neck')) this.neck = child;
                    if (name.includes('lefthand')) this.leftHandBone = child;
                    if (name.includes('righthand')) this.rightHandBone = child;
                    if (name.includes('hips') || name.includes('pelvis')) this.hips = child;
                    if (name.includes('root')) this.rootBone = child;
                }
            });

            // Same bone-name fallback chains as Character's `keyBones` setup in
            // the HTML file, kept as one-off lookups (only run once per avatar)
            // rather than folded into the traverse above so the preference order
            // (e.g. "LeftArm" over "LeftShoulder") matches exactly.
            const findBone = (name) => {
                let res = null;
                object.traverse((child) => { if (child.isBone && !res && child.name.toLowerCase().includes(name)) res = child; });
                return res;
            };

            const keyBones = [
                { id: 'hips', bone: this.hips, radius: 0.18 },
                { id: 'spine', bone: this.spine1 || this.spine, radius: 0.22 },
                { id: 'head', bone: findBone('head'), radius: 0.45 },
                { id: 'lShoulder', bone: findBone('leftarm') || findBone('leftshoulder'), radius: 0.1 },
                { id: 'lElbow', bone: findBone('leftforearm'), radius: 0.08 },
                { id: 'lHand', bone: this.leftHandBone, radius: 0.07 },
                { id: 'rShoulder', bone: findBone('rightarm') || findBone('rightshoulder'), radius: 0.1 },
                { id: 'rElbow', bone: findBone('rightforearm'), radius: 0.08 },
                { id: 'rHand', bone: this.rightHandBone, radius: 0.07 },
                { id: 'lThigh', bone: findBone('leftupleg'), radius: 0.12 },
                { id: 'lKnee', bone: findBone('leftleg'), radius: 0.1 },
                { id: 'lFoot', bone: findBone('leftfoot') || findBone('lefttoe'), radius: 0.09 },
                { id: 'rThigh', bone: findBone('rightupleg'), radius: 0.12 },
                { id: 'rKnee', bone: findBone('rightleg'), radius: 0.1 },
                { id: 'rFoot', bone: findBone('rightfoot') || findBone('righttoe'), radius: 0.09 }
            ];
            keyBones.forEach((kb) => {
                if (kb.bone) {
                    this.ragdollParticles.push({
                        id: kb.id, bone: kb.bone, pos: new THREE.Vector3(), oldPos: new THREE.Vector3(), radius: kb.radius
                    });
                }
            });

            this.group.add(object);
            this.mixer = new THREE.AnimationMixer(object);
            this.mixer.addEventListener('finished', (e) => {
                if (e.action === this.actions['standup_front'] || e.action === this.actions['standup_back']) {
                    this.standUpFinished = true;
                }
            });

            const makeAction = (name, clip) => {
                const action = this.mixer.clipAction(clip);
                if (ONE_SHOT_ANIMS.has(name)) {
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                }
                this.actions[name] = action;
            };

            Promise.all(REMOTE_ANIMS.map(anim =>
                loader.loadAsync(BASE_URL + anim.file)
                    .then(animObj => {
                        if (animObj.animations.length === 0) return;
                        if (anim.name === 'punch_charge') {
                            makeAction('punch_charge_hold', processClip(animObj.animations[0]));
                            makeAction('punch_charge_punch', processClip(animObj.animations[1] || animObj.animations[0]));
                            return;
                        }
                        const clip = processClip(animObj.animations[0]);
                        makeAction(anim.name, clip);
                        if (LOWER_SPLIT_ANIMS.includes(anim.name)) {
                            makeAction(anim.name + '_lower', makeLowerBodyClip(clip));
                        } else if (anim.name === 'carry') {
                            makeAction('carry_upper', makeUpperBodyClip(clip));
                        }
                    })
                    .catch(err => console.error('RemoteAvatar: failed to load anim', anim.name, err))
            )).then(() => {
                this.isLoaded = true;
                this.fadeToAction('idle', 0);
            });
        });
    }

    fadeToAction(name, duration = 0.2) {
        const action = this.actions[name];
        if (!action || this.activeAction === action) return;
        const previous = this.activeAction;
        this.activeAction = action;
        if (previous) {
            if (duration <= 0) previous.stop();
            else previous.fadeOut(duration);
        }
        action.reset().setEffectiveWeight(1);
        if (duration > 0) action.fadeIn(duration);
        action.play();
    }

    fadeToUpperAction(name, duration = 0.2) {
        const action = this.actions[name];
        if (!action || this.activeUpperAction === action) return;
        const previous = this.activeUpperAction;
        this.activeUpperAction = action;
        if (previous) {
            if (duration <= 0) previous.stop();
            else previous.fadeOut(duration);
        }
        action.reset().setEffectiveWeight(1);
        if (duration > 0) action.fadeIn(duration);
        action.play();
    }

    stopUpperAction(duration = 0.2) {
        if (this.activeUpperAction) {
            if (duration <= 0) this.activeUpperAction.stop();
            else this.activeUpperAction.fadeOut(duration);
            this.activeUpperAction = null;
        }
    }

    setColor(hexColor) {
        this.bodyColor = hexColor;
        this.bodyMaterials.forEach(m => m.color.setHex(hexColor));
        this.bodyMeshes.forEach(mesh => { if (mesh.userData.phongMat) mesh.userData.phongMat.color.setHex(hexColor); });
    }

    // Mirrors Character.setDynamicShading in the HTML file - remote players
    // (and the AI bot, which is also a RemoteAvatar) are "dynamic" for the
    // Phong/Lambert shading test the same way the local player is.
    setDynamicShading(enabled) {
        this.bodyMeshes.forEach((mesh, i) => {
            if (enabled) {
                if (!mesh.userData.phongMat) {
                    const src = this.bodyMaterials[i];
                    mesh.userData.phongMat = new THREE.MeshPhongMaterial({ color: src.color.clone(), map: src.map || null, shininess: 30 });
                }
                mesh.material = mesh.userData.phongMat;
            } else {
                mesh.material = this.bodyMaterials[i];
            }
        });
    }

    spawnSwingParticle() {
        if (!window.spawnPunchSpeedParticle) return;
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
        const pos = new THREE.Vector3();

        if (this.leftHandBone && this.rightHandBone) {
            const leftPos = new THREE.Vector3();
            const rightPos = new THREE.Vector3();
            this.leftHandBone.getWorldPosition(leftPos);
            this.rightHandBone.getWorldPosition(rightPos);
            const leftReach = leftPos.clone().sub(this.group.position).dot(forward);
            const rightReach = rightPos.clone().sub(this.group.position).dot(forward);
            pos.copy(leftReach >= rightReach ? leftPos : rightPos);
        } else if (this.leftHandBone) {
            this.leftHandBone.getWorldPosition(pos);
        } else if (this.rightHandBone) {
            this.rightHandBone.getWorldPosition(pos);
        } else {
            return;
        }

        window.spawnPunchSpeedParticle(pos, forward);
    }

    startChargeEffect() {
        if (this.chargeEffect || !window.gameScene) return;

        const glowGeo = new THREE.SphereGeometry(0.18, 12, 12);
        const glowMat = new THREE.MeshBasicMaterial({
            color: 0xffee44,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const glow = new THREE.Mesh(glowGeo, glowMat);
        window.gameScene.add(glow);

        // Bigger, softer yellow aura around the (now orange-red) core once
        // mature - only shown then, see updateChargeEffect.
        const outerGlowGeo = new THREE.SphereGeometry(0.18, 12, 12);
        const outerGlowMat = new THREE.MeshBasicMaterial({
            color: 0xffee44,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });
        const outerGlow = new THREE.Mesh(outerGlowGeo, outerGlowMat);
        outerGlow.visible = false;
        window.gameScene.add(outerGlow);

        const streakGeo = new THREE.BoxGeometry(0.04, 0.04, 0.5);
        const streakMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: window.chargeStreakOpacity !== undefined ? window.chargeStreakOpacity : 0.3,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        const streaks = [];
        for (let i = 0; i < 8; i++) {
            const mesh = new THREE.Mesh(streakGeo, streakMat);
            window.gameScene.add(mesh);
            const streak = { mesh };
            this.resetStreak(streak);
            streak.progress = Math.random();
            streaks.push(streak);
        }

        this.chargeEffect = { glow, outerGlow, streaks, streakGeo, streakMat, time: 0 };
    }

    resetStreak(streak) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos((Math.random() * 2) - 1);
        streak.dir = new THREE.Vector3(
            Math.sin(phi) * Math.cos(theta),
            Math.sin(phi) * Math.sin(theta),
            Math.cos(phi)
        );
        const baseRadius = window.chargeStreakBaseRadius !== undefined ? window.chargeStreakBaseRadius : 0.55;
        const radiusSpread = window.chargeStreakRadiusSpread !== undefined ? window.chargeStreakRadiusSpread : 0.5;
        streak.radius = baseRadius + Math.random() * radiusSpread;
        streak.progress = 0;
        streak.speed = 0.8 + Math.random() * 0.6;
    }

    updateChargeEffect(delta) {
        if (!this.chargeEffect || !this.rightHandBone) return;
        const handPos = new THREE.Vector3();
        this.rightHandBone.getWorldPosition(handPos);

        this.chargeEffect.time += delta;
        this.chargeEffect.glow.position.copy(handPos);

        // Mirrors CombatController's punchTimer/chargeDuration in the HTML
        // file (see the comment on _chargeElapsed in the constructor for why
        // it's not read off the active clip's own time - punch_walk loops).
        const growthT = Math.min(1, this._chargeElapsed / (this._chargeDuration || 1));
        const isMature = growthT >= 1.0;
        let growth, pulse;
        if (isMature) {
            growth = 1.3;
            pulse = 1.0 + Math.sin(this.chargeEffect.time * 14) * 0.18;
        } else {
            growth = 0.4 + 0.6 * growthT;
            pulse = 1.0 + Math.sin(this.chargeEffect.time * 10) * 0.15;
        }
        this.chargeEffect.glow.scale.setScalar(growth * pulse);
        if (isMature !== this.chargeEffect.isMature) {
            this.chargeEffect.glow.material.color.setHex(isMature ? 0xff4400 : 0xffee44);
            this.chargeEffect.isMature = isMature;
        }
        this.chargeEffect.outerGlow.visible = isMature;
        if (isMature) {
            this.chargeEffect.outerGlow.position.copy(handPos);
            this.chargeEffect.outerGlow.scale.setScalar(2.2 * pulse);
        }
        this.chargeEffect.streakMat.opacity = window.chargeStreakOpacity !== undefined ? window.chargeStreakOpacity : 0.3;

        const streakPos = new THREE.Vector3();
        this.chargeEffect.streaks.forEach(streak => {
            streak.progress += streak.speed * delta;
            if (streak.progress >= 1) this.resetStreak(streak);

            const dist = streak.radius * (1 - streak.progress);
            streakPos.copy(handPos).addScaledVector(streak.dir, dist);
            streak.mesh.position.copy(streakPos);
            streak.mesh.lookAt(handPos);
            streak.mesh.scale.set(1, 1, 1 - streak.progress * 0.3);
        });
    }

    stopChargeEffect() {
        if (!this.chargeEffect) return;
        window.gameScene.remove(this.chargeEffect.glow);
        this.chargeEffect.glow.geometry.dispose();
        this.chargeEffect.glow.material.dispose();
        window.gameScene.remove(this.chargeEffect.outerGlow);
        this.chargeEffect.outerGlow.geometry.dispose();
        this.chargeEffect.outerGlow.material.dispose();
        this.chargeEffect.streaks.forEach(s => window.gameScene.remove(s.mesh));
        this.chargeEffect.streakGeo.dispose();
        this.chargeEffect.streakMat.dispose();
        this.chargeEffect = null;
    }

    // Mirrors CombatController.update()'s hit-frame-window particle spawning,
    // driven off this avatar's own mixer clock instead of a local punchTimer -
    // stateName/action.time already advance in lockstep with the exact same
    // clips the puncher's own client is playing, so the swing-particle timing
    // matches without needing extra network events per punch.
    updatePunchEffects(delta) {
        const stateName = this.stateName;
        const isChargeHoldState = stateName === 'punch_charge_hold' || stateName === 'punch_walk';

        if (isChargeHoldState) {
            if (!this._wasChargeHoldState) {
                // Just started charging (from some other state) - fresh
                // timer. Switching between punch_charge_hold and punch_walk
                // (this avatar's own stateName may flip between them exactly
                // like the real puncher's does) does NOT hit this branch,
                // since isChargeHoldState was already true last frame too -
                // that's what keeps _chargeElapsed running continuously
                // across the switch instead of resetting.
                this._chargeElapsed = 0;
                const holdClip = this.actions['punch_charge_hold'] && this.actions['punch_charge_hold'].getClip();
                this._chargeDuration = holdClip ? holdClip.duration : 1;
            }
            this._chargeElapsed += delta;
            this.startChargeEffect();
            this.updateChargeEffect(delta);
        } else if (this.chargeEffect) {
            // chargeEffect.isMature tracked whether this avatar's own
            // punch_charge_hold clip reached its last frame (same synced
            // animation clock as the real puncher) - stashed here since
            // chargeEffect itself is gone by the time the hit-frame-window
            // check below (once punch_charge_punch actually reaches it) is
            // ready to spawn the projectile.
            this._pendingChargeMature = this.chargeEffect.isMature;
            this.stopChargeEffect();
        }
        this._wasChargeHoldState = isChargeHoldState;

        if (stateName !== this._lastPunchAnim) {
            this._punchHitFlags = [false, false, false, false, false];
            this._lastPunchAnim = stateName;
        }

        const action = this.actions[stateName];
        if (!action) return;
        const duration = action.getClip().duration;
        const normalizedTime = action.time / duration;

        if (stateName === 'punch_left' || stateName === 'punch_right' || stateName === 'punch_charge_punch') {
            const hitStart = stateName === 'punch_charge_punch'
                ? (window.chargePunchHitTime !== undefined ? window.chargePunchHitTime : 0.35)
                : (window.punchHitTime !== undefined ? window.punchHitTime : 0.35);
            const hitEnd = hitStart + 0.2;
            if (normalizedTime >= hitStart && normalizedTime <= hitEnd && !this._punchHitFlags[0]) {
                this.spawnSwingParticle();
                // Only a fully-matured hold earns the projectile - mirrors the
                // isMatureCharge gate in the puncher's own detectMeleeHits.
                if (stateName === 'punch_charge_punch' && this._pendingChargeMature && window.spawnChargeAttackProjectile && this.rightHandBone) {
                    const handPos = new THREE.Vector3();
                    this.rightHandBone.getWorldPosition(handPos);
                    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
                    window.spawnChargeAttackProjectile(handPos, fwd, this.id);
                }
                this._punchHitFlags[0] = true;
            }
        } else if (stateName === 'punch_combo') {
            const comboHitTimes = [window.comboHit1Time !== undefined ? window.comboHit1Time : 0.15, 0.32, 0.48, 0.65, 0.82];
            for (let i = 0; i < 5; i++) {
                if (normalizedTime >= comboHitTimes[i] && normalizedTime <= (comboHitTimes[i] + 0.15) && !this._punchHitFlags[i]) {
                    this.spawnSwingParticle();
                    this._punchHitFlags[i] = true;
                }
            }
        }
    }

    triggerHitFlash(strength = 1.0) {
        this.hitFlashTimer = this.hitFlashDuration;
        this.hitFlashStrength = THREE.MathUtils.clamp(strength, 0, 3);
    }

    updateHitFlash(delta) {
        if (this.hitFlashTimer > 0) {
            this.hitFlashTimer -= delta;
            const flashT = (Math.max(0, this.hitFlashTimer) / this.hitFlashDuration) * this.hitFlashStrength;
            this.hitFlashUniforms.forEach(u => { u.value = flashT; });
        } else {
            this.hitFlashUniforms.forEach(u => { u.value = 0; });
        }
    }

    setNetworkState(pos, quat, stateName, carryUpper) {
        if (pos) this.targetPos.set(pos[0], pos[1], pos[2]);
        if (quat) this.targetQuat.set(quat[0], quat[1], quat[2], quat[3]);
        this.hasTarget = true;
        if (stateName) this.stateName = stateName;
        this.carryUpper = !!carryUpper;
    }

    // While ragdolling/standing up, RagdollPhysics moves the hips bone within
    // local space and leaves this.group frozen at wherever the ragdoll started
    // (only beginStandUp snaps the group back, once it's over) - so anything
    // that needs "where is this avatar's body right now" (melee hit-detection,
    // shooter-corridor blocking) has to read the hips' world position during
    // that window instead of the stale group position, or it'll check against
    // a spot the visible body may have fallen/rolled well away from.
    getHitReferencePoint(out = new THREE.Vector3()) {
        if ((this.isRagdoll || this.isStandingUp) && this.hips) {
            this.hips.getWorldPosition(out);
            return out;
        }
        out.copy(this.group.position);
        out.y += 1.0;
        return out;
    }

    // Called when the real player's own beginStandUp reports where/which way
    // it actually ended up facing. Blended in (not snapped) in
    // _applyPendingStandupCorrection once this avatar's own local ragdoll flag
    // flips off, whichever order this correction and that avatar's own
    // beginStandUp happen to land in.
    setStandupOrientation(pos, quat) {
        this._standupCorrectionPos = pos;
        this._standupCorrectionQuat = quat;
        this._standupCorrectionTarget = null;
        this._standupCorrectionTargetQuat = null;
    }

    _applyPendingStandupCorrection(delta) {
        if (!this._standupCorrectionQuat || this.isRagdoll) return;

        if (!this._standupCorrectionTarget) {
            this._standupCorrectionTarget = new THREE.Vector3().fromArray(this._standupCorrectionPos);
            this._standupCorrectionTargetQuat = new THREE.Quaternion().fromArray(this._standupCorrectionQuat);
        }

        // Ease toward the real result over a few frames instead of an instant
        // set() - the independent local sim can end up a little off in position
        // too (not just facing), and snapping there in one frame reads as a pop.
        const t = Math.min(1, delta * 6);
        this.group.position.lerp(this._standupCorrectionTarget, t);
        this.group.quaternion.slerp(this._standupCorrectionTargetQuat, t);

        if (this.group.position.distanceTo(this._standupCorrectionTarget) < 0.01) {
            this._standupCorrectionPos = null;
            this._standupCorrectionQuat = null;
            this._standupCorrectionTarget = null;
            this._standupCorrectionTargetQuat = null;
        }
    }

    update(delta) {
        if (!this.isLoaded) return;

        this._applyPendingStandupCorrection(delta);

        // Runs every frame regardless of ragdoll/standup, same as Character's
        // own updateHitFlash call in game_js.js's main loop - it used to live
        // inside the branch below and freeze mid-flash for the whole ragdoll
        // duration (the decay timer never ticked down while ragdolling), only
        // resuming - and looking like a fresh flash - once standup finished.
        this.updateHitFlash(delta);

        // Ragdoll/standup own the group+bone transforms entirely (RagdollPhysics
        // moves the hips bone in local space, not this.group), so the network
        // position lerp and normal state-driven animation are skipped for their
        // whole duration - exactly like Character's own animate() dispatch.
        if (this.isRagdoll) {
            if (this.chargeEffect) this.stopChargeEffect();
            const floorY = this._ragdollFloorY();
            this.updateRagdoll(delta, window.collidables || [], floorY);
            const hipsP = this.getParticle('hips');
            // See the matching comment in game_js.js: ragdoll's per-frame
            // displacement is capped, so a hit from up high can still be well
            // above the floor once ragdollMaxTime elapses - keep falling
            // (capped-speed but continuous) until actually near the ground,
            // rather than letting the standup crossfade paper over a real
            // height gap as an unnaturally slow float down.
            const nearFloor = !hipsP || (hipsP.pos.y - floorY) < 1.0;
            if (this.ragdollTimer > this.ragdollMaxTime && (nearFloor || this.ragdollTimer > this.ragdollMaxTime + 5.0)) {
                this.beginStandUp(hipsP ? Math.max(0, hipsP.pos.y - 0.5) : 0);
            }
            if (this.mixer) this.mixer.update(delta);
            return;
        }
        if (this.isStandingUp) {
            if (this.chargeEffect) this.stopChargeEffect();
            if (this.updateStandUp(delta)) {
                this.fadeToAction('idle', 0.3);
                // The sender stops broadcasting position while ragdolled/standing
                // up, so targetPos/targetQuat are still whatever they were right
                // before the hit - re-sync them to where we actually just stood
                // up, otherwise the lerp below (resuming next frame) would yank
                // the avatar back toward that stale pre-hit spot for a moment.
                this.targetPos.copy(this.group.position);
                this.targetQuat.copy(this.group.quaternion);
            }
            if (this.mixer) this.mixer.update(delta);
            return;
        }

        // Undo last frame's recoil-offset multiply before the mixer recomputes
        // this frame's pose, otherwise the repeated quaternion.multiply calls
        // in applyRecoilVisual would permanently drift the bones over time.
        if (this.spine && this.defaultSpineQuat) this.spine.quaternion.copy(this.defaultSpineQuat);
        if (this.spine1 && this.defaultSpine1Quat) this.spine1.quaternion.copy(this.defaultSpine1Quat);
        if (this.neck && this.defaultNeckQuat) this.neck.quaternion.copy(this.defaultNeckQuat);

        if (this.hasTarget) {
            const t = Math.min(1, delta * 12);
            this.group.position.lerp(this.targetPos, t);
            this.group.quaternion.slerp(this.targetQuat, t);
        }
        if (this.mixer) this.mixer.update(delta);

        let animName = this.actions[this.stateName] ? this.stateName : 'idle';
        if (this.carryUpper && this.actions[animName + '_lower']) animName += '_lower';
        this.fadeToAction(animName, 0.2);

        if (this.carryUpper) this.fadeToUpperAction('carry_upper', 0.2);
        else this.stopUpperAction(0.2);

        this.updatePunchEffects(delta);
        this.updateCarryStabilize(delta);
        this.updateHeldMesh();

        this.updateRecoil(delta);
        this.applyRecoilVisual();
    }

    // Mirrors Character's recoil-offset block in the HTML file: captures the
    // current (post carry-stabilize) pose as this frame's "default", then
    // multiplies a decaying rotational offset (from RagdollPhysics.updateRecoil)
    // on top, purely visual - no bone stays permanently rotated.
    applyRecoilVisual() {
        if (!this.spine) return;

        if (!this.defaultSpineQuat) this.defaultSpineQuat = new THREE.Quaternion();
        this.defaultSpineQuat.copy(this.spine.quaternion);
        if (this.spine1) {
            if (!this.defaultSpine1Quat) this.defaultSpine1Quat = new THREE.Quaternion();
            this.defaultSpine1Quat.copy(this.spine1.quaternion);
        }
        if (this.neck) {
            if (!this.defaultNeckQuat) this.defaultNeckQuat = new THREE.Quaternion();
            this.defaultNeckQuat.copy(this.neck.quaternion);
        }

        _recoilEuler.set(this.recoilRotation.x, this.recoilRotation.y, this.recoilRotation.z);
        _recoilQOffset.setFromEuler(_recoilEuler);

        _recoilScratchQuat.slerpQuaternions(_recoilIdentity, _recoilQOffset, 0.3);
        this.spine.quaternion.multiply(_recoilScratchQuat);
        this.spine.updateMatrixWorld(true);

        if (this.spine1) {
            _recoilScratchQuat.slerpQuaternions(_recoilIdentity, _recoilQOffset, 0.5);
            this.spine1.quaternion.multiply(_recoilScratchQuat);
            this.spine1.updateMatrixWorld(true);
        }
        if (this.neck) {
            _recoilScratchQuat.slerpQuaternions(_recoilIdentity, _recoilQOffset, 0.2);
            this.neck.quaternion.multiply(_recoilScratchQuat);
            this.neck.updateMatrixWorld(true);
        }
    }

    _ragdollFloorY() {
        const hipsP = this.getParticle('hips');
        _ragdollRayOrigin.copy(hipsP ? hipsP.pos : this.group.position);
        _ragdollRayOrigin.y += 0.5;
        _ragdollRaycaster.set(_ragdollRayOrigin, _ragdollDownVec);
        const hits = _ragdollRaycaster.intersectObjects(window.collidables || []);
        return hits.length > 0 ? hits[0].point.y : 0;
    }

    // Positions the held carryable from this avatar's own hand bones every
    // frame (60fps, driven by the already-smoothed group transform + mixer)
    // instead of snapping it to raw 10Hz network samples, which ticked/stuttered.
    updateHeldMesh() {
        if (!this.heldMesh) return;

        if (this.leftHandBone && this.rightHandBone) {
            this.leftHandBone.getWorldPosition(this._leftHandPos);
            this.rightHandBone.getWorldPosition(this._rightHandPos);
            this._handMid.addVectors(this._leftHandPos, this._rightHandPos).multiplyScalar(0.5);
            this._handMid.y += 0.5;
        } else {
            const fwd = this._leftHandPos.set(0, 0, 1).applyQuaternion(this.group.quaternion);
            this._handMid.copy(this.group.position).addScaledVector(fwd, 0.15);
            this._handMid.y += 2.95;
        }

        this.heldMesh.position.copy(this._handMid);
        this.heldMesh.quaternion.copy(this.group.quaternion);
    }

    // Mirrors Character's carry-stabilize pass in the HTML file: without it the
    // spine/neck just play the raw carry_upper clip and visibly sway whenever
    // the body turns, since nothing holds their world-space orientation steady.
    updateCarryStabilize(delta) {
        if (!this.spine) return;

        if (!this.carryUpper) {
            this.stabilizeWeight = 0.0;
            this.lastSpineWorld = null;
            this.lastSpine1World = null;
            this.lastNeckWorld = null;
            this.lastGroupQuat = null;
            return;
        }

        const spineBlend = (typeof window.spineBlendValue === 'number') ? window.spineBlendValue : 1.0;

        // lastSpineWorld etc. is a low-pass filter on the bone's world
        // orientation: every frame it blends toward "current" by (1-damp) and
        // keeps (damp) of its old self. If the cache is allowed to update
        // while recoil has *any* meaningful leftover bend, it permanently
        // absorbs a sliver of that bend into its "resting" reference - and
        // once damping strengthens back up, it actively holds the pose at
        // that tainted reference instead of the clean animated one, so it
        // never fully lets go (and each subsequent hit adds another sliver on
        // top). A softer threshold or a continuous falloff both still sample
        // "current" while recoil is non-trivial, so they still taint the
        // cache, just more gradually. Only treating recoil as "gone" once
        // it's near-zero, and keeping the cache frozen (not updated at all)
        // until then, is what actually stops the drift.
        const recoilMag = this.recoilRotation.length() + this.recoilVelocity.length();
        const RECOIL_SETTLE_THRESHOLD = 0.01;
        if (recoilMag > RECOIL_SETTLE_THRESHOLD) {
            this.stabilizeWeight = 0.0;
            this.lastSpineWorld = null;
            this.lastSpine1World = null;
            this.lastNeckWorld = null;
            this.lastGroupQuat = null;
            return;
        }
        this.stabilizeWeight = THREE.MathUtils.lerp(this.stabilizeWeight, 1.0, 5.0 * delta);
        const activeDampFactor = spineBlend * 0.85 * this.stabilizeWeight;

        if (!this.lastGroupQuat) this.lastGroupQuat = this.group.quaternion.clone();
        const groupDeltaQuat = this.group.quaternion.clone().multiply(this.lastGroupQuat.clone().invert());

        const applyDamping = (bone, key) => {
            if (!bone) return;
            if (!this[key]) this[key] = bone.getWorldQuaternion(new THREE.Quaternion());
            else this[key].premultiply(groupDeltaQuat);

            bone.getWorldQuaternion(_stabQuat);
            _stabQuat.slerp(this[key], activeDampFactor);

            const parentWorld = bone.parent.getWorldQuaternion(_stabQuat2);
            bone.quaternion.copy(parentWorld.invert().multiply(_stabQuat));
            bone.updateMatrixWorld(true);

            this[key].copy(_stabQuat);
        };

        applyDamping(this.spine, 'lastSpineWorld');
        applyDamping(this.spine1, 'lastSpine1World');
        applyDamping(this.neck, 'lastNeckWorld');

        this.lastGroupQuat.copy(this.group.quaternion);
    }

    dispose() {
        this.scene.remove(this.group);
        if (this.mixer) this.mixer.stopAllAction();
        if (this.chargeEffect) this.stopChargeEffect();
    }
}

Object.assign(RemoteAvatar.prototype, RagdollPhysics);
