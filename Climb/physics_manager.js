import * as THREE from 'three';

const _tempVec1 = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempMat4 = new THREE.Matrix4();
const _fwdVec = new THREE.Vector3(0, 0, 1);

export function initRagdoll(char, initialVelocity) {
    if (!char.fbxModel || char.isRagdoll) return;

    char.fbxModel.updateMatrixWorld(true);

    char.ragdollParticles.forEach((p) => {
        if (p.bone) {
            p.bone.getWorldPosition(p.pos);
            const nX = (Math.random() - 0.5) * 4.0;
            const nY = (Math.random() - 0.5) * 4.0;
            const nZ = (Math.random() - 0.5) * 4.0;
            _tempVec1.set(nX, nY, nZ).add(initialVelocity).multiplyScalar(0.016);
            p.oldPos.copy(p.pos).sub(_tempVec1);
        }
    });

    char.ragdollConstraints = [];
    const addDist = (id1, id2) => {
        const p1 = char.ragdollParticles.find(p => p.id === id1);
        const p2 = char.ragdollParticles.find(p => p.id === id2);
        if (p1 && p2 && p1.bone && p2.bone) char.ragdollConstraints.push({ p1, p2, dist: p1.pos.distanceTo(p2.pos) });
    };

    addDist('hips', 'spine'); addDist('spine', 'head');
    addDist('spine', 'lShoulder'); addDist('lShoulder', 'lElbow'); addDist('lElbow', 'lHand');
    addDist('spine', 'rShoulder'); addDist('rShoulder', 'rElbow'); addDist('rElbow', 'rHand');
    addDist('hips', 'lThigh'); addDist('lThigh', 'lKnee'); addDist('lKnee', 'lFoot');
    addDist('hips', 'rThigh'); addDist('rThigh', 'rKnee'); addDist('rKnee', 'rFoot');
    addDist('lShoulder', 'rShoulder'); addDist('lThigh', 'rThigh');
    addDist('lShoulder', 'hips'); addDist('rShoulder', 'hips');
    addDist('head', 'hips');

    const getBone = (id) => char.ragdollParticles.find(p => p.id === id)?.bone;

    char.ragdollLinks = [
        { p1: 'hips', p2: 'spine', bone: getBone('hips') }, { p1: 'spine', p2: 'head', bone: getBone('spine') },
        { p1: 'lShoulder', p2: 'lElbow', bone: getBone('lShoulder') }, { p1: 'lElbow', p2: 'lHand', bone: getBone('lElbow') },
        { p1: 'rShoulder', p2: 'rElbow', bone: getBone('rShoulder') }, { p1: 'rElbow', p2: 'rHand', bone: getBone('rElbow') },
        { p1: 'lThigh', p2: 'lKnee', bone: getBone('lThigh') }, { p1: 'lKnee', p2: 'lFoot', bone: getBone('lKnee') },
        { p1: 'rThigh', p2: 'rKnee', bone: getBone('rThigh') }, { p1: 'rKnee', p2: 'rFoot', bone: getBone('rKnee') }
    ];

    char.ragdollLinks.forEach(link => {
        if (link.bone) {
            const p1 = char.ragdollParticles.find(p => p.id === link.p1);
            const p2 = char.ragdollParticles.find(p => p.id === link.p2);
            if (p1 && p2) {
                link.initialDir = p2.pos.clone().sub(p1.pos).normalize();
                link.initialQuat = link.bone.getWorldQuaternion(new THREE.Quaternion());
            } else link.bone = null;
        }
    });

    if (char.activeAction) char.activeAction.stop();
    if (char.activeUpperAction) char.activeUpperAction.stop();
    char.activeUpperAction = null;

    char.isRagdoll = true; 
    char.isStandingUp = false; 
    char.standUpFinished = false; 
    char.ragdollTimer = 0;
}

export function updateRagdoll(char, delta, collidables, floorY, cubeSize) {
    if (!char.isRagdoll) return;
    char.ragdollTimer += delta;
    const gravity = 30; const damping = 0.98;

    char.ragdollParticles.forEach(p => {
        const tempX = p.pos.x, tempY = p.pos.y, tempZ = p.pos.z;
        p.pos.x += (p.pos.x - p.oldPos.x) * damping;
        p.pos.y += (p.pos.y - p.oldPos.y) * damping - gravity * delta * delta;
        p.pos.z += (p.pos.z - p.oldPos.z) * damping;
        p.oldPos.set(tempX, tempY, tempZ);
    });

    for (let iter = 0; iter < 20; iter++) {
        char.ragdollConstraints.forEach(c => {
            _tempVec1.subVectors(c.p2.pos, c.p1.pos);
            const dist = _tempVec1.length();
            if (dist > 0.0001) {
                const offset = _tempVec1.multiplyScalar(((dist - c.dist) / dist) * 0.5);
                c.p1.pos.add(offset);
                c.p2.pos.sub(offset);
            }
        });

        char.ragdollParticles.forEach(p => {
            if (p.pos.y < p.radius) {
                p.pos.y = p.radius;
                p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
            }
            collidables.forEach(obj => {
                if (obj.geometry && obj.geometry.type === 'RoundedBoxGeometry') {
                    const half = cubeSize / 2 + p.radius;
                    const dx = p.pos.x - obj.position.x;
                    const dy = p.pos.y - obj.position.y;
                    const dz = p.pos.z - obj.position.z;

                    if (Math.abs(dx) < half && Math.abs(dy) < half && Math.abs(dz) < half) {
                        const ox = half - Math.abs(dx);
                        const oy = half - Math.abs(dy);
                        const oz = half - Math.abs(dz);

                        if (ox < oy && ox < oz) p.pos.x += Math.sign(dx) * ox;
                        else if (oy < ox && oy < oz) {
                            p.pos.y += Math.sign(dy) * oy;
                            if (Math.sign(dy) > 0) {
                                p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                                p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                            }
                        } else p.pos.z += Math.sign(dz) * oz;
                    }
                }
                if (obj.geometry && obj.geometry.type === 'SphereGeometry') {
                    _tempVec1.subVectors(p.pos, obj.position);
                    if (_tempVec1.y >= -p.radius) {
                        const dist = _tempVec1.length();
                        const minDist = 6.0 + p.radius;
                        if (dist < minDist) {
                            _tempVec1.normalize();
                            p.pos.copy(obj.position).addScaledVector(_tempVec1, minDist);
                            p.pos.x += (p.oldPos.x - p.pos.x) * 0.2;
                            p.pos.z += (p.oldPos.z - p.pos.z) * 0.2;
                        }
                    }
                }
            });
        });
    }

    const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
    if (hipsP && char.hips) {
        char.hips.position.copy(char.hips.parent.worldToLocal(_tempVec1.copy(hipsP.pos)));
        char.hips.updateMatrixWorld(true);
    }
    
    char.ragdollLinks.forEach(link => {
        if (link.bone) {
            const p1 = char.ragdollParticles.find(p => p.id === link.p1);
            const p2 = char.ragdollParticles.find(p => p.id === link.p2);
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
}

export function detectFallDirection(char) {
    const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
    const spineP = char.ragdollParticles.find(p => p.id === 'spine');
    const headP = char.ragdollParticles.find(p => p.id === 'head');
    if (!hipsP || !spineP) return 'front';

    _tempVec1.set(0, 0, 1).applyQuaternion(char.group.quaternion);
    _tempVec1.y = 0; _tempVec1.normalize();

    _tempVec2.subVectors(spineP.pos, hipsP.pos);
    _tempVec2.y = 0; _tempVec2.normalize();

    if (headP) {
        _tempVec3.subVectors(headP.pos, hipsP.pos);
        _tempVec3.y = 0; _tempVec3.normalize();
    } else _tempVec3.copy(_tempVec2);

    return _tempVec1.dot(_tempVec3) > 0 ? 'front' : 'back';
}

export function captureRagdollPose(char) {
    const tracks = [];
    const dur = char.ragdollPoseDuration;
    char.fbxModel.traverse(child => {
        if (child.isBone) {
            const q = child.quaternion;
            tracks.push(new THREE.QuaternionKeyframeTrack(child.name + '.quaternion', [0, dur], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]));
            if (child === char.hips || child === char.rootBone) {
                const p = child.position;
                tracks.push(new THREE.VectorKeyframeTrack(child.name + '.position', [0, dur], [p.x, p.y, p.z, p.x, p.y, p.z]));
            }
        }
    });
    const clip = new THREE.AnimationClip('ragdoll_pose', dur, tracks);
    const action = char.mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true;
    return action;
}

export function beginStandUp(char, floorY) {
    if (!char.isRagdoll) return;

    const direction = detectFallDirection(char);
    char.standUpDirection = direction;

    const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
    const spineP = char.ragdollParticles.find(p => p.id === 'spine');
    
    const globalTransforms = new Map();
    char.fbxModel.traverse(c => {
        if (c.isBone) {
            globalTransforms.set(c, {
                pos: c.getWorldPosition(new THREE.Vector3()),
                quat: c.getWorldQuaternion(new THREE.Quaternion()),
                scl: c.getWorldScale(new THREE.Vector3())
            });
        }
    });

    const hipsWorldPos = hipsP ? hipsP.pos.clone() : char.group.position.clone();
    char.group.position.set(hipsWorldPos.x, floorY, hipsWorldPos.z);

    if (hipsP && spineP) {
        _tempVec1.subVectors(spineP.pos, hipsP.pos);
        _tempVec1.y = 0;
        if (_tempVec1.lengthSq() > 0.001) {
            _tempVec1.normalize();
            if (direction === 'back') _tempVec1.negate();
            char.group.quaternion.setFromUnitVectors(_fwdVec, _tempVec1);
        }
    }
    char.group.updateMatrixWorld(true);

    char.fbxModel.traverse(c => {
        if (c.isBone) {
            const gt = globalTransforms.get(c);
            _tempMat4.copy(c.parent.matrixWorld).invert();
            const worldMat = new THREE.Matrix4().compose(gt.pos, gt.quat, gt.scl);
            const localMat = new THREE.Matrix4().multiplyMatrices(_tempMat4, worldMat);
            localMat.decompose(c.position, c.quaternion, new THREE.Vector3());
            c.updateMatrixWorld(true);
        }
    });

    if (char.fbxModel) {
        char.fbxModel.position.set(0, 0, 0);
        char.standUpTransStartX = 0; char.standUpTransStartY = 0; char.standUpTransStartZ = 0;
    }

    const ragdollAction = captureRagdollPose(char);
    ragdollAction.play();

    char.isRagdoll = false; char.isStandingUp = true; char.standUpFinished = false;
    const animName = direction === 'front' ? 'standup_front' : 'standup_back';
    if (!char.actions[animName]) {
        char.isStandingUp = false; char.standUpDirection = 'none'; return;
    }

    const standUpAction = char.actions[animName];
    standUpAction.reset();
    standUpAction.setEffectiveWeight(1);
    standUpAction.setEffectiveTimeScale(char.standupSpeed);
    standUpAction.time = Math.min(char.standupStartTime, standUpAction.getClip().duration - 0.1); 
    standUpAction.play();
    standUpAction.crossFadeFrom(ragdollAction, char.standupCrossfade, false);
    char.activeAction = standUpAction;
}

export function updateStandUp(char, delta) {
    if (!char.isStandingUp) return false;
    if (char.standUpFinished) {
        char.isStandingUp = false; char.standUpDirection = 'none'; char.standUpFinished = false;
        return true;
    }
    return false;
}