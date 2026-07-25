import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// LOCAL copy of the repo-root Gizmo.js (kept in sync with ../../../Gizmo.js,
// the version Editor/Editor.html uses). Imported relatively rather than from
// the jsdelivr CDN so (a) edits to the gizmo deploy with a normal push
// instead of waiting on the CDN's @main cache to purge, and (b) it resolves
// under the local test server, whose root IS this ProjectFiles/ folder (so a
// "../../../" path up to the repo root wouldn't reach outside it). If you
// change gizmo behaviour, edit the repo-root Gizmo.js and copy it here too.
import Gizmo from './Gizmo.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShapeGenerator } from './shape_generator.js';
import { ShapeGizmo } from './shape_gizmo.js';

// Scratch matrices/vectors for the multi-select group-move math (see
// LevelEditor.update's multi-drag block) - reused every frame so a
// continuous drag doesn't allocate.
const _mDelta = new THREE.Matrix4();
const _mTarget = new THREE.Matrix4();
const _mParentInv = new THREE.Matrix4();
const _vCentroid = new THREE.Vector3();
const _vTmp = new THREE.Vector3();

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

        // Selection outline via a dedicated post-processing composer, same
        // approach as Editor.html's own OutlinePass. Only ever run through
        // in render() below (called while editor mode is active), so it
        // adds nothing to normal gameplay's render path. renderPass/
        // outlinePass cameras are refreshed each render() to follow the
        // active editor camera (free vs player). Its selectedObjects array
        // is what actually gets outlined - set in _select().
        this.composer = new EffectComposer(renderer);
        this.renderPass = new RenderPass(scene, this.camera);
        this.composer.addPass(this.renderPass);
        this.outlinePass = new OutlinePass(new THREE.Vector2(window.innerWidth, window.innerHeight), scene, this.camera);
        // Matches Editor.html's own OutlinePass tuning. downSampleRatio=1
        // is the key sharpness lever - the default 2 renders the edge mask
        // at half resolution (softer/blurrier edges); 1 keeps it full-res
        // (crisp). Re-run setSize after changing it so the edge render
        // targets actually get recreated at the new ratio.
        this.outlinePass.downSampleRatio = 1;
        this.outlinePass.edgeStrength = 5.0;
        this.outlinePass.edgeGlow = 0.0;
        this.outlinePass.edgeThickness = 1.0;
        this.outlinePass.visibleEdgeColor.set('#ffffff');
        this.outlinePass.hiddenEdgeColor.set('#444444');
        this.outlinePass.setSize(window.innerWidth, window.innerHeight);
        this.composer.addPass(this.outlinePass);
        this.composer.addPass(new OutputPass());

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
        // selection is the full set; `selected` is the PRIMARY (last-picked)
        // one, kept for shape mode + the props panel which only ever act on
        // a single object. A single-object selection has selection=[obj],
        // selected=obj. Empty means selection=[], selected=null.
        this.selection = [];
        this.selected = null;
        // Single-select is the DEFAULT (matches the old Editor.html): a plain
        // click selects one object and left-drag ORBITS the camera. Re-clicking
        // the already-active Select tool switches to multi, where left-drag
        // instead runs the marquee box-select and accumulates onto the
        // selection (orbit moves to right-drag / two-finger there).
        this.multiSelectMode = false;
        this._selectClickPending = false;
        // Gizmo anchor for a multi-object selection - moved to the group's
        // centroid, gizmo attaches to THIS instead of any one object, and
        // update() propagates its drag delta onto every selected object
        // (see the multi-move block there). Identity rotation/scale each
        // time it's re-centered so the delta math starts clean.
        this.pivot = new THREE.Group();
        scene.add(this.pivot);
        this._multiDragging = false;
        this._childStartMatrices = [];
        this._pivotStartInv = new THREE.Matrix4();
        this.addedShapes = [];
        this._shapeCounter = 0;   // for naming added shapes (Box 1, Sphere 2...)
        this._entityCounter = 0;  // for naming grouped entities (Entity 1...)
        this.mode = 'select'; // 'select' | 'translate' | 'rotate' | 'scale' | 'shape'
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
        // Fired whenever the object tree changes shape (add / duplicate /
        // group / ungroup / delete) so the outliner can rebuild its rows.
        this.onStructureChange = null;
        // Fired with each brand-new top-level object (addShape / duplicate /
        // prefab instantiate) so the game can wire it into gameplay systems
        // the editor doesn't own - e.g. registering a carryable jar into the
        // `carryables` array so drop/throw physics actually applies to it.
        this.onObjectAdded = null;

        // Marquee (drag box) select - only active in 'select' mode (where
        // the transform gizmo is off, so a drag can't be a handle drag).
        // A screen-space <div> drawn during the drag; on release, every
        // editTarget child whose projected bounding box overlaps the box
        // gets selected. In select mode the left mouse / one-finger touch
        // is handed to the marquee instead of OrbitControls (see setMode),
        // so orbit there is right-drag / two-finger.
        this._marqueeEl = document.createElement('div');
        this._marqueeEl.style.cssText = 'position:fixed;border:1px solid #00aaff;background:rgba(0,150,255,0.15);pointer-events:none;z-index:150;display:none;';
        document.body.appendChild(this._marqueeEl);
        this._marqueeActive = false;
        this._marqueeStart = new THREE.Vector2();
        this._marqueeBox = new THREE.Box3();

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onDblClick = this._onDblClick.bind(this);
        renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
        renderer.domElement.addEventListener('pointermove', this._onPointerMove);
        window.addEventListener('pointerup', this._onPointerUp);
        renderer.domElement.addEventListener('dblclick', this._onDblClick);
    }

    activate() {
        this.controls.enabled = true;
        this.controls.update();
        // Apply the current mode's side effects (e.g. select mode frees the
        // left mouse button for the marquee, detaches the gizmo) so entering
        // editor mode matches the toolbar's default-active Select tool.
        this.setMode(this.mode);
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
        this.renderPass.camera = cam;
        this.outlinePass.renderCamera = cam;
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
        } else if (mode === 'select') {
            // Pure selection mode: clicking still selects/outlines objects,
            // but NO transform gizmo is shown, so you can pick without any
            // chance of dragging. Both gizmos off. The left-drag behaviour
            // depends on the single/multi sub-mode (see _applySelectControls):
            // single leaves orbit on left-drag, multi hands it to the marquee.
            this.shapeGizmo.detach();
            this.gizmo.detach();
            this._applySelectControls();
        } else {
            this.shapeGizmo.detach();
            this.gizmo.updateMode(mode);
            // Restore normal orbit on left-drag / one-finger for the
            // transform modes.
            this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
            this.controls.touches.ONE = THREE.TOUCH.ROTATE;
            // Re-attach the gizmo to whatever's selected - single object or
            // the multi-select pivot - via the shared visuals refresh.
            this._refreshSelectionVisuals();
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

    // Downloads a .glb of either the WHOLE level (selectionOnly=false -
    // everything in editTarget, the built level plus editor additions) or
    // just the current selection (selectionOnly=true). No import path yet -
    // this is "get it out of the tab before a refresh loses it", not a
    // load-back pipeline (see CLAUDE.md). Exports clones, not the live
    // objects (so their world transforms can be baked without disturbing
    // the scene), and strips the wireframe helper lines so they don't end
    // up as stray geometry in the file.
    exportGLTF(selectionOnly = false) {
        const exportRoot = new THREE.Group();
        let sources;
        if (selectionOnly) {
            if (this.selection.length === 0) return;
            sources = this.selection;
        } else {
            sources = this.editTarget.children;
        }
        sources.forEach(o => {
            if (o.userData && o.userData.isWireframeHelper) return;
            o.updateMatrixWorld(true);
            const c = o.clone(true);
            // Bake the object's world transform onto the clone so a
            // selection exported out of its parent still lands correctly.
            c.matrix.copy(o.matrixWorld);
            c.matrix.decompose(c.position, c.quaternion, c.scale);
            const toRemove = [];
            c.traverse(n => { if (n.userData && n.userData.isWireframeHelper) toRemove.push(n); });
            toRemove.forEach(n => { if (n.parent) n.parent.remove(n); });
            exportRoot.add(c);
        });

        const exporter = new GLTFExporter();
        exporter.parse(exportRoot, (result) => {
            const blob = new Blob([result], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = selectionOnly ? 'selection.glb' : 'level.glb';
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

        if (original.name) clone.name = original.name + ' copy';
        this.addedShapes.push(clone);
        this._select(clone);
        this._objectAdded(clone);
        this._structureChanged();
        return clone;
    }

    setSnapEnabled(enabled) { this.snapEnabled = enabled; }

    // Re-clicking the already-active Select tool flips single<->multi.
    // Returns the new state so the caller can swap the toolbar icon.
    toggleMultiSelect() {
        this.multiSelectMode = !this.multiSelectMode;
        // Re-apply the left-drag behaviour if we're in select mode right now
        // (single = orbit the camera, multi = marquee box-select).
        if (this.mode === 'select') this._applySelectControls();
        return this.multiSelectMode;
    }

    // In select mode, single sub-mode keeps OrbitControls on left-drag /
    // one-finger (so you can orbit the camera; a plain click still selects),
    // while multi sub-mode hands left-drag to the marquee box-select and
    // leaves orbit on right-drag / two-finger only. Matches Editor.html,
    // where marquee lived behind an explicit multi-select toggle and normal
    // select never stole the orbit drag.
    _applySelectControls() {
        if (this.mode !== 'select') return;
        if (this.multiSelectMode) {
            this.controls.mouseButtons.LEFT = null;
            this.controls.touches.ONE = null;
        } else {
            this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
            this.controls.touches.ONE = THREE.TOUCH.ROTATE;
        }
    }

    // Groups the current selection under a new entity (a THREE.Group with
    // userData.isEntity, so it outlines yellow and a plain click selects the
    // whole thing; double-click drills into a child - see _onDblClick). The
    // group's origin sits at the selection's world centroid, and each member
    // is re-parented with world transforms preserved (Object3D.attach). The
    // members leave editTarget's top level but stay reachable through the
    // group; the raycast walk-up in the pointer handlers already stops at
    // editTarget's direct child, so it lands on the group. Needs 2+ objects.
    group() {
        const members = this.selection.filter(o => o && o.parent === this.editTarget);
        if (members.length < 2) return null;
        _vCentroid.set(0, 0, 0);
        members.forEach(o => { o.getWorldPosition(_vTmp); _vCentroid.add(_vTmp); });
        _vCentroid.multiplyScalar(1 / members.length);
        const grp = new THREE.Group();
        grp.userData.isEntity = true;
        grp.name = 'Entity ' + (++this._entityCounter);
        grp.position.copy(_vCentroid);
        this.editTarget.add(grp);
        grp.updateMatrixWorld(true);
        // attach() preserves each child's world transform under the new parent.
        members.forEach(o => grp.attach(o));
        this._select(grp);
        this._structureChanged();
        return grp;
    }

    // Dissolves the selected entity group(s): re-parents their children back
    // to editTarget (world transforms preserved) and removes the now-empty
    // group, then selects the freed children. Non-entity selections are left
    // alone. The inverse of group().
    ungroup() {
        const groups = this.selection.filter(o => o && o.userData && o.userData.isEntity);
        if (!groups.length) return;
        const freed = [];
        groups.forEach(grp => {
            // Snapshot children first - attach() mutates grp.children mid-loop.
            grp.children.slice().forEach(child => {
                this.editTarget.attach(child);
                freed.push(child);
            });
            this.editTarget.remove(grp);
        });
        this.selection = freed;
        this.selected = freed.length ? freed[freed.length - 1] : null;
        this._refreshSelectionVisuals();
        if (this.onSelectionChange) this.onSelectionChange(this.selected);
        this._structureChanged();
    }

    // Public selection entry point for external UI (e.g. the outliner
    // clicking a row). Thin wrapper over the internal _select.
    select(obj, additive = false) { this._select(obj, additive); }

    // Removes the current selection from the scene: detaches from its parent,
    // drops it from collidables/addedShapes so the game stops colliding with
    // it and it won't reappear, then clears the selection. Recurses into
    // entity children so grouped meshes are cleaned up too.
    deleteSelected() {
        if (!this.selection.length) return;
        const victims = this.selection.slice();
        victims.forEach(obj => {
            obj.traverse(n => {
                if (this.collidables) {
                    const ci = this.collidables.indexOf(n);
                    if (ci >= 0) this.collidables.splice(ci, 1);
                }
                const ai = this.addedShapes.indexOf(n);
                if (ai >= 0) this.addedShapes.splice(ai, 1);
            });
            if (obj.parent) obj.parent.remove(obj);
        });
        this._select(null);
        this._structureChanged();
    }

    _structureChanged() { if (this.onStructureChange) this.onStructureChange(); }
    _objectAdded(obj) { if (this.onObjectAdded) this.onObjectAdded(obj); }

    // ---- Prefabs ----
    // Serializes the PRIMARY selected object (a shape mesh, or an entity group
    // with all its children) to a plain-JSON template the UI can stash in
    // localStorage and re-instantiate later. Wireframe helper lines are
    // stripped from the copy so they don't bake into the prefab. Returns null
    // if nothing is selected. Group first if you want a multi-object prefab.
    serializeSelected() {
        const o = this.selected;
        if (!o) return null;
        o.updateMatrixWorld(true);
        const clone = o.clone(true);
        const helpers = [];
        clone.traverse(n => { if (n.userData && n.userData.isWireframeHelper) helpers.push(n); });
        helpers.forEach(h => { if (h.parent) h.parent.remove(h); });
        return clone.toJSON();
    }

    // Rebuilds an object from a serializeSelected() template and drops it into
    // the level in front of the camera (same spawn placement as addShape),
    // registering its meshes as collidable and selecting it. Preserves the
    // prefab's own rotation/scale and, for entities, its whole child
    // hierarchy (so isEntity / double-click drill still work on the copy).
    instantiate(json, baseName) {
        if (!json) return null;
        const obj = new THREE.ObjectLoader().parse(json);
        const spawn = new THREE.Vector3();
        this.camera.getWorldDirection(spawn).multiplyScalar(6).add(this.camera.position);
        obj.position.copy(spawn);
        obj.name = (baseName || obj.name || 'Prefab') + ' ' + (++this._shapeCounter);
        this.editTarget.add(obj);
        obj.updateMatrixWorld(true);
        obj.traverse(n => {
            if (n.isMesh && this.collidables && !this.collidables.includes(n)) this.collidables.push(n);
        });
        // Only surface-snap a plain mesh; snapping an entity would drop its
        // group origin onto the surface and sink the children below it.
        if (this.snapEnabled && obj.isMesh && !this._placeViaScreenCenterRay(obj)) this._trySnapToSurface(obj);
        if (obj.isMesh) this.addedShapes.push(obj);
        this._select(obj);
        this._objectAdded(obj);
        this._structureChanged();
        return obj;
    }

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
        // Name it so it's identifiable in the outliner (Box 1, Sphere 2, ...).
        mesh.name = type.charAt(0).toUpperCase() + type.slice(1) + ' ' + (++this._shapeCounter);

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
        this._objectAdded(mesh);
        this._structureChanged();
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

        // SELECT mode splits by sub-mode:
        //  - MULTI: a press begins a *pending* marquee - the choice between a
        //    plain single-select (a click that never moved) and a box-select
        //    (a drag) is deferred to pointerup. It deliberately does NOT
        //    raycast-select on the way down (the press point can sit over
        //    distant background even when you mean to drag a box across empty
        //    foreground - letting that pre-empt the drag was the "marquee only
        //    selects one" bug). OrbitControls' left-drag is off in this mode.
        //  - SINGLE: no marquee at all. OrbitControls keeps left-drag to orbit
        //    the camera; we only remember the press point so pointerup can
        //    tell a select-click (didn't move) from an orbit-drag (did move).
        if (this.mode === 'select' && (e.pointerType !== 'mouse' || e.button === 0)) {
            this._marqueeShift = e.shiftKey;
            this._marqueeStart.set(e.clientX, e.clientY);
            if (this.multiSelectMode) {
                this._marqueePending = true;
                this._marqueeActive = false;
                this._selectClickPending = false;
            } else {
                this._marqueePending = false;
                this._marqueeActive = false;
                this._selectClickPending = true;
            }
            return;
        }

        const hits = this.raycaster.intersectObjects(this.editTarget.children, true);
        if (hits.length > 0) {
            let obj = hits[0].object;
            while (obj.parent && obj.parent !== this.editTarget) obj = obj.parent;
            // Shift-click adds/removes from the selection (multi-select);
            // plain click replaces it with just this object.
            this._select(obj, e.shiftKey);
        } else if (!e.shiftKey) {
            // Plain click on empty space clears; shift-click on empty space
            // leaves the current multi-selection alone.
            this._select(null);
        }
    }

    _onPointerMove(e) {
        if (!window.editorModeActive) return;
        if (this._marqueePending || this._marqueeActive) {
            const dx = e.clientX - this._marqueeStart.x, dy = e.clientY - this._marqueeStart.y;
            // Promote pending -> active only once the pointer actually
            // moves past a small threshold, so a plain click stays a click.
            if (!this._marqueeActive && (dx * dx + dy * dy) > 16) {
                this._marqueeActive = true;
                this._marqueeEl.style.display = 'block';
            }
            if (this._marqueeActive) {
                this._marqueeEl.style.left = Math.min(this._marqueeStart.x, e.clientX) + 'px';
                this._marqueeEl.style.top = Math.min(this._marqueeStart.y, e.clientY) + 'px';
                this._marqueeEl.style.width = Math.abs(e.clientX - this._marqueeStart.x) + 'px';
                this._marqueeEl.style.height = Math.abs(e.clientY - this._marqueeStart.y) + 'px';
            }
            return;
        }
        if (this.mode !== 'shape') return;
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        this.shapeGizmo.pointerMove(e, this.raycaster);
    }

    _onPointerUp(e) {
        if (!window.editorModeActive) return;
        if (this._marqueePending || this._marqueeActive) {
            const wasActive = this._marqueeActive;
            this._marqueePending = false;
            this._marqueeActive = false;
            this._marqueeEl.style.display = 'none';
            const ex = (e && e.clientX !== undefined) ? e.clientX : this._marqueeStart.x;
            const ey = (e && e.clientY !== undefined) ? e.clientY : this._marqueeStart.y;
            if (!wasActive) {
                // Never dragged: treat as a plain click - raycast-select the
                // object under the release point (or clear on empty). A tap
                // is additive only with shift held; in multi mode a plain
                // tap still replaces (selects the single object under it).
                const tapAdditive = this._marqueeShift;
                this.mouse.x = (ex / window.innerWidth) * 2 - 1;
                this.mouse.y = -(ey / window.innerHeight) * 2 + 1;
                this.raycaster.setFromCamera(this.mouse, this.camera);
                const hits = this.raycaster.intersectObjects(this.editTarget.children, true);
                if (hits.length > 0) {
                    let obj = hits[0].object;
                    while (obj.parent && obj.parent !== this.editTarget) obj = obj.parent;
                    this._select(obj, tapAdditive);
                } else if (!tapAdditive) {
                    this._select(null);
                }
                return;
            }
            // Dragged: box-select every editTarget child overlapping the rect.
            // The drag accumulates onto the existing selection in multi mode
            // (or with shift); in single mode it replaces.
            const dragAdditive = this._marqueeShift || this.multiSelectMode;
            const minX = Math.min(this._marqueeStart.x, ex), maxX = Math.max(this._marqueeStart.x, ex);
            const minY = Math.min(this._marqueeStart.y, ey), maxY = Math.max(this._marqueeStart.y, ey);
            const picked = [];
            this.editTarget.children.forEach(o => { if (o.userData && o.userData.isWireframeHelper) return; if (this._checkIntersectScreen(o, minX, minY, maxX, maxY)) picked.push(o); });
            if (!dragAdditive) this.selection = [];
            picked.forEach(o => { if (!this.selection.includes(o)) this.selection.push(o); });
            this.selected = this.selection.length ? this.selection[this.selection.length - 1] : null;
            this._refreshSelectionVisuals();
            if (this.onSelectionChange) this.onSelectionChange(this.selected);
            return;
        }
        // Single select mode: OrbitControls owned the drag. If the pointer
        // barely moved it was a select-click (raycast-select under it);
        // if it moved, it was an orbit-drag - leave the selection alone.
        if (this._selectClickPending) {
            this._selectClickPending = false;
            const ex = (e && e.clientX !== undefined) ? e.clientX : this._marqueeStart.x;
            const ey = (e && e.clientY !== undefined) ? e.clientY : this._marqueeStart.y;
            const dx = ex - this._marqueeStart.x, dy = ey - this._marqueeStart.y;
            if ((dx * dx + dy * dy) > 25) return; // dragged past ~5px -> orbit, not a click
            const clickAdditive = this._marqueeShift;
            this.mouse.x = (ex / window.innerWidth) * 2 - 1;
            this.mouse.y = -(ey / window.innerHeight) * 2 + 1;
            this.raycaster.setFromCamera(this.mouse, this.camera);
            const hits = this.raycaster.intersectObjects(this.editTarget.children, true);
            if (hits.length > 0) {
                let obj = hits[0].object;
                while (obj.parent && obj.parent !== this.editTarget) obj = obj.parent;
                this._select(obj, clickAdditive);
            } else if (!clickAdditive) {
                this._select(null);
            }
            return;
        }
        if (this.shapeGizmo.pointerUp()) this.controls.enabled = true;
    }

    // Double-click drills INTO an entity: single-click selects the whole
    // entity group (yellow), double-click steps one level deeper toward the
    // child under the cursor. Repeated double-clicks keep drilling through
    // nested entities down to the leaf mesh. Only meaningful in select mode.
    _onDblClick(e) {
        if (!window.editorModeActive || this.mode !== 'select') return;
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const hits = this.raycaster.intersectObjects(this.editTarget.children, true);
        if (!hits.length) return;
        // Build the ancestor chain from the top-level editTarget child (index
        // 0) down to the hit node, skipping wireframe helpers.
        const chain = [];
        let c = hits[0].object;
        while (c && c !== this.editTarget) {
            if (!(c.userData && c.userData.isWireframeHelper)) chain.unshift(c);
            c = c.parent;
        }
        if (!chain.length) return;
        // Find the deepest node in the chain that's already selected, then
        // select one level deeper (or the top entity if nothing here is
        // selected yet, or stay on the leaf if already at the bottom).
        let ds = -1;
        for (let i = 0; i < chain.length; i++) if (this.selection.includes(chain[i])) ds = i;
        let target;
        if (ds === -1) target = chain[0];
        else if (ds < chain.length - 1) target = chain[ds + 1];
        else target = chain[ds];
        this._select(target);
    }

    // True if `obj`'s world-space bounding box projects to a screen rect
    // that overlaps the given marquee rectangle (all in CSS pixels). Mirrors
    // Editor.html's own checkIntersect - projects the 8 box corners, takes
    // their screen-space AABB, and does a 2D overlap test.
    _checkIntersectScreen(obj, minX, minY, maxX, maxY) {
        this._marqueeBox.setFromObject(obj);
        if (this._marqueeBox.isEmpty() || !isFinite(this._marqueeBox.min.x)) return false;
        const b = this._marqueeBox;
        let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
        for (let i = 0; i < 8; i++) {
            _vTmp.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
            _vTmp.project(this.camera);
            if (_vTmp.z > 1) return false; // behind the camera
            const sx = (_vTmp.x * 0.5 + 0.5) * window.innerWidth;
            const sy = (-_vTmp.y * 0.5 + 0.5) * window.innerHeight;
            sMinX = Math.min(sMinX, sx); sMaxX = Math.max(sMaxX, sx);
            sMinY = Math.min(sMinY, sy); sMaxY = Math.max(sMaxY, sy);
        }
        return sMinX <= maxX && sMaxX >= minX && sMinY <= maxY && sMaxY >= minY;
    }

    // obj: the picked object (or null to clear). additive (shift-click):
    // toggle obj in/out of the current selection instead of replacing it.
    _select(obj, additive = false) {
        if (additive && obj) {
            const i = this.selection.indexOf(obj);
            if (i >= 0) this.selection.splice(i, 1); else this.selection.push(obj);
        } else {
            this.selection = obj ? [obj] : [];
        }
        // Primary = last one still in the set (drives shape mode + props
        // panel, which only make sense for a single object).
        this.selected = this.selection.length ? this.selection[this.selection.length - 1] : null;
        this._refreshSelectionVisuals();
        if (this.onSelectionChange) this.onSelectionChange(this.selected);
    }

    // Re-applies outline + gizmo attachment for the current selection set.
    // Split out of _select so grouping/ungrouping (later) can reuse it.
    _refreshSelectionVisuals() {
        // Outline every selected object. Yellow if the (primary) selection
        // is an entity/parent group (userData.isEntity), white otherwise.
        this.outlinePass.selectedObjects = this.selection.slice();
        const anyEntity = this.selection.some(o => o.userData && o.userData.isEntity);
        this.outlinePass.visibleEdgeColor.set(anyEntity ? '#ffff00' : '#ffffff');

        if (this.mode === 'shape') {
            // Shape mode only ever edits a single primary object.
            this._syncShapeGizmo();
            return;
        }
        if (this.mode === 'select') {
            // Selection-only mode never shows a transform gizmo.
            this.gizmo.detach();
            return;
        }
        if (this.selection.length === 0) {
            this.gizmo.detach();
        } else if (this.selection.length === 1) {
            this.gizmo.attach(this.selection[0]);
        } else {
            // Multi: anchor the gizmo on a fresh pivot at the selection's
            // centroid (identity rotation/scale), and update() propagates
            // its drag onto every member.
            _vCentroid.set(0, 0, 0);
            this.selection.forEach(o => { o.getWorldPosition(_vTmp); _vCentroid.add(_vTmp); });
            _vCentroid.multiplyScalar(1 / this.selection.length);
            this.pivot.position.copy(_vCentroid);
            this.pivot.quaternion.identity();
            this.pivot.scale.set(1, 1, 1);
            this.pivot.updateMatrixWorld(true);
            this.gizmo.attach(this.pivot);
        }
    }

    update(delta) {
        this.controls.update();
        this.gizmo.update();
        if (this.mode === 'shape') this.shapeGizmo.update();

        // Multi-select group move: while 2+ objects are selected and the
        // gizmo is being dragged, the gizmo moves the shared `pivot`; here
        // we propagate the pivot's transform delta (since drag start) onto
        // every selected object, preserving their relative offsets. Uses
        // full world-matrix deltas so translate/rotate/scale all work the
        // same way. gizmo.activeAxis transitioning null->set marks the drag
        // start (snapshot), set->null marks the end.
        if (this.selection.length > 1) {
            const dragging = !!this.gizmo.activeAxis;
            if (dragging && !this._multiDragging) {
                this._multiDragging = true;
                this.pivot.updateMatrixWorld(true);
                this._pivotStartInv.copy(this.pivot.matrixWorld).invert();
                this._childStartMatrices = this.selection.map(o => { o.updateMatrixWorld(true); return o.matrixWorld.clone(); });
            } else if (dragging && this._multiDragging) {
                this.pivot.updateMatrixWorld(true);
                _mDelta.multiplyMatrices(this.pivot.matrixWorld, this._pivotStartInv);
                this.selection.forEach((o, i) => {
                    if (!this._childStartMatrices[i]) return;
                    _mTarget.multiplyMatrices(_mDelta, this._childStartMatrices[i]);
                    // Bring the new world matrix back into o's local space
                    // (its parent is editTarget) before decomposing.
                    o.parent.updateMatrixWorld(true);
                    _mParentInv.copy(o.parent.matrixWorld).invert();
                    _mTarget.premultiply(_mParentInv);
                    _mTarget.decompose(o.position, o.quaternion, o.scale);
                });
            } else if (!dragging && this._multiDragging) {
                this._multiDragging = false;
            }
        }
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
        if (this.snapEnabled && this.mode === 'translate' && this.gizmo.activeAxis && this.selection.length === 1 && this.selected) {
            this._trySnapToSurface(this.selected, 1.5);
        }
    }

    render() {
        // Keep the composer's passes pointed at whichever camera is active
        // this frame (free/player can be swapped live via setCameraMode,
        // but this also covers the very first frame before any swap).
        this.renderPass.camera = this.camera;
        this.outlinePass.renderCamera = this.camera;
        this.composer.render();
    }

    setSize(w, h) {
        this.composer.setSize(w, h);
        this.outlinePass.setSize(w, h);
    }
}
