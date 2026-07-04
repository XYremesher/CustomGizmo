import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export class Sandbag {
    constructor(scene, position, collidables, debugHelpers, threeTone) {
        this.group = new THREE.Group();
        this.group.position.copy(position);
        scene.add(this.group);
        
        this.bones = [];
        this.recoilPosition = new THREE.Vector2();
        this.recoilVelocity = new THREE.Vector2();
        this.meshes = [];
        this.flashTimer = 0;
        this.whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

        const loader = new FBXLoader();
        loader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Combat/SandSack.fbx', (fbx) => {
            fbx.scale.setScalar(0.0065);
            this.group.add(fbx);
            
            fbx.traverse(c => {
                if (c.isMesh) {
                    const origMat = new THREE.MeshToonMaterial({ color: 0xd5c4a1, gradientMap: threeTone });
                    c.material = origMat;
                    c.castShadow = true;
                    c.receiveShadow = true;
                    this.meshes.push({ mesh: c, originalMaterial: origMat });
                }
                if (c.isBone && c.name.toLowerCase().includes('spine')) {
                    this.bones.push({ bone: c, defaultQuat: c.quaternion.clone() });
                }
            });
        });

        this.colliderMesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), new THREE.MeshBasicMaterial({visible: false}));
        this.colliderMesh.position.copy(position).setY(position.y + 1.2);
        this.colliderMesh.geometry.computeBoundingBox();
        this.colliderMesh.userData.isMovable = false;
        this.colliderMesh.userData.isObstacle = true;
        this.colliderMesh.userData.isWall = true;
        scene.add(this.colliderMesh);
        
        if (!window.collidables) window.collidables = [];
        if (!window.collidables.includes(this.colliderMesh)) {
            window.collidables.push(this.colliderMesh);
        }
    }

    checkHit(hitCenter, hitRadius) {
        return this.colliderMesh.position.distanceTo(hitCenter) < (0.5 + hitRadius);
    }

    applyHit(direction, magnitude) {
        let localDir = direction.clone().applyQuaternion(this.group.quaternion.clone().invert()).normalize();
        this.recoilVelocity.x += localDir.x * magnitude * 0.3;
        this.recoilVelocity.y += localDir.z * magnitude * 0.3;
        this.flashTimer = 0.15;
    }

    update(delta) {
        this.recoilVelocity.x -= this.recoilPosition.x * 250 * delta;
        this.recoilVelocity.y -= this.recoilPosition.y * 250 * delta;
        
        let damping = Math.pow(0.02, delta);
        this.recoilVelocity.x *= damping;
        this.recoilVelocity.y *= damping;
        
        this.recoilPosition.x += this.recoilVelocity.x * delta;
        this.recoilPosition.y += this.recoilVelocity.y * delta;

        let displacementLen = Math.sqrt(this.recoilPosition.x * this.recoilPosition.x + this.recoilPosition.y * this.recoilPosition.y);
        
        if (displacementLen > 0.001) {
            const _tempVec1 = new THREE.Vector3(this.recoilPosition.y, 0, -this.recoilPosition.x).normalize();
            let angle = Math.min(displacementLen * 0.4, 1.2); 
            _tempVec1.applyQuaternion(this.group.quaternion);
            
            this.bones.forEach(bData => {
                const _tempQuat = new THREE.Quaternion();
                bData.bone.parent.getWorldQuaternion(_tempQuat);
                const _tempVec2 = _tempVec1.clone().applyQuaternion(_tempQuat.invert());
                const _tempQuat2 = new THREE.Quaternion().setFromAxisAngle(_tempVec2, angle);
                
                bData.bone.quaternion.copy(_tempQuat2).multiply(bData.defaultQuat);
                bData.bone.updateMatrixWorld(true);
            });
        } else {
            this.bones.forEach(bData => {
                bData.bone.quaternion.copy(bData.defaultQuat);
                bData.bone.updateMatrixWorld(true);
            });
        }

        if (this.flashTimer > 0) {
            this.flashTimer -= delta;
            this.meshes.forEach(mObj => { mObj.mesh.material = this.whiteMat; });
        } else {
            this.meshes.forEach(mObj => { mObj.mesh.material = mObj.originalMaterial; });
        }
    }
}