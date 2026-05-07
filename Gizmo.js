import * as THREE from 'three';

/**
 * Gizmo class for 3D object transformation.
 */
export default class Gizmo {
    constructor(scene, camera, renderer, orbit) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.orbit = orbit;

        this.config = {
            handleOffset: 1.1,
            gizmoThickness: 0.4,
            axisLength: 1.8,
            centerCubeSize: 0.5,
            planeHandleSize: 0.6,
            gizmoScale: 1.2,
            space: 'world'
        };

        this.selectedObject = null;
        this.activeAxis = null;
        this.currentMode = 'translate';
        
        this.gizmoGroup = new THREE.Group();
        this.gizmoTranslate = new THREE.Group();
        this.gizmoRotate = new THREE.Group();
        this.gizmoScale = new THREE.Group();
        
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.startMouse = new THREE.Vector2();
        
        this.dragPlane = new THREE.Plane();
        this.dragOffset = new THREE.Vector3();
        this.startPos = new THREE.Vector3();
        this.startHit = new THREE.Vector3();
        this.startQuat = new THREE.Quaternion();
        this.startScaleVec = new THREE.Vector3();
        
        this.screenRotateRing = null;
        this._init();
    }

    _init() {
        this.gizmoGroup.visible = false;
        this.gizmoGroup.add(this.gizmoTranslate, this.gizmoRotate, this.gizmoScale);
        this.scene.add(this.gizmoGroup);
        this.createGizmoMeshes();
        
        this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown.bind(this));
        window.addEventListener('pointermove', this.onPointerMove.bind(this));
        window.addEventListener('pointerup', this.onPointerUp.bind(this));
    }

    /**
     * Check if the gizmo handles are being clicked.
     */
    isGizmoHit(mouseCoords) {
        if (!this.selectedObject) return false;
        this.raycaster.setFromCamera(mouseCoords, this.camera);
        const group = this.currentMode === 'translate' ? this.gizmoTranslate : (this.currentMode === 'scale' ? this.gizmoScale : this.gizmoRotate);
        const hits = this.raycaster.intersectObject(group, true);
        return hits.length > 0;
    }

    _getWhitenedColor(hex, amount = 0.5) {
        const c = new THREE.Color(hex);
        return c.lerp(new THREE.Color(0xffffff), amount).getHex();
    }

    createGizmoMeshes() {
        this.gizmoTranslate.clear();
        this.gizmoRotate.clear();
        this.gizmoScale.clear();

        const getMat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ 
            color, depthTest: false, transparent: true, opacity, side: THREE.DoubleSide 
        });

        const addAxis = (group, color, euler, axis, type) => {
            const sub = new THREE.Group();
            sub.userData = { axis, color };
            const mat = getMat(color);
            const line = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * this.config.gizmoThickness, 0.05 * this.config.gizmoThickness, this.config.axisLength), mat);
            line.position.y = this.config.axisLength / 2; line.renderOrder = 999;
            
            let head;
            if (type === 'translate') {
                head = new THREE.Mesh(new THREE.ConeGeometry(0.2 * this.config.gizmoThickness, 0.6), mat);
            } else {
                head = new THREE.Mesh(new THREE.BoxGeometry(0.35 * this.config.gizmoThickness, 0.35 * this.config.gizmoThickness, 0.35 * this.config.gizmoThickness), mat);
            }
            head.position.y = this.config.axisLength + 0.15; head.renderOrder = 999;
            
            const hbLen = this.config.axisLength + 0.2;
            const hitbox = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, hbLen), getMat(0, 0));
            hitbox.position.y = hbLen / 2 + 0.6; hitbox.userData.isHitbox = true;
            
            sub.add(line, head, hitbox); sub.rotation.copy(euler); group.add(sub);
        };

        const addPlane = (group, color, euler, axis) => {
            const sub = new THREE.Group();
            sub.userData = { axis, color };
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.config.planeHandleSize, this.config.planeHandleSize), getMat(color, 0.3));
            mesh.renderOrder = 999;
            const hitbox = new THREE.Mesh(new THREE.PlaneGeometry(this.config.planeHandleSize + 0.2, this.config.planeHandleSize + 0.2), getMat(0, 0));
            hitbox.userData.isHitbox = true;
            sub.add(mesh, hitbox); sub.rotation.copy(euler); group.add(sub);
        };

        addAxis(this.gizmoTranslate, 0xff3333, new THREE.Euler(0, 0, -Math.PI/2), 'X', 'translate');
        addAxis(this.gizmoTranslate, 0x33ff33, new THREE.Euler(0, 0, 0), 'Y', 'translate');
        addAxis(this.gizmoTranslate, 0x3333ff, new THREE.Euler(Math.PI/2, 0, 0), 'Z', 'translate');
        addPlane(this.gizmoTranslate, 0xffff00, new THREE.Euler(0, 0, 0), 'XY');
        addPlane(this.gizmoTranslate, 0x00ffff, new THREE.Euler(0, Math.PI/2, 0), 'YZ');
        addPlane(this.gizmoTranslate, 0xff00ff, new THREE.Euler(Math.PI/2, 0, 0), 'XZ');
        
        const screenT = new THREE.Group();
        screenT.userData = { axis: 'SCREEN', color: 0xffff00 };
        screenT.add(new THREE.Mesh(new THREE.BoxGeometry(this.config.centerCubeSize, this.config.centerCubeSize, this.config.centerCubeSize), getMat(0xffff00, 0.2)));
        screenT.children[0].renderOrder = 1000;
        const sTHit = new THREE.Mesh(new THREE.BoxGeometry(this.config.centerCubeSize + 0.5, this.config.centerCubeSize + 0.5, this.config.centerCubeSize + 0.5), getMat(0, 0));
        sTHit.userData.isHitbox = true; screenT.add(sTHit); this.gizmoTranslate.add(screenT);

        const addRing = (group, color, euler, axis) => {
            const sub = new THREE.Group();
            sub.userData = { axis, color };
            const radius = this.config.axisLength * 0.9;
            const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.05 * this.config.gizmoThickness, 16, 64), getMat(color));
            ring.renderOrder = 999;
            const hitbox = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.35, 8, 32), getMat(0, 0));
            hitbox.userData.isHitbox = true;
            sub.add(ring, hitbox); sub.rotation.copy(euler); group.add(sub);
        };
        addRing(this.gizmoRotate, 0xff3333, new THREE.Euler(0, Math.PI/2, 0), 'X');
        addRing(this.gizmoRotate, 0x33ff33, new THREE.Euler(Math.PI/2, 0, 0), 'Y');
        addRing(this.gizmoRotate, 0x3333ff, new THREE.Euler(0, 0, 0), 'Z');
        
        const screenR = new THREE.Group();
        screenR.userData = { axis: 'SCREEN', color: 0xffff00 };
        screenR.add(new THREE.Mesh(new THREE.TorusGeometry(this.config.axisLength * 1.15, 0.05 * this.config.gizmoThickness, 16, 64), getMat(0xffff00, 0.5)));
        screenR.children[0].renderOrder = 999;
        const ringSHit = new THREE.Mesh(new THREE.TorusGeometry(this.config.axisLength * 1.15, 0.4, 8, 32), getMat(0, 0));
        ringSHit.userData.isHitbox = true; screenR.add(ringSHit); this.gizmoRotate.add(screenR);
        this.screenRotateRing = screenR;

        addAxis(this.gizmoScale, 0xff3333, new THREE.Euler(0, 0, -Math.PI/2), 'X', 'scale');
        addAxis(this.gizmoScale, 0x33ff33, new THREE.Euler(0, 0, 0), 'Y', 'scale');
        addAxis(this.gizmoScale, 0x3333ff, new THREE.Euler(Math.PI/2, 0, 0), 'Z', 'scale');
        addPlane(this.gizmoScale, 0xffff00, new THREE.Euler(0, 0, 0), 'XY');
        addPlane(this.gizmoScale, 0x00ffff, new THREE.Euler(0, Math.PI/2, 0), 'YZ');
        addPlane(this.gizmoScale, 0xff00ff, new THREE.Euler(Math.PI/2, 0, 0), 'XZ');
        
        const screenS = new THREE.Group();
        screenS.userData = { axis: 'XYZ', color: 0xffff00 };
        screenS.add(new THREE.Mesh(new THREE.BoxGeometry(this.config.centerCubeSize, this.config.centerCubeSize, this.config.centerCubeSize), getMat(0xffff00, 0.2)));
        screenS.children[0].renderOrder = 1000;
        const sSHit = new THREE.Mesh(new THREE.BoxGeometry(this.config.centerCubeSize + 0.5, this.config.centerCubeSize + 0.5, this.config.centerCubeSize + 0.5), getMat(0, 0));
        sSHit.userData.isHitbox = true; screenS.add(sSHit); this.gizmoScale.add(screenS);

        this.updateMode(this.currentMode);
    }

    updateMode(mode) {
        this.currentMode = mode;
        this.gizmoTranslate.visible = mode === 'translate';
        this.gizmoRotate.visible = mode === 'rotate';
        this.gizmoScale.visible = mode === 'scale';
    }

    attach(obj) {
        this.selectedObject = obj;
        this.gizmoGroup.visible = !!obj;
        this.updateMatrix();
    }

    detach() { this.selectedObject = null; this.gizmoGroup.visible = false; }

    setSpace(s) { this.config.space = s; this.updateMatrix(); }

    updateMatrix() {
        if (!this.selectedObject) return;
        this.gizmoGroup.position.copy(this.selectedObject.position);
        if (this.config.space === 'local') this.gizmoGroup.quaternion.copy(this.selectedObject.quaternion);
        else this.gizmoGroup.quaternion.set(0,0,0,1);
    }

    onPointerDown(e) {
        this._updateMouse(e);
        this.startMouse.copy(this.mouse);
        this.raycaster.setFromCamera(this.mouse, this.camera);
        if (this.selectedObject) {
            const group = this.currentMode === 'translate' ? this.gizmoTranslate : (this.currentMode === 'scale' ? this.gizmoScale : this.gizmoRotate);
            const hits = this.raycaster.intersectObject(group, true);
            if (hits.length > 0) {
                let obj = hits[0].object;
                while (!obj.userData.axis && obj.parent) obj = obj.parent;
                this.activeAxis = obj.userData.axis;
                this.orbit.enabled = false;
                
                this.startPos.copy(this.selectedObject.position);
                
                const camDir = this.camera.getWorldDirection(new THREE.Vector3());
                let n = new THREE.Vector3();
                if (this.activeAxis === 'SCREEN' || this.activeAxis === 'XYZ') n.copy(camDir).negate();
                else if (this.currentMode === 'rotate') {
                    n.set(1,0,0); if (this.activeAxis === 'Y') n.set(0,1,0); if (this.activeAxis === 'Z') n.set(0,0,1);
                    if (this.config.space === 'local') n.applyQuaternion(this.selectedObject.quaternion);
                } else {
                    if (this.activeAxis.length === 1) {
                        if (this.activeAxis === 'X') n.set(0, Math.abs(camDir.y) > Math.abs(camDir.z) ? 1 : 0, Math.abs(camDir.z) >= Math.abs(camDir.y) ? 1 : 0);
                        else if (this.activeAxis === 'Y') n.set(Math.abs(camDir.x) > Math.abs(camDir.z) ? 1 : 0, 0, Math.abs(camDir.z) >= Math.abs(camDir.x) ? 1 : 0);
                        else if (this.activeAxis === 'Z') n.set(Math.abs(camDir.x) > Math.abs(camDir.y) ? 1 : 0, Math.abs(camDir.y) >= Math.abs(camDir.x) ? 1 : 0, 0);
                    } else {
                        n.set(0,0,1); if (this.activeAxis === 'YZ') n.set(1,0,0); else if (this.activeAxis === 'XZ') n.set(0,1,0);
                    }
                    if (this.config.space === 'local') n.applyQuaternion(this.selectedObject.quaternion);
                }
                this.dragPlane.setFromNormalAndCoplanarPoint(n, this.selectedObject.position);
                this.raycaster.ray.intersectPlane(this.dragPlane, this.startHit);
                this.dragOffset.copy(this.selectedObject.position).sub(this.startHit);
                this.startQuat.copy(this.selectedObject.quaternion);
                this.startScaleVec.copy(this.selectedObject.scale);
                return;
            }
        }
    }

    onPointerMove(e) {
        this._updateMouse(e);
        if (!this.activeAxis || !this.selectedObject) { this._hover(); return; }
        
        this.raycaster.setFromCamera(this.mouse, this.camera);
        let cur = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.dragPlane, cur)) {
            if (this.currentMode === 'translate') {
                if (this.activeAxis === 'SCREEN') this.selectedObject.position.copy(cur.clone().add(this.dragOffset));
                else {
                    const d = cur.clone().sub(this.startHit);
                    if (this.activeAxis.length === 1) {
                        let v = new THREE.Vector3(1,0,0); 
                        if (this.activeAxis === 'Y') v.set(0,1,0); 
                        else if (this.activeAxis === 'Z') v.set(0,0,1);
                        if (this.config.space === 'local') v.applyQuaternion(this.startQuat);
                        const proj = d.dot(v);
                        this.selectedObject.position.copy(this.startPos).add(v.multiplyScalar(proj));
                    } else {
                        this.selectedObject.position.copy(this.startPos).add(d);
                    }
                }
            } else if (this.currentMode === 'scale') {
                if (this.activeAxis === 'XYZ') {
                    const f = 1 + (this.mouse.y - this.startMouse.y) * 2;
                    this.selectedObject.scale.copy(this.startScaleVec).multiplyScalar(Math.max(0.1, f));
                } else {
                    const sD = this.startHit.distanceTo(this.startPos);
                    const cD = cur.distanceTo(this.startPos);
                    if (sD > 0.01) {
                        const f = cD / sD;
                        if (this.activeAxis.length === 1) {
                            if (this.activeAxis === 'X') this.selectedObject.scale.x = this.startScaleVec.x * f;
                            if (this.activeAxis === 'Y') this.selectedObject.scale.y = this.startScaleVec.y * f;
                            if (this.activeAxis === 'Z') this.selectedObject.scale.z = this.startScaleVec.z * f;
                        } else {
                            if (this.activeAxis.includes('X')) this.selectedObject.scale.x = this.startScaleVec.x * f;
                            if (this.activeAxis.includes('Y')) this.selectedObject.scale.y = this.startScaleVec.y * f;
                            if (this.activeAxis.includes('Z')) this.selectedObject.scale.z = this.startScaleVec.z * f;
                        }
                    }
                }
            } else if (this.currentMode === 'rotate') {
                const v1 = this.startHit.clone().sub(this.startPos).normalize();
                const v2 = cur.clone().sub(this.startPos).normalize();
                let a = Math.acos(THREE.MathUtils.clamp(v1.dot(v2), -1, 1));
                if (new THREE.Vector3().crossVectors(v1, v2).dot(this.dragPlane.normal) < 0) a = -a;
                this.selectedObject.quaternion.copy(this.startQuat).premultiply(new THREE.Quaternion().setFromAxisAngle(this.dragPlane.normal, a));
                if (this.config.space === 'local') this.gizmoGroup.quaternion.copy(this.selectedObject.quaternion);
            }
            this.gizmoGroup.position.copy(this.selectedObject.position);
        }
    }

    onPointerUp() { 
        this.activeAxis = null; 
        this.orbit.enabled = true; 
        this._resetColors();
    }

    _resetColors() {
        [this.gizmoTranslate, this.gizmoRotate, this.gizmoScale].forEach(g => {
            g.children.forEach(c => c.children.forEach(m => { if(!m.userData.isHitbox) m.material.color.setHex(c.userData.color); }));
        });
    }

    _hover() {
        this.raycaster.setFromCamera(this.mouse, this.camera);
        const g = this.currentMode === 'translate' ? this.gizmoTranslate : (this.currentMode === 'scale' ? this.gizmoScale : this.gizmoRotate);
        g.children.forEach(c => c.children.forEach(m => { if(!m.userData.isHitbox) m.material.color.setHex(c.userData.color); }));
        const hits = this.raycaster.intersectObject(g, true);
        if (hits.length > 0) {
            let o = hits[0].object; while (!o.userData.axis && o.parent) o = o.parent;
            o.children.forEach(m => { if(!m.userData.isHitbox) m.material.color.setHex(this._getWhitenedColor(o.userData.color, 0.7)); });
            document.body.style.cursor = 'pointer';
        } else document.body.style.cursor = 'default';
    }

    _updateMouse(e) { 
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1; 
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1; 
    }

    update() {
        if (!this.selectedObject || this.activeAxis) { if(this.screenRotateRing) this.screenRotateRing.quaternion.copy(this.camera.quaternion); return; }
        const dist = this.camera.position.distanceTo(this.gizmoGroup.position);
        const s = Math.max(dist / 14, 0.4) * this.config.gizmoScale;
        this.gizmoGroup.scale.set(s, s, s);
        const dir = this.camera.position.clone().sub(this.gizmoGroup.position);
        const px = dir.x > 0 ? 1 : -1, py = dir.y > 0 ? 1 : -1, pz = dir.z > 0 ? 1 : -1;
        [this.gizmoTranslate, this.gizmoScale].forEach(g => {
            g.children[0].rotation.z = dir.x < 0 ? Math.PI/2 : -Math.PI/2;
            g.children[1].rotation.x = dir.y < 0 ? Math.PI : 0;
            g.children[2].rotation.x = dir.z < 0 ? -Math.PI/2 : Math.PI/2;
            if (g.children.length > 3 && g.children[3].userData.axis.length > 1) {
                g.children[3].position.set(this.config.handleOffset * px, this.config.handleOffset * py, 0);
                g.children[4].position.set(0, this.config.handleOffset * py, this.config.handleOffset * pz);
                g.children[5].position.set(this.config.handleOffset * px, 0, this.config.handleOffset * pz);
            }
        });
        if (this.screenRotateRing) this.screenRotateRing.quaternion.copy(this.camera.quaternion);
    }
}