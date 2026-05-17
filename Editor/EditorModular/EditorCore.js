import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Gizmo from 'https://cdn.jsdelivr.net/gh/XYremesher/CustomGizmo@main/Gizmo.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { ShapeGenerator } from './ShapeGenerator.js';
import { ShapeGizmo } from './ShapeGizmo.js';
import { EditorUI } from './EditorUI.js';
import { EntityData } from './EntityData.js';
import { AnimationManager } from './AnimationManager.js';

export class EditorCore {
    constructor() {
        this.scene = null; this.camera = null; this.renderer = null; this.controls = null;
        this.raycaster = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
        this.gizmo = null; this.gizmoTarget = null; this.gizmoScene = null;
        this.shapeGenerator = null; this.shapeGizmo = null;
        this.isGizmoDragging = false; this.currentGizmoSpace = 'world'; this.isShapeMode = false;
        this.composer = null; this.outlinePass = null;
        this.axesScene = null; this.axesCamera = null; this.axesHelper = null; this.editorRoot = null;
        this.selectedObjects = []; this.isWireframe = false; this.showObjectAxes = false; this.showParentOrigins = false;
        this.showEntityDots = true; this.entityDotSize = 0.02; this.gizmoSize = 1.0; this.useOutline = true; this.useHighlight = false; this.gizmoOnTop = true;
        this.wfColorHex = '#666666';
        this.lastSelectedNode = null; this.outlinerFlatNodes = []; this.lockedChildrenTransforms = []; this.definedCollections = {}; this.undoStack = [];
        this.pointerDownPos = new THREE.Vector2(); this.isMultiSelectMode = false; this.isMarqueeSelecting = false; this.marqueeStart = new THREE.Vector2();
        this.multiSelectPivot = null; this.multiSelectInitialMatrix = new THREE.Matrix4(); this.multiSelectInitialInverse = new THREE.Matrix4(); this.selectedObjectsInitialMatrices = [];
        this.depthWriteMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        this.gltfGeometryCache = {}; this.gltfMaterialCache = {};

        this.ui = new EditorUI(this);
        this.clock = new THREE.Clock();
        this.animationManager = new AnimationManager(this);
    }

    init() {
        this.shapeGenerator = new ShapeGenerator();
        this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x3d3d3d);
        this.editorRoot = new THREE.Group(); this.editorRoot.name = "Scene Root"; this.scene.add(this.editorRoot);
        this.multiSelectPivot = new THREE.Group(); this.multiSelectPivot.name = "MultiSelectPivot"; this.scene.add(this.multiSelectPivot);
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000); this.camera.position.set(4, 4, 4);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, alpha: true }); this.renderer.setSize(window.innerWidth, window.innerHeight); this.renderer.autoClear = false; document.body.appendChild(this.renderer.domElement);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = true;
        
        const ambLight = new THREE.AmbientLight(0xffffff, 0.8);
        ambLight.userData.isHelper = true;
        this.scene.add(ambLight);
        
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
        dirLight.position.set(5, 10, 7);
        dirLight.userData.isHelper = true;
        this.scene.add(dirLight);
        
        const grid = new THREE.GridHelper(10, 10, 0x222222, 0x555555);
        grid.userData.isHelper = true;
        this.scene.add(grid);
        
        this.gizmoScene = new THREE.Scene();
        this.gizmo = new Gizmo(this.gizmoScene, this.camera, this.renderer, this.controls);
        this.gizmo.setSpace(this.currentGizmoSpace);

        this.shapeGizmo = new ShapeGizmo(this.camera, this.renderer.domElement);
        this.shapeGizmo.onUpdate = (pName, val, posOffset) => {
            if (!this.selectedObjects.length) return;
            const obj = this.selectedObjects[0];
            obj.userData.params[pName] = val;
            if (posOffset) {
                obj.position.copy(posOffset);
                obj.updateMatrixWorld(true);
                this.ui.updateTransformUI();
            }
            this.rebuildGeometry(obj);
            this.ui.renderGeometryUI();
        };
        this.gizmoScene.add(this.shapeGizmo.group);

        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.outlinePass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), this.scene, this.camera);
        this.outlinePass.downSampleRatio = 1;
        this.outlinePass.edgeStrength = 5.0;
        this.outlinePass.edgeGlow = 0.0;
        this.outlinePass.edgeThickness = 1.0;
        this.outlinePass.visibleEdgeColor.set('#ffffff');
        this.outlinePass.hiddenEdgeColor.set('#444444');
        this.composer.addPass(this.outlinePass);

        const outputPass = new OutputPass();
        this.composer.addPass(outputPass);

        this.axesScene = new THREE.Scene(); this.axesCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10); this.axesHelper = new THREE.AxesHelper(1); this.axesScene.add(this.axesHelper);
        
        this.buildInitialHierarchy(); 
        this.loadDefaultCharacter();
        this.animationManager.init(this.editorRoot);
        this.ui.populateOutliner(); this.ui.updateCollectionListUI(); this.ui.setupEventListeners(); this.animate();
    }
// ... existing code ...
    loadDefaultCharacter() {
        this.renderer.domElement.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            
            if (this.gizmo && this.gizmo.gizmo && this.raycaster.intersectObjects([this.gizmo.gizmo], true).length > 0) return;
            if (this.shapeGizmo && this.shapeGizmo.group && this.raycaster.intersectObjects([this.shapeGizmo.group], true).length > 0) return;

            const hits = this.raycaster.intersectObjects(this.editorRoot.children, true);
            if (hits.length > 0) {
                let obj = hits[0].object;
                if (obj.userData?.isHelper && !obj.userData?.isProxy) return;
                if (obj.userData?.isProxy) obj = obj.userData.targetObj;
                
                let root = obj;
                while (root.parent && root.parent !== this.editorRoot && root.parent.type !== 'Scene') {
                    if (root.name === "Soldier" || root.userData.isDefCollection) break;
                    root = root.parent;
                }
                this.selectObject(root, e.shiftKey);
            } else {
                this.selectObject(null, false);
            }
        });

        const url = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@master/examples/models/gltf/Soldier.glb';
        const loader = new GLTFLoader();
        loader.load(url, (gltf) => {
            const model = gltf.scene;
            model.name = "Soldier";
            
            model.traverse((child) => {
                child.userData.shapeType = child.isMesh ? 'GLTF' : 'Empty';
                child.userData.transformLock = true;
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    child.frustumCulled = false;
                    if(child.geometry) {
                        child.geometry.computeBoundingBox();
                        child.geometry.computeBoundingSphere();
                        if(child.geometry.boundingSphere) child.geometry.boundingSphere.radius = 100;
                    }
                    if(child.material) {
                        if(Array.isArray(child.material)) {
                            child.userData.gltfMatId = child.material.map(mat => { this.gltfMaterialCache[mat.uuid]=mat; return mat.uuid; }).join(',');
                            const m = child.material[0]; if(m?.color) child.userData.originalColor=[m.color.r,m.color.g,m.color.b];
                        } else {
                            const m = child.material; child.userData.gltfMatId=m.uuid; this.gltfMaterialCache[m.uuid]=m;
                            if(m.color) child.userData.originalColor=[m.color.r,m.color.g,m.color.b];
                        }
                    }
                    if(child.geometry) { child.userData.gltfGeomId=child.geometry.uuid; this.gltfGeometryCache[child.geometry.uuid]=child.geometry; }
                }
            });
            
            const proxyGeo = new THREE.BoxGeometry(2, 2, 2);
            const proxyMat = new THREE.MeshBasicMaterial({ visible: false, depthWrite: false });
            const proxy = new THREE.Mesh(proxyGeo, proxyMat);
            proxy.position.set(0, 1, 0);
            proxy.userData = { isProxy: true, targetObj: model };
            model.add(proxy);

            this.editorRoot.add(model);
            this.animationManager.cacheBaseStates();
            
            if (gltf.animations && gltf.animations.length > 0) {
                gltf.animations.forEach(anim => {
                    anim.name = "Soldier_" + anim.name;
                    this.animationManager.animationClips.push(anim);
                    const item = document.createElement('div');
                    item.className = 'anim-list-item';
                    item.innerHTML = `<span>${anim.name}</span><button>+</button>`;
                    item.querySelector('button').onclick = () => this.animationManager.addClipToTrack(anim.name);
                    const lib = document.getElementById('anim-library');
                    if (lib) lib.appendChild(item);
                });
            }
            
            this.ui.populateOutliner();
        });
    }

// ... existing code ...// ... existing code ...

    animate() { 
        requestAnimationFrame(this.animate.bind(this)); 
        const delta = this.clock.getDelta();
        this.controls.update(); 
        this.animationManager.update(delta);
        
        this.renderer.clear(); 
        this.renderer.setViewport(0, 0, window.innerWidth, window.innerHeight); 

        this.composer.render(); 

        if (this.gizmoOnTop) {
            this.renderer.clearDepth();
        } else {
            const oldBg = this.scene.background;
            this.scene.background = null;
            this.scene.overrideMaterial = this.depthWriteMat;
            this.renderer.render(this.scene, this.camera);
            this.scene.overrideMaterial = null;
            this.scene.background = oldBg;
        }

        if (this.gizmo) {
            this.gizmo.update();
            if (this.gizmo.gizmo) {
                const targetPos = new THREE.Vector3();
                if (this.gizmoTarget) {
                    this.gizmoTarget.getWorldPosition(targetPos);
                } else {
                    targetPos.set(0, 0, 0);
                }
                const dist = this.camera.position.distanceTo(targetPos);
                const scale = dist * 0.15 * this.gizmoSize;
                this.gizmo.gizmo.scale.setScalar(scale);
            }
        }
        
        if (this.shapeGizmo && this.shapeGizmo.group.visible) this.shapeGizmo.update();
        this.renderer.render(this.gizmoScene, this.camera);

        if (this.isGizmoDragging) {
            if (this.gizmoTarget === this.multiSelectPivot) {
                this.multiSelectPivot.updateMatrixWorld(true);
                const deltaMatrix = this.multiSelectPivot.matrixWorld.clone().multiply(this.multiSelectInitialInverse);
                this.selectedObjects.forEach((o, i) => {
                    if (o.userData.transformLock) return;
                    o.matrix.copy(new THREE.Matrix4().copy(o.parent.matrixWorld).invert()).multiply(deltaMatrix.clone().multiply(this.selectedObjectsInitialMatrices[i]));
                    o.matrix.decompose(o.position, o.quaternion, o.scale);
                    o.updateMatrixWorld(true);
                });
                this.ui.updateTransformUI();
            } else if (this.gizmoTarget) {
                this.gizmoTarget.updateMatrixWorld(true);
                this.ui.updateTransformUI();
            }
        }

        const uiWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ui-width') || 107);
        const isCollapsed = document.getElementById('ui-container')?.classList.contains('collapsed');
        const currentUIWidth = isCollapsed ? 10 : uiWidth;

        this.axesCamera.quaternion.copy(this.camera.quaternion); 
        this.axesCamera.position.set(0, 0, 3).applyQuaternion(this.camera.quaternion); 
        this.axesCamera.lookAt(0,0,0); 
        
        const axesSize = 40;
        const axesPadding = 20;
        const axesX = window.innerWidth - axesSize - axesPadding;
        const axesY = axesPadding;
        
        this.renderer.setViewport(axesX, axesY, axesSize, axesSize); 
        this.renderer.render(this.axesScene, this.axesCamera); 

        let totalTris = 0;
        this.editorRoot.traverse(n => {
            if (n.isMesh && n.geometry && !n.userData?.isHelper && n.visible) {
                totalTris += n.geometry.index ? n.geometry.index.count / 3 : n.geometry.attributes.position.count / 3;
            }
        });

        let selTris = 0;
        this.selectedObjects.forEach(obj => {
            obj.traverse(n => {
                if (n.isMesh && n.geometry && !n.userData?.isHelper && n.visible) {
                    selTris += n.geometry.index ? n.geometry.index.count / 3 : n.geometry.attributes.position.count / 3;
                }
            });
        });
        
        const stats = document.getElementById('stats-overlay');
        if (stats) {
            stats.style.right = (currentUIWidth + 4) + 'px';
            stats.innerHTML = `<div>${totalTris.toLocaleString()}</div><div>${selTris.toLocaleString()}</div>`;
        }
    }

    getCommon(objs, fn) {
        if(!objs.length) return null;
        let val = fn(objs[0]);
        for(let i=1; i<objs.length; i++) {
            const cur = fn(objs[i]);
            if (Array.isArray(val) && Array.isArray(cur)) { if (val[0] !== cur[0] || val[1] !== cur[1] || val[2] !== cur[2]) return null; } 
            else if(cur !== val) return null;
        }
        return val;
    }

    applyToLinkedInstances(baseObj, action) {
        const process = (n) => { action(n); n.traverse(c => { if (!(c.userData?.isHelper)) action(c); }); };
        process(baseObj);
        if (baseObj.userData.instanceOf) {
            this.editorRoot.traverse(o => { if (o !== baseObj && o.userData.instanceOf === baseObj.userData.instanceOf) process(o); });
        }
    }

    updateMultiSelectPivot() {
        if (this.selectedObjects.length <= 1) return;
        const box = new THREE.Box3();
        this.selectedObjects.forEach(obj => { obj.updateMatrixWorld(true); const cb = new THREE.Box3().setFromObject(obj); if (!cb.isEmpty() && cb.min.y !== Infinity) box.union(cb); });
        const center = new THREE.Vector3(); if (!box.isEmpty() && box.min.y !== Infinity) box.getCenter(center);
        this.multiSelectPivot.position.copy(center); this.multiSelectPivot.rotation.set(0,0,0); this.multiSelectPivot.scale.set(1,1,1); this.multiSelectPivot.updateMatrixWorld(true);
    }

    checkIntersect(obj, minX, minY, maxX, maxY) {
        if(!obj.geometry) return false;
        if(!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        const box = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld);
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z), new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z)
        ];
        let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
        for(let c of corners) {
            c.project(this.camera); if (c.z > 1) return false;
            const sx = (c.x * 0.5 + 0.5) * window.innerWidth, sy = -(c.y * 0.5 - 0.5) * window.innerHeight;
            minPx = Math.min(minPx, sx); maxPx = Math.max(maxPx, sx); minPy = Math.min(minPy, sy); maxPy = Math.max(maxPy, sy);
        }
        return !(maxPx < minX || minPx > maxX || maxPy < minY || minPy > maxY);
    }

    saveState() { this.undoStack.push(this.getSerializedScene()); if(this.undoStack.length > 24) this.undoStack.shift(); }
    
    getSerializedScene() { return JSON.stringify(this.serializeNode(this.editorRoot).children); }

    performUndo() {
        if(!this.undoStack.length) return;
        const state = JSON.parse(this.undoStack.pop());
        [...this.editorRoot.children].forEach(child => {
            this.editorRoot.remove(child);
            child.traverse(c => { if(c.geometry && !this.gltfGeometryCache[c.geometry.uuid]) c.geometry.dispose(); if(c.material) { if(Array.isArray(c.material)) c.material.forEach(m => { if(!this.gltfMaterialCache[m.uuid]) m.dispose(); }); else if(!this.gltfMaterialCache[c.material.uuid]) c.material.dispose(); } });
        });
        state.forEach(cData => this.deserializeNode(cData, this.editorRoot));
        this.lockedChildrenTransforms = []; this.selectedObjects = []; this.lastSelectedNode = null;
        if(this.gizmo) { this.gizmo.detach(); this.gizmoTarget = null; }
        if(this.shapeGizmo) this.shapeGizmo.detach();
        this.ui.populateOutliner(); this.ui.refreshSelectionUI();
    }

    updateEntityDot(node) {
        const isE = node.userData.isDefCollection || node.userData.instanceOf;
        if (isE && !node.userData.entityDot) {
            const dot = new THREE.Mesh(new THREE.SphereGeometry(this.entityDotSize, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false, depthWrite: false }));
            dot.userData.isHelper = true; dot.renderOrder = 999; node.userData.entityDot = dot; node.add(dot);
        }
        if (node.userData.entityDot) {
            if (node.userData.entityDot.geometry.parameters.radius !== this.entityDotSize) { node.userData.entityDot.geometry.dispose(); node.userData.entityDot.geometry = new THREE.SphereGeometry(this.entityDotSize, 8, 8); }
            node.userData.entityDot.visible = this.showEntityDots && !!isE;
        }
    }

    setupEmptyHelpers(group) {
        if (!group.userData.localAxes) { const la = new THREE.AxesHelper(1.5); la.userData.isHelper = true; la.visible = this.showObjectAxes; group.userData.localAxes = la; group.add(la); }
        if (!group.userData.originHelper) {
            const og = new THREE.Group(); og.userData.isHelper = true;
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true, depthTest: false, depthWrite: false })); box.renderOrder = 999; og.add(box);
            const axes = new THREE.AxesHelper(0.4); axes.material.depthTest = false; axes.material.depthWrite = false; axes.renderOrder = 999; og.add(axes);
            og.visible = this.showParentOrigins; group.userData.originHelper = og; group.add(og);
        }
        group.updateMatrixWorld(true);
    }

    applyHelper(mesh) {
        let wG = new THREE.BufferGeometry();
        if (mesh.geometry) { try { wG = new THREE.EdgesGeometry(mesh.geometry, 1); } catch(e) {} }
        const wlMat = new THREE.LineBasicMaterial({ color: new THREE.Color(this.wfColorHex), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, depthTest: true });
        const wl = new THREE.LineSegments(wG, wlMat); wl.name = 'WireframeHelper'; wl.userData.isHelper = true; wl.visible = this.isWireframe; wl.raycast = () => {}; mesh.userData.wireframeLine = wl; mesh.add(wl);
        const la = new THREE.AxesHelper(1.5); la.userData.isHelper = true; la.visible = this.showObjectAxes; mesh.userData.localAxes = la; mesh.add(la);
        mesh.updateMatrixWorld(true);
        return mesh;
    }

    createMaterialFromUserData(ud) {
        const type = ud.materialType || 'Standard', c = Array.isArray(ud.originalColor) ? ud.originalColor : [0.8,0.8,0.8], e = Array.isArray(ud.emissive) ? ud.emissive : [0,0,0];
        const props = { color: new THREE.Color(c[0]||0, c[1]||0, c[2]||0), transparent: ud.transparent||false, opacity: ud.opacity??1.0, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, flatShading: ud.flatShading??false, wireframe: ud.wireframe||false, side: ud.side??THREE.FrontSide, depthTest: ud.depthTest??true, depthWrite: ud.depthWrite??true, alphaTest: ud.alphaTest??0.0 };
        let mat;
        if(type === 'Basic') mat = new THREE.MeshBasicMaterial(props);
        else if(type === 'Normal') mat = new THREE.MeshNormalMaterial({ flatShading: props.flatShading, wireframe: props.wireframe, side: props.side, depthTest: props.depthTest, depthWrite: props.depthWrite });
        else if(type === 'Depth') mat = new THREE.MeshDepthMaterial({ wireframe: props.wireframe, side: props.side, depthTest: props.depthTest, depthWrite: props.depthWrite });
        else {
            if(type === 'Phong') mat = new THREE.MeshPhongMaterial(props);
            else if(type === 'Lambert') mat = new THREE.MeshLambertMaterial(props);
            else if(type === 'Toon') mat = new THREE.MeshToonMaterial(props);
            else if(type === 'Physical') { mat = new THREE.MeshPhysicalMaterial({...props, roughness: ud.roughness??0.5, metalness: ud.metalness??0.0, clearcoat:ud.clearcoat, clearcoatRoughness:ud.clearcoatRoughness, transmission:ud.transmission, ior:ud.ior, thickness:ud.thickness}); }
            else mat = new THREE.MeshStandardMaterial({...props, roughness: ud.roughness??0.5, metalness: ud.metalness??0.0});
            mat.emissive.copy(new THREE.Color(e[0]||0, e[1]||0, e[2]||0)); mat.emissiveIntensity = ud.emissiveIntensity??1.0;
        }
        return mat;
    }

    rebuildGeometry(mesh) {
        if (!mesh.userData?.shapeType || mesh.userData.shapeType === 'Empty' || mesh.userData.shapeType === 'GLTF') return;
        const p = mesh.userData.params || {}; 
        const stMap = { 'Cube': 'box', 'Cylinder': 'cyl', 'Cone': 'cone', 'Sphere': 'sphere', 'Torus': 'torus', 'Icosphere': 'icosphere' };
        const mappedType = stMap[mesh.userData.shapeType] || 'box';
        let ng = this.shapeGenerator.generate(mappedType, p);
        ng = this.shapeGenerator.processTriangles(ng, p);
        
        let totalOffset = new THREE.Vector3(0, 0, 0);
        if (p.centerCut) {
            ng.computeBoundingBox();
            const cOff = new THREE.Vector3(); ng.boundingBox.getCenter(cOff).multiplyScalar(-1);
            ng.translate(cOff.x, cOff.y, cOff.z); totalOffset.add(cOff);
        }
        if (p.centerBottom) {
            ng.computeBoundingBox();
            const yOff = -ng.boundingBox.min.y; ng.translate(0, yOff, 0); totalOffset.y += yOff;
        }
        mesh.userData.offset = totalOffset;

        if (BufferGeometryUtils.toCreasedNormals && p.smoothAngle) {
            ng.computeVertexNormals(); ng = BufferGeometryUtils.toCreasedNormals(ng, p.smoothAngle * Math.PI / 180);
        } else ng.computeVertexNormals();

        if (mesh.geometry) mesh.geometry.dispose(); 
        mesh.geometry = ng;
        
        if (mesh.userData.wireframeLine) { 
            if (mesh.userData.wireframeLine.geometry) mesh.userData.wireframeLine.geometry.dispose(); 
            mesh.userData.wireframeLine.geometry = new THREE.EdgesGeometry(ng, p.edgeThreshold || 1); 
        }
        mesh.updateMatrixWorld(true);
    }

    getDefUserData(nameLower, shapeType) {
        const isImport = (nameLower.includes('icosphere') || nameLower.includes('wing') || nameLower.includes('fly') || nameLower.includes('pupae'));
        const isIco = nameLower.includes('icosphere') || nameLower.includes('wing');
        const base = {
            originalColor: [0.8, 0.8, 0.8], shapeType, 
            params: {
                width: isImport ? 1 : 2, height: isImport ? 1 : 2, depth: isImport ? 1 : 2,
                radius: shapeType==='Cube'?0:0.3, torusTube: 0.3, radialSegments: 32, cornerSegments: 8, heightSegments: 1,
                edgeThreshold: 1, smoothAngle: 45, cutX: false, capX: true, flipX: false, flatX: false, capFlatX: true, offsetX: 0,
                cutY: false, capY: true, flipY: false, flatY: false, capFlatY: true, offsetY: 0,
                cutZ: false, capZ: true, flipZ: false, flatZ: false, capFlatZ: true, offsetZ: 0,
                cutRadial: false, radialAngle: 270, radialOffset: 0, radialCap: true,
                centerCut: false, centerBottom: false, coneRoundTip: true, invertRadius: false, cleanDegenerate: true,
                isIcosahedron: isIco
            },
            transparent: nameLower.includes('wing'), opacity: nameLower.includes('wing')?0.85:1.0, materialType: 'Standard', roughness: 0.5, metalness: 0.0, emissive: [0,0,0], emissiveIntensity: 1.0, wireframe: false, side: THREE.FrontSide, flatShading: false, depthTest: true, depthWrite: true, alphaTest: 0.0,
            transformLock: true, castShadow: true, receiveShadow: true, visible: true
        };
        if(shapeType === 'Cube') Object.assign(base.params, { radius: 0, cornerSegments: 3 });
        if(shapeType === 'Cylinder') Object.assign(base.params, { radius: 0.5, radialSegments: 32, cornerSegments: 3 });
        if(shapeType === 'Cone') Object.assign(base.params, { radius: 0.5, radialSegments: 32, cornerSegments: 3 });
        if(shapeType === 'Sphere') Object.assign(base.params, { radialSegments: 32, cornerSegments: isIco ? 2 : 16 });
        if(shapeType === 'Torus') Object.assign(base.params, { torusTube: 0.3, radialSegments: 16, cornerSegments: 32 });
        return base;
    }

    createMeshFromData(data, parentGroup) {
        const nl = data.name.toLowerCase(), st = nl.includes('torus')?'Torus':nl.includes('cube')?'Cube':nl.includes('cone')?'Cone':nl.includes('sphere')||nl.includes('icosphere')||nl.includes('wing')?'Sphere':'Sphere';
        const mesh = new THREE.Mesh(new THREE.BufferGeometry()); mesh.name = data.name; 
        mesh.userData = this.getDefUserData(nl, st); mesh.userData.originalColor = data.color; mesh.material = this.createMaterialFromUserData(mesh.userData);
        mesh.position.set(data.position[0], data.position[2], -data.position[1]); mesh.rotation.set(...data.rotation);
        let sX = Math.abs(data.scale[0]) * 2, sY = Math.abs(data.scale[2]) * 2, sZ = Math.abs(data.scale[1]) * 2;
        if (nl.match(/\.(005|006|009|010|016|038)$/) && !(data.collections?.[0]||"").includes("Watcher")) { sX*=0.4; sY*=0.4; sZ*=0.4; }
        mesh.scale.set(sX, sY, sZ);
        this.applyHelper(mesh); this.rebuildGeometry(mesh); parentGroup.add(mesh); return mesh;
    }

    buildInitialHierarchy() {
        const groups = {}, pd = [];
        EntityData.forEach(item => { pd.push(item); if (item.name.toLowerCase().includes('wing') || ["Cone", "Sphere.016", "Sphere.022", "Cube.001", "Cube.003", "Cube.004"].includes(item.name)) { const m = JSON.parse(JSON.stringify(item)); m.name = item.name.replace('Left', 'Right'); if (m.name === item.name) m.name += "_Mirrored"; m.position[0] = -item.position[0]; m.rotation[1] = -item.rotation[1]; m.rotation[2] = -item.rotation[2]; pd.push(m); } });
        pd.forEach(data => { const cN = data.collections?.[0] || 'Default'; if (!groups[cN]) { const g = new THREE.Group(); g.name = cN; g.userData = {shapeType:'Empty', transformLock:true, collapsed: true}; this.setupEmptyHelpers(g); groups[cN] = g; } this.createMeshFromData(data, groups[cN]); });
        Object.values(groups).forEach(g => {
            const bbox = new THREE.Box3().setFromObject(g), center = new THREE.Vector3(); bbox.getCenter(center);
            const tz = g.name==="Fly_Larvae"?-2:g.name==="Pupae"?-4:g.name==="Fly"?-6:g.name==="Fly_Big"?-8:0;
            const pivot = new THREE.Vector3(0, bbox.min.y, tz);
            g.children.forEach(c => { if (!c.userData?.isHelper) c.position.sub(pivot); });
            g.position.set(0, 0, 0); g.updateMatrixWorld(true);
            const id = THREE.MathUtils.generateUUID(); g.userData.isDefCollection = true; g.userData.defColName = g.name; g.userData.defColId = id;
            const sd = this.serializeNode(g); sd.name = g.name; sd.position = [0,0,0]; sd.userData.instanceOf = undefined; this.definedCollections[id] = sd;
        });
    }

    handleDrop(e, tN) { const id = e.dataTransfer.getData('text/plain'); if(!id) return; let n = null; this.editorRoot.traverse(x => { if(x.uuid === id) n = x; }); if (n && tN && n !== tN) { let ic = false; tN.traverseAncestors(a => { if(a === n) ic = true; }); if(!ic) { tN.attach(n); n.updateMatrixWorld(true); this.ui.populateOutliner(); } } }

    serializeNode(node) {
        const ud = node.userData || {};
        const d = { name: node.name||'Object', position: [node.position.x, node.position.y, node.position.z], rotation: [node.rotation.x, node.rotation.y, node.rotation.z], scale: [node.scale.x, node.scale.y, node.scale.z], type: node.isMesh ? 'Mesh' : node.type, userData: { shapeType: ud.shapeType||'Empty', params: ud.params?JSON.parse(JSON.stringify(ud.params)):undefined, originalColor: ud.originalColor?[...ud.originalColor]:undefined, transparent: ud.transparent||false, opacity: ud.opacity??1.0, materialType: ud.materialType||'Standard', roughness: ud.roughness, metalness: ud.metalness, clearcoat: ud.clearcoat, clearcoatRoughness: ud.clearcoatRoughness, transmission: ud.transmission, ior: ud.ior, thickness: ud.thickness, emissive: ud.emissive?[...ud.emissive]:undefined, emissiveIntensity: ud.emissiveIntensity, wireframe: ud.wireframe||false, side: ud.side??THREE.FrontSide, flatShading: ud.flatShading??false, depthTest: ud.depthTest??true, depthWrite: ud.depthWrite??true, alphaTest: ud.alphaTest??0.0, castShadow: ud.castShadow??true, receiveShadow: ud.receiveShadow??true, visible: node.visible, transformLock: ud.transformLock??true, isDefCollection: ud.isDefCollection||false, defColName: ud.defColName, defColId: ud.defColId, instanceOf: ud.instanceOf, gltfGeomId: ud.gltfGeomId, gltfMatId: ud.gltfMatId }, children: [] };
        if (node.children) node.children.forEach(c => { if (!c.userData?.isHelper) d.children.push(this.serializeNode(c)); });
        return d;
    }

    configureNode(node, data) {
        node.name = data.name; node.userData = data.userData; node.visible = node.userData.visible ?? true; node.position.set(...data.position); node.rotation.set(...data.rotation); node.scale.set(...data.scale);
        if(node.isMesh) {
            node.castShadow = node.userData.castShadow??true; node.receiveShadow = node.userData.receiveShadow??true; this.applyHelper(node);
        } else this.setupEmptyHelpers(node);
        this.updateEntityDot(node);
        node.updateMatrixWorld(true);
    }

    deserializeNode(data, parent) {
        let node;
        if (data.type === 'Mesh') {
            node = new THREE.Mesh(); node.userData = data.userData;
            node.geometry = (data.userData.shapeType === 'GLTF' && data.userData.gltfGeomId && this.gltfGeometryCache[data.userData.gltfGeomId]) ? this.gltfGeometryCache[data.userData.gltfGeomId] : new THREE.BufferGeometry();
            if(node.geometry.type === 'BufferGeometry') this.rebuildGeometry(node);
            let parsedMat = null;
            if (data.userData.shapeType === 'GLTF' && data.userData.gltfMatId) {
                if (data.userData.gltfMatId.includes(',')) {
                    parsedMat = data.userData.gltfMatId.split(',').map(id => this.gltfMaterialCache[id]).filter(m => m);
                    if (parsedMat.length === 0) parsedMat = null;
                } else parsedMat = this.gltfMaterialCache[data.userData.gltfMatId];
            }
            node.material = parsedMat || this.createMaterialFromUserData(data.userData);
        } else { node = new THREE.Group(); node.userData = data.userData; }
        this.configureNode(node, data);
        parent.add(node); if(data.children) data.children.forEach(c => this.deserializeNode(c, node));
        return node;
    }

    selectObject(obj, multi = false) {
        if (!obj) { if(!multi) this.selectedObjects=[]; }
        else if(Array.isArray(obj)) { if(!multi) this.selectedObjects=[]; obj.forEach(o=>{if(!this.selectedObjects.includes(o))this.selectedObjects.push(o);}); }
        else { if(multi) { const idx=this.selectedObjects.indexOf(obj); if(idx>-1) this.selectedObjects.splice(idx,1); else this.selectedObjects.push(obj); } else this.selectedObjects=[obj]; }
        this.ui.refreshSelectionUI();
    }

    addShape(shapeType) {
        this.saveState(); const p = this.editorRoot;
        if (shapeType === 'Empty') { const g = new THREE.Group(); g.name = "Empty."+Math.floor(Math.random()*1000).toString().padStart(3,'0'); g.userData = {shapeType:'Empty', transformLock:true, visible:true}; this.setupEmptyHelpers(g); p.add(g); this.ui.populateOutliner(); this.selectObject(g, false); return; }
        const mesh = new THREE.Mesh(new THREE.BufferGeometry()); mesh.name = shapeType+"."+Math.floor(Math.random()*1000).toString().padStart(3,'0');
        mesh.userData = this.getDefUserData(mesh.name.toLowerCase(), shapeType); mesh.material = this.createMaterialFromUserData(mesh.userData);
        this.applyHelper(mesh); this.rebuildGeometry(mesh); p.add(mesh);
        this.scene.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(mesh); if(!box.isEmpty() && box.min.y!==Infinity) mesh.position.y -= box.min.y; mesh.updateMatrixWorld(true);
        this.ui.populateOutliner(); this.selectObject(mesh, false);
    }

    deleteSelectedObjects() { if(!this.selectedObjects.length) return; this.saveState(); this.selectedObjects.forEach(o => { if(o===this.editorRoot)return; if(o.parent)o.parent.remove(o); o.traverse(c=>{if(c.geometry && !this.gltfGeometryCache[c.geometry.uuid])c.geometry.dispose(); if(c.material){if(Array.isArray(c.material))c.material.forEach(m=>{if(!this.gltfMaterialCache[m.uuid])m.dispose();}); else if(!this.gltfMaterialCache[c.material.uuid])c.material.dispose();}}); }); this.gizmo.detach(); this.gizmoTarget = null; if(this.shapeGizmo) this.shapeGizmo.detach(); this.selectedObjects=[]; this.ui.populateOutliner(); this.ui.refreshSelectionUI(); }

    exportSceneToGLTF() {
        const targets = this.selectedObjects.length ? this.selectedObjects : [this.editorRoot];
        const exp = new GLTFExporter();
        const exportScene = new THREE.Scene();
        targets.forEach(obj => {
            const clone = obj.clone(true); obj.updateMatrixWorld(true);
            clone.matrix.copy(obj.matrixWorld); clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
            const toRemove = []; clone.traverse(n => { if (n.userData?.isHelper || n.name.includes('OutlineMesh') || n.name.includes('AxesHelper') || n.name === 'WireframeHelper') toRemove.push(n); else n.userData = {}; });
            toRemove.forEach(n => { if(n.parent) n.parent.remove(n); });
            exportScene.add(clone);
        });
        exp.parse(exportScene, (g) => { 
            const url = URL.createObjectURL(new Blob([JSON.stringify(g,null,2)], {type:'text/plain'})); 
            const a = document.createElement('a'); a.href = url; a.download = `${this.selectedObjects.length===1 ? (this.selectedObjects[0].name||'object') : 'scene'}.gltf`; 
            a.click(); URL.revokeObjectURL(url); 
        }, (err) => console.error(err), {binary:false});
    }

    importSceneFromGLTF(e) {
        const f = e.target.files[0]; if(!f) return; const r = new FileReader();
        r.onload = (ev) => {
            const loader = new GLTFLoader(); const draco = new DRACOLoader();
            draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
            loader.setDRACOLoader(draco);
            loader.parse(ev.target.result, '', (g) => {
                this.saveState(); const sc = g.scene || g.scenes[0];
                if (sc) {
                    const importedRoots = [...sc.children];
                    importedRoots.forEach(c => this.editorRoot.add(c));
                    const garbage = [];
                    importedRoots.forEach(rootObj => rootObj.traverse(n => {
                        if (n.type === 'AxesHelper' || n.name === 'WireframeHelper' || (n.type === 'LineSegments' && n.material?.color?.getHex() === 0x666666)) garbage.push(n);
                    }));
                    garbage.forEach(n => { if(n.parent) n.parent.remove(n); });
                    importedRoots.forEach(rootObj => {
                        const nodes = []; rootObj.traverse(n => nodes.push(n));
                        nodes.forEach((n, idx) => {
                            if(!n.name || n.name.trim() === '') n.name = n.isMesh ? `Mesh_${idx}` : `Node_${idx}`;
                            n.userData = { 
                                shapeType: n.isMesh?'GLTF':'Empty', transformLock: true, visible: true, castShadow: true, receiveShadow: true,
                                originalColor: [0.8,0.8,0.8], emissive: [0,0,0], materialType: 'Standard', roughness: 0.5, metalness: 0.0, transparent: false, opacity: 1.0,
                                wireframe: false, side: THREE.FrontSide, flatShading: false, depthTest: true, depthWrite: true, alphaTest: 0.0
                            };
                            if (n.isMesh) {
                                if(n.material) {
                                    if(Array.isArray(n.material)) {
                                        n.userData.gltfMatId = n.material.map(mat => { this.gltfMaterialCache[mat.uuid]=mat; return mat.uuid; }).join(',');
                                        const m = n.material[0]; if(m?.color) n.userData.originalColor=[m.color.r,m.color.g,m.color.b];
                                    } else {
                                        const m = n.material; n.userData.gltfMatId=m.uuid; this.gltfMaterialCache[m.uuid]=m;
                                        if(m.color) n.userData.originalColor=[m.color.r,m.color.g,m.color.b];
                                    }
                                }
                                if(n.geometry) { n.userData.gltfGeomId=n.geometry.uuid; this.gltfGeometryCache[n.geometry.uuid]=n.geometry; }
                                this.applyHelper(n);
                            } else this.setupEmptyHelpers(n);
                        });
                    });
                    this.selectObject(importedRoots, false);
                }
                this.ui.populateOutliner();
            }, err => console.error(err));
        };
        if(f.name.toLowerCase().endsWith('.glb')) r.readAsArrayBuffer(f); else r.readAsText(f); e.target.value = '';
    }
}