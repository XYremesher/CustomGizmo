import * as THREE from 'three';

const _tempVec1 = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempQuat2 = new THREE.Quaternion();
const _tempMat4 = new THREE.Matrix4();
const _fwdVec = new THREE.Vector3(0, 0, 1);

export const RagdollPhysics = {
    initRagdoll(initialVelocity = new THREE.Vector3(), intensity = 'high') {
        if (!this.fbxModel || this.isRagdoll) return;

        if (window.forceDropCarriedObject) {
            window.forceDropCarriedObject(initialVelocity.clone().multiplyScalar(1.5));
            window.isCarryingObj = false; 
        }
        
        this.lastSpineWorld = null;
        this.lastSpine1World = null;
        this.lastNeckWorld = null;
        this.lastGroupQuat = null;
        this.stabilizeWeight = 1.0;

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
            const p1 = this.ragdollParticles.find(p => p.id === id1);
            const p2 = this.ragdollParticles.find(p => p.id === id2);
            if (p1 && p2 && p1.bone && p2.bone) this.ragdollConstraints.push({ p1, p2, dist: p1.pos.distanceTo(p2.pos) });
        };

        addDist('hips', 'spine'); addDist('spine', 'head');
        addDist('spine', 'lShoulder'); addDist('lShoulder', 'lElbow'); addDist('lElbow', 'lHand');
        addDist('spine', 'rShoulder'); addDist('rShoulder', 'rElbow'); addDist('rElbow', 'rHand');
        addDist('hips', 'lThigh'); addDist('lThigh', 'lKnee'); addDist('lKnee', 'lFoot');
        addDist('hips', 'rThigh'); addDist('rThigh', 'rKnee'); addDist('rKnee', 'rFoot');
        addDist('lShoulder', 'rShoulder'); addDist('lThigh', 'rThigh');

        const getBone = (id) => this.ragdollParticles.find(p => p.id === id)?.bone;

        this.ragdollLinks = [
            { p1: 'hips', p2: 'spine', bone: getBone('hips') }, { p1: 'spine', p2: 'head', bone: getBone('spine') },
            { p1: 'lShoulder', p2: 'lElbow', bone: getBone('lShoulder') }, { p1: 'lElbow', p2: 'lHand', bone: getBone('lHand') },
            { p1: 'rShoulder', p2: 'rElbow', bone: getBone('rShoulder') }, { p1: 'rElbow', p2: 'rHand', bone: getBone('rHand') },
            { p1: 'lThigh', p2: 'lKnee', bone: getBone('lThigh') }, { p1: 'lKnee', p2: 'lFoot', bone: getBone('lFoot') },
            { p1: 'rThigh', p2: 'rKnee', bone: getBone('rThigh') }, { p1: 'rKnee', p2: 'rFoot', bone: getBone('rFoot') }
        ];

        this.ragdollLinks.forEach(link => {
            if (link.bone) {
                const p1 = this.ragdollParticles.find(p => p.id === link.p1);
                const p2 = this.ragdollParticles.find(p => p.id === link.p2);
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

    applyProceduralRecoil(projectileVelocity, intensity, customOrangeRecoil = 35.0) {
        const localVelocity = projectileVelocity.clone().applyQuaternion(this.group.quaternion.clone().invert());
        const localDir = localVelocity.clone().normalize();
        
        let impulseMagnitude = 12.0;
        if (intensity === 'low') impulseMagnitude = 6.0;
        else if (intensity === 'medium') impulseMagnitude = 12.0;
        else if (intensity === 'medium_high') {
            impulseMagnitude = customOrangeRecoil;
            this.recoilVelocity.y += (Math.random() - 0.5) * 2.0 * impulseMagnitude * 1.2;
        }

        this.recoilVelocity.x += localDir.z * impulseMagnitude;
        this.recoilVelocity.z += -localDir.x * impulseMagnitude;

        this.lastSpineWorld = null;
        this.lastSpine1World = null;
        this.lastNeckWorld = null;
        this.lastGroupQuat = null;
        this.stabilizeWeight = 0.0;
    },

    updateRecoil(delta) {
        this.recoilVelocity.lerp(new THREE.Vector3(), 15 * delta);
        this.recoilRotation.lerp(new THREE.Vector3(), 10 * delta);
        this.recoilRotation.add(this.recoilVelocity.clone().multiplyScalar(delta));
    },

    detectFallDirection() {
        const hipsP = this.ragdollParticles.find(p => p.id === 'hips');
        const spineP = this.ragdollParticles.find(p => p.id === 'spine');
        const headP = this.ragdollParticles.find(p => p.id === 'head');
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

        const hipsP = this.ragdollParticles.find(p => p.id === 'hips');
        const spineP = this.ragdollParticles.find(p => p.id === 'spine');
        
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

    applyHingeLimit(id1, id2, id3, minAngle, maxAngle, isKnee = false, isElbow = false, isHip = false) {
        const p1 = this.ragdollParticles.find(p => p.id === id1);
        const p2 = this.ragdollParticles.find(p => p.id === id2);
        const p3 = this.ragdollParticles.find(p => p.id === id3);
        if (!p1 || !p2 || !p3) return;

        const v1 = new THREE.Vector3().subVectors(p1.pos, p2.pos);
        const v2 = new THREE.Vector3().subVectors(p3.pos, p2.pos);
        const d1 = v1.length();
        const d2 = v2.length();
        if (d1 < 0.001 || d2 < 0.001) return;

        v1.normalize();
        v2.normalize();

        const pHips = this.ragdollParticles.find(p => p.id === 'hips');
        const pSpine = this.ragdollParticles.find(p => p.id === 'spine');
        const pLShoulder = this.ragdollParticles.find(p => p.id === 'lShoulder');
        const pRShoulder = this.ragdollParticles.find(p => p.id === 'rShoulder');

        let torsoForward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
        if (pHips && pSpine && pLShoulder && pRShoulder) {
            const torsoUp = _tempVec1.subVectors(pSpine.pos, pHips.pos).normalize();
            const torsoRight = _tempVec2.subVectors(pRShoulder.pos, pLShoulder.pos).normalize();
            torsoForward.crossVectors(torsoRight, torsoUp).normalize();
        }

        if (isKnee) {
            const dotForward = v2.dot(torsoForward);
            if (dotForward > 0.02) {
                v2.addScaledVector(torsoForward, -dotForward - 0.05).normalize();
            }
        } else if (isElbow) {
            const dotForward = v2.dot(torsoForward);
            if (dotForward < -0.02) {
                v2.addScaledVector(torsoForward, -dotForward + 0.05).normalize();
            }
        } else if (isHip) {
            const dotForward = v2.dot(torsoForward);
            if (dotForward < -0.15) {
                v2.addScaledVector(torsoForward, -dotForward - 0.15).normalize();
            }
        }

        const dot = v1.dot(v2);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

        if (angle < minAngle || angle > maxAngle) {
            const targetAngle = Math.max(minAngle, Math.min(maxAngle, angle));
            const axis = new THREE.Vector3().crossVectors(v1, v2).normalize();
            if (axis.lengthSq() < 0.001) axis.set(0, 1, 0);
            const q = new THREE.Quaternion().setFromAxisAngle(axis, targetAngle - angle);
            v2.applyQuaternion(q).normalize().multiplyScalar(d2);
            p3.pos.copy(p2.pos).add(v2);
        }
    },

    updateRagdoll(delta, collidables, floorY) {
        if (!this.isRagdoll) return;
        this.ragdollTimer += delta;
        const gravity = 30; const damping = 0.95;

        this.ragdollParticles.forEach(p => {
            const tempX = p.pos.x, tempY = p.pos.y, tempZ = p.pos.z;
            let velX = (p.pos.x - p.oldPos.x) * damping;
            let velY = (p.pos.y - p.oldPos.y) * damping - gravity * delta * delta;
            let velZ = (p.pos.z - p.oldPos.z) * damping;

            const maxDisp = 0.3;
            const dispSq = velX*velX + velY*velY + velZ*velZ;
            if (dispSq > maxDisp * maxDisp) {
                const len = Math.sqrt(dispSq);
                velX = (velX / len) * maxDisp;
                velY = (velY / len) * maxDisp;
                velZ = (velZ / len) * maxDisp;
            }

            p.pos.x += velX;
            p.pos.y += velY;
            p.pos.z += velZ;
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

            this.applyHingeLimit('lThigh', 'lKnee', 'lFoot', 0.1, 2.3, true, false, false); 
            this.applyHingeLimit('rThigh', 'rKnee', 'rFoot', 0.1, 2.3, true, false, false); 
            this.applyHingeLimit('lShoulder', 'lElbow', 'lHand', 0.1, 2.5, false, true, false); 
            this.applyHingeLimit('rShoulder', 'rElbow', 'rHand', 0.1, 2.5, false, true, false); 
            this.applyHingeLimit('spine', 'hips', 'lThigh', 0.5, 2.0, false, false, true); 
            this.applyHingeLimit('spine', 'hips', 'rThigh', 0.5, 2.0, false, false, true); 

            this.ragdollParticles.forEach(p => {
                if (p.pos.y < p.radius) {
                    p.pos.y = p.radius;
                    p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                    p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                }
                
                const particleBox = new THREE.Box3();
                particleBox.setFromCenterAndSize(p.pos, new THREE.Vector3(p.radius * 2, p.radius * 2, p.radius * 2));
                const obstacleBox = new THREE.Box3();

                collidables.forEach(obj => {
                    if (obj === window.ground) return;

                    if (obj.geometry && (obj.geometry.type === 'SphereGeometry' || obj.geometry.constructor.name === 'SphereGeometry')) {
                        const radius = obj.geometry.parameters.radius || 6;
                        const dist = p.pos.distanceTo(obj.position);
                        const minDist = radius + p.radius;
                        if (dist < minDist) {
                            const prevPos = p.pos.clone();
                            const normal = _tempVec3.subVectors(p.pos, obj.position).normalize();
                            p.pos.copy(obj.position).addScaledVector(normal, minDist);
                            const displacement = _tempVec1.subVectors(p.pos, prevPos);
                            p.oldPos.add(displacement);
                        }
                        return;
                    }

                    if (window.getObstacleBox) window.getObstacleBox(obj, obstacleBox);
                    
                    if (particleBox.intersectsBox(obstacleBox)) {
                        const prevPos = p.pos.clone();
                        const overlapX = Math.min(particleBox.max.x - obstacleBox.min.x, obstacleBox.max.x - particleBox.min.x);
                        const overlapY = Math.min(particleBox.max.y - obstacleBox.min.y, obstacleBox.max.y - particleBox.min.y);
                        const overlapZ = Math.min(particleBox.max.z - obstacleBox.min.z, obstacleBox.max.z - particleBox.min.z);
                        
                        if (overlapX < overlapY && overlapX < overlapZ) {
                            p.pos.x += Math.sign(p.pos.x - obj.position.x) * overlapX;
                        } else if (overlapY < overlapX && overlapY < overlapZ) {
                            p.pos.y += Math.sign(p.pos.y - obj.position.y) * overlapY;
                            if (Math.sign(p.pos.y - obj.position.y) > 0) {
                                p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                                p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                            }
                        } else {
                            p.pos.z += Math.sign(p.pos.z - obj.position.z) * overlapZ;
                        }

                        const displacement = _tempVec3.subVectors(p.pos, prevPos);
                        if (displacement.lengthSq() > 0.0001) p.oldPos.add(displacement);
                        particleBox.setFromCenterAndSize(p.pos, new THREE.Vector3(p.radius * 2, p.radius * 2, p.radius * 2));
                    }
                });
            });
        }

        const hipsP = this.ragdollParticles.find(p => p.id === 'hips');
        if (hipsP && this.hips) {
            this.hips.position.copy(this.hips.parent.worldToLocal(_tempVec1.copy(hipsP.pos)));
            this.hips.updateMatrixWorld(true);
        }
        
        this.ragdollLinks.forEach(link => {
            if (link.bone) {
                const p1 = this.ragdollParticles.find(p => p.id === link.p1);
                const p2 = this.ragdollParticles.find(p => p.id === link.p2);
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