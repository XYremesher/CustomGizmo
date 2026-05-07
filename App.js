import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Gizmo from './Gizmo.js';

/**
 * Main App class for setting up Three.js scene and handling selection logic.
 */
export default class App {
    constructor() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f172a);
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(5, 5, 5);
        
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        document.body.appendChild(this.renderer.domElement);

        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.enableDamping = true;

        const grid = new THREE.GridHelper(20, 20, 0x334155, 0x1e293b);
        this.scene.add(grid);

        this.gizmo = new Gizmo(this.scene, this.camera, this.renderer, this.orbit);
        
        const geometry = new THREE.BoxGeometry(2, 2, 2);
        const material = new THREE.MeshNormalMaterial();
        this.box = new THREE.Mesh(geometry, material);
        
        // Set initial position to sit on the ground
        // Since height is 2, y=1 puts the bottom at y=0
        this.box.position.y = 1;
        
        this.box.userData.selectable = true;
        this.scene.add(this.box);
        
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this._setupSelection();

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    _setupSelection() {
        this.renderer.domElement.addEventListener('pointerdown', (e) => {
            this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);

            // Check if gizmo is being clicked first to prevent deselection while transforming
            if (this.gizmo.isGizmoHit(this.mouse)) return;

            const intersects = this.raycaster.intersectObjects(this.scene.children, true);
            const target = intersects.find(hit => hit.object.userData.selectable);

            if (target) {
                this.gizmo.attach(target.object);
            } else {
                this.gizmo.detach();
            }
        });
    }

    animate() {
        requestAnimationFrame(this.animate.bind(this));
        this.orbit.update();
        this.gizmo.update();
        this.renderer.render(this.scene, this.camera);
    }
}