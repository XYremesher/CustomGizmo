import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export function startGame(CharacterClass) {
    window.isCarryingObj = false;
    window.isCarryStarting = false;
    window.isCarryDropping = false;
    window.throwTimer = 0;

    const uiPanel = document.getElementById('ui');
    const dockBtn = document.getElementById('dock-btn');
    dockBtn.addEventListener('pointerdown', () => {
        uiPanel.classList.toggle('collapsed');
        dockBtn.innerText = uiPanel.classList.contains('collapsed') ? '▶' : '◀';
    });

    document.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('pointerdown', () => {
            header.parentElement.classList.toggle('active');
        });
    });

    const threeTone = new THREE.DataTexture(new Uint8Array([0, 128, 255]), 3, 1, THREE.RedFormat);
    threeTone.needsUpdate = true;
    threeTone.minFilter = THREE.NearestFilter;
    threeTone.magFilter = THREE.NearestFilter;

    const projectiles = [];
    const shooters = [];
    const carryables = [];
    const debugHelpers = [];
    const activeShards = [];

    const _tempVec1 = new THREE.Vector3();
    const _tempVec2 = new THREE.Vector3();
    const _tempVec3 = new THREE.Vector3();
    const _tempVec2D = new THREE.Vector2();
    const _tempVec2D2 = new THREE.Vector2();
    const _tempQuat = new THREE.Quaternion();
    const _downVec = new THREE.Vector3(0, -1, 0);
    const _upVec = new THREE.Vector3(0, 1, 0);
    const _cubeSizeVec = new THREE.Vector3(3.0, 3.0, 3.0);
    const _carrySizeVec = new THREE.Vector3(1.0, 1.0, 1.0);

    const shinyJarMat = new THREE.MeshStandardMaterial({
        color: 0xba5c3c,
        roughness: 0.15,
        metalness: 0.1,
        gradientMap: threeTone,
        transparent: true,
        opacity: 1.0
    });

    class ShooterBox {
        constructor(parent, x, y, z, intensity = 'high') {
            this.intensity = intensity;
            let color = 0xff2222;
            if (intensity === 'low') color = 0x22ff22;
            else if (intensity === 'medium') color = 0xffff22;
            else if (intensity === 'medium_high') color = 0xff7700;
            
            this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: color }));
            this.mesh.position.set(x, y, z);
            this.mesh.castShadow = true;
            parent.add(this.mesh);
            this.timer = 0;
            this.fireInterval = 3.0;
        }

        update(delta, targetPosition, scene) {
            this.timer += delta;
            if (this.timer >= this.fireInterval) {
                this.timer = 0;
                this.fire(targetPosition, scene);
            }
        }

        fire(targetPosition, scene) {
            let color = 0xff5555;
            if (this.intensity === 'low') color = 0x55ff55;
            else if (this.intensity === 'medium') color = 0xffff55;
            else if (this.intensity === 'medium_high') color = 0xffaa44;

            const pMesh = new THREE.Mesh(new THREE.SphereGeometry(projSize), new THREE.MeshBasicMaterial({ color: color }));
            pMesh.position.copy(this.mesh.position);
            scene.add(pMesh);

            const direction = _tempVec1.set(-1, 0, 0);
            const velocity = direction.multiplyScalar(projSpeed).clone();
            projectiles.push({ 
                mesh: pMesh, 
                velocity: velocity, 
                lifespan: 5.0, 
                sender: this, 
                intensity: this.intensity,
                radius: projSize
            });
        }
    }

    const canvas = document.getElementById('gameCanvas');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 10, 150);
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0.1, 40, 0.1); 
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048; dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5; dirLight.shadow.camera.far = 150;
    dirLight.shadow.camera.left = -40; dirLight.shadow.camera.right = 40;
    dirLight.shadow.camera.top = 40; dirLight.shadow.camera.bottom = -40;
    dirLight.shadow.bias = -0.0001; dirLight.shadow.normalBias = 0.05;
    scene.add(dirLight); scene.add(dirLight.target);

    const collidables = [];
    const levelGroup = new THREE.Group();
    scene.add(levelGroup);

    const texLoader = new THREE.TextureLoader();
    const groundTex = texLoader.load('https://media.istockphoto.com/id/865924416/de/vektor/cartoon-rasen.jpg?s=612x612&w=0&k=20&c=RPfx_iiW2SZsn_MinDtdgzJyeCKDbONn8Gn-8CSdg0s=');
    groundTex.wrapS = THREE.RepeatWrapping; groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(150, 150);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshToonMaterial({ map: groundTex, gradientMap: threeTone }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground); 
    
    window.ground = ground;

    const cubeSize = 3.0;
    const platMat = new THREE.MeshToonMaterial({ color: 0x5555aa, gradientMap: threeTone });
    const boxGeoTemplate = new RoundedBoxGeometry(cubeSize, cubeSize, cubeSize, 1, 0.15);

    const star = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), new THREE.MeshToonMaterial({ color: 0xffff00, emissive: 0xaa8800, gradientMap: threeTone }));
    star.visible = false;
    scene.add(star);
    
    const char = new CharacterClass(scene, threeTone);
    let currentLevel = "local_stairs";

    let jarTemplate = null;
    let brokenJarTemplate = null;
    const fbxLoader = new FBXLoader();

    fbxLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Interactables/Jar.fbx', (object) => {
        let originalMesh = null;
        object.traverse((child) => {
            if (child.isMesh && !originalMesh) originalMesh = child;
        });
        
        if (originalMesh) {
            const geom = originalMesh.geometry.clone();
            geom.rotateX(-Math.PI / 2);
            geom.computeBoundingBox();
            
            const center = new THREE.Vector3();
            geom.boundingBox.getCenter(center);
            geom.translate(-center.x, -center.y, -center.z);
            
            const size = new THREE.Vector3();
            geom.boundingBox.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            
            if (maxDim > 0) geom.scale(1.0 / maxDim, 1.0 / maxDim, 1.0 / maxDim);
            
            const mesh = new THREE.Mesh(geom, shinyJarMat);
            mesh.castShadow = true; mesh.receiveShadow = true;
            jarTemplate = mesh;
            
            if (currentLevel === "local_stairs") buildLevel();
        }
    });

    fbxLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Interactables/Jar_Broken.fbx', (object) => {
        object.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.material = shinyJarMat;
            }
        });
        object.rotateX(-Math.PI / 2);
        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        const pivotGroup = new THREE.Group();
        pivotGroup.add(object);

        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) pivotGroup.scale.setScalar(1.0 / maxDim);
        brokenJarTemplate = pivotGroup;
    });

    function shatterJar(position, impactVelocity) {
        const shardCount = 14;

        if (brokenJarTemplate) {
            const brokenJar = brokenJarTemplate.clone();
            scene.add(brokenJar); 
            brokenJar.position.copy(position);
            brokenJar.updateMatrixWorld(true);

            const shardsToExtract = [];
            brokenJar.traverse((child) => {
                if (child.isMesh) shardsToExtract.push(child);
            });

            shardsToExtract.forEach((shard) => {
                const worldPos = new THREE.Vector3();
                const worldQuat = new THREE.Quaternion();
                const worldScale = new THREE.Vector3();
                
                shard.getWorldPosition(worldPos);
                shard.getWorldQuaternion(worldQuat);
                shard.getWorldScale(worldScale);

                scene.add(shard); 
                shard.position.copy(worldPos);
                shard.quaternion.copy(worldQuat);
                shard.scale.copy(worldScale);

                const randomScatter = new THREE.Vector3((Math.random() - 0.5) * 6.0, Math.random() * 4.0 + 3.5, (Math.random() - 0.5) * 6.0);
                if (impactVelocity) randomScatter.addScaledVector(impactVelocity, 0.45);

                const fadeMat = shinyJarMat.clone();
                shard.material = fadeMat;
                shard.userData = { velocity: randomScatter, lifespan: 4.0, material: fadeMat };
                activeShards.push(shard);
            });
            scene.remove(brokenJar); 
        } else {
            for (let i = 0; i < shardCount; i++) {
                const sizeVal = 0.12 + Math.random() * 0.16;
                const geom = new THREE.BoxGeometry(sizeVal, sizeVal, sizeVal);
                
                const posAttr = geom.attributes.position;
                for (let j = 0; j < posAttr.count; j++) {
                    posAttr.setX(j, posAttr.getX(j) + (Math.random() - 0.5) * 0.04);
                    posAttr.setY(j, posAttr.getY(j) + (Math.random() - 0.5) * 0.04);
                    posAttr.setZ(j, posAttr.getZ(j) + (Math.random() - 0.5) * 0.04);
                }
                geom.computeVertexNormals();

                const fadeMat = shinyJarMat.clone();
                const shardMesh = new THREE.Mesh(geom, fadeMat);
                shardMesh.castShadow = true; shardMesh.receiveShadow = true;
                shardMesh.position.copy(position).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3));
                shardMesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
                scene.add(shardMesh);

                const randomScatter = new THREE.Vector3((Math.random() - 0.5) * 5.0, Math.random() * 5.0 + 2.5, (Math.random() - 0.5) * 5.0);
                if (impactVelocity) randomScatter.addScaledVector(impactVelocity, 0.35);

                shardMesh.userData = { velocity: randomScatter, lifespan: 3.5 + Math.random() * 1.0, material: fadeMat };
                activeShards.push(shardMesh);
            }
        }
    }

    function destroyJarCarryable(jarMesh) {
        forceDropCarriedObject();
        const index = carryables.findIndex(c => c.mesh === jarMesh);
        if (index !== -1) carryables.splice(index, 1);
        const collIndex = collidables.indexOf(jarMesh);
        if (collIndex !== -1) collidables.splice(collIndex, 1);
        levelGroup.remove(jarMesh);
        scene.remove(jarMesh);
    }

    function addHemisphereDebugHelper(mesh) {
        const radius = mesh.geometry.parameters.radius || 6;
        const helperGeo = new THREE.SphereGeometry(radius, 16, 16);
        const helperMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.4 });
        const helperMesh = new THREE.Mesh(helperGeo, helperMat);
        helperMesh.position.copy(mesh.position);
        helperMesh.visible = document.getElementById('toggle-hitbox').checked;
        scene.add(helperMesh);
        mesh.userData.debugHelper = helperMesh;
        debugHelpers.push(helperMesh);
    }

    function exportLevelToJson() {
        const data = { metadata: { author: "Player", version: "1.0" }, voxels: [], entities: [] };
        collidables.forEach(c => {
            if(c !== ground && c.geometry && (c.geometry.type.toLowerCase().includes('box') || c.geometry.constructor.name.toLowerCase().includes('box')) && c !== buildPreview) {
                if (c.userData && c.userData.isCarryable) return;
                data.voxels.push([Math.round(c.position.x / cubeSize), Math.round((c.position.y - cubeSize/2) / cubeSize), Math.round(c.position.z / cubeSize)]);
            }
            if (c.geometry && c.geometry.type === 'SphereGeometry') data.entities.push({ type: 'hemisphere', pos: [c.position.x, c.position.y, c.position.z] });
        });
        data.entities.push({ type: 'star', pos: [star.position.x, star.position.y, star.position.z] });
        data.entities.push({ type: 'playerStart', pos: [char.group.position.x, char.group.position.y, char.group.position.z] });
        shooters.forEach(s => data.entities.push({ type: 'shooter', pos: [s.mesh.position.x, s.mesh.position.y, s.mesh.position.z] }));
        return JSON.stringify(data, null, 2);
    }

    function getObstacleBox(obj, targetBox3) {
        if (obj.userData && obj.userData.isMovable) {
            targetBox3.setFromCenterAndSize(obj.position, _cubeSizeVec);
            return targetBox3;
        }
        if (obj.userData && obj.userData.isCarryable) {
            targetBox3.setFromCenterAndSize(obj.position, _carrySizeVec);
            return targetBox3;
        }
        if (obj.userData && obj.userData.cachedBox3) {
            targetBox3.copy(obj.userData.cachedBox3);
            return targetBox3;
        }
        if (!obj.userData) obj.userData = {};
        obj.userData.cachedBox3 = new THREE.Box3().setFromObject(obj);
        targetBox3.copy(obj.userData.cachedBox3);
        return targetBox3;
    }
    window.getObstacleBox = getObstacleBox;

    function buildLevelFromJson(data) {
        while(levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0; collidables.push(ground);

        if(data.voxels) {
            data.voxels.forEach(v => {
                const mesh = new THREE.Mesh(boxGeoTemplate, platMat);
                mesh.position.set(v[0] * cubeSize, cubeSize/2 + v[1] * cubeSize, v[2] * cubeSize);
                mesh.castShadow = true; mesh.receiveShadow = true;
                levelGroup.add(mesh); collidables.push(mesh);
            });
        }
        if(data.entities) {
            data.entities.forEach(e => {
                if (e.type === 'star') { star.position.set(e.pos[0], e.pos[1], e.pos[2]); star.visible = true; }
                if (e.type === 'playerStart') { char.group.position.set(e.pos[0], e.pos[1], e.pos[2]); char.group.rotation.y = Math.PI; }
                if (e.type === 'shooter') {
                    const shooter = new ShooterBox(levelGroup, e.pos[0], e.pos[1], e.pos[2], 'high');
                    shooters.push(shooter); collidables.push(shooter.mesh);
                }
                if (e.type === 'hemisphere') {
                    const hemisphere = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: threeTone }));
                    hemisphere.position.set(e.pos[0], e.pos[1], e.pos[2]);
                    hemisphere.castShadow = true; hemisphere.receiveShadow = true;
                    levelGroup.add(hemisphere); collidables.push(hemisphere);
                    addHemisphereDebugHelper(hemisphere);
                }
            });
        }
    }

    const level2Json = {
      "metadata": { "author": "RoundCube Pro User", "version": "2.1" },
      "voxels": [
        [0, 1, 1], [1, 0, 1], [0, 0, 1], [0, 0, 2], [0, 0, 0], [0, 2, 1],
        [0, 0, -1], [0, 1, -1], [1, 0, -1], [1, 0, -2], [0, 0, -2], [0, 2, -1],
        [0, 3, -1], [0, 3, 1], [0, 3, 0], [2, 0, -1], [2, 0, 0], [2, 0, 1],
        [2, 1, 1], [3, 0, 0], [3, 1, 0], [2, 1, -1], [2, 2, -1], [3, 2, 0],
        [1, 2, 1], [3, 2, -1], [3, 3, -1],
        [0, 1, -3], [0, 2, -4], [0, 3, -5], [0, 4, -6], [0, 5, -7], [0, 6, -8], [0, 7, -9]
      ],
      "entities": [
        { "type": "playerStart", "pos": [0, 3.0, 6.0] },
        { "type": "star", "pos": [0.0, 24.0, -27.0] },
        { "type": "shooter", "pos": [12, 4, -10] },
        { "type": "hemisphere", "pos": [10, 0, -10] }
      ]
    };

    function addCarryableDebugHelper(c) {
        let helperGeo;
        if (c.mesh.geometry && c.mesh.geometry.type === 'SphereGeometry') helperGeo = new THREE.SphereGeometry(0.5, 8, 8);
        else if (c.mesh.geometry && c.mesh.geometry.type === 'CylinderGeometry') helperGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 8);
        else helperGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0);
        
        const helperMat = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.6 });
        const helperMesh = new THREE.Mesh(helperGeo, helperMat);
        helperMesh.visible = document.getElementById('toggle-hitbox').checked;
        scene.add(helperMesh);
        c.debugHelper = helperMesh;
    }

    function buildStairsLevel() {
        const hemisphere = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: threeTone }));
        hemisphere.position.set(10, 0, -10); hemisphere.castShadow = true; hemisphere.receiveShadow = true;
        levelGroup.add(hemisphere); collidables.push(hemisphere);
        addHemisphereDebugHelper(hemisphere);

        const startMesh = new THREE.Mesh(boxGeoTemplate, platMat);
        startMesh.position.set(0, cubeSize/2, 0); startMesh.castShadow = true; startMesh.receiveShadow = true;
        levelGroup.add(startMesh); collidables.push(startMesh);

        for (let i = 0; i < 6; i++) {
            const mesh = new THREE.Mesh(boxGeoTemplate, platMat);
            mesh.position.set(0, cubeSize/2 + i * cubeSize * 0.9, -10 - i * cubeSize);
            mesh.castShadow = true; mesh.receiveShadow = true;
            levelGroup.add(mesh); collidables.push(mesh);
        }

        const sLow = new ShooterBox(levelGroup, 25, 1.0, 4.5, 'low');
        shooters.push(sLow); collidables.push(sLow.mesh);
        const sMed = new ShooterBox(levelGroup, 25, 1.0, 1.5, 'medium');
        shooters.push(sMed); collidables.push(sMed.mesh);
        const sMedHigh = new ShooterBox(levelGroup, 25, 1.0, -1.5, 'medium_high');
        shooters.push(sMedHigh); collidables.push(sMedHigh.mesh);
        const sHigh = new ShooterBox(levelGroup, 25, 1.0, -4.5, 'high');
        shooters.push(sHigh); collidables.push(sHigh.mesh);

        const movableBoxGeo = new RoundedBoxGeometry(cubeSize, cubeSize, cubeSize, 1, 0.15);
        const movableBoxMat = new THREE.MeshToonMaterial({ color: 0xffaa00, gradientMap: threeTone });
        const mBox = new THREE.Mesh(movableBoxGeo, movableBoxMat);
        mBox.position.set(-10, cubeSize/2, 0);
        mBox.castShadow = true; mBox.receiveShadow = true;
        mBox.userData.isMovable = true;
        levelGroup.add(mBox); collidables.push(mBox);

        const checkerData = new Uint8Array([255,255,255,255, 0,0,0,255, 0,0,0,255, 255,255,255,255]);
        const checkerTex = new THREE.DataTexture(checkerData, 2, 2);
        checkerTex.colorSpace = THREE.SRGBColorSpace;
        checkerTex.magFilter = THREE.NearestFilter;
        checkerTex.minFilter = THREE.NearestFilter;
        checkerTex.wrapS = THREE.RepeatWrapping;
        checkerTex.wrapT = THREE.RepeatWrapping;
        checkerTex.needsUpdate = true;

        const smallMat = new THREE.MeshToonMaterial({ map: checkerTex, gradientMap: threeTone });

        const smallBoxGeo = new RoundedBoxGeometry(1.0, 1.0, 1.0, 1, 0.05);
        const smallBox = new THREE.Mesh(smallBoxGeo, smallMat);
        smallBox.position.set(-6, 0.5, 0);
        smallBox.castShadow = true; smallBox.receiveShadow = true;
        smallBox.userData.isCarryable = true;
        levelGroup.add(smallBox); collidables.push(smallBox);
        const carry1 = { mesh: smallBox, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false };
        carryables.push(carry1); addCarryableDebugHelper(carry1);

        const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 16);
        const cyl = new THREE.Mesh(cylGeo, smallMat);
        cyl.position.set(-4, 0.5, 0);
        cyl.castShadow = true; cyl.receiveShadow = true;
        cyl.userData.isCarryable = true;
        levelGroup.add(cyl); collidables.push(cyl);
        const carry2 = { mesh: cyl, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false };
        carryables.push(carry2); addCarryableDebugHelper(carry2);

        const sphGeo = new THREE.SphereGeometry(0.5, 16, 16);
        const sph = new THREE.Mesh(sphGeo, smallMat);
        sph.position.set(-2, 0.5, 0);
        sph.castShadow = true; sph.receiveShadow = true;
        sph.userData.isCarryable = true;
        levelGroup.add(sph); collidables.push(sph);
        const carry3 = { mesh: sph, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false };
        carryables.push(carry3); addCarryableDebugHelper(carry3);

        if (jarTemplate) {
            const startX = 3.0;
            const startZ = 1.0;
            const spacing = 1.2;
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    const jarMesh = jarTemplate.clone();
                    jarMesh.position.set(startX + r * spacing, 0.5, startZ + c * spacing); 
                    jarMesh.userData.isCarryable = true;
                    jarMesh.userData.isJar = true; 
                    levelGroup.add(jarMesh);
                    collidables.push(jarMesh);
                    const carryJar = { mesh: jarMesh, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false };
                    carryables.push(carryJar); addCarryableDebugHelper(carryJar);
                }
            }
        }

        star.position.set(0, (5 * cubeSize * 0.9) + cubeSize + 2, -10 - 5 * cubeSize); star.visible = true;
        char.group.position.set(0, cubeSize, 0); char.group.rotation.y = Math.PI;
    }

    async function buildLevel() {
        while(levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0; collidables.push(ground);

        if (currentLevel === "local_stairs") buildStairsLevel();
        else if (currentLevel === "local_json") buildLevelFromJson(level2Json);
        else {
            try {
                if (currentLevel.endsWith('.js')) {
                    const module = await import(currentLevel);
                    if (module.default) module.default(scene, levelGroup, collidables, THREE, cubeSize, platMat, boxGeoTemplate, star, char);
                } else if (currentLevel.endsWith('.json')) {
                    const res = await fetch(currentLevel);
                    buildLevelFromJson(await res.json());
                }
            } catch(e) { buildStairsLevel(); }
        }
    }

    async function populateLevelsAndLoad() {
        const select = document.getElementById('level-select');
        select.innerHTML = '<option value="local_stairs">Level 1 (Stairs)</option><option value="local_json">Level 2 (JSON)</option>';
        try {
            const res = await fetch('https://api.github.com/repos/XYremesher/CustomGizmo/contents/Levels');
            if (res.ok) {
                const files = await res.json();
                files.forEach(file => {
                    if (file.name.endsWith('.js') || file.name.endsWith('.json')) {
                        const opt = document.createElement('option');
                        opt.value = `https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Levels/${file.name}`;
                        opt.textContent = `Remote: ${file.name}`;
                        select.appendChild(opt);
                    }
                });
            }
        } catch (e) {}
        select.value = 'local_stairs'; currentLevel = select.value;
        buildLevel();
    }
    populateLevelsAndLoad();

    document.getElementById('btn-show-json').addEventListener('pointerdown', () => {
        document.getElementById('json-textarea').value = exportLevelToJson();
        document.getElementById('json-modal').style.display = 'block';
    });
    document.getElementById('btn-close-json').addEventListener('pointerdown', () => document.getElementById('json-modal').style.display = 'none');
    document.getElementById('btn-apply-json').addEventListener('pointerdown', () => {
        try { buildLevelFromJson(JSON.parse(document.getElementById('json-textarea').value)); document.getElementById('json-modal').style.display = 'none'; } catch (e) {}
    });
    document.getElementById('level-select').addEventListener('change', (e) => { currentLevel = e.target.value; buildLevel(); });

    const buildPreview = new THREE.Mesh(boxGeoTemplate, new THREE.MeshStandardMaterial({ color: 0x00ff00, transparent: true, opacity: 0.4 }));
    buildPreview.visible = false; scene.add(buildPreview);
    const gridHelper = new THREE.GridHelper(cubeSize*6, 6, 0xffffff, 0x888888);
    gridHelper.visible = false; scene.add(gridHelper);

    let isBuilding = false, canPlace = false, buildStartY = 0, buildHeightOffset = 0, buildActivePointerId = null;
    const buildBtn = document.getElementById('build-btn');
    buildBtn.addEventListener('pointerdown', (e) => {
        isBuilding = true; buildPreview.visible = true; gridHelper.visible = true;
        buildStartY = e.clientY; buildHeightOffset = 0; buildActivePointerId = e.pointerId; buildBtn.setPointerCapture(e.pointerId);
    });
    buildBtn.addEventListener('pointermove', (e) => { if (isBuilding && e.pointerId === buildActivePointerId) buildHeightOffset = Math.round((buildStartY - e.clientY) / 30) * cubeSize; });
    buildBtn.addEventListener('pointerup', (e) => {
        if (isBuilding && e.pointerId === buildActivePointerId) {
            buildBtn.releasePointerCapture(e.pointerId);
            if (canPlace) {
                const newCube = new THREE.Mesh(boxGeoTemplate, platMat.clone());
                newCube.position.copy(buildPreview.position); newCube.castShadow = true; newCube.receiveShadow = true;
                levelGroup.add(newCube); collidables.push(newCube);
            }
            isBuilding = false; buildPreview.visible = false; gridHelper.visible = false; buildHeightOffset = 0;
        }
    });

    let isHoldingMovable = false;
    let heldBox = null;
    const holdBtn = document.getElementById('hold-btn');
    
    holdBtn.addEventListener('pointerdown', () => {
        if (!isHoldingMovable) {
            _tempVec3.set(0,0,1).applyQuaternion(char.group.quaternion);
            rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.5), _tempVec3);
            const boxHits = rayFwd.intersectObjects(collidables.filter(c => c.userData && c.userData.isMovable));
            if (boxHits.length > 0 && boxHits[0].distance < 1.5) {
                isHoldingMovable = true;
                let target = boxHits[0].object;
                while(target && (!target.userData || !target.userData.isMovable) && target.parent) target = target.parent;
                heldBox = target;
                holdBtn.innerText = 'RELEASE';
                document.getElementById('base-left').classList.add('hold-mode');
                const n = heldBox.position.clone().sub(char.group.position).setY(0).normalize();
                
                const targetPos = _tempVec1.copy(heldBox.position).addScaledVector(n, -2.2);
                targetPos.y = char.group.position.y;
                char.group.position.copy(targetPos);
                char.group.lookAt(_tempVec1.copy(char.group.position).add(n));
            }
        } else {
            isHoldingMovable = false;
            heldBox = null;
            holdBtn.innerText = 'HOLD';
            document.getElementById('base-left').classList.remove('hold-mode');
        }
    });

    let heldCarryable = null;
    let carryStartElapsed = 0;
    const carryBtn = document.getElementById('carry-btn');
    const dropBtn = document.getElementById('drop-btn');
    const throwBtn = document.getElementById('throw-btn');

    const pickupStartPos = new THREE.Vector3();
    const pickupStartRot = new THREE.Quaternion();
    const pickupTargetRot = new THREE.Quaternion();

    const dropStartPos = new THREE.Vector3();
    const dropStartRot = new THREE.Quaternion();
    const dropTargetPos = new THREE.Vector3();
    const dropTargetRot = new THREE.Quaternion();

    const cubeSymmetries = [];
    {
        const localDirs = [
            new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)
        ];
        for (let f = 0; f < 6; f++) {
            const zAxis = localDirs[f];
            const xAxis = localDirs[(f + 2) % 6];
            const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
            for (let r = 0; r < 4; r++) {
                const angle = r * Math.PI / 2;
                const rotMat = new THREE.Matrix4().makeRotationAxis(zAxis, angle);
                const baseMat = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
                baseMat.multiply(rotMat);
                const q = new THREE.Quaternion().setFromRotationMatrix(baseMat);
                cubeSymmetries.push(q);
            }
        }
    }

    carryBtn.addEventListener('pointerdown', () => {
        if (!window.isCarryingObj && !window.isCarryStarting && !window.isCarryDropping && carryTargetObj) {
            window.isCarryStarting = true;
            carryStartElapsed = 0;
            heldCarryable = carryTargetObj;

            pickupStartPos.copy(heldCarryable.position);
            pickupStartRot.copy(heldCarryable.quaternion);

            pickupTargetRot.copy(char.group.quaternion);
            
            if (!heldCarryable.userData.isJar) {
                let maxDot = -1;
                cubeSymmetries.forEach(sym => {
                    const worldSym = char.group.quaternion.clone().multiply(sym);
                    const dot = Math.abs(worldSym.dot(pickupStartRot));
                    if (dot > maxDot) {
                        maxDot = dot;
                        pickupTargetRot.copy(worldSym);
                    }
                });
            }

            const cObj = carryables.find(c => c.mesh === heldCarryable);
            if (cObj) {
                cObj.isCarried = true;
                cObj.wasThrown = false;
                cObj.velocity.set(0, 0, 0);
            }
            carryBtn.style.display = 'none';
            char.playCarryStart();
        }
    });

    dropBtn.addEventListener('pointerdown', () => {
        if (window.isCarryingObj && heldCarryable) {
            window.isCarryDropping = true;
            carryStartElapsed = 0;

            dropStartPos.copy(heldCarryable.position);
            dropStartRot.copy(heldCarryable.quaternion);

            _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);
            dropTargetPos.copy(char.group.position).addScaledVector(_tempVec3, 1.2);

            _tempVec1.copy(dropTargetPos).setY(dropTargetPos.y + 3.0);
            rayDown.set(_tempVec1, _downVec);
            const dropHits = rayDown.intersectObjects(collidables.filter(c => c !== heldCarryable && c !== ground));
            let detectedFloorY = 0;
            if (dropHits.length > 0) detectedFloorY = dropHits[0].point.y;

            let objectHeightOffset = 0.5;
            if (heldCarryable.geometry) {
                if (heldCarryable.geometry.type === 'SphereGeometry') objectHeightOffset = 0.5;
                else if (heldCarryable.geometry.type === 'CylinderGeometry') objectHeightOffset = 0.5;
                else if (heldCarryable.geometry.type === 'RoundedBoxGeometry') objectHeightOffset = 0.5;
            }
            dropTargetPos.y = detectedFloorY + objectHeightOffset;
            dropTargetRot.copy(char.group.quaternion);

            window.isCarryingObj = false;
            dropBtn.style.display = 'none';
            throwBtn.style.display = 'none';
            char.playCarryDrop();
        }
    });

    throwBtn.addEventListener('pointerdown', () => {
        if (window.isCarryingObj && heldCarryable) {
            const cObj = carryables.find(c => c.mesh === heldCarryable);
            if (cObj) {
                cObj.isCarried = false;
                cObj.wasThrown = true;
                _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);
                
                const boxHalfHeight = 0.5;
                cObj.mesh.position.copy(char.group.position).addScaledVector(_tempVec3, 0.15).setY(char.group.position.y + carryHeight + boxHalfHeight);

                cObj.velocity.copy(_tempVec3).multiplyScalar(15.0 * window.throwSpeedMult).setY(8.0 * window.throwSpeedMult);
            }

            const throwAction = char.actions['throw'];
            const throwClip = char.originalClips['throw'];

            if (throwAction) {
                throwAction.reset();
                throwAction.time = throwTrimStart;
                throwAction.setEffectiveTimeScale(window.throwSpeedMult);
            }

            window.throwTimer = throwClip ? ((throwClip.duration - throwTrimStart) / window.throwSpeedMult) : 0.5;

            window.isCarryingObj = false;
            heldCarryable = null;
            dropBtn.style.display = 'none';
            throwBtn.style.display = 'none';
        }
    });

    function forceDropCarriedObject(velocity = null) {
        if (heldCarryable) {
            const cObj = carryables.find(c => c.mesh === heldCarryable);
            if (cObj) {
                cObj.isCarried = false;
                cObj.wasThrown = false;
                if (velocity) cObj.velocity.copy(velocity);
                else cObj.velocity.set(0, 0, 0);
            }
            window.isCarryingObj = false;
            window.isCarryStarting = false;
            window.isCarryDropping = false;
            heldCarryable = null;
            document.getElementById('drop-btn').style.display = 'none';
            document.getElementById('throw-btn').style.display = 'none';
            if (char) char.stopUpperAction(0.2);
        }
    }
    window.forceDropCarriedObject = forceDropCarriedObject;

    const input = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    const keys = { w: false, a: false, s: false, d: false };
    let cameraTheta = 0, cameraPhi = Math.PI/3, cameraRadius = 12, yVelocity = 0;

    function setupJoystick(baseId, stickId, inputRef) {
        const base = document.getElementById(baseId), stick = document.getElementById(stickId);
        let activePointer = null, maxR = 40;
        const update = (e) => {
            if (e.pointerId !== activePointer) return;
            const rect = base.getBoundingClientRect(), cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
            let dx = e.clientX - cx, dy = e.clientY - cy, dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
            stick.style.transform = `translate(${dx}px, ${dy}px)`; inputRef.x = dx/maxR; inputRef.y = dy/maxR;
        };
        const onPointerMove = (e) => { if (e.pointerId === activePointer) update(e); };
        const onPointerUp = (e) => {
            if (e.pointerId !== activePointer) return;
            activePointer = null; stick.style.transform = `translate(0,0)`; inputRef.x = 0; inputRef.y = 0;
            window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', onPointerUp);
        };
        base.addEventListener('pointerdown', (e) => {
            if (activePointer !== null) return;
            activePointer = e.pointerId; update(e);
            window.addEventListener('pointermove', onPointerMove); window.addEventListener('pointerup', onPointerUp);
        });
    }
    setupJoystick('base-left', 'stick-left', input.left); setupJoystick('base-right', 'stick-right', input.right);

    let stamina = 100, isGrounded = false, isLedgeGrabbing = false, isClimbingUp = false, ledgeTarget = new THREE.Vector3(), jumpMomentum = new THREE.Vector3();
    let lastLedgeState = false, lockedHintAngle = null, ledgeGrabTimer = 0, ledgeGrabCooldown = 0, ledgeJumpMultiplier = 1.0, landingTimer = 0, initialLandingTimer = 0;
    let ledgeOffset = 0.06, ledgeMoveLocked = false, baseLandingAnimDuration = 0.25, climbTransitionDuration = 0.20;
    let wallStopThreshold = 0.90;
    let carryTargetObj = null;
    let isSlipping = false;
    let slipTimer = 0;
    let ledgeSlipDuration = 0.05;
    let ledgeDropPushback = 0.12;
    let carryHeight = 2.45, throwTrimStart = 0.25, projSize = 0.3, projSpeed = 20.0;
    window.throwSpeedMult = 1.0;
    window.spineBlendValue = 1.00;
    window.orangeRecoilForce = 35.0;
    const STAMINA_MAX = 100, REGEN_RATE = 25, HANG_DRAIN = 2, JUMP_COST = 8, LEDGE_JUMP_COST = 12, LEDGE_MOVE_COST = 4, CLIMB_COST = 4;

    document.getElementById('empty-stamina-btn').addEventListener('pointerdown', () => { stamina = 0; document.getElementById('stamina-bar').style.width = '0%'; });

    function handleJump() {
        if (char.isRagdoll || char.isStandingUp || isSlipping || isClimbingUp) return;
        if (isHoldingMovable) {
            isHoldingMovable = false; heldBox = null; holdBtn.innerText = 'HOLD';
            document.getElementById('base-left').classList.remove('hold-mode');
        }
        if (stamina < JUMP_COST || landingTimer > 0) return;
        if (isGrounded && !isLedgeGrabbing && !isClimbingUp) { stamina -= JUMP_COST; yVelocity = 10; isGrounded = false; landingTimer = 0; }
        else if (isLedgeGrabbing || isClimbingUp || (!isGrounded && ledgeGrabCooldown > 0.1)) {
            if (stamina < LEDGE_JUMP_COST) return; 
            stamina -= LEDGE_JUMP_COST;
            const curX = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
            const curY = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
            const mag = Math.sqrt(curX * curX + curY * curY);
            let isHoldingUp = false;
            
            if (mag > 0.3) {
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                let refAngle = lockedHintAngle === null ? (Math.PI - Math.atan2(_tempVec1.x, _tempVec1.z) + cameraTheta) : lockedHintAngle;
                const stickVec = new THREE.Vector2(curX, curY).normalize();
                const uiUp = new THREE.Vector2(Math.sin(refAngle), -Math.cos(refAngle)).normalize();
                if (stickVec.dot(uiUp) > 0.4) isHoldingUp = true;
            } else if (keys.w) isHoldingUp = true;

            if (isHoldingUp || mag < 0.3) {
                isLedgeGrabbing = false; isClimbingUp = true; lockedHintAngle = null; char.climbFinished = false; 
            } else {
                isLedgeGrabbing = false; isClimbingUp = false; yVelocity = 10 * ledgeJumpMultiplier;
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                jumpMomentum.copy(_tempVec1.negate().multiplyScalar(15 * ledgeJumpMultiplier)); 
                lockedHintAngle = null; ledgeGrabCooldown = 0.5;
            }
        }
    }

    window.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (keys.hasOwnProperty(k)) keys[k] = true; if (e.code === 'Space') handleJump(); });
    window.addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (keys.hasOwnProperty(k)) keys[k] = false; });
    document.getElementById('jump-btn').addEventListener('pointerdown', handleJump);

    let isLook = false, lX, lY;
    window.addEventListener('pointerdown', e => { 
        if (e.clientX < 200 && e.clientY > window.innerHeight - 200) return;
        if (e.clientX > window.innerWidth - 200 && e.clientY > window.innerHeight - 200) return;
        if (!e.target.closest('.joystick-base') && e.target.id.indexOf('btn') === -1 && !e.target.closest('#ui')) { isLook = true; lX=e.clientX; lY=e.clientY; } 
    });
    window.addEventListener('pointermove', e => { if (isLook) { cameraTheta -= (e.clientX-lX)*0.005; cameraPhi = Math.max(0.1, Math.min(3.0, cameraPhi-(e.clientY-lY)*0.005)); lX=e.clientX; lY=e.clientY; } });
    window.addEventListener('pointerup', () => isLook=false);
    document.getElementById('reset-cam-btn').addEventListener('pointerdown', () => { cameraTheta = char.group.rotation.y + Math.PI; cameraPhi = Math.PI/3; });

    const clock = new THREE.Clock();
    const rayDown = new THREE.Raycaster(), rayFwd = new THREE.Raycaster();
    let camTarget = new THREE.Vector3(0, 5, -40);

    const uiBindings = [
        { id: 'ledge-force-slider', vId: 'force-val', func: v => ledgeJumpMultiplier = v },
        { id: 'scale-slider', vId: 'scale-val', func: v => char.updateScale(v), fix: 4 },
        { id: 'offset-slider', vId: 'offset-val', func: v => ledgeOffset = v },
        { id: 'climb-speed-slider', vId: 'climb-speed-val', func: v => char.updateClimbSpeed(v), fix: 1 },
        { id: 'land-speed-slider', vId: 'land-speed-val', func: v => char.updateLandSpeed(v), fix: 1 },
        { id: 'land-dur-slider', vId: 'land-dur-val', func: v => baseLandingAnimDuration = v },
        { id: 'climb-trans-slider', vId: 'climb-trans-val', func: v => climbTransitionDuration = v },
        { id: 'wall-stop-slider', vId: 'wall-stop-val', func: v => wallStopThreshold = v, fix: 2 },
        { id: 'standup-start-slider', vId: 'standup-start-val', func: v => char.standupStartTime = v },
        { id: 'standup-speed-slider', vId: 'standup-speed-val', func: v => char.standupSpeed = v, fix: 1 },
        { id: 'standup-fade-slider', vId: 'standup-fade-val', func: v => char.standupCrossfade = v },
        { id: 'pose-dur-slider', vId: 'pose-dur-val', func: v => char.ragdollPoseDuration = v },
        { id: 'carry-height-slider', vId: 'carry-height-val', func: v => carryHeight = v },
        { id: 'throw-speed-slider', vId: 'throw-speed-val', func: v => window.throwSpeedMult = v },
        { id: 'throw-trim-slider', vId: 'throw-trim-val', func: v => throwTrimStart = v },
        { id: 'spine-blend-slider', vId: 'spine-blend-val', func: v => { window.spineBlendValue = v; char.buildClips(); } },
        { id: 'slip-dur-slider', vId: 'slip-dur-val', func: v => ledgeSlipDuration = v },
        { id: 'drop-pushback-slider', vId: 'drop-pushback-val', func: v => ledgeDropPushback = v },
        { id: 'proj-size-slider', vId: 'proj-size-val', func: v => projSize = v, raw: true },
        { id: 'proj-speed-slider', vId: 'proj-speed-val', func: v => projSpeed = v, raw: true },
        { id: 'orange-recoil-slider', vId: 'orange-recoil-val', func: v => window.orangeRecoilForce = v, raw: true },
        { id: 'collider-density-slider', vId: 'collider-density-val', func: v => char.updateColliderDensity(v), fix: 0 }
    ];

    uiBindings.forEach(b => {
        const el = document.getElementById(b.id);
        if (el) {
            el.addEventListener('input', e => {
                const val = parseFloat(e.target.value);
                b.func(val);
                const displayEl = document.getElementById(b.vId);
                if (displayEl) displayEl.innerText = b.raw ? e.target.value : val.toFixed(b.fix || 2);
            });
        }
    });

    document.getElementById('toggle-hitbox').addEventListener('change', e => {
        const checked = e.target.checked;
        char.toggleHitbox(checked);
        carryables.forEach(c => { if (c.debugHelper) c.debugHelper.visible = checked; });
        debugHelpers.forEach(h => { h.visible = checked; });
    });
    document.getElementById('toggle-ragdoll-colliders').addEventListener('change', e => char.toggleRagdollColliders(e.target.checked));

    let showJoints = false;
    document.getElementById('toggle-debug-joints').addEventListener('change', e => {
        showJoints = e.target.checked;
        if (char.skeletonHelper) char.skeletonHelper.visible = showJoints;
        if (char.rootMarker) char.rootMarker.visible = showJoints;
        if (char.hipsMarker) char.hipsMarker.visible = showJoints;
    });

    function animate() {
        requestAnimationFrame(animate);
        const delta = Math.min(clock.getDelta(), 0.1), time = Date.now()*0.001;
        
        const solidCollidables = heldCarryable ? collidables.filter(c => c !== heldCarryable) : collidables;

        if (Math.abs(input.right.x) > 0.05 || Math.abs(input.right.y) > 0.05) {
            cameraTheta -= input.right.x * 0.04;
            cameraPhi = Math.max(0.1, Math.min(3.0, cameraPhi - input.right.y * 0.04));
        }

        let lightTrack = _tempVec2.copy(char.group.position);
        if (char.isRagdoll) {
            const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
            if (hipsP) lightTrack.copy(hipsP.pos);
        }

        let floorY = 0; 
        let isSliding = false;
        let groundNormal = _upVec.clone();

        if (char.isRagdoll) {
            const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
            let rayOrigin = hipsP ? hipsP.pos.clone() : char.group.position.clone();
            rayOrigin.y += 0.5;
            rayDown.set(rayOrigin, _downVec);
            const dH = rayDown.intersectObjects(solidCollidables);
            if (dH.length > 0) {
                floorY = dH[0].point.y;
                groundNormal.copy(dH[0].face.normal).transformDirection(dH[0].object.matrixWorld);
            }
        } else {
            const rayOffsets = [
                new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.25, 0, 0), new THREE.Vector3(-0.25, 0, 0),
                new THREE.Vector3(0, 0, 0.25), new THREE.Vector3(0, 0, -0.25)
            ];
            let hitAnything = false;
            let highestY = -Infinity;

            for (let offset of rayOffsets) {
                let testOrigin = _tempVec1.copy(char.group.position).add(offset);
                testOrigin.y += 1.2; 
                rayDown.set(testOrigin, _downVec);
                const hits = rayDown.intersectObjects(solidCollidables);
                if (hits.length > 0) {
                    const hitY = hits[0].point.y;
                    if (hitY <= char.group.position.y + 0.8) {
                        if (hitY > highestY) {
                            highestY = hitY;
                            groundNormal.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
                            hitAnything = true;
                        }
                    }
                }
            }

            if (hitAnything) {
                floorY = highestY;
                if (groundNormal.angleTo(_upVec) > Math.PI * 0.22 && isGrounded && !isLedgeGrabbing && !isClimbingUp) { 
                    isSliding = true;
                    char.group.position.add(_tempVec3.set(groundNormal.x, 0, groundNormal.z).normalize().multiplyScalar(15 * delta));
                }
            } else floorY = 0;
        }
        
        const capsuleRadius = 0.4;
        const penetrationRays = [
            new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
            new THREE.Vector3(0.707, 0, 0.707), new THREE.Vector3(-0.707, 0, -0.707),
            new THREE.Vector3(0.707, 0, -0.707), new THREE.Vector3(-0.707, 0, 0.707)
        ];
        
        let pushOutVector = new THREE.Vector3(0, 0, 0);
        let hasPenetration = false;
        
        for(let dir of penetrationRays) {
            let testOrigin1 = _tempVec1.copy(char.group.position);
            testOrigin1.y += 0.5; 
            rayFwd.set(testOrigin1, dir);
            let hits1 = rayFwd.intersectObjects(solidCollidables);
            
            let testOrigin2 = _tempVec2.copy(char.group.position);
            testOrigin2.y += 1.5; 
            rayFwd.set(testOrigin2, dir);
            let hits2 = rayFwd.intersectObjects(solidCollidables);
            
            const processHits = (hits) => {
                if (hits.length > 0 && hits[0].distance < capsuleRadius) {
                    const overlap = capsuleRadius - hits[0].distance;
                    const normal = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld).setY(0).normalize();
                    if (normal.lengthSq() > 0) {
                        pushOutVector.add(normal.multiplyScalar(overlap));
                        hasPenetration = true;
                    }
                }
            };
            processHits(hits1); processHits(hits2);
        }
        
        if (hasPenetration && !char.isRagdoll && !isLedgeGrabbing && !isClimbingUp) {
            pushOutVector.y = 0; char.group.position.add(pushOutVector.multiplyScalar(0.5)); 
        }

        dirLight.position.set(lightTrack.x, lightTrack.y + 40, lightTrack.z);
        dirLight.target.position.copy(lightTrack);

        const curX = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
        const curY = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
        const moveMag = Math.min(Math.sqrt(curX*curX + curY*curY), 1.0);

        if (isBuilding) {
            const snap = v => Math.floor(v / cubeSize) * cubeSize + cubeSize/2;
            _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
            const targetPos = _tempVec2.copy(char.group.position).add(_tempVec1.multiplyScalar(cubeSize*1.5));
            const px = snap(targetPos.x), py = snap(char.group.position.y + 1.5) + buildHeightOffset, pz = snap(targetPos.z);
            buildPreview.position.set(px, py, pz); gridHelper.position.set(px, py-cubeSize/2+0.05, pz);
            canPlace = true;
            for (let o of solidCollidables) if (o !== ground && o.position.distanceTo(buildPreview.position) < 0.1) canPlace = false;
            if (char.group.position.distanceTo(_tempVec3.set(px, char.group.position.y, pz)) < cubeSize*0.7) canPlace = false;
            buildPreview.material.color.set(canPlace ? 0x00ff00 : 0xff0000);
        }

        if (star.visible) {
            star.rotation.y += delta;
            if (char.group.position.distanceTo(star.position) < 3.0) {
                star.visible = false;
                const select = document.getElementById('level-select');
                select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
                currentLevel = select.value;
                const overlay = document.getElementById('msg-overlay');
                overlay.innerHTML = `CONGRATULATIONS!<br><span style="font-size: 16px;">Level Completed!</span>`;
                overlay.style.display = 'block';
                setTimeout(() => { overlay.style.display = 'none'; buildLevel(); }, 3000);
            }
        }

        const targetPos = _tempVec1.copy(char.group.position).setY(char.group.position.y + 1.0);
        shooters.forEach(s => s.update(delta, targetPos, scene));

        for (let i = projectiles.length - 1; i >= 0; i--) {
            let p = projectiles[i];
            p.lifespan -= delta;
            p.mesh.position.addScaledVector(p.velocity, delta);

            const projRadius = p.radius || 0.3;
            if (!char.isRagdoll && p.mesh.position.distanceTo(targetPos) < (0.9 + projRadius)) {
                if (p.intensity === 'high') {
                    char.initRagdoll(p.velocity, p.intensity);
                    isLedgeGrabbing = false; isClimbingUp = false; yVelocity = 0;
                } else {
                    char.applyProceduralRecoil(p.velocity, p.intensity);
                }
                scene.remove(p.mesh); projectiles.splice(i, 1);
                continue;
            }

            let jarDestroyed = false;
            for (let c of carryables) {
                if (c.mesh.userData.isJar && p.mesh.position.distanceTo(c.mesh.position) < 0.8) {
                    shatterJar(c.mesh.position.clone(), p.velocity.clone());
                    destroyJarCarryable(c.mesh);
                    scene.remove(p.mesh); projectiles.splice(i, 1);
                    jarDestroyed = true;
                    break;
                }
            }
            if (jarDestroyed) continue;

            let hitObject = false;
            const obstacleBox = new THREE.Box3();
            for (let j = 0; j < collidables.length; j++) {
                const obj = collidables[j];
                if (obj === ground) continue;
                if (p.sender && obj === p.sender.mesh && p.mesh.position.distanceTo(obj.position) < 2.0) continue; 
                getObstacleBox(obj, obstacleBox);
                obstacleBox.expandByScalar(projRadius);
                if (obstacleBox.containsPoint(p.mesh.position)) { hitObject = true; break; }
            }

            if (hitObject || p.lifespan <= 0 || p.mesh.position.y < floorY) {
                scene.remove(p.mesh); projectiles.splice(i, 1);
            }
        }

        for (let i = activeShards.length - 1; i >= 0; i--) {
            const shard = activeShards[i];
            shard.userData.lifespan -= delta;

            if (shard.userData.lifespan <= 0) {
                scene.remove(shard);
                if (shard.geometry) shard.geometry.dispose();
                if (shard.material) {
                    if (Array.isArray(shard.material)) shard.material.forEach(m => m.dispose());
                    else shard.material.dispose();
                }
                activeShards.splice(i, 1);
                continue;
            }

            shard.userData.velocity.y -= 25 * delta;
            shard.position.addScaledVector(shard.userData.velocity, delta);

            if (shard.position.y < 0.1) {
                shard.position.y = 0.1;
                shard.userData.velocity.y *= -0.3;
                shard.userData.velocity.x *= 0.75;
                shard.userData.velocity.z *= 0.75;
            }

            if (shard.userData.lifespan < 1.0) {
                if (shard.material) {
                    if (Array.isArray(shard.material)) shard.material.forEach(m => m.opacity = shard.userData.lifespan);
                    else shard.material.opacity = shard.userData.lifespan;
                }
            }
        }

        carryables.forEach(c => {
            if (c.debugHelper) {
                c.debugHelper.position.copy(c.mesh.position);
                c.debugHelper.quaternion.copy(c.mesh.quaternion);
                c.debugHelper.visible = document.getElementById('toggle-hitbox').checked;
            }
            if (c.isCarried) return;

            const subSteps = 4;
            const subDelta = delta / subSteps;
            const carryBox = new THREE.Box3();
            const obstacleBox = new THREE.Box3();

            for (let step = 0; step < subSteps; step++) {
                if (c.isCarried) break;
                c.velocity.y -= 30 * subDelta;

                c.mesh.position.x += c.velocity.x * subDelta;
                carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                let earlyExit = false;
                collidables.forEach(obj => {
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable) return;
                    getObstacleBox(obj, obstacleBox);
                    if (carryBox.intersectsBox(obstacleBox)) {
                        const speed = c.velocity.length();
                        if (c.mesh.userData.isJar && speed > 5.0) {
                            shatterJar(c.mesh.position.clone(), c.velocity.clone());
                            destroyJarCarryable(c.mesh);
                            earlyExit = true; return;
                        }
                        const overlapX = Math.min(carryBox.max.x - obstacleBox.min.x, obstacleBox.max.x - carryBox.min.x);
                        const dirX = Math.sign(c.mesh.position.x - obj.position.x);
                        c.mesh.position.x += (dirX !== 0 ? dirX : 1) * (overlapX + 0.001);
                        c.velocity.x *= -0.25; 
                        carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                    }
                });
                if (earlyExit) break;

                c.mesh.position.z += c.velocity.z * subDelta;
                carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                collidables.forEach(obj => {
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable) return;
                    getObstacleBox(obj, obstacleBox);
                    if (carryBox.intersectsBox(obstacleBox)) {
                        const speed = c.velocity.length();
                        if (c.mesh.userData.isJar && speed > 5.0) {
                            shatterJar(c.mesh.position.clone(), c.velocity.clone());
                            destroyJarCarryable(c.mesh);
                            earlyExit = true; return;
                        }
                        const overlapZ = Math.min(carryBox.max.z - obstacleBox.min.z, obstacleBox.max.z - carryBox.min.z);
                        const dirZ = Math.sign(c.mesh.position.z - obj.position.z);
                        c.mesh.position.z += (dirZ !== 0 ? dirZ : 1) * (overlapZ + 0.001);
                        c.velocity.z *= -0.25; 
                        carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                    }
                });
                if (earlyExit) break;

                c.mesh.position.y += c.velocity.y * subDelta;
                if (c.mesh.position.y < 0.5) {
                    c.mesh.position.y = 0.5;
                    if (c.mesh.userData.isJar && Math.abs(c.velocity.y) > 5.0) {
                        shatterJar(c.mesh.position.clone(), c.velocity.clone());
                        destroyJarCarryable(c.mesh); break;
                    }
                    c.velocity.y = 0;
                    c.velocity.x *= Math.pow(0.85, 1 / subSteps); 
                    c.velocity.z *= Math.pow(0.85, 1 / subSteps);
                }

                carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                collidables.forEach(obj => {
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable) return;
                    getObstacleBox(obj, obstacleBox);
                    if (carryBox.intersectsBox(obstacleBox)) {
                        const overlapY = Math.min(carryBox.max.y - obstacleBox.min.y, obstacleBox.max.y - carryBox.min.y);
                        const dirY = Math.sign(c.mesh.position.y - obj.position.y);
                        const resolvedDirY = dirY !== 0 ? dirY : 1;
                        c.mesh.position.y += resolvedDirY * (overlapY + 0.001);

                        if (resolvedDirY > 0) { 
                            if (c.mesh.userData.isJar && Math.abs(c.velocity.y) > 5.0) {
                                shatterJar(c.mesh.position.clone(), c.velocity.clone());
                                destroyJarCarryable(c.mesh); earlyExit = true; return;
                            }
                            c.velocity.y = 0;
                            c.velocity.x *= Math.pow(0.85, 1 / subSteps); 
                            c.velocity.z *= Math.pow(0.85, 1 / subSteps);
                        } else { 
                            c.velocity.y *= -0.2; 
                        }
                        carryBox.setFromCenterAndSize(c.mesh.position, _carrySizeVec);
                    }
                });
                if (earlyExit) break;
            }
        });

        if (ledgeGrabCooldown > 0) ledgeGrabCooldown -= delta;
        
        const leftBaseEl = document.getElementById('base-left');
        if (isLedgeGrabbing !== lastLedgeState) {
            if (isLedgeGrabbing) { leftBaseEl.classList.add('ledge-mode'); ledgeGrabTimer = 0; }
            else leftBaseEl.classList.remove('ledge-mode');
            lastLedgeState = isLedgeGrabbing;
        }

        if (char.isRagdoll) {
            char.updateRagdoll(delta, collidables, floorY);
            if (char.ragdollTimer > char.ragdollMaxTime) {
                const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
                char.beginStandUp(hipsP ? Math.max(0, hipsP.pos.y - 0.5) : 0);
                yVelocity = 0; jumpMomentum.set(0, 0, 0); isGrounded = true;
            }
        } else if (char.isStandingUp) {
            if (char.updateStandUp(delta)) char.fadeToAction('idle', 0.3);
            if (char.mixer) char.mixer.update(delta);
        } else if (isClimbingUp) {
            if (isLedgeGrabbing) stamina -= HANG_DRAIN*delta;
            else if (isGrounded && moveMag < 0.1 && yVelocity === 0) stamina += REGEN_RATE*delta;
            else stamina -= CLIMB_COST*delta;
            stamina = Math.max(0, Math.min(STAMINA_MAX, stamina));
            document.getElementById('stamina-bar').style.width = stamina + '%';

            char.animate(delta, 'climbing', 0, time, 0, 0);
            
            const climbAction = char.actions['climb'];
            let transitionNow = char.climbFinished;
            if (climbAction && ((climbAction.getClip().duration - climbAction.time) / char.climbSpeed) <= climbTransitionDuration) transitionNow = true;

            if (transitionNow) {
                const oldPos = char.group.position.clone();
                char.group.position.copy(ledgeTarget);
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                char.group.position.add(_tempVec1.multiplyScalar(0.25)); 
                
                const moveDiff = char.group.position.clone().sub(oldPos);
                moveDiff.applyQuaternion(char.group.quaternion.clone().invert());
                
                if (char.fbxModel) {
                    char.fbxModel.position.sub(moveDiff);
                    char.transitionStartX = char.fbxModel.position.x;
                    char.transitionStartY = char.fbxModel.position.y;
                    char.transitionStartZ = char.fbxModel.position.z;
                }

                char.climbTransitionTimer = climbTransitionDuration; char.climbTransitionMax = climbTransitionDuration;
                isClimbingUp = false; char.climbFinished = false; yVelocity = 0; isGrounded = true; landingTimer = 0; ledgeGrabCooldown = 0.5;
            }
        } else if (isLedgeGrabbing) {
            yVelocity = 0; ledgeGrabTimer += delta;
            
            if (isSlipping) {
                slipTimer += delta;
                if (slipTimer > ledgeSlipDuration) {
                    isLedgeGrabbing = false; isSlipping = false; yVelocity = -23; ledgeGrabCooldown = 1.0; 
                    const pushBackVec = _tempVec1.set(0, 0, -1).applyQuaternion(char.group.quaternion);
                    char.group.position.addScaledVector(pushBackVec, ledgeDropPushback);
                }
            } else {
                stamina -= HANG_DRAIN*delta;
                if (moveMag > 0.1 && !ledgeMoveLocked) stamina -= LEDGE_MOVE_COST*delta;
            }
            
            stamina = Math.max(0, Math.min(STAMINA_MAX, stamina));
            document.getElementById('stamina-bar').style.width = stamina + '%';
            
            if (stamina <= 0) {
                isLedgeGrabbing = false; isSlipping = false; yVelocity = -5; ledgeGrabCooldown = 1.5; lockedHintAngle = null;
                const pushBackVec = _tempVec1.set(0, 0, -1).applyQuaternion(char.group.quaternion);
                char.group.position.addScaledVector(pushBackVec, ledgeDropPushback);
            }
            
            const chest = _tempVec2.copy(char.group.position).setY(char.group.position.y+1.1);
            const charFwd = _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
            rayFwd.set(chest, charFwd);
            const wallHits = rayFwd.intersectObjects(solidCollidables);
            if (wallHits.length > 0 && wallHits[0].distance < 1.0) {
                const n = wallHits[0].face.normal.clone().transformDirection(wallHits[0].object.matrixWorld).setY(0).normalize();
                char.group.position.x = wallHits[0].point.x + n.x * ledgeOffset;
                char.group.position.z = wallHits[0].point.z + n.z * ledgeOffset;
                char.group.lookAt(_tempVec3.copy(char.group.position).sub(n));
            }

            const actualRgt = _tempVec3.set(1,0,0).applyQuaternion(char.group.quaternion);
            let hint = Math.PI - Math.atan2(charFwd.x, charFwd.z) + cameraTheta;
            if (lockedHintAngle === null) document.getElementById('ledge-hint-container').style.transform = `rotate(${hint}rad)`;
            
            let currentPushS = 0;
            if (moveMag < 0.1) ledgeMoveLocked = false;

            if (moveMag > 0.1 && !isSlipping) {
                if (lockedHintAngle === null) { lockedHintAngle = hint; document.getElementById('ledge-hint-container').style.transform = `rotate(${lockedHintAngle}rad)`; }
                const stickVec = new THREE.Vector2(curX, curY).normalize(), uiUp = new THREE.Vector2(Math.sin(lockedHintAngle), -Math.cos(lockedHintAngle)).normalize(), uiRgt = new THREE.Vector2(Math.cos(lockedHintAngle), Math.sin(lockedHintAngle)).normalize();
                const pCD = stickVec.dot(uiUp), pS = stickVec.dot(uiRgt);
            
                if (!ledgeMoveLocked) currentPushS = pS;
                
                if (ledgeGrabTimer > 0.15) {
                    if (pCD > 0.6) { isLedgeGrabbing = false; isClimbingUp = true; lockedHintAngle = null; char.climbFinished = false; }
                    else if (pCD < -0.6) { 
                        isLedgeGrabbing = false; lockedHintAngle = null; yVelocity = -3; ledgeGrabCooldown = 0.5; 
                        const pushBackVec = _tempVec1.set(0, 0, -1).applyQuaternion(char.group.quaternion);
                        char.group.position.addScaledVector(pushBackVec, ledgeDropPushback);
                        return; 
                    }
                }
                
                if (Math.abs(pS) > 0.1 && !ledgeMoveLocked) {
                    const mDir = actualRgt.clone().multiplyScalar(-Math.sign(pS));
                    let handled = false;
                    
                    const targetHead = _tempVec1.copy(chest).setY(char.group.position.y + 2.0).add(mDir.clone().multiplyScalar(0.5));
                    const headRayFwd = new THREE.Raycaster(targetHead, charFwd);
                    const headHits = headRayFwd.intersectObjects(solidCollidables.filter(c => c !== ground));
                    const isHeadBlocked = headHits.length > 0 && headHits[0].distance < 0.8;

                    const sideRay = new THREE.Raycaster(chest, mDir);
                    const sH = sideRay.intersectObjects(solidCollidables);
                    const isBlockedByWall = sH.length > 0 && sH[0].distance < 0.65;
                    const isBlocked = isHeadBlocked || (isBlockedByWall && !handled);

                    if (sH.length > 0 && sH[0].distance < 0.8 && !isBlocked) {
                        const n = sH[0].face.normal.clone().transformDirection(sH[0].object.matrixWorld).setY(0).normalize();
                        const top = sH[0].point.clone().add(n.clone().multiplyScalar(-0.2)).setY(sH[0].point.y+2.0);
                        rayDown.set(top, _downVec); const h = rayDown.intersectObjects(solidCollidables);
                        if (h.length > 0 && Math.abs(h[0].point.y - (char.group.position.y + 1.85)) < 0.8) {
                            char.group.position.copy(sH[0].point.clone().add(n.clone().multiplyScalar(ledgeOffset)).setY(h[0].point.y-1.85));
                            ledgeTarget.copy(h[0].point); char.group.lookAt(_tempVec3.copy(char.group.position).sub(n)); handled = true;
                        }
                    }
                    if (!handled && !(sH.length > 0 && sH[0].distance < 0.65) && !isBlocked) {
                        char.group.position.add(mDir.multiplyScalar(4*delta));

                        _tempVec2.copy(char.group.position).setY(char.group.position.y + 1.1);
                        rayFwd.set(_tempVec2, charFwd);
                        const freshWallHits = rayFwd.intersectObjects(solidCollidables);
                        if (freshWallHits.length > 0 && freshWallHits[0].distance < 0.8) {
                            _tempVec3.copy(freshWallHits[0].point).addScaledVector(charFwd, 0.2).setY(freshWallHits[0].point.y + 3.0);
                            rayDown.set(_tempVec3, _downVec);
                            const freshLedgeHits = rayDown.intersectObjects(solidCollidables);
                            if (freshLedgeHits.length > 0) ledgeTarget.copy(freshLedgeHits[0].point);
                        }
                    }
                    else if (isBlocked) currentPushS = 0;
                }
            } else lockedHintAngle = null;
            char.animate(delta, 'ledge', currentPushS !== 0 ? moveMag : 0, time, 0, currentPushS);
        } else {
            if (isLedgeGrabbing) stamina -= HANG_DRAIN*delta;
            else if (isGrounded && moveMag < 0.1 && yVelocity === 0) stamina += REGEN_RATE*delta;
            stamina = Math.max(0, Math.min(STAMINA_MAX, stamina));
            document.getElementById('stamina-bar').style.width = stamina + '%';

            let effectiveMoveMag = 0;
            let pushPullState = null;

            if (char.isRagdoll && isHoldingMovable) {
                isHoldingMovable = false; heldBox = null; holdBtn.innerText = 'HOLD';
                document.getElementById('base-left').classList.add('hold-mode');
            }

            if (!isHoldingMovable && !window.isCarryingObj && !char.isRagdoll && isGrounded && !window.isCarryStarting && !window.isCarryDropping) {
                _tempVec3.set(0,0,1).applyQuaternion(char.group.quaternion);
                rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.5), _tempVec3);
                
                const boxHits = rayFwd.intersectObjects(solidCollidables.filter(c => c.userData && c.userData.isMovable));
                if (boxHits.length > 0 && boxHits[0].distance < 1.2) {
                    holdBtn.style.display = 'flex'; carryBtn.style.display = 'none';
                } else {
                    holdBtn.style.display = 'none';
                    const carryHits = rayFwd.intersectObjects(solidCollidables.filter(c => c.userData && c.userData.isCarryable));
                    if (carryHits.length > 0 && carryHits[0].distance < 1.5) {
                        carryBtn.style.display = 'flex';
                        let target = carryHits[0].object;
                        while(target && (!target.userData || !target.userData.isCarryable) && target.parent) target = target.parent;
                        carryTargetObj = target;
                    } else {
                        carryBtn.style.display = 'none'; carryTargetObj = null;
                    }
                }
            } else if (isHoldingMovable || window.isCarryingObj || window.isCarryStarting || window.isCarryDropping) {
                holdBtn.style.display = isHoldingMovable ? 'flex' : 'none';
                carryBtn.style.display = 'none';
            }

            const leftHandPos = new THREE.Vector3();
            const rightHandPos = new THREE.Vector3();
            let handMidpoint = new THREE.Vector3();

            if (char.leftHandBone && char.rightHandBone) {
                char.leftHandBone.getWorldPosition(leftHandPos);
                char.rightHandBone.getWorldPosition(rightHandPos);
                handMidpoint.addVectors(leftHandPos, rightHandPos).multiplyScalar(0.5);
                handMidpoint.y += 0.5;
            } else {
                _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);
                handMidpoint.copy(char.group.position).addScaledVector(_tempVec3, 0.15).setY(char.group.position.y + carryHeight + 0.5);
            }

            if (window.isCarryStarting && heldCarryable) {
                carryStartElapsed += delta;
                const duration = char.originalClips['carry_start'] ? char.originalClips['carry_start'].duration : 1.0;
                const t = Math.max(0.0, Math.min(1.0, carryStartElapsed / duration));

                let basePos = new THREE.Vector3();
                basePos.x = THREE.MathUtils.lerp(pickupStartPos.x, handMidpoint.x, t);
                basePos.z = THREE.MathUtils.lerp(pickupStartPos.z, handMidpoint.z, t);
                basePos.y = THREE.MathUtils.lerp(pickupStartPos.y, handMidpoint.y, Math.sin(t * Math.PI / 2));
                
                const headY = char.group.position.y + 1.65;
                const heightDiff = basePos.y - headY;
                const range = 1.1;
                const factor = Math.max(0, 1 - Math.abs(heightDiff) / range);
                const smoothFactor = factor * factor * (3 - 2 * factor);

                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion);
                const offsetDistance = 0.8 * smoothFactor;
                basePos.addScaledVector(fwd, offsetDistance);
                
                heldCarryable.position.copy(basePos);
                heldCarryable.quaternion.slerpQuaternions(pickupStartRot, pickupTargetRot, t);

                if (carryStartElapsed >= duration) {
                    window.isCarryStarting = false; window.isCarryingObj = true;
                    dropBtn.style.display = 'flex'; throwBtn.style.display = 'flex';
                }
            } else if (window.isCarryingObj && heldCarryable) {
                heldCarryable.position.copy(handMidpoint); heldCarryable.quaternion.copy(char.group.quaternion);
            } else if (window.isCarryDropping && heldCarryable) {
                carryStartElapsed += delta;
                const duration = char.originalClips['carry_start'] ? char.originalClips['carry_start'].duration : 1.0;
                const t = Math.max(0.0, Math.min(1.0, carryStartElapsed / duration));

                let basePos = new THREE.Vector3();
                basePos.x = THREE.MathUtils.lerp(dropStartPos.x, dropTargetPos.x, t);
                basePos.z = THREE.MathUtils.lerp(dropStartPos.z, dropTargetPos.z, t);
                basePos.y = THREE.MathUtils.lerp(dropStartPos.y, dropTargetPos.y, Math.sin(t * Math.PI / 2));

                const headY = char.group.position.y + 1.65;
                const heightDiff = basePos.y - headY;
                const range = 1.1;
                const factor = Math.max(0, 1 - Math.abs(heightDiff) / range);
                const smoothFactor = factor * factor * (3 - 2 * factor);

                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion);
                const offsetDistance = 0.8 * smoothFactor;
                basePos.addScaledVector(fwd, offsetDistance);

                heldCarryable.position.copy(basePos);
                heldCarryable.quaternion.slerpQuaternions(dropStartRot, dropTargetRot, t);

                if (carryStartElapsed >= duration) {
                    window.isCarryDropping = false;
                    const cObj = carryables.find(c => c.mesh === heldCarryable);
                    if (cObj) { cObj.isCarried = false; cObj.velocity.set(0, 0, 0); }
                    heldCarryable = null;
                }
            }

            if (window.throwTimer > 0) {
                window.throwTimer -= delta;
            } else if (isHoldingMovable && heldBox) {
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                let pushPullHintAngle = Math.PI - Math.atan2(_tempVec1.x, _tempVec1.z) + cameraTheta;
                document.getElementById('push-pull-hint-container').style.transform = `rotate(${pushPullHintAngle}rad)`;
                
                _tempVec2D.set(curX, curY);
                _tempVec2D2.set(Math.sin(pushPullHintAngle), -Math.cos(pushPullHintAngle)).normalize();
                const dot = _tempVec2D.dot(_tempVec2D2);

                if (Math.abs(dot) > 0.15) {
                    pushPullState = dot > 0 ? 'push' : 'pull';
                    const fwdDir = _tempVec3.set(0,0,1).applyQuaternion(char.group.quaternion);
                    const moveDir = fwdDir.clone().multiplyScalar(dot > 0 ? 1 : -1);
                    let speedMult = isSliding ? 0.1 : 1.0;
                    let actualSpeed = 1.5 * speedMult * Math.abs(dot);
                    
                    rayFwd.set(heldBox.position, moveDir);
                    const boxWallHits = rayFwd.intersectObjects(solidCollidables.filter(c => c !== heldBox && c !== ground && (!c.userData || !c.userData.isMovable)));
                    rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.3), moveDir);
                    const charWallHits = rayFwd.intersectObjects(solidCollidables.filter(c => c !== heldBox && c !== ground && (!c.userData || !c.userData.isMovable)));

                    if ((boxWallHits.length > 0 && boxWallHits[0].distance < cubeSize/2 + 0.2) || (charWallHits.length > 0 && charWallHits[0].distance < 0.5)) actualSpeed = 0;
                    if (!isBuilding && actualSpeed > 0) {
                        const moveVec = moveDir.multiplyScalar(actualSpeed * delta);
                        char.group.position.add(moveVec); heldBox.position.add(moveVec);
                    }
                    effectiveMoveMag = isBuilding ? 0 : actualSpeed / 1.5;
                }
            } else if (moveMag > 0.1) {
                const mAng = cameraTheta + Math.atan2(curX, curY);
                const mDir = _tempVec1.set(Math.sin(mAng), 0, Math.cos(mAng));
                
                rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.3), mDir);
                
                let speedMult = 1.0;
                if (isSliding) speedMult = 0.1;
                if (landingTimer > 0 && initialLandingTimer > 0) speedMult = 1.0 - (0.85 * Math.sin(Math.pow(1.0 - (landingTimer / initialLandingTimer), 0.6) * Math.PI));
                
                let finalMoveDir = mDir.clone();
                let actualSpeed = (window.isCarryingObj ? 4.0 : 8) * speedMult * moveMag;
                
                const actualHits = rayFwd.intersectObjects(solidCollidables);
                if (actualHits.length > 0 && actualHits[0].distance < 0.5) {
                    const wallNormal = actualHits[0].face.normal.clone().transformDirection(actualHits[0].object.matrixWorld).setY(0).normalize();
                    const dot = finalMoveDir.dot(wallNormal);
                    if (dot < 0) {
                        if (-dot > wallStopThreshold) { finalMoveDir.set(0, 0, 0); actualSpeed = 0; }
                        else {
                            finalMoveDir.sub(wallNormal.multiplyScalar(dot));
                            if (finalMoveDir.lengthSq() > 0.001) finalMoveDir.normalize(); else finalMoveDir.set(0, 0, 0);
                            actualSpeed *= Math.sqrt(1.0 - dot * dot);
                        }
                    }
                }
                
                if (!isBuilding && actualSpeed > 0.05) char.group.position.add(finalMoveDir.multiplyScalar(actualSpeed * delta));
                effectiveMoveMag = isBuilding ? 0 : actualSpeed / (window.isCarryingObj ? 4.0 : 8.0);
                char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, mAng), 15*delta);
            }

            if (!isGrounded && yVelocity < 2 && ledgeGrabCooldown <= 0 && !window.isCarryingObj && !window.isCarryStarting) {
                const chest = _tempVec2.copy(char.group.position).setY(char.group.position.y+1.1), fwd = _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                rayFwd.set(chest, fwd); const wH = rayFwd.intersectObjects(solidCollidables);
                if (wH.length > 0 && wH[0].distance < 0.8) {
                    const n = wH[0].face.normal.clone().transformDirection(wH[0].object.matrixWorld).setY(0).normalize();
                    rayFwd.set(_tempVec3.copy(chest).setY(chest.y + cubeSize), fwd);
                    const headClearHits = rayFwd.intersectObjects(collidables);
                    if (!(headClearHits.length > 0 && headClearHits[0].distance < 0.8)) {
                        const top = wH[0].point.clone().add(fwd.clone().multiplyScalar(0.2)).setY(wH[0].point.y+3.0);
                        rayDown.set(top, _downVec); const lH = rayDown.intersectObjects(solidCollidables);
                        if (lH.length > 0 && lH[0].point.y > char.group.position.y && lH[0].point.y < char.group.position.y+3.5) {
                            isLedgeGrabbing = true; ledgeMoveLocked = true;
                            if (yVelocity < -22) { isSlipping = true; slipTimer = 0; } else isSlipping = false;
                            yVelocity = 0; ledgeTarget.copy(lH[0].point);
                            char.group.position.y = lH[0].point.y-1.85; char.group.position.x = wH[0].point.x + n.x*ledgeOffset; char.group.position.z = wH[0].point.z + n.z*ledgeOffset;
                            char.group.lookAt(_tempVec3.copy(char.group.position).sub(n)); jumpMomentum.set(0,0,0);
                        }
                    }
                }
            }
            if (jumpMomentum.lengthSq() > 0.01) { char.group.position.add(_tempVec1.copy(jumpMomentum).multiplyScalar(delta)); jumpMomentum.lerp(_tempVec2.set(0,0,0), 4*delta); }
            
            let wasGrounded = isGrounded;
            if (char.group.position.y + yVelocity*delta > floorY + 0.01) { 
                yVelocity -= 30*delta; isGrounded = false; char.group.position.y += yVelocity*delta; 
            } else { 
                char.group.position.y = floorY; isGrounded = true; 
                if (!wasGrounded) {
                    if (yVelocity < -22 && !char.isRagdoll) {
                        const currentVel = new THREE.Vector3();
                        if (moveMag > 0.1) {
                            const mAng = cameraTheta + Math.atan2(curX, curY);
                            currentVel.set(Math.sin(mAng), 0, Math.cos(mAng)).multiplyScalar(12 * moveMag);
                        }
                        currentVel.y = yVelocity;
                        char.initRagdoll(currentVel, 'high');
                        isLedgeGrabbing = false; isClimbingUp = false; lockedHintAngle = null;
                    } else if (yVelocity < -5) {
                        landingTimer = baseLandingAnimDuration * (1.0 + (Math.abs(yVelocity) - 5) * 0.2);
                        initialLandingTimer = landingTimer;
                    } else { landingTimer = 0; initialLandingTimer = 0; }
                }
                if (!char.isRagdoll) { yVelocity = 0; jumpMomentum.set(0,0,0); }
            }
            
            if (landingTimer > 0) landingTimer -= delta;
            
            if (isGrounded) {
                if (pushPullState === 'push') char.animate(delta, 'push', effectiveMoveMag, time, yVelocity, 0);
                else if (pushPullState === 'pull') char.animate(delta, 'pull', effectiveMoveMag, time, yVelocity, 0);
                else if (landingTimer > 0 && (initialLandingTimer > 0 ? landingTimer / initialLandingTimer : 0) > 0.4) char.animate(delta, 'landing', effectiveMoveMag, time, yVelocity, 0);
                else if (effectiveMoveMag > 0.05) char.animate(delta, 'walk', effectiveMoveMag, time, yVelocity, 0);
                else char.animate(delta, 'idle', 0, time, 0, 0);
            } else char.animate(delta, 'air', effectiveMoveMag, time, yVelocity, 0);
        }
        
        let trackingPoint = _tempVec1;
        if (char.hips && (isClimbingUp || char.isRagdoll || char.isStandingUp)) char.hips.getWorldPosition(trackingPoint);
        else { trackingPoint.copy(char.group.position); trackingPoint.y += 1.1; }
        
        camTarget.lerp(trackingPoint, 10 * delta);

        let targetCamX = camTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
        let targetCamY = Math.max(floorY + 0.5, camTarget.y + cameraRadius * Math.cos(cameraPhi) + 1.5);
        let targetCamZ = camTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);

        camera.position.lerp(_tempVec2.set(targetCamX, targetCamY, targetCamZ), 15 * delta);
        camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
        
        if (char.fbxModel) char.fbxModel.visible = true;
        char.syncColliders();

// Sol joystick üzerindeki okun yönünü kameraya göre döndür
const leftArrow = document.getElementById('left-arrow');
if (leftArrow) {
    // Karakterin baktığı yön vektörü (+Z yönü)
    const F = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion).normalize();
    
    // Kameranın yatay düzlemdeki ileri ve sağ yönleri
    const camForward = new THREE.Vector3(-Math.sin(cameraTheta), 0, -Math.cos(cameraTheta)).normalize();
    const camRight = new THREE.Vector3(Math.cos(cameraTheta), 0, -Math.sin(cameraTheta)).normalize();
    
    const fwdDot = F.dot(camForward);
    const rgtDot = F.dot(camRight);
    
    // Ekrana göre açıyı hesapla ve oku döndür
    const screenAngle = Math.atan2(rgtDot, fwdDot);
    leftArrow.style.transform = `rotate(${screenAngle}rad)`;
}


        renderer.render(scene, camera);
    }

    animate();
    
    window.addEventListener('resize', () => { 
        camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); 
    });
}