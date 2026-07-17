import * as THREE from 'three';

const _tempVec1 = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempQuat2 = new THREE.Quaternion();
const _tempMat4 = new THREE.Matrix4();
const _fwdVec = new THREE.Vector3(0, 0, 1);

// Scratch objects reused by applyHingeLimit / updateRagdoll so the 20-iteration
// constraint solver doesn't allocate fresh Vector3/Quaternion/Box3 every call.
const _hingeV1 = new THREE.Vector3();
const _hingeV2 = new THREE.Vector3();
const _hingeAxis = new THREE.Vector3();
const _hingeQuat = new THREE.Quaternion();
const _particleBox = new THREE.Box3();
const _obstacleBox = new THREE.Box3();
const _prevPos = new THREE.Vector3();
const _boxSize = new THREE.Vector3();

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

        let velocityModifier = 1.0;
        if (intensity === 'low') {
            this.ragdollMaxTime = 0.02; 
            velocityModifier = 0.05; 
        } else if (intensity === 'medium') {
            this.ragdollMaxTime = 0.4; 
            velocityModifier = 0.25;
        } else if (intensity === 'medium_high') {
            this.ragdollMaxTime = 0.8;
            velocityModifier = 0.4;
        } else {
            this.ragdollMaxTime = 1.6; 
            velocityModifier = 0.55;
        }

        const modifiedVelocity = initialVelocity.clone().multiplyScalar(velocityModifier);
        modifiedVelocity.clampLength(0.0, 15.0);

        this.ragdollParticles.forEach((p) => {
            if (p.bone) {
                p.bone.getWorldPosition(p.pos);
                const nX = (Math.random() - 0.5) * 2.0 * velocityModifier;
                const nY = (Math.random() - 0.5) * 2.0 * velocityModifier;
                const nZ = (Math.random() - 0.5) * 2.0 * velocityModifier;
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

        this.ragdollLinks = [
            { p1: 'hips', p2: 'spine', bone: getBone('hips') }, { p1: 'spine', p2: 'head', bone: getBone('spine') },
            { p1: 'lShoulder', p2: 'lElbow', bone: getBone('lShoulder') }, { p1: 'lElbow', p2: 'lHand', bone: getBone('lHand') },
            { p1: 'rShoulder', p2: 'rElbow', bone: getBone('rShoulder') }, { p1: 'rElbow', p2: 'rHand', bone: getBone('rHand') },
            { p1: 'lThigh', p2: 'lKnee', bone: getBone('lThigh') }, { p1: 'lKnee', p2: 'lFoot', bone: getBone('lFoot') },
            { p1: 'rThigh', p2: 'rKnee', bone: getBone('rThigh') }, { p1: 'rKnee', p2: 'rFoot', bone: getBone('rFoot') }
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
            }
        }
    },

    updateRecoil(delta) {
        this.recoilVelocity.lerp(new THREE.Vector3(), 15 * delta);
        this.recoilRotation.lerp(new THREE.Vector3(), 10 * delta);
        this.recoilRotation.add(this.recoilVelocity.clone().multiplyScalar(delta));
        // Same spring-damper shape as recoilVelocity/recoilRotation above,
        // just scalar - drives the whole-character impact twist (see
        // applyProceduralRecoil and setSlopeTilt's hitTwistAngle param).
        this.hitTwistVelocity = THREE.MathUtils.lerp(this.hitTwistVelocity, 0, 15 * delta);
        this.hitTwistAngle = THREE.MathUtils.lerp(this.hitTwistAngle, 0, 10 * delta);
        this.hitTwistAngle += this.hitTwistVelocity * delta;
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

        for (let iter = 0; iter < 20; iter++) {
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
                    if (p.pos.y < p.radius) {
                        p.pos.y = p.radius;
                        // Absorb the vertical velocity on landing instead of just
                        // repositioning: oldPos.y still reflected the pre-landing
                        // (falling) height, so next frame's implicit velocity
                        // would still read as "falling", clamp again, forever -
                        // a non-decaying jitter now that Y motion isn't damped.
                        p.oldPos.y = p.pos.y;
                        p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                        p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                    }

                    const particleBox = _particleBox;
                    _boxSize.set(p.radius * 2, p.radius * 2, p.radius * 2);
                    particleBox.setFromCenterAndSize(p.pos, _boxSize);
                    const obstacleBox = _obstacleBox;

                    collidables.forEach(obj => {
                        if (obj === window.ground) return;

                        if (obj.geometry && (obj.geometry.type === 'SphereGeometry' || obj.geometry.constructor.name === 'SphereGeometry')) {
                            const radius = obj.geometry.parameters.radius || 6;
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
                            return;
                        }

                        if (window.getObstacleBox) window.getObstacleBox(obj, obstacleBox);

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
                    });
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