import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MultiplayerClient } from './multiplayer.js';
import { RemoteAvatar } from './remote_avatar.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
    // Ramp angle labels (makeTextSprite, added by buildSlopeTestRamp) plus
    // the live yaw readout above the player's head are both tied to the
    // 'toggle-angle-labels' Debug Vis checkbox - collected here so the
    // checkbox's change handler (below) can flip all of them at once.
    // Cleared at the top of buildStairsLevel() each rebuild so this never
    // accumulates references to sprites that got removed along with their
    // old ramp meshes.
    const rampAngleLabels = [];
    const curvedRampWireframes = [];
    // Sandbag (constructed later from ClimbGame.html) takes a debugHelpers
    // array in its own constructor to push a hitbox wireframe into, but
    // without this it was getting a disconnected, throwaway [] instead of
    // this actual array - toggle-hitbox's handler below only ever iterates
    // this one, so anything pushed into the throwaway copy was never
    // reachable and just silently never showed.
    window.debugHelpers = debugHelpers;
    const activeShards = [];

    const _tempVec1 = new THREE.Vector3();
    const _tempVec2 = new THREE.Vector3();
    const _tempVec3 = new THREE.Vector3();
    const _slideDirScratch = new THREE.Vector3(0, 0, 1);
    const _steepestNormalScratch = new THREE.Vector3();
    const _candidateNormalScratch = new THREE.Vector3();
    const _centerNormalScratch = new THREE.Vector3();
    const _tiltRefDirScratch = new THREE.Vector3();
    const _footWorldPosScratch = new THREE.Vector3();
    const _footRayOriginScratch = new THREE.Vector3();
    const _leftFootIKTarget = new THREE.Vector3();
    const _rightFootIKTarget = new THREE.Vector3();
    const _hitRecoveryLocalDir = new THREE.Vector3();
    const _hitRecoveryInvQuat = new THREE.Quaternion();
    // Fixed unit directions for the anti-clipping penetration check below -
    // used to be recreated with `new THREE.Vector3(...)` (8 allocations)
    // every single frame despite never changing; Raycaster.set() copies
    // these values in rather than holding a reference, so reusing the same
    // 8 objects every frame is safe.
    const _penetrationRayDirs = [
        new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(0.707, 0, 0.707), new THREE.Vector3(-0.707, 0, -0.707),
        new THREE.Vector3(0.707, 0, -0.707), new THREE.Vector3(-0.707, 0, 0.707)
    ];
    const _pushOutVectorScratch = new THREE.Vector3();
    const _penetrationNormalScratch = new THREE.Vector3();
    const _tempVec2D = new THREE.Vector2();
    const _tempVec2D2 = new THREE.Vector2();
    const _tempQuat = new THREE.Quaternion();
    const _downVec = new THREE.Vector3(0, -1, 0);
    const _upVec = new THREE.Vector3(0, 1, 0);
    const _shooterTargetPos = new THREE.Vector3();
    const _remoteCollideNormal = new THREE.Vector3();
    const _cubeSizeVec = new THREE.Vector3(3.0, 3.0, 3.0);
    const _carrySizeVec = new THREE.Vector3(1.0, 1.0, 1.0);
    const _rampLocalPos = new THREE.Vector3();
    const _rampLocalHead = new THREE.Vector3();
    const _rampInvMatrix = new THREE.Matrix4();

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
    window.gameCamera = camera;
    // Camera has to be in the scene graph for anything parented to it (the
    // compass mesh below) to actually get drawn - camera.add(x) alone
    // leaves x in a detached hierarchy renderer.render(scene, camera)
    // never visits.
    scene.add(camera);

    // Real 3D compass: the Compass.glb needle model, re-oriented via a real
    // lookAt() every frame to point at the level's exit (the star). Full 3D
    // rotation, not a flat screen icon - it tilts up/down and spins left/
    // right together, on whatever combined axis actually points at the
    // target. Toggled independently from the flat 2D arrow below
    // (window.compass3DEnabled/compass2DEnabled, see the panel checkboxes)
    // - 3D on, 2D off by default (matches the checkboxes' own default
    // checked state in the HTML).
    window.compass3DEnabled = true;
    window.compass2DEnabled = false;
    // Positioned in world space every frame (see the main loop) rather
    // than parented to the camera: still uses the camera's full local
    // offset (so it stays roughly centered in view exactly like before,
    // tracking pitch as the player orbits up/down), but the result gets
    // clamped to a minimum world Y afterward - a plain camera-child offset
    // has no such floor, so a steep enough downward pitch could swing the
    // offset point below ground level.
    const compassMesh = new THREE.Group();
    scene.add(compassMesh);
    window.compassMesh = compassMesh;
    const compassGltfLoader = new GLTFLoader();
    compassGltfLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Compass.glb', (gltf) => {
        const model = gltf.scene;
        // The model's two halves (a yellow-tipped cone and a white-tipped
        // cone, base to base) are built pointing along local Y, spanning
        // y:[-2,2]. Object3D.lookAt() (unlike Camera's own -Z convention)
        // orients a plain mesh's local +Z at the target, so rotating this
        // 90 degrees around X once here maps that Y axis onto Z - the
        // yellow tip becomes the end that ends up pointing at the star.
        model.rotation.x = Math.PI / 2;
        // Model's own bounding box is 4 units tall - scaled down to a
        // small on-screen size.
        model.scale.setScalar(0.032);
        model.traverse(c => {
            if (!c.isMesh) return;
            const isContainer = c.name === 'CompassContainer';
            if (isContainer) {
                // CompassContainer (a shell around the needle, added after
                // the original two cone halves) came in with its normals
                // facing the wrong way for how it's meant to be lit/shaded
                // here - flipping them is a simple fix for that.
                const normalAttr = c.geometry.attributes.normal;
                for (let i = 0; i < normalAttr.count; i++) {
                    normalAttr.setXYZ(i, -normalAttr.getX(i), -normalAttr.getY(i), -normalAttr.getZ(i));
                }
                normalAttr.needsUpdate = true;
                // Cell/toon-shaded (matches the rest of the game's look,
                // see threeTone) and fully opaque/matte - no specular
                // highlight from toon shading already gives it a flat,
                // non-shiny look on its own.
                c.material = new THREE.MeshToonMaterial({ color: 0x1c2a4a, gradientMap: threeTone });
                c.renderOrder = 0;
            } else {
                // Truly flat: MeshBasicMaterial isn't lit at all, so each
                // face renders as its own uniform solid color with no
                // lighting response/gradient whatsoever - Lambert still
                // varies continuously with the light angle (not flat
                // enough), and Toon still bands in discrete steps.
                c.material = new THREE.MeshBasicMaterial({
                    color: c.material.color ? c.material.color.clone() : 0xffffff,
                });
                // The needle sits inside the container's opaque volume,
                // so its own near surface would normally depth-occlude
                // the needle entirely. depthTest:false plus a higher
                // renderOrder than the container is what makes it always
                // draw last and fully visible, regardless of actual depth.
                c.material.depthTest = false;
                c.material.depthWrite = false;
                c.renderOrder = 1;
            }
        });
        compassMesh.add(model);
    });
    // Camera-local offset - same ratio of up:forward the old cone used
    // (0, 1.9, -3), just scaled down to about half the distance from the
    // camera, so it keeps the same on-screen position (this ratio is what
    // determines where it lands on screen, not the absolute distance) but
    // sits closer.
    const COMPASS_LOCAL_OFFSET = new THREE.Vector3(0, 1.05, -1.5);
    // Minimum height above the current floor the compass is allowed to
    // sit at, regardless of what the camera-local offset above would
    // otherwise compute - this is what actually stops it from ever
    // visually sinking into the ground on a steep downward camera pitch.
    const COMPASS_MIN_FLOOR_CLEARANCE = 1.2;
    const _compassOffset = new THREE.Vector3();

    // 2D arrow, kept in sync with the 3D needle above instead of computed
    // independently: projects the needle's own tip (its "front") and its
    // own center (its "back") to screen pixels, and points the flat icon
    // along that on-screen delta. Both points stay near the camera
    // regardless of which way the needle is currently facing (only its
    // *rotation*, inherited from its own lookAt(), carries the "which way"
    // information) so this never nears the divide-by-near-zero-w blowup a
    // directly-projected far-away/behind target hits.
    const _compassFront = new THREE.Vector3();
    const _compassBack = new THREE.Vector3();

    // Orthographic camera test, toggled from the settings panel - all the
    // existing follow/orbit/raycast/billboard logic below keeps driving the
    // perspective `camera` exactly as before (it's the one thing everything
    // else in the file reads), this one just copies its position/rotation
    // every frame and is swapped in at render time only, so nothing else
    // needs to know which camera is actually on screen.
    window.orthoCameraEnabled = false;
    window.orthoViewSize = 10;
    const orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    function updateOrthoFrustum() {
        const aspect = window.innerWidth / window.innerHeight;
        const size = window.orthoViewSize;
        orthoCamera.left = -size * aspect;
        orthoCamera.right = size * aspect;
        orthoCamera.top = size;
        orthoCamera.bottom = -size;
        orthoCamera.updateProjectionMatrix();
    }
    updateOrthoFrustum();

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;

    // Pixelation post-processing test (https://threejs.org/examples/webgl_postprocessing_pixel.html)
    // - off by default, toggled from the settings panel. Built once up front
    // rather than lazily on first enable, so the toggle is instant either way.
    window.pixelEffectEnabled = false;
    const composer = new EffectComposer(renderer);
    const renderPixelatedPass = new RenderPixelatedPass(6, scene, camera);
    composer.addPass(renderPixelatedPass);
    composer.addPass(new OutputPass());

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
        cooldownTimer: 0,
        // Which side (-1 left / 0 none / 1 right) moveAiBotToward last
        // steered around an obstacle on. Persisted across frames so it
        // keeps preferring that same side next frame instead of
        // re-deciding from scratch - when the obstacle sits dead-center
        // between the bot and the target, left and right are equally
        // "first found clear" and a per-frame re-decision flip-flops
        // between them every frame (net standing still, vibrating).
        avoidSide: 0
    };
    window.aiBotPathVisible = true;
    // Two lines, not one: goalLine (yellow) is where the bot is ultimately
    // trying to get to (the player in chase, a random point while
    // wandering); stepLine (cyan) is the direction it's actually walking
    // this frame. They only diverge while avoidance (see moveAiBotToward)
    // is steering around something - seeing them split apart is the visual
    // confirmation avoidance is doing something, not just decoration.
    let aiBotGoalLine = null, aiBotStepLine = null;
    function createAiBotPathLines() {
        const goalGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        aiBotGoalLine = new THREE.Line(goalGeo, new THREE.LineBasicMaterial({ color: 0xffcc00 }));
        aiBotGoalLine.frustumCulled = false;
        scene.add(aiBotGoalLine);

        const stepGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        aiBotStepLine = new THREE.Line(stepGeo, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
        aiBotStepLine.frustumCulled = false;
        scene.add(aiBotStepLine);
    }
    function disposeAiBotPathLines() {
        [aiBotGoalLine, aiBotStepLine].forEach(line => {
            if (!line) return;
            scene.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        });
        aiBotGoalLine = null; aiBotStepLine = null;
    }
    // Just rewrites the existing two-point BufferGeometry each call (no
    // alloc/dispose per frame) - updateAiBot only calls this while
    // window.aiBotPathVisible is on and the bot exists, so the cost when
    // it's off (or no bot) is a single boolean check.
    function updateAiBotPathVisual(botPos, goalPos, stepPos) {
        if (!aiBotGoalLine || !aiBotStepLine) return;
        aiBotGoalLine.visible = window.aiBotPathVisible;
        aiBotStepLine.visible = window.aiBotPathVisible;
        if (!window.aiBotPathVisible) return;
        const goalY = botPos.y + 0.1;
        aiBotGoalLine.geometry.setFromPoints([
            new THREE.Vector3(botPos.x, goalY, botPos.z),
            new THREE.Vector3(goalPos.x, goalY, goalPos.z)
        ]);
        aiBotStepLine.geometry.setFromPoints([
            new THREE.Vector3(botPos.x, goalY, botPos.z),
            new THREE.Vector3(stepPos.x, goalY, stepPos.z)
        ]);
    }
    const aiBotPathToggle = document.getElementById('ai-bot-path-toggle');
    if (aiBotPathToggle) {
        window.aiBotPathVisible = aiBotPathToggle.checked;
        aiBotPathToggle.addEventListener('change', () => { window.aiBotPathVisible = aiBotPathToggle.checked; });
    }

    function pickNewAiWanderTarget() {
        const angle = Math.random() * Math.PI * 2;
        const dist = 3 + Math.random() * 6;
        aiBotState.target.set(
            aiBot.group.position.x + Math.cos(angle) * dist,
            aiBot.group.position.y,
            aiBot.group.position.z + Math.sin(angle) * dist
        );
    }
    // Candidate steering angles (degrees) tried in order when the direct
    // line to the target is blocked - 0 first (so the common unblocked
    // case costs exactly the one raycast it always did), then increasingly
    // wide turns. Two fixed orderings, one preferring right first and one
    // left first - which one gets used each call depends on
    // aiBotState.avoidSide (see moveAiBotToward), so once the bot commits
    // to going around a side it keeps re-trying that side first every
    // frame instead of re-deciding from scratch (which side "wins" ties
    // arbitrarily each frame when an obstacle is dead-center, flip-flopping
    // between them - net standing still, vibrating left/right).
    const AI_AVOID_ANGLES_RIGHT_FIRST = [0, 25, -25, 50, -50, 75, -75, 100, -100];
    const AI_AVOID_ANGLES_LEFT_FIRST = [0, -25, 25, -50, 50, -75, 75, -100, 100];
    const AI_AVOID_LOOKAHEAD = 1.8;
    // Roughly the bot's own half-width - a single centerline ray can find a
    // direction "clear" while still grazing an obstacle's edge close enough
    // for the bot's actual body to clip it, which showed up as walking
    // right next to (and partly onto, via the separate ground-snap ray
    // picking up the obstacle's own top face) a jar instead of around it.
    // Two extra rays offset sideways from the same origin, parallel to the
    // candidate direction, approximate a capsule sweep cheaply.
    const AI_AVOID_RADIUS = 0.45;
    const _aiAvoidPerp = new THREE.Vector3();
    const _aiAvoidSideOrigin = new THREE.Vector3();

    // Moves aiBot's group position toward destTarget at the given speed,
    // steering around anything in the way (see AI_AVOID_ANGLES) instead of
    // just refusing to move, with the same ground-snapping the plain wander
    // uses, reused for both wander and chase movement.
    function moveAiBotToward(destTarget, speed, delta) {
        const pos = aiBot.group.position;
        const toTarget = _tempVec1.set(destTarget.x - pos.x, 0, destTarget.z - pos.z);
        const dist = toTarget.length();
        if (dist < 0.001) return dist;
        toTarget.normalize();

        // 0.5, not the "chest height" 1.0 the old single-ray check used -
        // getObstacleBox treats every isCarryable object (jars included) as
        // a fixed 1x1x1 box centered on its own position (see game_js.js's
        // getObstacleBox), and jars sit at y=0.5, so their box only spans
        // y:[0,1.0]. A ray at y=1.0 just skims that box's very top edge
        // instead of passing through it - which is exactly why the bot was
        // walking straight over jars specifically while still correctly
        // avoiding taller things like the sandbag/movable boxes.
        const rayOrigin = _tempVec2.copy(pos).setY(pos.y + 0.5);
        const angleOrder = aiBotState.avoidSide < 0 ? AI_AVOID_ANGLES_LEFT_FIRST : AI_AVOID_ANGLES_RIGHT_FIRST;
        let moveDir = null;
        let chosenAngle = 0;
        for (const angleDeg of angleOrder) {
            const candidate = _tempQuat.setFromAxisAngle(_upVec, angleDeg * Math.PI / 180);
            // _tempVec3 is also this function's nextPos scratch further
            // down, but that's only written after this loop is done with it.
            _tempVec3.copy(toTarget).applyQuaternion(candidate);

            _aiAvoidPerp.set(-_tempVec3.z, 0, _tempVec3.x);
            let clear = true;
            for (const sideMul of [0, 1, -1]) {
                _aiAvoidSideOrigin.copy(rayOrigin);
                if (sideMul !== 0) _aiAvoidSideOrigin.addScaledVector(_aiAvoidPerp, sideMul * AI_AVOID_RADIUS);
                rayFwd.set(_aiAvoidSideOrigin, _tempVec3);
                const hits = rayFwd.intersectObjects(collidables);
                if (hits.length > 0 && hits[0].distance <= AI_AVOID_LOOKAHEAD) { clear = false; break; }
            }
            if (clear) {
                moveDir = _tempVec3.clone();
                chosenAngle = angleDeg;
                break;
            }
        }
        // 0 means the direct line is clear again - nothing left to commit
        // to, so future obstacles get re-decided fresh rather than sticking
        // to whatever side was last used for something unrelated.
        aiBotState.avoidSide = chosenAngle === 0 ? 0 : Math.sign(chosenAngle);
        if (window.aiBotPathVisible) {
            updateAiBotPathVisual(pos, destTarget, moveDir ? _tempVec2.copy(pos).addScaledVector(moveDir, 3) : pos);
        }
        // Every candidate angle is blocked within lookahead - genuinely
        // boxed in, not just "one direction happens to be blocked".
        if (!moveDir) return -1;

        const facingQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), moveDir);

        const nextPos = _tempVec3.copy(pos).addScaledVector(moveDir, speed * delta);
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

        // Hit-recovery stagger step - mirrors the local player's own
        // recovery step in the main movement block below: pauses whatever
        // the bot was doing (wander/chase/punch/cooldown) for this same
        // short window and staggers it in the hit's direction instead,
        // using the exact fields RagdollPhysics.applyProceduralRecoil
        // already populates (hitRecoveryDir/Timer/Strength - shared with
        // the local Character via the same mixin, so this needed no new
        // trigger plumbing, just something to actually read them).
        // Position-only, no clip to match the exact direction with -
        // RemoteAvatar's REMOTE_ANIMS never loaded strafe/backward-walk
        // clips, so 'walk' is the closest available state; at least the
        // legs visibly cycle instead of sliding/staying frozen mid-stumble.
        const hitRecoveryDuration = window.hitRecoveryDuration !== undefined ? window.hitRecoveryDuration : 0.35;
        if (aiBot.hitRecoveryTimer > 0 && aiBot.hitRecoveryTimer <= hitRecoveryDuration) {
            const recoveryStepSpeed = window.recoveryStepSpeed || 3.5;
            const recoveryStrengthMult = THREE.MathUtils.clamp(aiBot.hitRecoveryStrength / 12.0, 0.5, window.recoveryStrengthMultMax || 2.0);
            const stepSpeed = recoveryStepSpeed * recoveryStrengthMult * Math.min(1, aiBot.hitRecoveryTimer / hitRecoveryDuration);
            const nextPos = _tempVec3.copy(pos).addScaledVector(aiBot.hitRecoveryDir, stepSpeed * delta);
            rayDown.set(_tempVec1.copy(nextPos).setY(nextPos.y + 2.0), _downVec);
            const groundHits = rayDown.intersectObjects(collidables);
            if (groundHits.length > 0) nextPos.y = groundHits[0].point.y;
            aiBot.setNetworkState([nextPos.x, nextPos.y, nextPos.z],
                [aiBot.group.quaternion.x, aiBot.group.quaternion.y, aiBot.group.quaternion.z, aiBot.group.quaternion.w], 'walk', false);
            aiBot.update(delta);
            return;
        }

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
        createAiBotPathLines();

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
        disposeAiBotPathLines();

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

    // StarKey.glb contains both a key and a lock (LockBase/LockStarContainer
    // for the lock, KeyBase/KeyStarContainer for the key) plus a single
    // shared "Star" mesh, all authored as flat siblings in the source file.
    // Loaded as glTF, not FBX: the lock's shape key (used to hide/reveal the
    // star, see buildStarAssembly) exported with valid vertex deltas in glTF
    // every time, but came back completely empty (0 vertices) from FBX in
    // every export attempt across both Blender and Maya - a known rough edge
    // in how well FBX interchange preserves blend shapes versus glTF's more
    // standardized, better-tested encoding (and three.js's GLTFLoader support
    // for it).
    let keyTemplateParts = null;
    let stairsLevelBuilt = false; // set once buildStairsLevel() has run at least once
    const activeKeyStars = []; // billboarded toward the camera every frame, see the main loop
    // Star.glb's flat plane faces local +Y, not +Z - see the billboard update
    // in the main loop for why this correction is needed.
    const starFrontFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const activeKeyGroups = []; // rescaled live by the Key Scale slider (key + lock share it)
    window.keyScale = 2.0;
    const gltfLoader = new GLTFLoader();
    gltfLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Interactables/StarKey.glb', (gltf) => {
        const object = gltf.scene;
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

    // Level 2's whole map is a single authored model (LevelModel/Level.glb,
    // exported from Blender) rather than voxels/JSON. Preloaded here at
    // startup the same way StarKey.glb is; buildLevelFromGlb() (called via
    // the level dropdown) just assembles the already-loaded scene. Tries
    // the local copy first (ProjectFiles/LevelModel/, kept alongside the
    // FBX clips so the dev server can reach it - the authored original
    // lives outside the server root at Editor/IKRig/LevelModel/), falls
    // back to the repo's raw URL like every other remote asset.
    let levelGlbScene = null;
    let pendingGlbLevelBuild = false;
    const levelGlbLoader = new GLTFLoader();
    const onLevelGlbLoaded = (gltf) => {
        levelGlbScene = gltf.scene;
        if (pendingGlbLevelBuild) { pendingGlbLevelBuild = false; buildLevelFromGlb(); }
    };
    levelGlbLoader.load('LevelModel/Level.glb', onLevelGlbLoaded, undefined, () => {
        levelGlbLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/LevelModel/Level.glb',
            onLevelGlbLoaded, undefined, (e) => console.error('Level.glb load failed:', e));
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
            window.debugTestKeyGroup = testKeyGroup;
        }

        // Test-only lock instance next to the key - fixed in place (not
        // carryable), just to see it in the level; no unlock puzzle wired
        // up yet.
        const testLockGroup = createLockInstance();
        if (testLockGroup) {
            // Right where the flat starting platform ends and the actual
            // stairs (stair_0 at z=-10, see buildStairsLevel) begin -
            // stair_0's near face sits at roughly z=-8.5 (cubeSize/2 in
            // front of its own z=-10 center), so -8 puts the lock just
            // ahead of it, still on the flat ground.
            testLockGroup.position.set(0, testLockGroup.userData.floorOffset * window.keyScale, -8);
            testLockGroup.rotation.y = Math.PI;
            levelGroup.add(testLockGroup);
            collidables.push(testLockGroup);
            activeLockInstances.push(testLockGroup);
            window.debugTestLockGroup = testLockGroup; // L key triggers revealLockStar() on this, see keydown handler

            // Capsule = its actual collision size (getObstacleBox falls
            // back to the real computed AABB for anything that isn't
            // isCarryable/isMovable, which the lock is neither) - a box
            // was a poor visual match for this tall, roughly-cylindrical
            // model. Sphere = how close a thrown/carried key actually has
            // to get for it to insert (see KEY_INSERT_DISTANCE).
            //
            // Positioned at the box's own computed center, not
            // testLockGroup.position - this model's visible mesh (like the
            // sandbag's) isn't centered on its own group origin, so the
            // helper was floating off away from what's actually on screen.
            // Actual gameplay code (insertion distance, collision) still
            // uses testLockGroup.position unchanged - only this debug
            // visualization's placement needed the correction.
            testLockGroup.updateMatrixWorld(true);
            const lockBox = new THREE.Box3().setFromObject(testLockGroup);
            const lockSize = lockBox.getSize(new THREE.Vector3());
            const lockCenter = lockBox.getCenter(new THREE.Vector3());
            addWireframeCapsuleDebugHelper(lockCenter, Math.max(lockSize.x, lockSize.z) / 2, lockSize.y);
            addWireframeSphereDebugHelper(testLockGroup.position, KEY_INSERT_DISTANCE);
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
            // Two ways this data has shown up broken so far (both from FBX
            // exports - the glTF export doesn't have this problem, that's
            // why this asset loads as .glb now): literal NaN values, and a
            // target with 0 vertices - an empty/mismatched morph attribute
            // still confuses Three's bounding box/sphere math into producing
            // NaN, same end result. Check both instead of just one.
            const baseCount = clone.geometry.attributes.position.count;
            const invalid = morphPos.some(attr => attr.count !== baseCount || attr.array.some(v => !Number.isFinite(v)));
            if (invalid) {
                console.error(`"${node.name}": shape key data is invalid (wrong vertex count or non-finite values) - stripping morph targets until fixed in the source file.`);
                clone.geometry = clone.geometry.clone();
                clone.geometry.morphAttributes = {};
                clone.geometry.computeBoundingBox();
                clone.geometry.computeBoundingSphere();
                clone.morphTargetInfluences = undefined;
                clone.morphTargetDictionary = undefined;
            } else if (clone.morphTargetInfluences && clone.morphTargetInfluences.length > 0) {
                // Default state: fully-weighted (closed up, no star visible).
                // Index 0, not by name - Blender's own export naming for this
                // one shape key has changed ("Key1"/"Key 1"/"LockStarContainer.001")
                // across re-exports, but the container only ever has the one
                // morph target regardless of what it's currently called.
                clone.morphTargetInfluences[0] = 1.0;
            }
        }
        return clone;
    }

    function buildStarAssembly(baseNode, containerNode, starNode, scale, hideStarInitially) {
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
            alphaTest: 0.5,
            side: THREE.DoubleSide // flat plane - a one-sided material would go invisible if the billboard-facing correction is ever off by 180 degrees
        });
        containerClone.add(starClone);

        [baseClone, containerClone, starClone].forEach(m => { m.castShadow = true; m.receiveShadow = true; });
        group.add(baseClone, containerClone);
        group.scale.setScalar(window.keyScale);
        activeKeyStars.push(starClone);
        activeKeyGroups.push(group);
        group.userData.containerMesh = containerClone; // for revealLockStar()
        group.userData.starClone = starClone; // for the key-insertion sequence

        // The lock's star starts hidden (scale 0, not just occluded by the
        // closed container) and is only revealed once a key gets inserted -
        // see triggerKeyInsertion. starFullScale is captured here (before
        // hiding it) so that reveal knows what size to grow back to.
        group.userData.starFullScale = starClone.scale.x;
        if (hideStarInitially) starClone.scale.setScalar(0);

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
        return buildStarAssembly(keyBase, keyStarContainer, star, scale, false);
    }

    function createLockInstance() {
        if (!keyTemplateParts || !keyTemplateParts.lockBase || !keyTemplateParts.lockStarContainer) return null;
        const { lockBase, lockStarContainer, star, scale } = keyTemplateParts;
        return buildStarAssembly(lockBase, lockStarContainer, star, scale, true);
    }

    // Animates the lock's shape key from its current influence down to 0
    // over `duration` seconds, revealing the star inside. Also reachable
    // directly via the L key debug binding below for testing without needing
    // to actually carry a key over to a lock.
    const activeMorphTweens = [];
    function revealLockStar(lockGroup, duration = 0.4, onComplete, delay = 0) {
        const mesh = lockGroup && lockGroup.userData.containerMesh;
        if (!mesh || !mesh.morphTargetInfluences || mesh.morphTargetInfluences.length === 0) {
            if (onComplete) onComplete();
            return;
        }
        const idx = 0;
        activeMorphTweens.push({ mesh, idx, from: mesh.morphTargetInfluences[idx], to: 0, duration, elapsed: -delay, onComplete });
    }

    // Generic scalar scale tween, used by the key-insertion sequence below
    // (key shrinking away, its star lingering a beat longer, the lock's own
    // star growing in at the end) - kept scalar/uniform rather than
    // per-axis since every scale in this system already is (window.keyScale,
    // the normalize scale, etc). `delay` holds the tween at `from` for that
    // many seconds before it starts easing toward `to` (elapsed just counts
    // down through negative territory first).
    const activeScaleTweens = [];
    function tweenScaleScalar(obj, from, to, duration, onComplete, delay = 0) {
        activeScaleTweens.push({ obj, from, to, duration, elapsed: -delay, onComplete });
    }

    // Detaches a child (e.g. the key's star) from its parent while preserving
    // its current WORLD transform, so it can keep animating independently of
    // whatever happens to the parent afterward (the parent's own shrink-to-0
    // would otherwise drag a still-nested star's world scale to 0 with it,
    // regardless of the star's own separate tween's progress).
    function detachPreservingWorldTransform(child, newParent) {
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
        child.getWorldPosition(pos);
        child.getWorldQuaternion(quat);
        child.getWorldScale(scale);
        newParent.add(child);
        child.position.copy(pos);
        child.quaternion.copy(quat);
        child.scale.copy(scale);
    }

    const activeLockInstances = [];
    const KEY_INSERT_DISTANCE = 2.0;

    // Fires when a carried key is brought close enough to a lock (see the
    // proximity check next to the carry-position update below). Not sure yet
    // whether this should eventually require an explicit drop instead of
    // triggering automatically on proximity - going with automatic for now.
    function triggerKeyInsertion(keyMesh, lockGroup) {
        lockGroup.userData.keyInserted = true;

        const cIdx = carryables.findIndex(c => c.mesh === keyMesh);
        if (cIdx !== -1) carryables.splice(cIdx, 1);
        const collIdx = collidables.indexOf(keyMesh);
        if (collIdx !== -1) collidables.splice(collIdx, 1);

        window.isCarryingObj = false;
        window.isCarryStarting = false;
        window.isCarryDropping = false;
        heldCarryable = null;
        dropBtn.style.display = 'none';
        throwBtn.style.display = 'none';
        if (char) char.stopUpperAction(0.2);

        // KeyStarContainer/LockStarContainer sit at their own (different)
        // authored positions in the shared source-file coordinate space -
        // not a coincidence, that's the artist's reference for exactly how
        // the key sits seated in the lock's socket once inserted. Reproduce
        // that same relative offset here instead of just snapping the key to
        // the lock's raw origin, scaled/rotated to match this lock instance's
        // actual placement (normalize scale + window.keyScale, its current
        // world rotation).
        const { keyStarContainer, lockStarContainer, scale } = keyTemplateParts;
        const seatOffset = meshWorldCenter(keyStarContainer).sub(meshWorldCenter(lockStarContainer))
            .multiplyScalar(scale * window.keyScale)
            .applyQuaternion(lockGroup.quaternion);
        keyMesh.position.copy(lockGroup.position).add(seatOffset);
        keyMesh.quaternion.copy(lockGroup.quaternion);

        let keyStarGone = false, lockMorphDone = false;
        const tryRevealLockStar = () => {
            if (!keyStarGone || !lockMorphDone) return;
            const lockStar = lockGroup.userData.starClone;
            const fullScale = lockGroup.userData.starFullScale;
            if (lockStar && fullScale !== undefined) tweenScaleScalar(lockStar, 0, fullScale, 0.5);
        };

        // Only the container (the star-container "ball") shrinks, in place,
        // to 70% of its own size - the base/handle and the rest of the key
        // group are left alone. The star stays a child of the container for
        // this part (not detached yet) - the container's own origin isn't at
        // its visual center, so it visibly shifts as it scales down, and the
        // star needs to keep riding along with that shift rather than sit
        // fixed in world space while the container moves out from under it.
        const keyContainer = keyMesh.userData.containerMesh;
        const keyStar = keyMesh.userData.starClone;
        if (keyContainer) {
            const fromScale = keyContainer.scale.x;
            tweenScaleScalar(keyContainer, fromScale, fromScale * 0.7, 0.5, () => {
                // Only once the container's own shrink is done does the star
                // detach and continue shrinking further (to 0) on its own -
                // by now it's inherited the container's 70% scale via the
                // parent-child relationship, so its current world scale is
                // exactly where the container's shrink left it.
                if (keyStar) {
                    detachPreservingWorldTransform(keyStar, levelGroup);
                    const startScale = keyStar.scale.x;
                    tweenScaleScalar(keyStar, startScale, 0, 0.5, () => {
                        levelGroup.remove(keyStar);
                        keyStarGone = true;
                        tryRevealLockStar();
                    });
                } else {
                    keyStarGone = true;
                    tryRevealLockStar();
                }
            });
        } else if (keyStar) {
            detachPreservingWorldTransform(keyStar, levelGroup);
            tweenScaleScalar(keyStar, keyStar.scale.x, 0, 0.5, () => {
                levelGroup.remove(keyStar);
                keyStarGone = true;
                tryRevealLockStar();
            });
        } else {
            keyStarGone = true;
        }

        // The lock's own shape-key transition runs at the same time, over
        // roughly the same total span as the container-then-star shrink
        // (0.5s + 0.5s) so both finish together.
        revealLockStar(lockGroup, 1.0, () => { lockMorphDone = true; tryRevealLockStar(); });
    }
    window.debugTriggerKeyInsertion = triggerKeyInsertion;

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

    // Two general-purpose debug wireframes, same "Show Hitboxes" checkbox
    // convention as every other helper here (initial visibility read from
    // it directly, pushed into the shared debugHelpers array so the
    // checkbox's own change handler keeps controlling it afterward).
    // Box = actual collision hitbox; sphere = a proximity/interaction
    // radius (e.g. KEY_INSERT_DISTANCE) that isn't a physical collider at
    // all, just a "close enough" check - kept visually distinct (cyan vs
    // magenta) so the two don't get confused for each other.
    function addWireframeBoxDebugHelper(targetPos, width, height, depth, colorHex = 0xff00ff) {
        const helperMesh = new THREE.Mesh(
            new THREE.BoxGeometry(width, height, depth),
            new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true, transparent: true, opacity: 0.6 })
        );
        helperMesh.position.copy(targetPos);
        helperMesh.visible = document.getElementById('toggle-hitbox').checked;
        helperMesh.raycast = () => {};
        scene.add(helperMesh);
        debugHelpers.push(helperMesh);
        return helperMesh;
    }
    function addWireframeSphereDebugHelper(targetPos, radius, colorHex = 0x00ffff) {
        const helperMesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 16),
            new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true, transparent: true, opacity: 0.4 })
        );
        helperMesh.position.copy(targetPos);
        helperMesh.visible = document.getElementById('toggle-hitbox').checked;
        helperMesh.raycast = () => {};
        scene.add(helperMesh);
        debugHelpers.push(helperMesh);
        return helperMesh;
    }
    // CapsuleGeometry(radius, length, ...) - length is just the straight
    // cylindrical middle section, total height is length + 2*radius, so
    // callers passing a target total height need to subtract that back out
    // (see the lock's own call site for why: a box was a poor visual match
    // for a tall, roughly-cylindrical model like the lock).
    function addWireframeCapsuleDebugHelper(targetPos, radius, totalHeight, colorHex = 0xff00ff) {
        const length = Math.max(0.01, totalHeight - 2 * radius);
        const helperMesh = new THREE.Mesh(
            new THREE.CapsuleGeometry(radius, length, 4, 12),
            new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true, transparent: true, opacity: 0.6 })
        );
        helperMesh.position.copy(targetPos);
        helperMesh.visible = document.getElementById('toggle-hitbox').checked;
        helperMesh.raycast = () => {};
        scene.add(helperMesh);
        debugHelpers.push(helperMesh);
        return helperMesh;
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

    // The ground/wall raycasts only ever look straight down or straight
    // ahead, so a tilted ramp's slab has whole regions they never see from
    // below/beside: the pinch zone under it (gap shorter than the
    // character), and the shallow zone near the toe where the slab crosses
    // the body at shin/chest height with the head sticking out ABOVE the
    // top surface. An earlier version of this check tested only the single
    // head point against the slab, which caught the pinch zone but
    // completely missed that shallow zone - the exact "head poking out of
    // the ramp near where it meets the ground" the player kept hitting.
    // Every ramp is the same BoxGeometry(6, 0.6, 14) shape (half-extents
    // hx=3, hy=0.3, hz=7), rotated only around local X, so instead this
    // takes the character's whole body as a vertical segment (feet+0.15 up
    // to feet+1.75) in the ramp's local space and asks whether ANY of it
    // overlaps the slab's local-Y band (-hy, hy) while the crossing point
    // sits inside the XZ footprint - true whenever any body part is inside
    // the solid slab, at any height. Legitimately standing/sliding ON the
    // top face keeps feet at local Y=+hy exactly, so the +0.15 bottom
    // margin puts the whole segment above the band and this never fires
    // for the on-ramp case.
    // Resolution: fully close the smallest of four escape distances each
    // frame - either side (X) edge, the toe (+Z) edge, or backing out
    // toward the tall-gap side (-Z) until the head clears the underside.
    // Because the overlap test triggers on first contact, the penetration
    // being resolved is at most one frame's movement (~centimeters), so a
    // full resolve reads as a solid invisible wall; the per-frame cap
    // below only matters for abnormal deep spawns (teleports/lag), turning
    // what used to be a single-frame jump to the footprint edge into a
    // quick smooth push instead.
    function pushOutOfRampUnderside(position) {
        const hx = 3, hy = 0.3, hz = 7;
        const bodyBottom = 0.15, bodyTop = 1.75;
        const MAX_PUSH_PER_FRAME = 0.3;
        for (let k = 0; k < collidables.length; k++) {
            const ramp = collidables[k];
            if (!ramp.userData || !ramp.userData.isSlopeRamp) continue;
            _rampInvMatrix.copy(ramp.matrixWorld).invert();
            _rampLocalPos.set(position.x, position.y + bodyBottom, position.z).applyMatrix4(_rampInvMatrix);
            _rampLocalHead.set(position.x, position.y + bodyTop, position.z).applyMatrix4(_rampInvMatrix);
            const loY = Math.min(_rampLocalPos.y, _rampLocalHead.y);
            const hiY = Math.max(_rampLocalPos.y, _rampLocalHead.y);
            if (loY >= hy || hiY <= -hy) continue;
            // Where the body segment crosses the slab's center plane
            // (clamped to the segment) - the local X/Z used for the
            // footprint test and the escape distances. The body is
            // vertical in world space but tilted in ramp-local space, so
            // feet and head can differ in local Z by up to ~1.6 units;
            // the crossing point is the part actually inside the slab.
            const dy = _rampLocalHead.y - _rampLocalPos.y;
            const t = Math.abs(dy) > 1e-6 ? THREE.MathUtils.clamp(-_rampLocalPos.y / dy, 0, 1) : 0.5;
            const cx = _rampLocalPos.x + (_rampLocalHead.x - _rampLocalPos.x) * t;
            const cz = _rampLocalPos.z + (_rampLocalHead.z - _rampLocalPos.z) * t;
            if (Math.abs(cx) >= hx || Math.abs(cz) >= hz) continue;
            const sinA = Math.max(0.2, Math.sin(ramp.userData.rampAngleRad || 0.6));
            const dxPlus = hx - cx;
            const dxMinus = cx + hx;
            const dzToe = hz - cz;
            const dzClear = (hiY + hy) / sinA;
            const minDist = Math.min(dxPlus, dxMinus, dzToe, dzClear);
            const push = Math.min(minDist, MAX_PUSH_PER_FRAME);
            if (minDist === dxPlus) _rampLocalPos.x += push;
            else if (minDist === dxMinus) _rampLocalPos.x -= push;
            else if (minDist === dzToe) _rampLocalPos.z += push;
            else _rampLocalPos.z -= push;
            _rampLocalPos.applyMatrix4(ramp.matrixWorld);
            position.x = _rampLocalPos.x;
            position.z = _rampLocalPos.z;
        }
    }

    // Finds where a given foot's own ground contact point actually is,
    // for the leg IK to reach toward - not just floorY under the
    // character's center (which a foot on a slope can be meaningfully off
    // of once it's a body-width to either side). Symmetric on purpose
    // (within 0.6 units either way of where the animation already put the
    // foot) - an EARLIER, asymmetric version of this (only ever correcting
    // upward, never down) was tried to stop legIK from flattening a
    // running foot's natural lift on flat/bump ground, but it broke ramps:
    // a downhill foot's true contact point is often genuinely BELOW where
    // a flat-ground-authored animation places it mid-stride, and the
    // asymmetric check silently refused that correction, leaving the leg
    // hovering above the slope instead of planting on it. The run-lift
    // problem is handled differently now - see applyLegIK's own weight
    // parameter (speed-based in game_js.js), which fades how much of this
    // target actually gets applied instead of rejecting it outright.
    // Returns the hit object (truthy) on success, null otherwise - callers
    // that only need a yes/no can just check truthiness; the object itself
    // is also how the movement block tells whether a foot actually landed
    // on isDecorativeBump terrain (see bumpSpeedBlend) without a third,
    // separate raycast pass.
    function computeFootIKTarget(footBone, targetVec, solidCollidables) {
        if (!footBone) return null;
        footBone.getWorldPosition(_footWorldPosScratch);
        _footRayOriginScratch.copy(_footWorldPosScratch);
        _footRayOriginScratch.y += 0.6;
        rayDown.set(_footRayOriginScratch, _downVec);
        const hits = rayDown.intersectObjects(solidCollidables);
        if (hits.length > 0 && Math.abs(hits[0].point.y - _footWorldPosScratch.y) < 0.6) {
            targetVec.copy(hits[0].point);
            return hits[0].object;
        }
        return null;
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
                    // See isOnHemisphere in the movement code - exempts this
                    // continuously-curved surface from isStandPositionClear
                    // the same way ramps are, since that check's coarse
                    // cached AABB (the dome's full 12x12x6 bounding box)
                    // bears no resemblance to the actual thin curved shell.
                    hemisphere.userData.isHemisphere = true;
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

    let levelGlbWater = null;
    function buildLevelFromGlb() {
        // Loader may still be in flight the first time the dropdown picks
        // this level - flag it and let onLevelGlbLoaded re-call once ready.
        if (!levelGlbScene) { pendingGlbLevelBuild = true; return; }
        while(levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0;

        // Grass ground swapped for a water plane, a bit below the level's
        // own y=0 base - only for this level, restored by buildLevel()
        // before every other level builds. No fall-into-water handling
        // yet (recovery/respawn is a separate follow-up) - for now it's
        // just a plain solid floor so nothing falls through into the void.
        ground.visible = false;
        if (!levelGlbWater) {
            levelGlbWater = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000),
                new THREE.MeshToonMaterial({ color: 0x3377aa, gradientMap: threeTone }));
            levelGlbWater.rotation.x = -Math.PI / 2;
            levelGlbWater.receiveShadow = true;
        }
        // Whole level scaled to match the player's own in-game scale.
        // Derived from a real Blender-side reference rather than guessed:
        // in Blender, the player model reads at the correct size next to
        // Level.glb when scaled to 0.01 there (with the level left at its
        // native 1) - so 0.01 (Blender reference) and 1 (Blender
        // reference) are the two scales that already look right together.
        // The player's actual in-game scale is 0.0065 (char.fbxModel /
        // '#scale-slider'), which is 0.65x that Blender reference (0.0065
        // / 0.01) - applying that same 0.65x to the level's own Blender
        // reference (1) preserves the exact proportion Blender already
        // confirmed looks right, landing on 0.65 instead of the flatly
        // wrong 0.0065 tried earlier (that number conflated two different
        // reference frames - the player's OWN native-to-ingame correction
        // - with the level's, which needs its own separate one).
        const LEVEL_TO_PLAYER_SCALE = 0.65;
        levelGlbScene.scale.setScalar(LEVEL_TO_PLAYER_SCALE);
        levelGlbWater.position.y = -1.5 * LEVEL_TO_PLAYER_SCALE;
        levelGroup.add(levelGlbWater);
        collidables.push(levelGlbWater);

        let startNode = null;
        levelGlbScene.traverse(o => {
            if (o.isMesh) {
                o.castShadow = true; o.receiveShadow = true;
                collidables.push(o);
            } else if (o.name && o.name.toLowerCase().startsWith('empty')) {
                startNode = o;
            }
        });
        levelGroup.add(levelGlbScene);
        levelGlbScene.updateMatrixWorld(true);
        star.visible = false;

        if (startNode) {
            // The Blender single-arrow empty marks both where the player
            // spawns and which way they face. Which LOCAL axis the arrow
            // corresponds to after Blender's Y-up export conversion isn't
            // guaranteed, so try +Y first (what this file's actual export
            // produces: its +90deg-X rotation maps local +Y to a horizontal
            // world direction) and fall back to +Z if +Y comes out near-
            // vertical (an unrotated empty), then flatten to the ground
            // plane either way - the spawn facing is yaw-only.
            // WORLD position, not startNode.position (its raw LOCAL
            // coordinate) - now that the whole scene has a non-1 scale
            // applied above it, those no longer coincide.
            startNode.getWorldPosition(char.group.position);
            _tempVec1.set(0, 1, 0).applyQuaternion(startNode.quaternion);
            if (Math.abs(_tempVec1.y) > 0.9) _tempVec1.set(0, 0, 1).applyQuaternion(startNode.quaternion);
            _tempVec1.y = 0;
            if (_tempVec1.lengthSq() > 0.0001) {
                _tempVec1.normalize();
                char.group.rotation.y = Math.atan2(_tempVec1.x, _tempVec1.z);
            } else {
                char.group.rotation.y = Math.PI;
            }
        } else {
            char.group.position.set(0, 2, 0);
            char.group.rotation.y = Math.PI;
        }
    }

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

    // Same shape as the original 48deg sliding-slope ramp in
    // buildStairsLevel(), parameterized by angle - rotated only around X,
    // so its own local top face's low edge lands at
    // y = hz*sin(angle) - hy*cos(angle) relative to this mesh's own
    // position (hz/hy = half the 14/0.6 box dimensions below), which is
    // exactly the position.y needed to sit that low edge flush with y=0
    // ground (verified against the original ramp's hand-picked y=5.0 at
    // 48deg, which this formula reproduces exactly).
    // Small canvas-texture sprite showing plain text, always facing the
    // camera - used to label each test ramp with its own angle so it can
    // be identified at a glance instead of having to remember/recompute
    // which one is which from its world position.
    function makeTextSprite(text, scale = 1.5) {
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
        const texture = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
        sprite.scale.set(scale, scale * 0.5, 1);
        // Parented to the ramp mesh below, which is itself in
        // `collidables` - Raycaster.intersectObjects recurses into
        // children by default, so without this the label's own billboard
        // quad (floating just above the ramp surface) could be the
        // closest hit instead of the actual ramp, breaking every raycast
        // that expects a real face/normal (ground detection, leg IK, wall
        // checks - anything that reads hits[0].face or .object.matrixWorld
        // assuming a real mesh surface).
        sprite.raycast = () => {};
        return sprite;
    }

    function buildSlopeTestRamp(x, z, angleDeg) {
        const angleRad = angleDeg * Math.PI / 180;
        const hz = 7, hy = 0.3;
        const rampGeo = new THREE.BoxGeometry(6, 0.6, 14);
        const ramp = new THREE.Mesh(rampGeo, platMat);
        ramp.rotation.x = angleRad;
        ramp.position.set(x, hz * Math.sin(angleRad) - hy * Math.cos(angleRad), z);
        ramp.castShadow = true; ramp.receiveShadow = true;
        // Checked by both the ledge-grab detection and the horizontal
        // wall-stop (see their own comments) - a ramp is meant to be a
        // pure slide surface, not something with grabbable edges, and its
        // walk-blocking angle is tuned separately/lower than the general
        // SLOPE_WALL_CUTOFF used for natural terrain like the hemisphere.
        ramp.userData.isSlopeRamp = true;
        ramp.userData.rampAngleRad = angleRad;
        levelGroup.add(ramp); collidables.push(ramp);

        // Angle label at the ramp's own low/right corner (local +x, +z,
        // just above the surface) - parented to the ramp mesh itself so it
        // inherits its rotation/position automatically, no separate
        // world-space math to keep in sync.
        const label = makeTextSprite(Math.round(angleDeg) + '°');
        label.position.set(2.5, 0.6, 6.5);
        label.visible = document.getElementById('toggle-angle-labels').checked;
        ramp.add(label);
        rampAngleLabels.push(label);

        return ramp;
    }

    // Decorative curved ramp prop (CurvedRamps_UniRamp.glb) - purely a
    // collidable set piece, not wired into the isSlopeRamp-specific slide/
    // walk-up-clip logic the way buildSlopeTestRamp's own ramps are.
    // Positioned directly off the model's own local origin (no bounding-box
    // ground-fit) - its root is meant to already sit at its own base, same
    // as any other game-ready export.
    function loadCurvedRampProp(x, z) {
        const propLoader = new GLTFLoader();
        propLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/LevelModel/CurvedRamps_UniRamp.glb', (gltf) => {
            const model = gltf.scene;
            // Half of Level.glb's own LEVEL_TO_PLAYER_SCALE (buildLevelFromGlb) -
            // full scale read too large here.
            model.scale.setScalar(0.325);
            model.position.set(x, 0, z);

            const shinyPlasticMat = new THREE.MeshPhysicalMaterial({
                color: 0xff7722, roughness: 0.2, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.1
            });
            // Wireframe overlay of the exact same geometry used for
            // collision - there's no separate simplified collider for this
            // prop (the visible mesh IS the collidable), so this is purely
            // to see the actual triangulation the ground raycast is
            // sampling against (see 'toggle-curved-ramp-collider' Debug Vis
            // checkbox) - useful for the reported climbing jitter, which
            // looks like the 5-ray ground sample flipping between adjacent
            // triangles with different face normals on this curved,
            // faceted surface (unlike the flat test ramps).
            const wireframeMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, wireframe: true, depthTest: false });
            // Collect the real meshes into a plain array FIRST, then add the
            // wireframe children in a separate loop - traverse() is a live
            // recursive walk, so adding a wireframe child (itself an
            // isMesh===true Object3D) to `c` WHILE still inside the same
            // traverse() call means traverse would then descend into that
            // freshly-added child too, wireframe it AGAIN, and so on - an
            // unbounded chain (caught this at 16607 objects deep).
            const realMeshes = [];
            model.traverse(c => { if (c.isMesh) realMeshes.push(c); });
            realMeshes.forEach(c => {
                c.material = shinyPlasticMat; c.castShadow = true; c.receiveShadow = true;
                const wire = new THREE.Mesh(c.geometry, wireframeMat);
                wire.raycast = () => {};
                wire.visible = document.getElementById('toggle-curved-ramp-collider').checked;
                c.add(wire);
                curvedRampWireframes.push(wire);
            });
            model.userData.isCurvedRampProp = true;

            levelGroup.add(model);
            // realMeshes only (not a fresh traverse) - the wireframe
            // overlays are now children of these same meshes and would
            // otherwise get swept in too (harmless since their raycast is
            // stubbed out, but there's no reason to carry them here).
            realMeshes.forEach(c => collidables.push(c));
        });
    }

    // A field of small cubes, each rotated 45deg (diamond-on-point), whose
    // top corner height is randomized around roughly knee height (the
    // rigged character's own knee bone sits at ~0.256 world units above
    // the ground - measured live via lKneeBone.getWorldPosition()) - some
    // a bit under, some right at, some a bit over. Meant purely to stress-
    // test the per-foot leg IK (computeFootIKTarget/applyLegIK in
    // game_js.js) against genuinely uneven, closely-packed terrain instead
    // of the single flat/sloped surface every other test area so far
    // provides - a real single-obstacle raycast per foot has nowhere to
    // "average out" bumps here.
    function buildKneeBumpField(centerX, centerZ, rows, cols, spacing, size = 0.32, baseHeight = 0.256, heightSpread = 0.22) {
        const bumpMat = new THREE.MeshToonMaterial({ color: 0x77aa88, gradientMap: threeTone });
        const startX = centerX - (cols - 1) * spacing / 2;
        const startZ = centerZ - (rows - 1) * spacing / 2;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const peakHeight = baseHeight + THREE.MathUtils.randFloatSpread(heightSpread);
                const bump = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), bumpMat);
                bump.rotation.x = Math.PI / 4;
                bump.rotation.y = Math.random() * Math.PI * 2;
                const halfDiagonal = size * Math.SQRT2 / 2;
                bump.position.set(startX + c * spacing, peakHeight - halfDiagonal, startZ + r * spacing);
                bump.castShadow = true; bump.receiveShadow = true;
                // These sit right at/past the slide-entry angle by design
                // (that's the point - genuinely uneven terrain for legIK to
                // react to), but they're small, densely packed, and
                // randomly yawed - if the ground-detection raycast treated
                // one as a real "steep slope", the whole slide-physics
                // system (built for one continuous surface with one
                // consistent downhill direction) would trigger and shove
                // the character toward THAT bump's own random slideDir,
                // then the next bump's completely different one the very
                // next frame - the reported "deliye dönüyor" chaos. This
                // flag excludes them from that specific trigger (see
                // isSteepSlope in the ground-detection block) while
                // leaving them fully solid for everything else - vertical
                // ground-follow (so the character's height still bobs over
                // them) and each foot's own independent legIK raycast.
                bump.userData.isDecorativeBump = true;
                levelGroup.add(bump); collidables.push(bump);
            }
        }
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
        rampAngleLabels.length = 0;
        const hemisphere = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: threeTone }));
        hemisphere.position.set(10, 0, -10); hemisphere.castShadow = true; hemisphere.receiveShadow = true;
        // See isOnHemisphere in the movement code.
        hemisphere.userData.isHemisphere = true;
        levelGroup.add(hemisphere); collidables.push(hemisphere);
        addHemisphereDebugHelper(hemisphere);

        // A row of test ramps, one per angle, laid out in ANGLE order (not
        // build order) so each new one actually sits physically between
        // its two neighbors instead of just tacked on at the end: below
        // the ~39.6deg slide threshold (walkable, no sliding), just past
        // it, solidly steep, and near the ~75.6deg wall cutoff (still
        // barely a slideable slope, not a wall) - plus one filled in
        // between each original pair. Moved closer to spawn (was
        // ROW_START_X=-25) and packed tighter (was ROW_SPACING=9, a 3-unit
        // gap on each side of every 6-unit-wide ramp - now half that gap,
        // 1.5 units) so walking the whole row for testing is quicker.
        const ROW_ANGLES = [25, 33, 40, 44, 48, 56, 65, 69, 72];
        const ROW_SPACING = 7.5, ROW_START_X = -15, ROW_Z = -10;
        ROW_ANGLES.forEach((deg, i) => buildSlopeTestRamp(ROW_START_X - i * ROW_SPACING, ROW_Z, deg));
        const ROW_END_X = ROW_START_X - (ROW_ANGLES.length - 1) * ROW_SPACING;

        // Decorative curved ramp prop, across from the test ramp row (same
        // X as its first entry, mirrored to the other side of Z=0).
        loadCurvedRampProp(ROW_START_X, -ROW_Z);

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

        // Jump-height test rig: two more ground-standing blocks flush
        // against stair_0's own side (-x, same z, each cubeSize wide so
        // touching just means stepping cubeSize over per block) - same
        // footprint as stair_0, but 1/4 and 2/4 (1.25x/1.5x) taller, to
        // see exactly how big a single-jump step-up the player can still
        // clear before it turns into a climb/mantle situation. -x, not
        // +x: the hemisphere sits at (10, 0, -10) with radius 6, reaching
        // out to x=4 - +x put these blocks (and the marker below) partway
        // inside its dome, invisible/clipped through solid geometry. -x is
        // clear all the way out past the ramp row (closest one starts at
        // x=-15, well past this rig's own x=-7.8 marker).
        const JUMP_TEST_HEIGHTS = [1.25, 1.5];
        JUMP_TEST_HEIGHTS.forEach((mult, i) => {
            const h = cubeSize * mult;
            const block = new THREE.Mesh(new RoundedBoxGeometry(cubeSize, h, cubeSize, 1, 0.15), platMat);
            block.position.set(-cubeSize * (i + 1), h / 2, -10);
            block.castShadow = true; block.receiveShadow = true;
            levelGroup.add(block); collidables.push(block);
        });
        // Reference marker for the SAME test: a thin, non-collidable plate
        // hovering at exactly the height the player's own head reaches at
        // the peak of a standing jump from flat ground (y=0), so it can be
        // held up against the two blocks above by eye. Derived, not
        // guessed: apex height gain above the jump's start = v0^2/(2*g)
        // with this game's actual jump/gravity constants (yVelocity=10 at
        // takeoff in handleJump(), gravity=30/s^2 in the main integrator)
        // = 100/60 = 1.667; head-top sits ~2.267 above char.group's own
        // origin (measured live via the fbxModel's world-space bounding
        // box - group's origin tracks the feet, not a fixed rig constant,
        // so this was measured rather than assumed) - 0 + 1.667 + 2.267 =
        // 3.93.
        const JUMP_APEX_HEAD_Y = 3.93;
        const jumpApexMarker = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.06, 2.5),
            new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.6 }));
        jumpApexMarker.position.set(-cubeSize * 2.6, JUMP_APEX_HEAD_Y, -10);
        levelGroup.add(jumpApexMarker);

        // Elevated walkway from the top of the stairs (last one lands at
        // (0, 16.5, -25) per the loop above) over to the ramp row, so
        // approaching a ramp by walking/falling onto its high end can be
        // tested too, not just climbing up from its low edge. Stays a
        // couple units above even the tallest (72deg) ramp's own top edge
        // the whole way, so it doesn't intersect any of them. L-shaped
        // (two straight legs) rather than one diagonal run - easier to
        // actually walk end to end with plain forward/strafe input than a
        // diagonal would be. Leg 1 heads west at the stairs' own Z; leg 2
        // then turns south along the ramp row's own X, ending above the
        // 72deg ramp's top edge - stepping off the side anywhere along
        // leg 2 means dropping a short distance onto whichever ramp is
        // below.
        const addWalkwaySegment = (x, y, z) => {
            const seg = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 8), platMat);
            seg.position.set(x, y, z);
            seg.castShadow = true; seg.receiveShadow = true;
            levelGroup.add(seg); collidables.push(seg);
        };
        const WALKWAY_LEG1_SEGMENTS = 12;
        for (let i = 0; i <= WALKWAY_LEG1_SEGMENTS; i++) {
            const t = i / WALKWAY_LEG1_SEGMENTS;
            addWalkwaySegment(THREE.MathUtils.lerp(0, ROW_END_X, t), THREE.MathUtils.lerp(16.5, 14.5, t), -25);
        }
        const WALKWAY_LEG2_SEGMENTS = 3;
        for (let i = 1; i <= WALKWAY_LEG2_SEGMENTS; i++) {
            const t = i / WALKWAY_LEG2_SEGMENTS;
            addWalkwaySegment(ROW_END_X, THREE.MathUtils.lerp(14.5, 13.5, t), THREE.MathUtils.lerp(-25, -11, t));
        }

        buildNarrowLedgeTestRig(15, 8, 1.2);
        buildNarrowLedgeTestRig(20, 8, 0.4);
        buildNarrowLedgeTestRig(25, 8, 0);

        // All four bump-test fields lined up along the same Z (20), packed
        // as close together (and to spawn at 0,0,0) as their own widths
        // allow without actually overlapping - originally spread 20 units
        // apart starting at x=45, then tightened once already; each center
        // here is spaced just past the widest of its two neighbors' half-
        // extents plus a small walkable gap, not a fixed round number.
        buildKneeBumpField(5, 20, 8, 8, 0.9);
        // Same field, right next to it, with 2x bigger bumps - spacing
        // doubled to match (keeps the same gap-to-bump-size ratio as the
        // original instead of the boxes packing tighter together).
        buildKneeBumpField(15, 20, 8, 8, 1.8, 0.64);
        // Same big (0.64) bumps as above, but spacing back down to the
        // first field's own 0.9 - packed tight the way the original was,
        // just with bigger obstacles this time.
        buildKneeBumpField(25, 20, 8, 8, 0.9, 0.64);
        // Same tight-packed big bumps, but noticeably taller - baseHeight
        // raised from knee level (~0.256) to roughly hip level (the
        // character's own hips bone sits at ~0.62 - measured live via
        // hips.getWorldPosition() the same way the knee reference was).
        buildKneeBumpField(32, 20, 8, 8, 0.9, 0.64, 0.62, 0.22);

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
        // getObstacleBox treats isMovable objects as an exact cubeSize^3
        // box regardless of this mesh's own (rounded-corner) geometry -
        // worth being able to see that they're not quite the same shape.
        addWireframeBoxDebugHelper(mBox.position, cubeSize, cubeSize, cubeSize);

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
        // Only Level 2 (buildLevelFromGlb) hides this in favor of a water
        // plane - reset here so switching back to any other level always
        // gets the grass back regardless of which level was active before.
        ground.visible = true;

        if (currentLevel === "local_stairs") buildStairsLevel();
        else if (currentLevel === "local_glb") buildLevelFromGlb();
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
        select.innerHTML = '<option value="local_stairs">Level 1 (Stairs)</option><option value="local_glb">Level 2 (Model)</option><option value="local_json">Level 3 (JSON)</option>';
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
    function placeCube(position) {
        const newCube = new THREE.Mesh(boxGeoTemplate, platMat.clone());
        newCube.position.copy(position); newCube.castShadow = true; newCube.receiveShadow = true;
        levelGroup.add(newCube); collidables.push(newCube);
        return newCube;
    }
    // Called by MultiplayerClient when another player's build-cube broadcast
    // arrives - placeCube's own local levelGroup/collidables aren't reachable
    // from multiplayer.js, so it goes through this window global instead,
    // same pattern as spawnHitEffect/spawnChargeAttackProjectile etc.
    window.placeNetworkCube = (posArray) => placeCube(new THREE.Vector3(posArray[0], posArray[1], posArray[2]));

    buildBtn.addEventListener('pointerup', (e) => {
        if (isBuilding && e.pointerId === buildActivePointerId) {
            buildBtn.releasePointerCapture(e.pointerId);
            if (canPlace) {
                placeCube(buildPreview.position);
                if (network) network.sendBuildCubeEvent(buildPreview.position);
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
    const compassArrowEl = document.getElementById('compass-arrow');
    const compassBackdropEl = document.getElementById('compass-backdrop');

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
                // Who threw it - skipped in the thrown-object hit check
                // (like chargeAttackProjectiles' own ownerId) so a bystander
                // client, whose local physics sim of this same object starts
                // right next to the thrower's own hand, doesn't immediately
                // register that as the thrower hitting themselves.
                cObj.throwOwnerId = window.multiplayerClient ? window.multiplayerClient.id : null;
                _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);

                // Launch from wherever it's actually being held right now
                // (tracks the real hand bones during carry, not carryHeight -
                // that's just the pickup animation's target) - just nudged
                // slightly forward to clear the character's own hitbox.
                // Snapping to a carryHeight-based Y here used to cause a
                // visible upward pop at the moment of throwing even with
                // throwVerticalSpeed at 0, independent of the actual launch
                // velocity.
                cObj.mesh.position.addScaledVector(_tempVec3, 0.15);

                cObj.velocity.copy(_tempVec3).multiplyScalar(window.throwHorizontalSpeed).setY(window.throwVerticalSpeed);

                if (network) network.sendThrowEvent(cObj.netId, cObj.mesh.position, cObj.mesh.quaternion, cObj.velocity);
            }

            const throwAction = char.actions['throw'];
            const throwClip = char.originalClips['throw'];

            // Not setting throwAction.time here anymore - char.animate()'s
            // fadeToAction('throw', ...) call (in ClimbGame.html) runs on the
            // very next frame and calls action.reset() internally, which
            // clobbers time back to 0 regardless of what's set here. That
            // used to cause a one-frame pose flicker (this frame showing the
            // trimmed-start pose, next frame snapping back to frame 0) and
            // effectively play the untrimmed windup every time. The trim is
            // applied once, after that reset, in ClimbGame.html instead.
            if (throwAction) {
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
    // Slope sliding: was flickering on/off right around the entry angle
    // (any tiny per-frame change in exact foot position, from the slide
    // push itself or from fighting it with input, could nudge the raycast
    // hit angle back and forth across a single fixed threshold) and had no
    // sense of acceleration/friction at all - a flat, instant 15 units/sec
    // the moment it started, dead stop the moment it didn't. wasSliding is
    // the persisted (across frames) half of a hysteresis band: use the
    // higher SLIDE_ENTER_ANGLE to *start* sliding, but only the lower
    // SLIDE_EXIT_ANGLE to *stop* - once already sliding, a momentary dip
    // just under the entry angle no longer immediately kicks you out.
    // slideSpeed is a real ramping scalar (accelerates toward a
    // steepness-dependent target while sliding, decays via friction
    // otherwise) instead of an instant on/off constant.
    let wasSliding = false, slideSpeed = 0;
    // Smooths out frame-to-frame face-normal noise on densely-triangulated
    // curved surfaces (e.g. the curved ramp prop) - the ground raycast can
    // land on adjacent triangles with meaningfully different face normals
    // from a sub-pixel shift in exact hit position, which read as visible
    // jitter (tilt, climb speed/anim rate, all of which key off groundNormal)
    // on a flat/coarse ramp too, just imperceptibly since neighboring
    // triangles there share nearly the same normal. Persists across frames;
    // lerped toward the raw per-frame groundNormal below, then that raw
    // value is overwritten with the smoothed result so every downstream
    // read this same frame benefits automatically.
    const smoothedGroundNormal = _upVec.clone();
    const SLIDE_ENTER_ANGLE = Math.PI * 0.22; // ~39.6deg
    const SLIDE_EXIT_ANGLE = Math.PI * 0.17; // ~30.6deg
    // Walking along a ramp's base line (nearly parallel to where it meets
    // the ground) makes the center ground ray alternate between the flat
    // ground and the ramp face frame to frame, so the measured slope angle
    // jumps across BOTH thresholds at once and the angle hysteresis above
    // can't stop the resulting slide/walk flicker. Entering a slide now
    // additionally requires the steep reading to have held continuously
    // for this long - intermittent single-frame steep readings at the
    // boundary keep resetting the timer and never engage the slide, while
    // genuinely walking onto a steep face still slides after an
    // imperceptible beat. Exit (while already sliding) is untouched.
    const SLIDE_ENTER_DEBOUNCE = 0.15;
    let steepGroundTimer = 0;
    const SLIDE_ACCEL = 20, SLIDE_FRICTION = 25;
    const SLIDE_MIN_SPEED = 3, SLIDE_MAX_SPEED = 15;
    // slideSpeed above is purely horizontal (applied along slideDir, which
    // has y=0) - the actual vertical descent rate it produces depends on
    // the slope's own steepness (roughly slideSpeed*tan(angle)), so as the
    // angle approaches vertical that implied fall rate can end up faster
    // than actual gravity (yVelocity's own -30/s^2) ever gets falling the
    // same height, reading as "sliding is faster than just falling off a
    // cliff" on the steepest ramps. Capping the vertical rate directly
    // (rather than the horizontal slideSpeed) keeps every slope's descent
    // just under a comparable free-fall's, regardless of angle - some
    // felt friction instead of feeling frictionless/faster than gravity.
    const SLIDE_MAX_VERTICAL_RATE = 18;
    // Set (each frame, in the ground-detection block below) whenever the
    // player is actively holding input roughly opposing the slide
    // direction - lets the movement-input block further down give them a
    // real, if slow, climb speed and normal walk-facing instead of the
    // automatic push+facing-lock fighting them the instant they let go.
    let isClimbingSlope = false;
    // Last frame's isClimbingSlope (same role wasSliding plays for
    // isSliding) - the slidable-face entry refusal below must not fire
    // against someone who was already legitimately climbing last frame.
    let wasClimbingSlope = false;
    // Set by ground detection on frames where the character is being
    // refused entry onto a slidable face (approach not deliberate enough -
    // see CLIMB_INTENT_DOT); read by the movement block the same frame
    // to also strip the into-face component of the move direction, since
    // the forward wall ray misses a face approached near-parallel.
    let steepEntryBlocked = false;
    const _steepEntryNormal = new THREE.Vector3();
    // Set alongside isClimbingSlope (reset every frame in the same place)
    // whenever the player pushes uphill against a real slide - a brief,
    // fast-decelerating continuation of the slide instead of an instant,
    // physically-wrong stop, with its own StopSliding.fbx clip (see
    // 'stop_sliding' in the animation state selection).
    let isStoppingSlide = false;
    // Smoothed (not snapped) extra height added on top of floorY when a
    // foot lands on ground higher than the center-ray reading (see the
    // foot-boost block below, near wasGrounded) - eases toward the target
    // instead of jumping straight to it every frame, since on scattered
    // small obstacles (buildKneeBumpField) which foot is in stance phase
    // touching which bump changes step to step; snapping floorY straight
    // to that raw, rapidly-changing value read as the root visibly
    // jittering rather than a smooth rise/fall onto each bump.
    let footRiseSmoothed = 0;
    // Smoothed 0..1 "how much of either foot is currently on decorative
    // bump terrain" - read by the movement block to blend in a speed
    // reduction (see bumpTerrainSpeedMult) the same eased way, rather than
    // a per-frame on/off toggle that would itself read as speed jitter.
    let bumpSpeedBlend = 0;
    // Set once per frame by the foot-boost block (near footRiseSmoothed
    // above), reused by the legIK-apply block later the same frame instead
    // of recomputing the identical raycast a second time - see that
    // block's own comment.
    let leftFootHit = null;
    let rightFootHit = null;
    // Deliberately gentler than it sounds - a high value here dumps almost
    // all the slide speed in the first fraction of a second, so the
    // character sits fully stopped for most of STOP_SLIDE_DURATION while
    // the animation keeps playing, reading as an abrupt halt rather than
    // an actual gradual slowdown. Spreads the deceleration out closer to
    // the full duration of the stopping animation instead.
    const STOP_SLIDE_FRICTION = 14;
    // Gating this phase on slideSpeed itself (skip it once speed is
    // already low) meant a player who reacts quickly - pressing uphill
    // within the first couple frames of even starting to slide, before
    // SLIDE_ACCEL has built up much speed at all - skipped straight to
    // the climb state and never saw the animation, which is the common
    // case, not an edge case. A fixed timer instead guarantees the
    // stopping animation always gets its full duration on screen
    // regardless of how fast the player reacts or how much speed there
    // actually was to bleed off.
    let stopSlideTimer = 0;
    const STOP_SLIDE_DURATION = 0.5;
    // How long into the stop to keep the body moving at full speed before
    // any friction kicks in - matches the animation crossfade duration
    // (see 'dur' in Character.animate) so the body has actually travelled
    // by the time the sliding pose has fully blended into the stopping
    // one, instead of the lead foot appearing to yank itself backward
    // while the body barely moved.
    const STOP_SLIDE_HOLD = 0.2;
    // All live-tunable via panel sliders now (window.hitRecoveryDuration/
    // recoveryStepSpeed/recoveryStrengthMultMax/hitRecoveryAnimSpeedMin/Max,
    // see their init below and ragdoll_physics.js's matching
    // window.hitRecoveryDuration read) - the fixed defaults here only
    // matter as a fallback if read before that init has run.
    const HIT_RECOVERY_DURATION_DEFAULT = 0.35;
    const RECOVERY_STEP_SPEED_DEFAULT = 3.5;
    const _climbInputDir = new THREE.Vector3();
    let networkStateName = 'idle';
    let networkCarryUpper = false;
    // Last movement-input angle (world yaw, cameraTheta+atan2(curX,curY)
    // convention) while there WAS meaningful input - read by the ledge-
    // grab wall-detection ray (see its own comment) so a jump fired the
    // instant the player lets go of the stick (a completely normal thing
    // to do right as you press jump - the single-frame input read this
    // used to fall back on was zero almost as often as it was stale
    // facing) still aims at where they were actually just running,
    // instead of silently reverting to the same lagging body-facing bug
    // this was meant to fix in the first place.
    let lastMoveIntentAng = 0;
    let hasMoveIntent = false;
    // Matches '#ledge-force-slider's own HTML default (0.6) - uiBindings'
    // init only wires an 'input' listener, it never applies the slider's
    // starting value on load, so this has to be kept in sync by hand or
    // the two silently disagree until the user first touches the slider.
    let lastLedgeState = false, lockedHintAngle = null, ledgeGrabTimer = 0, ledgeGrabCooldown = 0, ledgeJumpMultiplier = 0.6, landingTimer = 0, initialLandingTimer = 0;
    let ledgeOffset = 0.06, ledgeMoveLocked = false, ledgeSidewaysGesture = false, baseLandingAnimDuration = 0.25, climbTransitionDuration = 0.20;
    let wallStopThreshold = 0.90;
    // How fast the character's facing turns to match the movement/slide
    // direction (a slerp factor, higher = snappier) - was 15, bumped to 40
    // for feeling too slow/laggy on direction reversals, then eased back
    // down after 40 itself read as a bit too snappy. Still exposed on
    // window so it can be tuned further from the console without a
    // reload if needed.
    window.CHAR_TURN_RATE = 28;
    // Surfaces steeper than this (measured from the real, un-flattened hit
    // normal) count as a genuine wall for the horizontal wall-stop below,
    // not a climbable/slideable slope - comfortably past the ~39.6deg
    // slide-eligibility threshold, short of vertical.
    const SLOPE_WALL_CUTOFF = Math.PI * 0.42;
    // Purpose-built test ramps (userData.isSlopeRamp) use their own, lower
    // walk-blocking angle instead of SLOPE_WALL_CUTOFF above - the two
    // steepest ones (65/72deg) are meant to read as an unclimbable cliff
    // face on foot even though they're still well under the general
    // 75.6deg cutoff (which exists for natural terrain like the
    // hemisphere, where nothing marks a "this angle is a hard wall"
    // intent this explicitly). Landing/being pushed onto one from above
    // is untouched by this - only the horizontal approach is blocked;
    // isSliding's own threshold (SLIDE_ENTER_ANGLE) still applies once
    // grounded there regardless of how you got there.
    const RAMP_WALK_BLOCK_ANGLE = Math.PI * (58 / 180);
    // Minimum UPHILL component of the input direction (dot against the
    // face's outward downhill normal, ~0.08 = ~5deg above parallel) for
    // the input to count as "wants to go up" on a slidable face. ONE
    // shared threshold for all three consumers - the climb trigger in the
    // slide state machine, the base-seam entry refusal, and the movement
    // block's wall treatment - after a round of separate thresholds
    // (climb at ~72deg-off, entry at ~37deg-off) left mismatch zones that
    // stalled or flung the character. Any input above this climbs, right
    // from the base seam, with no debounce and no slide flash (explicit
    // user direction: walking just-above-parallel must go UP, never
    // slide); anything at/below it while walking is refused entry
    // entirely; sliding stays reserved for no-input/downhill situations.
    const CLIMB_INTENT_DOT = 0.08;
    // Air-control speed multiplier while airborne - normally full (1.0),
    // dropped for the duration of a jump launched while climbing a
    // slidable slope (see handleJump): full 8u/s air speed is ~4x the
    // climb crawl, so one mid-climb hop with any stick misalignment used
    // to fling the character clean off the ramp's side. Re-set on every
    // jump, snapped back to 1.0 whenever grounded.
    let airControlMult = 1.0;
    let carryTargetObj = null;
    let isSlipping = false;
    let slipTimer = 0;
    let ledgeSlipDuration = 0.05;
    let ledgeDropPushback = 0.12;
    let carryHeight = 2.45, throwTrimStart = 0.25, projSize = 0.3, projSpeed = 20.0;
    window.throwTrimStart = throwTrimStart; // mirrored for ClimbGame.html's Character.animate() to read
    window.throwSpeedMult = 1.0;
    window.throwHorizontalSpeed = 10.0;
    window.throwVerticalSpeed = 1.0;
    window.throwHitForce = 35;
    window.throwHitRadius = 0.8;
    window.spineBlendValue = 1.00;
    window.orangeRecoilForce = 60.0;
    window.hitRecoveryDelay = 0.02;
    window.hitRecoveryDuration = HIT_RECOVERY_DURATION_DEFAULT;
    window.recoveryStepSpeed = RECOVERY_STEP_SPEED_DEFAULT;
    window.recoveryStrengthMultMax = 6.0;
    window.hitRecoveryAnimSpeedMin = 1.5;
    window.hitRecoveryAnimSpeedMax = 6.0;
    // Multiplies speedMult while on isDecorativeBump terrain (see
    // bumpSpeedBlend) - 1.0 would mean no slowdown, lower = slower. Applied
    // through the same eased blend as the root foot-rise, not a hard
    // per-frame toggle.
    window.bumpTerrainSpeedMult = 0.6;
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
    window.rampWalkAnimSpeed = 1.3;
    window.chargePunchKnockback = 15.0;
    window.chargeAttackProjectileSpeed = 5.0;
    window.chargeAttackProjectileFadeRate = 3.0;
    window.chargeAttackProjectileHitCutoff = 0.3;
    window.playerStagger = 100.0;
    window.playerStaggerMax = 100.0;
    window.playerStaggerRegenRate = 20.0;
    window.playerStaggerRegenDelay = 2.5;
    window.playerStaggerRegenCooldown = 0;
    // Same hidden poise pool as window.playerStagger above, mirrored for
    // the AI bot - multiplayer.js's _applyPunchEvent already has this for
    // real PvP targets (a flurry of non-ragdoll hits chips it down, and
    // once exhausted the next hit knocks them down even if it's a light
    // one; a gap without being hit lets it refill), the bot's own hit path
    // in ClimbGame.html's detectMeleeHits never had an equivalent - every
    // hit was judged purely on its own forceMagnitude, so no amount of
    // never letting the bot recover between combo hits could ever knock
    // it down on its own.
    window.aiBotStagger = 100.0;
    window.aiBotStaggerMax = 100.0;
    window.aiBotStaggerRegenRate = 20.0;
    window.aiBotStaggerRegenDelay = 2.5;
    window.aiBotStaggerRegenCooldown = 0;
    const STAMINA_MAX = 100, REGEN_RATE = 25, HANG_DRAIN = 2, JUMP_COST = 8, LEDGE_JUMP_COST = 12, LEDGE_MOVE_COST = 4, CLIMB_COST = 4;
    // Between HANG_DRAIN (passive hanging) and CLIMB_COST (the quick
    // ledge climb-up action) - actively climbing a steep/slidable ramp
    // (isClimbingSlope, only ever true above the slide-entry angle) is
    // sustained effort like hanging, not a one-off action like the ledge
    // climb-up, so it's charged per second the same way, just a bit
    // steeper since you're also making real progress against it (unlike
    // hanging in place). Angle-scaled at the drain site (same climbT as
    // speed): the shallowest slidable slope drains at the base rate
    // (~33s of full bar), the steepest still-climbable one at the max
    // (~12s of full bar).
    const RAMP_CLIMB_DRAIN = 3, RAMP_CLIMB_DRAIN_MAX = 8;


    function handleJump() {
        if (char.isRagdoll || char.isStandingUp || isSlipping || isClimbingUp) return;
        if (isHoldingMovable) {
            isHoldingMovable = false; heldBox = null; holdBtn.innerText = 'HOLD';
            document.getElementById('base-left').classList.remove('hold-mode');
        }
        if (stamina < JUMP_COST || landingTimer > 0) return;
        if (isGrounded && !isLedgeGrabbing && !isClimbingUp) {
            stamina -= JUMP_COST; isGrounded = false; landingTimer = 0;
            // Jumping off a slide used to just cancel all speed and pop
            // straight up in place at the same fixed height as any other
            // jump - carry the slide's own speed and direction into the
            // jump instead, both horizontally AND vertically, the way
            // actually launching off a slope while moving fast gives you
            // more air than jumping from a standstill. isSliding itself is
            // a per-frame-local flag from the animate loop and not visible
            // here, but wasSliding (updated every frame, same scope as
            // this function) is a frame-old proxy for "still sliding right
            // now" that's accurate enough for a keypress landing between
            // frames. _slideDirScratch keeps its last-set value (the
            // ground-detection block only touches it while isSteepSlope is
            // true) so it still holds the correct direction here.
            // isClimbingSlope/isStoppingSlide excluded: both can coexist
            // with wasSliding for a few frames (the stop-slide transition,
            // or slide/climb flapping right at a ramp's base line), and
            // leftover slideSpeed along the DOWNHILL slideDir hurled a
            // player who was jumping to gain height while climbing off
            // the ramp instead. Only a genuine, ongoing slide carries its
            // momentum into the jump.
            if (wasSliding && !isClimbingSlope && !isStoppingSlide) {
                yVelocity = 10 + slideSpeed * 0.4;
                jumpMomentum.addScaledVector(_slideDirScratch, slideSpeed);
            } else {
                yVelocity = 10;
            }
            // See airControlMult's own comment - a hop launched mid-climb
            // keeps only a fraction of normal air speed so it stays a
            // controllable straight-up hop instead of a 4x-speed lunge
            // off the ramp's side. Every other jump gets full air control.
            airControlMult = (isClimbingSlope || isStoppingSlide) ? 0.4 : 1.0;
        }
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
                // Was 15 - height (yVelocity, still 10) reads fine, but the
                // horizontal push carries for the whole ~0.67s air time
                // (until yVelocity brings it back to launch height, from
                // v0=10 and gravity=30), landing noticeably further out
                // than intended. 12 trims that same-air-time distance by
                // ~20% without touching the jump's height/arc feel.
                jumpMomentum.copy(_tempVec1.negate().multiplyScalar(12 * ledgeJumpMultiplier));
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
        { id: 'ramp-walk-speed-slider', vId: 'ramp-walk-speed-val', func: v => window.rampWalkAnimSpeed = v, fix: 2 },
        { id: 'carry-height-slider', vId: 'carry-height-val', func: v => carryHeight = v },
        { id: 'throw-speed-slider', vId: 'throw-speed-val', func: v => window.throwSpeedMult = v },
        { id: 'throw-horizontal-slider', vId: 'throw-horizontal-val', func: v => window.throwHorizontalSpeed = v, fix: 1 },
        { id: 'throw-vertical-slider', vId: 'throw-vertical-val', func: v => window.throwVerticalSpeed = v, fix: 1 },
        { id: 'throw-trim-slider', vId: 'throw-trim-val', func: v => { throwTrimStart = v; window.throwTrimStart = v; } },
        { id: 'throw-hit-force-slider', vId: 'throw-hit-force-val', func: v => window.throwHitForce = v, fix: 0 },
        { id: 'throw-hit-radius-slider', vId: 'throw-hit-radius-val', func: v => window.throwHitRadius = v, fix: 2 },
        { id: 'spine-blend-slider', vId: 'spine-blend-val', func: v => { window.spineBlendValue = v; char.buildClips(); } },
        { id: 'slip-dur-slider', vId: 'slip-dur-val', func: v => ledgeSlipDuration = v },
        { id: 'drop-pushback-slider', vId: 'drop-pushback-val', func: v => ledgeDropPushback = v },
        { id: 'proj-size-slider', vId: 'proj-size-val', func: v => projSize = v, raw: true },
        { id: 'proj-speed-slider', vId: 'proj-speed-val', func: v => projSpeed = v, raw: true },
        { id: 'orange-recoil-slider', vId: 'orange-recoil-val', func: v => window.orangeRecoilForce = v, raw: true },
        { id: 'collider-density-slider', vId: 'collider-density-val', func: v => char.updateColliderDensity(v), fix: 0 },
        { id: 'ragdoll-lateral-stiffness-slider', vId: 'ragdoll-lateral-stiffness-val', func: v => window.ragdollLateralStiffness = v },
        { id: 'ragdoll-damping-slider', vId: 'ragdoll-damping-val', func: v => window.ragdollDamping = v },
        { id: 'hit-recovery-delay-slider', vId: 'hit-recovery-delay-val', func: v => window.hitRecoveryDelay = v, fix: 2 },
        { id: 'hit-recovery-duration-slider', vId: 'hit-recovery-duration-val', func: v => window.hitRecoveryDuration = v, fix: 2 },
        { id: 'recovery-step-speed-slider', vId: 'recovery-step-speed-val', func: v => window.recoveryStepSpeed = v, fix: 1 },
        { id: 'recovery-strength-mult-max-slider', vId: 'recovery-strength-mult-max-val', func: v => window.recoveryStrengthMultMax = v, fix: 1 },
        { id: 'hit-recovery-anim-speed-min-slider', vId: 'hit-recovery-anim-speed-min-val', func: v => window.hitRecoveryAnimSpeedMin = v, fix: 2 },
        { id: 'hit-recovery-anim-speed-max-slider', vId: 'hit-recovery-anim-speed-max-val', func: v => window.hitRecoveryAnimSpeedMax = v, fix: 2 },
        { id: 'bump-terrain-speed-mult-slider', vId: 'bump-terrain-speed-mult-val', func: v => window.bumpTerrainSpeedMult = v, fix: 2 },
        { id: 'charge-streak-opacity-slider', vId: 'charge-streak-opacity-val', func: v => window.chargeStreakOpacity = v },
        { id: 'charge-streak-base-radius-slider', vId: 'charge-streak-base-radius-val', func: v => window.chargeStreakBaseRadius = v },
        { id: 'charge-streak-radius-spread-slider', vId: 'charge-streak-radius-spread-val', func: v => window.chargeStreakRadiusSpread = v },
        { id: 'punch-particle-scale-slider', vId: 'punch-particle-scale-val', func: v => window.punchParticleScale = v },
        { id: 'punch-hit-time-slider', vId: 'punch-hit-time-val', func: v => window.punchHitTime = v },
        { id: 'charge-punch-hit-time-slider', vId: 'charge-punch-hit-time-val', func: v => window.chargePunchHitTime = v },
        { id: 'combo-hit1-time-slider', vId: 'combo-hit1-time-val', func: v => window.comboHit1Time = v },
        { id: 'charge-punch-force-slider', vId: 'charge-punch-force-val', func: v => window.chargePunchForce = v },
        // Deliberately NOT pre-set at module scope like chargePunchForce
        // above (line ~2698) - startChargePunch (ClimbGame.html) checks
        // `window.chargePunchChargeTime !== undefined` and falls back to
        // the punch_charge_hold clip's own natural duration when it's
        // untouched, which is the correct zero-config default (matches
        // pre-this-feature behavior exactly). Pre-setting it here to
        // match the slider's own "1.0" display would risk silently
        // overriding that natural duration with a guessed number instead.
        { id: 'charge-punch-time-slider', vId: 'charge-punch-time-val', func: v => window.chargePunchChargeTime = v },
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
        // Not in debugHelpers - see the comment on Sandbag's own
        // this.hitboxHelper for why (it survives level rebuilds that wipe
        // that array, so it can't live in it).
        if (window.sacks) window.sacks.forEach(s => { if (s.hitboxHelper) s.hitboxHelper.visible = checked; });
    });
    document.getElementById('toggle-ragdoll-colliders').addEventListener('change', e => char.toggleRagdollColliders(e.target.checked));
    document.getElementById('toggle-angle-labels').addEventListener('change', e => {
        const checked = e.target.checked;
        rampAngleLabels.forEach(l => { l.visible = checked; });
        if (window._yawLabelSprite) window._yawLabelSprite.visible = checked;
    });
    document.getElementById('toggle-curved-ramp-collider').addEventListener('change', e => {
        curvedRampWireframes.forEach(w => { w.visible = e.target.checked; });
    });
    document.getElementById('toggle-speed-label').addEventListener('change', e => {
        if (window._speedLabelSprite) window._speedLabelSprite.visible = e.target.checked;
    });

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

    document.getElementById('toggle-pixel-effect').addEventListener('change', e => {
        window.pixelEffectEnabled = e.target.checked;
    });
    document.getElementById('pixel-size-slider').addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        renderPixelatedPass.setPixelSize(v);
        document.getElementById('pixel-size-val').textContent = v;
    });
    document.getElementById('pixel-normal-edge-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        renderPixelatedPass.normalEdgeStrength = v;
        document.getElementById('pixel-normal-edge-val').textContent = v.toFixed(2);
    });
    document.getElementById('pixel-depth-edge-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        renderPixelatedPass.depthEdgeStrength = v;
        document.getElementById('pixel-depth-edge-val').textContent = v.toFixed(2);
    });

    document.getElementById('toggle-ortho-camera').addEventListener('change', e => {
        window.orthoCameraEnabled = e.target.checked;
    });
    document.getElementById('ortho-zoom-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.orthoViewSize = v;
        updateOrthoFrustum();
        document.getElementById('ortho-zoom-val').textContent = v;
    });

    document.getElementById('toggle-compass-3d').addEventListener('change', e => {
        window.compass3DEnabled = e.target.checked;
    });
    document.getElementById('toggle-compass-2d').addEventListener('change', e => {
        window.compass2DEnabled = e.target.checked;
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
        // Same regen tick as the player's own stagger pool above, for the
        // AI bot's mirrored one (see window.aiBotStagger's own comment).
        if (window.aiBotStaggerRegenCooldown > 0) {
            window.aiBotStaggerRegenCooldown -= delta;
        } else if (window.aiBotStagger < window.aiBotStaggerMax) {
            window.aiBotStagger = Math.min(window.aiBotStaggerMax, window.aiBotStagger + window.aiBotStaggerRegenRate * delta);
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
            // The star mesh is authored flat with its face along local +Y
            // (lying down), not the +Z a plain camera.quaternion copy
            // assumes as "forward" - without starFrontFix the star tracks
            // the camera's rotation correctly (facing math checks out) but
            // shows its top/edge rather than its face. starFrontFix rotates
            // +Y to +Z first so the rest of the billboard math lines up.
            star.quaternion.copy(_tempQuat.invert().multiply(camera.quaternion).multiply(starFrontFix));
        });

        for (let i = activeMorphTweens.length - 1; i >= 0; i--) {
            const t = activeMorphTweens[i];
            t.elapsed += delta;
            const p = Math.min(1, t.elapsed / t.duration);
            t.mesh.morphTargetInfluences[t.idx] = t.from + (t.to - t.from) * p;
            if (p >= 1) {
                activeMorphTweens.splice(i, 1);
                if (t.onComplete) t.onComplete();
            }
        }

        for (let i = activeScaleTweens.length - 1; i >= 0; i--) {
            const t = activeScaleTweens[i];
            t.elapsed += delta;
            const p = Math.min(1, t.elapsed / t.duration);
            t.obj.scale.setScalar(t.from + (t.to - t.from) * p);
            if (p >= 1) {
                activeScaleTweens.splice(i, 1);
                if (t.onComplete) t.onComplete();
            }
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
                            // A bystander's client spawns a visual-only copy of
                            // someone else's charge projectile (see RemoteAvatar.
                            // updatePunchEffects) starting right at that player's
                            // own hand - without this it could immediately
                            // register as a hit against its own thrower's remote
                            // avatar and send a punch event back to them.
                            if (remoteId === cp.ownerId) return;
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

                    // AI bot is local-only (no socket/id) - same reaction
                    // detectMeleeHits already applies for a regular/charge
                    // punch landing on it (ClimbGame.html), applied directly
                    // instead of through sendPunchEvent since there's no
                    // remote to send it to. This projectile only ever fires
                    // from the local player's own charge attack, so unlike
                    // the remotes check above there's no bystander-mirror
                    // self-hit case to guard against here.
                    if (!consumed && window.aiBot && window.aiBot.isLoaded && !window.aiBot.isRagdoll) {
                        const botHitPos = window.aiBot.getHitReferencePoint();
                        if (botHitPos.distanceTo(cp.mesh.position) < chargeHitRadius + 1.0) {
                            if (window.createHandHitEffect) window.createHandHitEffect(cp.mesh.position);
                            if (window.spawnHitEffect) window.spawnHitEffect(cp.mesh.position.clone());
                            const intensity = chargeForce >= 70 ? 'high' : (chargeForce >= 45 ? 'medium_high' : 'medium');
                            const flashStrengthByIntensity = { medium: 0.9, medium_high: 1.4, high: 2.5 };
                            const strength = flashStrengthByIntensity[intensity] || 1.0;
                            const knockback = window.chargePunchKnockback !== undefined ? window.chargePunchKnockback : 15;
                            const magnitudeForRagdoll = intensity === 'high' ? knockback : chargeForce;
                            const botVelocity = impactDir.clone().multiplyScalar(magnitudeForRagdoll);
                            window.aiBot.triggerHitFlash(strength);
                            if (intensity === 'high') window.aiBot.initRagdoll(botVelocity, intensity);
                            else window.aiBot.applyProceduralRecoil(botVelocity, intensity);
                            consumed = true;
                        }
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
        // Ground-scan-only variant, excluding isDecorativeBump terrain
        // (see buildKneeBumpField) - those small bumps still need to be in
        // solidCollidables itself for the per-foot legIK raycasts
        // (computeFootIKTarget) and normal horizontal collision, but
        // having them ALSO picked up by the coarse 5-offset-ray floorY/
        // groundNormal scan below meant that scan's own single highest-hit
        // reading flipped between a bump-top and the flat ground right
        // next to it from one frame to the next, independent of (and in
        // addition to) the already-smoothed per-foot boost - the root
        // visibly jittering even with that smoothing in place. Every bump
        // contributing to standing height now flows through exactly one
        // path (the smoothed foot-boost), not two uncoordinated ones.
        const groundScanCollidables = solidCollidables.filter(c => !(c.userData && c.userData.isDecorativeBump));

        if (Math.abs(input.right.x) > 0.05 || Math.abs(input.right.y) > 0.05) {
            cameraTheta -= input.right.x * 0.04;
            cameraPhi = Math.max(0.1, Math.min(3.0, cameraPhi - input.right.y * 0.04));
        }

        let lightTrack = _tempVec2.copy(char.group.position);
        if (char.isRagdoll) {
            const hipsP = char.ragdollParticles.find(p => p.id === 'hips');
            if (hipsP) lightTrack.copy(hipsP.pos);
        }

        // Ticks down every frame regardless of which branches run below -
        // unlike the old in-branch decrement, this has to keep counting
        // through the initial "bend only, no stepping yet" delay portion
        // too (see HIT_RECOVERY_DELAY), which the movement block's own
        // isHitRecovering branch doesn't even enter during.
        if (char.hitRecoveryTimer > 0) char.hitRecoveryTimer = Math.max(0, char.hitRecoveryTimer - delta);
        // True only once the timer has counted down PAST the initial delay
        // portion into its last window.hitRecoveryDuration seconds - the window
        // where the recovery step itself (movement override + directional
        // anim) is actually active. Read by both the movement block and
        // the animation state-selection chain further below.
        const hitRecoveryStepActive = char.hitRecoveryTimer > 0 && char.hitRecoveryTimer <= window.hitRecoveryDuration && !char.isRagdoll;
        // Read by Character.animate() (ClimbGame.html) to know whether
        // THIS frame's 'walk' state is the hit-recovery forward-step
        // variant or an ordinary player-driven walk - both share the same
        // state name, so window.hitRecoveryAnimSpeed alone (which persists
        // stale between hits) isn't a reliable enough signal on its own.
        window.isHitRecoveryStepActive = hitRecoveryStepActive;

        let floorY = 0;
        let isSliding = false;
        // Reset every frame here (unlike isSliding, this one's declared
        // outside this function so the movement-input block further down
        // can still read it) - only the branch below ever sets it true, so
        // without this it would keep whatever value it had on the last
        // frame that branch actually ran, on any frame that doesn't reach
        // it at all (ungrounded, ledge-grabbing, not a steep slope, etc.).
        isClimbingSlope = false;
        isStoppingSlide = false;
        steepEntryBlocked = false;
        // Horizontal (downhill) direction of the slope currently being slid
        // on - only meaningful while isSliding is true this frame, set
        // alongside it below. Used later (see the animation state
        // selection) to face the character the way they're actually sliding.
        let slideDir = _slideDirScratch;
        let groundNormal = _upVec.clone();
        // Mirrors the inner (else-block-scoped) groundHitObject once it's
        // settled each frame - needed outside that block too (e.g. to check
        // userData.isSlopeRamp for the WalkingUp.fbx animation swap), same
        // reason floorY/groundNormal themselves are already declared out
        // here instead of inside that block.
        let lastGroundObject = null;

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
            let steepestAngle = -Infinity;
            let hasSteepCandidate = false;
            let steepestY = 0;
            let groundHitObject = null;
            let steepestHitObject = null;
            let hasCenterHit = false;
            let centerY = 0;
            let centerHitObject = null;

            for (let i = 0; i < rayOffsets.length; i++) {
                const offset = rayOffsets[i];
                let testOrigin = _tempVec1.copy(char.group.position).add(offset);
                testOrigin.y += 1.2;
                rayDown.set(testOrigin, _downVec);
                const hits = rayDown.intersectObjects(groundScanCollidables);
                if (hits.length > 0) {
                    const hitY = hits[0].point.y;
                    if (hitY <= char.group.position.y + 0.8) {
                        hitAnything = true;
                        if (hitY > highestY) {
                            highestY = hitY;
                            groundNormal.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
                            groundHitObject = hits[0].object;
                        }
                        // Also track whichever of the 5 offset rays sees
                        // the steepest surface, regardless of its height -
                        // used below only while already sliding, to avoid
                        // flip-flopping right at a slope's low edge (see
                        // that comment).
                        _candidateNormalScratch.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
                        const candidateAngle = _candidateNormalScratch.angleTo(_upVec);
                        if (candidateAngle > steepestAngle) {
                            steepestAngle = candidateAngle;
                            steepestY = hitY;
                            _steepestNormalScratch.copy(_candidateNormalScratch);
                            hasSteepCandidate = true;
                            steepestHitObject = hits[0].object;
                        }
                        // rayOffsets[0] is the (0,0,0) center ray, directly
                        // under the character - remember its own reading
                        // separately (see below for why).
                        if (i === 0) {
                            hasCenterHit = true;
                            centerY = hitY;
                            centerHitObject = hits[0].object;
                            _centerNormalScratch.copy(_candidateNormalScratch);
                        }
                    }
                }
            }
            // Prefer the center ray's own single-point reading over
            // "whichever of the 5 is highest" whenever it has a hit at all.
            // Two adjacent surfaces that are only centimeters apart in
            // height (a ramp's low edge meeting flat ground, for instance)
            // is exactly where "highest of 5 rays a body-width apart"
            // becomes ambiguous - it can flip between the two surfaces from
            // one frame to the next off of sub-frame position noise alone,
            // even standing still, because the offset rays are sampling
            // genuinely different ground truth a few centimeters to either
            // side of the character. A single point sample has no such
            // ambiguity: it reads whichever surface is actually under the
            // character's own center, and transitions exactly once as they
            // physically cross the seam. The other 4 offset rays remain in
            // play only as a fallback for when the center ray itself has no
            // hit at all (standing right at an edge/corner).
            if (hasCenterHit) {
                groundNormal.copy(_centerNormalScratch);
                highestY = centerY;
                groundHitObject = centerHitObject;
            }
            // While already sliding, stick with whichever offset ray sees
            // the steepest surface (as long as it's still above the exit
            // angle) instead of whichever is merely highest/centered - a
            // fast-moving slide can have the center ray briefly leave the
            // slope's own surface (landing just past its edge) while the
            // character is still very much sliding on it.
            if (wasSliding && hasSteepCandidate && steepestAngle > SLIDE_EXIT_ANGLE) {
                groundNormal.copy(_steepestNormalScratch);
                highestY = steepestY;
                groundHitObject = steepestHitObject;
            }
            lastGroundObject = groundHitObject;
            smoothedGroundNormal.lerp(groundNormal, Math.min(1, 15 * delta)).normalize();
            groundNormal.copy(smoothedGroundNormal);

            if (hitAnything) {
                // isStandPositionClear falls back to a cached, one-time
                // bounding box for any collidable that isn't specifically
                // isMovable/isCarryable (see getObstacleBox) - fine for
                // roughly box-shaped level geometry, but for something
                // large and curved (the hemisphere) that box spans its
                // entire footprint, nothing like the actual surface. Since
                // isSteppingUp is true almost every frame while climbing a
                // continuously-rising curved surface, that gate would
                // reject the step-up on nearly every frame anywhere on it,
                // freezing floorY at the character's own stale position
                // forever and never reaching the isSliding branch below.
                // Steep slopes don't need "standing room" anyway - they're
                // about to get pushed back off - so let them bypass this
                // gate entirely instead. Ramps below the slide threshold hit
                // the exact same loose-AABB problem despite being plain
                // walkable surfaces (no sliding involved at all) - their
                // getObstacleBox fallback is still the whole tilted box's
                // bounding extent, not the thin slab itself, so a ramp is
                // exempted outright regardless of its own angle; the
                // separate pushOutOfRampUnderside check (see its own
                // comment) already handles the one case this gate would
                // otherwise have caught (walking into an overhang with too
                // little headroom).
                const slopeAngle = groundNormal.angleTo(_upVec);
                // Small decorative clutter (see buildKneeBumpField) is
                // explicitly excluded here even when individually steeper
                // than the slide threshold - see its own userData comment
                // for why treating dense, randomly-oriented small bumps as
                // "the one slope you're sliding on" breaks down.
                const isDecorativeBump = groundHitObject && groundHitObject.userData && groundHitObject.userData.isDecorativeBump;
                // See SLIDE_ENTER_DEBOUNCE's own comment - entry needs the
                // steep reading to persist, exit hysteresis is unchanged.
                const rawSteepReading = !isDecorativeBump && slopeAngle > SLIDE_ENTER_ANGLE;
                steepGroundTimer = rawSteepReading ? steepGroundTimer + delta : 0;
                const isSteepSlope = wasSliding
                    ? (!isDecorativeBump && slopeAngle > SLIDE_EXIT_ANGLE)
                    : (rawSteepReading && steepGroundTimer >= SLIDE_ENTER_DEBOUNCE);
                const isOnRamp = groundHitObject && groundHitObject.userData && groundHitObject.userData.isSlopeRamp;
                // Same reasoning as isOnRamp: isStandPositionClear falls
                // back to a cached AABB (getObstacleBox) that's the dome's
                // whole 12x12x6 bounding box, nothing like the thin curved
                // shell actually underfoot. The earlier fix for this only
                // exempted the STEEP (isSteepSlope) part of the dome, so
                // walking up the shallower base first (still isSteppingUp
                // almost every frame on a continuous curve, but not yet
                // past the slide angle) kept hitting the same false
                // "blocked" verdict and froze floorY there - reported as
                // "gets stuck partway up". Exempting the whole hemisphere
                // regardless of local steepness fixes both zones the same
                // way ramps already are.
                const isOnHemisphere = groundHitObject && groundHitObject.userData && groundHitObject.userData.isHemisphere;
                const isSteppingUp = highestY > char.group.position.y + 0.05;
                const blockedByStandCheck = isSteppingUp && !isSteepSlope && !isOnRamp && !isOnHemisphere &&
                    !isStandPositionClear(char.group.position.x, highestY + 0.05, char.group.position.z, null);
                // Entry refusal for slidable faces, ground-path version of
                // the CLIMB_INTENT_DOT wall gate: walking nearly parallel
                // to a ramp's base line with a slight uphill drift slips
                // past the forward wall ray (which misses a face it runs
                // almost parallel to), creeps up the face via this very
                // ground-follow, gets slid back off, creeps up again - the
                // reported walk-slide-walk oscillation on 40-48deg ramps.
                // Refuse the ground-follow onto the face here, at the
                // source, unless the input genuinely points into the face
                // (or the character was already sliding/climbing -
                // mid-slide ground-follow and an established climb must
                // never be interrupted by this).
                // Deliberately NOT gated on any single "stepping up" frame:
                // the center ray flips to the steep face the exact frame
                // the character's center crosses the base seam, where the
                // face is only ~1-2cm above the flat - far below any
                // step-height threshold - and after that the per-frame
                // rise while grinding along the base never exceeds one.
                // The refusal instead re-fires on EVERY grounded frame the
                // center reads steep without an established slide/climb
                // and without deliberate input (verified at the user-
                // reported leak yaws, 107/263deg on the test ramps).
                // While refusing, the slide-entry debounce timer is pinned
                // to zero so the grind can never mature into a slide.
                // The face must also be at/above the character's own feet
                // (entry from below/level) - walking DOWNHILL onto a face
                // from its crest reads steep with non-deliberate input
                // too, but holding floorY there would leave the character
                // walking on air past the edge; that case falls through to
                // the normal ground-follow + slide machine instead.
                // Input-driven only: with no movement input at all there is
                // no walk-in to refuse, and the slide machine must stay in
                // charge - a character dropped/landing onto mid-face with
                // no input held would otherwise be caught by this (a short
                // drop doesn't accumulate enough steepGroundTimer to take
                // the escape below) and left standing impossibly still on
                // a slidable face instead of sliding off it.
                if (rawSteepReading && !wasSliding && !wasClimbingSlope
                    && isGrounded && !isLedgeGrabbing && !isClimbingUp && !blockedByStandCheck
                    && highestY >= char.group.position.y - 0.05
                    && steepGroundTimer <= SLIDE_ENTER_DEBOUNCE) {
                    const ecx = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
                    const ecy = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
                    if (Math.sqrt(ecx * ecx + ecy * ecy) > 0.1) {
                        _steepEntryNormal.set(groundNormal.x, 0, groundNormal.z).normalize();
                        const entryAng = cameraTheta + Math.atan2(ecx, ecy);
                        _climbInputDir.set(Math.sin(entryAng), 0, Math.cos(entryAng));
                        const hasUphillIntent = _climbInputDir.dot(_steepEntryNormal) < -CLIMB_INTENT_DOT;
                        if (!hasUphillIntent) {
                            steepEntryBlocked = true;
                            steepGroundTimer = 0;
                        }
                    }
                }
                if (blockedByStandCheck || steepEntryBlocked) {
                    floorY = char.group.position.y;
                } else {
                    floorY = highestY;
                    // Gated on the RAW steep reading, not the debounced
                    // isSteepSlope: the climb decision inside must engage
                    // the very frame the character's center crosses onto a
                    // steep face with uphill input - waiting out the
                    // debounce here meant ~0.15s of ordinary walk (wrong
                    // animation, and a window for stray slide flashes)
                    // right at the base seam before the climb state took
                    // over. The debounce still gates the SLIDE branch
                    // below - it exists to stop seam flicker from
                    // alternating flat/steep readings, which is purely a
                    // slide-entry problem.
                    if (rawSteepReading && isGrounded && !isLedgeGrabbing && !isClimbingUp) {
                        slideDir.set(groundNormal.x, 0, groundNormal.z).normalize();

                        // Holding input roughly uphill (opposing slideDir)
                        // means "let me climb this, slowly" - read input
                        // directly here rather than the movement block's
                        // own curX/curY, which aren't computed until later
                        // this same frame.
                        const cx = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
                        const cy = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
                        const inputMag = Math.sqrt(cx * cx + cy * cy);
                        isClimbingSlope = false;
                        // A ramp past its own RAMP_WALK_BLOCK_ANGLE is meant
                        // to behave like a wall - no climbing it under any
                        // input, only sliding. The horizontal wall-stop only
                        // catches a straight-on approach; without this, once
                        // the character is already standing on such a ramp
                        // (e.g. having crept up via a shallower-angled/side
                        // approach the single forward ray missed), holding
                        // "uphill" let them climb it anyway.
                        const onBlockedRamp = groundHitObject && groundHitObject.userData &&
                            groundHitObject.userData.isSlopeRamp && slopeAngle > RAMP_WALK_BLOCK_ANGLE;
                        let wantsToClimb = false;
                        if (inputMag > 0.1 && !onBlockedRamp) {
                            const inputAng = cameraTheta + Math.atan2(cx, cy);
                            _climbInputDir.set(Math.sin(inputAng), 0, Math.cos(inputAng));
                            // Same shared threshold as the entry refusal
                            // and the wall gate (see CLIMB_INTENT_DOT) -
                            // any real uphill component climbs.
                            wantsToClimb = _climbInputDir.dot(slideDir) < -CLIMB_INTENT_DOT;
                        }

                        // Only relevant coming out of an actual slide - if
                        // they weren't sliding as of last frame (e.g. just
                        // walked up to the ramp from flat ground already
                        // aiming uphill, never slid down it at all), there
                        // is no slide to stop out of, so this whole phase
                        // has to be skipped and normal climbing has to
                        // start immediately instead. wasSliding covers this
                        // (it's true for every frame isStoppingSlide itself
                        // was active too, so a stop-in-progress isn't cut
                        // short by this check).
                        if (wantsToClimb && wasSliding) {
                            // Fresh transition (timer not already counting
                            // down from a previous frame) - kick it off.
                            if (stopSlideTimer <= 0) stopSlideTimer = STOP_SLIDE_DURATION;
                            stopSlideTimer -= delta;
                        } else {
                            stopSlideTimer = 0;
                        }

                        if (wantsToClimb && wasSliding && stopSlideTimer > 0) {
                            // Pushing uphill against a real slide - snapping
                            // straight to the climb state here would stop
                            // them dead in one frame, which doesn't read as
                            // "fighting your own momentum" so much as just
                            // teleporting to a standstill. Keep it a real
                            // (if steeply decelerating) slide for a fixed
                            // stretch instead, with its own StopSliding.fbx
                            // clip (see the isStoppingSlide branch in state
                            // selection) rather than the looping downhill-
                            // slide one - once the timer runs out, the
                            // plain isClimbingSlope branch below takes over
                            // for good.
                            isStoppingSlide = true;
                            isSliding = true;
                            // Hold near-full speed through the animation
                            // crossfade itself (see the 'dur' this same
                            // transition uses in Character.animate) before
                            // any deceleration kicks in. The sliding pose
                            // plants the lead foot forward; the stopping
                            // pose plants it further back - blending
                            // between those two poses while the body barely
                            // moves reads as the foot yanking itself
                            // backward. Keeping the body actually
                            // travelling at full speed through that same
                            // blend window instead means the body catches
                            // up to roughly where the stop pose expects the
                            // foot to be, so it reads as the foot staying
                            // planted while the body slides past it -
                            // actual friction only starts after the pose
                            // has fully blended in.
                            const stopSlideElapsed = STOP_SLIDE_DURATION - stopSlideTimer;
                            if (stopSlideElapsed > STOP_SLIDE_HOLD) {
                                slideSpeed = Math.max(0, slideSpeed - STOP_SLIDE_FRICTION * delta);
                            }
                            char.group.position.addScaledVector(slideDir, slideSpeed * delta);
                            char.group.position.y = floorY;
                        } else if (wantsToClimb) {
                            isClimbingSlope = true;
                            // Let the movement-input block (further down,
                            // its own reduced-but-real climb speed) carry
                            // them up instead of fighting it here too -
                            // isSliding stays false so it also keeps normal
                            // walk-facing/animation instead of the
                            // downhill facing-lock and slide clip. Any
                            // leftover speed from sliding right before they
                            // started climbing still bleeds off via
                            // friction rather than carrying over.
                            isSliding = false;
                            slideSpeed = Math.max(0, slideSpeed - SLIDE_FRICTION * delta);
                        } else if (isSteepSlope) {
                            isSliding = true;
                            // Steeper past the entry angle = faster top
                            // speed, same way a real slope would give more
                            // or less grip - and ramps up/down through
                            // SLIDE_ACCEL rather than snapping straight to
                            // it, so starting to slide (and riding it out
                            // onto flatter ground) both feel like they have
                            // weight instead of an instant on/off switch.
                            const steepnessT = THREE.MathUtils.clamp((slopeAngle - SLIDE_ENTER_ANGLE) / (Math.PI / 2 - SLIDE_ENTER_ANGLE), 0, 1);
                            const steepnessTarget = THREE.MathUtils.lerp(SLIDE_MIN_SPEED, SLIDE_MAX_SPEED, steepnessT);
                            // See SLIDE_MAX_VERTICAL_RATE - re-expresses that
                            // cap as a horizontal along-slope speed for this
                            // specific angle (tan(angle) is how much vertical
                            // drop one unit of this horizontal motion
                            // produces on this slope), and only lets the
                            // steepness-based target above win where it's
                            // already under that.
                            const tanAngle = Math.tan(slopeAngle);
                            const verticalCappedTarget = tanAngle > 0.01 ? SLIDE_MAX_VERTICAL_RATE / tanAngle : steepnessTarget;
                            const targetSlideSpeed = Math.min(steepnessTarget, verticalCappedTarget);
                            slideSpeed = Math.min(slideSpeed + SLIDE_ACCEL * delta, targetSlideSpeed);
                            char.group.position.addScaledVector(slideDir, slideSpeed * delta);
                            // The push above only moves X/Z - on a steep
                            // slope, the true floor height changes fast
                            // relative to that horizontal speed (e.g. ~1.1
                            // units of drop per unit moved at a 48deg
                            // incline), much faster than gravity alone can
                            // accelerate the character downward within a
                            // single frame. Left to the separate vertical
                            // gravity/ground-snap resolution below to
                            // "catch up" on its own, position.y stays stale
                            // (matching the pre-push XZ's height) for a
                            // frame, reads as being above the newly-lower
                            // floor, drops isGrounded back to false, and
                            // the cycle repeats every few frames - a real,
                            // visible fall/sliding flicker. Snapping Y to
                            // this frame's floorY immediately keeps it
                            // glued to the slope every frame instead of
                            // waiting on gravity.
                            char.group.position.y = floorY;
                        }
                    }
                }
            } else { floorY = 0; steepGroundTimer = 0; }
        }
        // Friction: decay any leftover slide speed back to zero once no
        // longer sliding (instead of the old instant stop), and remember
        // this frame's result for next frame's hysteresis check above.
        if (!isSliding) slideSpeed = Math.max(0, slideSpeed - SLIDE_FRICTION * delta);
        wasSliding = isSliding;
        wasClimbingSlope = isClimbingSlope;

        const capsuleRadius = 0.4;
        const pushOutVector = _pushOutVectorScratch.set(0, 0, 0);
        let hasPenetration = false;

        const processHit = (hits) => {
            if (hits.length > 0 && hits[0].distance < capsuleRadius) {
                const overlap = capsuleRadius - hits[0].distance;
                const normal = _penetrationNormalScratch.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld).setY(0).normalize();
                if (normal.lengthSq() > 0) {
                    pushOutVector.add(normal.multiplyScalar(overlap));
                    hasPenetration = true;
                }
            }
        };
        for (let dir of _penetrationRayDirs) {
            let testOrigin1 = _tempVec1.copy(char.group.position);
            testOrigin1.y += 0.5;
            rayFwd.set(testOrigin1, dir);
            processHit(rayFwd.intersectObjects(solidCollidables));

            let testOrigin2 = _tempVec2.copy(char.group.position);
            testOrigin2.y += 1.5;
            rayFwd.set(testOrigin2, dir);
            processHit(rayFwd.intersectObjects(solidCollidables));
        }
        
        // On a steep slope, the character is deliberately standing/leaning
        // against what is, from these 8 horizontal rays' point of view, a
        // near-vertical surface right behind them - reads as "penetrating
        // a wall" to this generic anti-clipping system, which isn't aware
        // a slope's own surface is supposed to be that close. Without this
        // exclusion it forcefully shoves the character off the slope every
        // single frame on top of (and far exceeding) the controlled
        // slide/climb speed above - the real cause behind slides feeling
        // wildly faster than intended specifically on the steepest ramps.
        if (hasPenetration && !char.isRagdoll && !isLedgeGrabbing && !isClimbingUp && !isSliding && !isClimbingSlope) {
            pushOutVector.y = 0; char.group.position.add(pushOutVector.multiplyScalar(0.5));
        }

        dirLight.position.set(lightTrack.x, lightTrack.y + 40, lightTrack.z);
        dirLight.target.position.copy(lightTrack);

        const rawX = Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0));
        const rawY = Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0));
        const rawMag = Math.min(Math.sqrt(rawX*rawX + rawY*rawY), 1.0);
        // Keyboard input is inherently binary (a key is either down or not -
        // W alone gives exactly moveMag 1.0, always landing in the 'run'
        // clip), but the touch joystick is analog and can land anywhere in
        // between. That continuum is what produced the awkward slow "in-
        // between" actual speeds on ramps that needed a growing stack of
        // dedicated short-stride walk clips just to not look like the feet
        // were sliding - simpler to just not let those speeds exist in the
        // first place. Quantizing the joystick's OWN magnitude down to the
        // same two effective tiers keyboard already only ever produces
        // (a fixed walk-pace deflection, or full run) means Walking.fbx's
        // ordinary stride is always being asked to move at a pace it's
        // actually tuned for - direction is preserved exactly, only the
        // magnitude is snapped.
        const JOYSTICK_DEADZONE = 0.15, JOYSTICK_RUN_THRESHOLD = 0.7, JOYSTICK_WALK_MAG = 0.6;
        let moveMag = 0, curX = 0, curY = 0;
        if (rawMag > JOYSTICK_DEADZONE) {
            moveMag = rawMag >= JOYSTICK_RUN_THRESHOLD ? 1.0 : JOYSTICK_WALK_MAG;
            curX = (rawX / rawMag) * moveMag;
            curY = (rawY / rawMag) * moveMag;
        }

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

            // Captured before the substep physics below can touch it - the
            // generic obstacle-bounce collision response a few lines down
            // (velocity *= -0.25 on any solid collidable, including the
            // sandbag's own hitbox) already cuts a thrown object's speed by
            // 75% the instant it makes contact, same frame the hit check
            // further below would otherwise run. Gating that check on the
            // POST-bounce velocity meant a throw that actually connected
            // almost always read as "already below the speed threshold" by
            // the time it was checked - it never got credit for having just
            // hit something. Using the incoming (pre-bounce) velocity/speed
            // for both the gate and the impact direction fixes that, and
            // also better matches the object's real point-of-impact motion
            // rather than its post-bounce rebound.
            const incomingWasThrown = c.wasThrown;
            const incomingVelocity = incomingWasThrown ? c.velocity.clone() : null;
            const incomingSpeedSq = incomingVelocity ? incomingVelocity.lengthSq() : 0;

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
                    // Locks excluded too - otherwise a thrown key bounces
                    // off the lock's own solid hitbox before ever getting
                    // within KEY_INSERT_DISTANCE of its origin (a lock
                    // model is wider than that), so it could never actually
                    // reach the lock to trigger insertion by throwing.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || activeLockInstances.includes(obj)) return;
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
                    // Locks excluded too - otherwise a thrown key bounces
                    // off the lock's own solid hitbox before ever getting
                    // within KEY_INSERT_DISTANCE of its origin (a lock
                    // model is wider than that), so it could never actually
                    // reach the lock to trigger insertion by throwing.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || activeLockInstances.includes(obj)) return;
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
                    // Locks excluded too - otherwise a thrown key bounces
                    // off the lock's own solid hitbox before ever getting
                    // within KEY_INSERT_DISTANCE of its origin (a lock
                    // model is wider than that), so it could never actually
                    // reach the lock to trigger insertion by throwing.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || activeLockInstances.includes(obj)) return;
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

            // A thrown key can also settle into the lock, same as walking
            // up to it while still carrying already does (see the
            // isCarryingObj branch elsewhere in this file) - checked every
            // frame the key isn't being held, not gated on it still being
            // "fast" like the hit-detection below, so it also catches one
            // that's already rolled to a stop near the lock, not just one
            // still mid-flight.
            if (c.mesh.userData.isKey) {
                for (const lockGroup of activeLockInstances) {
                    if (lockGroup.userData.keyInserted) continue;
                    if (c.mesh.position.distanceTo(lockGroup.position) <= KEY_INSERT_DISTANCE) {
                        triggerKeyInsertion(c.mesh, lockGroup);
                        break;
                    }
                }
            }

            // Thrown objects land like a punch, on sandbags and on other
            // players - mirrors the charge-attack projectile's own hit
            // check further up (same checkHit/applyHit + getHitReferencePoint/
            // sendPunchEvent calls), just gated on c.wasThrown/velocity
            // instead of a projectile's lifespan. Physics for carryables runs
            // identically on every client (see _applyThrowEvent's own
            // comment - deterministic, seeded once from the throw event),
            // so this check runs locally on every client the same way the
            // charge projectile's does, including the thrower's own.
            if (incomingWasThrown) {
                // Below this it's rolled/settled to a stop, not flying -
                // shouldn't keep landing hits just from resting nearby.
                if (incomingSpeedSq > 1.0) {
                    const hitRadius = window.throwHitRadius !== undefined ? window.throwHitRadius : 0.8;
                    const hitForce = window.throwHitForce !== undefined ? window.throwHitForce : 35;
                    const impactDir = _tempVec3.copy(incomingVelocity).normalize();
                    let consumed = false;

                    if (window.sacks) {
                        for (const sack of window.sacks) {
                            if (sack.checkHit(c.mesh.position, hitRadius)) {
                                sack.applyHit(impactDir, hitForce);
                                if (window.createHandHitEffect) window.createHandHitEffect(c.mesh.position);
                                if (window.spawnHitEffect) window.spawnHitEffect(c.mesh.position.clone());
                                if (network) {
                                    const sackIdx = window.sacks.indexOf(sack);
                                    if (sackIdx !== -1) network.sendSandbagHitEvent(sackIdx, impactDir, hitForce);
                                }
                                consumed = true;
                                break;
                            }
                        }
                    }

                    if (!consumed && window.multiplayerClient) {
                        window.multiplayerClient.remotes.forEach((avatar, remoteId) => {
                            if (remoteId === c.throwOwnerId) return;
                            if (consumed || !avatar.isLoaded || avatar.isRagdoll) return;
                            const avatarHitPos = avatar.getHitReferencePoint();
                            if (avatarHitPos.distanceTo(c.mesh.position) < hitRadius + 1.0) {
                                if (window.createHandHitEffect) window.createHandHitEffect(c.mesh.position);
                                if (window.spawnHitEffect) window.spawnHitEffect(c.mesh.position.clone());
                                window.multiplayerClient.sendPunchEvent(remoteId, impactDir, hitForce, c.mesh.position);
                                consumed = true;
                            }
                        });
                    }

                    // AI bot is local-only (no socket/id) - same reaction
                    // detectMeleeHits already applies for a regular/charge
                    // punch landing on it (ClimbGame.html), applied directly
                    // instead of through sendPunchEvent since there's no
                    // remote to send it to.
                    if (!consumed && window.aiBot && window.aiBot.isLoaded && !window.aiBot.isRagdoll) {
                        const botHitPos = window.aiBot.getHitReferencePoint();
                        if (botHitPos.distanceTo(c.mesh.position) < hitRadius + 1.0) {
                            if (window.createHandHitEffect) window.createHandHitEffect(c.mesh.position);
                            if (window.spawnHitEffect) window.spawnHitEffect(c.mesh.position.clone());
                            const intensity = hitForce >= 70 ? 'high' : (hitForce >= 45 ? 'medium_high' : 'medium');
                            const flashStrengthByIntensity = { medium: 0.9, medium_high: 1.4, high: 2.5 };
                            const strength = flashStrengthByIntensity[intensity] || 1.0;
                            const knockback = window.chargePunchKnockback !== undefined ? window.chargePunchKnockback : 15;
                            const magnitudeForRagdoll = intensity === 'high' ? knockback : hitForce;
                            const botVelocity = impactDir.clone().multiplyScalar(magnitudeForRagdoll);
                            window.aiBot.triggerHitFlash(strength);
                            if (intensity === 'high') window.aiBot.initRagdoll(botVelocity, intensity);
                            else window.aiBot.applyProceduralRecoil(botVelocity, intensity);
                            consumed = true;
                        }
                    }

                    // A thrown jar shatters on any of these hits too, same
                    // as it already does hitting a wall in the collision
                    // loop above (speed > 5.0 there) - this check only ever
                    // runs while incomingSpeedSq > 1.0, well above walking
                    // speed, so no extra speed gate needed here. destroyJarCarryable
                    // removes it from `carryables` (this same array being
                    // iterated) same as the wall-collision path already does
                    // from inside this same forEach - accepted existing
                    // behavior, not something new introduced here.
                    if (consumed && c.mesh.userData.isJar) {
                        shatterJar(c.mesh.position.clone(), incomingVelocity.clone());
                        destroyJarCarryable(c.mesh);
                    }

                    // One hit per throw, same as a punch's own punchesHitFlags -
                    // a thrown box resting against a target shouldn't keep
                    // dealing damage every frame it's still touching them.
                    if (consumed) c.wasThrown = false;
                } else {
                    c.wasThrown = false;
                }
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
            // The normal-movement branch (the trailing `else` below) is the
            // only place that calls setSlopeTilt each frame - this branch
            // never did, so whatever motorcycle-style turn-lean the body had
            // at the exact instant it grabbed on stayed baked into
            // fbxModel.quaternion for the entire hang, never relaxing back
            // to level. Forcing turnLeanAngle to 0 and normal/slideDir to
            // the identity-target case here every frame actively slerps it
            // back level while hanging, same rate (10*delta) as the normal
            // branch already uses elsewhere.
            char.setSlopeTilt(_upVec, delta, null, 0, char.hitTwistAngle);
            char.animate(delta, 'ledge', currentPushS !== 0 ? moveMag : 0, time, 0, currentPushS);
            networkStateName = 'hang_idle';
        } else {
            if (isLedgeGrabbing) stamina -= HANG_DRAIN*delta;
            else if (isClimbingSlope) {
                // Steeper climb drains faster - same climbT ramp that
                // already scales movement speed and the runup clip's rate.
                const drainT = THREE.MathUtils.clamp((groundNormal.angleTo(_upVec) - SLIDE_ENTER_ANGLE) / (RAMP_WALK_BLOCK_ANGLE - SLIDE_ENTER_ANGLE), 0, 1);
                stamina -= THREE.MathUtils.lerp(RAMP_CLIMB_DRAIN, RAMP_CLIMB_DRAIN_MAX, drainT)*delta;
            }
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

                if (heldCarryable.userData.isKey) {
                    for (const lockGroup of activeLockInstances) {
                        if (lockGroup.userData.keyInserted) continue;
                        if (heldCarryable.position.distanceTo(lockGroup.position) <= KEY_INSERT_DISTANCE) {
                            triggerKeyInsertion(heldCarryable, lockGroup);
                            break;
                        }
                    }
                }
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
            } else if (moveMag > 0.1 || hitRecoveryStepActive) {
                // A real hit (see applyProceduralRecoil) forces a short,
                // fixed step in the direction it shoved the character,
                // overriding whatever the player is actually pressing (or
                // pressing nothing at all) for its short duration - reads
                // as catching your balance by stepping into the hit rather
                // than the spine's own recoil lean just springing back
                // upright while the character stays planted in place. Runs
                // through the exact same wall-check/collision/facing-turn
                // code as normal movement below, just with mAng/mDir/speed
                // substituted, so it can't clip through anything a normal
                // step couldn't. Only true once hitRecoveryStepActive is
                // (i.e. past the initial bend-only delay - see its own
                // comment) - during the delay itself, moveMag alone decides
                // whether this branch runs at all.
                const isHitRecovering = hitRecoveryStepActive;
                let mAng, mDir;
                if (isHitRecovering) {
                    mDir = _tempVec1.copy(char.hitRecoveryDir);
                    mAng = Math.atan2(mDir.x, mDir.z);
                    // Which way the character actually staggers visually
                    // (see the facing-turn skip below, and Character.animate's
                    // 'strafe_left'/'strafe_right'/'walk_backward' handling) -
                    // classified against the character's CURRENT facing
                    // (unrotated this frame, since facing is intentionally
                    // left alone during recovery) rather than always turning
                    // to face travel direction like normal movement does.
                    // Without this, a hit from the front pushes the
                    // character straight back, and facing the push direction
                    // like normal movement would spin them a full 180 to
                    // face away from whoever just hit them, regardless of
                    // which side the hit actually came from.
                    _hitRecoveryInvQuat.copy(char.group.quaternion).invert();
                    _hitRecoveryLocalDir.copy(char.hitRecoveryDir).applyQuaternion(_hitRecoveryInvQuat);
                    if (Math.abs(_hitRecoveryLocalDir.x) > Math.abs(_hitRecoveryLocalDir.z)) {
                        char.hitRecoveryAnimState = _hitRecoveryLocalDir.x > 0 ? 'strafe_right' : 'strafe_left';
                    } else {
                        char.hitRecoveryAnimState = _hitRecoveryLocalDir.z > 0 ? 'walk' : 'walk_backward';
                    }
                } else {
                    mAng = cameraTheta + Math.atan2(curX, curY);
                    mDir = _tempVec1.set(Math.sin(mAng), 0, Math.cos(mAng));
                    // See lastMoveIntentAng's own comment (ledge-grab ray).
                    if (moveMag > 0.1) { lastMoveIntentAng = mAng; hasMoveIntent = true; }
                }

                rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.3), mDir);

                let speedMult = 1.0;
                if (isGrounded) airControlMult = 1.0;
                if (isHitRecovering) { /* actualSpeed set directly below instead */ }
                else if (isSliding) speedMult = 0.1;
                else if (isClimbingSlope) {
                    // The original deliberate slow crawl, restored (a
                    // softer 0.6-0.35 range was tried in between and
                    // rejected - the whole point of this branch is that
                    // climbing a slope you'd otherwise slide down reads as
                    // real effort, and steeper/closer to
                    // RAMP_WALK_BLOCK_ANGLE is a real slog).
                    const climbT = THREE.MathUtils.clamp((groundNormal.angleTo(_upVec) - SLIDE_ENTER_ANGLE) / (RAMP_WALK_BLOCK_ANGLE - SLIDE_ENTER_ANGLE), 0, 1);
                    speedMult = THREE.MathUtils.lerp(0.3, 0.1, climbT);
                    // Same climbT drives the 'runup' clip's own playback
                    // rate (read in ClimbGame.html's animate()) - the
                    // dedicated climbing clip is back for slidable ramps
                    // (a walk/run cycle was tried there and rejected), and
                    // without this its fixed pace ignores how the ramp's
                    // steepness already scales real ground speed.
                    window.runupAnimSpeed = THREE.MathUtils.lerp(1.6, 0.7, climbT);
                } else if (isGrounded) {
                    // Below the slide threshold entirely (not slidable) -
                    // real reduction again too, same reasoning as above:
                    // safe now that the run/walk animation choice no
                    // longer reads this same (reduced) value.
                    const walkT = THREE.MathUtils.clamp(groundNormal.angleTo(_upVec) / SLIDE_ENTER_ANGLE, 0, 1);
                    speedMult = THREE.MathUtils.lerp(1.0, 0.6, walkT);
                } else {
                    // Airborne - normally full control, reduced for the
                    // duration of a mid-climb hop (see airControlMult).
                    speedMult = airControlMult;
                }
                if (!isHitRecovering && landingTimer > 0 && initialLandingTimer > 0) speedMult = 1.0 - (0.85 * Math.sin(Math.pow(1.0 - (landingTimer / initialLandingTimer), 0.6) * Math.PI));
                // Slows down on decorative bump terrain (see
                // buildKneeBumpField/bumpSpeedBlend, updated once per frame
                // near wasGrounded) - real uneven ground is harder to move
                // fast over, and it reads as a genuine "this terrain is
                // rough" cue rather than just a visual leg-IK correction
                // with no gameplay weight to it. bumpSpeedBlend is already
                // eased (not a hard per-frame toggle), so this multiply
                // itself doesn't introduce any new jitter.
                if (!isHitRecovering) speedMult *= THREE.MathUtils.lerp(1.0, window.bumpTerrainSpeedMult, bumpSpeedBlend);

                let finalMoveDir = mDir.clone();
                // Eases out as the timer counts down instead of holding
                // full speed then stopping dead, so the step itself reads
                // as a decelerating stumble-catch rather than a rigid slide.
                // Scaled by hitRecoveryStrength (the hit's own
                // impulseMagnitude - see applyProceduralRecoil) so a harder
                // hit covers noticeably more ground than one right at the
                // recovery threshold, instead of every recovery step
                // travelling the same fixed distance regardless of how hard
                // it landed. 12.0 (medium's own flat impulse) is the
                // baseline - a plain medium hit's distance is unchanged from
                // before this scaling was added.
                const recoveryStrengthMult = THREE.MathUtils.clamp(char.hitRecoveryStrength / 12.0, 0.5, window.recoveryStrengthMultMax);
                let actualSpeed = isHitRecovering
                    ? window.recoveryStepSpeed * recoveryStrengthMult * Math.min(1, char.hitRecoveryTimer / window.hitRecoveryDuration)
                    : (window.isCarryingObj ? 4.0 : 8) * speedMult * moveMag;

                const actualHits = rayFwd.intersectObjects(solidCollidables);
                if (actualHits.length > 0 && actualHits[0].distance < 0.5) {
                    // Classify using the real (un-flattened) hit normal
                    // before deciding this is even a "wall" at all - a
                    // steep-but-still-floor-like slope (like the
                    // hemisphere's sides) has real angleTo(_upVec) well
                    // under vertical, and should be left entirely to the
                    // vertical ground-follow/sliding block instead of
                    // getting hard-stopped here. Only surfaces past
                    // SLOPE_WALL_CUTOFF - genuinely near-vertical - go
                    // through the existing horizontal wall-stop. Test ramps
                    // (userData.isSlopeRamp) use their own, lower
                    // RAMP_WALK_BLOCK_ANGLE instead - see its own comment.
                    const realNormal = actualHits[0].face.normal.clone().transformDirection(actualHits[0].object.matrixWorld);
                    const realSurfaceAngle = realNormal.angleTo(_upVec);
                    const wallCutoffForHit = actualHits[0].object.userData?.isSlopeRamp ? RAMP_WALK_BLOCK_ANGLE : SLOPE_WALL_CUTOFF;
                    let treatAsWall = realSurfaceAngle > wallCutoffForHit;
                    // Slidable-but-climbable faces (past the slide-entry
                    // angle but under the hard cutoff above) are a wall
                    // only for movement with NO uphill component (walking
                    // past/alongside the ramp) - any real uphill intent
                    // (shared CLIMB_INTENT_DOT threshold, same one the
                    // climb trigger and the base-seam entry refusal use)
                    // walks on and climbs. ENTRY-ONLY: once the character
                    // is already climbing (or sliding, or mid-air from a
                    // hop), this stays out of the way - an earlier version
                    // used a stricter threshold here than the climb
                    // trigger, and the mismatch zone stalled/flung
                    // climbers whose stick drifted mid-climb.
                    if (!treatAsWall && realSurfaceAngle > SLIDE_ENTER_ANGLE
                        && isGrounded && !isClimbingSlope && !isSliding) {
                        _tempVec3.copy(realNormal).setY(0).normalize();
                        treatAsWall = -finalMoveDir.dot(_tempVec3) < CLIMB_INTENT_DOT;
                    }
                    if (treatAsWall) {
                        const wallNormal = realNormal.clone().setY(0).normalize();
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
                }

                // Ground-path companion to the wall gate above: on frames
                // where ground detection refused entry onto a slidable
                // face (steepEntryBlocked - near-parallel approach the
                // forward ray can't see), strip the into-face component of
                // the move too, or the character keeps grinding into the
                // face it was just refused from and jitters against it.
                if (steepEntryBlocked && !isHitRecovering) {
                    const entryDot = finalMoveDir.dot(_steepEntryNormal);
                    if (entryDot < 0) {
                        finalMoveDir.sub(_tempVec3.copy(_steepEntryNormal).multiplyScalar(entryDot));
                        if (finalMoveDir.lengthSq() > 0.001) finalMoveDir.normalize(); else finalMoveDir.set(0, 0, 0);
                        actualSpeed *= Math.sqrt(Math.max(0, 1.0 - entryDot * entryDot));
                    }
                }

                actualSpeed = resolveRemotePlayerCollision(char.group.position, finalMoveDir, actualSpeed);

                if (!isBuilding && actualSpeed > 0.05) char.group.position.add(finalMoveDir.multiplyScalar(actualSpeed * delta));
                effectiveMoveMag = isBuilding ? 0 : actualSpeed / (window.isCarryingObj ? 4.0 : 8.0);
                window._dbgActualSpeed = actualSpeed;
                if (isHitRecovering) {
                    // Same idea as runupAnimSpeed above: the step's own
                    // ground speed already starts fast (scaled by hit
                    // strength) and eases toward a stop as the timer runs
                    // out (see actualSpeed's own comment) - without this,
                    // the feet cycle at a fixed rate regardless, reading as
                    // sliding/skating on a hard hit instead of actually
                    // stepping harder. window.recoveryStepSpeed is the 1.0
                    // ("normal pace") reference, so a plain medium hit's
                    // very first frame plays at roughly its usual rate; a
                    // stronger hit starts noticeably faster and settles back
                    // down as the stumble itself decelerates. Floor kept
                    // well above 0 so the feet don't visibly freeze right at
                    // the tail end, before the state hands off to idle.
                    window.hitRecoveryAnimSpeed = THREE.MathUtils.clamp(actualSpeed / window.recoveryStepSpeed, window.hitRecoveryAnimSpeedMin, window.hitRecoveryAnimSpeedMax);
                }
                // Skipped while sliding - the slide-facing turn (see the
                // isSliding branch below, later this same frame) is meant
                // to be the sole thing driving facing in that case. Both
                // used to run unconditionally every frame regardless of
                // each other, so trying to walk uphill against a slide had
                // this one turning to face the input direction and the
                // other immediately turning back to face downhill right
                // after it, every single frame - a visible, constant
                // tug-of-war on the character's rotation. Also skipped
                // during hit recovery - the whole point of classifying
                // hitRecoveryAnimState above is to stagger sideways/
                // backwards/forwards in whichever direction the hit
                // actually pushed, WITHOUT turning to face travel
                // direction the way normal movement does.
                if (!isSliding && !isHitRecovering) char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, mAng), window.CHAR_TURN_RATE*delta);
            }

            // Walking downhill (stairs, a shallow ramp, the hemisphere,
            // anything sloped but not steep enough to slide): floorY was
            // computed earlier this frame from the position BEFORE this
            // frame's own movement just above, so it reflects where the
            // ground was, not where it now is at the character's new,
            // further-downhill spot. The gravity/ground-snap resolution
            // further below only starts correcting once that gap crosses
            // its own "am I falling" threshold, then closes it in one
            // frame - since the gap regenerates every single frame while
            // continuously walking downhill, this repeats every frame and
            // reads as a stutter-step hop instead of smoothly following
            // the slope down. A single fresh ray from the character's
            // actual new position catches up immediately instead of
            // waiting on gravity - the same fix isSliding already applies
            // to itself, just for ordinary grounded walking too. Downhill
            // only (never snaps up) so it can't interfere with the
            // separate isSteppingUp/isStandPositionClear logic that
            // already handles stepping up onto something higher.
            if (isGrounded && !isSliding && !isClimbingSlope && !isLedgeGrabbing && !isClimbingUp && yVelocity <= 0) {
                const downhillOrigin = _tempVec3.copy(char.group.position); downhillOrigin.y += 1.2;
                rayDown.set(downhillOrigin, _downVec);
                const downhillHits = rayDown.intersectObjects(groundScanCollidables);
                if (downhillHits.length > 0 && downhillHits[0].point.y < char.group.position.y && downhillHits[0].point.y > char.group.position.y - 1.5) {
                    char.group.position.y = downhillHits[0].point.y;
                }
            }

            // Debug: the two rays the ledge-grab check below actually casts
            // (yellow = forward wall probe from chest height, magenta =
            // downward ledge-top probe from just above/past the wall hit) -
            // added while chasing reports that grabbing feels highly
            // timing/aim-sensitive in real play despite working in scripted
            // tests. Lazily created once; hidden by default each frame and
            // only shown/updated on frames the check below actually runs
            // (and further, the down ray only once the wall probe itself
            // passed), so a stale ray from a previous attempt never lingers
            // on screen.
            if (!window._ledgeRayFwdLine) {
                const mkLine = (color) => {
                    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
                    line.raycast = () => {};
                    line.renderOrder = 999;
                    line.visible = false;
                    scene.add(line);
                    return line;
                };
                window._ledgeRayFwdLine = mkLine(0xffff00);
                window._ledgeRayDownLine = mkLine(0xff00ff);
            }
            window._ledgeRayFwdLine.visible = false;
            window._ledgeRayDownLine.visible = false;
            const showLedgeRays = document.getElementById('toggle-ledge-rays').checked;

            if (!isGrounded && yVelocity < 2 && ledgeGrabCooldown <= 0 && !window.isCarryingObj && !window.isCarryStarting) {
                // Aimed at actual movement INTENT, not the character's own
                // facing - group.quaternion visually lags behind input
                // while turning (curved running/strafing), so a jump timed
                // mid-turn could point this ray somewhere other than where
                // the player is actually running, catching an unintended
                // side/corner surface instead of the one being run toward
                // head-on - reported as grabbing a ledge "sideways" after
                // running while turning. Three-tier fallback, in order:
                // (1) THIS frame's own input, if any (curX/curY+cameraTheta,
                // same convention as mAng above); (2) failing that,
                // lastMoveIntentAng - a jump is very often pressed on the
                // exact frame the player lets go of the stick to press it,
                // so requiring live input here reverted to the same stale-
                // facing bug just as often as it fixed it; (3) only with no
                // recent movement at all (a standing jump) does this fall
                // back to plain body facing, same as originally.
                const jInputMag = Math.sqrt(curX * curX + curY * curY);
                let fwd;
                if (jInputMag > 0.1) {
                    const jAng = cameraTheta + Math.atan2(curX, curY);
                    fwd = _tempVec1.set(Math.sin(jAng), 0, Math.cos(jAng));
                } else if (hasMoveIntent) {
                    fwd = _tempVec1.set(Math.sin(lastMoveIntentAng), 0, Math.cos(lastMoveIntentAng));
                } else {
                    fwd = _tempVec1.set(0, 0, 1).applyQuaternion(char.group.quaternion);
                }
                const chest = _tempVec2.copy(char.group.position).setY(char.group.position.y+1.1);
                rayFwd.set(chest, fwd); const wH = rayFwd.intersectObjects(solidCollidables);
                if (showLedgeRays) {
                    const fwdEnd = wH.length > 0 ? wH[0].point.clone() : chest.clone().addScaledVector(fwd, 2.0);
                    window._ledgeRayFwdLine.geometry.setFromPoints([chest.clone(), fwdEnd]);
                    window._ledgeRayFwdLine.visible = true;
                }
                // Same steep-slope-vs-genuine-wall classification as the
                // horizontal movement wall-stop (see SLOPE_WALL_CUTOFF) -
                // without it, a steep ramp (still a walkable/slideable
                // slope, not a distinct ledge) reads as a climbable wall
                // with a "ledge" above it (since the ray upward from any
                // point on a continuous ramp always finds more ramp), so
                // the player grabs on and hangs instead of sliding/
                // climbing normally. Test ramps are excluded outright
                // (isSlopeRamp), regardless of which face got hit or its
                // angle - their own SIDE faces are always perfectly
                // vertical (unaffected by the ramp's own rotation, which
                // only tilts around that same axis), so without this a
                // player could walk up to a ramp's side, grab that edge
                // like a real ledge, and climb/shimmy up it - bypassing
                // the slide mechanic entirely from the side even on ramps
                // whose actual sloped face is well within normal
                // slide/walk range.
                const realWallNormal = wH.length > 0 ? wH[0].face.normal.clone().transformDirection(wH[0].object.matrixWorld) : null;
                const isRampHit = wH.length > 0 && wH[0].object.userData?.isSlopeRamp;
                if (wH.length > 0 && wH[0].distance < 0.8 && !isRampHit && realWallNormal.angleTo(_upVec) > SLOPE_WALL_CUTOFF) {
                    const n = realWallNormal.setY(0).normalize();
                    const top = wH[0].point.clone().add(fwd.clone().multiplyScalar(0.2)).setY(wH[0].point.y+3.0);
                    rayDown.set(top, _downVec); const lH = rayDown.intersectObjects(solidCollidables);
                    if (showLedgeRays) {
                        const downEnd = lH.length > 0 ? lH[0].point.clone() : top.clone().addScaledVector(_downVec, 4.0);
                        window._ledgeRayDownLine.geometry.setFromPoints([top.clone(), downEnd]);
                        window._ledgeRayDownLine.visible = true;
                    }
                    // Ceiling on how high a ledge can be and still get
                    // grabbed - was a flat char.group.position.y+3.5, which
                    // actually gets MORE generous the higher/later into the
                    // jump this runs, since current Y keeps climbing while
                    // the +3.5 budget never shrinks to compensate. A wall
                    // taller than any real jump could reach (confirmed with
                    // a purpose-built test rig - a block above the jump's
                    // own measured apex height still grabbed, reading as
                    // teleporting onto it) could still pass this check well
                    // into the arc. Physically consistent version instead:
                    // v^2/(2g) is exactly how much MORE the character can
                    // still rise from its current yVelocity - takeoff_Y +
                    // remainingRise stays constant across the whole arc
                    // (remainingRise shrinks by precisely as much as
                    // current Y has already risen), so this doesn't grow
                    // over time the way the flat version did. +1.85 is the
                    // same hand-above-group offset hangGroupY already uses
                    // below, for internal consistency (whatever height
                    // this accepts, hangGroupY correctly reflects it).
                    const remainingRise = yVelocity > 0 ? (yVelocity * yVelocity) / 60 : 0;
                    const maxLedgeY = char.group.position.y + remainingRise + 1.85;
                    if (lH.length > 0 && lH[0].point.y > char.group.position.y && lH[0].point.y < maxLedgeY) {
                        const hangX = wH[0].point.x + n.x*ledgeOffset;
                        const hangZ = wH[0].point.z + n.z*ledgeOffset;
                        const hangGroupY = lH[0].point.y - 1.85;

                        if (isHangPositionClear(hangX, hangGroupY, hangZ, wH[0].object)) {
                            isLedgeGrabbing = true; ledgeMoveLocked = true;
                            if (yVelocity < -22) { isSlipping = true; slipTimer = 0; } else isSlipping = false;
                            yVelocity = 0; ledgeTarget.copy(lH[0].point);
                            char.group.position.y = hangGroupY; char.group.position.x = hangX; char.group.position.z = hangZ;
                            char.group.lookAt(_tempVec3.copy(char.group.position).sub(n)); jumpMomentum.set(0,0,0);
                            // The lookAt above snaps facing straight at the wall in a
                            // single frame - without this, updateTurnLean (game_js.js,
                            // runs every frame off char.group's own yaw delta) reads
                            // that snap as an enormous instantaneous turn rate and banks
                            // the body into it, so the character can appear tilted right
                            // as it grabs on. Zeroing turnLeanAngle removes any lean
                            // already in flight, and priming _lastGroupYaw to the
                            // POST-snap yaw means next frame's yawDelta is 0 instead of
                            // the whole snap angle, so the bank never gets recreated.
                            char.turnLeanAngle = 0;
                            char._lastGroupYaw = 2 * Math.atan2(char.group.quaternion.y, char.group.quaternion.w);
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
            // Only decay while grounded (landing naturally kills leftover
            // momentum, and it's also explicitly zeroed on various landing
            // transitions below) - decaying it unconditionally at this
            // fairly fast fixed rate meant a slide-jump's horizontal push
            // (see handleJump) died out well before a real jump arc with
            // that much vertical velocity finishes, so the character moved
            // forward briefly right after jumping and then just fell
            // straight down for the rest of the flight instead of
            // following a proper forward arc the whole way. No air
            // resistance is modeled anywhere else, so constant horizontal
            // momentum for the whole time airborne is the physically
            // consistent behavior, not a decaying one.
            if (jumpMomentum.lengthSq() > 0.01) {
                char.group.position.add(_tempVec1.copy(jumpMomentum).multiplyScalar(delta));
                if (isGrounded) jumpMomentum.lerp(_tempVec2.set(0,0,0), 4*delta);
            }
            
            // Blend floorY with each foot's OWN ground contact point (found
            // the same way applyLegIK's own targets are below, just
            // computed here too) BEFORE the grounded/falling decision right
            // below uses it - the single center-preferred ray floorY comes
            // from can land in a gap between scattered small obstacles (see
            // buildKneeBumpField) even while a foot is squarely on one,
            // leaving the root too low for that leg to reach without
            // stretching or clipping through. Doing this here, folded into
            // floorY itself, keeps floorY the one source of truth isGrounded
            // relies on - an earlier attempt nudged char.group.position.y
            // up AFTER isGrounded was already decided instead, which left
            // the root sitting above whatever floorY the very next frame's
            // fresh single-ray read happened to find, misreading as
            // "falling" out of nowhere the instant that ray missed the bump.
            // Computed once here and reused by the legIK-apply block further
            // below (same foot bones, same frame) instead of calling
            // computeFootIKTarget a second time for each foot - it used to
            // recompute an identical raycast twice per foot per frame
            // (4 raycasts total against the full ~300+-object collidables
            // array where 2 give the same result), pure waste. The targets
            // are one animation-tick staler by the time legIK reads them
            // (this runs before char.animate() updates the skeleton for
            // the frame, the old second call ran after) - imperceptible at
            // 60fps for how far a foot actually moves in one tick.
            // Only ever counts isDecorativeBump contacts - this whole
            // root-rise/speed-reduction system is scoped exclusively to the
            // buildKneeBumpField test areas now, never touching ordinary
            // ramps/slopes/stairs at all. It used to count ANY raised
            // ground a foot found (not just bumps), which was meant to be
            // a no-op on a genuine ramp (its own foot target and floorY
            // should already roughly agree) but in practice kept
            // interacting with ramp-specific behavior in ways that were
            // hard to fully predict and broke ramp foot-planting more than
            // once this session - full separation is safer and easier to
            // reason about than trying to make one shared system correct
            // for both a continuous authored slope and scattered test
            // clutter at the same time.
            let footBoostTarget = 0;
            let bumpBoostTarget = 0;
            leftFootHit = null; rightFootHit = null;
            if (char.lFootBone && char.rFootBone && !isLedgeGrabbing && !isClimbingUp) {
                leftFootHit = computeFootIKTarget(char.lFootBone, _leftFootIKTarget, solidCollidables);
                rightFootHit = computeFootIKTarget(char.rFootBone, _rightFootIKTarget, solidCollidables);
                if (leftFootHit && leftFootHit.userData && leftFootHit.userData.isDecorativeBump) {
                    bumpBoostTarget = Math.max(bumpBoostTarget, _leftFootIKTarget.y - floorY);
                }
                if (rightFootHit && rightFootHit.userData && rightFootHit.userData.isDecorativeBump) {
                    bumpBoostTarget = Math.max(bumpBoostTarget, _rightFootIKTarget.y - floorY);
                }
            }
            // Debug: small markers at each foot's own computed IK target
            // (where computeFootIKTarget's raycast actually landed, before
            // solveLegIK tries to reach it) - lets a target-placement bug be
            // told apart from a leg-reach/animation-timing one by literally
            // seeing where the system thinks each foot should plant, right
            // next to (or not) where the rendered foot ends up. Lazily
            // created once, matching the '_yawLabelSprite' pattern already
            // used for this session's other debug overlays.
            if (!window._footIKGoalL) {
                const goalGeo = new THREE.SphereGeometry(0.06, 8, 8);
                window._footIKGoalL = new THREE.Mesh(goalGeo, new THREE.MeshBasicMaterial({ color: 0x00ff66, depthTest: false }));
                window._footIKGoalR = new THREE.Mesh(goalGeo, new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false }));
                window._footIKGoalL.raycast = () => {};
                window._footIKGoalR.raycast = () => {};
                window._footIKGoalL.renderOrder = 999;
                window._footIKGoalR.renderOrder = 999;
                scene.add(window._footIKGoalL, window._footIKGoalR);
            }
            // Debug: small cube markers at each knee bone's actual current
            // world position (post-IK, post-mixer - wherever the rendered
            // skeleton really has them right now), same toggle as the foot
            // goals above - lets a knee that's bending oddly (collapsing
            // forward, not tracking the slope) be seen directly instead of
            // inferred from the feet alone.
            if (!window._kneeMarkerL) {
                const kneeGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
                window._kneeMarkerL = new THREE.Mesh(kneeGeo, new THREE.MeshBasicMaterial({ color: 0x00ff66, depthTest: false }));
                window._kneeMarkerR = new THREE.Mesh(kneeGeo, new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false }));
                window._kneeMarkerL.raycast = () => {};
                window._kneeMarkerR.raycast = () => {};
                window._kneeMarkerL.renderOrder = 999;
                window._kneeMarkerR.renderOrder = 999;
                scene.add(window._kneeMarkerL, window._kneeMarkerR);
            }
            const showFootIKGoals = document.getElementById('toggle-foot-ik-goals').checked;
            window._footIKGoalL.visible = showFootIKGoals && !!leftFootHit;
            window._footIKGoalR.visible = showFootIKGoals && !!rightFootHit;
            if (leftFootHit) window._footIKGoalL.position.copy(_leftFootIKTarget);
            if (rightFootHit) window._footIKGoalR.position.copy(_rightFootIKTarget);
            window._kneeMarkerL.visible = showFootIKGoals && !!char.lKneeBone;
            window._kneeMarkerR.visible = showFootIKGoals && !!char.rKneeBone;
            if (char.lKneeBone) char.lKneeBone.getWorldPosition(window._kneeMarkerL.position);
            if (char.rKneeBone) char.rKneeBone.getWorldPosition(window._kneeMarkerR.position);
            bumpBoostTarget = Math.max(0, bumpBoostTarget);
            footBoostTarget = bumpBoostTarget;
            // Only frozen (skipped) while genuinely standing still ON TOP
            // of a bump right now (moveMag<=0.1 AND footBoostTarget still
            // >0 this exact frame) - every other case updates normally:
            //   - moving: rises fast onto a new bump, falls slow off an
            //     old one, same as always.
            //   - airborne (!isGrounded, last frame's value - this block
            //     runs before this frame's own grounded/falling decision):
            //     MUST keep updating even with no input, or a value frozen
            //     from the last bump the player was standing on before
            //     walking off an edge stays baked into floorY while
            //     they're actually falling through open air - the
            //     grounded/falling check below then reads that stale,
            //     no-longer-relevant boost as real ground and snaps them
            //     back "grounded" at a height with nothing under them,
            //     which is exactly the mid-air-with-legs-stretched-down
            //     pose from the reported screenshot.
            //   - standing still but NOT currently on a bump
            //     (footBoostTarget already back to 0, e.g. they drifted
            //     off the bump itself while stopping, or this is simply
            //     the tail end of walking away): still decays toward 0
            //     normally instead of holding onto a stale elevation with
            //     nothing left to justify it - the earlier version of this
            //     fix always froze once input stopped, which meant walking
            //     away in short, hesitant bursts (stop-start-stop) held
            //     the leftover height in place through every pause instead
            //     of continuing to settle down between them.
            const isStandingOnBumpNow = footBoostTarget > 0.001;
            // A foot raycast alone isn't proof the CHARACTER is still over
            // the bump field: stopping right after slowly drifting past
            // its edge leaves the root hanging over flat ground while one
            // trailing (IK-reaching) foot still catches a bump behind -
            // the old feet-only freeze then held that stale elevation
            // forever, floating the character in mid-air next to the
            // field. Verify with the root's own downward ray: whatever
            // surface is directly below the root must itself be a bump.
            // The same ray also steers the DECAY rate below, so it's cast
            // whenever either consumer needs it (idle-on-bump frames, or
            // while leftover boost is still settling after leaving the
            // field) - still nothing on plain ground with no boost active.
            let rootOverBump = false;
            const needRootRay = (isStandingOnBumpNow && moveMag <= 0.1 && isGrounded)
                || (footRiseSmoothed > 0.02);
            if (needRootRay) {
                rayDown.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.5), _downVec);
                const rootBumpHits = rayDown.intersectObjects(solidCollidables);
                rootOverBump = rootBumpHits.length > 0 && rootBumpHits[0].object.userData
                    && rootBumpHits[0].object.userData.isDecorativeBump;
            }
            if (moveMag > 0.1 || !isGrounded || !isStandingOnBumpNow || !rootOverBump) {
                // Rise fast, fall slow - each stride only has ONE foot in
                // stance touching a bump at a time (the other's mid-swing,
                // see computeFootIKTarget), so a symmetric lerp here means
                // the target itself swings a lot step to step (one foot on
                // a tall bump, the next stride's foot maybe on nothing at
                // all) and the root visibly bobs down again between almost
                // every single step even at a fairly slow lerp rate.
                // Letting it fall back down much more gradually than it
                // rises keeps the root reading as "generally elevated
                // while crossing rough ground" instead of snapping down
                // each time neither foot's raycast happens to catch a
                // bump for a step.
                // The slow 2.5 fall is ONLY for stride gaps while still
                // over the field (neither foot momentarily touching a bump
                // mid-walk - dropping fast there made the root bob every
                // step). Once the root itself is past the field's edge
                // (rootOverBump false with no foot contact either), there
                // is nothing left to be smooth about - fall at a fast,
                // step-off-a-ledge rate instead of the floaty slow drift
                // to the ground the shared 2.5 gave there.
                const offFieldEntirely = bumpBoostTarget <= 0.001 && !rootOverBump;
                const footRiseRate = footBoostTarget > footRiseSmoothed ? 9 : (offFieldEntirely ? 14 : 2.5);
                footRiseSmoothed = THREE.MathUtils.lerp(footRiseSmoothed, footBoostTarget, Math.min(1, footRiseRate * delta));
                // Proportional to how tall/intense the actual bump contact
                // is (0.4 units ~ the taller test field's typical peak
                // height reads as "fully" slow) rather than a flat on/off -
                // a single small bump barely slows the player, the tall/
                // dense field slows them close to the full
                // bumpTerrainSpeedMult.
                const BUMP_SPEED_REFERENCE_HEIGHT = 0.4;
                const bumpIntensity = THREE.MathUtils.clamp(bumpBoostTarget / BUMP_SPEED_REFERENCE_HEIGHT, 0, 1);
                bumpSpeedBlend = THREE.MathUtils.lerp(bumpSpeedBlend, bumpIntensity, Math.min(1, 8 * delta));
            }
            floorY += footRiseSmoothed;

            let wasGrounded = isGrounded;
            // yVelocity>0 (actively rising, e.g. right after a jump) is
            // always treated as airborne outright, not just when it clears
            // the floorY+0.01 check - on a steep slope, floorY (from the 5
            // offset ground-detection rays) can shift by
            // 0.25*tan(slopeAngle) between one frame and the next purely
            // from which of those rays happens to read "highest" (real
            // effect measured: exactly 0.278 on the 48deg ramp, matching
            // 0.25*tan(48deg)) even though the character's own position
            // barely moved - a jump's very first frame or two can land
            // right on the wrong side of that jitter and get silently
            // snapped back onto the slope before ever leaving it, without
            // this exemption.
            if (yVelocity > 0 || char.group.position.y + yVelocity*delta > floorY + 0.01) {
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
                // Smoothed instead of snapped specifically while on/near
                // decorative bump terrain (bumpSpeedBlend > 0, see its own
                // comment) - floorY itself (not just the foot-boost added
                // to it above) already jitters there, since the small
                // bumps are also picked up directly by the normal 5-ray
                // ground scan just like any other ground geometry, and
                // which ray reads highest can flip between a bump-top and
                // the flat ground beneath it from one frame to the next.
                // Every other surface (stairs, ramps, flat ground) keeps
                // the exact original instant snap - bumpSpeedBlend is 0
                // there, so this is a no-op everywhere except the bump
                // fields.
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

            // Run only now that position.y is fully finalized for this
            // frame (both the grounded and airborne branches above have
            // already run) - checking earlier, before the Y-snap, compares
            // against a stale (usually previous-frame) height and reads as
            // "below the ramp's top surface" even while legitimately
            // standing on/climbing it, spuriously shoving the character
            // sideways off ramps they were correctly walking up.
            pushOutOfRampUnderside(char.group.position);

            if (landingTimer > 0) landingTimer -= delta;
            
            if (isGrounded) {
                if (hitRecoveryStepActive) {
                    // Only during the actual step window, not the initial
                    // bend-only delay before it (see hitRecoveryStepActive's
                    // own comment) - through that delay, normal state
                    // selection (idle/walk/whatever) keeps running below
                    // undisturbed, and the visible "bend" comes entirely
                    // from the spine recoil overlay (updateRecoil, applied
                    // unconditionally in Character.animate regardless of
                    // which locomotion state is playing), not from
                    // switching locomotion states early.
                    // hitRecoveryAnimState was classified this same frame in
                    // the movement block above (relative to the character's
                    // own un-rotated facing) - 'walk' (forward), 'walk_backward',
                    // 'strafe_left', or 'strafe_right'. Character.animate maps
                    // each to its matching clip (see its own state handling).
                    const s = char.hitRecoveryAnimState || 'walk';
                    char.animate(delta, s, effectiveMoveMag, time, yVelocity, 0);
                    networkStateName = s;
                }
                else if (pushPullState === 'push') { char.animate(delta, 'push', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'push'; }
                else if (pushPullState === 'pull') { char.animate(delta, 'pull', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'pull'; }
                else if (isStoppingSlide) {
                    char.animate(delta, 'stop_sliding', effectiveMoveMag, time, yVelocity, 0);
                    networkStateName = 'stop_sliding';
                    char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, Math.atan2(slideDir.x, slideDir.z)), window.CHAR_TURN_RATE * delta);
                }
                else if (isSliding) {
                    char.animate(delta, 'sliding', effectiveMoveMag, time, yVelocity, 0);
                    networkStateName = 'slide';
                    // Face the direction actually being slid, same turn rate
                    // normal movement uses (see the moveMag>0.1 block above) -
                    // overrides whatever that block just turned toward, since
                    // it runs earlier this same frame and isn't aware of slopes.
                    char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, Math.atan2(slideDir.x, slideDir.z)), window.CHAR_TURN_RATE * delta);
                }
                else if (landingTimer > 0 && (initialLandingTimer > 0 ? landingTimer / initialLandingTimer : 0) > 0.4) { char.animate(delta, 'landing', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'land'; }
                // Slidable-but-climbable ramps keep their dedicated
                // 'runup' clip (a plain walk/run cycle was tried there and
                // rejected) - unlike before, legIK now stays on during it.
                else if (isClimbingSlope && effectiveMoveMag > 0.05) { char.animate(delta, 'runup', effectiveMoveMag, time, yVelocity, 0); networkStateName = 'runup'; }
                // Non-slidable ramps + flat ground: the walk/run choice is
                // driven by moveMag (raw input, 0-1) rather than
                // effectiveMoveMag, so the ramp-angle speed reduction above
                // can't cap the character out of the run clip at full
                // input. fadeToAction uses the value as a plain threshold
                // (neither clip's timeScale varies with it), so which clip
                // plays reflects how hard the player is pressing while
                // actual ground covered still reflects the reduced speed.
                else if (effectiveMoveMag > 0.05) {
                    // Deliberately NOT the same threshold isOnSlopeSurface
                    // (below, groundNormal.y<0.995, ~5.7deg) uses - that
                    // catches every gentle ramp too, and normal Walking.fbx
                    // was already fine on the shallower ones (confirmed
                    // still fine at 25deg). Reusing SLIDE_EXIT_ANGLE
                    // (~30.6deg, between the 25deg that's fine and the
                    // 33deg that isn't) keeps WalkingUp.fbx scoped to
                    // ramps steep enough to actually need it. Also gated on
                    // isSlopeRamp specifically (not any steep terrain, e.g.
                    // the hemisphere) - WalkingUp.fbx was only ever verified
                    // against the purpose-built test ramps, not other
                    // natural climbable slopes.
                    const isOnTestRamp = lastGroundObject && lastGroundObject.userData && lastGroundObject.userData.isSlopeRamp;
                    window.isOnSlopeSurfaceForWalk = isGrounded && isOnTestRamp && groundNormal.angleTo(_upVec) > SLIDE_EXIT_ANGLE && !isLedgeGrabbing && !isClimbingUp;
                    char.animate(delta, 'walk', moveMag, time, yVelocity, 0); networkStateName = moveMag > 0.8 ? 'run' : 'walk';
                }
                else { char.animate(delta, 'idle', 0, time, 0, 0); networkStateName = 'idle'; }
            } else { char.animate(delta, 'air', effectiveMoveMag, time, yVelocity, 0); networkStateName = yVelocity > 0 ? 'jump_start' : 'fall'; }
            // Visual-only lean toward the slope's surface while sliding -
            // called every frame (not just while isSliding) so it relaxes
            // back to upright on its own once grounded normally again.
            // isStoppingSlide counts as "not sliding" here on purpose: it
            // still sets isSliding=true for the physics/animation-state
            // branch above, but the body itself should already be
            // straightening back up through that whole stopping stretch,
            // not staying leaned at the full slide angle until the instant
            // it switches to climbing - StopSliding.fbx's own pose already
            // shows that recovery, fighting it with a still-fully-tilted
            // root transform is what left the body looking stuck at the
            // slide angle through the transition.
            const isGenuinelySliding = isSliding && !isStoppingSlide;
            // Only the ARROW tilts on any sloped surface the character is
            // grounded on (sliding, climbing, or just walking a shallow
            // ramp). The body/root itself only tilts while genuinely
            // sliding - tilting it during climbing/walking too forced legIK
            // to fight a fully-tilted root every frame just to keep feet
            // planted, producing an unnatural crouch. Feet still conform to
            // the slope on any sloped surface via legIK below, independent
            // of whether the root itself is tilted.
            const isOnSlopeSurface = isGrounded && groundNormal.y < 0.995 && !isLedgeGrabbing && !isClimbingUp;
            let arrowTiltRefDir = null;
            if (isOnSlopeSurface) {
                arrowTiltRefDir = isGenuinelySliding ? slideDir : _tiltRefDirScratch.set(0, 0, 1).applyQuaternion(char.group.quaternion);
            }
            // Updates char.turnLeanAngle only (no quaternion writes) - has
            // to run before setSlopeTilt so that call can fold the fresh
            // value into its own single combined slerp target this frame
            // (see setSlopeTilt's own comment for why they can't be two
            // separate quaternion ops on fbxModel.quaternion).
            char.updateTurnLean(delta);
            // Whole body (root) tilts to match the slope while genuinely
            // sliding, same as it always did - the piecemeal spine/neck
            // counter-lean experiments are gone. What survives instead is
            // a single pelvis hold (below): the root tilts, but the hips
            // bone is rotated back to its as-authored orientation, as if
            // the ground weren't sloped - legs get carried with it and
            // legIK (later this frame) re-plants the feet on the slope.
            char.setSlopeTilt(isGenuinelySliding ? groundNormal : _upVec, delta, isGenuinelySliding ? slideDir : null, char.turnLeanAngle, char.hitTwistAngle);
            if (isGenuinelySliding) char.levelPelvisWhileSliding();
            char.setArrowTilt(isOnSlopeSurface ? groundNormal : _upVec, delta, arrowTiltRefDir);
            // Leg IK: plants each foot on the ground actually under it
            // (rather than wherever the animation clip alone leaves it),
            // running after the tilt/lean above so it's working from the
            // final posed skeleton for this frame, not a stale one.
            // Gated on isOnSlopeSurface (one continuous sloped surface,
            // groundNormal.y < 0.995) - the ORIGINAL condition, restored -
            // OR isOnBumpTerrain (either foot's own raycast found an
            // isDecorativeBump directly, regardless of what the single
            // coarse groundNormal ray saw). A version of this broadened to
            // plain isGrounded (running on literally every frame,
            // including flat ground) was tried to make bump-field contact
            // more reliable, but it also meant every other new mechanic
            // built alongside it (weighted correction, the floorY foot-
            // boost) now ran on ramps too even when nothing about them
            // needed fixing, and broke ramp foot-planting more than once
            // this session in ways that took real effort to track down
            // each time. Splitting the trigger like this keeps ramps on
            // the exact path they were already working well on, while
            // still giving bumps their own reliable (if separately
            // maintained) per-foot detection.
            const isOnBumpTerrain = (leftFootHit && leftFootHit.userData && leftFootHit.userData.isDecorativeBump)
                || (rightFootHit && rightFootHit.userData && rightFootHit.userData.isDecorativeBump);
            // No legIK while actively climbing a slidable slope
            // (isClimbingSlope - the 'runup' clip): IK-on there was tried
            // and rejected, the correction erases the clip's stepping
            // motion (an earlier version of the same exception gated on
            // the test ramps' own 40deg+ userData angle instead; the state
            // flag covers every slidable slope, not just test ramps).
            // Shallower, non-slidable ramps keep full IK as always.
            if ((isOnSlopeSurface || isOnBumpTerrain) && !isClimbingSlope && !isLedgeGrabbing && !isClimbingUp && char.fbxModel) {
                // leftFootHit/rightFootHit and _leftFootIKTarget/
                // _rightFootIKTarget were already computed once this same
                // frame by the foot-boost block above (near wasGrounded) -
                // reused here instead of raycasting the same thing again.
                const leftValid = leftFootHit;
                const rightValid = rightFootHit;
                // Plain universal speed-based weight, no isClimbingSlope
                // special case - both a flat weight of 1.0 (perfect hold,
                // but reads as zero stepping - full correction overrides
                // whatever lift the runup clip's own cycle wants to show)
                // and a fixed 0.6 for climbing specifically (still too
                // close to the same "doesn't hold" feel as the plain
                // formula already gave) were tried and rejected in favor
                // of just this - the first version that actually read
                // well while climbing.
                const legIKWeight = THREE.MathUtils.clamp(1.0 - effectiveMoveMag, 0.35, 1.0);
                char.applyLegIK(leftValid ? _leftFootIKTarget : null, rightValid ? _rightFootIKTarget : null, legIKWeight);
            }

            networkCarryUpper = false;
            if (window.isCarryStarting) networkStateName = 'carry_start';
            else if (window.isCarryDropping) networkStateName = 'carry_start';
            else if (window.throwTimer > 0) networkStateName = 'throw';
            else if (window.combat && window.combat.punchState > 0) {
                const ps = window.combat.punchState;
                if (ps === 1) networkStateName = 'punch_left';
                else if (ps === 2) networkStateName = 'punch_right';
                else if (ps === 3) networkStateName = 'punch_combo';
                else if (ps === 4) networkStateName = window.combat.chargeHoldAnimName || 'punch_charge_hold';
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
        // Broadcasts under a fixed id ('ai-bot-1') so every connected client
        // renders the same bot, driven by whoever spawned it - not
        // synced/cleaned up if that person disconnects, it just stays put
        // wherever it last was on everyone else's screen (simple, matches
        // what was asked for; no ownership handoff or despawn-on-leave).
        if (aiBot && network) network.sendAiBotState(aiBot.group.position, aiBot.group.quaternion, aiBot.stateName, delta);

        let trackingPoint = _tempVec1;
        if (char.hips && (isClimbingUp || char.isRagdoll || char.isStandingUp)) char.hips.getWorldPosition(trackingPoint);
        else { trackingPoint.copy(char.group.position); trackingPoint.y += 1.1; }
        
        camTarget.lerp(trackingPoint, 10 * delta);

        let targetCamX = camTarget.x + cameraRadius * Math.sin(cameraPhi) * Math.sin(cameraTheta);
        let targetCamY = Math.max(floorY + 0.5, camTarget.y + cameraRadius * Math.cos(cameraPhi) + 1.5);
        let targetCamZ = camTarget.z + cameraRadius * Math.sin(cameraPhi) * Math.cos(cameraTheta);

        camera.position.lerp(_tempVec2.set(targetCamX, targetCamY, targetCamZ), 15 * delta);
        camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
        orthoCamera.position.copy(camera.position);
        orthoCamera.quaternion.copy(camera.quaternion);

        // Debug: live yaw readout floating above the player's head, so a
        // problematic walking angle can be read off the screen and
        // reported exactly instead of described (used for tuning the
        // slidable-ramp entry thresholds). Redrawn only when the shown
        // integer changes. Tied to the 'toggle-angle-labels' Debug Vis
        // checkbox alongside the ramp angle labels (rampAngleLabels) -
        // see that checkbox's change handler.
        if (!window._yawLabelSprite && char && char.group) {
            const cv = document.createElement('canvas');
            cv.width = 192; cv.height = 64;
            window._yawLabelCtx = cv.getContext('2d');
            window._yawLabelTex = new THREE.CanvasTexture(cv);
            const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: window._yawLabelTex, depthTest: false }));
            spr.scale.set(1.8, 0.6, 1);
            spr.position.set(0, 2.5, 0);
            spr.raycast = () => {}; // must never be hit-testable (see makeTextSprite)
            spr.visible = document.getElementById('toggle-angle-labels').checked;
            char.group.add(spr);
            window._yawLabelSprite = spr;
            window._yawLabelLast = '';
        }
        // Debug: expose core per-frame physics state for external
        // inspection (e.g. via Playwright) while chasing ledge-grab
        // reach reports. Cheap (plain property writes), fine to leave.
        window._dbgIsGrounded = isGrounded;
        window._dbgYVelocity = yVelocity;
        window._dbgIsLedgeGrabbing = isLedgeGrabbing;
        window._dbgIsClimbingUp = isClimbingUp;
        window._dbgStamina = stamina;
        window._dbgLedgeGrabCooldown = ledgeGrabCooldown;
        if (window._yawLabelSprite) {
            // group.quaternion is yaw-only: (0, sin(y/2), 0, cos(y/2)).
            let yawDeg = Math.round(2 * Math.atan2(char.group.quaternion.y, char.group.quaternion.w) * 180 / Math.PI);
            yawDeg = ((yawDeg % 360) + 360) % 360;
            const txt = yawDeg + '°';
            if (txt !== window._yawLabelLast) {
                window._yawLabelLast = txt;
                const ctx = window._yawLabelCtx;
                ctx.clearRect(0, 0, 192, 64);
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.fillRect(0, 0, 192, 64);
                ctx.fillStyle = '#ffff88';
                ctx.font = 'bold 40px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(txt, 96, 32);
                window._yawLabelTex.needsUpdate = true;
            }
        }
        // Debug: speed + which locomotion clip(s) are actually playing
        // right now (and at what blend weight, during a walk/run
        // crossfade) - for tuning the walk-vs-run feel/transition without
        // guessing from how it looks. Stacked above the yaw label. Tied to
        // its own 'toggle-speed-label' Debug Vis checkbox.
        // Canvas tall enough for speed + up to 3 animation lines (one per
        // active clip) stacked below it, each on its own row instead of
        // crammed onto one line together.
        const SPEED_LABEL_LINE_H = 40;
        const SPEED_LABEL_MAX_LINES = 4;
        if (!window._speedLabelSprite && char && char.group) {
            const cv2 = document.createElement('canvas');
            cv2.width = 256; cv2.height = SPEED_LABEL_LINE_H * SPEED_LABEL_MAX_LINES;
            window._speedLabelCtx = cv2.getContext('2d');
            window._speedLabelTex = new THREE.CanvasTexture(cv2);
            const spr2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: window._speedLabelTex, depthTest: false }));
            spr2.scale.set(2.4, 2.4 * cv2.height / cv2.width, 1);
            spr2.position.set(0, 3.4, 0);
            spr2.raycast = () => {};
            spr2.visible = document.getElementById('toggle-speed-label').checked;
            char.group.add(spr2);
            window._speedLabelSprite = spr2;
            window._speedLabelLast = '';
        }
        if (window._speedLabelSprite) {
            const spd = window._dbgActualSpeed || 0;
            const parts = [];
            ['idle', 'walk', 'run'].forEach(name => {
                const a = char.actions && char.actions[name];
                // getEffectiveWeight() alone is misleading here - it
                // reflects the action's configured weight regardless of
                // whether the action has actually been started (played)
                // on the mixer, so an action that's just sitting at its
                // three.js default weight=1 but was never play()'d would
                // otherwise show as "100%" despite contributing nothing
                // to the pose actually on screen. isRunning() is what
                // tells them apart.
                if (!a || !a.isRunning()) return;
                const w = Math.round(a.getEffectiveWeight() * 100);
                if (w > 0) parts.push(name + ' ' + w + '%');
            });
            const lines = [spd.toFixed(1) + ' u/s'].concat(parts.length ? parts : ['-']);
            const txt = lines.join('|');
            if (txt !== window._speedLabelLast) {
                window._speedLabelLast = txt;
                const ctx2 = window._speedLabelCtx;
                const w2 = ctx2.canvas.width, h2 = ctx2.canvas.height;
                ctx2.clearRect(0, 0, w2, h2);
                ctx2.fillStyle = 'rgba(0,0,0,0.55)';
                ctx2.fillRect(0, 0, w2, h2);
                ctx2.fillStyle = '#88ddff';
                ctx2.font = 'bold 28px sans-serif';
                ctx2.textAlign = 'center';
                ctx2.textBaseline = 'middle';
                lines.forEach((line, i) => {
                    ctx2.fillText(line, w2 / 2, SPEED_LABEL_LINE_H * (i + 0.5));
                });
                window._speedLabelTex.needsUpdate = true;
            }
        }

        // Compass: real 3D needle (see its own construction comment near
        // the camera, top of this function). Same camera-local offset the
        // old cone used (so it stays roughly centered in view, tracking
        // pitch as the player orbits the camera), computed manually here
        // instead of via camera.add() so a floor clamp can be applied
        // afterward - that's what actually stops it from visually sinking
        // into the ground on a steep downward pitch. Then just looks
        // straight at the level's exit (the yellow octahedron "star").
        compassMesh.visible = window.compass3DEnabled;
        _compassOffset.copy(COMPASS_LOCAL_OFFSET).applyQuaternion(camera.quaternion);
        compassMesh.position.copy(camera.position).add(_compassOffset);
        compassMesh.position.y = Math.max(compassMesh.position.y, floorY + COMPASS_MIN_FLOOR_CLEARANCE);
        compassMesh.lookAt(star.position);
        compassMesh.updateMatrixWorld();

        // 2D arrow, derived from the (always-updated, even if its own
        // visibility is off) 3D cone's own tip vs its own center - see
        // _compassFront/_compassBack's construction comment for why this
        // avoids the near-90-degree projection blowup a directly-projected
        // far-away/behind target hits.
        if (compassArrowEl) {
            compassArrowEl.style.display = window.compass2DEnabled ? '' : 'none';
            if (compassBackdropEl) compassBackdropEl.style.display = window.compass2DEnabled ? '' : 'none';
            if (window.compass2DEnabled) {
                _compassFront.set(0, 0, 0.25).applyMatrix4(compassMesh.matrixWorld).project(camera);
                _compassBack.set(0, 0, 0).applyMatrix4(compassMesh.matrixWorld).project(camera);
                const frontX = (_compassFront.x * 0.5 + 0.5) * window.innerWidth;
                const frontY = (-_compassFront.y * 0.5 + 0.5) * window.innerHeight;
                const backX = (_compassBack.x * 0.5 + 0.5) * window.innerWidth;
                const backY = (-_compassBack.y * 0.5 + 0.5) * window.innerHeight;
                const dx = frontX - backX, dy = frontY - backY;
                if (dx !== 0 || dy !== 0) {
                    const screenAngle = Math.atan2(dx, -dy);
                    compassArrowEl.style.transform = `translateX(-50%) rotate(${screenAngle}rad)`;
                }
            }
        }

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


        const activeCamera = window.orthoCameraEnabled ? orthoCamera : camera;
        if (window.pixelEffectEnabled) {
            renderPixelatedPass.camera = activeCamera;
            composer.render();
        } else {
            renderer.render(scene, activeCamera);
        }
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
        composer.setSize(window.innerWidth, window.innerHeight);
        updateOrthoFrustum();
    }
    window.addEventListener('resize', handleViewportResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportResize);
}