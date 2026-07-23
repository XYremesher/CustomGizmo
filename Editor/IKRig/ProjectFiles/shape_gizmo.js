import * as THREE from 'three';

// Extracted verbatim from Editor/Editor.html's own ShapeGizmo - the
// draggable 3D handles for a shape's own dimension/radius/segment
// parameters (distinct from the generic move/rotate/scale Gizmo.js
// handles). Cut/cap/flip aren't exposed as 3D handles here either in the
// original tool - those are checkbox/number-input controls in a 2D panel
// there (see level_editor.js's buildShapePropsPanel, which mirrors that).
export class ShapeGizmo {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        this.group = new THREE.Group();
        this.group.name = "ShapeGizmoGroup";
        this.dragPlane = new THREE.Plane();
        this.draggingHandle = null;
        this.activeMesh = null;
        this.activeParams = null;
        this.activeType = null;
        this.onUpdate = null;

        const geoCube = new THREE.BoxGeometry(0.2, 0.2, 0.2);
        const geoSphere = new THREE.SphereGeometry(0.12, 16, 16);
        const geoOcta = new THREE.OctahedronGeometry(0.15);

        const mkMat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 });
        const mX = mkMat(0xff3333), mY = mkMat(0x33ff33), mZ = mkMat(0x3333ff), mRad = mkMat(0xffff33), mSeg = mkMat(0xff33ff), mCy = mkMat(0x33ffff), mOr = mkMat(0xffaa33);

        this.configs = {
            box: [
                { p: 'width', g: geoCube, m: mX, pos: p=>[p.width/2+0.2, 0, 0], dimAxis: 'x', s: 1, t: 'dim' },
                { p: 'width', g: geoCube, m: mX, pos: p=>[-p.width/2-0.2, 0, 0], dimAxis: 'x', s: -1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, p.height/2+0.2, 0], dimAxis: 'y', s: 1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, -p.height/2-0.2, 0], dimAxis: 'y', s: -1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, p.depth/2+0.2], dimAxis: 'z', s: 1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, -p.depth/2-0.2], dimAxis: 'z', s: -1, t: 'dim' },
                { p: 'radius', g: geoSphere, m: mRad, pos: p=>[p.width/2, p.height/2, p.depth/2], ax: [1,1,1], s: 1, t: 'rad' },
                { p: 'cornerSegments', g: geoOcta, m: mSeg, pos: p=>[p.width/2+0.4, p.height/2+0.4, p.depth/2+0.4], ax: [1,1,1], s: 1, t: 'seg' }
            ],
            cyl: [
                { p: 'width', g: geoCube, m: mX, pos: p=>[p.width/2+0.2, 0, 0], dimAxis: 'x', s: 1, t: 'dim' },
                { p: 'width', g: geoCube, m: mX, pos: p=>[-p.width/2-0.2, 0, 0], dimAxis: 'x', s: -1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, p.height/2+0.2, 0], dimAxis: 'y', s: 1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, -p.height/2-0.2, 0], dimAxis: 'y', s: -1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, p.depth/2+0.2], dimAxis: 'z', s: 1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, -p.depth/2-0.2], dimAxis: 'z', s: -1, t: 'dim' },
                { p: 'radius', g: geoSphere, m: mRad, pos: p=>[p.width/2, p.height/2, 0], ax: [1,1,0], s: 1, t: 'rad' },
                { p: 'radialSegments', g: geoOcta, m: mCy, pos: p=>[p.width/2+0.6, 0, 0], ax: [1,0,0], s: 1, t: 'seg' },
                { p: 'cornerSegments', g: geoOcta, m: mSeg, pos: p=>[p.width/2+0.3, p.height/2+0.3, 0], ax: [1,1,0], s: 1, t: 'seg' }
            ],
            cone: [
                { p: 'width', g: geoCube, m: mX, pos: p=>[p.width/2+0.2, -p.height/2, 0], dimAxis: 'x', s: 1, t: 'dim' },
                { p: 'width', g: geoCube, m: mX, pos: p=>[-p.width/2-0.2, -p.height/2, 0], dimAxis: 'x', s: -1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, p.height/2+0.2, 0], dimAxis: 'y', s: 1, t: 'dim' },
                { p: 'height', g: geoCube, m: mY, pos: p=>[0, -p.height/2-0.2, 0], dimAxis: 'y', s: -1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, p.depth/2+0.2], dimAxis: 'z', s: 1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, -p.depth/2-0.2], dimAxis: 'z', s: -1, t: 'dim' },
                { p: 'radius', g: geoSphere, m: mRad, pos: p=>[p.width/2, -p.height/2, 0], ax: [1,-1,0], s: 1, t: 'rad' },
                { p: 'radialSegments', g: geoOcta, m: mCy, pos: p=>[p.width/2+0.6, -p.height/2, 0], ax: [1,0,0], s: 1, t: 'seg' },
                { p: 'cornerSegments', g: geoOcta, m: mSeg, pos: p=>[0, p.height/2+0.5, 0], ax: [0,1,0], s: 1, t: 'seg' }
            ],
            sphere: [
                { p: 'width', g: geoCube, m: mX, pos: p=>[p.width/2+0.2, 0, 0], dimAxis: 'x', s: 1, t: 'dim' },
                { p: 'width', g: geoCube, m: mX, pos: p=>[-p.width/2-0.2, 0, 0], dimAxis: 'x', s: -1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, p.depth/2+0.2], dimAxis: 'z', s: 1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, -p.depth/2-0.2], dimAxis: 'z', s: -1, t: 'dim' },
                { p: 'radialSegments', g: geoOcta, m: mCy, pos: p=>[p.width/2+0.6, 0, 0], ax: [1,0,0], s: 1, t: 'seg' },
                { p: 'cornerSegments', g: geoOcta, m: mSeg, pos: p=>[0, p.width/2+0.5, 0], ax: [0,1,0], s: 1, t: 'seg' }
            ],
            torus: [
                { p: 'width', g: geoCube, m: mX, pos: p=>[p.width/2+p.torusTube+0.2, 0, 0], dimAxis: 'x', s: 1, t: 'dim' },
                { p: 'width', g: geoCube, m: mX, pos: p=>[-p.width/2-p.torusTube-0.2, 0, 0], dimAxis: 'x', s: -1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, p.depth/2+0.2], dimAxis: 'z', s: 1, t: 'dim' },
                { p: 'depth', g: geoCube, m: mZ, pos: p=>[0, 0, -p.depth/2-0.2], dimAxis: 'z', s: -1, t: 'dim' },
                { p: 'torusTube', g: geoSphere, m: mOr, pos: p=>[p.width/2, p.torusTube+0.2, 0], ax: [0,1,0], s: 1, t: 'rad' },
                { p: 'radialSegments', g: geoOcta, m: mCy, pos: p=>[p.width/2+p.torusTube+0.6, 0, 0], ax: [1,0,0], s: 1, t: 'seg' },
                { p: 'cornerSegments', g: geoOcta, m: mSeg, pos: p=>[p.width/2, p.torusTube+0.5, 0], ax: [0,1,0], s: 1, t: 'seg' }
            ]
        };
    }
    attach(mesh, params, type) {
        this.activeMesh = mesh;
        this.activeParams = params;
        this.activeType = type;
        this.group.visible = true;
        this.update();
    }
    detach() {
        this.activeMesh = null;
        this.group.visible = false;
        this.group.clear();
    }
    update() {
        if (!this.activeMesh || !this.activeType) return;
        const p = this.activeParams;
        const targetMesh = this.activeMesh;

        if (this.group.children.length === 0 || this.group.children[0].userData.type !== this.activeType) {
            this.group.clear();
            const conf = this.configs[this.activeType];
            if (conf) {
                conf.forEach((c) => {
                    const mesh = new THREE.Mesh(c.g, c.m);
                    mesh.userData = { ...c, type: this.activeType };
                    this.group.add(mesh);
                });
            }
        }
        this.group.children.forEach((mesh) => {
            const c = mesh.userData;
            const localPos = c.pos(p);
            let localVec = new THREE.Vector3(...localPos);
            if (targetMesh.userData.offset) localVec.add(targetMesh.userData.offset);
            let worldPos = localVec.applyMatrix4(targetMesh.matrixWorld);
            mesh.position.copy(worldPos);
            mesh.quaternion.copy(targetMesh.quaternion);
        });
    }
    pointerDown(e, raycaster, camera) {
        if (!this.activeMesh || !this.group.visible) return false;
        const handleHits = raycaster.intersectObjects(this.group.children);
        if (handleHits.length > 0) {
            this.draggingHandle = handleHits[0].object;
            const def = this.draggingHandle.userData;
            const wp = new THREE.Vector3();
            this.draggingHandle.getWorldPosition(wp);

            const normal = new THREE.Vector3().copy(camera.position).sub(wp).normalize();
            this.dragPlane.setFromNormalAndCoplanarPoint(normal, wp);

            const intersect = new THREE.Vector3();
            raycaster.ray.intersectPlane(this.dragPlane, intersect);

            this.draggingHandle.userData.startIntersection = intersect.clone();
            this.draggingHandle.userData.startValue = this.activeParams[def.p];
            this.draggingHandle.userData.startPos = this.activeMesh.position.clone();
            this.draggingHandle.userData.startLocalPos = new THREE.Vector3(...def.pos(this.activeParams));
            return true;
        }
        return false;
    }
    pointerMove(e, raycaster) {
        if (!this.draggingHandle || !this.activeMesh) return false;
        const intersectPoint = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(this.dragPlane, intersectPoint)) {
            const def = this.draggingHandle.userData;
            const worldToLocalMatrix = new THREE.Matrix4().copy(this.activeMesh.matrixWorld).invert();
            const localHit = intersectPoint.clone().applyMatrix4(worldToLocalMatrix);

            if (this.activeMesh.userData.offset) localHit.sub(this.activeMesh.userData.offset);

            let val, delta = 0, posOffset = null;

            if (def.t === 'dim') {
                const oppositeSide = -(def.startValue / 2) * def.s;
                val = (localHit[def.dimAxis] - oppositeSide) * def.s;
                if (val < 0.1) val = 0.1;
                delta = val - def.startValue;

                const dir = new THREE.Vector3(); dir[def.dimAxis] = def.s;
                const localMove = dir.clone().multiplyScalar(delta / 2);
                const worldMove = localMove.applyMatrix4(new THREE.Matrix4().extractRotation(this.activeMesh.matrixWorld));
                posOffset = this.draggingHandle.userData.startPos.clone().add(worldMove);
            } else {
                const hitDelta = localHit.clone().sub(def.startLocalPos);
                const axisVec = new THREE.Vector3(...def.ax).normalize();
                let factor = def.t === 'seg' ? 10 : 1;
                let change = hitDelta.dot(axisVec) * factor * def.s;
                val = def.startValue + change;

                if (def.t === 'seg') {
                    val = Math.round(val);
                    if (def.p === 'radialSegments') val = Math.max(3, val);
                    if (def.p === 'cornerSegments') val = Math.max(0, val);
                } else {
                    val = Math.max(0.01, val);
                }
            }
            if (this.onUpdate) this.onUpdate(def.p, val, posOffset);
        }
        return true;
    }
    pointerUp() {
        if (this.draggingHandle) {
            this.draggingHandle = null;
            return true;
        }
        return false;
    }
}
