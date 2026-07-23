import * as THREE from 'three';

// Extracted out of Character (ClimbGame.html) so RemoteAvatar can mix in the
// exact same analytic 2-bone leg solve instead of a separately-maintained
// copy - same pattern as RagdollPhysics (ragdoll_physics.js), which both
// classes already share this way.

const _ikVec1 = new THREE.Vector3();
const _ikVec2 = new THREE.Vector3();
const _ikVec3 = new THREE.Vector3();
const _ikVec4 = new THREE.Vector3();
const _ikVec5 = new THREE.Vector3();
const _ikVec6 = new THREE.Vector3();
const _ikVec7 = new THREE.Vector3();
const _ikVec8 = new THREE.Vector3();
const _ikQuat1 = new THREE.Quaternion();
const _ikQuat2 = new THREE.Quaternion();
const _ikQuat3 = new THREE.Quaternion();
const _ikQuat4 = new THREE.Quaternion();
const _ikParentWorldQuat = new THREE.Quaternion();
const _ikBoneWorldQuat = new THREE.Quaternion();
const _ikNewWorldQuat = new THREE.Quaternion();
const _legPoleWorldDir = new THREE.Vector3();
const _armPoleScratch = new THREE.Vector3();
const _armRightScratch = new THREE.Vector3();

export const LegIK = {
    // Rotates `bone` so its WORLD orientation becomes
    // deltaWorldQuat * (bone's current world orientation), leaving its
    // parent untouched - i.e. applies a rotation expressed in world space
    // without needing to know the bone's own bind-pose local axis at all
    // (which varies by rig/exporter and isn't something this codebase has
    // any other way to know). Works out the equivalent LOCAL quaternion via
    // parentWorldQuat^-1 * (deltaWorldQuat * boneWorldQuat), since THREE
    // composes worldQuat = parentWorldQuat * localQuat.
    applyWorldDeltaRotation(bone, deltaWorldQuat, weight = 1.0) {
        bone.parent.getWorldQuaternion(_ikParentWorldQuat);
        bone.getWorldQuaternion(_ikBoneWorldQuat);
        _ikNewWorldQuat.copy(deltaWorldQuat).multiply(_ikBoneWorldQuat);
        // weight < 1 pulls the fully-corrected world orientation back
        // toward the bone's pre-IK (animated) one - _ikBoneWorldQuat still
        // holds that original value here, untouched since the read above.
        // Lets the caller blend between "trust the animation" and "trust
        // the IK solve" instead of always snapping straight to the exact
        // target.
        if (weight < 1.0) _ikNewWorldQuat.slerp(_ikBoneWorldQuat, 1.0 - weight);
        bone.quaternion.copy(_ikParentWorldQuat.invert().multiply(_ikNewWorldQuat));
    },

    // Analytic 2-bone IK (law of cosines, same technique as a game engine's
    // "two bone IK" node) - bends thighBone/kneeBone so footBone reaches
    // targetWorldPos, or as close to it as the leg's own fixed length
    // allows. Works from CURRENT (already animation-posed) bone directions
    // and applies a world-space delta rather than computing an absolute
    // target rotation, so it doesn't need to know either bone's bind-pose
    // axis (see applyWorldDeltaRotation) - it only needs to know how far to
    // rotate from wherever the animation already left it.
    solveLegIK(thighBone, kneeBone, footBone, upperLen, lowerLen, targetWorldPos, weight = 1.0) {
        if (!thighBone || !kneeBone || !footBone || upperLen <= 0 || lowerLen <= 0) return;

        const hipPos = _ikVec1; thighBone.getWorldPosition(hipPos);
        const kneePos = _ikVec2; kneeBone.getWorldPosition(kneePos);
        const curHipToKnee = _ikVec4.copy(kneePos).sub(hipPos).normalize();

        const toTarget = _ikVec5.copy(targetWorldPos).sub(hipPos);
        const rawDist = toTarget.length();
        if (rawDist < 0.0001) return;
        const maxReach = upperLen + lowerLen - 0.001;
        const minReach = Math.max(0.001, Math.abs(upperLen - lowerLen) + 0.001);
        const dist = THREE.MathUtils.clamp(rawDist, minReach, maxReach);
        const targetDir = toTarget.normalize();

        const cosHip = THREE.MathUtils.clamp((upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2 * upperLen * dist), -1, 1);
        const hipAngle = Math.acos(cosHip);
        const cosKnee = THREE.MathUtils.clamp((upperLen * upperLen + lowerLen * lowerLen - dist * dist) / (2 * upperLen * lowerLen), -1, 1);
        const kneeInteriorAngle = Math.acos(cosKnee);

        // Bend plane: the character's own forward direction, flattened to
        // be perpendicular to targetDir, so the knee bends forward rather
        // than sideways or backward - falls back to world up if forward
        // happens to be parallel to targetDir (looking straight down/up, an
        // edge case that shouldn't come up for a standing character).
        const poleDir = _ikVec6.copy(_legPoleWorldDir);
        poleDir.addScaledVector(targetDir, -poleDir.dot(targetDir));
        if (poleDir.lengthSq() < 1e-6) poleDir.set(0, 1, 0).addScaledVector(targetDir, -targetDir.y);
        poleDir.normalize();

        // Order matters here (cross(targetDir, poleDir), not the other way
        // around) - it's what makes rotating targetDir by +hipAngle below
        // actually bend the knee TOWARD poleDir (forward) instead of away
        // from it. Verified by hand with a concrete example (hip at origin,
        // target straight down, pole straight forward): the wrong order
        // rotates desiredHipToKnee backward instead of forward.
        const bendAxis = _ikVec7.crossVectors(targetDir, poleDir).normalize();
        if (bendAxis.lengthSq() < 1e-6) return;

        _ikQuat1.setFromAxisAngle(bendAxis, hipAngle);
        const desiredHipToKnee = _ikVec8.copy(targetDir).applyQuaternion(_ikQuat1).normalize();

        _ikQuat2.setFromUnitVectors(curHipToKnee, desiredHipToKnee);
        this.applyWorldDeltaRotation(thighBone, _ikQuat2, weight);

        // The thigh rotation just moved the knee (and everything below it)
        // - re-read its new position/world matrix before working out the
        // lower leg's own rotation.
        thighBone.updateMatrixWorld(true);
        const kneePos2 = _ikVec2; kneeBone.getWorldPosition(kneePos2);
        const footPos2 = _ikVec3; footBone.getWorldPosition(footPos2);
        const curKneeToFoot = _ikVec4.copy(footPos2).sub(kneePos2).normalize();

        // Negative here (folding back), not positive (continuing to swing
        // the same way) - the hip rotation above bends the thigh
        // forward/out from the straight-line direction, and the shin has to
        // bend back the OTHER way around the same axis to actually bring
        // the foot back to the target instead of swinging it further away.
        // Also verified by hand with the same concrete example: the
        // positive-angle version lands the foot nowhere near the target,
        // the negative one lands exactly on it.
        _ikQuat3.setFromAxisAngle(bendAxis, -(Math.PI - kneeInteriorAngle));
        const desiredKneeToFoot = _ikVec5.copy(desiredHipToKnee).applyQuaternion(_ikQuat3).normalize();

        _ikQuat4.setFromUnitVectors(curKneeToFoot, desiredKneeToFoot);
        this.applyWorldDeltaRotation(kneeBone, _ikQuat4, weight);
        kneeBone.updateMatrixWorld(true);
    },

    // leftTarget/rightTarget: world-space ground point under each foot, or
    // null if no valid ground was found under that foot this frame (leaves
    // that leg's animated pose untouched rather than guessing). weight
    // (0-1, default full): how much of the solve actually gets applied vs
    // leaving the animated pose alone.
    applyLegIK(leftTarget, rightTarget, weight = 1.0) {
        if (!this.fbxModel) return;
        _legPoleWorldDir.set(0, 0, 1).applyQuaternion(this.group.quaternion);
        if (leftTarget) this.solveLegIK(this.lThighBone, this.lKneeBone, this.lFootBone, this.lUpperLegLen, this.lLowerLegLen, leftTarget, weight);
        if (rightTarget) this.solveLegIK(this.rThighBone, this.rKneeBone, this.rFootBone, this.rUpperLegLen, this.rLowerLegLen, rightTarget, weight);
    },

    // Same solve, same shared pole-direction scratch as applyLegIK above -
    // reusing it here is safe since the two are never called in the same
    // frame (leg IK is explicitly gated off while ledge-hanging, arm IK is
    // only used during it - see game_js.js's own call sites). leftTarget/
    // rightTarget: world-space point on the actual grabbed surface for
    // each hand, or null to leave that arm's animated hang pose untouched
    // for the frame (e.g. no valid surface found directly above/below that
    // specific hand's current position).
    applyArmIK(leftTarget, rightTarget, weight = 1.0) {
        if (!this.fbxModel) return;
        // Pole direction = where the ELBOW should bulge. Legs reuse a plain
        // "forward" pole (knees bend forward), but an arm reaching UP to a
        // ledge that way bends the elbow forward INTO the wall, which reads
        // as the whole arm twisting/warping ("çarp"). A hanging arm's elbow
        // instead points down-and-outward (left arm out to the left, right
        // arm out to the right) - built per-arm below from the character's
        // own world right axis plus a downward component. Down is kept the
        // smaller term so there's always a solid outward component left
        // after solveLegIK flattens the pole perpendicular to the (mostly
        // vertical) shoulder->hand direction, avoiding the degenerate
        // near-antiparallel case.
        _armRightScratch.set(1, 0, 0).applyQuaternion(this.group.quaternion);
        if (leftTarget) {
            _legPoleWorldDir.copy(_armRightScratch).multiplyScalar(-1.0).add(_armPoleScratch.set(0, -0.6, 0)).normalize();
            this.solveLegIK(this.lShoulderBone, this.lElbowBone, this.leftHandBone, this.lUpperArmLen, this.lLowerArmLen, leftTarget, weight);
        }
        if (rightTarget) {
            _legPoleWorldDir.copy(_armRightScratch).add(_armPoleScratch.set(0, -0.6, 0)).normalize();
            this.solveLegIK(this.rShoulderBone, this.rElbowBone, this.rightHandBone, this.rUpperArmLen, this.rLowerArmLen, rightTarget, weight);
        }
    },

    // Lighter alternative to applyArmIK: instead of a full 2-bone solve
    // (which needs a correct elbow pole and warps the arm if that's off),
    // just re-aim each whole arm at its grip target by rotating ONLY the
    // shoulder so the shoulder->hand line points at the target. The
    // forearm/elbow keep their animated bend relative to the upper arm, so
    // the arm keeps the hang clip's natural shape and only pivots to reach
    // - no pole vector, nothing to warp. The hand lands near (not exactly
    // on) the target, which is all the rounded/beveled-edge float actually
    // needs. weight blends the aim in from the animated pose.
    _aimArmAt(shoulderBone, handBone, targetWorldPos, weight) {
        if (!shoulderBone || !handBone) return;
        const shoulderPos = _ikVec1; shoulderBone.getWorldPosition(shoulderPos);
        const handPos = _ikVec2; handBone.getWorldPosition(handPos);
        const curDir = _ikVec3.copy(handPos).sub(shoulderPos);
        const tgtDir = _ikVec4.copy(targetWorldPos).sub(shoulderPos);
        if (curDir.lengthSq() < 1e-8 || tgtDir.lengthSq() < 1e-8) return;
        curDir.normalize(); tgtDir.normalize();
        _ikQuat1.setFromUnitVectors(curDir, tgtDir);
        this.applyWorldDeltaRotation(shoulderBone, _ikQuat1, weight);
        shoulderBone.updateMatrixWorld(true);
    },

    applyArmAim(leftTarget, rightTarget, weight = 1.0) {
        if (!this.fbxModel) return;
        if (leftTarget) this._aimArmAt(this.lShoulderBone, this.leftHandBone, leftTarget, weight);
        if (rightTarget) this._aimArmAt(this.rShoulderBone, this.rightHandBone, rightTarget, weight);
    }
};
