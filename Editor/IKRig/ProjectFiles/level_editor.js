import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// Same repo-root Gizmo.js the standalone Geometry Editor Pro tool
// (Editor/Editor.html) already uses, loaded the same way it does (a CDN
// URL, not a relative path) - this file lives inside ProjectFiles/, which
// is also the root the game is normally served from during local testing
// (python -m http.server from ProjectFiles/), so a relative "../../../"
// path up to the repo root wouldn't resolve under that setup. The CDN
// path works identically locally and once deployed, same as every model/
// texture asset the game already loads this way.
import Gizmo from 'https://cdn.jsdelivr.net/gh/XYremesher/CustomGizmo@main/Gizmo.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { ShapeGenerator } from './shape_generator.js';
import { ShapeGizmo } from './shape_gizmo.js';

// The cut/cap/flip/offset fields shown in the properties panel when a
// shape is selected - not exposed as 3D handles (Editor.html's own
// ShapeGizmo doesn't do that either, see shape_gizmo.js's own comment),
// just checkboxes/number inputs. Mirrors Editor.html's EditorUI.
// renderGeometryUI's cutHierarchy grouping.
export const CUT_PROP_GROUPS = [
    { toggle: 'cutX', subs: ['capX', 'flipX', 'flatX', 'capFlatX', 'offsetX'] },
    { toggle: 'cutY', subs: ['capY', 'flipY', 'flatY', 'capFlatY', 'offsetY'] },
    { toggle: 'cutZ', subs: ['capZ', 'flipZ', 'flatZ', 'capFlatZ', 'offsetZ'] }
];

// Minimal in-game level editor: select an existing level object, move/
// rotate/scale it with a gizmo, add a new primitive shape and sculpt its
// dimensions/radius/segment count with its own dedicated shape gizmo
// (plus cut/cap/flip via the properties panel), toggle a wireframe
// overlay. No outliner, multi-select, undo, or save/export yet - see
// ProjectFiles/CLAUDE.md for the full scope this was deliberately kept
// out of. Toggled on/off via window.editorModeActive (see game_js.js's
// animate() and keydown handler, and ClimbGame.html's "Level Editor"
// panel button) - this class stays inert (no listener side effects beyond
// a cheap per-mousemove hover raycast Gizmo itself already does
// unconditionally) whenever that flag is off.
export class LevelEditor {
    constructor(scene, renderer, editTarget, collidables) {
        this.scene = scene;
        this.renderer = renderer;
        this.editTarget = editTarget; // levelGroup - new/selected objects live here, same as everything else built by buildStairsLevel()
        // The same array the whole game's ground/wall raycasting tests
        // against (game_js.js's `collidables`) - shapes added via addShape
        // get pushed in here too so the player can actually stand on them,
        // not just see them. Existing level objects already live in here
        // from level-build time and just get moved by reference when
        // dragged with the transform gizmo, so they never needed this -
        // only brand-new shapes do.
        this.collidables = collidables;

        // The editor's own dedicated free-fly camera - default mode. Kept
        // separate from `this.camera` (the currently ACTIVE camera, see
        // setCameraMode below) so switching to "player camera" mode doesn't
        // lose this one's position/orbit state, and switching back to
        // "free" restores exactly where you left it.
        this._freeCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
        this._freeCamera.position.set(14, 14, 14);
        this.camera = this._freeCamera;
        this.cameraMode = 'free'; // 'free' | 'player'

        // enableDamping without calling controls.update() every frame (only
        // done in this.update(), itself only called while editor mode is
        // active - see LevelEditor.update's own call site) means the damped
        // "coast" motion simply doesn't advance while inactive, not that it
        // leaks input handling into normal gameplay - OrbitControls' own
        // pointer listeners are scoped to renderer.domElement like Gizmo's,
        // not global, but its default `enabled` would still let it react to
        // an orbit-drag anywhere the player already clicks the canvas -
        // hence gating `enabled` explicitly in activate()/deactivate() too.
        // `controls.object` gets reassigned in setCameraMode below when
        // switching to/from the player's own camera - three.js's
        // OrbitControls reads it fresh every update() call rather than
        // caching it at construction, so this is safe to swap live.
        this.controls = new OrbitControls(this.camera, renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.target.set(0, 3, -10);
        this.controls.enabled = false;

        // Gizmo adds its own group straight into `scene` and its handle
        // materials already render with depthTest:false (see Gizmo.js's
        // own getMat helper), so it draws on top of level geometry without
        // needing EditorCore's separate gizmoScene/clearDepth trick.
        this.gizmo = new Gizmo(scene, this.camera, renderer, this.controls);

        this.shapeGenerator = new ShapeGenerator();
        this.shapeGizmo = new ShapeGizmo(this.camera, renderer.domElement);
        this.shapeGizmo.onUpdate = (paramName, value, posOffset) => {
            if (!this.selected) return;
            this.selected.userData.params[paramName] = value;
            this._rebuildShapeGeometry(this.selected);
            if (posOffset) this.selected.position.copy(posOffset);
            this.shapeGizmo.update();
            this.gizmo.updateMatrix();
        };
        scene.add(this.shapeGizmo.group);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this._screenCenter = new THREE.Vector2(0, 0);
        this._snapRaycaster = new THREE.Raycaster();
        this._snapOrigin = new THREE.Vector3();
        this._snapDown = new THREE.Vector3(0, -1, 0);
        this.selected = null;
        this.addedShapes = [];
        this.mode = 'translate'; // 'translate' | 'rotate' | 'scale' | 'shape'
        this.wireframeEnabled = false;
        // Gates both the drag-time surface snap (update(), vertical-only,
        // tight distance) and addShape's own placement snap (screen-center
        // raycast onto whatever surface is under the crosshair, any
        // orientation - see _placeViaScreenCenterRay). Default on since
        // that's the whole point of a level editor: things should land
        // where you're aiming, not float at a fixed distance in front of
        // the camera.
        this.snapEnabled = true;

        // UI hook - set by the panel wiring (game_js.js) to re-render the
        // cut/cap/flip inputs whenever selection changes. Not called on
        // every shapeGizmo drag (those only touch dim/radius/segment
        // params, which aren't in this panel).
        this.onSelectionChange = null;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
        renderer.domElement.addEventListener('pointermove', this._onPointerMove);
        window.addEventListener('pointerup', this._onPointerUp);
    }

    activate() {
        this.controls.enabled = true;
        this.controls.update();
    }

    deactivate() {
        this.controls.enabled = false;
        this._select(null);
    }

    // mode: 'free' (the editor's own dedicated fly camera) | 'player' (the
    // actual game camera, window.gameCamera - editing from wherever you
    // currently are instead of a separate detached viewpoint). Safe to
    // call while editor mode is active or not; normal gameplay's own
    // per-frame camera-follow logic is already skipped entirely whenever
    // window.editorModeActive is true (see game_js.js's animate() gate),
    // so there's no fight over who's driving window.gameCamera while this
    // is controlling it - just be aware that on exiting editor mode,
    // gameplay's own camera-follow resumes from wherever OrbitControls
    // left it rather than snapping back on its own.
    setCameraMode(mode) {
        this.cameraMode = mode;
        const cam = mode === 'player' && window.gameCamera ? window.gameCamera : this._freeCamera;
        this.camera = cam;
        this.controls.object = cam;
        this.gizmo.camera = cam;
        this.shapeGizmo.camera = cam;
        // OrbitControls orbits around `target`, not wherever the camera
        // happens to already be looking - re-aim it at a point in front of
        // whichever camera just became active, otherwise switching to the
        // player's camera would orbit around the free camera's old target
        // (or vice versa), snapping the view sideways on the very first drag.
        const forward = new THREE.Vector3();
        cam.getWorldDirection(forward);
        this.controls.target.copy(cam.position).addScaledVector(forward, 10);
        this.controls.update();
    }

    setMode(mode) {
        this.mode = mode;
        if (mode === 'shape') {
            // Fully detach, not just hide gizmoGroup - Gizmo's own
            // pointerdown handler (registered globally in its constructor,
            // completely outside this class's control) still hit-tests and
            // drags a merely-hidden-but-still-attached selectedObject, which
            // is what let the transform gizmo silently keep responding
            // while supposedly in shape mode.
            this.gizmo.detach();
            this._syncShapeGizmo();
        } else {
            this.shapeGizmo.detach();
            this.gizmo.updateMode(mode);
            if (this.selected) this.gizmo.attach(this.selected);
        }
    }

    // Reframes the camera on the current selection, same idea as
    // Editor.html's own "F" focus shortcut - keeps the current viewing
    // angle (camera direction relative to controls.target), just moves in/
    // out along it and re-centers the orbit target on the selected object.
    focus() {
        if (!this.selected) return;
        const box = new THREE.Box3().setFromObject(this.selected);
        if (box.isEmpty()) return;
        const center = new THREE.Vector3(); box.getCenter(center);
        const size = new THREE.Vector3(); box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 2.0;
        const dist = maxDim * 2.0;
        const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();
        this.camera.position.copy(center).addScaledVector(dir, dist);
        this.controls.target.copy(center);
        this.controls.update();
    }

    // Downloads the whole current level (everything in editTarget - the
    // original built level plus anything added/moved in this editor
    // session) as a single .glb file. No import path yet - this is just
    // "get it out of the browser tab before a refresh loses it", not a
    // load-back pipeline (see CLAUDE.md for what's still out of scope).
    // Exports a clone, not the live objects, and strips the wireframe
    // helper lines (see _addWireframeHelper) so they don't end up as
    // stray geometry in the file.
    exportGLTF() {
        const clone = this.editTarget.clone(true);
        clone.updateMatrixWorld(true);
        const toRemove = [];
        clone.traverse(n => { if (n.userData && n.userData.isWireframeHelper) toRemove.push(n); });
        toRemove.forEach(n => { if (n.parent) n.parent.remove(n); });

        const exporter = new GLTFExporter();
        exporter.parse(clone, (result) => {
            const blob = new Blob([result], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'level.glb';
            a.click();
            URL.revokeObjectURL(url);
        }, (err) => console.error('GLTF export failed:', err), { binary: true });
    }

    // Clones the current selection (geometry/material shared by reference
    // like a plain Object3D.clone() - editing the copy's shape params
    // later fully replaces ITS OWN geometry via _rebuildShapeGeometry, so
    // sharing the starting geometry costs nothing and never leaks an edit
    // back onto the original). userData.params is deep-copied explicitly
    // rather than trusted to clone()'s own userData handling, since a
    // shared params object would make editing one shape silently edit the
    // other too. Offset sideways by roughly the object's own width so the
    // copy doesn't land exactly on top of the original.
    duplicate() {
        if (!this.selected) return null;
        const original = this.selected;
        const clone = original.clone(false);
        clone.userData = { ...original.userData };
        if (original.userData.params) clone.userData.params = JSON.parse(JSON.stringify(original.userData.params));
        delete clone.userData.wireframeLine; // clone(false) skips children, but strip the stale reference too

        const size = new THREE.Box3().setFromObject(original).getSize(new THREE.Vector3());
        clone.position.x += Math.max(size.x, 1.0) * 1.2;

        this.editTarget.add(clone);
        clone.updateMatrixWorld(true);
        if (this.wireframeEnabled) this._addWireframeHelper(clone);
        if (this.collidables && !this.collidables.includes(clone)) this.collidables.push(clone);

        this.addedShapes.push(clone);
        this._select(clone);
        return clone;
    }

    setSnapEnabled(enabled) { this.snapEnabled = enabled; }

    // Both snap raycasts below need to hit the plain grass ground too, not
    // just built level objects - `window.ground` (the big flat plane) is
    // deliberately NOT part of `editTarget` (levelGroup), same as several
    // of the game's own systems that exclude it on purpose (see
    // CLAUDE.md), so it has to be added in here explicitly or open-ground
    // placement/dragging would never find anything to snap to.
    _snapTargets() {
        return window.ground ? this.editTarget.children.concat(window.ground) : this.editTarget.children;
    }

    // Casts from the center of the screen along the camera's own view
    // direction (crosshair-style, not straight down like _trySnapToSurface
    // below) and, on a hit, positions `mesh` flush against that surface -
    // whatever orientation it is, not just a floor. Offset along the hit
    // normal uses the AABB's own half-extent projected onto that normal
    // (exact for an axis-aligned, unrotated box; a small conservative
    // over-estimate for spheres/cylinders/cones/torus, which just means a
    // hair of gap rather than embedding). Returns false (caller should
    // fall back to the plain in-front-of-camera spawn) if the crosshair
    // isn't aimed at anything.
    _placeViaScreenCenterRay(mesh) {
        this.raycaster.setFromCamera(this._screenCenter, this.camera);
        const hits = this.raycaster.intersectObjects(this._snapTargets(), true).filter(h => {
            let a = h.object;
            while (a.parent && a.parent !== this.editTarget) a = a.parent;
            return a !== mesh;
        });
        if (hits.length === 0) return false;
        const hit = hits[0];
        if (!hit.face) return false;
        const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
        const box = new THREE.Box3().setFromObject(mesh);
        const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        const offset = Math.abs(half.x * normal.x) + Math.abs(half.y * normal.y) + Math.abs(half.z * normal.z);
        mesh.position.copy(hit.point).addScaledVector(normal, offset);
        return true;
    }

    // Raycasts straight down from `obj`'s current position against the
    // rest of the level and, if a surface is found within
    // `maxSnapDistance` of resting height (Infinity = always snap onto
    // whatever's below, used when first placing a shape - a tight distance
    // is used instead while actively dragging, see update() below, so it
    // only assists near a surface rather than yanking the object from far
    // away mid-drag), sets obj's Y so it sits flush on top of it instead
    // of floating or embedding.
    _trySnapToSurface(obj, maxSnapDistance = Infinity) {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty() || !isFinite(box.min.y)) return;
        const halfHeight = (box.max.y - box.min.y) / 2;
        if (!(halfHeight > 0)) return;
        this._snapRaycaster.set(this._snapOrigin.set(obj.position.x, obj.position.y + 1000, obj.position.z), this._snapDown);
        const hits = this._snapRaycaster.intersectObjects(this._snapTargets(), true).filter(h => {
            let a = h.object;
            while (a.parent && a.parent !== this.editTarget) a = a.parent;
            return a !== obj;
        });
        if (hits.length === 0) return;
        const targetY = hits[0].point.y + halfHeight;
        if (Math.abs(obj.position.y - targetY) <= maxSnapDistance) {
            obj.position.y = targetY;
            this.gizmo.updateMatrix();
        }
    }

    _syncShapeGizmo() {
        if (this.selected && this.selected.userData.shapeType) {
            this.shapeGizmo.attach(this.selected, this.selected.userData.params, this.selected.userData.shapeType);
        } else {
            this.shapeGizmo.detach();
        }
    }

    setWireframe(enabled) {
        this.wireframeEnabled = enabled;
        this.editTarget.traverse(obj => {
            if (!obj.isMesh || obj.userData.isWireframeHelper) return;
            if (!obj.userData.wireframeLine) this._addWireframeHelper(obj);
            obj.userData.wireframeLine.visible = enabled;
        });
    }

    _addWireframeHelper(mesh) {
        let wG;
        try { wG = new THREE.EdgesGeometry(mesh.geometry, 1); } catch (e) { wG = new THREE.BufferGeometry(); }
        const mat = new THREE.LineBasicMaterial({ color: 0x111111, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const wl = new THREE.LineSegments(wG, mat);
        wl.userData.isWireframeHelper = true;
        // Never a selection target - it's a child of the mesh it outlines,
        // so a hit on it would resolve to the same mesh anyway via the
        // walk-up-to-editTarget-child logic in _onPointerDown, but skipping
        // it outright avoids a redundant raycast test on every click.
        wl.raycast = () => {};
        wl.visible = this.wireframeEnabled;
        mesh.userData.wireframeLine = wl;
        mesh.add(wl);
    }

    // type: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' (ShapeGenerator's
    // own type keys). Spawns a bit in front of the editor camera (not at a
    // fixed world position) so it's always immediately visible and selected
    // regardless of where the camera's currently orbiting.
    addShape(type) {
        const params = ShapeGenerator.defaultParams(type);
        let geo = this.shapeGenerator.generate(type, params);
        geo = this.shapeGenerator.processTriangles(geo, params);
        geo.computeVertexNormals();

        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4d9be6 }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData.shapeType = type;
        mesh.userData.params = params;

        const spawnPos = new THREE.Vector3();
        this.camera.getWorldDirection(spawnPos).multiplyScalar(6).add(this.camera.position);
        mesh.position.copy(spawnPos);

        if (this.wireframeEnabled) this._addWireframeHelper(mesh);

        // Added to editTarget (and its matrixWorld brought up to date)
        // before snapping - both snap paths below need it in the graph to
        // raycast/measure this mesh correctly.
        this.editTarget.add(mesh);
        mesh.updateMatrixWorld(true);
        // Snap ON: place wherever the screen-center crosshair is aimed, on
        // whatever surface that is (wall, ramp, another object's top - not
        // just straight down). If the crosshair isn't aimed at anything,
        // falls back to the plain drop-straight-down snap (still with no
        // distance limit - a freshly placed shape should land on whatever's
        // below it regardless of how far that is) rather than leaving it
        // uselessly floating. Snap OFF: no snapping at all, stays at the
        // plain in-front-of-camera spawn position from above.
        if (this.snapEnabled && !this._placeViaScreenCenterRay(mesh)) {
            this._trySnapToSurface(mesh);
        }

        // Makes it solid - without this the player/carryables would fall
        // straight through anything added here, since the game's own
        // ground/wall raycasts only ever test objects in this array.
        if (this.collidables && !this.collidables.includes(mesh)) this.collidables.push(mesh);

        this.addedShapes.push(mesh);
        this._select(mesh);
        return mesh;
    }

    // Re-generates a shape mesh's geometry from its current userData.params
    // - called after any cut/cap/flip/offset property change, and from
    // shapeGizmo's own onUpdate above after a dim/radius/segment drag.
    _rebuildShapeGeometry(mesh) {
        const p = mesh.userData.params;
        let ng = this.shapeGenerator.generate(mesh.userData.shapeType, p);
        ng = this.shapeGenerator.processTriangles(ng, p);
        ng.computeVertexNormals();
        if (mesh.geometry) mesh.geometry.dispose();
        mesh.geometry = ng;
        if (mesh.userData.wireframeLine) {
            if (mesh.userData.wireframeLine.geometry) mesh.userData.wireframeLine.geometry.dispose();
            mesh.userData.wireframeLine.geometry = new THREE.EdgesGeometry(ng, p.edgeThreshold || 1);
        }
    }

    // Called by the properties panel when a cut/cap/flip checkbox or
    // offset number input changes for the currently selected shape.
    setShapeProp(key, value) {
        if (!this.selected || !this.selected.userData.params) return;
        this.selected.userData.params[key] = value;
        this._rebuildShapeGeometry(this.selected);
        this.shapeGizmo.update();
    }

    _onPointerDown(e) {
        if (!window.editorModeActive) return;
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);

        if (this.mode === 'shape') {
            // Grabbing one of the shape gizmo's own dim/radius/segment
            // handles takes priority - same reasoning as the gizmo.isGizmoHit
            // check below for the transform gizmo. Also disable orbit
            // controls for the duration of the drag, same as the transform
            // Gizmo already does internally for its own handles (Gizmo.js's
            // onPointerDown) - ShapeGizmo doesn't have an orbit reference to
            // do this itself, so without this the camera orbited right
            // along with every shape-handle drag.
            if (this.shapeGizmo.pointerDown(e, this.raycaster, this.camera)) {
                this.controls.enabled = false;
                return;
            }
        } else if (this.gizmo.isGizmoHit(this.mouse)) {
            // A click on the transform gizmo's own handles is a drag-start,
            // not a new selection - Gizmo's own pointerdown listener
            // (registered in its constructor, before this one) already
            // handles that; bail here so it doesn't get reinterpreted as
            // "clicked empty space, deselect".
            return;
        }

        const hits = this.raycaster.intersectObjects(this.editTarget.children, true);
        if (hits.length > 0) {
            let obj = hits[0].object;
            while (obj.parent && obj.parent !== this.editTarget) obj = obj.parent;
            this._select(obj);
        } else {
            this._select(null);
        }
    }

    _onPointerMove(e) {
        if (!window.editorModeActive || this.mode !== 'shape') return;
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.shapeGizmo.pointerMove(e, this.raycaster);
    }

    _onPointerUp() {
        if (!window.editorModeActive) return;
        if (this.shapeGizmo.pointerUp()) this.controls.enabled = true;
    }

    _select(obj) {
        this.selected = obj;
        if (this.mode === 'shape') {
            this._syncShapeGizmo();
        } else {
            this.gizmo.attach(obj);
        }
        if (this.onSelectionChange) this.onSelectionChange(obj);
    }

    update(delta) {
        this.controls.update();
        this.gizmo.update();
        if (this.mode === 'shape') this.shapeGizmo.update();
        // Snap-while-dragging: checked here (once per rendered frame)
        // rather than from a pointermove handler - this class's own
        // pointermove listener is registered on the canvas, which (being
        // the actual event target) fires BEFORE Gizmo's own window-level
        // pointermove that does the real position update, so snapping
        // there would always be one step stale and immediately overwritten.
        // Doing it here instead runs strictly after any pointer-driven
        // moves this frame. Tight 1.5-unit distance (vs. addShape's
        // Infinity) so it only assists near a surface instead of yanking
        // the object away from a precise mid-air placement.
        if (this.snapEnabled && this.mode === 'translate' && this.gizmo.activeAxis && this.selected) {
            this._trySnapToSurface(this.selected, 1.5);
        }
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }
}
