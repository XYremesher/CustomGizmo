import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MultiplayerClient } from './multiplayer.js';
import { RemoteAvatar } from './remote_avatar.js';

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
    window.carryables = carryables;
    let nextCarryNetId = 0;
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
    const _shooterTargetPos = new THREE.Vector3();
    const _remoteCollideNormal = new THREE.Vector3();
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

    function getSyncedTime() {
        return window.multiplayerClient ? window.multiplayerClient.getSyncedTime() : Date.now();
    }

    // Each client only ever hit-tests a shooter's projectile against its own
    // local character (RemoteAvatars aren't real collidables), so once shots
    // are time-synced across clients the same shot could otherwise register a
    // hit independently on every player standing along its fixed firing line,
    // instead of stopping at the first one - like a bullet passing through.
    // Since all players' positions are already known (local + broadcast remote
    // positions), each client works out whether some other, closer-to-the-
    // shooter known player sits in the projectile's path; once the projectile
    // actually reaches that player's position, we treat the shot as consumed
    // (removed) here too, without applying any hit effect to the local player -
    // the closer player's own client is the one that registers a real hit on
    // itself, the same way it always has.
    function isProjectileConsumedByCloserPlayer(projectilePos, shooterPos, myPos, hitRadius) {
        if (!window.multiplayerClient) return false;
        const myDistToShooter = shooterPos.distanceTo(myPos);
        for (const avatar of window.multiplayerClient.remotes.values()) {
            if (!avatar.isLoaded || avatar.isRagdoll) continue;
            const rp = avatar.getHitReferencePoint();
            const perpDist = Math.sqrt((rp.y - shooterPos.y) ** 2 + (rp.z - shooterPos.z) ** 2);
            if (perpDist > hitRadius) continue;
            if (shooterPos.distanceTo(rp) >= myDistToShooter) continue;
            if (projectilePos.distanceTo(rp) < hitRadius) return true;
        }
        return false;
    }

    // RemoteAvatars are purely cosmetic (never added to `collidables`), so
    // without this, walking straight at another player never gets blocked -
    // the raycast wall-check above only ever sees real level geometry. This
    // is a simple circular clearance around each known remote's current body
    // position (ragdoll-aware via getHitReferencePoint), redirecting the
    // move direction the same way the wall-normal slide above does, rather
    // than a full raycast against a mesh we don't have collision data for.
    function resolveRemotePlayerCollision(currentPos, moveDir, actualSpeed) {
        if (!window.multiplayerClient) return actualSpeed;
        const COMBINED_RADIUS = 0.8;
        window.multiplayerClient.remotes.forEach(avatar => {
            if (!avatar.isLoaded || actualSpeed <= 0) return;
            const rp = avatar.getHitReferencePoint();
            const dx = currentPos.x - rp.x, dz = currentPos.z - rp.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist >= COMBINED_RADIUS) return;

            _remoteCollideNormal.set(dx, 0, dz);
            if (_remoteCollideNormal.lengthSq() < 0.0001) _remoteCollideNormal.set(1, 0, 0);
            else _remoteCollideNormal.normalize();

            const dot = moveDir.dot(_remoteCollideNormal);
            if (dot < 0) {
                moveDir.addScaledVector(_remoteCollideNormal, -dot);
                if (moveDir.lengthSq() > 0.001) moveDir.normalize(); else moveDir.set(0, 0, 0);
                actualSpeed *= Math.sqrt(Math.max(0, 1 - dot * dot));
            }
        });
        return actualSpeed;
    }

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
            this.fireInterval = 3.0;
            // Synced-time cycle instead of a per-client elapsed-since-page-load
            // timer: every connected client computes the same fire cycle at the
            // same server-clock moment (see MultiplayerClient.getSyncedTime,
            // offset from the server's own Date.now() sent in connectSuccess),
            // so turrets fire in lockstep without any per-shot network message -
            // this is what previously made shots appear at different
            // times/positions on each screen, since every client's timer
            // started counting from its own page-load instant.
            this._lastFireCycle = Math.floor(getSyncedTime() / 1000 / this.fireInterval);
        }

        update(delta, targetPosition, scene) {
            const cycle = Math.floor(getSyncedTime() / 1000 / this.fireInterval);
            if (cycle !== this._lastFireCycle) {
                this._lastFireCycle = cycle;
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
    // Exponential falloff instead of linear THREE.Fog: linear fog has a hard
    // "far" distance beyond which everything is pure fog color, so from an
    // elevated viewpoint (looking out across a lot of ground at once) a large
    // chunk of the view hit that cutoff at once, reading as a stark white
    // band butting up against the sky gradient instead of a smooth blend.
    // Density is deliberately low - FogExp2 grows with distance squared, so
    // even a small value here still fully whites out near the sky dome's
    // horizon; too high (e.g. 0.008) and it starts visibly hazing nearby
    // mid-ground before the player even gets close to the true horizon.
    scene.fog = new THREE.FogExp2(0xffffff, 0.0045);

    // Gradient sky dome (classic three.js "webgl_shaders_sky" approach):
    // a huge inward-facing sphere shaded white at the horizon fading up to
    // blue overhead. The fog color above is matched to the same horizon
    // white so distant ground fades into the sky seamlessly instead of
    // blending into a flat, uniformly-blue backdrop.
    const skyGeo = new THREE.SphereGeometry(500, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(0x4d9be6) },
            bottomColor: { value: new THREE.Color(0xffffff) },
            offset: { value: 15 },
            exponent: { value: 1.1 }
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 bottomColor;
            uniform float offset;
            uniform float exponent;
            varying vec3 vWorldPosition;
            void main() {
                float h = normalize(vWorldPosition + offset).y;
                gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
            }
        `,
        side: THREE.BackSide
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(0.1, 40, 0.1);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048; dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5; dirLight.shadow.camera.far = 150;
    dirLight.shadow.camera.left = -40; dirLight.shadow.camera.right = 40;
    dirLight.shadow.camera.top = 40; dirLight.shadow.camera.bottom = -40;
    dirLight.shadow.bias = -0.0001; dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight); scene.add(dirLight.target);

    // Second, angled "fill" light - no shadow map (the expensive part of a
    // light, not the lighting math itself), so it's cheap to have a second
    // directional source giving depth/rim definition from the side instead
    // of everything being lit from directly overhead.
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-25, 15, -20);
    fillLight.castShadow = false;
    scene.add(fillLight); scene.add(fillLight.target);

    const collidables = [];
    window.collidables = collidables;
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
    window.localChar = char;
    let currentLevel = "local_stairs";

    const network = new MultiplayerClient(scene, threeTone);
    window.multiplayerClient = network;

    // Reuses RemoteAvatar as-is (same rendering/animation, ragdoll, hit
    // reactions a real networked player gets) but drives it locally with
    // simple wander AI instead of MultiplayerClient network messages - no
    // server/connection involved, so it works offline and doesn't touch the
    // multiplayer system at all. Not created until spawnAiBot() runs (panel
    // button) so it doesn't wander into every normal test session uninvited.
    let aiBot = null;
    const AI_WANDER_SPEED = 5.0, AI_CHASE_SPEED = 6.5;
    const AI_CHASE_RADIUS = 8, AI_CHASE_GIVEUP_RADIUS = 11, AI_PUNCH_RANGE = 1.3;
    const AI_PUNCH_DURATION = 0.7, AI_PUNCH_HIT_TIME = 0.35, AI_PUNCH_COOLDOWN = 0.8, AI_PUNCH_FORCE = 22;
    const aiBotState = {
        mode: 'wander', // 'wander' | 'chase' | 'punch' | 'cooldown'
        target: new THREE.Vector3(char.group.position.x + 4, char.group.position.y, char.group.position.z + 4),
        waitTimer: 0,
        punchTimer: 0,
        punchHasHit: false,
        cooldownTimer: 0
    };
    function pickNewAiWanderTarget() {
        const angle = Math.random() * Math.PI * 2;
        const dist = 3 + Math.random() * 6;
        aiBotState.target.set(
            aiBot.group.position.x + Math.cos(angle) * dist,
            aiBot.group.position.y,
            aiBot.group.position.z + Math.sin(angle) * dist
        );
    }
    // Moves aiBot's group position toward destTarget at the given speed, with
    // the same reactive obstacle-avoidance and ground-snapping the plain
    // wander uses, reused for both wander and chase movement.
    function moveAiBotToward(destTarget, speed, delta) {
        const pos = aiBot.group.position;
        const toTarget = _tempVec1.set(destTarget.x - pos.x, 0, destTarget.z - pos.z);
        const dist = toTarget.length();
        if (dist < 0.001) return dist;
        toTarget.normalize();

        rayFwd.set(_tempVec2.copy(pos).setY(pos.y + 1.0), toTarget);
        const wallHits = rayFwd.intersectObjects(collidables);
        if (wallHits.length > 0 && wallHits[0].distance < 1.0) return -1;

        // toTarget (_tempVec1) is done being read after this - facingQuat
        // below needs it too, so it's captured into its own quaternion before
        // _tempVec1 gets reused for the ground-check ray origin.
        const facingQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), toTarget);

        const nextPos = _tempVec3.copy(pos).addScaledVector(toTarget, speed * delta);
        rayDown.set(_tempVec1.copy(nextPos).setY(nextPos.y + 2.0), _downVec);
        const groundHits = rayDown.intersectObjects(collidables);
        if (groundHits.length > 0) nextPos.y = groundHits[0].point.y;

        aiBot.setNetworkState([nextPos.x, nextPos.y, nextPos.z], [facingQuat.x, facingQuat.y, facingQuat.z, facingQuat.w], 'walk', false);
        return dist;
    }
    function updateAiBot(delta) {
        if (!aiBot || !aiBot.isLoaded) return;
        if (aiBot.isRagdoll || aiBot.isStandingUp) { aiBot.update(delta); return; }

        const pos = aiBot.group.position;
        const distToPlayer = pos.distanceTo(char.group.position);
        const playerAvailable = !char.isRagdoll && !char.isStandingUp;

        // Combat mode transitions - punch/cooldown run their own timers below
        // and aren't interrupted by distance checks mid-swing.
        if (aiBotState.mode === 'wander' && playerAvailable && distToPlayer < AI_CHASE_RADIUS) {
            aiBotState.mode = 'chase';
        } else if (aiBotState.mode === 'chase' && (!playerAvailable || distToPlayer > AI_CHASE_GIVEUP_RADIUS)) {
            aiBotState.mode = 'wander';
            pickNewAiWanderTarget();
        }

        if (aiBotState.mode === 'punch') {
            aiBotState.punchTimer += delta;
            const facingDir = _tempVec1.set(char.group.position.x - pos.x, 0, char.group.position.z - pos.z);
            if (facingDir.lengthSq() > 0.0001) {
                facingDir.normalize();
                const facingQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facingDir);
                aiBot.setNetworkState([pos.x, pos.y, pos.z], [facingQuat.x, facingQuat.y, facingQuat.z, facingQuat.w], 'punch_left', false);
            }

            if (!aiBotState.punchHasHit && aiBotState.punchTimer >= AI_PUNCH_HIT_TIME) {
                aiBotState.punchHasHit = true;
                if (playerAvailable && pos.distanceTo(char.group.position) < AI_PUNCH_RANGE + 0.6) {
                    const velocity = _tempVec2.set(char.group.position.x - pos.x, 0, char.group.position.z - pos.z).normalize().multiplyScalar(AI_PUNCH_FORCE);
                    const hitPoint = char.group.position.clone().setY(char.group.position.y + 1.2);
                    char.triggerHitFlash(0.9);
                    char.applyProceduralRecoil(velocity, 'medium');
                    if (network) { network.sendHitEvent(0.9, hitPoint); network.sendRecoilEvent(velocity, 'medium'); }
                    if (window.createHandHitEffect) window.createHandHitEffect(hitPoint);
                    if (window.spawnHitEffect) window.spawnHitEffect(hitPoint.clone());
                }
            }
            if (aiBotState.punchTimer >= AI_PUNCH_DURATION) {
                aiBotState.mode = 'cooldown';
                aiBotState.cooldownTimer = AI_PUNCH_COOLDOWN;
            }
            aiBot.update(delta);
            return;
        }

        if (aiBotState.mode === 'cooldown') {
            aiBotState.cooldownTimer -= delta;
            aiBot.setNetworkState([pos.x, pos.y, pos.z], [aiBot.group.quaternion.x, aiBot.group.quaternion.y, aiBot.group.quaternion.z, aiBot.group.quaternion.w], 'idle', false);
            if (aiBotState.cooldownTimer <= 0) aiBotState.mode = (playerAvailable && distToPlayer < AI_CHASE_RADIUS) ? 'chase' : 'wander';
            aiBot.update(delta);
            return;
        }

        if (aiBotState.mode === 'chase') {
            if (distToPlayer < AI_PUNCH_RANGE) {
                aiBotState.mode = 'punch';
                aiBotState.punchTimer = 0;
                aiBotState.punchHasHit = false;
                aiBot.update(delta);
                return;
            }
            if (moveAiBotToward(char.group.position, AI_CHASE_SPEED, delta) < 0) pickNewAiWanderTarget();
            aiBot.update(delta);
            return;
        }

        // --- wander ---
        if (aiBotState.waitTimer > 0) {
            aiBotState.waitTimer -= delta;
            aiBot.setNetworkState([pos.x, pos.y, pos.z], [aiBot.group.quaternion.x, aiBot.group.quaternion.y, aiBot.group.quaternion.z, aiBot.group.quaternion.w], 'idle', false);
            aiBot.update(delta);
            return;
        }
        const distLeft = moveAiBotToward(aiBotState.target, AI_WANDER_SPEED, delta);
        if (distLeft < 0.3) {
            aiBotState.waitTimer = 1.0 + Math.random() * 2.0;
            pickNewAiWanderTarget();
        }
        aiBot.update(delta);
    }

    function spawnAiBot() {
        if (aiBot) return;
        aiBot = new RemoteAvatar(scene, threeTone, 'ai-bot-1');
        window.aiBot = aiBot;
        const spawnPos = char.group.position;
        aiBotState.mode = 'wander';
        aiBotState.target.set(spawnPos.x + 4, spawnPos.y, spawnPos.z + 4);
        aiBotState.waitTimer = 0;
        aiBotState.cooldownTimer = 0;
        aiBot.group.position.copy(spawnPos).add(new THREE.Vector3(3, 0, 3));

        const spawnBtn = document.getElementById('ai-bot-spawn-btn');
        const despawnBtn = document.getElementById('ai-bot-despawn-btn');
        const statusEl = document.getElementById('ai-bot-status');
        if (spawnBtn) spawnBtn.style.display = 'none';
        if (despawnBtn) despawnBtn.style.display = 'block';
        if (statusEl) statusEl.textContent = 'spawned';
    }

    function despawnAiBot() {
        if (!aiBot) return;
        aiBot.dispose();
        aiBot = null;
        window.aiBot = null;

        const spawnBtn = document.getElementById('ai-bot-spawn-btn');
        const despawnBtn = document.getElementById('ai-bot-despawn-btn');
        const statusEl = document.getElementById('ai-bot-status');
        if (spawnBtn) spawnBtn.style.display = 'block';
        if (despawnBtn) despawnBtn.style.display = 'none';
        if (statusEl) statusEl.textContent = 'not spawned';
    }

    const aiBotSpawnBtn = document.getElementById('ai-bot-spawn-btn');
    const aiBotDespawnBtn = document.getElementById('ai-bot-despawn-btn');
    if (aiBotSpawnBtn) aiBotSpawnBtn.addEventListener('pointerdown', spawnAiBot);
    if (aiBotDespawnBtn) aiBotDespawnBtn.addEventListener('pointerdown', despawnAiBot);

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

    // StarKey.fbx contains both a key and a lock (LockBase/LockStarContainer
    // for the lock, KeyBase/KeyStarContainer for the key) plus a single
    // shared "Star" mesh, all authored as flat siblings in the source file.
    let keyTemplateParts = null;
    let stairsLevelBuilt = false; // set once buildStairsLevel() has run at least once
    const activeKeyStars = []; // billboarded toward the camera every frame, see the main loop
    const activeKeyGroups = []; // rescaled live by the Key Scale slider (key + lock share it)
    window.keyScale = 2.0;
    fbxLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Interactables/StarKey.fbx', (object) => {
        let keyBase = null, keyStarContainer = null, star = null, lockBase = null, lockStarContainer = null;
        object.traverse((child) => {
            if (!child.isMesh) return;
            if (child.name === 'KeyBase') keyBase = child;
            else if (child.name === 'KeyStarContainer') keyStarContainer = child;
            else if (child.name === 'Star') star = child;
            else if (child.name === 'LockBase') lockBase = child;
            else if (child.name === 'LockStarContainer') lockStarContainer = child;
        });
        if (keyBase && keyStarContainer && star) {
            // KeyBase/KeyStarContainer share the exact same local position in
            // the source file - normalize the whole assembly's scale off
            // their combined size, same 1/maxDim approach Jar.fbx uses above,
            // so it isn't a guessed constant tied to this one model's units.
            const box = new THREE.Box3().setFromObject(keyBase).union(new THREE.Box3().setFromObject(keyStarContainer));
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = maxDim > 0 ? 1.0 / maxDim : 1;
            keyTemplateParts = { keyBase, keyStarContainer, star, scale, lockBase, lockStarContainer };
            // Used to just call the full buildLevel() again here whenever
            // this (large, slow-to-fetch) FBX finished loading after the
            // level had already been built once - but a full rebuild while
            // the player might already be mid-climb/mid-carry resets
            // collidables/carryables out from under them (lost ledge grabs,
            // vanished carryables, falling through geometry). If the level's
            // already up, just add the test key/lock on top of it instead.
            if (currentLevel === "local_stairs" && stairsLevelBuilt) spawnTestKeyAndLock();
        }
    });

    function spawnTestKeyAndLock() {
        // Test-only key instance, sitting out in the open near spawn so it
        // can be inspected/picked up without having to break a jar first.
        const testKeyGroup = createKeyInstance();
        if (testKeyGroup) {
            // Sit exactly on the ground (y=0) instead of a guessed y=1.0 -
            // the group's origin is the container's mass center, not the
            // model's base, so the correct ground Y depends on floorOffset.
            testKeyGroup.position.set(0, testKeyGroup.userData.floorOffset * window.keyScale, -3);
            testKeyGroup.userData.isCarryable = true;
            testKeyGroup.userData.isKey = true;
            levelGroup.add(testKeyGroup);
            collidables.push(testKeyGroup);
            const carryTestKey = { mesh: testKeyGroup, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
            carryables.push(carryTestKey); addCarryableDebugHelper(carryTestKey);
        }

        // Test-only lock instance next to the key - fixed in place (not
        // carryable), just to see it in the level; no unlock puzzle wired
        // up yet.
        const testLockGroup = createLockInstance();
        if (testLockGroup) {
            testLockGroup.position.set(-3, testLockGroup.userData.floorOffset * window.keyScale, -3);
            levelGroup.add(testLockGroup);
            collidables.push(testLockGroup);
            window.debugTestLockGroup = testLockGroup; // L key triggers revealLockStar() on this, see keydown handler
        }
    }

    // Shared by both the key and the lock - same base+container+star
    // construction, just with different source meshes. `scale` is always
    // the KEY's own normalize factor (not a separately-computed one for the
    // lock), so the lock keeps its true size relative to the key instead of
    // both getting independently normalized to the same 1-unit footprint.
    // Box3.setFromObject() also expands by every morph target's position
    // range, not just the base geometry - LockStarContainer has a leftover
    // shape key with NaN vertex data (from the Blender normal-flip edit)
    // that poisons the box even though the mesh doesn't actually use that
    // shape. Computing straight from the base position attribute sidesteps
    // that entirely.
    function safeWorldBox(mesh) {
        const posAttr = mesh.geometry.attributes.position;
        const box = new THREE.Box3();
        const v = new THREE.Vector3();
        for (let i = 0; i < posAttr.count; i++) {
            v.fromBufferAttribute(posAttr, i);
            box.expandByPoint(v);
        }
        mesh.updateWorldMatrix(true, false);
        box.applyMatrix4(mesh.matrixWorld);
        return box;
    }
    function meshWorldCenter(mesh) {
        return safeWorldBox(mesh).getCenter(new THREE.Vector3());
    }
    // Object3D.clone() shares the SAME geometry object (incl. morph
    // attributes) with the source - so even though buildStarAssembly's own
    // math avoids the corrupted shape key, any OTHER system that computes a
    // bounding box on the cloned mesh (e.g. the ledge-grab obstacle check,
    // which iterates all collidables) hits the same NaN. LockStarContainer's
    // "Key1" shape key is an intentional part of the lock/key gameplay (open
    // by default so no star shows; animated to 0 once the key goes in, to
    // reveal it) - not something to permanently strip. But its vertex data
    // is currently corrupted (NaN) in the exported FBX, and geometry with
    // morph targets always gets its bounding box expanded to cover the FULL
    // morph range regardless of current influence - so until that's fixed in
    // Blender, keeping it live re-breaks every bounding-box check in the
    // game (that's the ledge-grab bug from before). Only strip it if NaN is
    // actually present; once the source data is clean this stops firing on
    // its own and Key1 starts working without needing another code change.
    function cloneMeshClean(node) {
        const clone = node.clone();
        const morphPos = clone.geometry.morphAttributes && clone.geometry.morphAttributes.position;
        if (morphPos && morphPos.length > 0) {
            // Two ways this data has shown up broken so far: literal NaN
            // values, and (the shape key's actual name is "Key 1", with a
            // space) a target with 0 vertices - an empty/mismatched morph
            // attribute still confuses Three's bounding box/sphere math into
            // producing NaN, same end result. Check both instead of just one.
            const baseCount = clone.geometry.attributes.position.count;
            const invalid = morphPos.some(attr => attr.count !== baseCount || attr.array.some(v => !Number.isFinite(v)));
            if (invalid) {
                console.error(`"${node.name}": shape key data is invalid (wrong vertex count or non-finite values) - stripping morph targets until fixed in Blender.`);
                clone.geometry = clone.geometry.clone();
                clone.geometry.morphAttributes = {};
                clone.geometry.computeBoundingBox();
                clone.geometry.computeBoundingSphere();
                clone.morphTargetInfluences = undefined;
                clone.morphTargetDictionary = undefined;
            } else if (clone.morphTargetDictionary && 'Key 1' in clone.morphTargetDictionary) {
                // Default state: Key 1 = 1 (closed up, no star visible).
                clone.morphTargetInfluences[clone.morphTargetDictionary['Key 1']] = 1.0;
            }
        }
        return clone;
    }

    function buildStarAssembly(baseNode, containerNode, starNode, scale) {
        // Group origin is the container's own geometric/mass center (its
        // world-space bounding box center), not the base mesh's arbitrary
        // pivot - that's what the group is positioned/held/thrown by, so it
        // should be anchored on the star container, not wherever the
        // handle's pivot happens to sit.
        const center = meshWorldCenter(containerNode);
        if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(center.z)) {
            // Belt-and-suspenders: bail out instead of letting a NaN
            // position/matrix leak into the scene graph if the base geometry
            // itself is ever the problem too - that's what was silently
            // breaking spawn position and ledge grabs elsewhere in the level.
            console.error(`buildStarAssembly: "${containerNode.name}" has a non-finite bounding box - skipping this instance.`);
            return null;
        }
        const group = new THREE.Group();

        const baseClone = cloneMeshClean(baseNode);
        baseClone.position.copy(baseNode.position).sub(center).multiplyScalar(scale);
        baseClone.scale.multiplyScalar(scale);

        const containerClone = cloneMeshClean(containerNode);
        containerClone.position.copy(containerNode.position).sub(center).multiplyScalar(scale);
        containerClone.scale.multiplyScalar(scale);
        // Fancy shader attempts (fresnel, additive glow) didn't land - kept
        // simple instead: the original material, just made see-through.
        containerClone.material = (Array.isArray(containerNode.material) ? containerNode.material[0] : containerNode.material).clone();
        containerClone.material.transparent = true;
        containerClone.material.opacity = 0.5;
        containerClone.material.side = THREE.DoubleSide;
        containerClone.material.depthWrite = false;

        // Star's own authored position in the file is off to the side (not
        // meaningful - it's shared between the key and lock containers and
        // meant to be hand-placed into whichever one it belongs to). What the
        // model actually wants is the star sitting at the container's own
        // geometric center of mass, as a real child of the container.
        // Raw local vertex-space center of the container mesh - i.e. already
        // the correct frame for a child's local position once containerClone
        // becomes its parent, so no extra scale/offset math against
        // containerClone's transform is needed here. Computed the same
        // morph-target-ignoring way as meshWorldCenter (just without the
        // matrixWorld transform) for the same reason - geometry.computeBoundingBox()
        // would otherwise pick up LockStarContainer's corrupted shape key.
        const containerLocalCenter = (() => {
            const posAttr = containerNode.geometry.attributes.position;
            const box = new THREE.Box3();
            const v = new THREE.Vector3();
            for (let i = 0; i < posAttr.count; i++) box.expandByPoint(v.fromBufferAttribute(posAttr, i));
            return box.getCenter(new THREE.Vector3());
        })();

        const starClone = cloneMeshClean(starNode);
        starClone.position.copy(containerLocalCenter);
        // Star's own original scale is divided by the container's original
        // scale so that once containerClone's scale (container.scale *
        // normalize scale) applies on top via the parent-child transform,
        // the star ends up at exactly star.scale * normalize scale - the
        // same absolute size every other part gets.
        starClone.scale.copy(starNode.scale).divide(containerNode.scale);
        // Flat/unlit material: since the star billboards toward the camera
        // every frame (see activeKeyStars in the main loop), its normals spin
        // independently of the rest of the key, which would make a lit
        // material's shading flicker unnaturally as it rotates. A flat color
        // sidesteps that and just always reads as the star's true color.
        const starSrcMat = Array.isArray(starNode.material) ? starNode.material[0] : starNode.material;
        starClone.material = new THREE.MeshBasicMaterial({
            color: starSrcMat && starSrcMat.color ? starSrcMat.color.clone() : 0xffffff,
            map: starSrcMat && starSrcMat.map ? starSrcMat.map : null,
            transparent: true,
            alphaTest: 0.5
        });
        containerClone.add(starClone);

        [baseClone, containerClone, starClone].forEach(m => { m.castShadow = true; m.receiveShadow = true; });
        group.add(baseClone, containerClone);
        group.scale.setScalar(window.keyScale);
        activeKeyStars.push(starClone);
        activeKeyGroups.push(group);
        group.userData.containerMesh = containerClone; // for revealLockStar()

        // How far below the group's own origin (the container's mass
        // center) the model's lowest point sits, in the group's local space
        // BEFORE the window.keyScale multiplier - callers use this to sit
        // the object exactly on the ground instead of guessing a Y value,
        // since the origin moved off the base mesh's pivot onto the
        // container's center.
        const combinedBox = safeWorldBox(baseNode).union(safeWorldBox(containerNode));
        group.userData.floorOffset = (center.y - combinedBox.min.y) * scale;

        return group;
    }

    function createKeyInstance() {
        if (!keyTemplateParts) return null;
        const { keyBase, keyStarContainer, star, scale } = keyTemplateParts;
        return buildStarAssembly(keyBase, keyStarContainer, star, scale);
    }

    function createLockInstance() {
        if (!keyTemplateParts || !keyTemplateParts.lockBase || !keyTemplateParts.lockStarContainer) return null;
        const { lockBase, lockStarContainer, star, scale } = keyTemplateParts;
        return buildStarAssembly(lockBase, lockStarContainer, star, scale);
    }

    // Animates the lock's "Key1" shape key from its current influence down
    // to 0 over `duration` seconds, revealing the star inside - meant to run
    // once the real "key inserted into lock" gameplay trigger exists. No
    // such trigger is wired up yet, so for now this is only reachable via
    // the L key debug binding below. No-ops safely if Key1 isn't live
    // (e.g. still stripped because the shape key's source data has NaN).
    const activeMorphTweens = [];
    function revealLockStar(lockGroup, duration = 0.4) {
        const mesh = lockGroup && lockGroup.userData.containerMesh;
        if (!mesh || !mesh.morphTargetDictionary || !('Key 1' in mesh.morphTargetDictionary)) return;
        const idx = mesh.morphTargetDictionary['Key 1'];
        activeMorphTweens.push({ mesh, idx, from: mesh.morphTargetInfluences[idx], to: 0, duration, elapsed: 0 });
    }

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
        const spawnKey = !!jarMesh.userData.containsKey;
        const spawnPos = jarMesh.position.clone();
        levelGroup.remove(jarMesh);
        scene.remove(jarMesh);

        if (spawnKey) {
            const keyGroup = createKeyInstance();
            if (keyGroup) {
                keyGroup.position.copy(spawnPos);
                keyGroup.userData.isCarryable = true;
                keyGroup.userData.isKey = true;
                levelGroup.add(keyGroup);
                collidables.push(keyGroup);
                const carryKey = { mesh: keyGroup, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
                carryables.push(carryKey); addCarryableDebugHelper(carryKey);
            }
        }
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

    const _hangBox = new THREE.Box3();
    const _hangObstacleBox = new THREE.Box3();
    function isVerticalSpaceClear(x, bottomY, topY, z, excludeObj, excludeObj2, label) {
        const bodyRadius = 0.45;
        _hangBox.min.set(x - bodyRadius, bottomY, z - bodyRadius);
        _hangBox.max.set(x + bodyRadius, topY, z + bodyRadius);
        for (let k = 0; k < collidables.length; k++) {
            const obj = collidables[k];
            if (obj === ground || obj === excludeObj || obj === excludeObj2) continue;
            getObstacleBox(obj, _hangObstacleBox);
            if (_hangBox.intersectsBox(_hangObstacleBox)) {
                if (label) console.log(`[ledge-debug] ${label} BLOCKED by`, obj.name || obj.uuid, 'checkBox', _hangBox.min.toArray(), _hangBox.max.toArray(), 'obstacleBox', _hangObstacleBox.min.toArray(), _hangObstacleBox.max.toArray(), 'excluded were', excludeObj && (excludeObj.name || excludeObj.uuid), excludeObj2 && (excludeObj2.name || excludeObj2.uuid));
                return false;
            }
        }
        if (label) console.log(`[ledge-debug] ${label} CLEAR`, 'checkBox', _hangBox.min.toArray(), _hangBox.max.toArray(), 'excluded were', excludeObj && (excludeObj.name || excludeObj.uuid), excludeObj2 && (excludeObj2.name || excludeObj2.uuid));
        return true;
    }
    function findNearestObstacle(x, y, z, maxDist) {
        const point = new THREE.Vector3(x, y, z);
        for (let k = 0; k < collidables.length; k++) {
            const obj = collidables[k];
            if (obj === ground) continue;
            getObstacleBox(obj, _hangObstacleBox);
            if (_hangObstacleBox.distanceToPoint(point) < maxDist) return obj;
        }
        return null;
    }
    function isHangPositionClear(x, groupY, z, excludeObj, excludeObj2) {
        return isVerticalSpaceClear(x, groupY, groupY + 1.85 + 0.15, z, excludeObj, excludeObj2, 'HANG');
    }
    function isStandPositionClear(x, feetY, z, excludeObj, excludeObj2) {
        return isVerticalSpaceClear(x, feetY, feetY + 1.8, z, excludeObj, excludeObj2, 'STAND');
    }

    function buildLevelFromJson(data) {
        while(levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
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

    function buildNarrowLedgeTestRig(x, z, gap) {
        const lower = new THREE.Mesh(boxGeoTemplate, platMat);
        lower.position.set(x, cubeSize/2, z);
        lower.castShadow = true; lower.receiveShadow = true;
        levelGroup.add(lower); collidables.push(lower);

        const upper = new THREE.Mesh(boxGeoTemplate, platMat);
        upper.position.set(x, cubeSize + gap + cubeSize/2, z);
        upper.castShadow = true; upper.receiveShadow = true;
        levelGroup.add(upper); collidables.push(upper);
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
            mesh.name = 'stair_' + i;
            mesh.castShadow = true; mesh.receiveShadow = true;
            levelGroup.add(mesh); collidables.push(mesh);
        }

        buildNarrowLedgeTestRig(15, 8, 1.2);
        buildNarrowLedgeTestRig(20, 8, 0.4);
        buildNarrowLedgeTestRig(25, 8, 0);

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
        const carry1 = { mesh: smallBox, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
        carryables.push(carry1); addCarryableDebugHelper(carry1);

        const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.0, 16);
        const cyl = new THREE.Mesh(cylGeo, smallMat);
        cyl.position.set(-4, 0.5, 0);
        cyl.castShadow = true; cyl.receiveShadow = true;
        cyl.userData.isCarryable = true;
        levelGroup.add(cyl); collidables.push(cyl);
        const carry2 = { mesh: cyl, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
        carryables.push(carry2); addCarryableDebugHelper(carry2);

        const sphGeo = new THREE.SphereGeometry(0.5, 16, 16);
        const sph = new THREE.Mesh(sphGeo, smallMat);
        sph.position.set(-2, 0.5, 0);
        sph.castShadow = true; sph.receiveShadow = true;
        sph.userData.isCarryable = true;
        levelGroup.add(sph); collidables.push(sph);
        const carry3 = { mesh: sph, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
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
                    // Exactly one jar in the grid holds the key - checked in
                    // destroyJarCarryable once this one actually shatters.
                    if (r === 0 && c === 0) jarMesh.userData.containsKey = true;
                    levelGroup.add(jarMesh);
                    collidables.push(jarMesh);
                    const carryJar = { mesh: jarMesh, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
                    carryables.push(carryJar); addCarryableDebugHelper(carryJar);
                }
            }
        }

        star.position.set(0, (5 * cubeSize * 0.9) + cubeSize + 2, -10 - 5 * cubeSize); star.visible = true;
        char.group.position.set(0, cubeSize, 0); char.group.rotation.y = Math.PI;
        stairsLevelBuilt = true;

        // Runs last, after everything the player actually needs (spawn
        // position, stairs, ledges) is already in place - if anything about
        // the key/lock props throws, it can no longer take the rest of the
        // level down with it (that's what was leaving the player stuck
        // inside the start box with no ledge grabs: an exception here used
        // to abort the rest of buildStairsLevel before it ran).
        try {
            spawnTestKeyAndLock();
        } catch (e) {
            console.error('spawnTestKeyAndLock failed:', e);
        }
    }

    async function buildLevel() {
        while(levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
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

        if (window.sacks) {
            window.sacks.forEach(s => {
                const c = s.getCollider ? s.getCollider() : null;
                if (c && !collidables.includes(c)) collidables.push(c);
            });
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

            if (network) {
                const heldObj = carryables.find(c => c.mesh === heldCarryable);
                if (heldObj) network.sendDropEvent(heldObj.netId, dropTargetPos, dropTargetRot);
            }

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

                if (network) network.sendThrowEvent(cObj.netId, cObj.mesh.position, cObj.mesh.quaternion, cObj.velocity);
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
                if (network) network.sendThrowEvent(cObj.netId, cObj.mesh.position, cObj.mesh.quaternion, cObj.velocity);
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
    let networkStateName = 'idle';
    let networkCarryUpper = false;
    let lastLedgeState = false, lockedHintAngle = null, ledgeGrabTimer = 0, ledgeGrabCooldown = 0, ledgeJumpMultiplier = 1.0, landingTimer = 0, initialLandingTimer = 0;
    let ledgeOffset = 0.06, ledgeMoveLocked = false, ledgeSidewaysGesture = false, baseLandingAnimDuration = 0.25, climbTransitionDuration = 0.20;
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
    window.ragdollLateralStiffness = 0.0;
    window.ragdollDamping = 0.98;
    window.chargeStreakOpacity = 0.3;
    window.chargeStreakBaseRadius = 0.55;
    window.chargeStreakRadiusSpread = 0.5;
    window.punchParticleScale = 0.7;
    window.punchHitTime = 0.42;
    window.chargePunchHitTime = 0.28;
    window.comboHit1Time = 0.15;
    window.chargePunchForce = 80.0;
    window.chargePunchKnockback = 15.0;
    window.chargeAttackProjectileSpeed = 5.0;
    window.chargeAttackProjectileFadeRate = 3.0;
    window.chargeAttackProjectileHitCutoff = 0.3;
    window.playerStagger = 100.0;
    window.playerStaggerMax = 100.0;
    window.playerStaggerRegenRate = 20.0;
    window.playerStaggerRegenDelay = 2.5;
    window.playerStaggerRegenCooldown = 0;
    const STAMINA_MAX = 100, REGEN_RATE = 25, HANG_DRAIN = 2, JUMP_COST = 8, LEDGE_JUMP_COST = 12, LEDGE_MOVE_COST = 4, CLIMB_COST = 4;


    function handleJump() {
        if (char.isRagdoll || char.isStandingUp || isSlipping || isClimbingUp) return;
        if (isHoldingMovable) {
            isHoldingMovable = false; heldBox = null; holdBtn.innerText = 'HOLD';
            document.getElementById('base-left').classList.remove('hold-mode');
        }
        if (stamina < JUMP_COST || landingTimer > 0) return;
        if (isGrounded && !isLedgeGrabbing && !isClimbingUp) { stamina -= JUMP_COST; yVelocity = 10; isGrounded = false; landingTimer = 0; }
        // Used to also fire whenever airborne with ledgeGrabCooldown > 0.1,
        // regardless of isLedgeGrabbing - meant to let a jump-away-from-ledge
        // keep responding to jump briefly, but it let this whole climb-attempt
        // branch run using whatever ledgeTarget was left over from the ledge
        // you just left, since nothing here re-detects a new wall. Jump right
        // after mantling (isGrounded, cooldown still ticking) would launch you
        // up, immediately re-enter this branch mid-air, and re-mantle to that
        // same stale ledgeTarget - the "climbs back onto where it just was,
        // seemingly forever" bug. Only a genuinely active hang should trust
        // ledgeTarget enough to attempt a climb from it.
        else if (isLedgeGrabbing) {
            if (stamina < LEDGE_JUMP_COST) return;
            const curX = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
            const curY = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
            const mag = Math.sqrt(curX * curX + curY * curY);
            const keyboardDriven = Math.abs(input.left.x) <= 0.1 && Math.abs(input.left.y) <= 0.1;
            let isHoldingUp = false;

            // Same fix as the main ledge-hang loop below: a keyboard W-press
            // has no analog angle, so it shouldn't be judged against the
            // camera-relative uiUp cone (which it can easily fall just short
            // of depending on camera rotation) - it's an unambiguous climb
            // intent on its own.
            if (keyboardDriven) {
                isHoldingUp = keys.w;
            } else if (mag > 0.3) {
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                let refAngle = lockedHintAngle === null ? (Math.PI - Math.atan2(_tempVec1.x, _tempVec1.z) + cameraTheta) : lockedHintAngle;
                const stickVec = new THREE.Vector2(curX, curY).normalize();
                const uiUp = new THREE.Vector2(Math.sin(refAngle), -Math.cos(refAngle)).normalize();
                if (stickVec.dot(uiUp) > 0.4) isHoldingUp = true;
            }

            // Stamina is only spent once the action actually happens - it used
            // to be deducted unconditionally up front, so pressing jump while
            // hanging somewhere unclimbable (isStandPositionClear failing)
            // burned LEDGE_JUMP_COST for nothing, every single press.
            if (isHoldingUp || mag < 0.3) {
                const climbFwd = _tempVec1.set(0, 0, 1).applyQuaternion(char.group.quaternion);
                const standX = ledgeTarget.x + climbFwd.x * 0.25;
                const standZ = ledgeTarget.z + climbFwd.z * 0.25;
                const standFeetY = ledgeTarget.y + 0.05;
                const clear = isStandPositionClear(standX, standFeetY, standZ, null);
                if (clear) {
                    stamina -= LEDGE_JUMP_COST;
                    isLedgeGrabbing = false; isClimbingUp = true; lockedHintAngle = null; char.climbFinished = false;
                }
            } else {
                stamina -= LEDGE_JUMP_COST;
                isLedgeGrabbing = false; isClimbingUp = false; yVelocity = 10 * ledgeJumpMultiplier;
                _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                jumpMomentum.copy(_tempVec1.negate().multiplyScalar(15 * ledgeJumpMultiplier));
                lockedHintAngle = null; ledgeGrabCooldown = 0.5;
            }
        }
    }

    window.addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (keys.hasOwnProperty(k)) keys[k] = true; if (e.code === 'Space') handleJump(); if (k === 'l' && window.debugTestLockGroup) revealLockStar(window.debugTestLockGroup); });
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
    const rayDown = new THREE.Raycaster(), rayFwd = new THREE.Raycaster(), xrayRaycaster = new THREE.Raycaster();
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
        { id: 'collider-density-slider', vId: 'collider-density-val', func: v => char.updateColliderDensity(v), fix: 0 },
        { id: 'ragdoll-lateral-stiffness-slider', vId: 'ragdoll-lateral-stiffness-val', func: v => window.ragdollLateralStiffness = v },
        { id: 'ragdoll-damping-slider', vId: 'ragdoll-damping-val', func: v => window.ragdollDamping = v },
        { id: 'charge-streak-opacity-slider', vId: 'charge-streak-opacity-val', func: v => window.chargeStreakOpacity = v },
        { id: 'charge-streak-base-radius-slider', vId: 'charge-streak-base-radius-val', func: v => window.chargeStreakBaseRadius = v },
        { id: 'charge-streak-radius-spread-slider', vId: 'charge-streak-radius-spread-val', func: v => window.chargeStreakRadiusSpread = v },
        { id: 'punch-particle-scale-slider', vId: 'punch-particle-scale-val', func: v => window.punchParticleScale = v },
        { id: 'punch-hit-time-slider', vId: 'punch-hit-time-val', func: v => window.punchHitTime = v },
        { id: 'charge-punch-hit-time-slider', vId: 'charge-punch-hit-time-val', func: v => window.chargePunchHitTime = v },
        { id: 'combo-hit1-time-slider', vId: 'combo-hit1-time-val', func: v => window.comboHit1Time = v },
        { id: 'charge-punch-force-slider', vId: 'charge-punch-force-val', func: v => window.chargePunchForce = v },
        { id: 'charge-punch-knockback-slider', vId: 'charge-punch-knockback-val', func: v => window.chargePunchKnockback = v },
        { id: 'charge-proj-speed-slider', vId: 'charge-proj-speed-val', func: v => window.chargeAttackProjectileSpeed = v },
        { id: 'charge-proj-fade-slider', vId: 'charge-proj-fade-val', func: v => window.chargeAttackProjectileFadeRate = v },
        { id: 'charge-proj-hit-cutoff-slider', vId: 'charge-proj-hit-cutoff-val', func: v => window.chargeAttackProjectileHitCutoff = v }
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

    window.toonOutlineEnabled = false;
    window.toonOutlineThickness = 0.02;
    document.getElementById('toggle-toon-outline').addEventListener('change', e => {
        window.toonOutlineEnabled = e.target.checked;
        char.setOutlineEnabled(e.target.checked);
    });
    document.getElementById('toon-outline-thickness-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.toonOutlineThickness = v;
        document.getElementById('toon-outline-thickness-val').textContent = v.toFixed(3);
        char.setOutlineThickness(v);
    });

    // Phong/Lambert shading test: static level geometry (ground, stairs,
    // boxes, obstacles - anything in `collidables` that isn't carryable/
    // movable) swaps to Lambert; the player, remote players, and the AI bot
    // (all "dynamic") swap to Phong via their own setDynamicShading. Same
    // swap-cached-material-on-mesh pattern as Character's, so toggling back
    // to toon is instant and the two looks can be compared live.
    window.phongLambertEnabled = false;
    function setStaticShading(enabled) {
        collidables.forEach(mesh => {
            if (!mesh.isMesh) return;
            const isToon = mesh.material && mesh.material.isMeshToonMaterial;
            if (!isToon && !mesh.userData.toonMat) return;
            if (mesh.userData.isMovable || mesh.userData.isCarryable) return; // handled as dynamic elsewhere
            if (!mesh.userData.toonMat) mesh.userData.toonMat = mesh.material;
            if (enabled) {
                if (!mesh.userData.lambertMat) {
                    const src = mesh.userData.toonMat;
                    mesh.userData.lambertMat = new THREE.MeshLambertMaterial({ color: src.color.clone(), map: src.map || null });
                }
                mesh.material = mesh.userData.lambertMat;
            } else {
                mesh.material = mesh.userData.toonMat;
            }
        });
    }
    // Carryables (boxes/cylinder/sphere/jars) are "dynamic" too - excluded
    // from setStaticShading above via isMovable/isCarryable specifically so
    // they'd land here instead.
    function setCarryablesShading(enabled) {
        carryables.forEach(c => {
            const mesh = c.mesh;
            const isToon = mesh.material && mesh.material.isMeshToonMaterial;
            if (!isToon && !mesh.userData.toonMat) return;
            if (!mesh.userData.toonMat) mesh.userData.toonMat = mesh.material;
            if (enabled) {
                if (!mesh.userData.phongMat) {
                    const src = mesh.userData.toonMat;
                    mesh.userData.phongMat = new THREE.MeshPhongMaterial({ color: src.color.clone(), map: src.map || null, shininess: 30 });
                }
                mesh.material = mesh.userData.phongMat;
            } else {
                mesh.material = mesh.userData.toonMat;
            }
        });
    }
    function setPhongLambertEnabled(enabled) {
        window.phongLambertEnabled = enabled;
        setStaticShading(enabled);
        setCarryablesShading(enabled);
        char.setDynamicShading(enabled);
        network.remotes.forEach(avatar => { if (avatar.setDynamicShading) avatar.setDynamicShading(enabled); });
        if (aiBot) aiBot.setDynamicShading(enabled);
        if (window.sacks) window.sacks.forEach(s => { if (s.setDynamicShading) s.setDynamicShading(enabled); });
    }
    document.getElementById('toggle-phong-lambert').addEventListener('change', e => setPhongLambertEnabled(e.target.checked));

    document.getElementById('light-intensity-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        dirLight.intensity = v;
        document.getElementById('light-intensity-val').textContent = v.toFixed(2);
    });
    document.getElementById('fill-light-intensity-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        fillLight.intensity = v;
        document.getElementById('fill-light-intensity-val').textContent = v.toFixed(2);
    });

    document.getElementById('key-scale-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.keyScale = v;
        document.getElementById('key-scale-val').textContent = v.toFixed(2);
        activeKeyGroups.forEach(g => g.scale.setScalar(v));
    });

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

        char.updateHitFlash(delta);

        // Hidden poise/stagger pool (see MultiplayerClient._applyPunchEvent):
        // regenerates back toward full once a bit of time has passed since
        // the last non-ragdoll hit, so it only tracks a "flurry" of recent
        // punches rather than permanently wearing the player down.
        if (window.playerStaggerRegenCooldown > 0) {
            window.playerStaggerRegenCooldown -= delta;
        } else if (window.playerStagger < window.playerStaggerMax) {
            window.playerStagger = Math.min(window.playerStaggerMax, window.playerStagger + window.playerStaggerRegenRate * delta);
        }

        // Used to live inside Character.prototype.animate() in the HTML file,
        // which the main loop below stops calling entirely while the local
        // player is ragdolled/standing up - freezing every hit-effect/swing
        // particle in the scene (including ones spawned by remote punches)
        // until the local player recovered. Runs here unconditionally instead.
        if (window.hitEffects) {
            for (let i = window.hitEffects.length - 1; i >= 0; i--) {
                const fx = window.hitEffects[i];
                if (fx.mesh) {
                    fx.life -= delta * 5.0;
                    const t = Math.max(0, fx.life);
                    fx.mesh.scale.setScalar(2.0 - t);
                    fx.mesh.material.opacity = t;
                    if (fx.life <= 0) {
                        if (window.gameScene) window.gameScene.remove(fx.mesh);
                        fx.mesh.geometry.dispose();
                        fx.mesh.material.dispose();
                        window.hitEffects.splice(i, 1);
                    }
                } else {
                    fx.life -= delta * 1.2;
                    const t = Math.max(0, fx.life);
                    fx.visibleMesh.material.opacity = t * 1.0;
                    fx.hiddenMesh.material.opacity = t * 0.25;
                    if (fx.life <= 0) {
                        if (window.gameScene) {
                            window.gameScene.remove(fx.visibleMesh);
                            window.gameScene.remove(fx.hiddenMesh);
                        }
                        fx.visibleMesh.geometry.dispose();
                        fx.visibleMesh.material.dispose();
                        fx.hiddenMesh.material.dispose();
                        window.hitEffects.splice(i, 1);
                    }
                }
            }
        }

        if (window.speedParticles) {
            for (let i = window.speedParticles.length - 1; i >= 0; i--) {
                const sp = window.speedParticles[i];
                sp.life -= delta * 3.5;
                const t = Math.max(0, sp.life);
                sp.mesh.material.opacity = t * 0.85;
                if (sp.life <= 0) {
                    if (window.gameScene) window.gameScene.remove(sp.mesh);
                    sp.mesh.material.dispose();
                    window.speedParticles.splice(i, 1);
                }
            }
        }

        // Star inside the key always faces the camera - unlike the charge
        // projectile below, it's nested inside a group that itself moves/
        // rotates (carried, thrown, sitting in the level), so its target
        // world rotation has to be converted into a LOCAL rotation relative
        // to that parent instead of just copying camera.quaternion directly.
        activeKeyStars.forEach(star => {
            if (!star.parent) return;
            star.parent.getWorldQuaternion(_tempQuat);
            star.quaternion.copy(_tempQuat.invert().multiply(camera.quaternion));
        });

        for (let i = activeMorphTweens.length - 1; i >= 0; i--) {
            const t = activeMorphTweens[i];
            t.elapsed += delta;
            const p = Math.min(1, t.elapsed / t.duration);
            t.mesh.morphTargetInfluences[t.idx] = t.from + (t.to - t.from) * p;
            if (p >= 1) activeMorphTweens.splice(i, 1);
        }

        if (window.chargeAttackProjectiles) {
            for (let i = window.chargeAttackProjectiles.length - 1; i >= 0; i--) {
                const cp = window.chargeAttackProjectiles[i];
                cp.mesh.position.addScaledVector(cp.velocity, delta);
                // Billboard toward the camera every frame - a flat plane kept
                // at a fixed travel-direction rotation goes edge-on (nearly
                // invisible) whenever viewed from the side, so it's re-faced
                // to the camera instead, the same way sprite-based particles
                // always read as having "volume" regardless of view angle.
                cp.mesh.quaternion.copy(camera.quaternion);
                // Spin it around that camera-facing axis so the sprite's own
                // "up" (its wide/rounded end, per the source texture) points
                // along however the travel direction projects onto the
                // screen right now - otherwise every projectile shows the
                // same fixed orientation no matter which way it's flying.
                const camRight = _tempVec1.set(1, 0, 0).applyQuaternion(camera.quaternion);
                const camUp = _tempVec2.set(0, 1, 0).applyQuaternion(camera.quaternion);
                const screenAngle = Math.atan2(cp.velocity.dot(camRight), cp.velocity.dot(camUp));
                cp.mesh.rotateZ(-screenAngle);
                const fadeRate = window.chargeAttackProjectileFadeRate !== undefined ? window.chargeAttackProjectileFadeRate : 1.3;
                cp.life -= delta * fadeRate;
                cp.mesh.material.opacity = Math.max(0, cp.life);

                // Same targets/reaction detectMeleeHits already lands with a
                // mature charge punch (sandbags, remote players via a
                // targeted send), just checked against the flying projectile
                // instead of the puncher's own hand each frame - so the
                // charge punch's reach isn't capped at melee range anymore.
                // Hit checks stop once life drops below hitCutoff (a separate,
                // earlier threshold than full removal at life<=0) - without
                // it, a projectile that's already visually almost gone could
                // still land a hit slightly ahead of where it looks like
                // nothing is there anymore.
                let consumed = false;
                const hitCutoff = window.chargeAttackProjectileHitCutoff !== undefined ? window.chargeAttackProjectileHitCutoff : 0.4;
                if (cp.life > hitCutoff) {
                    const chargeHitRadius = 0.9;
                    const impactDir = _tempVec3.copy(cp.velocity).normalize();
                    const chargeForce = window.chargePunchForce !== undefined ? window.chargePunchForce : 80;

                    if (window.sacks) {
                        for (const sack of window.sacks) {
                            if (sack.checkHit(cp.mesh.position, chargeHitRadius)) {
                                sack.applyHit(impactDir, chargeForce);
                                if (window.createHandHitEffect) window.createHandHitEffect(cp.mesh.position);
                                if (window.spawnHitEffect) window.spawnHitEffect(cp.mesh.position.clone());
                                if (network) {
                                    const sackIdx = window.sacks.indexOf(sack);
                                    if (sackIdx !== -1) network.sendSandbagHitEvent(sackIdx, impactDir, chargeForce);
                                }
                                consumed = true;
                                break;
                            }
                        }
                    }

                    if (!consumed && window.multiplayerClient) {
                        window.multiplayerClient.remotes.forEach((avatar, remoteId) => {
                            if (consumed || !avatar.isLoaded || avatar.isRagdoll) return;
                            const avatarHitPos = avatar.getHitReferencePoint();
                            if (avatarHitPos.distanceTo(cp.mesh.position) < chargeHitRadius + 1.0) {
                                if (window.createHandHitEffect) window.createHandHitEffect(cp.mesh.position);
                                if (window.spawnHitEffect) window.spawnHitEffect(cp.mesh.position.clone());
                                window.multiplayerClient.sendPunchEvent(remoteId, impactDir, chargeForce, cp.mesh.position);
                                consumed = true;
                            }
                        });
                    }
                }

                if (consumed || cp.life <= 0) {
                    if (window.gameScene) window.gameScene.remove(cp.mesh);
                    cp.mesh.geometry.dispose();
                    cp.mesh.material.dispose();
                    window.chargeAttackProjectiles.splice(i, 1);
                }
            }
        }

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
                const isSteppingUp = highestY > char.group.position.y + 0.05;
                if (isSteppingUp && !isStandPositionClear(char.group.position.x, highestY + 0.05, char.group.position.z, null)) {
                    floorY = char.group.position.y;
                } else {
                    floorY = highestY;
                    if (groundNormal.angleTo(_upVec) > Math.PI * 0.22 && isGrounded && !isLedgeGrabbing && !isClimbingUp) {
                        isSliding = true;
                        char.group.position.add(_tempVec3.set(groundNormal.x, 0, groundNormal.z).normalize().multiplyScalar(15 * delta));
                    }
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

        const targetPos = _shooterTargetPos.copy(char.group.position).setY(char.group.position.y + 1.0);
        shooters.forEach(s => s.update(delta, targetPos, scene));

        for (let i = projectiles.length - 1; i >= 0; i--) {
            let p = projectiles[i];
            p.lifespan -= delta;
            p.mesh.position.addScaledVector(p.velocity, delta);

            const projRadius = p.radius || 0.3;
            const hitRadius = 0.9 + projRadius;

            if (p.sender && isProjectileConsumedByCloserPlayer(p.mesh.position, p.sender.mesh.position, targetPos, hitRadius)) {
                scene.remove(p.mesh); projectiles.splice(i, 1);
                continue;
            }

            if (!char.isRagdoll && p.mesh.position.distanceTo(targetPos) < hitRadius) {
                const flashStrengthByIntensity = { low: 0.5, medium: 0.9, medium_high: 1.4, high: 2.5 };
                const hitStrength = flashStrengthByIntensity[p.intensity] || 2.5;
                char.triggerHitFlash(hitStrength);
                if (network) network.sendHitEvent(hitStrength);
                if (p.intensity === 'high') {
                    char.initRagdoll(p.velocity, p.intensity);
                    if (network) network.sendRagdollEvent(p.velocity, p.intensity);
                    isLedgeGrabbing = false; isClimbingUp = false; yVelocity = 0;
                } else {
                    char.applyProceduralRecoil(p.velocity, p.intensity);
                    if (network) network.sendRecoilEvent(p.velocity, p.intensity);
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
            const ragdollHipsP = char.ragdollParticles.find(p => p.id === 'hips');
            // Ragdoll's own per-frame displacement is capped (see maxDisp in
            // ragdoll_physics.js), so a hit from up high can still be well
            // above the floor once ragdollMaxTime elapses. beginStandUp
            // re-anchors the group to roughly the current hips height and
            // lets the standup animation's crossfade cover the remaining gap -
            // fine for a few inches, but over a real height difference that
            // crossfade reads as an unnaturally slow float down instead of a
            // fall. Keep simulating the actual (capped-speed but continuous)
            // ragdoll fall until they're actually near the ground, with a
            // generous absolute cap so a bad floor read can't ragdoll forever.
            const nearFloor = !ragdollHipsP || (ragdollHipsP.pos.y - floorY) < 1.0;
            if (char.ragdollTimer > char.ragdollMaxTime && (nearFloor || char.ragdollTimer > char.ragdollMaxTime + 5.0)) {
                char.beginStandUp(ragdollHipsP ? Math.max(0, ragdollHipsP.pos.y - 0.5) : 0);
                if (network) network.sendStandupEvent(char.group.position, char.group.quaternion);
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
            networkStateName = 'climb';

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
                char.climbLockedWorldPos = null;
                char.smoothedArrowPos = new THREE.Vector3(0, 0.05, 0);
                if (char.playerArrowGroup) char.playerArrowGroup.position.copy(char.smoothedArrowPos);
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

            // Checked every frame while hanging (not just at the moment the
            // player pushes up) so the CLIMB hint greys out proactively -
            // e.g. the 3 stacked cube-pairs test level, where the ledge you'd
            // stand on top of is already occupied and a climb attempt would
            // otherwise just silently fail with no visual explanation why.
            const climbStandX = ledgeTarget.x + charFwd.x * 0.25;
            const climbStandZ = ledgeTarget.z + charFwd.z * 0.25;
            const climbStandFeetY = ledgeTarget.y + 0.05;
            const canClimbHere = isStandPositionClear(climbStandX, climbStandFeetY, climbStandZ, null);
            const climbHintEl = document.getElementById('ledge-hint-climb');
            const dropHintEl = document.getElementById('ledge-hint-drop');
            if (climbHintEl) climbHintEl.classList.toggle('blocked', !canClimbHere || ledgeSidewaysGesture);
            if (dropHintEl) dropHintEl.classList.toggle('blocked', ledgeSidewaysGesture);

            const actualRgt = _tempVec3.set(1,0,0).applyQuaternion(char.group.quaternion);
            let hint = Math.PI - Math.atan2(charFwd.x, charFwd.z) + cameraTheta;
            // The hint arrow always tracks the character's live facing now -
            // it used to freeze the instant the stick was pushed (matching
            // lockedHintAngle below) and stay stuck showing the pre-turn
            // direction for as long as the stick was held, e.g. while
            // shimmying around a ledge corner. lockedHintAngle itself still
            // stays frozen for the actual push-direction math right below,
            // so a mid-hold facing change can't reinterpret an already-in-
            // progress push as a new climb/drop - only the visual indicator
            // is now live; releasing and pushing again still remaps normally.
            document.getElementById('ledge-hint-container').style.transform = `rotate(${hint}rad)`;

            let currentPushS = 0;
            if (moveMag < 0.1) { ledgeMoveLocked = false; ledgeSidewaysGesture = false; }

            if (moveMag > 0.1 && !isSlipping) {
                if (lockedHintAngle === null) lockedHintAngle = hint;
                const stickVec = new THREE.Vector2(curX, curY).normalize(), uiUp = new THREE.Vector2(Math.sin(lockedHintAngle), -Math.cos(lockedHintAngle)).normalize(), uiRgt = new THREE.Vector2(Math.cos(lockedHintAngle), Math.sin(lockedHintAngle)).normalize();
                const pCD = stickVec.dot(uiUp), pS = stickVec.dot(uiRgt);
                console.log(`[ledge-input-debug] keys w/a/s/d=${keys.w}/${keys.a}/${keys.s}/${keys.d} curX=${curX.toFixed(2)} curY=${curY.toFixed(2)} lockedHintAngle=${(lockedHintAngle*180/Math.PI).toFixed(1)}deg pCD=${pCD.toFixed(2)} pS=${pS.toFixed(2)} sidewaysGesture=${ledgeSidewaysGesture}`);

                if (!ledgeMoveLocked) currentPushS = pS;

                // Once a sideways shimmy has actually started this hold, climb/
                // drop stay locked out for the rest of it (even if the stick's
                // angle later drifts back toward vertical while still held) -
                // otherwise, as the controller's rotating hint kept turning to
                // match the character mid-shimmy (see the live-rotation comment
                // above), climb/drop could end up right under a finger that
                // never moved, firing from a push the player only meant as
                // "keep walking sideways." Release below the deadzone (moveMag
                // < 0.1 above) to re-arm climb/drop.
                // Threshold raised from 0.1: keyboard only has 8 fixed WASD
                // directions, so a diagonal press aimed at climb (e.g. W+A)
                // can still land up to ~22.5 degrees off the wheel's exact
                // climb angle, leaving a residual sideways component as high
                // as ~0.38 even though the player clearly meant to climb, not
                // shimmy. 0.1 caught that noise and locked climb out almost
                // every time; a real sideways-only press (just A or D, no W)
                // still lands far above this either way (~0.6-1.0).
                if (Math.abs(pS) > 0.45 && !ledgeMoveLocked) ledgeSidewaysGesture = true;

                // Keyboard can only push curX/curY at 8 fixed directions
                // (WASD combos), never at the exact angle analog stick users
                // can - and pCD's threshold is measured against lockedHintAngle,
                // which bakes in the camera's current rotation. Whichever of
                // those 8 directions "W" happens to land on can easily fall
                // just short of 0.6 depending on where the camera was facing
                // at that moment, so climb/drop would intermittently just not
                // register despite clearly pressing W/S. A bare W/S press has
                // no "angle" to it in the first place - it's an unambiguous
                // climb/drop intent - so keyboard bypasses the angle check
                // entirely instead of trying to land in the same narrow cone.
                const keyboardDriven = Math.abs(input.left.x) <= 0.1 && Math.abs(input.left.y) <= 0.1;
                if (ledgeGrabTimer > 0.15 && !ledgeSidewaysGesture) {
                    if (pCD > 0.6 || (keyboardDriven && keys.w)) {
                        const standX = ledgeTarget.x + charFwd.x * 0.25;
                        const standZ = ledgeTarget.z + charFwd.z * 0.25;
                        const standFeetY = ledgeTarget.y + 0.05;
                        if (isStandPositionClear(standX, standFeetY, standZ, null)) {
                            isLedgeGrabbing = false; isClimbingUp = true; lockedHintAngle = null; char.climbFinished = false;
                        }
                    }
                    else if (pCD < -0.6 || (keyboardDriven && keys.s)) {
                        isLedgeGrabbing = false; lockedHintAngle = null; yVelocity = -3; ledgeGrabCooldown = 0.5; 
                        const pushBackVec = _tempVec1.set(0, 0, -1).applyQuaternion(char.group.quaternion);
                        char.group.position.addScaledVector(pushBackVec, ledgeDropPushback);
                        return; 
                    }
                }
                
                if (Math.abs(pS) > 0.1 && !ledgeMoveLocked) {
                    const mDir = actualRgt.clone().multiplyScalar(-Math.sign(pS));
                    let handled = false;

                    const sideRay = new THREE.Raycaster(chest, mDir);
                    const sH = sideRay.intersectObjects(solidCollidables);
                    const isBlockedByWall = sH.length > 0 && sH[0].distance < 0.65;
                    const isBlocked = isBlockedByWall && !handled;

                    let debugBranch = 'none', debugHeightDiff = null;
                    if (sH.length > 0 && sH[0].distance < 0.8 && !isBlocked) {
                        const n = sH[0].face.normal.clone().transformDirection(sH[0].object.matrixWorld).setY(0).normalize();
                        const top = sH[0].point.clone().add(n.clone().multiplyScalar(-0.2)).setY(sH[0].point.y+2.0);
                        rayDown.set(top, _downVec); const h = rayDown.intersectObjects(solidCollidables);
                        if (h.length > 0) debugHeightDiff = Math.abs(h[0].point.y - (char.group.position.y + 1.85));
                        if (h.length > 0 && Math.abs(h[0].point.y - (char.group.position.y + 1.85)) < 0.8) {
                            const candX = sH[0].point.x + n.x*ledgeOffset;
                            const candZ = sH[0].point.z + n.z*ledgeOffset;
                            const candGroupY = h[0].point.y - 1.85;
                            const currentWallObj2 = (wallHits.length > 0 ? wallHits[0].object : null) || findNearestObstacle(char.group.position.x, char.group.position.y + 1.0, char.group.position.z, 0.6);
                            if (isHangPositionClear(candX, candGroupY, candZ, sH[0].object, currentWallObj2)) {
                                char.group.position.set(candX, candGroupY, candZ);
                                ledgeTarget.copy(h[0].point); char.group.lookAt(_tempVec3.copy(char.group.position).sub(n)); handled = true;
                                debugBranch = 'wrap-success';
                            } else debugBranch = 'wrap-blocked-by-hangPositionClear';
                        } else debugBranch = h.length > 0 ? 'wrap-failed-height' : 'wrap-failed-no-downhit';
                    } else if (isBlocked) debugBranch = 'blocked-close-wall';
                    else debugBranch = 'no-side-hit';
                    console.log(`[ledge-corner-debug] sideHit=${sH.length > 0 ? sH[0].distance.toFixed(2) : 'none'} branch=${debugBranch} heightDiff=${debugHeightDiff !== null ? debugHeightDiff.toFixed(2) : 'n/a'}`);
                    if (!handled && !(sH.length > 0 && sH[0].distance < 0.65) && !isBlocked) {
                        _tempVec3.copy(char.group.position).addScaledVector(mDir, 4*delta);
                        const currentWallObj = (wallHits.length > 0 ? wallHits[0].object : null) || findNearestObstacle(char.group.position.x, char.group.position.y + 1.0, char.group.position.z, 0.6);

                        if (isHangPositionClear(_tempVec3.x, _tempVec3.y, _tempVec3.z, currentWallObj)) {
                            char.group.position.copy(_tempVec3);

                            const freshFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion);
                            _tempVec2.copy(char.group.position).setY(char.group.position.y + 1.1);
                            rayFwd.set(_tempVec2, freshFwd);
                            const freshWallHits = rayFwd.intersectObjects(solidCollidables);
                            if (freshWallHits.length > 0 && freshWallHits[0].distance < 0.8) {
                                _tempVec3.copy(freshWallHits[0].point).addScaledVector(freshFwd, 0.2).setY(freshWallHits[0].point.y + 3.0);
                                rayDown.set(_tempVec3, _downVec);
                                const freshLedgeHits = rayDown.intersectObjects(solidCollidables);
                                if (freshLedgeHits.length > 0) ledgeTarget.copy(freshLedgeHits[0].point);
                            }
                        }
                    }
                    else if (isBlocked) currentPushS = 0;
                }
            } else lockedHintAngle = null;
            char.animate(delta, 'ledge', currentPushS !== 0 ? moveMag : 0, time, 0, currentPushS);
            networkStateName = 'hang_idle';
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

                actualSpeed = resolveRemotePlayerCollision(char.group.position, finalMoveDir, actualSpeed);

                if (!isBuilding && actualSpeed > 0.05) char.group.position.add(finalMoveDir.multiplyScalar(actualSpeed * delta));
                effectiveMoveMag = isBuilding ? 0 : actualSpeed / (window.isCarryingObj ? 4.0 : 8.0);
                char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, mAng), 15*delta);
            }

            if (!isGrounded && yVelocity < 2 && ledgeGrabCooldown <= 0 && !window.isCarryingObj && !window.isCarryStarting) {
                const chest = _tempVec2.copy(char.group.position).setY(char.group.position.y+1.1), fwd = _tempVec1.set(0,0,1).applyQuaternion(char.group.quaternion);
                rayFwd.set(chest, fwd); const wH = rayFwd.intersectObjects(solidCollidables);
                if (wH.length > 0 && wH[0].distance < 0.8) {
                    const n = wH[0].face.normal.clone().transformDirection(wH[0].object.matrixWorld).setY(0).normalize();
                    const top = wH[0].point.clone().add(fwd.clone().multiplyScalar(0.2)).setY(wH[0].point.y+3.0);
                    rayDown.set(top, _downVec); const lH = rayDown.intersectObjects(solidCollidables);
                    if (lH.length > 0 && lH[0].point.y > char.group.position.y && lH[0].point.y < char.group.position.y+3.5) {
                        const hangX = wH[0].point.x + n.x*ledgeOffset;
                        const hangZ = wH[0].point.z + n.z*ledgeOffset;
                        const hangGroupY = lH[0].point.y - 1.85;

                        if (isHangPositionClear(hangX, hangGroupY, hangZ, wH[0].object)) {
                            isLedgeGrabbing = true; ledgeMoveLocked = true;
                            if (yVelocity < -22) { isSlipping = true; slipTimer = 0; } else isSlipping = false;
                            yVelocity = 0; ledgeTarget.copy(lH[0].point);
                            char.group.position.y = hangGroupY; char.group.position.x = hangX; char.group.position.z = hangZ;
                            char.group.lookAt(_tempVec3.copy(char.group.position).sub(n)); jumpMomentum.set(0,0,0);
                            // Force-finish any still-fading-out visual offset from a
                            // previous mantle (its 0.2s climbTransitionTimer lerp,
                            // see Character.animate in the HTML file) instead of
                            // leaving it mid-transition - grabbing and mantling a new
                            // ledge quickly enough (jump right after a climb) could
                            // otherwise have the new climb's landing-position math
                            // subtract against a stale, not-yet-settled fbxModel
                            // offset, visibly popping back toward the previous climb's
                            // position once the new one finished.
                            char.climbTransitionTimer = 0;
                            if (char.fbxModel) char.fbxModel.position.set(0, 0, 0);
                        }
                    }
                }
            }
            if (jumpMomentum.lengthSq() > 0.01) { char.group.position.add(_tempVec1.copy(jumpMomentum).multiplyScalar(delta)); jumpMomentum.lerp(_tempVec2.set(0,0,0), 4*delta); }
            
            let wasGrounded = isGrounded;
            if (char.group.position.y + yVelocity*delta > floorY + 0.01) {
                yVelocity -= 30*delta;
                if (yVelocity > 0) {
                    const headOrigin = _tempVec3.copy(char.group.position).setY(char.group.position.y + 1.7);
                    const ceilRay = new THREE.Raycaster(headOrigin, _upVec);
                    const ceilHits = ceilRay.intersectObjects(solidCollidables);
                    const ceilThreshold = yVelocity*delta + 0.15;
                    if (ceilHits.length > 0 && ceilHits[0].distance < ceilThreshold + 2.0) {
                        console.log('[ceil-debug]', 'blocked=', ceilHits[0].distance < ceilThreshold, 'dist=', ceilHits[0].distance.toFixed(3), 'threshold=', ceilThreshold.toFixed(3), 'obj=', ceilHits[0].object.name || ceilHits[0].object.uuid, 'headOrigin=', headOrigin.toArray().map(n=>n.toFixed(2)), 'hitPoint=', ceilHits[0].point.toArray().map(n=>n.toFixed(2)));
                    }
                    if (ceilHits.length > 0 && ceilHits[0].distance < ceilThreshold) yVelocity = 0;
                }
                isGrounded = false; char.group.position.y += yVelocity*delta;
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
                if (pushPullState === 'push') { char.animate(delta, 'push', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'push'; }
                else if (pushPullState === 'pull') { char.animate(delta, 'pull', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'pull'; }
                else if (landingTimer > 0 && (initialLandingTimer > 0 ? landingTimer / initialLandingTimer : 0) > 0.4) { char.animate(delta, 'landing', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'land'; }
                else if (effectiveMoveMag > 0.05) { char.animate(delta, 'walk', effectiveMoveMag, time, yVelocity, 0); networkStateName = effectiveMoveMag > 0.8 ? 'run' : 'walk'; }
                else { char.animate(delta, 'idle', 0, time, 0, 0); networkStateName = 'idle'; }
            } else { char.animate(delta, 'air', effectiveMoveMag, time, yVelocity, 0); networkStateName = yVelocity > 0 ? 'jump_start' : 'fall'; }

            networkCarryUpper = false;
            if (window.isCarryStarting) networkStateName = 'carry_start';
            else if (window.isCarryDropping) networkStateName = 'carry_start';
            else if (window.throwTimer > 0) networkStateName = 'throw';
            else if (window.combat && window.combat.punchState > 0) {
                const ps = window.combat.punchState;
                if (ps === 1) networkStateName = 'punch_left';
                else if (ps === 2) networkStateName = 'punch_right';
                else if (ps === 3) networkStateName = 'punch_combo';
                else if (ps === 4) networkStateName = 'punch_charge_hold';
                else if (ps === 5) networkStateName = 'punch_charge_punch';
            } else if (window.isCarryingObj) networkCarryUpper = true;
        }

        if (network) {
            if (!char.isRagdoll && !char.isStandingUp) {
                let heldNetId = null;
                if (window.isCarryingObj && heldCarryable) {
                    const heldObj = carryables.find(c => c.mesh === heldCarryable);
                    if (heldObj) heldNetId = heldObj.netId;
                }
                network.sendLocalState(char.group.position, char.group.quaternion, networkStateName, networkCarryUpper, heldNetId, delta);
            }
            network.update(delta);
        }
        updateAiBot(delta);

        let trackingPoint = _tempVec1;
        if (char.hips && (isClimbingUp || char.isRagdoll || char.isStandingUp)) char.hips.getWorldPosition(trackingPoint);
        else { trackingPoint.copy(char.group.position); trackingPoint.y += 1.1; }
        
        camTarget.lerp(trackingPoint, 10 * delta);

        let targetCamX = camTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
        let targetCamY = Math.max(floorY + 0.5, camTarget.y + cameraRadius * Math.cos(cameraPhi) + 1.5);
        let targetCamZ = camTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);

        camera.position.lerp(_tempVec2.set(targetCamX, targetCamY, targetCamZ), 15 * delta);
        camera.lookAt(camTarget.x, camTarget.y, camTarget.z);

        // X-ray: if a wall sits between the camera and the player (camera
        // orbits at a fixed radius with no collision of its own, so this can
        // happen any time it swings behind geometry), show the always-on-top
        // faint gray xray body instead of just losing the player behind it.
        const toPlayer = _tempVec3.copy(trackingPoint).sub(camera.position);
        const distToPlayer = toPlayer.length();
        let playerOccluded = false;
        if (distToPlayer > 0.01) {
            xrayRaycaster.set(camera.position, toPlayer.normalize());
            xrayRaycaster.far = distToPlayer - 0.3;
            const occluders = xrayRaycaster.intersectObjects(collidables);
            playerOccluded = occluders.length > 0;
        }
        char.setXrayVisible(playerOccluded);

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
    
    // iOS Safari doesn't fire 'resize' when the on-screen keyboard opens/closes
    // (it pans the visual viewport instead, leaving window.innerHeight/scrollY
    // untouched) - and after tapping a text input like the multiplayer server
    // address box, it doesn't always restore that pan once the keyboard closes,
    // leaving the whole page visibly shifted up. visualViewport's own resize
    // event does fire reliably for this, and re-snapping scroll to (0,0) undoes
    // the leftover pan.
    function handleViewportResize() {
        window.scrollTo(0, 0);
        camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', handleViewportResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportResize);
}