import * as THREE from 'three';

export class AnimationManager {
    constructor(core) {
        this.core = core;
        this.mixer = null;
        this.baseActions = [];
        this.layers = []; 
        this.currentTime = 0;
        this.duration = 10;
        this.isPlaying = false;
        this.loopStart = 0;
        this.loopEnd = 10;
        this.baseStates = new Map();
        this.bonesByName = new Map();
    }

    init(root) {
        this.mixer = new THREE.AnimationMixer(root);
    }

    cacheBaseStates() {
        this.baseStates.clear();
        this.bonesByName.clear();
        if (!this.core.editorRoot) return;
        this.core.editorRoot.traverse(bone => {
            if (bone.name) {
                this.bonesByName.set(bone.name, bone);
                this.baseStates.set(bone.name, {
                    pos: bone.position.clone(),
                    quat: bone.quaternion.clone(),
                    scale: bone.scale.clone()
                });
            }
        });
    }

    update(delta) {
        if (this.isPlaying) {
            this.currentTime += delta;
            if (this.currentTime > this.loopEnd) this.currentTime = this.loopStart;
        }
        if (this.mixer) this.mixer.setTime(this.currentTime);
        this.applyLayers();
    }

    applyLayers() {
        if (!this.core.editorRoot || this.layers.length === 0) return;

        const animatedBones = new Set();
        this.layers.forEach(l => {
            if(!l.visible || l.weight === 0) return;
            l.tracks.forEach(t => animatedBones.add(t.boneName));
        });

        animatedBones.forEach(boneName => {
            const bone = this.bonesByName.get(boneName);
            const base = this.baseStates.get(boneName);
            if (bone && base) {
                bone.position.copy(base.pos);
                bone.quaternion.copy(base.quat);
                bone.scale.copy(base.scale);
            }
        });

        this.layers.forEach(layer => {
            if (!layer.visible || layer.weight === 0) return;

            layer.tracks.forEach(track => {
                const bone = this.bonesByName.get(track.boneName);
                const base = this.baseStates.get(track.boneName);
                if (!bone || !base) return;

                const times = track.times;
                const values = track.values;
                if (times.length === 0) return;

                let t0Idx = 0, t1Idx = 0;
                for (let i = 0; i < times.length; i++) {
                    if (times[i] <= this.currentTime) t0Idx = i;
                    if (times[i] >= this.currentTime && t1Idx === 0 && i > 0) t1Idx = i;
                }
                if (t1Idx === 0) t1Idx = times.length - 1;

                const t0 = times[t0Idx], t1 = times[t1Idx];
                let ratio = (t0 === t1) ? 0 : (this.currentTime - t0) / (t1 - t0);
                ratio = Math.max(0, Math.min(1, ratio));

                if (track.type === 'position' || track.type === 'scale') {
                    const v0 = new THREE.Vector3().fromArray(values, t0Idx * 3);
                    const v1 = new THREE.Vector3().fromArray(values, t1Idx * 3);
                    const lerpVal = v0.lerp(v1, ratio);
                    
                    if (layer.blendMode === 'override') {
                        const target = base[track.type === 'position' ? 'pos' : 'scale'].clone().lerp(lerpVal, layer.weight);
                        bone[track.type].copy(target);
                    } else if (layer.blendMode === 'additive') {
                        const additiveVal = lerpVal.clone().multiplyScalar(layer.weight);
                        if (track.type === 'position') bone.position.add(additiveVal);
                        else bone.scale.add(additiveVal); 
                    }
                } else if (track.type === 'quaternion') {
                    const q0 = new THREE.Quaternion().fromArray(values, t0Idx * 4);
                    const q1 = new THREE.Quaternion().fromArray(values, t1Idx * 4);
                    const lerpVal = q0.slerp(q1, ratio);
                    
                    if (layer.blendMode === 'override') {
                        const target = base.quat.clone().slerp(lerpVal, layer.weight);
                        bone.quaternion.copy(target);
                    } else if (layer.blendMode === 'additive') {
                        const tempQuat = new THREE.Quaternion().identity().slerp(lerpVal, layer.weight);
                        bone.quaternion.multiply(tempQuat);
                    }
                }
            });
        });
    }

    play() { this.isPlaying = true; }
    pause() { this.isPlaying = false; }
    stop() { this.isPlaying = false; this.currentTime = 0; }
    setTime(time) { this.currentTime = time; }
}