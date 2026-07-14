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
                this.flashDuration = 0.15;
                this.flashStrength = 1.0;

                const loader = new FBXLoader();
                loader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Combat/SandSack.fbx', (fbx) => {
                    fbx.scale.setScalar(0.0065);
                    this.group.add(fbx);
                    fbx.updateMatrixWorld(true);

                    // This model's own skeleton isn't centered on the FBX
                    // file's root node - some off-center pivot baked in at
                    // export - so the visible sandbag was rendering
                    // noticeably away from this.group's own origin, which
                    // is what colliderMesh/hitboxHelper below (and every
                    // hit check anywhere else in the game against this
                    // sandbag) actually use. Close enough to be easy to
                    // miss at a glance, far enough that the hitbox
                    // wireframe never looked like it belonged to the bag
                    // you were actually looking at. Anchoring on the
                    // skeleton's own "Root" bone (rather than a mesh
                    // bounding-box measurement, which turned out not to
                    // agree with where the root bone itself actually sits -
                    // a skinned mesh isn't necessarily positioned at the
                    // same point as the bone driving it) and re-centering
                    // the whole loaded FBX by the inverse of that offset,
                    // just once right after load, fixes both without
                    // needing to touch anywhere the collider itself is used.
                    let rootBone = null;
                    fbx.traverse(c => { if (!rootBone && c.isBone && c.name.toLowerCase().includes('root')) rootBone = c; });
                    if (rootBone) {
                        const boneWorldPos = rootBone.getWorldPosition(new THREE.Vector3());
                        fbx.position.sub(boneWorldPos).add(this.group.position);
                        fbx.updateMatrixWorld(true);
                    }

                    // The skinned mesh's own vertices aren't actually
                    // anchored to the Root bone above - they're offset from
                    // it by a fixed amount baked into this FBX's export
                    // (same offset regardless of where fbx.position puts
                    // the whole hierarchy, since a uniform translation
                    // can't change the *relative* placement between two
                    // nodes that both move with it). So with the skeleton
                    // now correctly centered on this.group above, the
                    // visible mesh itself still renders off to one side.
                    // Nudge just the mesh's own local transform - separate
                    // from the bones it's skinned to - by that fixed
                    // residual, so it lines up with the now-correctly-
                    // centered collider too.
                    let sandSackMesh = null;
                    fbx.traverse(c => { if (!sandSackMesh && c.isMesh) sandSackMesh = c; });
                    if (sandSackMesh) {
                        const meshWorldPos = sandSackMesh.getWorldPosition(new THREE.Vector3());
                        // Transform both the mesh's current world position
                        // and the target world position (this.group's
                        // origin) into the mesh's own parent-local space,
                        // then shift by their difference - transforming as
                        // points (not as a direction vector) so the actual
                        // magnitude of the offset is preserved.
                        const targetLocalPos = sandSackMesh.parent.worldToLocal(this.group.position.clone());
                        const meshWorldPosAsLocal = sandSackMesh.parent.worldToLocal(meshWorldPos.clone());
                        sandSackMesh.position.add(targetLocalPos).sub(meshWorldPosAsLocal);
                        sandSackMesh.updateMatrixWorld(true);
                    }

                    fbx.traverse(c => {
                        if (c.isMesh) {
                            const origMat = new THREE.MeshToonMaterial({ color: 0xd5c4a1, gradientMap: threeTone });
                            const rimUniform = { value: 0.0 };
                            origMat.onBeforeCompile = (shader) => {
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
                            c.material = origMat;
                            c.castShadow = true;
                            c.receiveShadow = true;
                            this.meshes.push({ mesh: c, originalMaterial: origMat, rimUniform });
                        }
                        if (c.isBone && c.name.toLowerCase().includes('spine')) {
                            this.bones.push({ bone: c, defaultQuat: c.quaternion.clone() });
                        }
                    });
                });

                // Kutu geometrisi ve doğru duvar/engel tanımlamaları eklendi
this.colliderMesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), new THREE.MeshBasicMaterial({visible: false}));
this.colliderMesh.position.copy(position).setY(position.y + 1.2);
this.colliderMesh.updateMatrixWorld(true);
this.colliderMesh.geometry.computeBoundingBox();
this.colliderMesh.userData.isMovable = false;
this.colliderMesh.userData.isObstacle = true;
this.colliderMesh.userData.isWall = true;
                
                scene.add(this.colliderMesh);

                if (!window.collidables) window.collidables = [];
                if (!window.collidables.includes(this.colliderMesh)) {
                    window.collidables.push(this.colliderMesh);
                }

                // colliderMesh's own material is invisible on purpose (it's
                // a physics-only box, not meant to be seen normally) - this
                // separate wireframe, toggled by the same "Show Hitboxes"
                // checkbox every other debug hitbox uses (see its initial-
                // state read here matching that same convention), is what
                // actually lets it be inspected. Kept as this.hitboxHelper
                // (toggled directly by name from game_js.js's checkbox
                // handler, the same way it already reaches into char's own
                // hitbox) instead of pushed into the passed-in debugHelpers
                // array: that array belongs to the *level* and gets wiped
                // wholesale on every buildLevel() rebuild, but the sandbag
                // itself is constructed once and survives level rebuilds -
                // anything of its own put in there would get scene.remove()'d
                // on the next rebuild and never come back.
                // Capsule instead of a box - same overall footprint as the
                // actual collision box (1.2 wide/deep, 2.4 tall: radius 0.6,
                // so the straight middle section is 2.4 - 2*0.6 = 1.2 tall),
                // just a closer visual match for this roughly cylindrical
                // sandbag than a box's flat corners were.
                this.hitboxHelper = new THREE.Mesh(
                    new THREE.CapsuleGeometry(0.6, 1.2, 4, 12),
                    new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.6 })
                );
                this.hitboxHelper.position.copy(this.colliderMesh.position);
                const toggleEl = document.getElementById('toggle-hitbox');
                this.hitboxHelper.visible = toggleEl ? toggleEl.checked : false;
                this.hitboxHelper.raycast = () => {};
                scene.add(this.hitboxHelper);
            }

            getCollider() {
                return this.colliderMesh;
            }

            // Mirrors Character.setDynamicShading in ClimbGame.html - the
            // sandbag swings/wobbles when hit, so it counts as "dynamic" for
            // the Phong/Lambert shading test.
            setDynamicShading(enabled) {
                this.meshes.forEach(mObj => {
                    const mesh = mObj.mesh;
                    if (enabled) {
                        if (!mesh.userData.phongMat) {
                            const src = mObj.originalMaterial;
                            mesh.userData.phongMat = new THREE.MeshPhongMaterial({ color: src.color.clone(), map: src.map || null, shininess: 30 });
                        }
                        mesh.material = mesh.userData.phongMat;
                    } else {
                        mesh.material = mObj.originalMaterial;
                    }
                });
            }

            checkHit(hitCenter, hitRadius) {
                return this.colliderMesh.position.distanceTo(hitCenter) < (0.5 + hitRadius);
            }

            applyHit(direction, magnitude) {
                let localDir = direction.clone().applyQuaternion(this.group.quaternion.clone().invert()).normalize();
                this.recoilVelocity.x += localDir.x * magnitude * 0.3;
                this.recoilVelocity.y += localDir.z * magnitude * 0.3;
                this.flashTimer = this.flashDuration;
                this.flashStrength = Math.min(3.0, magnitude / 40);
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
                    const t = (Math.max(0, this.flashTimer) / this.flashDuration) * this.flashStrength;
                    this.meshes.forEach(mObj => { mObj.rimUniform.value = t; });
                } else {
                    this.meshes.forEach(mObj => { mObj.rimUniform.value = 0; });
                }
            }
        }