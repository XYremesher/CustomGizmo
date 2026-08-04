import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { MultiplayerClient } from './multiplayer.js';
import { RemoteAvatar } from './remote_avatar.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// LevelEditor is loaded lazily (see ensureLevelEditorLoaded below), NOT
// imported statically here - a top-level import is fetched/parsed before
// any game code runs at all, so every player paid that cost even though
// only the level author (never someone playing on a portal) ever opens
// the editor.

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

    // Same 3 tone bands (dark/mid/light) the toon gradient always used
    // (0, 128, 255), just now baked into a wider 64-texel ramp instead of
    // one texel per band, so a smoothness value can blend each band
    // partway into the next instead of only ever being a hard step -
    // smoothness 0 reproduces the exact old look (flat plateau covering
    // the whole band, instant jump at the boundary); 1 blends across the
    // entire band, reading as a soft, almost-continuous gradient instead
    // of visible cel-shading steps. LinearFilter (was Nearest) just
    // antialiases the single-texel-wide jump that's still there at
    // smoothness 0, rather than adding any softening of its own - at 64
    // texels that's sub-pixel, not a visible change to the hard-edge look.
    const TOON_BAND_VALUES = [0, 128, 255];
    const TOON_GRADIENT_SIZE = 64;
    function buildToonGradientData(smoothness) {
        const n = TOON_BAND_VALUES.length;
        const data = new Uint8Array(TOON_GRADIENT_SIZE);
        for (let i = 0; i < TOON_GRADIENT_SIZE; i++) {
            const t = i / (TOON_GRADIENT_SIZE - 1);
            const scaled = t * n;
            const bandIndex = Math.min(n - 1, Math.floor(scaled));
            const localT = scaled - bandIndex;
            const currentVal = TOON_BAND_VALUES[bandIndex];
            const nextVal = TOON_BAND_VALUES[Math.min(n - 1, bandIndex + 1)];
            let blendT = 0;
            if (smoothness > 0) {
                const edgeStart = 1 - smoothness; // where the blend-toward-next-band zone starts within this band
                blendT = localT <= edgeStart ? 0 : (localT - edgeStart) / smoothness;
            }
            data[i] = Math.round(THREE.MathUtils.lerp(currentVal, nextVal, blendT));
        }
        return data;
    }
    window.toonSmoothness = 0.0;
    const threeTone = new THREE.DataTexture(buildToonGradientData(window.toonSmoothness), TOON_GRADIENT_SIZE, 1, THREE.RedFormat);
    threeTone.needsUpdate = true;
    threeTone.minFilter = THREE.LinearFilter;
    threeTone.magFilter = THREE.LinearFilter;
    // Every MeshToonMaterial in the game shares this one texture by
    // reference, so rewriting its data in place (instead of building a new
    // DataTexture each time) updates every material's shading at once.
    function setToonSmoothness(v) {
        window.toonSmoothness = v;
        threeTone.image.data.set(buildToonGradientData(v));
        threeTone.needsUpdate = true;
    }

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
    // Temporary debug numbering for the stair columns (buildStairColumn) -
    // always visible, no toggle checkbox. Cleared at the top of
    // buildStairsLevel() same as rampAngleLabels, same reason.
    const stairNumberLabels = [];
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
    // Copy of the ground normal the slope logic settled on this frame, kept
    // for the _dbg readout at the end of animate (groundNormal itself is
    // scoped to the block that computes it).
    const _dbgGroundNormalOut = new THREE.Vector3(0, 1, 0);
    // Ground normal fitted through the five ground-ray hit points (see the
    // bevel check in the ground scan).
    const _fitNormalScratch = new THREE.Vector3();
    // The single-triangle normal the scan started from, kept so the ground-ray
    // debug view can show it next to the corrected one - seeing the raw facet
    // swing sideways on a block edge while the used normal stays put is the
    // whole point of that view.
    const _facetNormalBeforeFit = new THREE.Vector3(0, 1, 0);

    // ---- Ground-ray debug visualisation (Debug Vis > "Ray 5") ----
    // Draws the five ground-scan rays, their hit points, and BOTH normals:
    // magenta = the raw facet the centre ray landed on, cyan = what the slope
    // logic actually uses after the plane fit. Same shape as the other Debug
    // Vis toggles: built once, hidden by default, visibility driven by the
    // checkbox.
    const groundRayDbg = { built: false, group: null, lines: [], dots: [], facetArrow: null, finalArrow: null };
    function buildGroundRayDbg() {
        if (groundRayDbg.built) return;
        groundRayDbg.built = true;
        const g = new THREE.Group();
        g.visible = false;
        for (let i = 0; i < 5; i++) {
            const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x00ff00, depthTest: false }));
            line.renderOrder = 999;
            g.add(line); groundRayDbg.lines.push(line);
            const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6),
                new THREE.MeshBasicMaterial({ color: 0xffff00, depthTest: false }));
            dot.renderOrder = 1000;
            g.add(dot); groundRayDbg.dots.push(dot);
        }
        groundRayDbg.facetArrow = new THREE.ArrowHelper(_upVec.clone(), new THREE.Vector3(), 1.1, 0xff00ff, 0.22, 0.12);
        groundRayDbg.finalArrow = new THREE.ArrowHelper(_upVec.clone(), new THREE.Vector3(), 1.4, 0x00ffff, 0.26, 0.14);
        [groundRayDbg.facetArrow, groundRayDbg.finalArrow].forEach(a => {
            a.line.material.depthTest = false; a.cone.material.depthTest = false;
            a.line.renderOrder = 999; a.cone.renderOrder = 999;
            g.add(a);
        });
        scene.add(g);
        groundRayDbg.group = g;
    }
    const _grdA = new THREE.Vector3(), _grdB = new THREE.Vector3();
    function updateGroundRayDbg(offsets, sampleY, facetNormal, finalNormal) {
        const cb = document.getElementById('toggle-ground-rays');
        const on = !!(cb && cb.checked);
        if (!on) { if (groundRayDbg.group) groundRayDbg.group.visible = false; return; }
        buildGroundRayDbg();
        groundRayDbg.group.visible = true;
        const p = char.group.position;
        for (let i = 0; i < 5; i++) {
            const off = offsets[i];
            const topY = p.y + 1.2;
            const hit = sampleY[i];
            _grdA.set(p.x + off.x, topY, p.z + off.z);
            _grdB.set(p.x + off.x, hit !== null && hit !== undefined ? hit : topY - 2.0, p.z + off.z);
            const pos = groundRayDbg.lines[i].geometry.attributes.position;
            pos.setXYZ(0, _grdA.x, _grdA.y, _grdA.z);
            pos.setXYZ(1, _grdB.x, _grdB.y, _grdB.z);
            pos.needsUpdate = true;
            groundRayDbg.lines[i].geometry.computeBoundingSphere();
            const didHit = hit !== null && hit !== undefined;
            groundRayDbg.lines[i].material.color.setHex(didHit ? (i === 0 ? 0x00ff88 : 0x00aa44) : 0xff3333);
            groundRayDbg.dots[i].visible = didHit;
            if (didHit) groundRayDbg.dots[i].position.copy(_grdB);
        }
        _grdA.set(p.x, p.y + 0.05, p.z);
        groundRayDbg.facetArrow.position.copy(_grdA);
        groundRayDbg.facetArrow.setDirection(facetNormal);
        groundRayDbg.finalArrow.position.copy(_grdA);
        groundRayDbg.finalArrow.setDirection(finalNormal);
        const fEl = document.getElementById('ground-facet-display');
        const uEl = document.getElementById('ground-final-display');
        if (fEl) fEl.textContent = THREE.MathUtils.radToDeg(facetNormal.angleTo(_upVec)).toFixed(1) + '°';
        if (uEl) uEl.textContent = THREE.MathUtils.radToDeg(finalNormal.angleTo(_upVec)).toFixed(1) + '°';
    }

    // Crack-straddle probes, used only when the normal ground scan finds
    // nothing under the character (see its own comment in the ground scan).
    // Opposing pairs at the character's own body radius: index k in A is the
    // mirror of index k in B, so "both hit" means solid ground on BOTH sides
    // of whatever the character is standing over - a crack - as opposed to a
    // platform edge, where only one side hits.
    const CHAR_BODY_RADIUS = 0.45;   // matches isVerticalSpaceClear's bodyRadius
    const _R = CHAR_BODY_RADIUS, _Rd = CHAR_BODY_RADIUS * 0.7071;
    const _crackProbeA = [
        new THREE.Vector3(_R, 0, 0), new THREE.Vector3(0, 0, _R),
        new THREE.Vector3(_Rd, 0, _Rd), new THREE.Vector3(_Rd, 0, -_Rd),
    ];
    const _crackProbeB = [
        new THREE.Vector3(-_R, 0, 0), new THREE.Vector3(0, 0, -_R),
        new THREE.Vector3(-_Rd, 0, -_Rd), new THREE.Vector3(-_Rd, 0, _Rd),
    ];
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
        constructor(parent, x, y, z, intensity = 'high', fireDir = new THREE.Vector3(-1, 0, 0)) {
            this.intensity = intensity;
            this.fireDir = fireDir;
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

            const direction = _tempVec1.copy(this.fireDir);
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
    // target. (There used to be a flat 2D screen-space arrow alongside
    // this, projected from the same needle - removed outright per request,
    // not just defaulted off.)
    window.compass3DEnabled = true;
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
    // Half-extent of the shadow camera's box, kept as a named constant since
    // buildGrass() below needs the exact same number - anything placed
    // outside this box samples the shadow map past its own edge (clamped/
    // undefined depth comparison), which reads as random dark speckling on
    // perfectly lit ground. Not widened to cover the full grass field: the
    // same 2048x2048 texel budget spread over a bigger box would blur the
    // shadows that matter most (the player, the level geometry near it) -
    // see buildGrass's own comment for the alternative taken instead.
    const SHADOW_CAMERA_HALF_EXTENT = 40;
    window._shadowCameraHalfExtent = SHADOW_CAMERA_HALF_EXTENT;
    dirLight.shadow.camera.left = -SHADOW_CAMERA_HALF_EXTENT; dirLight.shadow.camera.right = SHADOW_CAMERA_HALF_EXTENT;
    dirLight.shadow.camera.top = SHADOW_CAMERA_HALF_EXTENT; dirLight.shadow.camera.bottom = -SHADOW_CAMERA_HALF_EXTENT;
    dirLight.shadow.bias = -0.0001; dirLight.shadow.normalBias = 0.02;
    scene.add(dirLight); scene.add(dirLight.target);

    // Second, angled "fill" light - no shadow map (the expensive part of a
    // light, not the lighting math itself), so it's cheap to have a second
    // directional source giving depth/rim definition from the side instead
    // of everything being lit from directly overhead.
    const fillLight = new THREE.DirectionalLight(0xffffff, 1.0);
    fillLight.position.set(-25, 15, -20);
    fillLight.castShadow = false;
    scene.add(fillLight); scene.add(fillLight.target);

    const collidables = [];
    window.collidables = collidables;
    const levelGroup = new THREE.Group();
    scene.add(levelGroup);

    // In-game level editor (select/move/rotate/scale/add-shape) - see
    // level_editor.js and CLAUDE.md for scope. Loaded LAZILY: level_editor.js
    // (plus Gizmo.js/shape_generator.js/shape_gizmo.js it pulls in) is only
    // fetched/constructed the first time the editor toggle is actually
    // checked, via ensureLevelEditorLoaded() below - a real player on a
    // portal never opens the editor, so this keeps that whole module graph
    // out of their load time entirely. Was built eagerly before; every
    // `levelEditor.` reference below this point either lives inside a
    // listener that only fires once the editor panel is visible (which
    // can't happen before the toggle's own handler has awaited the load),
    // or is explicitly guarded (see the resize handler, and the grass
    // wireframe check above).
    window.editorModeActive = false;
    let levelEditor = null;
    window.levelEditor = null;
    let CUT_PROP_GROUPS = null;
    let levelEditorLoadPromise = null;
    function ensureLevelEditorLoaded() {
        if (levelEditorLoadPromise) return levelEditorLoadPromise;
        levelEditorLoadPromise = import('./level_editor.js').then(mod => {
            levelEditor = new mod.LevelEditor(scene, renderer, levelGroup, collidables);
            window.levelEditor = levelEditor;
            CUT_PROP_GROUPS = mod.CUT_PROP_GROUPS;
            setupEditorUI();
            return levelEditor;
        });
        return levelEditorLoadPromise;
    }

    const texLoader = new THREE.TextureLoader();
    const groundTex = texLoader.load('https://media.istockphoto.com/id/865924416/de/vektor/cartoon-rasen.jpg?s=612x612&w=0&k=20&c=RPfx_iiW2SZsn_MinDtdgzJyeCKDbONn8Gn-8CSdg0s=');
    groundTex.wrapS = THREE.RepeatWrapping; groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(150, 150);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshToonMaterial({ map: groundTex, gradientMap: threeTone }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground); 
    
    window.ground = ground;

    // ---- Scattered grass tufts ----
    // Crossed quads (two planes at 90 degrees per tuft) rather than billboards:
    // a billboard has to be re-oriented every frame, a cross looks the same
    // from any angle for free and instances cleanly. One InstancedMesh per
    // texture, so the whole field is two draw calls no matter how dense.
    //
    // raycast is disabled on both. Everything in this game probes the world
    // with rays - ground scan, foot IK, carry placement, editor picking - and
    // decorative geometry that answers those rays would break all of it (the
    // ground scan in particular just spent a long session being made robust).
    const grassTex2 = texLoader.load('grass2.png');
    const grassTex3 = texLoader.load('grass3.png');
    [grassTex2, grassTex3].forEach(t => { t.colorSpace = THREE.SRGBColorSpace; });
    // alphaTest instead of transparent: cutout foliage sorts badly as
    // transparent (tufts flicker against each other depending on camera
    // angle), and grass edges don't need real blending.
    //
    // Live-tunable (Grass Alpha Cutoff slider) rather than a fixed constant -
    // both PNGs have a soft, anti-aliased fade at the blade tips/base rather
    // than a hard alpha edge, and how much of that fade to keep vs. discard
    // is a look call, not something to nail down once and hardcode. Measured
    // for reference: at 0.5 the shader discards the bottom ~18% of the image
    // height as "not opaque enough" (reads as the whole tuft floating above
    // the ground even though the geometry itself is flush); at 0.15 that
    // margin is ~5%.
    window.grassAlphaTest = 0.90;
    const grassMats = [grassTex2, grassTex3].map(map => {
        const mat = new THREE.MeshToonMaterial({
            map, gradientMap: threeTone, side: THREE.DoubleSide, alphaTest: window.grassAlphaTest, transparent: false,
        });
        // Cancels out DoubleSide's automatic backface normal flip. Standard
        // three.js behaviour: a double-sided material negates the normal
        // when gl_FrontFacing is false, so a surface always shades as if lit
        // from its own visible side. For the crossed-quad cross this UNDOES
        // the forced-up normal above rather than complementing it - from any
        // camera angle you're looking at the FRONT of one card and the BACK
        // of its perpendicular partner, so the same (0,1,0) normal flips to
        // (0,-1,0) on that second card, and it renders as if lit from
        // underneath - bright card next to a dark one, in the same tuft.
        // Stripping the flip out of the compiled shader (rather than
        // dropping DoubleSide, which would make the geometry invisible from
        // outside its winding direction) makes every card use the literal
        // vertex normal always, so lighting - and therefore shadow
        // reception, still fully intact - is identical no matter which face
        // or angle you're looking from.
        mat.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_begin>',
                'vec3 normal = normalize( vNormal );'
            );
        };
        return mat;
    });
    // Two crossed unit quads, pivot at the base so scaling grows them upward.
    const grassCrossGeo = (() => {
        const a = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
        const bGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2);
        const merged = BufferGeometryUtils.mergeGeometries([a, bGeo]);
        // Force every vertex's normal to straight up, overwriting the two
        // quads' real (perpendicular) normals. Without this, MeshToonMaterial
        // shades each quad against its OWN facing direction under the
        // directional light - one card of the cross ends up near-fully-lit,
        // the other near-fully-backlit, so a single tuft reads as two
        // different brightnesses depending which card you're looking at,
        // and that's per-tuft-orientation (random Y rotation), not
        // consistent across the field. Sharing one normal makes both cards
        // receive identical lighting regardless of which way they face -
        // the standard trick for crossed-billboard foliage.
        const n = merged.attributes.position.count;
        const normals = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) normals[i * 3 + 1] = 1;
        merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        return merged;
    })();
    const grassMeshes = [];
    window.grassCount = 2000;
    window.grassSize = 1.4;
    window.grassArea = 80;
    // Independent of grassSize (which is the width/depth of the card) - lets
    // the tufts be stretched taller/shorter without also changing how wide
    // they are, or vice versa.
    window.grassHeight = 0.95;
    // Fraction of each instance's OWN height to sink it below the ground -
    // see the placement loop for why this has to scale with height rather
    // than being a fixed world-unit offset.
    window.grassBaseSink = 0.25;
    function clearGrass() {
        grassMeshes.forEach(m => { scene.remove(m); m.dispose && m.dispose(); });
        grassMeshes.length = 0;
    }
    // Scatters tufts on open ground: a downward ray finds whatever's
    // directly above a candidate spot, then checks that hit's own Box3 to
    // tell "solid thing resting on the ground here" apart from "something's
    // overhead but there's real clearance below it" - see the check itself,
    // further down, for why a plain hit/no-hit test isn't enough.
    const _grassRay = new THREE.Raycaster();
    const _grassDown = new THREE.Vector3(0, -1, 0);
    const _grassFrom = new THREE.Vector3();
    const _grassObstacleBox = new THREE.Box3();
    const _grassMat4 = new THREE.Matrix4();
    const _grassQuat = new THREE.Quaternion();
    const _grassPos = new THREE.Vector3();
    const _grassScale = new THREE.Vector3();
    function buildGrass() {
        // The level is built synchronously in one go and buildGrass() runs at
        // the tail end of that, before any frame has ever rendered. A mesh's
        // matrixWorld is only recomputed on render (or an explicit call) -
        // without this, freshly created/rotated pieces (the ramps in
        // particular, which set position AND rotation.x) can still carry a
        // stale or identity matrixWorld, so a raycast run this early tests
        // them in the wrong place. Confirmed live: without this call, tufts
        // landed on ramp panels that a raycast moments later (post-render)
        // correctly rejected - same ray, same objects, only the timing
        // differed.
        scene.updateMatrixWorld(true);
        clearGrass();
        const toggle = document.getElementById('toggle-grass');
        if (toggle && !toggle.checked) return;
        const total = Math.max(0, Math.round(window.grassCount));
        if (!total) return;
        const half = window.grassArea;
        const blockers = collidables.filter(c => c !== ground);
        // Two buckets per texture: instances inside the shadow camera's own
        // box get receiveShadow, instances outside it don't - see the
        // SHADOW_CAMERA_HALF_EXTENT comment on dirLight for why. A small
        // margin short of the true edge (not the full 40) because shadow
        // sampling gets unreliable in the last few units near the frustum
        // boundary too (PCF filter kernel reaches past the edge), not just
        // strictly outside it.
        const shadowSafe = (window._shadowCameraHalfExtent || 40) - 3;
        const perMat = grassMats.map(() => ({ near: [], far: [] }));
        // Tallest a tuft can come out at the CURRENT Size/Height settings
        // (matches the s/h random ranges below: size up to *1.35, height up
        // to *1.3), plus a margin - see its use just below.
        const maxGrassClearance = window.grassSize * 1.35 * window.grassHeight * 1.3 + 0.3;
        // Fixed attempt budget so a level that is mostly platforms can't spin
        // here forever looking for open ground.
        let attempts = 0;
        const maxAttempts = total * 6;
        let placed = 0;
        while (placed < total && attempts++ < maxAttempts) {
            const x = (Math.random() * 2 - 1) * half;
            const z = (Math.random() * 2 - 1) * half;
            _grassFrom.set(x, 60, z);
            _grassRay.set(_grassFrom, _grassDown);
            const hits = _grassRay.intersectObjects(blockers, true);
            if (hits.length > 0) {
                // Not an automatic reject anymore. The ray still has to start
                // from a safely-high origin - some level pieces (the extra-
                // tall first stair step, cubeSize*1.9) are themselves taller
                // than a tuft, and starting the ray any lower would sometimes
                // spawn it INSIDE that solid geometry, where a downward ray
                // can't see the exit face and would falsely report "clear".
                // What changes is what counts as blocking: the hit object's
                // OWN bottom edge (its Box3), not just that something was hit
                // at all. An overhang whose underside sits comfortably above
                // maxGrassClearance leaves genuine open ground beneath it -
                // exactly the "grows in shade under a bridge" case that a
                // blanket "any hit rejects" was wrongly excluding everywhere.
                // A block resting on the ground has min.y near 0, well under
                // the clearance line, so it's still rejected exactly as
                // before - this only opens up placement that was always
                // physically valid to begin with.
                window.getObstacleBox(hits[0].object, _grassObstacleBox);
                if (_grassObstacleBox.min.y < maxGrassClearance) continue;
            }
            const s = window.grassSize * (0.65 + Math.random() * 0.7);
            const h = s * window.grassHeight * (0.8 + Math.random() * 0.5);
            // Sunk below the ground plane, PROPORTIONAL to this instance's
            // own height rather than a fixed amount. The polygon's base is
            // exactly at local y=0 and the UVs are a plain untouched 0..1
            // map - confirmed by rendering with alphaTest near 0, which
            // showed the blade content reaching the card's bottom edge with
            // no dead margin. The actual gap is alphaTest itself: it's
            // discarding a thin band of low-alpha (anti-aliased) pixels
            // right at the blade base, and how tall that discarded band is
            // IN WORLD UNITS scales with the instance's height - a fixed
            // sink compensated a short tuft fine but was far too small once
            // Grass Height could scale a tuft up to 3x. Sinking by a
            // fraction of h instead keeps the fix correct at any height.
            _grassPos.set(x, -h * window.grassBaseSink, z);
            _grassQuat.setFromAxisAngle(_upVec, Math.random() * Math.PI * 2);
            _grassScale.set(s, h, s);
            const bucket = (Math.abs(x) < shadowSafe && Math.abs(z) < shadowSafe) ? 'near' : 'far';
            perMat[placed % grassMats.length][bucket].push(
                new THREE.Matrix4().compose(_grassPos, _grassQuat, _grassScale));
            placed++;
        }
        perMat.forEach((buckets, i) => {
            ['near', 'far'].forEach(key => {
                const mats = buckets[key];
                if (!mats.length) return;
                const inst = new THREE.InstancedMesh(grassCrossGeo, grassMats[i], mats.length);
                mats.forEach((m, k) => inst.setMatrixAt(k, m));
                inst.instanceMatrix.needsUpdate = true;
                // Doesn't CAST shadows (1600+ crossed quads shadowing each
                // other/the ground would be expensive for very little payoff,
                // and self-shadowing thin cutout cards tends to look noisy).
                //
                // RECEIVES shadows only in the 'near' bucket - instances
                // inside the shadow camera's own frustum (see
                // SHADOW_CAMERA_HALF_EXTENT / shadowSafe above). Together
                // with the forced-up normal on the geometry, this is what
                // makes grass read as flat: normal-based directional shading
                // is already uniform everywhere, so the shadow map is the
                // only source of variation, exactly where an object - the
                // player, a block - actually blocks the light. The 'far'
                // bucket keeps receiveShadow off: outside the shadow camera's
                // box, sampling the shadow map reads past its own edge
                // (clamped/undefined depth), which showed up as random dark
                // speckling on ground nothing was actually shadowing -
                // confirmed by measuring a lit patch with zero occluders
                // above it and still finding dozens of falsely-dark pixels,
                // all outside this exact box.
                inst.castShadow = false;
                inst.receiveShadow = key === 'near';
                inst.raycast = () => {};                  // never answer a world probe
                inst.frustumCulled = false;               // instances span the whole field
                inst.userData.isGrass = true;
                scene.add(inst);
                grassMeshes.push(inst);
            });
        });
        buildGrassWireframe();
    }
    window.rebuildGrass = buildGrass;

    // ---- Grass wireframe helper (Editor Wireframe toggle) ----
    // Grass tufts don't go through the level editor's own per-mesh wireframe
    // path: they're InstancedMesh (one shared geometry, per-instance
    // transforms - EdgesGeometry on the raw geometry wouldn't reflect where
    // any individual tuft actually sits) and they're added straight to
    // `scene`, not under editTarget, which is the only subtree
    // LevelEditor.setWireframe() traverses. So this builds its own outline:
    // the quad-cross edges of every placed instance, transformed by that
    // instance's own matrix and merged into one LineSegments draw call.
    // Bright red specifically so it reads clearly against the toon-shaded
    // ground plane's own solid green (ground isn't under editTarget either,
    // so it stays solid even in wireframe mode - a deliberate, useful
    // reference surface to check tuft base height against).
    let grassWireMesh = null;
    const _gwA = new THREE.Vector3(), _gwB = new THREE.Vector3(), _gwC = new THREE.Vector3();
    function buildGrassWireframe() {
        if (grassWireMesh) { scene.remove(grassWireMesh); grassWireMesh.geometry.dispose(); grassWireMesh.material.dispose(); grassWireMesh = null; }
        if (!grassMeshes.length) return;
        const edgesLocal = new THREE.EdgesGeometry(grassCrossGeo, 1);
        const localPos = edgesLocal.attributes.position;
        const positions = [];
        const M = new THREE.Matrix4();
        grassMeshes.forEach(inst => {
            for (let i = 0; i < inst.count; i++) {
                inst.getMatrixAt(i, M);
                for (let v = 0; v < localPos.count; v++) {
                    _gwA.fromBufferAttribute(localPos, v).applyMatrix4(M);
                    positions.push(_gwA.x, _gwA.y, _gwA.z);
                }
            }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        grassWireMesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff0033, depthTest: true }));
        grassWireMesh.raycast = () => {};
        grassWireMesh.visible = !!(levelEditor && levelEditor.wireframeEnabled);
        scene.add(grassWireMesh);
    }

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

    // ---- Companion ----
    // HYBRID follower:
    //  - FOLLOW (manual): walks toward the player and stands near, distance-
    //    based so a pure turn doesn't swing it around, Y hugs the ground
    //    (falls to follow you down, small step-up for ramps). This is the
    //    normal "stay near me" behaviour.
    //  - CLIMB (breadcrumb REPLAY): we always record the player's pose+anim
    //    state into a trail; when the companion is stuck below a wall the
    //    player just climbed, it replays that recorded climb segment - your
    //    real ledge motion, frame-for-frame - to get up the same wall. No
    //    geometry AI, no flying. And it won't top out while the player is
    //    standing on the exact spot it would emerge (waits until you move).
    let companion = null;
    const COMP_FOLLOW_DIST = 1.8;   // manual-follow stand-off distance
    const COMP_TRAIL_KEEP = 15.0;   // seconds of trail kept - long enough that after a
                                    // fall the companion can walk back and re-replay the
                                    // same recorded climb instead of being stuck below
    const _compTrail = [];          // {t,x,y,z,qx,qy,qz,qw,state}
    let _compTrailT = 0;
    let _compMode = 'follow';       // 'follow' | 'replay'
    let _replayStartT = 0, _replayT = 0;
    const _compFaceEuler = new THREE.Euler();
    const _compFaceQuat = new THREE.Quaternion();
    const _compGroundOrigin = new THREE.Vector3();
    const _compGroundList = [];
    const _compVisPos = new THREE.Vector3();   // player's VISUAL (fbxModel) world pos
    window.companionEnabled = false;   // off by default - added from the panel ('Companion' → Add Companion)
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
        if (groundHits.length > 0) {
            // A short thrown carryable (a box, jar, ...) landing directly in
            // the bot's path is too low for the horizontal avoidance rays
            // above (cast at pos.y+0.5) to see as something to steer around,
            // but this ground-snap has no height filter at all - it happily
            // climbed the bot straight up onto anything sitting underfoot,
            // reading as the bot casually stepping onto a box that just
            // landed near it. Capping how far it can snap UP per step (same
            // idea as a normal stair step, not a real climb) makes it just
            // push against a low obstacle like that instead of mounting it;
            // stepping DOWN (a ledge, stairs going down) stays uncapped.
            const AI_MAX_STEP_UP = 0.4;
            const newY = groundHits[0].point.y;
            if (newY - pos.y <= AI_MAX_STEP_UP) nextPos.y = newY;
        }

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

    function spawnCompanion() {
        if (companion) return;
        companion = new RemoteAvatar(scene, threeTone, 'companion');
        window.companion = companion;
        companion.group.position.copy(char.group.position);
    }

    // Highest solid surface under (x,z) (falls back to fallbackY on a miss).
    // Casts against _compGroundList, rebuilt once per updateCompanion frame.
    function companionGroundY(x, z, fallbackY) {
        _compGroundOrigin.set(x, Math.max(fallbackY, char.group.position.y) + 3.0, z);
        rayDown.set(_compGroundOrigin, _downVec);
        const hits = rayDown.intersectObjects(_compGroundList, true);
        return hits.length ? hits[0].point.y : fallbackY;
    }

    function updateCompanion(delta) {
        if (!window.companionEnabled) { if (companion) companion.group.visible = false; return; }
        if (!companion) spawnCompanion();
        if (!companion) return;
        if (!companion.isLoaded) { companion.update(delta); return; }
        companion.group.visible = true;
        if (companion.isRagdoll || companion.isStandingUp) { companion.update(delta); return; }

        // Ground-cast list for this frame's rays.
        _compGroundList.length = 0;
        for (let i = 0; i < collidables.length; i++) _compGroundList.push(collidables[i]);
        _compGroundList.push(ground);

        // Always record the player's pose + anim state into the trail. Use the
        // player's VISUAL position (fbxModel world pos), not the raw group: at
        // the climb-end the group SNAPS to ledgeTarget while the model is
        // offset back to hide it (see the isClimbingUp transition) - recording
        // the compensated visual means the companion replays that SMOOTH climb-
        // out instead of the raw root snap (the extra pop it used to show).
        const p = char.group.position, q = char.group.quaternion;
        const c = companion.group.position;
        if (char.fbxModel) char.fbxModel.getWorldPosition(_compVisPos); else _compVisPos.copy(p);
        _compTrailT += delta;
        const last = _compTrail.length ? _compTrail[_compTrail.length - 1] : null;
        if (last && Math.hypot(_compVisPos.x - last.x, _compVisPos.y - last.y, _compVisPos.z - last.z) > 5) _compTrail.length = 0; // teleport → reset
        _compTrail.push({ t: _compTrailT, x: _compVisPos.x, y: _compVisPos.y, z: _compVisPos.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, state: networkStateName });
        while (_compTrail.length > 2 && (_compTrailT - _compTrail[0].t) > COMP_TRAIL_KEEP) _compTrail.shift();

        const gy = companionGroundY(c.x, c.z, c.y);
        const playerElevated = isGrounded && !isLedgeGrabbing && !isClimbingUp && (p.y - gy) > 1.0;

        // ---- CLIMB (breadcrumb replay) ----
        if (_compMode === 'replay') {
            _replayT += delta;
            const endCr = _compTrail[_compTrail.length - 1];
            const wantT = _replayStartT + _replayT;
            let cr = endCr;
            for (let i = 0; i < _compTrail.length; i++) { if (_compTrail[i].t >= wantT) { cr = _compTrail[i]; break; } }
            // Wait (hang) if we'd top out onto the exact spot the player stands.
            const blocked = cr.y >= p.y - 0.6 && Math.hypot(cr.x - p.x, cr.z - p.z) < 0.9;
            if (blocked) {
                _replayT -= delta;
                let hangCr = cr;
                for (let i = 0; i < _compTrail.length; i++) { if (_compTrail[i].t <= wantT && _compTrail[i].y <= p.y - 1.2) hangCr = _compTrail[i]; }
                companion.group.position.set(hangCr.x, hangCr.y, hangCr.z);
                companion.group.quaternion.set(hangCr.qx, hangCr.qy, hangCr.qz, hangCr.qw);
                companion.setNetworkState([hangCr.x, hangCr.y, hangCr.z], [hangCr.qx, hangCr.qy, hangCr.qz, hangCr.qw], 'hang_idle', false);
                companion.update(delta);
                return;
            }
            // Pure replay of the recorded climb - exact pose + state.
            companion.group.position.set(cr.x, cr.y, cr.z);
            companion.group.quaternion.set(cr.qx, cr.qy, cr.qz, cr.qw);
            companion.setNetworkState([cr.x, cr.y, cr.z], [cr.qx, cr.qy, cr.qz, cr.qw], cr.state, false);
            companion.update(delta);
            if (cr.y >= p.y - 0.4 || wantT >= endCr.t) _compMode = 'follow';
            return;
        }

        // Below a wall the player just climbed: walk precisely to the takeoff
        // spot (nearest trail crumb at our own height), then replay the recorded
        // climb from there. If no such crumb exists (player didn't actually
        // climb here), fall through to normal follow and just wait below.
        if (playerElevated && (p.y - c.y) > 1.0) {
            let bi = -1, bd = Infinity;
            for (let i = 0; i < _compTrail.length; i++) {
                const cr = _compTrail[i];
                if (Math.abs(cr.y - c.y) > 0.8) continue;          // only crumbs at our (base) height
                const d = (cr.x - c.x) * (cr.x - c.x) + (cr.z - c.z) * (cr.z - c.z);
                if (d < bd) { bd = d; bi = i; }
            }
            if (bi >= 0) {
                const tk = _compTrail[bi];
                const dTk = Math.hypot(tk.x - c.x, tk.z - c.z);
                if (dTk < 0.55) { _compMode = 'replay'; _replayStartT = tk.t; _replayT = 0; return; }
                // Walk to the takeoff spot.
                const s = Math.min(dTk, 7.5 * delta);
                const nx = c.x + (tk.x - c.x) / dTk * s, nz = c.z + (tk.z - c.z) / dTk * s;
                const gyH = companionGroundY(nx, nz, c.y);
                let ny = c.y; const dyy = gyH - c.y;
                if (dyy < -0.05) ny += Math.max(dyy, -16 * delta); else if (dyy > 0.05 && dyy < 0.9) ny += Math.min(dyy, 6 * delta);
                _compFaceEuler.set(0, Math.atan2(tk.x - c.x, tk.z - c.z), 0);
                _compFaceQuat.setFromEuler(_compFaceEuler);
                const mv = Math.hypot(nx - c.x, nz - c.z) / Math.max(delta, 1e-3);
                companion.group.position.set(nx, ny, nz);
                companion.setNetworkState([nx, ny, nz], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], mv > 3.5 ? 'run' : (mv > 0.4 ? 'walk' : 'idle'), false);
                companion.update(delta);
                return;
            }
        }

        // ---- FOLLOW (manual, distance-based) ----
        let dirx = c.x - p.x, dirz = c.z - p.z; let len = Math.hypot(dirx, dirz);
        if (len < 0.001) { dirx = 0; dirz = 1; len = 1; }
        dirx /= len; dirz /= len;
        let tgx = p.x + dirx * COMP_FOLLOW_DIST, tgz = p.z + dirz * COMP_FOLLOW_DIST;
        if (playerElevated && (p.y - c.y) < 1.0) { tgx = p.x + dirx * 0.9; tgz = p.z + dirz * 0.9; } // up on the block: hug close
        const toX = tgx - c.x, toZ = tgz - c.z; const h = Math.hypot(toX, toZ);
        let nx = c.x, nz = c.z;
        if (h > 1e-4) { const s = Math.min(h, 7.5 * delta); nx += (toX / h) * s; nz += (toZ / h) * s; }
        const gyHere = companionGroundY(nx, nz, c.y);
        let ny = c.y; const dy = gyHere - c.y;
        if (dy < -0.05) ny += Math.max(dy, -16 * delta);            // fall to follow down
        else if (dy > 0.05 && dy < 0.9) ny += Math.min(dy, 6 * delta); // small step up (ramps); taller = replay's job
        _compFaceEuler.set(0, Math.atan2(p.x - c.x, p.z - c.z), 0);
        _compFaceQuat.setFromEuler(_compFaceEuler);
        const movedH = Math.hypot(nx - c.x, nz - c.z) / Math.max(delta, 1e-3);
        const st = movedH > 3.5 ? 'run' : (movedH > 0.4 ? 'walk' : 'idle');
        companion.group.position.set(nx, ny, nz);
        companion.setNetworkState([nx, ny, nz], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], st, false);
        companion.update(delta);
    }

    const aiBotSpawnBtn = document.getElementById('ai-bot-spawn-btn');
    const aiBotDespawnBtn = document.getElementById('ai-bot-despawn-btn');
    if (aiBotSpawnBtn) aiBotSpawnBtn.addEventListener('pointerdown', spawnAiBot);
    if (aiBotDespawnBtn) aiBotDespawnBtn.addEventListener('pointerdown', despawnAiBot);

    // Companion: off by default, added from the panel. updateCompanion spawns
    // it lazily on the first enabled frame and just hides it when disabled.
    const toggleCompanionEl = document.getElementById('toggle-companion');
    if (toggleCompanionEl) {
        toggleCompanionEl.checked = window.companionEnabled;
        toggleCompanionEl.addEventListener('change', e => { window.companionEnabled = e.target.checked; });
    }

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

            // Used to call the full buildLevel() here whenever this (slow-
            // to-fetch) FBX finished loading after the level had already
            // been built once - but a full rebuild while the player might
            // already be mid-climb/mid-carry (or just mid-load of another
            // async prop like Cubes.glb) resets collidables/carryables out
            // from under them, and can silently wipe out anything another
            // in-flight async loader was about to add. If the level's
            // already up, just add the jar grid on top of it instead - same
            // fix already applied to the StarKey.glb loader below.
            if (currentLevel === "local_stairs" && stairsLevelBuilt) { spawnJarGrid(); spawnStairJar(); }
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
    // Blender's glTF export splits a mesh into one child primitive per
    // material slot as soon as it has more than one material, wrapping
    // those primitives in a Group that keeps the ORIGINAL node's name -
    // that's what happened to LockBase (it picked up a second material at
    // some point) - so a part that used to come back from traverse() as a
    // single named Mesh can just as easily come back as a same-named Group
    // of anonymous sub-meshes instead. Flattens it back into one Mesh
    // (multi-material via geometry groups) so cloneMeshClean/safeWorldBox/
    // buildStarAssembly and the collision code's `.parent.userData.isLock`
    // check all keep working unchanged regardless of which shape the
    // export produced.
    function flattenMultiMaterialNode(node) {
        if (!node || node.isMesh) return node;
        const meshes = node.children.filter(c => c.isMesh);
        if (meshes.length === 0) return node;
        const merged = BufferGeometryUtils.mergeGeometries(meshes.map(m => m.geometry), true);
        const flat = new THREE.Mesh(merged, meshes.map(m => m.material));
        flat.name = node.name;
        flat.position.copy(node.position);
        flat.quaternion.copy(node.quaternion);
        flat.scale.copy(node.scale);
        return flat;
    }
    const gltfLoader = new GLTFLoader();
    gltfLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/Interactables/StarKey.glb', (gltf) => {
        const object = gltf.scene;
        let keyBase = null, keyStarContainer = null, star = null, lockBase = null, lockStarContainer = null;
        object.traverse((child) => {
            // Matches by name only (not isMesh) - see flattenMultiMaterialNode
            // above for why a target part might arrive as a Group instead.
            if (child.name === 'KeyBase') keyBase = child;
            else if (child.name === 'KeyStarContainer') keyStarContainer = child;
            else if (child.name === 'Star') star = child;
            else if (child.name === 'LockBase') lockBase = child;
            else if (child.name === 'LockStarContainer') lockStarContainer = child;
        });
        keyBase = flattenMultiMaterialNode(keyBase);
        keyStarContainer = flattenMultiMaterialNode(keyStarContainer);
        star = flattenMultiMaterialNode(star);
        lockBase = flattenMultiMaterialNode(lockBase);
        lockStarContainer = flattenMultiMaterialNode(lockStarContainer);
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
        if (pendingWaterLevelBuild) { pendingWaterLevelBuild = false; buildWaterTestLevel(); }
    };
    levelGlbLoader.load('LevelModel/Level.glb', onLevelGlbLoaded, undefined, () => {
        levelGlbLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/LevelModel/Level.glb',
            onLevelGlbLoaded, undefined, (e) => console.error('Level.glb load failed:', e));
    });

    // Village level (buildVillageLevel) - same "single authored whitebox
    // model" pattern as Level.glb above. Original source lives at
    // Levels/Proxy/Village.glb (outside this folder, so the dev server
    // can't reach it directly) - copied into VillageModel/ alongside this
    // file, the same way LevelModel/Level.glb is a local copy kept next to
    // the FBX clips. No Draco compression on this one (checked the raw
    // glb JSON chunk - only KHR_materials_specular/unlit), so a plain
    // GLTFLoader is enough, no DRACOLoader needed.
    let villageScene = null;
    let pendingVillageLevelBuild = false;
    const villageLoader = new GLTFLoader();
    const onVillageLoaded = (gltf) => {
        villageScene = gltf.scene;
        if (pendingVillageLevelBuild) { pendingVillageLevelBuild = false; buildVillageLevel(); }
    };
    villageLoader.load('VillageModel/Village.glb', onVillageLoaded, undefined, () => {
        villageLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/VillageModel/Village.glb',
            onVillageLoaded, undefined, (e) => console.error('Village.glb load failed:', e));
    });

    function spawnTestKeyAndLock() {
        // The free-standing key that used to sit out in the open here (no
        // jar needed) was removed - the jar grid's own key (see
        // spawnJarGrid, containsKey on the r===0,c===0 jar) is now the only
        // way to get one.

        // Test-only lock instance - fixed in place (not
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
            // Marks this group (checked via a hit mesh's .parent, since the
            // raycasts below hit baseClone/containerClone directly, not the
            // group) so the ground-follow and wall-stop code can recognize
            // it and, once userData.keyInserted flips true in
            // triggerKeyInsertion, treat it like a climbable ramp/hemisphere
            // instead of a solid wall - see isOnActiveLock below.
            testLockGroup.userData.isLock = true;
            levelGroup.add(testLockGroup);
            collidables.push(testLockGroup);
            activeLockInstances.push(testLockGroup);
            window.debugTestLockGroup = testLockGroup; // L key triggers revealLockStar() on this, see keydown handler

            // Sphere = how close a thrown/carried key actually has to get
            // for it to insert (see KEY_INSERT_DISTANCE) - not a physical
            // collider at all, just a "close enough" proximity check.
            //
            // The lock's actual collision was never this capsule - it's the
            // real computed AABB getObstacleBox falls back to for anything
            // that isn't isCarryable/isMovable, which the lock is neither.
            // The capsule was purely a visual approximation of that box's
            // size for the "Show Hitboxes" debug view; removed since it was
            // being read as the real collider (it wasn't) rather than as a
            // rough visual stand-in for one.
            addWireframeSphereDebugHelper(testLockGroup.position, KEY_INSERT_DISTANCE);

            // Companion box, flush against the lock's -x side (the side the
            // jump-height test rig/tall blue boxes sit on, see
            // buildStairsLevel) - matches the lock's own width/depth but
            // only 2/5 (shortened by 3/5) of its height, rounded like the
            // other blue boxes instead of sharp-cornered.
            testLockGroup.updateMatrixWorld(true);
            const lockBox = new THREE.Box3().setFromObject(testLockGroup);
            const lockSize = lockBox.getSize(new THREE.Vector3());
            const companionHeight = lockSize.y * 0.4;
            const lockCompanionBox = new THREE.Mesh(new RoundedBoxGeometry(lockSize.x, companionHeight, lockSize.z, 1, 0.15), platMat);
            lockCompanionBox.position.set(lockBox.min.x - lockSize.x / 2, companionHeight / 2, testLockGroup.position.z);
            lockCompanionBox.castShadow = true; lockCompanionBox.receiveShadow = true;
            levelGroup.add(lockCompanionBox); collidables.push(lockCompanionBox);
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

    // Water Test level (see WaterTestAssets/README.md): land/rocks are
    // borrowed as-is from the tympanus/codrops "stylized water" tutorial
    // repo (github.com/thaslle/stylized-water, MIT) rather than reusing
    // Level 2's own Level.glb - that repo is also where the shader math
    // below is ported from line-for-line (their CustomShaderMaterial +
    // React Three Fiber setup translated to a plain THREE.ShaderMaterial,
    // since this project has no build step to pull in that library).
    // uTime is pushed from animate()'s clock.elapsedTime - NOT the raw
    // Date.now()-based `time` var used elsewhere in this file (a ~1.7e9
    // epoch value): feeding a number that large into per-fragment UV math
    // blows past float32 precision at that magnitude, quantizing every
    // fragment to the same noise lattice cell and rendering as a flat,
    // pattern-less plane (this exact bug was hit and fixed while building
    // this level - the source repo itself uses clock.getElapsedTime(),
    // confirming small-time is the correct convention here).
    let waterTerrainScene = null;
    let waterRocksScene = null;
    let pendingWaterLevelBuild = false;
    let waterTestTerrainMaterial = null;
    let waterTestRocksMaterial = null;
    let pondWaterBody = null;
    // Same defaults as the source repo's useStore.js.
    // Amplitude is the one knob that decides how visible the water's rise
    // and fall is - the source's own 0.1 is nearly imperceptible at this
    // game's scale (it was tuned for a much closer camera), and since the
    // bob is global the foam band tracks it exactly, so raising it moves
    // the whole waterline in and out like a tide rather than desyncing
    // anything. Raise/lower this single value to taste.
    const WATER_TEST_LEVEL = 0.9, WATER_TEST_WAVE_SPEED = 1.2, WATER_TEST_WAVE_AMPLITUDE = 0.3, WATER_TEST_FOAM_DEPTH = 0.08;

    // A "water body" bundles a stylized water plane material with the
    // uniforms shoreline-foam objects near it should read - one WATER
    // HEIGHT can't be a single scene-wide value once a level has more than
    // one water surface (a main sea plus an elevated pond, say): each
    // needs its own uWaterLevel, so each gets its own uniforms object
    // instead of every foam-enabled material sharing one global. All
    // bodies still get their uTime ticked together in animate().
    const waterBodies = [];
    function createWaterBody(opts) {
        const uniforms = {
            uTime: { value: 0 },
            uWaterLevel: { value: opts.waterLevel },
            uWaveSpeed: { value: opts.waveSpeed },
            uWaveAmplitude: { value: opts.waveAmplitude },
            uFoamDepth: { value: opts.foamDepth },
            // The character's own body material gets applyShorelineFoam
            // once and keeps it forever (materials aren't rebuilt per-level
            // like terrain/rocks/props are) - this lets a level that isn't
            // near this body's water gate it off, where the character's Y
            // can just as easily cross uWaterLevel while walking around dry
            // land, which would otherwise paint a nonsense white band.
            uFoamEnabled: { value: opts.foamEnabled !== undefined ? opts.foamEnabled : 1 },
        };
        const waterMaterial = createStylizedWaterMaterial(
            // 45 in the source; raised so the surface reads as fewer, larger
            // blobs instead of a busy fine mesh of squiggles. Counter-
            // intuitive direction: the shader uses `100.0 - uTextureSize` as
            // the noise frequency, so a BIGGER number here means a LOWER
            // frequency, i.e. bigger and sparser features.
            opts.waveSpeed, opts.waveAmplitude, opts.textureSize ?? 68,
            opts.colorNear ?? 0x00fccd, opts.colorFar ?? 0x1ceeff);
        // Re-point the water surface's own uniform objects at the ones
        // above so the two share state BY REFERENCE. Without this they are
        // two independent sets: animate() only ticks `uniforms` (the foam
        // side), leaving the water material's uTime frozen at 0 forever -
        // sin(0) is 0, so the surface neither bobbed nor scrolled its noise
        // while the foam animated perfectly. That mismatch is exactly the
        // "foam moves but the water mesh is static" bug. Sharing them also
        // makes it impossible for the surface and its foam to drift apart
        // if speed/amplitude are ever retuned.
        waterMaterial.uniforms.uTime = uniforms.uTime;
        waterMaterial.uniforms.uWaveSpeed = uniforms.uWaveSpeed;
        waterMaterial.uniforms.uWaveAmplitude = uniforms.uWaveAmplitude;
        const body = { uniforms, waterMaterial };
        waterBodies.push(body);
        return body;
    }
    // Pairs a water PLANE MESH with the water body it should keep in sync -
    // read fresh every frame in animate(), so dragging the mesh with the
    // level editor's gizmo (or any future gameplay code that animates
    // water.position.y, e.g. a rising-tide effect) moves the foam band
    // immediately, with no manual "re-set uWaterLevel" step and no reload.
    // Cleared at the top of buildLevel() (with collidables/carryables/etc)
    // and re-populated by whichever level rebuilds after - a mesh that's
    // recreated every rebuild (the Water Test level's sea/pond) would
    // otherwise pile up stale entries pointing at removed objects.
    const waterMeshSyncs = [];
    function linkWaterMeshToBody(mesh, waterBody) {
        waterMeshSyncs.push({ mesh, waterBody });
    }
    // ---- Shoreline foam: which water body applies is decided PER FRAGMENT ----
    // Every water body's state is uploaded as parallel arrays and the
    // fragment shader picks the one whose footprint the fragment actually
    // sits in. Binding each material to one body at creation time (what
    // this used to do) meant an object could never change allegiance: carry
    // a rock from the sea into the elevated pond and it kept testing itself
    // against the sea's height, so it simply stopped foaming. Only the
    // player worked, because it alone had a JS "nearest body" search - which
    // this replaces, since doing it per fragment covers the player, props,
    // level geometry and anything the editor adds, with no bookkeeping.
    const MAX_WATER_BODIES = 4;
    const foamSharedUniforms = {
        uFoamTime: { value: 0 },
        uFoamCount: { value: 0 },
        uFoamGlobalScale: { value: 1 },
        uFoamLevel: { value: new Array(MAX_WATER_BODIES).fill(0) },
        uFoamSpeed: { value: new Array(MAX_WATER_BODIES).fill(0) },
        uFoamAmp: { value: new Array(MAX_WATER_BODIES).fill(0) },
        uFoamBand: { value: new Array(MAX_WATER_BODIES).fill(0) },
        uFoamOn: { value: new Array(MAX_WATER_BODIES).fill(0) },
        uFoamMin: { value: Array.from({ length: MAX_WATER_BODIES }, () => new THREE.Vector2()) },
        uFoamMax: { value: Array.from({ length: MAX_WATER_BODIES }, () => new THREE.Vector2()) },
    };
    // Live-tunable globals (see the Water sliders in the debug panel).
    // foamDepthScale multiplies the band on EVERYTHING; charFoamScale is an
    // extra multiplier for the player only, because the band is sized in
    // world units and so reads far heavier on a ~1.7-unit character than on
    // a 9-unit level wall.
    window.foamDepthScale = 0.3;
    window.charFoamScale = 1.0;
    // Per-material thickness uniforms that should follow a window global
    // live (currently just the player's, via charFoamScale).
    const foamObjScaleUniforms = [];
    // Same idea for the water SURFACE's own pattern layer (see
    // createStylizedWaterMaterial) - Scale multiplies its frequency
    // (bigger = bigger/sparser features), Opacity is how strongly it
    // blends into color/alpha. Copied into every water body's material
    // every frame in animate(), so these sliders retune every water
    // surface in the level at once, live.
    //
    // There used to be a second "blob" pattern layer underneath these
    // lines (Pattern Size/Opacity/Speed uniforms) - removed outright, not
    // just defaulted off, since the user settled on opacity 0 for it and
    // asked for it gone entirely rather than kept as a dead/no-op knob.
    window.waterLinesScale = 0.50;
    window.waterLinesOpacity = 0.36;
    // Internal noise-scroll speed and thickness for the line layer - see
    // the uniforms of the same name for what they do.
    window.waterLinesSpeed = 0.25;
    window.waterLinesThickness = 0.10;
    // Generic version of the terrain/rocks foam trick (see the two
    // hand-written ShaderMaterials below) for ANY existing material -
    // boxes, props, whatever the level editor adds - via onBeforeCompile,
    // so the object keeps its own texture/color/lighting and just gets the
    // white waterline band mixed into its final output. Cheap: no extra
    // render pass, just a few ALU ops per fragment, and it already works
    // for moving objects for free since it re-reads the object's current
    // world Y against the animated water height every frame.
    //
    // opts.objScale is a per-material thickness multiplier (the player
    // passes a smaller one). WHICH water body applies is no longer chosen
    // here at all - see foamSharedUniforms.
    function applyShorelineFoam(material, opts) {
        if (!material || material.userData.hasShorelineFoam) return;
        material.userData.hasShorelineFoam = true;
        // Kept as a live uniform object rather than baked into the shader
        // at compile time, so the debug-panel slider can retune it without
        // a level rebuild (see foamObjScaleUniforms).
        const objScaleUniform = { value: (opts && opts.objScale !== undefined) ? opts.objScale : 1.0 };
        if (opts && opts.trackGlobal) foamObjScaleUniforms.push({ uniform: objScaleUniform, key: opts.trackGlobal });
        // Chain rather than clobber: the character's own body material
        // already carries an onBeforeCompile (the rim-light effect set up
        // in ClimbGame.html) - overwriting it outright would silently kill
        // rim lighting. Every handler here (rim, this one) uses the
        // "replace <chunk> with <chunk>+ownCode" pattern, which re-inserts
        // the same literal #include token as part of its own replacement -
        // so calling the previous handler first and then still doing our
        // own .replace() calls on the result keeps finding that token and
        // stacks correctly regardless of how many handlers are chained.
        const previousOnBeforeCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (previousOnBeforeCompile) previousOnBeforeCompile(shader, renderer);
            Object.assign(shader.uniforms, foamSharedUniforms);
            shader.uniforms.uFoamObjScale = objScaleUniform;
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec3 vFoamPositionW;\nvarying vec3 vFoamNormalW;')
                // World normal, used below to keep the band a similar
                // apparent thickness on any surface angle.
                .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nvFoamNormalW = normalize(mat3(modelMatrix) * objectNormal);')
                // Anchored on <skinning_vertex> (which runs unconditionally
                // in every material's template, skinned or not - it's a
                // no-op under the hood when there's no skeleton) and reads
                // `transformed`, NOT <begin_vertex>/`position`: for a
                // skinned mesh (the player character), `position` at
                // <begin_vertex> is still the bind-pose vertex - anchoring
                // there would compute a world position that ignores the
                // current animation pose entirely, so the foam band would
                // sit wherever the character's T-pose feet happen to be,
                // not its actual animated feet.
                .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvFoamPositionW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
                    varying vec3 vFoamPositionW;
                    varying vec3 vFoamNormalW;
                    uniform float uFoamTime, uFoamCount, uFoamGlobalScale, uFoamObjScale;
                    uniform float uFoamLevel[${MAX_WATER_BODIES}];
                    uniform float uFoamSpeed[${MAX_WATER_BODIES}];
                    uniform float uFoamAmp[${MAX_WATER_BODIES}];
                    uniform float uFoamBand[${MAX_WATER_BODIES}];
                    uniform float uFoamOn[${MAX_WATER_BODIES}];
                    uniform vec2 uFoamMin[${MAX_WATER_BODIES}];
                    uniform vec2 uFoamMax[${MAX_WATER_BODIES}];`)
                .replace('#include <dithering_fragment>', `
                    // Pick the water body this fragment belongs to: the one
                    // whose XZ footprint it is inside (or nearest to), ties
                    // broken toward the SMALLER footprint so a pond sitting
                    // on top of the sea's huge plane wins over it.
                    float fFoamBestDist = 1e9;
                    float fFoamBestArea = 1e9;
                    float fFoamLevel = 0.0, fFoamSpeed = 0.0, fFoamAmp = 0.0, fFoamBand = 0.0, fFoamOn = 0.0;
                    for (int i = 0; i < ${MAX_WATER_BODIES}; i++) {
                        if (float(i) >= uFoamCount) continue;
                        if (uFoamOn[i] < 0.5) continue;
                        vec2 mn = uFoamMin[i];
                        vec2 mx = uFoamMax[i];
                        float dxx = max(max(mn.x - vFoamPositionW.x, vFoamPositionW.x - mx.x), 0.0);
                        float dzz = max(max(mn.y - vFoamPositionW.z, vFoamPositionW.z - mx.y), 0.0);
                        float dd = dxx * dxx + dzz * dzz;
                        float aa = (mx.x - mn.x) * (mx.y - mn.y);
                        if (dd < fFoamBestDist - 1e-4 || (abs(dd - fFoamBestDist) <= 1e-4 && aa < fFoamBestArea)) {
                            fFoamBestDist = dd; fFoamBestArea = aa;
                            fFoamLevel = uFoamLevel[i]; fFoamSpeed = uFoamSpeed[i];
                            fFoamAmp = uFoamAmp[i]; fFoamBand = uFoamBand[i]; fFoamOn = 1.0;
                        }
                    }
                    // A clean 0..1 band mask (NOT the terrain/rocks shaders'
                    // ported formula, which relied on smoothstep with
                    // edge0>edge1 - an "overshoot" trick that reads as white
                    // for saturated colors like their sand orange but barely
                    // shows on a dark base color). Needs to work for
                    // whatever arbitrary color an editor-added object has,
                    // so: a straightforward mix to pure white, no overshoot.
                    float shorelineSineOffset = sin(uFoamTime * fFoamSpeed) * fFoamAmp;
                    float shorelineWaterHeight = fFoamLevel + shorelineSineOffset;
                    // The band is a VERTICAL extent, so how wide it looks
                    // depends entirely on the surface angle: on the gently
                    // sloped test island it spreads into a fat ring, but on
                    // a vertical wall (Level 2 is all box-sided platforms,
                    // as is most of this game) the very same number is a
                    // hairline you cannot see. Dividing by the surface's
                    // verticality keeps the apparent width roughly constant;
                    // clamped so a perfectly vertical face widens by 4x
                    // rather than infinitely.
                    float shorelineFacing = max(abs(vFoamNormalW.y), 0.25);
                    float shorelineDepth = fFoamBand * uFoamObjScale * uFoamGlobalScale / shorelineFacing;
                    float shorelineAbove = smoothstep(shorelineWaterHeight - 0.01, shorelineWaterHeight + 0.01, vFoamPositionW.y);
                    float shorelineAboveBand = smoothstep(shorelineWaterHeight + shorelineDepth - 0.01, shorelineWaterHeight + shorelineDepth + 0.01, vFoamPositionW.y);
                    float shorelineMask = (shorelineAbove - shorelineAboveBand) * fFoamOn;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), shorelineMask);
                    #include <dithering_fragment>`);
        };
        // Distinguishes this material's compiled program from an otherwise-
        // identical material without the injection above - onBeforeCompile
        // closures aren't part of three.js's default cache key, so without
        // this two materials could wrongly share one compiled program.
        // Every material already inherits a default customProgramCacheKey
        // from THREE.Material.prototype (it's never actually undefined) -
        // call it bound to `material`, since the default implementation
        // reads `this.onBeforeCompile` internally and loses that `this` if
        // invoked as a bare function reference.
        const previousCacheKey = material.customProgramCacheKey;
        material.customProgramCacheKey = () => (previousCacheKey ? previousCacheKey.call(material) : '') + '|shorelineFoam';
        material.needsUpdate = true;
    }
    // terrain.glb/rocks.glb come out of the source repo's Vite build
    // Draco-compressed - a plain GLTFLoader errors on them without this.
    const waterDracoLoader = new DRACOLoader();
    waterDracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
    const waterAssetLoader = new GLTFLoader();
    waterAssetLoader.setDRACOLoader(waterDracoLoader);
    function tryBuildWaterTestLevel() {
        if (pendingWaterLevelBuild && waterTerrainScene && waterRocksScene) {
            pendingWaterLevelBuild = false;
            buildWaterTestLevel();
        }
    }
    waterAssetLoader.load('WaterTestAssets/terrain.glb',
        (gltf) => { waterTerrainScene = gltf.scene; tryBuildWaterTestLevel(); },
        undefined, (e) => console.error('terrain.glb load failed:', e));
    waterAssetLoader.load('WaterTestAssets/rocks.glb',
        (gltf) => { waterRocksScene = gltf.scene; tryBuildWaterTestLevel(); },
        undefined, (e) => console.error('rocks.glb load failed:', e));

    // Same simplex noise used by the water/foam shaders below - the
    // Ashima/webgl-noise "snoise" 2D implementation, unchanged from the
    // source repo's copy of it.
    const SNOISE_GLSL = `
        vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
        vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
        float snoise(vec2 v){
            const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                                -0.577350269189626, 0.024390243902439);
            vec2 i  = floor(v + dot(v, C.yy));
            vec2 x0 = v - i + dot(i, C.xx);
            vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            vec4 x12 = x0.xyxy + C.xxzz;
            x12.xy -= i1;
            i = mod289(i);
            vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                    + i.x + vec3(0.0, i1.x, 1.0));
            vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
            m = m*m; m = m*m;
            vec3 x = 2.0 * fract(p * C.www) - 1.0;
            vec3 h = abs(x) - 0.5;
            vec3 ox = floor(x + 0.5);
            vec3 a0 = x - ox;
            m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
            vec3 g;
            g.x = a0.x * x0.x + h.x * x0.y;
            g.yz = a0.yz * x12.xz + h.yz * x12.yw;
            return 130.0 * dot(m, g);
        }
    `;

    // Direct port of src/components/Water/shaders/{vertex,fragment}.glsl
    // from the source repo. Their version runs through CustomShaderMaterial
    // on top of a lit MeshStandardMaterial (csm_FragColor starts as that
    // material's own lit "near" color); we have no lighting pipeline here,
    // so finalColor just starts as the flat uColorNear instead.
    // The bob here is deliberately GLOBAL (one offset for every vertex, no
    // position term) because it has to match the foam band's own formula
    // in applyShorelineFoam EXACTLY - that one is
    // `sin(uTime*uWaveSpeed)*uWaveAmplitude` with no position term either.
    // A position-dependent traveling ripple was tried and reverted: it
    // desynced the two (the plane's average height stayed put while the
    // foam still rose and fell, so the surface read as static next to a
    // moving waterline), and it forced heavy plane subdivision to render
    // at all - which tanked performance badly, because these water planes
    // live in `collidables`, which is raycast several times per frame
    // (rayDown/rayFwd/xray) and up to ~12k times by buildGrass(). A global
    // bob needs no subdivision whatsoever: 2 triangles animate perfectly.
    function createStylizedWaterMaterial(waveSpeed, waveAmplitude, textureSize, colorNearHex, colorFarHex) {
        return new THREE.ShaderMaterial({
            transparent: true,
            side: THREE.DoubleSide,
            uniforms: {
                uTime: { value: 0 },
                uWaveSpeed: { value: waveSpeed },
                uWaveAmplitude: { value: waveAmplitude },
                uTextureSize: { value: textureSize },
                uColorNear: { value: new THREE.Color(colorNearHex) },
                uColorFar: { value: new THREE.Color(colorFarHex) },
                // Live-tunable from the debug panel (see the Water sliders
                // and the sync loop in animate()) - Scale is a multiplier
                // ON TOP of this body's own uTextureSize base frequency,
                // Opacity is how strongly this layer blends into the final
                // color/alpha.
                uLinesScale: { value: 1.0 },
                uLinesOpacity: { value: 0.6 },
                // Internal noise-scroll speed for the line layer (not
                // uWaveSpeed - that's the surface's own vertical bob, a
                // separate thing).
                uLinesSpeed: { value: 1.0 },
                // Widens the line layer's kept threshold band - bigger =
                // thicker lines. Past 1.0 it also starts punching gaps into
                // the line (see uLinesScale's fragment code) rather than
                // just getting fatter, since a real foam line breaks up
                // when it gets too thick instead of staying solid.
                uLinesThickness: { value: 1.0 },
            },
            vertexShader: `
                varying vec2 vUv;
                uniform float uTime;
                uniform float uWaveSpeed;
                uniform float uWaveAmplitude;
                void main() {
                    vUv = uv;
                    vec3 pos = position;
                    pos.z += sin(uTime * uWaveSpeed) * uWaveAmplitude;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vUv;
                uniform float uTime;
                uniform vec3 uColorNear;
                uniform vec3 uColorFar;
                uniform float uTextureSize;
                uniform float uLinesScale;
                uniform float uLinesOpacity;
                uniform float uLinesSpeed;
                uniform float uLinesThickness;

                ${SNOISE_GLSL}

                // One "squiggly line network" sample, from the ported
                // tutorial shader. Called TWICE in main() with a different
                // uv/freq/phase each time and screen-blended together -
                // trying to fake a tangled look by perturbing a SINGLE
                // pass's phase (an earlier attempt, since discarded) only
                // ever reads as that one pattern sliding around faster,
                // because at any instant it's still just one line network.
                // Two independent networks actually crossing each other is
                // what makes it read as interwoven.
                float lineNetwork(vec2 uv, float freq, float thickness, float threshold, float phaseA, float phaseB, float breakPhase) {
                    float noiseBase = snoise(uv * (freq * 2.8) + phaseA);
                    noiseBase = noiseBase * 0.5 + 0.5;
                    float lineFoam = step(0.5, smoothstep(0.08, 0.001, noiseBase));

                    float noiseWaves = snoise(uv * freq + phaseB);
                    noiseWaves = noiseWaves * 0.5 + 0.5;
                    // thickness widens the kept band around threshold,
                    // replacing the source's fixed hairline width (a
                    // symmetric smoothstep band instead of that formula's
                    // hardcoded asymmetric offsets).
                    float halfBand = 0.006 + 0.05 * thickness;
                    float lo = threshold - halfBand;
                    float hi = threshold + halfBand;
                    float waveEffect = smoothstep(lo - 0.006, lo, noiseWaves) - smoothstep(hi, hi + 0.006, noiseWaves);
                    waveEffect = clamp(waveEffect, 0.0, 1.0);

                    // Past thickness 1.0, punch gaps into the line instead
                    // of just getting fatter: a second, offset noise sample
                    // decides what survives, and the survival bar only
                    // rises once thickness pushes past 1.0, so
                    // default/thin lines stay solid and unaffected. Below
                    // that threshold step()'s cutoff is -1.0, which noise in
                    // [-1,1] always clears - the whole sample would be
                    // computed just to multiply by 1.0, so it's skipped
                    // outright.
                    if (thickness > 1.0) {
                        float breakNoise = snoise(uv * freq * 1.7 + breakPhase);
                        float breakCutoff = mix(-1.0, 0.5, clamp(thickness - 1.0, 0.0, 1.0));
                        waveEffect *= step(breakCutoff, breakNoise);
                    }

                    return min(waveEffect + lineFoam, 1.0);
                }

                void main() {
                    float baseFreq = 100.0 - uTextureSize;
                    // Both passes' internal noise animation runs off this,
                    // not raw uTime directly - see uLinesSpeed above.
                    float noiseTime = uTime * uLinesSpeed;
                    float linesFreq = baseFreq * uLinesScale;
                    // Shared gentle "breathing" of the kept threshold band,
                    // same for both passes.
                    float linesThreshold = 0.6 + 0.01 * sin(noiseTime * 2.0);

                    // Pass A: the original network, unrotated.
                    float linesPatternA = lineNetwork(
                        vUv, linesFreq, uLinesThickness, linesThreshold,
                        sin(noiseTime * 0.3), sin(noiseTime * -0.1), -noiseTime * 0.15);

                    // Pass B: a second, independent network - rotated (an
                    // arbitrary fixed angle, not a multiple of 90 degrees,
                    // so its lines aren't just parallel to pass A's) and at
                    // a different frequency/phase, so it actually crosses
                    // pass A instead of retracing it.
                    float rotAngle = 1.1;
                    mat2 rotB = mat2(cos(rotAngle), -sin(rotAngle), sin(rotAngle), cos(rotAngle));
                    vec2 uvB = rotB * vUv;
                    float linesPatternB = lineNetwork(
                        uvB, linesFreq * 1.4, uLinesThickness, linesThreshold,
                        sin(noiseTime * -0.22) + 4.2, sin(noiseTime * 0.17) + 7.7, noiseTime * 0.12 + 2.3);

                    // Screen-blend (not max/add-clamp) so wherever the two
                    // networks cross reads as brighter/more solid instead
                    // of just clipping - this is the actual "iç içe girme"
                    // (interweaving) look, not achievable from one pass.
                    float linesPattern = linesPatternA + linesPatternB - linesPatternA * linesPatternB;

                    float distFromCenter = length(vUv - 0.5);
                    vec3 baseColor = mix(uColorNear, uColorFar, smoothstep(0.0, 0.7, distFromCenter));
                    vec3 color = mix(baseColor, vec3(1.0), linesPattern * uLinesOpacity);

                    // "Shallow" (near) reads more see-through, "deep" (far)
                    // more solid - same distFromCenter already driving the
                    // near/far color mix above, so the two stay in sync.
                    // The line layer lighting up also nudges alpha up a
                    // bit, since foam/wave crests read as more solid in
                    // real water too. material.transparent is already on.
                    float depthAlpha = mix(0.45, 0.88, smoothstep(0.0, 0.7, distFromCenter));
                    float patternLift = linesPattern * uLinesOpacity;
                    float alpha = mix(depthAlpha, min(depthAlpha + 0.25, 1.0), patternLift);

                    gl_FragColor = vec4(color, alpha);
                }
            `,
        });
    }
    // The "current level's main water" body - what every existing call
    // site (character, Level.glb terrain, the Water Test level's own
    // terrain/props) points at unless a specific secondary water body
    // (e.g. an elevated pond) is passed to applyShorelineFoam explicitly.
    // Defined only now, not right after createWaterBody() above: it calls
    // createStylizedWaterMaterial(), which has to already exist by then -
    // this const's initializer runs immediately (unlike a function
    // declaration, which is hoisted), so placing it any earlier hits a
    // temporal-dead-zone ReferenceError on SNOISE_GLSL inside that function.
    const defaultWaterBody = createWaterBody({
        waterLevel: WATER_TEST_LEVEL, waveSpeed: WATER_TEST_WAVE_SPEED,
        waveAmplitude: WATER_TEST_WAVE_AMPLITUDE, foamDepth: WATER_TEST_FOAM_DEPTH, foamEnabled: 0,
    });

    function buildWaterTestLevel() {
        if (!waterTerrainScene || !waterRocksScene) { pendingWaterLevelBuild = true; return; }
        while (levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0;
        ground.visible = false;
        star.visible = false;
        // uWaterLevel itself is no longer set here - the water mesh below
        // gets linkWaterMeshToBody()'d, so animate() drives it every frame
        // from that mesh's own position.y instead (see waterMeshSyncs).
        defaultWaterBody.uniforms.uFoamEnabled.value = 1;

        const WATER_LEVEL = WATER_TEST_LEVEL;

        // The player's own body material gets its private charWaterUniforms
        // (see there for why - it wanders between the sea and the pond)
        // instead of the default per-object binding - applyShorelineFoam is
        // idempotent per-material, so this is a no-op on every rebuild
        // after the first.
        if (char.bodyMaterials) char.bodyMaterials.forEach(mat => applyShorelineFoam(mat, { objScale: window.charFoamScale, trackGlobal: 'charFoamScale' }));

        // Same MeshToonMaterial + threeTone cell-shading every other prop in
        // the game uses (not the bespoke height-tinted ShaderMaterial this
        // used to be) - applyShorelineFoam gives it the waterline band the
        // same way it does the demo box/player, which also means it's
        // wired to defaultWaterBody.uniforms BY REFERENCE, so it live-syncs
        // with the sea mesh's position exactly like they do (the bespoke
        // version's own copied-at-creation uWaterLevel never did).
        let terrainMesh = null;
        waterTerrainScene.traverse(o => { if (o.isMesh && !terrainMesh) terrainMesh = o; });
        if (terrainMesh) {
            if (!waterTestTerrainMaterial) {
                waterTestTerrainMaterial = new THREE.MeshToonMaterial({ color: 0xd9b26a, gradientMap: threeTone });
                applyShorelineFoam(waterTestTerrainMaterial);
            }
            const terrain = new THREE.Mesh(terrainMesh.geometry, waterTestTerrainMaterial);
            terrain.receiveShadow = true;
            levelGroup.add(terrain);
            collidables.push(terrain);
        }

        let rocksMesh = null;
        waterRocksScene.traverse(o => { if (o.isMesh && !rocksMesh) rocksMesh = o; });
        if (rocksMesh) {
            if (!waterTestRocksMaterial) {
                waterTestRocksMaterial = new THREE.MeshToonMaterial({ color: 0xb2baa0, gradientMap: threeTone });
                applyShorelineFoam(waterTestRocksMaterial);
            }
            const rocks = new THREE.Mesh(rocksMesh.geometry, waterTestRocksMaterial);
            rocks.position.set(8, 0.5, -5);
            rocks.rotation.y = Math.PI * 0.5;
            rocks.castShadow = true;
            levelGroup.add(rocks);
            collidables.push(rocks);
        }

        // Default (1x1 segment = 2 triangles) on purpose - see
        // createStylizedWaterMaterial: the bob is global, so subdividing
        // buys nothing visually and costs a lot, since this mesh goes into
        // `collidables` and gets raycast constantly.
        const water = new THREE.Mesh(new THREE.PlaneGeometry(256, 256), defaultWaterBody.waterMaterial);
        water.rotation.x = -Math.PI / 2;
        water.position.y = WATER_LEVEL;
        levelGroup.add(water);
        collidables.push(water);
        // Drag this in the level editor and the foam on the terrain/rocks/
        // demo box/player all follow immediately - see linkWaterMeshToBody.
        linkWaterMeshToBody(water, defaultWaterBody);

        // Proves applyShorelineFoam works on an arbitrary object's own
        // material (kept as MeshStandardMaterial, not a bespoke shader like
        // terrain/rocks above) - sitting flush on the shore so its bottom
        // face crosses the animated waterline, same as any box the level
        // editor's Add Object tool drops in this level (see
        // levelEditor.onObjectAdded below).
        // terrain.glb's own footprint is roughly [-15,15] in both X/Z (see
        // project chat) - well clear of that, floating in open water, so
        // it can't end up buried inside the terrain mound like an earlier
        // placement did.
        const demoBoxMat = new THREE.MeshStandardMaterial({ color: 0x2b4a6f });
        applyShorelineFoam(demoBoxMat);
        const demoBox = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), demoBoxMat);
        demoBox.position.set(18, WATER_LEVEL + 0.3, 0);
        demoBox.castShadow = true;
        demoBox.receiveShadow = true;
        levelGroup.add(demoBox);
        collidables.push(demoBox);

        // Proof that the multi-water-body architecture actually works:
        // a second, independent water surface at a totally different
        // height (2.5 vs the main sea's 0.9), with its own waterBody
        // object - passing it as applyShorelineFoam's second argument
        // means this rock's foam tracks THIS water's height, unaffected
        // by defaultWaterBody being reset per-level above. Floating in
        // open air rather than sitting on a proper basin/pedestal - this
        // is only here to prove two different heights can foam at once,
        // not to look good.
        if (!pondWaterBody) pondWaterBody = createWaterBody({
            waterLevel: 2.5, waveSpeed: 0.8, waveAmplitude: 0.12, foamDepth: 0.1,
            textureSize: 55, colorNear: 0x3fd0ff, colorFar: 0x0d5c8f,
        });
        // Re-enable every rebuild, not just on first creation: buildLevel()
        // turns foam off on ALL bodies before dispatching, and the `if
        // (!pondWaterBody)` guard above means the createWaterBody default of
        // 1 only ever applies the very first time this level is built. Going
        // Water Test -> Level 2 -> Water Test therefore left the pond's foam
        // switched off for good.
        pondWaterBody.uniforms.uFoamEnabled.value = 1;
        const pondWater = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), pondWaterBody.waterMaterial);
        pondWater.rotation.x = -Math.PI / 2;
        pondWater.position.set(25, 2.5, 10);
        levelGroup.add(pondWater);
        collidables.push(pondWater);
        linkWaterMeshToBody(pondWater, pondWaterBody);

        const pondRockMat = new THREE.MeshStandardMaterial({ color: 0x6f6a5c });
        applyShorelineFoam(pondRockMat);
        const pondRock = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), pondRockMat);
        pondRock.position.set(25, 2.6, 10);
        pondRock.castShadow = true;
        pondRock.receiveShadow = true;
        levelGroup.add(pondRock);
        collidables.push(pondRock);

        char.group.position.set(0, WATER_LEVEL + 2, 0);
        char.group.rotation.y = Math.PI;
    }

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
        // Same stylized water material as the Water Test level's main sea
        // (defaultWaterBody) - one shared instance/uniform set, reused
        // here instead of a second copy, so animate()'s existing uTime
        // loop over waterBodies covers both.
        if (!levelGlbWater) {
            levelGlbWater = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), defaultWaterBody.waterMaterial);
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
        // Measured directly (see project chat): Level.glb's own lowest
        // point sits at scaled y=-0.858, water at -0.975 - a 0.117 gap the
        // geometry never dips into, so the foam band (0.08 deep, riding a
        // ±0.1 wave) never reaches it and never shows. Nudging the whole
        // level down (not the water up, so the "platform over open ocean"
        // read stays the same) drops that lowest point to roughly -1.0 -
        // just past the waterline, enough for the foam band to catch it.
        levelGlbScene.position.y = -0.15;
        levelGlbWater.position.y = -1.5 * LEVEL_TO_PLAYER_SCALE;
        levelGroup.add(levelGlbWater);
        collidables.push(levelGlbWater);

        // Same shoreline-foam trick as the Water Test level, pointed at
        // this level's own water instead - defaultWaterBody.uniforms is
        // shared by reference with every material applyShorelineFoam has
        // touched with no explicit waterBody argument (terrain here, the
        // Water Test level's own props). uWaterLevel itself isn't set here
        // anymore - linkWaterMeshToBody below makes animate() read it
        // straight off levelGlbWater.position.y every frame, so dragging
        // that mesh in the editor moves the foam too. Anything bound to a
        // different waterBody (the Water Test level's pond rock, or the
        // player - see charWaterUniforms) is unaffected.
        defaultWaterBody.uniforms.uFoamEnabled.value = 1;
        linkWaterMeshToBody(levelGlbWater, defaultWaterBody);
        if (char.bodyMaterials) char.bodyMaterials.forEach(mat => applyShorelineFoam(mat, { objScale: window.charFoamScale, trackGlobal: 'charFoamScale' }));

        let startNode = null;
        levelGlbScene.traverse(o => {
            if (o.isMesh) {
                o.castShadow = true; o.receiveShadow = true;
                collidables.push(o);
                // Arrow wrapper, NOT a bare `.forEach(applyShorelineFoam)`:
                // forEach passes (element, index, array), so the index
                // landed in the waterBody parameter. `0..uniforms` is
                // undefined, Object.assign ignores undefined sources
                // silently, and the shader ended up declaring uWaterLevel/
                // uFoamEnabled without any of them ever being bound - they
                // read as 0, so the mask was always 0 and this geometry
                // never showed foam at all.
                (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => applyShorelineFoam(m));
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

    // ---- Village level: NPC, speech bubble, first quest ----
    // villageNpcAvatar is a RemoteAvatar (same idle-animated player-model
    // clone class used for aiBot/companion) rather than a bespoke mesh -
    // "just like the enemy or companion" per request.
    let villageNpcAvatar = null;
    let villageNpcBubble = null;
    let villageQuestGiven = false;
    let villageDialogueActive = false;
    let villageDialogueLineIndex = 0;
    let villageTypewriterProgress = 0;
    let villageTypewriterDone = false;
    let villageDialogueFastForward = false;
    const VILLAGE_DIALOGUE_LINES = [
        'Dinle beni.',
        'Çırağım, dün ormana gitti ama hala dönmedi.',
        'Pusulasını da yanına almamış.',
        'Eğer onu bulabilirsen, köye geri getirebilir misin?',
        'Lütfen, lütfen onu geri getir.',
    ];
    const VILLAGE_TYPEWRITER_CPS = 28; // base characters/second
    const VILLAGE_TYPEWRITER_FAST_MULT = 3; // while tap/hold-forwarding
    const VILLAGE_NPC_TALK_RADIUS = 2.5;

    // Small canvas speech-bubble sprite (rounded rect + tail), always
    // facing the camera like makeTextSprite's labels - raycast disabled
    // for the same reason those are: without it, this bubble (a child of
    // the NPC, which IS a collidable) could be the closest hit instead of
    // the NPC's actual body when a ray sweeps past its height.
    function createSpeechBubbleSprite(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 4;
        const r = 20, w = 236, h = 84, x = 10, y = 10;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(canvas.width / 2 - 14, y + h);
        ctx.lineTo(canvas.width / 2, y + h + 20);
        ctx.lineTo(canvas.width / 2 + 14, y + h);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#222';
        ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, y + h / 2);
        const texture = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
        sprite.scale.set(2.0, 1.0, 1);
        sprite.raycast = () => {};
        return sprite;
    }

    // Simplified port of DungeonGame.html's sageToasts/addSageToast -
    // prepends a toast into #notif-toasts (top-right) and auto-fades it
    // after a few seconds. No manual-dismiss/history panel like that
    // script's version had - just enough to surface "quest received"
    // style events without a popup blocking play.
    function addNotificationToast(text, iconUrl) {
        const container = document.getElementById('notif-toasts');
        if (!container) return;
        const el = document.createElement('div');
        el.style.cssText = 'background:rgba(20,20,20,0.88); color:#ffffe0; border-right:3px solid #8e44ad; border-radius:6px; padding:8px 12px; font-size:13px; font-family:monospace; box-shadow:0 4px 10px rgba(0,0,0,0.5); opacity:1; transition:opacity 0.6s; text-align:right; display:flex; align-items:center; gap:8px;';
        if (iconUrl) {
            const img = document.createElement('img');
            img.src = iconUrl;
            img.style.cssText = 'width:28px; height:28px; flex:0 0 auto;';
            el.appendChild(img);
        }
        const label = document.createElement('span');
        label.textContent = text;
        el.appendChild(label);
        container.prepend(el);
        while (container.children.length > 5) container.removeChild(container.lastChild);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 700); }, 5000);
    }

    // ---- Player compendium / Viewer ----
    // Minimal single-entry port of DungeonGame.html's Viewer - that script
    // shows a whole bestiary via category tabs + prev/next; this only ever
    // shows the Player, so all of that navigation chrome is left out.
    // Own scene/camera/renderer/OrbitControls, loading a completely
    // separate, fresh copy of the player's own model (StickMan.fbx) rather
    // than cloning the live character - the live one is a currently-
    // animating rig, and a plain Object3D.clone() doesn't correctly
    // rebind SkinnedMesh bones, so a second independent load sidesteps
    // that entirely for what's just a static rotate-and-look display.
    // Lazy-loaded (mirrors ensureLevelEditorLoaded's own reasoning): most
    // players never open this, so the extra FBX fetch + renderer/scene
    // setup only happens the first time the button is actually clicked.
    const Viewer = { scene: null, camera: null, renderer: null, controls: null, active: false, playerModel: null, loaded: false, mixer: null, clock: new THREE.Clock() };
    function ensureViewerLoaded() {
        if (Viewer.loaded) return;
        Viewer.loaded = true;
        Viewer.scene = new THREE.Scene();
        Viewer.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
        Viewer.camera.position.set(2.5, 2.0, 5.0);
        // alpha:true + zero clear color, no scene.background - lets the
        // modal's own dark CSS background show through, and (just as
        // usefully) keeps generatePlayerIcon's render below transparent
        // without having to toggle scene.background on and off around it.
        Viewer.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        Viewer.renderer.setClearColor(0x000000, 0);
        Viewer.renderer.setSize(window.innerWidth, window.innerHeight);
        Viewer.renderer.shadowMap.enabled = true;
        document.getElementById('viewer-container').appendChild(Viewer.renderer.domElement);
        Viewer.controls = new OrbitControls(Viewer.camera, Viewer.renderer.domElement);
        Viewer.controls.enableDamping = true;
        Viewer.controls.target.set(0, 0.9, 0);
        Viewer.scene.add(new THREE.HemisphereLight(0xddeeff, 0x202020, 1.2));
        const viewerLight = new THREE.DirectionalLight(0xffffff, 0.8);
        viewerLight.position.set(2, 4, 2);
        Viewer.scene.add(viewerLight);
        const viewerFloor = new THREE.Mesh(new THREE.CircleGeometry(2, 32), new THREE.ShadowMaterial({ opacity: 0.3 }));
        viewerFloor.rotation.x = -Math.PI / 2;
        Viewer.scene.add(viewerFloor);

        const baseUrl = 'https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/';
        new FBXLoader().load(baseUrl + 'StickMan.fbx', (object) => {
            object.scale.setScalar(parseFloat(document.getElementById('scale-slider').value));
            object.traverse(child => {
                if (child.isMesh) {
                    child.material = new THREE.MeshToonMaterial({ color: 0xdddddd, gradientMap: threeTone });
                    child.castShadow = true; child.receiveShadow = true;
                }
            });
            Viewer.scene.add(object);
            Viewer.playerModel = object;
            generatePlayerIcon();
            // Idle, not the raw T-pose - same Idle.fbx clip the real
            // character/companion/aiBot all use, just this model's own
            // independent mixer (ticked in Viewer.render below, called
            // from animate()'s Viewer.active branch).
            new FBXLoader().load(baseUrl + 'Idle.fbx', (animObj) => {
                if (!animObj.animations.length) return;
                Viewer.mixer = new THREE.AnimationMixer(object);
                Viewer.mixer.clipAction(animObj.animations[0]).play();
            });
        });
    }
    // Same idea as DungeonGame.html's generateIcons(): render the model to
    // a small offscreen canvas from a flattering angle, once, and keep the
    // resulting data URL around for anywhere a small player icon is
    // useful (right now: the quest toast). Renders Viewer.scene directly
    // (the same one the modal itself displays) through a separate small
    // renderer/camera, rather than cloning the model into a throwaway
    // scene - sidesteps any SkinnedMesh clone/rebind concerns entirely
    // since nothing is actually cloned.
    function generatePlayerIcon() {
        if (!Viewer.scene) return;
        const iconRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        iconRenderer.setSize(96, 96);
        iconRenderer.setClearColor(0x000000, 0);
        const iconCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 10);
        iconCamera.position.set(2.2, 1.8, 4.2);
        iconCamera.lookAt(0, 0.9, 0);
        iconRenderer.render(Viewer.scene, iconCamera);
        window.playerIconDataUrl = iconRenderer.domElement.toDataURL('image/png');
        iconRenderer.dispose();
    }
    function openViewer() {
        ensureViewerLoaded();
        Viewer.active = true;
        document.getElementById('player-viewer-modal').style.display = 'block';
    }
    function closeViewer() {
        Viewer.active = false;
        document.getElementById('player-viewer-modal').style.display = 'none';
    }
    const viewerBtnEl = document.getElementById('viewer-btn');
    if (viewerBtnEl) viewerBtnEl.addEventListener('click', openViewer);
    const closeViewerBtnEl = document.getElementById('close-viewer-btn');
    if (closeViewerBtnEl) closeViewerBtnEl.addEventListener('click', (e) => { e.stopPropagation(); closeViewer(); });

    function buildVillageLevel() {
        if (!villageScene) { pendingVillageLevelBuild = true; return; }
        while (levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0;

        // Unlike Level 2/Water Test, this whitebox's own floor blocks sit
        // well above y=0 in most places - the generic grass ground plane
        // (left visible, buildLevel()'s own default) shows through the
        // gaps around/under them instead of clashing, and gives the level
        // a green world to stand in rather than the stark empty backdrop
        // it had while this was hidden.

        villageScene.traverse(o => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; collidables.push(o); }
        });
        levelGroup.add(villageScene);
        villageScene.updateMatrixWorld(true);

        // Spawn: this whitebox has no dedicated "Empty" spawn marker yet
        // (see buildLevelFromGlb's startNode convention above) - it's a
        // first-pass proxy per the author's own note, so a fixed point
        // just above the first path block stands in for now.
        char.group.position.set(0, 4.5, -6);
        char.group.rotation.y = Math.PI;
        // window.compassTarget is already reset to null by buildLevel()'s
        // shared per-level reset above - re-armed once the quest is given.

        // NPC - a RemoteAvatar (idle-animated player-model clone), same
        // class aiBot/companion use, not a bespoke placeholder mesh. Not
        // pushed into `collidables` either, matching that same precedent
        // (aiBot/companion are purely visual - the player walks through
        // them, no physical blocking).
        villageNpcAvatar = new RemoteAvatar(scene, threeTone, 'village-npc-quest-giver');
        // Somewhere between spawn and the village's own central "Torus_5"
        // prop (t=0.3 - close enough to spawn for a quick first walk-up,
        // but clearly placed toward the torus, not right on top of spawn).
        // RemoteAvatar has no gravity/ground-snap of its own (unlike the
        // player), so a flat guessed Y left it floating - a real downward
        // raycast against the just-populated `collidables` finds the
        // actual ground height at that XZ instead.
        let villageTorusNode = null;
        villageScene.traverse(o => { if (o.name === 'Torus_5') villageTorusNode = o; });
        const npcSpawnRef = new THREE.Vector3(0, 4.5, -6);
        let npcX = 2.5, npcZ = -14;
        if (villageTorusNode) {
            const torusPos = new THREE.Vector3();
            villageTorusNode.getWorldPosition(torusPos);
            npcX = THREE.MathUtils.lerp(npcSpawnRef.x, torusPos.x, 0.3);
            npcZ = THREE.MathUtils.lerp(npcSpawnRef.z, torusPos.z, 0.3);
        }
        const npcGroundRay = new THREE.Raycaster(new THREE.Vector3(npcX, 200, npcZ), new THREE.Vector3(0, -1, 0));
        const npcGroundHits = npcGroundRay.intersectObjects(collidables, false);
        const npcGroundY = npcGroundHits.length > 0 ? npcGroundHits[0].point.y : npcSpawnRef.y;
        villageNpcAvatar.group.position.set(npcX, npcGroundY, npcZ);
        // Faces the player's spawn point by default (not just during
        // dialogue, which re-aims it anyway once triggered).
        const npcToPlayer = new THREE.Vector3(npcSpawnRef.x - npcX, 0, npcSpawnRef.z - npcZ);
        villageNpcAvatar.group.rotation.y = Math.atan2(npcToPlayer.x, npcToPlayer.z);

        villageNpcBubble = createSpeechBubbleSprite('Hey!');
        villageNpcBubble.position.set(0, 2.4, 0);
        villageNpcAvatar.group.add(villageNpcBubble);
        villageQuestGiven = false;
        villageDialogueActive = false;

        // Forest entrance = midpoint between the two named tree-cluster
        // entities the modeler placed in the whitebox ("Entity 2" and
        // "treeGroup 15" - both literal groups of trees flanking the
        // approach, per the file's own naming). Computed from their real
        // loaded world positions rather than hardcoded, so this stays
        // correct if the model is reworked later.
        // GLTFLoader sanitizes node names on load (spaces -> underscores,
        // and de-dupes any repeated raw name with a numeric suffix) - the
        // source file's "Entity 2"/"treeGroup 15" come through as
        // "Entity_2"/"treeGroup_15" (confirmed by traversing the actually-
        // loaded scene, not just reading the raw glb's JSON chunk).
        let treeGroupA = null, treeGroupB = null;
        villageScene.traverse(o => {
            if (o.name === 'Entity_2') treeGroupA = o;
            else if (o.name && o.name.startsWith('treeGroup')) treeGroupB = o;
        });
        if (treeGroupA && treeGroupB) {
            const posA = new THREE.Vector3(), posB = new THREE.Vector3();
            treeGroupA.getWorldPosition(posA);
            treeGroupB.getWorldPosition(posB);
            window.villageForestEntrance = new THREE.Vector3((posA.x + posB.x) / 2, 0, (posA.z + posB.z) / 2);
            // Visible marker at the entrance itself (not just the
            // compass) - a soft glowing pillar plus a text label, so
            // arriving there reads as "this is the spot" on its own.
            const markerMat = new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
            const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 6, 16, 1, true), markerMat);
            marker.position.copy(window.villageForestEntrance);
            marker.position.y += 3;
            levelGroup.add(marker);
            const label = makeTextSprite('Orman Girişi', 2.2);
            label.position.copy(window.villageForestEntrance);
            label.position.y += 6.5;
            levelGroup.add(label);
        } else {
            window.villageForestEntrance = null;
        }
    }

    // ---- Village NPC dialogue ----
    // Starts once the player gets close enough (see the proximity check in
    // animate()) - locks movement/jump/punch input (window.dialogueInputLocked,
    // checked at the few real input sources: rawX/rawY, handleJump, the
    // punch button), swings the camera to a fixed two-shot framing instead
    // of the normal follow-cam, and steps through VILLAGE_DIALOGUE_LINES
    // one at a time with an old-game-style typewriter reveal.
    const dialogueBoxEl2 = document.getElementById('dialogue-box');
    const dialogueTextEl = document.getElementById('dialogue-text');
    const dialogueContinueEl = document.getElementById('dialogue-continue');
    function startVillageDialogue() {
        villageDialogueActive = true;
        window.dialogueInputLocked = true;
        villageDialogueLineIndex = 0;
        villageTypewriterProgress = 0;
        villageTypewriterDone = false;
        villageDialogueFastForward = false;
        if (villageNpcBubble) villageNpcBubble.visible = false;
        if (dialogueTextEl) dialogueTextEl.textContent = '';
        if (dialogueContinueEl) dialogueContinueEl.style.display = 'none';
        if (dialogueBoxEl2) dialogueBoxEl2.style.display = 'block';
        // Clears the joysticks/buttons out from under your hands during
        // the conversation - same helper the editor toggle already uses.
        setGameControlsVisible(false);

        // Snap player + NPC to face each other, and compute the two-shot
        // camera framing once up front (not recomputed every frame) - it's
        // then just eased toward smoothly below, the same way the normal
        // follow-cam already lerps every frame.
        const toNpc = new THREE.Vector3().subVectors(villageNpcAvatar.group.position, char.group.position);
        toNpc.y = 0;
        const dist = Math.max(0.5, toNpc.length());
        toNpc.normalize();
        char.group.rotation.y = Math.atan2(toNpc.x, toNpc.z);
        villageNpcAvatar.group.rotation.y = Math.atan2(-toNpc.x, -toNpc.z);
        const mid = new THREE.Vector3().addVectors(char.group.position, villageNpcAvatar.group.position).multiplyScalar(0.5);
        const perp = new THREE.Vector3(-toNpc.z, 0, toNpc.x);
        window._dialogueCamTarget = mid.clone().add(new THREE.Vector3(0, 1.3, 0));
        window._dialogueCamPos = mid.clone().add(perp.multiplyScalar(Math.max(2.2, dist * 0.9))).add(new THREE.Vector3(0, 1.6, 0));
    }
    function updateVillageDialogueTypewriter(delta) {
        if (villageTypewriterDone) return;
        const rate = VILLAGE_TYPEWRITER_CPS * (villageDialogueFastForward ? VILLAGE_TYPEWRITER_FAST_MULT : 1);
        villageTypewriterProgress += rate * delta;
        const line = VILLAGE_DIALOGUE_LINES[villageDialogueLineIndex];
        const shown = Math.min(line.length, Math.floor(villageTypewriterProgress));
        if (dialogueTextEl) dialogueTextEl.textContent = line.slice(0, shown);
        if (shown >= line.length) {
            villageTypewriterDone = true;
            if (dialogueContinueEl) dialogueContinueEl.style.display = 'inline-block';
        }
    }
    function advanceVillageDialogueLine() {
        villageDialogueLineIndex++;
        if (villageDialogueLineIndex >= VILLAGE_DIALOGUE_LINES.length) {
            endVillageDialogue();
        } else {
            villageTypewriterProgress = 0;
            villageTypewriterDone = false;
            if (dialogueTextEl) dialogueTextEl.textContent = '';
            if (dialogueContinueEl) dialogueContinueEl.style.display = 'none';
        }
    }
    function endVillageDialogue() {
        villageDialogueActive = false;
        window.dialogueInputLocked = false;
        if (dialogueBoxEl2) dialogueBoxEl2.style.display = 'none';
        setGameControlsVisible(true);
        window._dialogueCamPos = null;
        window._dialogueCamTarget = null;
        if (!villageQuestGiven) {
            villageQuestGiven = true;
            // window.playerIconDataUrl only exists once the Viewer has been
            // opened at least once (lazy-loaded) - undefined is fine here,
            // the toast just shows text-only until then.
            addNotificationToast('New Quest: The Lost Apprentice', window.playerIconDataUrl);
            if (window.villageForestEntrance) window.compassTarget = window.villageForestEntrance;
        }
    }
    if (dialogueBoxEl2) {
        dialogueBoxEl2.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (!villageDialogueActive) return;
            if (villageTypewriterDone) advanceVillageDialogueLine();
            else villageDialogueFastForward = true;
        });
        const stopFastForward = () => { villageDialogueFastForward = false; };
        dialogueBoxEl2.addEventListener('pointerup', stopFastForward);
        dialogueBoxEl2.addEventListener('pointercancel', stopFastForward);
        dialogueBoxEl2.addEventListener('pointerleave', stopFastForward);
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

    // Test prop (Cubes.glb) - same scale factor as Level.glb itself
    // (LEVEL_TO_PLAYER_SCALE, buildLevelFromGlb) since it comes from the
    // same export pipeline. Its own local origin is NOT at its base (off by
    // ~34 units at this scale, confirmed by measuring its bounding box) -
    // unlike CurvedRamps_UniRamp.glb, trusting the raw origin here would
    // leave it floating deep underground, so this corrects for that
    // specific gap instead.
    // Split out of buildStairsLevel() so the Jar.fbx loader (below) can spawn
    // the jar grid on its own, the same way spawnTestKeyAndLock already
    // handles StarKey.glb finishing late - a bare `if (jarTemplate)` block
    // used to mean the only way to retroactively populate jars once Jar.fbx
    // finished loading was a full buildLevel() rebuild, which wipes
    // collidables/carryables out from under anything already loaded (see the
    // comment above spawnTestKeyAndLock's call site for the incident that
    // pattern caused).
    function spawnJarGrid() {
        if (!jarTemplate) return;
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

    // A single jar sitting on top of stair_1 (the original column's 2nd
    // step, y-top=5.7 per buildStairColumn's own h/2+i*cubeSize*0.9 - i=1,
    // h=cubeSize=3.0 - formula, z=-13). Offset is 0.51, not exactly 0.5:
    // the carryable physics loop gives every carryable a fixed 1x1x1
    // collision box (_carrySizeVec) regardless of the jar's real visual
    // size, and resolves X/Z overlap against other collidables BEFORE Y
    // each substep. Landing at exactly 0.5 (the box's own half-height) put
    // its collision box EXACTLY touching the stair's own top on the very
    // first frame, before gravity had even moved it - read as a horizontal
    // collision, not a landing, which shoved it sideways off the step
    // entirely and sent it falling all the way to the real ground instead
    // (breaking on impact). The extra 0.01 keeps it just clear of that
    // touching boundary at spawn so it falls a hair and settles normally.
    function spawnStairJar() {
        if (!jarTemplate) return;
        const jarMesh = jarTemplate.clone();
        jarMesh.position.set(0, 5.7 + 0.51, -13);
        jarMesh.userData.isCarryable = true;
        jarMesh.userData.isJar = true;
        levelGroup.add(jarMesh);
        collidables.push(jarMesh);
        const carryJar = { mesh: jarMesh, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
        carryables.push(carryJar); addCarryableDebugHelper(carryJar);

        // Second jar, on top of B3 (stairL_2) - looked up by name instead
        // of a hardcoded position since B3 gets moved down by one cubeSize
        // elsewhere in buildStairsLevel; reading its live position here
        // keeps this correct even if that offset ever changes.
        const stairL2 = levelGroup.getObjectByName('stairL_2');
        if (stairL2) {
            const jarMesh2 = jarTemplate.clone();
            jarMesh2.position.set(stairL2.position.x, stairL2.position.y + cubeSize / 2 + 0.51, stairL2.position.z);
            jarMesh2.userData.isCarryable = true;
            jarMesh2.userData.isJar = true;
            levelGroup.add(jarMesh2);
            collidables.push(jarMesh2);
            const carryJar2 = { mesh: jarMesh2, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
            carryables.push(carryJar2); addCarryableDebugHelper(carryJar2);
        }
    }

    function loadCubesProp(x, z) {
        const propLoader = new GLTFLoader();
        propLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/LevelModel/Cubes.glb', (gltf) => {
            const model = gltf.scene;
            model.scale.setScalar(0.65);
            model.position.set(x, 0, z);
            model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
            model.userData.isCubesProp = true;

            model.updateMatrixWorld(true);
            const groundGap = new THREE.Box3().setFromObject(model).min.y;
            model.position.y -= groundGap;

            levelGroup.add(model);
            model.traverse(c => { if (c.isMesh) collidables.push(c); });
            // Remote GLTF fetch takes several seconds on a cold load - the
            // loading overlay (hidden once this and char.isLoaded are both
            // true, see animate()) stays up until this prop can actually be
            // grabbed, instead of the player being able to reach it before
            // it's in collidables at all.
            window._cubesLoaded = true;
            // The grass field was already scattered (synchronously, at level
            // build time) before this prop existed to avoid - re-scatter now
            // that it's actually in collidables. window.rebuildGrass is the
            // same escape hatch the slider controls use.
            if (window.rebuildGrass) window.rebuildGrass();
        });
    }

    function buildStairsLevel() {
        rampAngleLabels.length = 0;
        stairNumberLabels.length = 0;
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
        // ROW_START_X=-25). ROW_SPACING equals each ramp's own width (6)
        // so consecutive ramps sit flush edge-to-edge - no gap to fall
        // through while walking sideways across the row (was 7.5, a
        // 1.5-unit slot between every pair).
        const ROW_ANGLES = [25, 33, 40, 44, 48, 56, 65, 69, 72];
        const ROW_SPACING = 6, ROW_START_X = -15, ROW_Z = -10;
        ROW_ANGLES.forEach((deg, i) => buildSlopeTestRamp(ROW_START_X - i * ROW_SPACING, ROW_Z, deg));
        const ROW_END_X = ROW_START_X - (ROW_ANGLES.length - 1) * ROW_SPACING;

        // Test prop, across from the ramp row (same spot the earlier curved
        // ramp prop used, mirrored to the other side of Z=0).
        loadCubesProp(ROW_START_X, -ROW_Z);

        const startMesh = new THREE.Mesh(boxGeoTemplate, platMat);
        startMesh.position.set(0, cubeSize/2, 0); startMesh.castShadow = true; startMesh.receiveShadow = true;
        levelGroup.add(startMesh); collidables.push(startMesh);

        // Builds one full column of 6 steps, centered at the given x -
        // pulled out so a second, flush-adjacent column (see below) can
        // reuse the exact same step heights/spacing instead of duplicating
        // the loop by hand.
        const buildStairColumn = (xCenter, namePrefix, columnTag) => {
            for (let i = 0; i < 6; i++) {
                // Step 0 is deliberately tall - built all the way up to step
                // 1's own top (cubeSize*1.9, i.e. step 1's h +
                // i*cubeSize*0.9 with i=1) instead of stopping partway, so
                // climbing onto it lands flush with step 1 rather than
                // leaving a second small step right after it. Once the lock
                // down at z=-8 is opened, reaching this first step should
                // take a jump followed by grabbing its edge (ledge grab),
                // not a plain walk-up or a clean jump straight onto it.
                const h = i === 0 ? cubeSize * 1.9 : cubeSize;
                const mesh = new THREE.Mesh(i === 0 ? new RoundedBoxGeometry(cubeSize, h, cubeSize, 1, 0.15) : boxGeoTemplate, platMat);
                mesh.position.set(xCenter, h / 2 + i * cubeSize * 0.9, -10 - i * cubeSize);
                mesh.name = namePrefix + i;
                mesh.castShadow = true; mesh.receiveShadow = true;
                levelGroup.add(mesh); collidables.push(mesh);

                // Temporary debug numbering (always visible, no toggle) so
                // steps can be pointed at unambiguously by column+number
                // instead of "3rd step" being guessable two different ways.
                // Added to levelGroup in world space, NOT as a child of
                // mesh - getObstacleBox's cached collision box for this
                // step is a Box3().setFromObject(mesh), which recurses into
                // children by default, so parenting the label to the step
                // was silently inflating its own collision box upward by
                // the label's height. That's what broke the stair-top jar
                // again: its landing surface was no longer where the box
                // actually visually ends.
                const label = makeTextSprite(columnTag + (i + 1));
                label.position.set(xCenter, h / 2 + i * cubeSize * 0.9 + h / 2 + 0.2, -10 - i * cubeSize);
                label.visible = document.getElementById('toggle-step-labels').checked;
                levelGroup.add(label);
                stairNumberLabels.push(label);
            }
        };
        buildStairColumn(0, 'stair_', 'A');
        // Second column flush against the first one's -x side (the ramp
        // row's own direction, see ROW_START_X below) - touches edge to
        // edge since each step is cubeSize wide, so offsetting the center
        // by exactly cubeSize leaves no gap.
        buildStairColumn(-cubeSize, 'stairL_', 'B');

        // Jump-height test rig: one more ground-standing block flush
        // against stair_0's own side (-x, same z, cubeSize wide) - same
        // footprint as stair_0, but 2/4 (1.5x) taller, to see how big a
        // single-jump step-up the player can still clear before it turns
        // into a climb/mantle situation. The other block in this rig
        // (1.25x, formerly at -cubeSize) is now stair_0 itself. -x, not
        // +x: the hemisphere sits at (10, 0, -10) with radius 6, reaching
        // out to x=4 - +x put this block partway inside its dome,
        // invisible/clipped through solid geometry. -x is
        // clear all the way out past the ramp row (closest one starts at
        // x=-15, well past this rig's own x=-7.8 marker).
        const jumpTestH = cubeSize * 1.5;
        const jumpTestBlock = new THREE.Mesh(new RoundedBoxGeometry(cubeSize, jumpTestH, cubeSize, 1, 0.15), platMat);
        jumpTestBlock.position.set(-cubeSize * 2, jumpTestH / 2, -10);
        jumpTestBlock.castShadow = true; jumpTestBlock.receiveShadow = true;
        levelGroup.add(jumpTestBlock); collidables.push(jumpTestBlock);
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
        // First segment (leg 1, i=0, right at the stairs' own top) and last
        // segment (leg 2, its final i, right above the ramp row) are
        // skipped so both ends of the walkway leave a real gap to jump
        // instead of a flush, walk-straight-onto connection.
        const WALKWAY_LEG1_SEGMENTS = 12;
        for (let i = 1; i <= WALKWAY_LEG1_SEGMENTS; i++) {
            const t = i / WALKWAY_LEG1_SEGMENTS;
            // Only the walkway's own first built element (i=1, the one
            // resting closest to B6) is pulled down to B4's top
            // (stairL_3, y=9.6 + cubeSize/2=11.1) - every other segment
            // keeps the original 16.5->14.5 lerp untouched.
            const y = i === 1 ? 11.1 : THREE.MathUtils.lerp(16.5, 14.5, t);
            addWalkwaySegment(THREE.MathUtils.lerp(0, ROW_END_X, t), y, -25);
        }
        const WALKWAY_LEG2_SEGMENTS = 3;
        for (let i = 1; i < WALKWAY_LEG2_SEGMENTS; i++) {
            const t = i / WALKWAY_LEG2_SEGMENTS;
            addWalkwaySegment(ROW_END_X, THREE.MathUtils.lerp(14.5, 13.5, t), THREE.MathUtils.lerp(-25, -11, t));
        }
        // Last BUILT leg-2 segment (i=2 above, since i=WALKWAY_LEG2_SEGMENTS
        // itself is skipped) sits at (ROW_END_X, 13.83, -15.67), an 8x0.6x8
        // slab - top surface at y≈14.13, spanning z from about -19.67 to
        // -11.67. This is the actual elevated walkway a player crosses to
        // reach the ramp row, not ground level - the turret and finish
        // diamond both belong up here, at the walkway's own far end (close
        // to the ramp-side gap), not down at the base of a ramp.
        const WALKWAY_END_X = ROW_END_X, WALKWAY_END_Y = 14.13 + 1.4, WALKWAY_END_Z = -13;

        // Orange (medium_high) turret moved onto leg 1 - the arm that runs
        // from this same corner (where leg 2/the ramp-side platform ends)
        // back toward the stairs - instead of leg 2. Placed one segment in
        // from that corner (t=11/12, same lerp leg 1's own loop above
        // uses) and hovering above THAT segment's surface, firing +X
        // (toward the stairs, where leg 1 actually leads) instead of -Z.
        const LEG1_TURRET_T = 11 / 12;
        const leg1TurretX = THREE.MathUtils.lerp(0, ROW_END_X, LEG1_TURRET_T);
        const leg1TurretSurfaceY = THREE.MathUtils.lerp(16.5, 14.5, LEG1_TURRET_T) + 0.3;
        const rampEndShooter = new ShooterBox(levelGroup, leg1TurretX, leg1TurretSurfaceY + 1.4, -25, 'medium_high', new THREE.Vector3(1, 0, 0));
        shooters.push(rampEndShooter); collidables.push(rampEndShooter.mesh);

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

        // One-off tweaks to specific numbered steps (see the debug number
        // labels added in buildStairColumn) - done here, after both
        // columns already exist, by grabbing each step by its
        // stair_/stairL_ name rather than re-parameterizing
        // buildStairColumn again for a handful of one-off cases.
        {
            const stairL2 = levelGroup.getObjectByName('stairL_2'); // B3
            const stairL3 = levelGroup.getObjectByName('stairL_3'); // B4
            const stairL4 = levelGroup.getObjectByName('stairL_4'); // B5
            const stair4 = levelGroup.getObjectByName('stair_4');   // A5
            const stairL5 = levelGroup.getObjectByName('stairL_5'); // B6
            const stair5 = levelGroup.getObjectByName('stair_5');   // A6
            const stair3 = levelGroup.getObjectByName('stair_3');   // A4

            // B3 down by one cubeSize (Jar added below, once jarTemplate is
            // known ready - see spawnStairJar).
            if (stairL2) stairL2.position.y -= cubeSize;

            // B4: a plain flush support box directly underneath it.
            if (stairL3) {
                const under = new THREE.Mesh(boxGeoTemplate, platMat);
                under.position.set(stairL3.position.x, stairL3.position.y - cubeSize, stairL3.position.z);
                under.castShadow = true; under.receiveShadow = true;
                levelGroup.add(under); collidables.push(under);
            }

            // B5: halved height, bottom edge kept where the full-height
            // step's own bottom was (not re-centered) - can't just resize
            // boxGeoTemplate, it's shared by every other plain step.
            if (stairL4) {
                const oldBottom = stairL4.position.y - cubeSize / 2;
                stairL4.geometry = new RoundedBoxGeometry(cubeSize, cubeSize / 2, cubeSize, 1, 0.15);
                stairL4.position.y = oldBottom + cubeSize / 4;
            }

            // A5 down by one cubeSize.
            if (stair4) stair4.position.y -= cubeSize;

            // B6 and A6: same flush support box as B4's.
            [stairL5, stair5].forEach(step => {
                if (!step) return;
                const under = new THREE.Mesh(boxGeoTemplate, platMat);
                under.position.set(step.position.x, step.position.y - cubeSize, step.position.z);
                under.castShadow = true; under.receiveShadow = true;
                levelGroup.add(under); collidables.push(under);
            });

            // A4: a pickup-able small box on top, deliberately off-center
            // (A4's own footprint is cubeSize wide, so +0.6 in x stays well
            // within it without sitting dead center). 0.51, not 0.5 -
            // exactly touching a step's own top on spawn reads as a
            // horizontal collision to the carryable physics loop before
            // gravity ever moves it (see spawnStairJar's own comment on the
            // stair-top jar for the full explanation) and shoves it off.
            if (stair3) {
                const topBox = new THREE.Mesh(new RoundedBoxGeometry(1.0, 1.0, 1.0, 1, 0.05), smallMat);
                topBox.position.set(stair3.position.x + 0.6, stair3.position.y + cubeSize / 2 + 0.51, stair3.position.z);
                topBox.castShadow = true; topBox.receiveShadow = true;
                topBox.userData.isCarryable = true;
                levelGroup.add(topBox); collidables.push(topBox);
                const carryTop = { mesh: topBox, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
                carryables.push(carryTop); addCarryableDebugHelper(carryTop);
            }

            // Debug number labels aren't parented to their steps (see their
            // own comment on why), so moving/resizing a step above leaves
            // its label floating at the old spot unless repositioned here
            // too. Indices: A's are 0-5 (label i = array index i), B's are
            // 6-11 (array index 6+i).
            if (stairNumberLabels[8] && stairL2) stairNumberLabels[8].position.y = stairL2.position.y + cubeSize / 2 + 0.2;
            if (stairNumberLabels[4] && stair4) stairNumberLabels[4].position.y = stair4.position.y + cubeSize / 2 + 0.2;
            if (stairNumberLabels[10] && stairL4) stairNumberLabels[10].position.y = stairL4.position.y + cubeSize / 4 + 0.2;
        }

        spawnJarGrid();
        spawnStairJar();

        // Finish marker moved from the top of the stairs to the far end of
        // the elevated walkway leading to the ramp row - right next to the
        // new orange turret above (WALKWAY_END_X/Y/Z), not down at ground
        // level where a player crossing the walkway would never see it.
        star.position.set(WALKWAY_END_X, WALKWAY_END_Y, WALKWAY_END_Z); star.visible = true;
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

    // ---- Documentation / screenshot level -------------------------------
    // A deliberately empty, untextured, greyscale scene. Everything in the
    // normal levels - grass texture, blue sky gradient, ramps, props - is
    // visual noise when the point of the shot is the UI itself: joysticks,
    // contextual buttons, panels. Stripping the world to flat greys makes the
    // interface read as the subject rather than something laid over a
    // landscape.
    //
    // Captured once here (not inside the toggle) so the "off" branch restores
    // the values the game actually shipped with rather than hardcoded guesses.
    const presentationGroundMap = ground.material.map;
    const presentationSkyTop = skyMat.uniforms.topColor.value.clone();
    const presentationSkyBottom = skyMat.uniforms.bottomColor.value.clone();
    const presentationFogColor = scene.fog.color.clone();

    function setPresentationGreyscale(on) {
        if (on) {
            // Two backdrops, because they serve different shots. Grey keeps the
            // character and the UI readable against it. White is for anything
            // that has to be cut out or dropped onto a light document page -
            // there the ground/sky seam is the problem, so it gets erased
            // entirely rather than merely muted.
            const white = document.getElementById('toggle-blank-white');
            const useWhite = white && white.checked;
            ground.material.map = null;
            ground.material.color.setHex(useWhite ? 0xffffff : 0xb4b4b4);
            skyMat.uniforms.topColor.value.setHex(useWhite ? 0xffffff : 0x8a8a8a);
            skyMat.uniforms.bottomColor.value.setHex(useWhite ? 0xffffff : 0xdcdcdc);
            scene.fog.color.setHex(useWhite ? 0xffffff : 0xdcdcdc);
        } else {
            ground.material.map = presentationGroundMap;
            ground.material.color.setHex(0xffffff);
            skyMat.uniforms.topColor.value.copy(presentationSkyTop);
            skyMat.uniforms.bottomColor.value.copy(presentationSkyBottom);
            scene.fog.color.copy(presentationFogColor);
        }
        ground.material.needsUpdate = true;
    }

    function buildBlankLevel() {
        setPresentationGreyscale(true);

        // Stations along one axis, far enough apart that walking to any one of
        // them puts the others out of frame. The point is a separate clean shot
        // per mechanic, so nothing may share a backdrop with anything else -
        // hence the wide spacing rather than a compact test course.
        const STATION_Z = -6;
        const GAP = 20;
        const stationX = i => i * GAP;

        function addBox(x, y, z, sx = 1, sy = 1, sz = 1) {
            const m = new THREE.Mesh(boxGeoTemplate, platMat);
            m.position.set(x, y, z);
            m.scale.set(sx, sy, sz);
            m.castShadow = true; m.receiveShadow = true;
            levelGroup.add(m); collidables.push(m);
            return m;
        }

        // 0 - single box: contextual carry/climb buttons, i.e. the UI shot.
        addBox(stationX(0), cubeSize / 2, STATION_Z);

        // +1 - walkable slope: foot IK adapting to an incline.
        buildSlopeTestRamp(stationX(1), STATION_Z, 30);

        // +2 - curved surface: the hemisphere ground-follow case, which is a
        // different code path from flat ground and from ramps.
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(4, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshToonMaterial({ color: 0xa8a8a8, gradientMap: threeTone }));
        dome.position.set(stationX(2), 0, STATION_Z);
        dome.castShadow = true; dome.receiveShadow = true;
        dome.userData.isHemisphere = true;   // see isOnHemisphere in movement
        levelGroup.add(dome); collidables.push(dome);

        // +3 - stairs: step traversal.
        for (let i = 0; i < 4; i++)
            addBox(stationX(3), cubeSize / 2 + i * cubeSize, STATION_Z - i * cubeSize);

        // +4 - climb wall: tall enough that it can only be passed by grabbing
        // the ledge, not by stepping or jumping.
        addBox(stationX(4), cubeSize * 1.5, STATION_Z, 3, 3, 1);

        // -1 - carryables: jars, for carry / throw / break.
        if (jarTemplate) {
            for (let i = 0; i < 3; i++) {
                const jar = jarTemplate.clone();
                jar.position.set(stationX(-1) + (i - 1) * 1.3, 0.5, STATION_Z);
                jar.userData.isCarryable = true;
                jar.userData.isJar = true;
                levelGroup.add(jar); collidables.push(jar);
                const carryJar = { mesh: jar, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
                carryables.push(carryJar); addCarryableDebugHelper(carryJar);
            }
        }

        // -2 - turret: projectile hit, recoil and ragdoll. Aimed back along the
        // row so the character is shot while standing in front of it.
        const turret = new ShooterBox(levelGroup, stationX(-2), 1.0, STATION_Z, 'medium_high',
            new THREE.Vector3(0, 0, 1));
        shooters.push(turret);
        collidables.push(turret.mesh);

        // -3 - lock: the unlock mechanic.
        const lock = createLockInstance();
        if (lock) {
            lock.position.set(stationX(-3), 0, STATION_Z);
            levelGroup.add(lock);
        }

        // -4 - a raised platform to fall from, for the ragdoll shot.
        addBox(stationX(-4), cubeSize * 2, STATION_Z, 2, 4, 2);

        // +5 - the finish diamond, at the end of the row where it belongs.
        // Sat on the ground rather than floating: the octahedron's radius is
        // 1.2, so that is exactly how high its centre has to be for the bottom
        // vertex to touch. Note it disappears once the character gets within
        // 3 units (that is the level-complete check), so shoot it from further
        // back than that.
        star.position.set(stationX(5), 1.2, STATION_Z);
        star.visible = true;
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
        // Level 2 (buildLevelFromGlb) and the water test level both hide
        // this in favor of a water plane - reset here so switching back to
        // any other level always gets the grass back regardless of which
        // level was active before.
        ground.visible = true;
        // Same idea as ground.visible above: the blank level recolours shared
        // scene state (ground material, sky, fog), so every other level has to
        // put it back rather than assuming it was never touched.
        if (currentLevel !== "local_blank") setPresentationGreyscale(false);
        // EVERY body, not just defaultWaterBody: a body created by one level
        // (the Water Test level's pond) outlives that level - it is a
        // module-scope `let`, still in waterBodies, still holding its own
        // uWaterLevel - so leaving its foam enabled made materials bound to
        // it keep painting a band at the pond's height (2.5) in completely
        // unrelated levels. That is exactly the "objects higher up get foam
        // in Level 2" bug. Each level re-enables only the bodies it uses.
        waterBodies.forEach(wb => { wb.uniforms.uFoamEnabled.value = 0; });
        // Whichever level rebuilds next re-links its own water mesh(es) -
        // stale entries here would otherwise point at Object3Ds this same
        // levelGroup.remove() loop above just detached from the scene.
        waterMeshSyncs.length = 0;
        // Same idea for the village level's NPC/quest/dialogue state -
        // without disposing it, switching away still left villageNpcAvatar
        // (and its group, added directly to `scene` by RemoteAvatar's own
        // constructor - NOT levelGroup, so the levelGroup.remove() loop
        // above never touches it) alive and visible in totally unrelated
        // levels, and the proximity check kept comparing against its last
        // position forever.
        if (villageNpcAvatar) { villageNpcAvatar.dispose(); villageNpcAvatar = null; }
        villageDialogueActive = false;
        window.dialogueInputLocked = false;
        window.compassTarget = null;
        const dialogueBoxEl = document.getElementById('dialogue-box');
        if (dialogueBoxEl) dialogueBoxEl.style.display = 'none';

        if (currentLevel === "local_blank") buildBlankLevel();
        else if (currentLevel === "local_stairs") buildStairsLevel();
        else if (currentLevel === "local_glb") buildLevelFromGlb();
        else if (currentLevel === "local_water") buildWaterTestLevel();
        else if (currentLevel === "local_json") buildLevelFromJson(level2Json);
        else if (currentLevel === "local_village") buildVillageLevel();
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

        // Last, so the scatter's "is this spot free?" probe sees every
        // collidable the level registered - including the sacks above.
        // Anything that loads asynchronously afterwards (the Jar.fbx props)
        // can still land on a tuft; window.rebuildGrass() re-scatters.
        // The water level is almost entirely open water - the scatter has
        // no notion of "is there actually ground here" (it only rejects
        // spots where something blocks the ray too close to y=0), so
        // tufts were landing right on/through the water plane. Skip it
        // for this level rather than special-casing that assumption.
        if (currentLevel === "local_water") clearGrass(); else buildGrass();
    }

    async function populateLevelsAndLoad() {
        const select = document.getElementById('level-select');
        select.innerHTML = '<option value="local_stairs">Level 1 (Stairs)</option><option value="local_glb">Level 2 (Model)</option><option value="local_json">Level 3 (JSON)</option><option value="local_water">Water Test</option><option value="local_village">Village</option><option value="local_blank">Blank (UI screenshots)</option>';
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
    // Re-applies immediately rather than waiting for a level rebuild, so the
    // backdrop can be flipped while lining a shot up.
    document.getElementById('toggle-blank-white').addEventListener('change', () => {
        if (currentLevel === 'local_blank') setPresentationGreyscale(true);
    });

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
    // Gradual "step back to make room" phase, run when something's too close
    // in front for the object to land clear of it (see attemptCarryAction
    // below) - slides the player backward rather than snapping them back
    // instantly (that read as the player teleporting) or leaving the object
    // to spawn embedded (that read as the object teleporting once the physics
    // loop shoved it back out).
    //
    // The drop/throw now runs CONCURRENTLY with this slide, not after it -
    // see attemptCarryAction. makeRoomDuration is therefore per-action rather
    // than a constant: a drop matches carryDropDuration() so the slide and
    // the lowering land on the same frame, a throw keeps the short default.
    let isMakingRoom = false;
    let makeRoomElapsed = 0;
    const makeRoomStartPos = new THREE.Vector3();
    const makeRoomTargetPos = new THREE.Vector3();
    const MAKE_ROOM_DURATION = 0.17;
    let makeRoomDuration = MAKE_ROOM_DURATION;
    // Set only for a throw whose launch point is blocked - the one action that
    // still has to wait for the slide to finish instead of running with it.
    // See attemptCarryAction.
    let pendingCarryAction = null;
    const _throwLaunchProbe = new THREE.Vector3();
    const carryBtn = document.getElementById('carry-btn');
    const dropBtn = document.getElementById('drop-btn');
    const throwBtn = document.getElementById('throw-btn');
    // Punch's own click/charge handling lives in ClimbGame.html (tied to
    // the Character class), but its on-screen visibility is driven from
    // here since that's where isLedgeGrabbing/isCarryingObj are already
    // read every frame for the hold/carry buttons - see the per-frame
    // update below.
    const punchBtnEl = document.getElementById('punch-btn');

    const pickupStartPos = new THREE.Vector3();
    const pickupStartRot = new THREE.Quaternion();
    const pickupTargetRot = new THREE.Quaternion();

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

    // Tests whether a carryable-sized box (_carrySizeVec - the same 1x1x1
    // box the per-frame physics loop above resolves overlaps against, see
    // its own comment on why that's a fixed size regardless of the actual
    // model) at `pos` overlaps any solid collidable. Used by both drop and
    // throw below so neither ever hands an object off to that physics loop
    // already embedded in something - an object that spawns overlapping
    // gets shoved out sideways by that loop's X/Z push-out in a single,
    // un-animated step the very next frame, which is what reads as the
    // object "teleporting" next to whatever it was placed into.
    const _carryOverlapBox = new THREE.Box3();
    const _carryObstacleBox = new THREE.Box3();
    function overlapsSolidCollidable(pos, excludeMesh) {
        _carryOverlapBox.setFromCenterAndSize(pos, _carrySizeVec);
        return collidables.some(obj => {
            if (obj === ground || obj === excludeMesh || (obj.userData && (obj.userData.isCarryable || obj.userData.isSandbagCollider)) || activeLockInstances.includes(obj)) return false;
            getObstacleBox(obj, _carryObstacleBox);
            return _carryOverlapBox.intersectsBox(_carryObstacleBox);
        });
    }

    // Whether `pos` is solid ground to stand on - a real collidable OR
    // plain open ground (ground itself counts here, unlike the drop
    // search above which deliberately excludes it - see its own comment)
    // - and roughly the same height as the player's current spot, not a
    // big drop or rise. Used before gradually stepping the player back to
    // make room for a drop/throw: stepping back without checking what's
    // actually behind them is what glitched on a narrow elevated block
    // yesterday - it could walk them straight off the platform's back
    // edge into open air.
    const _safeSpotProbe = new THREE.Vector3();
    function isSafeStandingSpot(pos, referenceY) {
        _safeSpotProbe.set(pos.x, referenceY + 2.0, pos.z);
        rayDown.set(_safeSpotProbe, _downVec);
        const hits = rayDown.intersectObjects(collidables.filter(c => c !== heldCarryable).concat(ground));
        return hits.length > 0 && Math.abs(hits[0].point.y - referenceY) < 0.6;
    }

    carryBtn.addEventListener('pointerdown', () => {
        if (!window.isCarryingObj && !window.isCarryStarting && !window.isCarryDropping && !isMakingRoom && carryTargetObj) {
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

    // Tries a drop/throw immediately; if a wall's close enough in front
    // that the object couldn't land clear of it, steps the player back
    // first (gradually - see isMakingRoom above) so the normal full-reach
    // placement below has room, instead of relying only on that
    // placement logic's own closer-in fallback (still there as a backup
    // for when no safe spot exists to step back into at all, e.g. boxed
    // in on multiple sides).
    function attemptCarryAction(action) {
        _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);
        // Same margin the drop/throw placement logic itself needs: how
        // far forward an object has to clear (DROP_DISTANCE) plus its own
        // rough half-width (matches _carrySizeVec/2) - plus a small extra
        // buffer so the object's box ends up genuinely clear of the wall's
        // rather than exactly touching it. Exactly touching (no buffer)
        // still reads as an overlap to the physics loop's Box3 check (its
        // bounds compare inclusively, same reason the floor-landing height
        // below uses 0.51 instead of 0.5) and got the object shoved
        // sideways anyway even after stepping the player back.
        const NEEDED_CLEARANCE = 1.72;
        rayFwd.set(_tempVec2.copy(char.group.position).setY(char.group.position.y + 0.5), _tempVec3);
        const wallHits = rayFwd.intersectObjects(collidables.filter(c => c !== heldCarryable && c !== ground));

        // For a DROP, ask the placement search directly: is there already a
        // good spot to put this down, right here, without moving? If so
        // there's nothing to make room for - whatever the forward probe hit
        // is something we can place on or beside, not something in the way.
        //
        // This replaces judging the obstacle by its height alone. Height
        // answers "could I put it on top of that?" but not "is there
        // anywhere clear to put it?", and only the second question decides
        // whether stepping back helps. A low block with a wall right behind
        // it passes the height test and still has nowhere clear at full
        // reach; a tall pillar off to one side fails the height test while
        // the spot in front of it is perfectly fine.
        //
        // dist is required to be near the full reach: a "clear" spot that is
        // only reachable at 0.3 means the object would be set down almost
        // between the player's feet, which is exactly what stepping back
        // exists to avoid.
        if (action === 'drop') {
            const here = findDropPlacement(char.group.position, _tempVec3, 0.51);
            if (here.clear && here.dist >= 0.9) { performDrop(); return; }
        }

        // A THROW has a much weaker requirement than a drop: the object leaves
        // the hand with velocity immediately, so all it needs is a launch
        // point that isn't already inside something. It does NOT need the
        // 1.72 of forward room a drop needs to set the object DOWN. Checking
        // the real launch point (hand + the same 0.15 nudge performThrow
        // applies) instead of that placement margin means a throw next to a
        // wall just fires, with no step-back and no stutter.
        if (action === 'throw') {
            const held = carryables.find(c => c.mesh === heldCarryable);
            if (!held) { performThrow(); return; }
            _throwLaunchProbe.copy(held.mesh.position).addScaledVector(_tempVec3, 0.15);
            if (!overlapsSolidCollidable(_throwLaunchProbe, held.mesh)) { performThrow(); return; }
            // Launch point IS blocked. This is the one case that genuinely has
            // to wait: the object can only be released once the slide has
            // opened up room, so the throw is deferred to the end of the
            // step-back rather than run alongside it. Releasing it early would
            // spawn it inside the wall and the physics would fling it out.
        }

        // Otherwise find the nearest hit that actually BLOCKS, so the
        // step-back distance is measured against the real obstruction.
        // Anything low enough to set the object on top of is skipped: on
        // stairs the probe hits the next riser first, and judging only
        // wallHits[0] let that low riser mask a genuine wall behind it.
        // (intersectObjects returns hits sorted near-to-far.)
        let blocking = null;
        for (const h of wallHits) {
            if (action === 'drop' && obstacleIsLowEnoughToDropOnto(h.object)) continue;
            blocking = h;
            break;
        }
        if (blocking && blocking.distance < NEEDED_CLEARANCE) {
            const backstepNeeded = NEEDED_CLEARANCE - blocking.distance;
            const candidate = _makeRoomCandidate.copy(char.group.position).addScaledVector(_tempVec3, -backstepNeeded);
            if (isSafeStandingSpot(candidate, char.group.position.y)) {
                isMakingRoom = true;
                makeRoomElapsed = 0;
                makeRoomStartPos.copy(char.group.position);
                makeRoomTargetPos.copy(candidate).setY(char.group.position.y);
                // Run the step-back and the action TOGETHER rather than one
                // after the other. Sequencing them was the "player slides,
                // then the drop happens" awkwardness: two short motions read
                // as one long stutter. The placement is computed from
                // makeRoomTargetPos - where the player is about to BE - so
                // the object still lands in the cleared spot even though the
                // player hasn't arrived yet. The drop lerp tracks the live
                // hand bones (see the isCarryDropping branch in animate), so
                // the object rides the slide and eases onto the fixed world
                // target; nothing pops.
                //
                // A blocked throw is the exception - it waits for the slide to
                // finish (see pendingCarryAction) because its launch point is
                // only clear once the player has actually moved.
                if (action === 'drop') {
                    // Matched durations so the slide and the lowering finish
                    // on the same frame.
                    makeRoomDuration = carryDropDuration();
                    performDrop(makeRoomTargetPos);
                } else {
                    makeRoomDuration = MAKE_ROOM_DURATION;
                    pendingCarryAction = 'throw';
                }
                return;
            }
            // No safe spot to step back into (e.g. boxed in on more than
            // one side) - fall through to the immediate attempt below;
            // its own overlap-avoidance still keeps the object from
            // spawning embedded, it just won't have full room to work with.
        }
        if (action === 'drop') performDrop(); else performThrow();
    }
    const _makeRoomCandidate = new THREE.Vector3();

    // Is the thing the forward ray hit short enough to place the carried
    // object on top of, instead of backing away from it? Measured from the
    // player's own feet up to the obstacle's box top, against
    // window.dropOnTopMaxHeight (Carry & Throw panel).
    const _dropOnTopBox = new THREE.Box3();
    function obstacleIsLowEnoughToDropOnto(hitObject) {
        // intersectObjects recurses, so the hit can be a child mesh - walk up
        // to the registered collidable so the box covers the whole obstacle.
        let obstacle = hitObject;
        while (obstacle && !collidables.includes(obstacle) && obstacle.parent) obstacle = obstacle.parent;
        if (!obstacle || obstacle === ground) return false;
        getObstacleBox(obstacle, _dropOnTopBox);
        const maxH = window.dropOnTopMaxHeight !== undefined ? window.dropOnTopMaxHeight : 1.5;
        return (_dropOnTopBox.max.y - char.group.position.y) <= maxH;
    }

    // How long the drop's lowering motion takes. Shared by the animate()
    // branch that drives it and by the step-back above, which matches its
    // own duration to this so the two finish together.
    function carryDropDuration() {
        const clipDur = char.originalClips['carry_start'] ? char.originalClips['carry_start'].duration : 0.667;
        const speedMult = window.carryDropSpeedMult !== undefined ? window.carryDropSpeedMult : 2.2;
        return window.carryDropLowerDuration !== undefined ? window.carryDropLowerDuration : (clipDur / speedMult);
    }

    // Searches forward from refPos for somewhere to set the carried object
    // down: the full arm's reach first, then progressively closer. Returns
    // { dist, floorY, clear }.
    //
    // `clear` is the important part - it means the chosen spot is genuinely
    // free, not just the least-bad option. The caller steps the player back
    // when it's false, because handing an object to the carryable physics
    // already embedded in something gets it shoved sideways in a single
    // un-animated step (which reads as the object teleporting).
    //
    // Two things this has to tell apart that used to look identical, both of
    // which put the object somewhere wrong:
    //   - open ground vs a VOID. The probe used to exclude `ground`, so
    //     "flat grass ahead" and "standing at a ledge with nothing ahead"
    //     both came back as no-hit, and the object got placed at the
    //     player's own height either way - over the drop in the second case.
    //     Ground is included here and the hit height is range-checked
    //     instead.
    //   - a surface too HIGH to place onto vs no surface. A hit above the
    //     reach is skipped so a closer candidate gets tried, rather than
    //     being treated as a floor.
    const _dropScratch = new THREE.Vector3();
    const _dropCandidate = new THREE.Vector3();
    const DROP_DISTANCE = 1.2;
    function findDropPlacement(refPos, fwd, heightOffset) {
        // How far ABOVE the player's feet a surface can be and still be
        // something to place onto - the Carry & Throw panel's Drop-On-Top Max
        // Height.
        const reach = window.dropOnTopMaxHeight !== undefined ? window.dropOnTopMaxHeight : 1.5;
        // How far BELOW the feet still counts as "somewhere in front of me to
        // set this down" rather than a drop-off to avoid placing out over.
        // Symmetric with the reach above, so one knob covers both directions.
        //
        // This was briefly 0.6, which was far too strict: setting an object
        // down on a ledge a step below you is completely normal, and the
        // tight limit rejected those spots and pulled the drop all the way
        // back to the player's own feet.
        const MAX_STEP_DOWN = reach;
        const probeTargets = collidables.filter(c => c !== heldCarryable);
        let fallback = null;
        // Why each candidate distance was passed over, for _dbgLastDrop. Cheap
        // (a few short strings on a button press) and it is the difference
        // between diagnosing a bad drop from a report and guessing at it.
        const tried = [];
        for (const dist of [DROP_DISTANCE, 0.9, 0.6, 0.3, 0]) {
            _dropScratch.copy(refPos).addScaledVector(fwd, dist).setY(refPos.y + 3.0);
            rayDown.set(_dropScratch, _downVec);
            const hits = rayDown.intersectObjects(probeTargets);
            if (!hits.length) { tried.push(dist + ':nothing-below'); continue; }
            const floorY = hits[0].point.y;
            const rel = +(floorY - refPos.y).toFixed(2);
            if (floorY > refPos.y + reach) { tried.push(dist + ':too-high(' + rel + ')'); continue; }
            if (floorY < refPos.y - MAX_STEP_DOWN) { tried.push(dist + ':too-low(' + rel + ')'); continue; }
            _dropCandidate.copy(refPos).addScaledVector(fwd, dist).setY(floorY + heightOffset);
            if (!overlapsSolidCollidable(_dropCandidate, heldCarryable)) {
                tried.push(dist + ':OK(' + rel + ')');
                return { dist, floorY, clear: true, tried };
            }
            tried.push(dist + ':overlaps(' + rel + ')');
            fallback = fallback || { dist, floorY };
        }
        // Nothing clear anywhere. Land it at the player's own feet - a spot
        // they are demonstrably standing in legally - rather than at the
        // embedded candidate further out, which is what the physics loop
        // would then have to shove out of the way.
        return { dist: 0, floorY: refPos.y, clear: false, tried };
    }

    // refPos: where to compute the placement FROM. Defaults to the player's
    // current position; the step-back path passes the position the player is
    // sliding toward, so the drop can start on the same frame as the slide
    // and still target the spot that's about to be cleared.
    function performDrop(refPos) {
        if (window.isCarryingObj && heldCarryable) {
            const dropRefPos = refPos || char.group.position;
            window.isCarryDropping = true;
            carryStartElapsed = 0;

            dropStartRot.copy(heldCarryable.quaternion);

            _tempVec3.set(0, 0, 1).applyQuaternion(char.group.quaternion);

            // 0.51, not 0.5: dropping it landing EXACTLY on a surface's own
            // top (touching, not clear of it) reads as a horizontal
            // collision to the carryable physics loop the instant it
            // resumes (X/Z overlap is resolved before Y each substep - see
            // spawnStairJar's comment for the full mechanism) and shoves it
            // sideways off whatever it was dropped onto. Confirmed live:
            // at exactly +0.5 a box dropped near a platform's edge jumped
            // about a full unit sideways the same frame; +0.51 didn't move
            // at all. Harmless on flat ground too (ground is excluded from
            // that collision loop entirely), so no need to special-case it.
            // Computed up front (not after picking dropDist below) since
            // the overlap check in that search needs the object's real
            // final Y, not just its X/Z, to test accurately.
            let objectHeightOffset = 0.51;
            if (heldCarryable.geometry) {
                if (heldCarryable.geometry.type === 'SphereGeometry') objectHeightOffset = 0.51;
                else if (heldCarryable.geometry.type === 'CylinderGeometry') objectHeightOffset = 0.51;
                else if (heldCarryable.geometry.type === 'RoundedBoxGeometry') objectHeightOffset = 0.51;
            }

            // Full arm's reach first, then progressively closer - a fixed
            // 1.2-unit forward offset regularly overshoots the edge of the
            // narrower steps in this level (only cubeSize=3 wide). See
            // findDropPlacement for what makes a candidate acceptable.
            const placement = findDropPlacement(dropRefPos, _tempVec3, objectHeightOffset);
            window._dbgLastDrop = {
                dist: placement.dist, floorY: +placement.floorY.toFixed(3), clear: placement.clear,
                feetY: +dropRefPos.y.toFixed(3), steppedBack: !!refPos,
                reach: window.dropOnTopMaxHeight, tried: placement.tried,
            };
            dropTargetPos.copy(dropRefPos).addScaledVector(_tempVec3, placement.dist);
            dropTargetPos.y = placement.floorY + objectHeightOffset;
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
    }

    function performThrow() {
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
                // velocity. Skipped if that nudge would land inside
                // something solid right in front (a wall thrown into
                // point-blank) - isCarried just went false above, so the
                // very next physics substep would otherwise shove the
                // object sideways out of that overlap before its own throw
                // velocity ever got a chance to carry it anywhere, reading
                // as if it launched from the wall's own side instead of the
                // player's hand.
                _tempVec2.copy(cObj.mesh.position).addScaledVector(_tempVec3, 0.15);
                if (!overlapsSolidCollidable(_tempVec2, cObj.mesh)) cObj.mesh.position.copy(_tempVec2);

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
    }

    dropBtn.addEventListener('pointerdown', () => {
        if (window.isCarryingObj && heldCarryable && !isMakingRoom) attemptCarryAction('drop');
    });

    throwBtn.addEventListener('pointerdown', () => {
        if (window.isCarryingObj && heldCarryable && !isMakingRoom) attemptCarryAction('throw');
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
            isMakingRoom = false;
            // Must be cleared with isMakingRoom. Left set, a deferred throw
            // survives the reset and fires at the end of some LATER step-back
            // - during a drop - nulling heldCarryable out from under the
            // drop's own animate branch, which then never runs its end
            // condition and leaves the character stuck in the drop pose.
            pendingCarryAction = null;
            heldCarryable = null;
            document.getElementById('drop-btn').style.display = 'none';
            document.getElementById('throw-btn').style.display = 'none';
            if (char) char.stopUpperAction(0.2);
        }
    }
    window.forceDropCarriedObject = forceDropCarriedObject;

    const input = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    // shift: held to run on keyboard - see the moveMag calc below, WASD
    // alone only ever walks now instead of always landing at full run
    // magnitude.
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    // Tighter than the naive full spherical range [0.1, 3.0] on purpose -
    // the follow-cam formula down in animate() (targetCamX/Y/Z) scales
    // its HORIZONTAL offset from the player by sin(cameraPhi), which
    // shrinks toward 0 as phi approaches either pole. With the old wider
    // range, tilting the view far up or down swung the camera in close to
    // directly above/below the player (radius stayed the same, but almost
    // none of it was horizontal anymore) - reads as the camera suddenly
    // rushing toward the player. This range still allows a good look up/
    // down sweep, just stops short of the extremes where that shrink
    // becomes severe.
    const CAMERA_PHI_MIN = 0.5, CAMERA_PHI_MAX = 2.6;
    // Live-tunable via the panel's "Camera" sliders:
    // - cameraDistance: the normal orbit distance (was a fixed 12, felt
    //   too far - now adjustable, and also the value cameraRadius starts
    //   at below).
    // - cameraCloseStartElevation: the camera elevation ABOVE THE HORIZON,
    //   in degrees, at which the follow-cam starts closing in on the player
    //   as it keeps descending. 90 = straight overhead, 0 = level with the
    //   player, negative = below. At 45 the approach begins while the camera
    //   is still well above the player and reaches cameraMinCloseDistance at
    //   the bottom clamp (CAMERA_PHI_MAX). Set very low (e.g. -30) to
    //   effectively disable the downward close-in.
    // - cameraCloseStartAngle: the same idea for the TOP of the range - how
    //   close cameraPhi has to get to CAMERA_PHI_MIN (in radians) before the
    //   horizontal distance starts shrinking. 0 disables it.
    // - cameraMinCloseDistance: the horizontal distance it shrinks toward
    //   right at the clamp limits.
    // See the targetCamX/Y/Z block in animate() for where these are read.
    window.cameraDistance = 13.0;
    window.cameraCloseStartElevation = 45.0;
    window.cameraCloseStartAngle = 0.7;
    window.cameraMinCloseDistance = 5.0;
    let cameraTheta = 0, cameraPhi = Math.PI/3, cameraRadius = window.cameraDistance, yVelocity = 0;

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
    // Camera-rotate joystick (right stick): kept fully working in code, but
    // hidden by default now that screen-drag rotation (dragRotateSensitivity
    // above) is the primary way to turn the camera and a second, redundant
    // control for the same thing was judged unnecessary clutter. Flip this
    // to true (e.g. from devtools) to bring it back if drag-only doesn't
    // hold up in real testing - setupJoystick above still wires it either
    // way, this only controls whether it's shown/reachable on screen.
    window.cameraJoystickEnabled = false;
    const baseRightEl = document.getElementById('base-right');
    if (baseRightEl) baseRightEl.style.display = window.cameraJoystickEnabled ? 'flex' : 'none';

    let stamina = 100, isGrounded = false, isLedgeGrabbing = false, isClimbingUp = false, ledgeTarget = new THREE.Vector3(), jumpMomentum = new THREE.Vector3();
    // Set true the instant a ledge grab commits (position also hard-snaps
    // onto the wall that same frame - see isLedgeGrabbing's own set site).
    // Consumed (and cleared) the very next frame, the first one the 'ledge'
    // state's own animate() call actually runs - passed through as
    // forceSnap so that one frame cuts straight to the hang pose instead of
    // the usual 0.2s crossfade. Blending a still-outstretched falling pose
    // at a position that's already snug against the wall was exactly what
    // read as the head clipping into the wall - there's no physically
    // sensible in-between pose to blend through when the position itself
    // didn't ease in either.
    let justGrabbedLedge = false;
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
    // Ground-planting leg IK strength, faded to 0 while sliding so the slide
    // clip's own foot pose isn't overwritten - see its use in animate().
    let legIKBlend = 1;
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
    let ledgeCornerBufferApplied = false;
    let ledgeCornerRetreating = false;
    const ledgeCornerRetreatTarget = new THREE.Vector3();
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
    // How high above the player's feet a surface can be and still be somewhere
    // to set a carried object down. Below this, a drop places the object on
    // the surface (a knee-high block, a step, a crate) instead of stepping the
    // player away from it; above it, the surface counts as a wall and the
    // step-back-to-make-room behaviour applies. Single knob: it is both the
    // drop placement's upward reach and the wall/ledge cutoff, so lowering it
    // really does turn low blocks back into walls. 1.5 is the reach this used
    // to have hardcoded.
    window.dropOnTopMaxHeight = 1.5;
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
    // Matches orangeRecoilForce's own default - a mature charge punch
    // should launch its target exactly as far as an orange-intensity hit
    // does, not by its own separate, much weaker number.
    window.chargePunchKnockback = 60.0;
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
    // How much of the stagger pool each hit tier chips away (ClimbGame.html's
    // AI-bot block and multiplayer.js's _applyPunchEvent both read these).
    // Tuned so the full left->right->5-hit combo (6 'medium' hits at the
    // escalating-but-capped-under-45 forceMagnitude, then one 'medium_high'
    // final blow) lands right at the edge of the pool (6*10 + 35 = 95 of
    // 100) instead of emptying it partway through - the whole combo should
    // stagger hard without alone causing a knockdown; a bit more punching
    // after that is what should tip it into ragdoll.
    window.staggerDamageMedium = 10.0;
    window.staggerDamageMediumHigh = 35.0;
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
        if (window.dialogueInputLocked) return;
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

    window.addEventListener('keydown', e => { if (window.editorModeActive) return; const k = e.key.toLowerCase(); if (keys.hasOwnProperty(k)) keys[k] = true; if (e.code === 'Space') handleJump(); if (k === 'l' && window.debugTestLockGroup) revealLockStar(window.debugTestLockGroup); });
    window.addEventListener('keyup', e => { const k = e.key.toLowerCase(); if (keys.hasOwnProperty(k)) keys[k] = false; });
    document.getElementById('jump-btn').addEventListener('pointerdown', handleJump);

    // Look-drag. lookPointerId (not a bare boolean) is what makes this work
    // alongside the joysticks on touch: with two fingers down, every one of
    // these window-level handlers fires for BOTH pointers. Without an id
    // check the joystick finger's moves were being fed into the camera as
    // well - and since lX/lY were overwritten by whichever pointer moved
    // last, each frame's delta was measured between the two fingers, which
    // is what threw the camera around. The same went for pointerup: lifting
    // the joystick finger ended a look drag that a different finger was
    // still performing. null = no look drag in progress.
    // Multiplies the raw per-pixel drag-to-rotate rate below (see the
    // 'pointermove' handler's cameraTheta/cameraPhi math) - a friend
    // testing the game needed 3-4 separate drags to reach the angle they
    // wanted, since a direct 1:1(ish) pixel mapping is bounded by how far
    // a thumb can physically travel across the screen before it has to
    // lift and re-grip. Live-tunable (see the debug panel slider) so this
    // can be dialed in without a reload; default 2 doubles the old rate.
    window.dragRotateSensitivity = 3.0;
    let lookPointerId = null, lX, lY;
    window.addEventListener('pointerdown', e => {
        if (lookPointerId !== null) return;   // one look finger at a time
        // Circular (not square) exclusion around each bottom corner - same
        // 200px reach along both edges as the old square check, just
        // rounded off along the diagonal instead of blocking a full corner
        // rectangle. Radius must match DRAG_DEADZONE_RADIUS in ClimbGame.html
        // (the "Show Drag Dead-Zone" debug overlay) exactly, or the overlay
        // would show a boundary that isn't the real one.
        const DRAG_DEADZONE_RADIUS = 200;
        if (Math.hypot(e.clientX, e.clientY - window.innerHeight) < DRAG_DEADZONE_RADIUS) return;
        if (Math.hypot(e.clientX - window.innerWidth, e.clientY - window.innerHeight) < DRAG_DEADZONE_RADIUS) return;
        if (!e.target.closest('.joystick-base') && e.target.id.indexOf('btn') === -1 && !e.target.closest('#ui')) { lookPointerId = e.pointerId; lX=e.clientX; lY=e.clientY; }
    });
    window.addEventListener('pointermove', e => { if (e.pointerId === lookPointerId) { const s = 0.005 * window.dragRotateSensitivity; cameraTheta -= (e.clientX-lX)*s; cameraPhi = Math.max(CAMERA_PHI_MIN, Math.min(CAMERA_PHI_MAX, cameraPhi-(e.clientY-lY)*s)); lX=e.clientX; lY=e.clientY; } });
    const endLookDrag = e => { if (e.pointerId === lookPointerId) lookPointerId = null; };
    window.addEventListener('pointerup', endLookDrag);
    window.addEventListener('pointercancel', endLookDrag);
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
        { id: 'drop-ontop-height-slider', vId: 'drop-ontop-height-val', func: v => window.dropOnTopMaxHeight = v, fix: 2 },
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
        { id: 'camera-distance-slider', vId: 'camera-distance-val', func: v => { window.cameraDistance = v; cameraRadius = v; }, fix: 1 },
        { id: 'camera-close-elev-slider', vId: 'camera-close-elev-val', func: v => window.cameraCloseStartElevation = v, fix: 0 },
        { id: 'drag-rotate-sensitivity-slider', vId: 'drag-rotate-sensitivity-val', func: v => window.dragRotateSensitivity = v, fix: 1 },
        // Grass rebuilds the whole instanced field, so these re-scatter on
        // release rather than on every input tick - see the 'change' wiring
        // below for that; the func here only records the value.
        { id: 'grass-count-slider', vId: 'grass-count-val', func: v => window.grassCount = v, fix: 0 },
        { id: 'grass-size-slider', vId: 'grass-size-val', func: v => window.grassSize = v, fix: 2 },
        { id: 'grass-area-slider', vId: 'grass-area-val', func: v => window.grassArea = v, fix: 0 },
        { id: 'grass-height-slider', vId: 'grass-height-val', func: v => window.grassHeight = v, fix: 2 },
        // Slider is a whole-number percent (0-30) for a more readable label
        // than a 0.00-0.30 fraction; grassBaseSink itself stays a fraction.
        { id: 'grass-sink-slider', vId: 'grass-sink-val', func: v => window.grassBaseSink = v / 100, fix: 0, raw: true },
        // Alpha cutoff bypasses this table's normal path (which only records
        // the value - a rebuild is wired separately below per-slider) since
        // it doesn't need clearGrass()/re-placement at all, just a material
        // property flip. Handled entirely by its own 'input' listener further
        // down instead of a func here, for instant feedback while dragging.
        { id: 'camera-close-start-slider', vId: 'camera-close-start-val', func: v => window.cameraCloseStartAngle = v, fix: 2 },
        { id: 'camera-close-min-slider', vId: 'camera-close-min-val', func: v => window.cameraMinCloseDistance = v, fix: 1 },
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
    document.getElementById('toggle-speed-label').addEventListener('change', e => {
        if (window._speedLabelSprite) window._speedLabelSprite.visible = e.target.checked;
    });
    // Grass: re-scatter on 'change' (slider release / checkbox click) rather
    // than 'input'. Each rebuild raycasts once per tuft and rebuilds two
    // InstancedMeshes, which is far too heavy to run on every drag tick.
    ['grass-count-slider', 'grass-size-slider', 'grass-area-slider', 'grass-height-slider', 'grass-sink-slider'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => buildGrass());
    });
    const grassToggleEl = document.getElementById('toggle-grass');
    if (grassToggleEl) grassToggleEl.addEventListener('change', () => buildGrass());
    // Alpha cutoff: a straight material property, no ray-cast placement
    // involved, so it updates on 'input' (live, while dragging) rather than
    // waiting for 'change' like the others - the whole point of exposing
    // this is to let the cutoff be dialed in by eye.
    const grassAlphaEl = document.getElementById('grass-alpha-slider');
    if (grassAlphaEl) grassAlphaEl.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.grassAlphaTest = v;
        grassMats.forEach(m => { m.alphaTest = v; m.needsUpdate = true; });
        const disp = document.getElementById('grass-alpha-val');
        if (disp) disp.innerText = v.toFixed(2);
    });

    // Foam thickness, live on 'input' (no rebuild needed) - animate() copies
    // both globals into the shader uniforms every frame, so dragging these
    // updates the waterline immediately on every foamed object at once.
    const foamScaleEl = document.getElementById('foam-scale-slider');
    if (foamScaleEl) foamScaleEl.addEventListener('input', e => {
        window.foamDepthScale = parseFloat(e.target.value);
        const d = document.getElementById('foam-scale-val');
        if (d) d.innerText = window.foamDepthScale.toFixed(2);
    });
    const foamCharEl = document.getElementById('foam-char-slider');
    if (foamCharEl) foamCharEl.addEventListener('input', e => {
        window.charFoamScale = parseFloat(e.target.value);
        const d = document.getElementById('foam-char-val');
        if (d) d.innerText = window.charFoamScale.toFixed(2);
    });
    // Water surface pattern controls (see createStylizedWaterMaterial) -
    // same live-on-'input' pattern as the foam sliders above, synced into
    // every water body's material each frame in animate().
    [
        ['water-lines-scale-slider', 'water-lines-scale-val', 'waterLinesScale'],
        ['water-lines-opacity-slider', 'water-lines-opacity-val', 'waterLinesOpacity'],
        ['water-lines-speed-slider', 'water-lines-speed-val', 'waterLinesSpeed'],
        ['water-lines-thickness-slider', 'water-lines-thickness-val', 'waterLinesThickness'],
    ].forEach(([sliderId, valId, key]) => {
        const el = document.getElementById(sliderId);
        if (!el) return;
        el.addEventListener('input', e => {
            window[key] = parseFloat(e.target.value);
            const d = document.getElementById(valId);
            if (d) d.innerText = window[key].toFixed(2);
        });
    });

    document.getElementById('toggle-step-labels').addEventListener('change', e => {
        stairNumberLabels.forEach(l => { l.visible = e.target.checked; });
    });
    document.getElementById('toggle-fps').addEventListener('change', e => {
        if (fpsCounterEl) fpsCounterEl.style.display = e.target.checked ? 'block' : 'none';
    });
    // ---- UI panel: re-enable elements hidden from the default control set ----
    // Both start unchecked/off, matching how the game actually ships - these
    // exist purely so the elements can be brought back for testing without
    // digging into code (see the "UI" debug panel category in ClimbGame.html).
    const toggleCameraJoystickEl = document.getElementById('toggle-camera-joystick');
    if (toggleCameraJoystickEl) toggleCameraJoystickEl.addEventListener('change', e => {
        window.cameraJoystickEnabled = e.target.checked;
        const el = document.getElementById('base-right');
        if (el) el.style.display = e.target.checked ? 'flex' : 'none';
    });
    window.buildButtonEnabled = false;
    const toggleBuildBtnEl = document.getElementById('toggle-build-btn');
    if (toggleBuildBtnEl) toggleBuildBtnEl.addEventListener('change', e => {
        window.buildButtonEnabled = e.target.checked;
        const el = document.getElementById('build-btn');
        if (el) el.style.display = e.target.checked ? 'flex' : 'none';
    });
    // Punch's own visibility is recomputed every frame (see punchBtnEl's
    // per-frame update, gated on carry/ledge state) rather than set once
    // here - this checkbox just flips the master on/off flag that gate
    // also checks, it doesn't touch style directly (the per-frame update
    // would immediately overwrite a direct set here anyway).
    window.punchButtonEnabled = false;
    const togglePunchBtnEl = document.getElementById('toggle-punch-btn');
    if (togglePunchBtnEl) togglePunchBtnEl.addEventListener('change', e => { window.punchButtonEnabled = e.target.checked; });
    // Visualizes the two screen corners the look-drag pointerdown handler
    // (see lookPointerId above) deliberately ignores, so a thumb reaching
    // for the joystick/action buttons can't accidentally start rotating the
    // camera instead - purely a debug overlay (pointer-events: none, doesn't
    // change the actual dead-zone logic) so it can be seen during UX testing
    // without guessing the numbers.
    window.showDragDeadZone = false;
    const toggleDragDeadZoneEl = document.getElementById('toggle-drag-deadzone');
    if (toggleDragDeadZoneEl) toggleDragDeadZoneEl.addEventListener('change', e => {
        window.showDragDeadZone = e.target.checked;
        const display = e.target.checked ? 'block' : 'none';
        const l = document.getElementById('drag-deadzone-left'); if (l) l.style.display = display;
        const r = document.getElementById('drag-deadzone-right'); if (r) r.style.display = display;
    });

    // Reverse of the follow-cam formula a few hundred lines down
    // (targetCamX/Y/Z from camTarget + cameraRadius/cameraTheta/cameraPhi) -
    // solves for the orbit angles/radius that reproduce the camera's
    // CURRENT actual position relative to camTarget. Needed because
    // "Use Player Camera" editor mode drives window.gameCamera directly via
    // OrbitControls, leaving cameraTheta/cameraPhi/cameraRadius stale at
    // whatever they were before entering editor mode - without this,
    // exiting handed control back to the normal follow-cam lerp (15*delta,
    // see its own site) chasing an unrelated old orbit position, which
    // swooped the camera across the level every single time editor mode
    // turned off instead of continuing smoothly from where it visually was.
    function resyncCameraFollowFromCurrentPosition() {
        const dx = camera.position.x - camTarget.x;
        const dz = camera.position.z - camTarget.z;
        const dyAdj = camera.position.y - camTarget.y - 1.5;
        const radiusSinPhi = Math.sqrt(dx * dx + dz * dz);
        const newRadius = Math.sqrt(radiusSinPhi * radiusSinPhi + dyAdj * dyAdj);
        if (newRadius > 0.001) {
            cameraRadius = newRadius;
            cameraPhi = Math.max(CAMERA_PHI_MIN, Math.min(CAMERA_PHI_MAX, Math.atan2(radiusSinPhi, dyAdj)));
        }
        if (radiusSinPhi > 0.001) cameraTheta = Math.atan2(dx, dz);
    }

    const editorPanelEl = document.getElementById('level-editor-panel');
    const editorToggleBtnEl = document.getElementById('fullscreen-btn'); // repurposed top-right button, see ClimbGame.html
    // Single source of truth for showing/hiding the on-screen game
    // controls (joysticks + action buttons) - the CSS class does the
    // actual hiding (see body.hide-game-controls in ClimbGame.html); this
    // just keeps the panel checkbox in sync with it.
    const editorControlsCb = document.getElementById('toggle-editor-controls');
    function setGameControlsVisible(visible) {
        document.body.classList.toggle('hide-game-controls', !visible);
        if (editorControlsCb) editorControlsCb.checked = visible;
    }
    if (editorControlsCb) editorControlsCb.addEventListener('change', e => setGameControlsVisible(e.target.checked));
    // On-screen Shift: only meaningful while the Select tool is active (the
    // transform modes never branch on the additive modifier), so it appears
    // and disappears with that mode - and un-latches on the way out, so it
    // can't silently still be held next time Select is picked. Declared out
    // here (not inside setupEditorUI below) because the toggle-editor-mode
    // handler right below calls it directly - guarded since it can run
    // before the lazy editor has ever been loaded (editorModeActive is
    // false then anyway, so there's nothing to show).
    const editorShiftBtn = document.getElementById('editor-shift-btn');
    function updateEditorShiftBtn() {
        if (!editorShiftBtn) return;
        const show = !!levelEditor && window.editorModeActive && levelEditor.mode === 'select';
        editorShiftBtn.style.display = show ? 'block' : 'none';
        if (!show && levelEditor && levelEditor.additiveModifier) {
            levelEditor.setAdditiveModifier(false);
            editorShiftBtn.classList.remove('active');
        }
    }
    // Async: the first time this is checked, awaits the lazy LevelEditor
    // import/construction (see ensureLevelEditorLoaded) before touching it -
    // every other `levelEditor.` reference in setupEditorUI only runs from
    // listeners on elements inside #level-editor-panel, which stays
    // display:none (so unclickable) until this handler's own activate()
    // call below, which can't happen until the await resolves.
    document.getElementById('toggle-editor-mode').addEventListener('change', async e => {
        const checked = e.target.checked;
        if (checked) await ensureLevelEditorLoaded();
        window.editorModeActive = checked;
        if (editorPanelEl) editorPanelEl.style.display = checked ? 'block' : 'none';
        if (editorToggleBtnEl) editorToggleBtnEl.classList.toggle('editor-active', checked);
        if (checked) {
            levelEditor.activate();
            // Clear the joysticks/buttons out from under your hands while
            // editing - unchecked by default on entry, per request.
            setGameControlsVisible(false);
        } else {
            // On exit, if editing was through the player camera, hand it
            // back to gameplay's follow-cam FROM WHERE THE EDITOR LEFT IT
            // (resync reverse-solves the orbit angles from the camera's
            // current position) so the view stays put instead of snapping.
            // Player-camera mode is left ON (checkbox stays checked) per
            // request - so this continuity holds and re-entering the editor
            // resumes from the same spot rather than a detached free cam.
            if (levelEditor.cameraMode === 'player') resyncCameraFollowFromCurrentPosition();
            levelEditor.deactivate();
            // Restore the game controls for actually playing again.
            setGameControlsVisible(true);
        }
        updateEditorShiftBtn();
    });
    // Everything below that touches `levelEditor` (toolbar, panels,
    // outliner, prefabs) is wired up exactly once, lazily, right after the
    // editor finishes loading (see ensureLevelEditorLoaded's call to this).
    function setupEditorUI() {
    // Dockable panel: collapse/expand just the body, leaving the header
    // (and its toggle) always visible - same idea as the debug panel's own
    // #dock-btn, so the panel can be tucked out of the way without exiting
    // editor mode.
    const editorDockBtn = document.getElementById('level-editor-dock-btn');
    const editorHeaderEl = document.getElementById('level-editor-header');
    if (editorHeaderEl && editorPanelEl) {
        editorHeaderEl.addEventListener('pointerdown', () => {
            const docked = editorPanelEl.classList.toggle('docked');
            if (editorDockBtn) editorDockBtn.textContent = docked ? '▼' : '▲';
        });
    }
    // Multi-select select icon (4 squares) vs single-select cursor arrow,
    // swapped in when the already-active Select button is clicked again.
    const SELECT_ICON_MULTI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
    const SELECT_ICON_SINGLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path></svg>';
    const editorModeBtns = document.querySelectorAll('.editor-mode-btn');
    if (editorShiftBtn) editorShiftBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        editorShiftBtn.classList.toggle('active', levelEditor.toggleAdditiveModifier());
    });
    editorModeBtns.forEach(btn => {
        btn.addEventListener('pointerdown', () => {
            // Re-clicking the already-active Select button toggles its
            // single/multi sub-mode instead of re-entering select mode.
            if (btn.dataset.mode === 'select' && btn.classList.contains('active')) {
                const multi = levelEditor.toggleMultiSelect();
                btn.innerHTML = multi ? SELECT_ICON_MULTI : SELECT_ICON_SINGLE;
                btn.title = multi ? 'Multi-Select (click again for Single)' : 'Single-Select (click again for Multi)';
                return;
            }
            levelEditor.setMode(btn.dataset.mode);
            editorModeBtns.forEach(b => b.classList.toggle('active', b === btn));
            updateEditorShiftBtn();
        });
    });
    // Inline dropdown panels (gear/add/prefab/export/props) live in the
    // panel body - a .editor-panel-toggle button shows its own panel and
    // hides every other, and marks itself active. Clicking the same toggle
    // again closes its panel. No off-screen floating.
    const editorPanelToggles = document.querySelectorAll('.editor-panel-toggle');
    const closeAllEditorPanels = (exceptId) => editorPanelToggles.forEach(t => {
        const p = document.getElementById(t.dataset.panel);
        if (t.dataset.panel !== exceptId) { if (p) p.style.display = 'none'; t.classList.remove('active'); }
    });
    editorPanelToggles.forEach(t => {
        t.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const p = document.getElementById(t.dataset.panel);
            if (!p) return;
            const willOpen = p.style.display === 'none';
            closeAllEditorPanels(t.dataset.panel);
            p.style.display = willOpen ? 'block' : 'none';
            t.classList.toggle('active', willOpen);
            // The dropdown panels live inside #level-editor-body, which the
            // dock collapses - opening one while docked would show nothing,
            // so un-dock automatically.
            if (willOpen && editorPanelEl && editorPanelEl.classList.contains('docked')) {
                editorPanelEl.classList.remove('docked');
                if (editorDockBtn) editorDockBtn.textContent = '▲';
            }
        });
    });
    // Add-object: each shape button adds its shape; closes the add panel
    // afterwards UNLESS the pin is active (series-add mode).
    const editorAddPinEl = document.getElementById('editor-add-pin');
    if (editorAddPinEl) editorAddPinEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); editorAddPinEl.classList.toggle('active'); });
    document.querySelectorAll('.editor-add-btn').forEach(btn => {
        btn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            levelEditor.addShape(btn.dataset.shape);
            if (!(editorAddPinEl && editorAddPinEl.classList.contains('active'))) closeAllEditorPanels();
        });
    });
    // Export panel: Level vs Selection.
    const exportLevelBtn = document.getElementById('export-level-btn');
    if (exportLevelBtn) exportLevelBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); levelEditor.exportGLTF(false); closeAllEditorPanels(); });
    const exportSelectionBtn = document.getElementById('export-selection-btn');
    if (exportSelectionBtn) exportSelectionBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); levelEditor.exportGLTF(true); closeAllEditorPanels(); });
    // Snap toggle button (moved out of the gear settings onto the toolbar).
    const editorSnapBtnEl = document.getElementById('editor-snap-btn');
    if (editorSnapBtnEl) {
        levelEditor.setSnapEnabled(editorSnapBtnEl.classList.contains('active'));
        editorSnapBtnEl.addEventListener('pointerdown', () => {
            const on = !editorSnapBtnEl.classList.contains('active');
            editorSnapBtnEl.classList.toggle('active', on);
            levelEditor.setSnapEnabled(on);
        });
    }
    // World / Local gizmo space toggle (button label flips WLD<->LCL).
    const editorSpaceBtnEl = document.getElementById('editor-space-btn');
    if (editorSpaceBtnEl) {
        editorSpaceBtnEl.addEventListener('pointerdown', () => {
            const nowLocal = levelEditor.gizmo.config.space !== 'local';
            levelEditor.gizmo.setSpace(nowLocal ? 'local' : 'world');
            editorSpaceBtnEl.textContent = nowLocal ? 'LCL' : 'WLD';
        });
    }
    const editorFocusBtnEl = document.getElementById('editor-focus-btn');
    if (editorFocusBtnEl) editorFocusBtnEl.addEventListener('pointerdown', () => levelEditor.focus());
    const editorDuplicateBtnEl = document.getElementById('editor-duplicate-btn');
    if (editorDuplicateBtnEl) editorDuplicateBtnEl.addEventListener('pointerdown', () => levelEditor.duplicate());
    const editorGroupBtnEl = document.getElementById('editor-group-btn');
    if (editorGroupBtnEl) editorGroupBtnEl.addEventListener('pointerdown', () => levelEditor.group());
    const editorUngroupBtnEl = document.getElementById('editor-ungroup-btn');
    if (editorUngroupBtnEl) editorUngroupBtnEl.addEventListener('pointerdown', () => levelEditor.ungroup());
    const outlineStrengthEl = document.getElementById('outline-strength-slider');
    if (outlineStrengthEl) outlineStrengthEl.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        levelEditor.outlinePass.edgeStrength = v;
        document.getElementById('outline-strength-val').textContent = v.toFixed(1);
    });
    const outlineThicknessEl = document.getElementById('outline-thickness-slider');
    if (outlineThicknessEl) outlineThicknessEl.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        levelEditor.outlinePass.edgeThickness = v;
        document.getElementById('outline-thickness-val').textContent = v.toFixed(1);
    });
    const toggleEditorWireframeEl = document.getElementById('toggle-editor-wireframe');
    if (toggleEditorWireframeEl) toggleEditorWireframeEl.addEventListener('change', e => {
        levelEditor.setWireframe(e.target.checked);
        // Grass isn't under editTarget (see buildGrassWireframe's own
        // comment on why it needs a separate path), so the level editor's
        // own setWireframe never touches it - drive it here instead.
        if (grassWireMesh) grassWireMesh.visible = e.target.checked;
    });
    const toggleEditorPlayerCameraEl = document.getElementById('toggle-editor-player-camera');
    if (toggleEditorPlayerCameraEl) {
        levelEditor.setCameraMode(toggleEditorPlayerCameraEl.checked ? 'player' : 'free');
        toggleEditorPlayerCameraEl.addEventListener('change', e => levelEditor.setCameraMode(e.target.checked ? 'player' : 'free'));
    }

    // Cut/cap/flip/offset properties panel for the selected shape - only
    // dim/radius/segment (handled by the 3D shape gizmo, see level_editor.js)
    // are left out here; everything in CUT_PROP_GROUPS shows as a plain
    // checkbox/number input instead, same fields Editor.html's own
    // renderGeometryUI exposes (minus the dim/radius/segment group it
    // handles separately too).
    // Properties dropdown: the "Properties ▾" toggle button only appears
    // when a shape (something with editable cut/cap params) is selected;
    // clicking it expands/collapses the cut-props container below it.
    // Properties: the toolbar's editor-props-toggle button (a
    // .editor-panel-toggle, wired generically above to open the inline
    // #editor-props-panel) only makes sense when a shape is selected -
    // renderShapePropsPanel shows/hides that toolbar button and fills the
    // panel's #shape-props-container with the cut/cap controls.
    const shapePropsContainer = document.getElementById('shape-props-container');
    const propsToggleEl = document.getElementById('editor-props-toggle');
    const propsPanelEl = document.getElementById('editor-props-panel');
    function renderShapePropsPanel(obj) {
        if (!shapePropsContainer) return;
        shapePropsContainer.innerHTML = '';
        const isShape = obj && obj.userData && obj.userData.shapeType;
        if (propsToggleEl) propsToggleEl.style.display = isShape ? 'flex' : 'none';
        // Nothing shape-like selected: hide the panel + clear the toggle's
        // active state so a leftover-open props panel doesn't linger.
        if (!isShape) {
            if (propsPanelEl) propsPanelEl.style.display = 'none';
            if (propsToggleEl) propsToggleEl.classList.remove('active');
            return;
        }
        // Auto-open the properties panel when a shape is selected (restores
        // the old behaviour where picking an added object surfaced its
        // cut/cap props straight away). Closes whatever other panel was up.
        if (propsPanelEl && propsToggleEl) {
            closeAllEditorPanels('editor-props-panel');
            propsPanelEl.style.display = 'block';
            propsToggleEl.classList.add('active');
        }
        const params = obj.userData.params;
        CUT_PROP_GROUPS.forEach(group => {
            if (params[group.toggle] === undefined) return;
            const toggleLabel = document.createElement('label');
            const toggleCb = document.createElement('input');
            toggleCb.type = 'checkbox'; toggleCb.checked = !!params[group.toggle];
            toggleCb.addEventListener('change', () => {
                levelEditor.setShapeProp(group.toggle, toggleCb.checked);
                renderShapePropsPanel(obj);
            });
            toggleLabel.appendChild(toggleCb);
            toggleLabel.appendChild(document.createTextNode(' ' + group.toggle));
            shapePropsContainer.appendChild(toggleLabel);
            shapePropsContainer.appendChild(document.createElement('br'));

            if (params[group.toggle]) {
                const sub = document.createElement('div');
                sub.style.cssText = 'padding-left: 10px; border-left: 1px solid #444; margin: 2px 0 4px 2px;';
                group.subs.forEach(subKey => {
                    if (params[subKey] === undefined) return;
                    const isBool = typeof params[subKey] === 'boolean';
                    const row = document.createElement('label');
                    const inp = document.createElement('input');
                    inp.type = isBool ? 'checkbox' : 'number';
                    if (isBool) inp.checked = params[subKey]; else { inp.value = params[subKey]; inp.step = '0.1'; inp.style.width = '55px'; }
                    inp.addEventListener(isBool ? 'change' : 'input', () => {
                        levelEditor.setShapeProp(subKey, isBool ? inp.checked : parseFloat(inp.value));
                    });
                    row.appendChild(inp);
                    row.appendChild(document.createTextNode(' ' + subKey));
                    sub.appendChild(row);
                    sub.appendChild(document.createElement('br'));
                });
                shapePropsContainer.appendChild(sub);
            }
        });
    }
    // ---- Outliner (scene hierarchy tree) ----
    // Mirrors editTarget's object graph as clickable rows: click selects,
    // shift-click adds to the selection, the twisty expands a container
    // (entity / group with non-helper children), the eye toggles .visible.
    // Rebuilt on any structural change; selection highlight is patched in
    // place (cheap) on selection change rather than rebuilding.
    const outlinerTreeEl = document.getElementById('editor-outliner-tree');
    const outlinerRowMap = new Map();       // uuid -> row element
    const outlinerExpanded = new Set();      // uuids currently expanded
    // Flat, top-to-bottom list of the rows currently on screen ({obj, row}),
    // in the same order addOutlinerRow appended them. Range-select needs to
    // turn "the row I pressed on" and "the row I'm over now" into a
    // contiguous span, which needs the visible ORDER - the uuid map alone
    // can't give that.
    const outlinerRowOrder = [];
    function outlinerLabel(o) {
        if (o.name) return o.name;
        if (o.userData && o.userData.isEntity) return 'Entity';
        if (o.userData && o.userData.shapeType) return o.userData.shapeType;
        return o.type || 'Object';
    }
    const outlinerChildrenOf = (o) => o.children.filter(c => !(c.userData && c.userData.isWireframeHelper));
    function addOutlinerRow(o, depth) {
        const row = document.createElement('div');
        row.className = 'outliner-row' + ((o.userData && o.userData.isEntity) ? ' entity' : '');
        row.style.paddingLeft = (depth * 12 + 3) + 'px';
        const kids = outlinerChildrenOf(o);
        const isContainer = kids.length > 0;
        const expanded = outlinerExpanded.has(o.uuid);
        const tw = document.createElement('span');
        tw.className = 'outliner-twisty';
        tw.textContent = isContainer ? (expanded ? '▼' : '▶') : '';
        if (isContainer) tw.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (expanded) outlinerExpanded.delete(o.uuid); else outlinerExpanded.add(o.uuid);
            buildOutliner();
        });
        row.appendChild(tw);
        const eye = document.createElement('span');
        eye.className = 'outliner-eye' + (o.visible ? '' : ' hidden');
        eye.textContent = o.visible ? '◉' : '○';
        eye.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            o.visible = !o.visible;
            eye.className = 'outliner-eye' + (o.visible ? '' : ' hidden');
            eye.textContent = o.visible ? '◉' : '○';
        });
        row.appendChild(eye);
        const lbl = document.createElement('span');
        lbl.className = 'outliner-label';
        lbl.textContent = outlinerLabel(o);
        row.appendChild(lbl);
        row.addEventListener('pointerdown', (e) => outlinerDragStart(e, o));
        // Double-click the label to rename the object/entity inline.
        lbl.addEventListener('dblclick', (e) => { e.stopPropagation(); startOutlinerRename(o, lbl); });
        outlinerTreeEl.appendChild(row);
        outlinerRowMap.set(o.uuid, row);
        outlinerRowOrder.push({ obj: o, row });
        if (isContainer && expanded) kids.forEach(c => addOutlinerRow(c, depth + 1));
    }
    function buildOutliner() {
        if (!outlinerTreeEl) return;
        outlinerTreeEl.innerHTML = '';
        outlinerRowMap.clear();
        outlinerRowOrder.length = 0;
        levelEditor.editTarget.children
            .filter(o => !(o.userData && o.userData.isWireframeHelper))
            .forEach(o => addOutlinerRow(o, 0));
        updateOutlinerSelection();
    }
    function updateOutlinerSelection() {
        const sel = new Set(levelEditor.selection.map(o => o.uuid));
        outlinerRowMap.forEach((row, uuid) => row.classList.toggle('selected', sel.has(uuid)));
    }
    // ---- Outliner drag: reparent, or range-select ----
    // One gesture, two meanings, chosen at press time by whether the additive
    // modifier is engaged (real Shift, or the on-screen Shift button - see
    // levelEditor._isAdditive) or the Select tool is in its multi sub-mode:
    //
    //   plain drag      row onto row  -> re-parent (drop target becomes parent)
    //                   row onto the tree's empty space -> back out to root
    //   additive drag   sweep across rows -> range-select everything swept
    //
    // Pointer events rather than HTML5 drag-and-drop, because HTML5 DnD does
    // not fire on touch at all and the whole editor has to work on a phone.
    let outlinerDrag = null;
    const outlinerRowIndex = (row) => outlinerRowOrder.findIndex(r => r.row === row);
    // The row under a screen point. elementFromPoint (rather than the event
    // target) is what makes this work on touch, where the pointer stays
    // captured by the row it started on for the whole gesture.
    function outlinerRowAt(x, y) {
        const el = document.elementFromPoint(x, y);
        return el ? el.closest('.outliner-row') : null;
    }
    function outlinerClearDropHint() {
        outlinerRowOrder.forEach(r => r.row.classList.remove('drop-target'));
    }
    function outlinerDragStart(e, o) {
        if (outlinerDrag) return;
        const rangeMode = levelEditor._isAdditive(e) || levelEditor.multiSelectMode;
        const row = outlinerRowMap.get(o.uuid);
        outlinerDrag = {
            pointerId: e.pointerId, obj: o, row, rangeMode, moved: false,
            startX: e.clientX, startY: e.clientY,
            // Range-select accumulates ON TOP of whatever was already
            // selected, so the sweep can extend an existing multi-selection
            // instead of wiping it.
            baseSelection: levelEditor.selection.slice(),
            anchorIndex: outlinerRowIndex(row),
        };
        if (rangeMode) levelEditor.select(o, true);
        else levelEditor.select(o, false);
        window.addEventListener('pointermove', outlinerDragMove);
        window.addEventListener('pointerup', outlinerDragEnd);
        window.addEventListener('pointercancel', outlinerDragEnd);
    }
    function outlinerDragMove(e) {
        if (!outlinerDrag || e.pointerId !== outlinerDrag.pointerId) return;
        const dx = e.clientX - outlinerDrag.startX, dy = e.clientY - outlinerDrag.startY;
        // Same small threshold as the viewport marquee: a press that never
        // really moved stays a plain click.
        if (!outlinerDrag.moved && (dx * dx + dy * dy) < 16) return;
        outlinerDrag.moved = true;
        const overRow = outlinerRowAt(e.clientX, e.clientY);
        if (outlinerDrag.rangeMode) {
            if (!overRow) return;
            const i = outlinerRowIndex(overRow);
            if (i < 0 || outlinerDrag.anchorIndex < 0) return;
            const lo = Math.min(i, outlinerDrag.anchorIndex), hi = Math.max(i, outlinerDrag.anchorIndex);
            const next = outlinerDrag.baseSelection.slice();
            for (let k = lo; k <= hi; k++) {
                const obj = outlinerRowOrder[k].obj;
                if (!next.includes(obj)) next.push(obj);
            }
            levelEditor.setSelection(next);
        } else {
            // Reparent drag: highlight whatever row would become the parent.
            outlinerClearDropHint();
            if (overRow && overRow !== outlinerDrag.row) overRow.classList.add('drop-target');
        }
    }
    function outlinerDragEnd(e) {
        if (!outlinerDrag || (e && e.pointerId !== undefined && e.pointerId !== outlinerDrag.pointerId)) return;
        const drag = outlinerDrag;
        outlinerDrag = null;
        window.removeEventListener('pointermove', outlinerDragMove);
        window.removeEventListener('pointerup', outlinerDragEnd);
        window.removeEventListener('pointercancel', outlinerDragEnd);
        outlinerClearDropHint();
        if (!drag.moved || drag.rangeMode) return;
        const x = (e && e.clientX !== undefined) ? e.clientX : drag.startX;
        const y = (e && e.clientY !== undefined) ? e.clientY : drag.startY;
        const overRow = outlinerRowAt(x, y);
        if (overRow === drag.row) return;
        // Drag the whole selection if the grabbed row was part of it (so a
        // multi-selection re-parents in one go), otherwise just this object.
        const movers = levelEditor.selection.includes(drag.obj) ? levelEditor.selection.slice() : [drag.obj];
        let newParent = null;
        if (overRow) {
            const entry = outlinerRowOrder.find(r => r.row === overRow);
            if (!entry) return;
            newParent = entry.obj;
        } else {
            // Released over the tree's own empty space -> unparent back to the
            // level root. Released anywhere else on screen -> cancel.
            const treeRect = outlinerTreeEl.getBoundingClientRect();
            const inTree = x >= treeRect.left && x <= treeRect.right && y >= treeRect.top && y <= treeRect.bottom;
            if (!inTree) return;
            newParent = levelEditor.editTarget;   // reparent(null) means the same
        }
        if (levelEditor.reparent(movers, newParent) > 0) {
            // Open the new parent so the moved objects are visible where they
            // landed, rather than silently vanishing into a collapsed row.
            if (newParent !== levelEditor.editTarget) outlinerExpanded.add(newParent.uuid);
            buildOutliner();
        }
    }
    // Inline rename: swap a row's label span for a text input, commit the
    // trimmed value onto obj.name (Enter or blur), cancel on Escape. Rebuilds
    // the tree afterwards so the label reflects the new name.
    function startOutlinerRename(o, lbl) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = o.name || outlinerLabel(o);
        input.style.cssText = 'flex:1; min-width:0; font:inherit; background:#111; color:#fff; border:1px solid #06f; border-radius:2px; padding:0 2px;';
        lbl.replaceWith(input);
        let done = false;
        const commit = (save) => {
            if (done) return; done = true;
            if (save) { const v = input.value.trim(); if (v) o.name = v; }
            buildOutliner();
        };
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        // Focus + wire blur on the next tick so the click that opened this
        // rename doesn't immediately blur the fresh input and commit-close it.
        setTimeout(() => { input.focus(); input.select(); input.addEventListener('blur', () => commit(true)); }, 0);
    }
    levelEditor.onStructureChange = buildOutliner;
    levelEditor.onSelectionChange = (sel) => { renderShapePropsPanel(sel); updateOutlinerSelection(); };
    // New editor objects that carry gameplay userData (a carryable jar made
    // into a prefab, a duplicated jar, ...) need a matching entry in the
    // `carryables` array or drop/throw physics never sees them and they hang
    // in mid-air where the carry animation left them. Register every
    // isCarryable mesh in the freshly added object (works for a lone mesh or
    // an entity full of them). isMovable objects don't need a wrapper.
    levelEditor.onObjectAdded = (obj) => {
        obj.traverse(n => {
            if (!(n.isMesh && n.userData && n.userData.isCarryable)) return;
            if (carryables.some(c => c.mesh === n)) return;
            const carry = { mesh: n, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false, netId: nextCarryNetId++ };
            carryables.push(carry);
            addCarryableDebugHelper(carry);
        });
        // Anything the editor drops into a level with water (Water Test,
        // Level 2) gets the same waterline foam as the terrain/rocks/demo
        // box, without the user having to wire it up per-object by hand -
        // applyShorelineFoam is cheap and self-gates via uFoamEnabled, so
        // it's fine to apply unconditionally rather than re-checking
        // currentLevel here (a level added later with water wouldn't need
        // this list touched again).
        obj.traverse(n => {
            if (n.isMesh && n.material) {
                // Arrow wrapper for the same reason as buildLevelFromGlb's -
                // a bare forEach reference passes the index as waterBody.
                (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => applyShorelineFoam(m));
            }
        });
    };
    // Build once the outliner is first opened (editTarget can hold hundreds
    // of built-level nodes - no point paying for the rows until it's shown).
    const outlinerToggleEl = document.getElementById('editor-outliner-toggle');
    if (outlinerToggleEl) outlinerToggleEl.addEventListener('pointerdown', () => buildOutliner());
    const editorDeleteBtnEl = document.getElementById('editor-delete-btn');
    if (editorDeleteBtnEl) editorDeleteBtnEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); levelEditor.deleteSelected(); });

    // ---- Prefabs ----
    // Save the primary selection as a reusable template (serialized to
    // localStorage so it survives a reload); the panel lists saved prefabs
    // as buttons that instantiate a fresh copy in front of the camera.
    const PREFAB_KEY = 'levelEditorPrefabs_v1';
    // Fill only the list sub-div - the Group/Ungroup buttons live statically
    // above it in the same panel and must survive re-renders.
    const prefabPanelEl = document.getElementById('editor-prefab-list');
    let prefabs = [];
    try { prefabs = JSON.parse(localStorage.getItem(PREFAB_KEY) || '[]'); } catch (e) { prefabs = []; }
    function savePrefabs() { try { localStorage.setItem(PREFAB_KEY, JSON.stringify(prefabs)); } catch (e) { /* quota / private mode - keep them in-memory this session */ } }
    function renderPrefabPanel(autoRenameIndex = -1) {
        if (!prefabPanelEl) return;
        prefabPanelEl.innerHTML = '';
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '+ Save selection as prefab';
        saveBtn.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:6px;';
        saveBtn.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            const json = levelEditor.serializeSelected();
            if (!json) { saveBtn.textContent = 'Select something first!'; setTimeout(() => { saveBtn.textContent = '+ Save selection as prefab'; }, 1200); return; }
            const base = (levelEditor.selected && levelEditor.selected.name) || 'Prefab';
            prefabs.push({ name: base, json });
            savePrefabs();
            // Re-render and drop straight into renaming the new prefab so the
            // user can give it a meaningful name right away.
            renderPrefabPanel(prefabs.length - 1);
        });
        prefabPanelEl.appendChild(saveBtn);
        if (!prefabs.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'opacity:0.6;padding:2px;';
            empty.textContent = 'No prefabs yet.';
            prefabPanelEl.appendChild(empty);
            return;
        }
        prefabs.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-bottom:3px;';
            const btn = document.createElement('button');
            btn.textContent = p.name;
            btn.title = 'Add ' + p.name;
            btn.style.cssText = 'flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;';
            btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); levelEditor.instantiate(p.json, p.name); });
            const ren = document.createElement('button');
            ren.textContent = '✎';
            ren.title = 'Rename prefab';
            ren.style.cssText = 'flex:0 0 auto;width:24px;';
            ren.addEventListener('pointerdown', (e) => { e.stopPropagation(); startPrefabRename(i, btn); });
            const del = document.createElement('button');
            del.textContent = '×';
            del.title = 'Delete prefab';
            del.style.cssText = 'flex:0 0 auto;width:24px;';
            del.addEventListener('pointerdown', (e) => { e.stopPropagation(); prefabs.splice(i, 1); savePrefabs(); renderPrefabPanel(); });
            row.appendChild(btn); row.appendChild(ren); row.appendChild(del);
            prefabPanelEl.appendChild(row);
            if (i === autoRenameIndex) startPrefabRename(i, btn);
        });
    }
    // Inline-rename a prefab: swap its instantiate button for a text input,
    // commit onto prefabs[i].name (Enter/blur), cancel on Escape.
    function startPrefabRename(i, btn) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = prefabs[i].name;
        input.style.cssText = 'flex:1; min-width:0; font:inherit; background:#111; color:#fff; border:1px solid #06f; border-radius:2px; padding:0 2px;';
        btn.replaceWith(input);
        let done = false;
        const commit = (save) => {
            if (done) return; done = true;
            if (save) { const v = input.value.trim(); if (v) { prefabs[i].name = v; savePrefabs(); } }
            renderPrefabPanel();
        };
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        // Defer focus + blur wiring one tick so the opening click (its own
        // pointerup/click still pending) doesn't blur-and-commit immediately.
        setTimeout(() => { input.focus(); input.select(); input.addEventListener('blur', () => commit(true)); }, 0);
    }
    renderPrefabPanel();
    } // end setupEditorUI()

    window.toonOutlineEnabled = false;
    window.toonOutlineThickness = 0.02;
    document.getElementById('toggle-toon-outline').addEventListener('change', e => {
        window.toonOutlineEnabled = e.target.checked;
        char.setOutlineEnabled(e.target.checked);
    });
    document.getElementById('toon-smoothness-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        setToonSmoothness(v);
        document.getElementById('toon-smoothness-val').textContent = v.toFixed(2);
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

    let gameReadyOverlayHidden = false;
    // Uses the RAW (unclamped) per-frame delta, not the 0.1s-capped `delta`
    // used everywhere else - the cap exists specifically to stop a slow
    // frame from blowing up physics/animation timing, which would otherwise
    // hide exactly what this counter is for (seeing how bad a real stall on
    // low-end/mobile hardware actually gets). minFps never recovers once
    // it drops, on purpose - leave the game running and come back later to
    // see the worst frame this session ever had, not just whatever the
    // instantaneous reading happens to be at the moment you look.
    const fpsCounterEl = document.getElementById('fps-counter');
    let fpsSmoothed = 60;
    let fpsMin = Infinity;
    let fpsDisplayAccum = 0;

    // Ledge hand-IK debug visualization (Debug Vis: 'Show Ledge Hand IK').
    // Lazily builds a set of scene markers/lines + a head-mounted text
    // sprite, updates them to show what the hang-hand aim is computing each
    // frame, and is hidden when the toggle is off (see setHangIKDebugVisible
    // below, called from the always-run debug section in animate()). Kept
    // out of the hot path when the toggle is off - the caller only invokes
    // updateHangIKDebugViz while actually hanging AND checks the toggle here.
    const _hangDbg = { built: false };
    function buildHangIKDebugViz() {
        const mkMarker = (color) => {
            const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
            m.renderOrder = 1000; m.raycast = () => {}; m.visible = false; scene.add(m); return m;
        };
        const mkLine = (color) => {
            const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
            l.renderOrder = 1000; l.raycast = () => {}; l.visible = false; scene.add(l); return l;
        };
        _hangDbg.leftMarker = mkMarker(0xff3333);
        _hangDbg.rightMarker = mkMarker(0x3388ff);
        _hangDbg.ledgeMarker = mkMarker(0xffff00);
        _hangDbg.leftLine = mkLine(0xff3333);
        _hangDbg.rightLine = mkLine(0x3388ff);
        _hangDbg.normalLine = mkLine(0x00ff88); // grabbed-surface normal (green)
        const cv = document.createElement('canvas');
        cv.width = 320; cv.height = 200;
        _hangDbg.ctx = cv.getContext('2d');
        _hangDbg.tex = new THREE.CanvasTexture(cv);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: _hangDbg.tex, depthTest: false }));
        spr.scale.set(3.2, 2.0, 1); spr.position.set(0, 3.3, 0); spr.raycast = () => {}; spr.visible = false;
        if (char && char.group) char.group.add(spr);
        _hangDbg.sprite = spr;
        _hangDbg.built = true;
    }
    function setHangIKDebugVisible(v) {
        if (!_hangDbg.built) return;
        _hangDbg.leftMarker.visible = v; _hangDbg.rightMarker.visible = v; _hangDbg.ledgeMarker.visible = v;
        _hangDbg.leftLine.visible = v; _hangDbg.rightLine.visible = v; _hangDbg.sprite.visible = v;
        _hangDbg.normalLine.visible = v;
    }
    const _hangDbgLH = new THREE.Vector3(), _hangDbgRH = new THREE.Vector3(), _hangDbgNEnd = new THREE.Vector3();
    function updateHangIKDebugViz(lt, rt, ledgeTgt, ch, spread, yLift, ikW) {
        const on = !!(document.getElementById('toggle-hang-ik-dbg') && document.getElementById('toggle-hang-ik-dbg').checked);
        if (!on) { if (_hangDbg.built) setHangIKDebugVisible(false); return; }
        if (!_hangDbg.built) buildHangIKDebugViz();
        setHangIKDebugVisible(true);
        ch.leftHandBone.getWorldPosition(_hangDbgLH);
        ch.rightHandBone.getWorldPosition(_hangDbgRH);
        _hangDbg.leftMarker.position.copy(lt);
        _hangDbg.rightMarker.position.copy(rt);
        _hangDbg.ledgeMarker.position.copy(ledgeTgt);
        _hangDbg.leftLine.geometry.setFromPoints([_hangDbgLH, lt]);
        _hangDbg.rightLine.geometry.setFromPoints([_hangDbgRH, rt]);
        // Grabbed-surface normal (green) drawn out from the ledge point, so
        // the face's real steepness is visible in 3D alongside the number.
        if (window._dbgGrabWallNormal) {
            _hangDbgNEnd.copy(ledgeTgt).addScaledVector(window._dbgGrabWallNormal, 1.2);
            _hangDbg.normalLine.geometry.setFromPoints([ledgeTgt, _hangDbgNEnd]);
        }
        const lGapV = _hangDbgLH.distanceTo(lt), rGapV = _hangDbgRH.distanceTo(rt);
        const angDeg = window._dbgGrabWallAngleDeg, cutDeg = window._dbgGrabWallCutoffDeg;
        const ctx = _hangDbg.ctx;
        ctx.clearRect(0, 0, 320, 200);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, 320, 200);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold 20px monospace';
        // Surface angle first (the climbability question) - green if the
        // face is genuinely wall-steep, orange if it only just cleared the
        // grab cutoff (a surprisingly shallow face that still grabs).
        if (angDeg !== undefined) {
            const marginal = angDeg < (cutDeg + 5);
            ctx.fillStyle = marginal ? '#ffaa44' : '#66ff88';
            ctx.fillText(`face ${angDeg.toFixed(1)}deg  cut ${cutDeg.toFixed(1)}`, 8, 8);
        } else {
            ctx.fillStyle = '#888888'; ctx.fillText(`face --`, 8, 8);
        }
        ctx.fillStyle = '#ffff88';
        ctx.fillText(`ledge ${ledgeTgt.x.toFixed(1)},${ledgeTgt.y.toFixed(1)},${ledgeTgt.z.toFixed(1)}`, 8, 40);
        ctx.fillStyle = '#ff8888';
        ctx.fillText(`L gap ${lGapV.toFixed(3)}`, 8, 72);
        ctx.fillStyle = '#88bbff';
        ctx.fillText(`R gap ${rGapV.toFixed(3)}`, 8, 104);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`spread ${spread}  grip ${yLift}`, 8, 136);
        // Corner-retreat flag - if this ever shows RETREAT right after a
        // fresh grab, the stale-retreat teleport bug is back (see the
        // fresh-grab reset). ledgeCornerRetreating is a closure var in
        // scope here.
        ctx.fillStyle = ledgeCornerRetreating ? '#ff4444' : '#ffffff';
        ctx.fillText(`${window.ledgeHandUseIK ? 'IK' : 'AIM'} w${ikW}  ${ledgeCornerRetreating ? 'RETREAT' : 'hang'}`, 8, 168);
        _hangDbg.tex.needsUpdate = true;
    }

    function animate() {
        requestAnimationFrame(animate);
        // Viewer modal owns its own scene/camera/renderer entirely - while
        // open, render only that and skip the whole game update below
        // (same "one or the other, not both" exclusivity as editor mode's
        // own early return further down, just checked first since Viewer
        // can be opened regardless of editor state).
        if (Viewer.active) {
            Viewer.controls.update();
            if (Viewer.mixer) Viewer.mixer.update(Viewer.clock.getDelta());
            Viewer.renderer.render(Viewer.scene, Viewer.camera);
            return;
        }
        const rawDelta = clock.getDelta();
        const delta = Math.min(rawDelta, 0.1), time = Date.now()*0.001;
        // clock.elapsedTime (small, zero-based), NOT `time` (raw Date.now()
        // epoch seconds, ~1.7e9): feeding that huge number straight into a
        // shader's vec2 UV math blows past float32's precision at that
        // magnitude (ULP > 10 there), quantizing every fragment's noise
        // input to the same lattice cell - the whole plane comes out flat.
        // waterTestTerrainMaterial/waterTestRocksMaterial are now plain
        // MeshToonMaterial (applyShorelineFoam'd like everything else, see
        // buildWaterTestLevel) - no .uniforms of their own to tick here
        // anymore, they read defaultWaterBody's by reference instead.
        // Every water body's own uTime (defaultWaterBody's, the Water Test
        // level's pond, and any future one) - each carries its own
        // uWaterLevel etc, but they all still animate off the same clock.
        waterBodies.forEach(wb => {
            wb.uniforms.uTime.value = clock.elapsedTime;
            // These aren't part of the shared foam `uniforms` object (only
            // the water SURFACE material has them), so they need their own
            // copy from the debug-panel globals every frame.
            const wu = wb.waterMaterial.uniforms;
            wu.uLinesScale.value = window.waterLinesScale;
            wu.uLinesOpacity.value = window.waterLinesOpacity;
            wu.uLinesSpeed.value = window.waterLinesSpeed;
            wu.uLinesThickness.value = window.waterLinesThickness;
        });
        // Live position -> uWaterLevel sync (see linkWaterMeshToBody) - runs
        // before the editor-mode early return below, so dragging a water
        // mesh with the gizmo moves its foam immediately, no reload.
        waterMeshSyncs.forEach(({ mesh, waterBody }) => { waterBody.uniforms.uWaterLevel.value = mesh.position.y; });
        // Upload every water body's state as flat arrays; the fragment
        // shader does the "which body am I in?" test itself (see
        // foamSharedUniforms). Footprints come from the live mesh, so
        // dragging or resizing a water plane in the editor is picked up
        // immediately, and an object carried from the sea into the pond
        // starts obeying the pond the moment it crosses the boundary.
        const foamCount = Math.min(waterMeshSyncs.length, MAX_WATER_BODIES);
        foamSharedUniforms.uFoamCount.value = foamCount;
        foamSharedUniforms.uFoamTime.value = clock.elapsedTime;
        foamSharedUniforms.uFoamGlobalScale.value = window.foamDepthScale;
        foamObjScaleUniforms.forEach(e => { e.uniform.value = window[e.key]; });
        for (let i = 0; i < foamCount; i++) {
            const { mesh, waterBody } = waterMeshSyncs[i];
            const g = mesh.geometry;
            if (!g.boundingBox) g.computeBoundingBox();
            // Plane geometry is authored in XY then rotated flat, so its
            // local X/Y half-extents are the world X/Z ones.
            const halfX = (g.boundingBox.max.x - g.boundingBox.min.x) * 0.5 * mesh.scale.x;
            const halfZ = (g.boundingBox.max.y - g.boundingBox.min.y) * 0.5 * mesh.scale.y;
            foamSharedUniforms.uFoamMin.value[i].set(mesh.position.x - halfX, mesh.position.z - halfZ);
            foamSharedUniforms.uFoamMax.value[i].set(mesh.position.x + halfX, mesh.position.z + halfZ);
            foamSharedUniforms.uFoamLevel.value[i] = mesh.position.y;
            foamSharedUniforms.uFoamSpeed.value[i] = waterBody.uniforms.uWaveSpeed.value;
            foamSharedUniforms.uFoamAmp.value[i] = waterBody.uniforms.uWaveAmplitude.value;
            foamSharedUniforms.uFoamBand.value[i] = waterBody.uniforms.uFoamDepth.value;
            foamSharedUniforms.uFoamOn.value[i] = waterBody.uniforms.uFoamEnabled.value;
        }

        // Editor mode short-circuits the entire rest of this function - it's
        // one big ~2900-line closure, not decomposed into per-system update
        // calls, so there's no clean seam to thread a check through every
        // subsystem individually. Nothing below this (movement, physics,
        // AI, network sync, the normal render call) runs while active;
        // LevelEditor owns its own camera/controls/gizmo update and render.
        if (window.editorModeActive) {
            levelEditor.update(delta);
            levelEditor.render();
            return;
        }

        if (fpsCounterEl && rawDelta > 0) {
            const instFps = 1 / rawDelta;
            fpsSmoothed = fpsSmoothed * 0.9 + instFps * 0.1;
            if (instFps < fpsMin) fpsMin = instFps;
            fpsDisplayAccum += rawDelta;
            if (fpsDisplayAccum > 0.3) {
                fpsDisplayAccum = 0;
                fpsCounterEl.textContent = `FPS: ${Math.round(fpsSmoothed)} (min ${Math.round(fpsMin)})`;
            }
        }

        if (!gameReadyOverlayHidden && char.isLoaded && window._cubesLoaded) {
            gameReadyOverlayHidden = true;
            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.classList.add('hidden');
            // Otherwise the one-time asset-loading hitch (everything up to
            // this point) permanently poisons the min reading before actual
            // gameplay even starts.
            fpsMin = Infinity;
        }

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
            cameraPhi = Math.max(CAMERA_PHI_MIN, Math.min(CAMERA_PHI_MAX, cameraPhi - input.right.y * 0.04));
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
            // Height each individual ray came back with, indexed to match
            // rayOffsets (0 = centre, 1/2 = +x/-x, 3/4 = +z/-z), or null if
            // that ray found nothing. Opposing pairs give the ground's real
            // gradient across the character's footprint - see the bevel check
            // after the loop.
            const sampleY = [null, null, null, null, null];
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
                        sampleY[i] = hitY;
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
            // NARROW GUTTER. Every place two blocks butt together has a
            // channel between them: the blocks are RoundedBoxGeometry with
            // radius 0.15, so two abutting roundings leave a groove roughly
            // 0.3 wide and 0.15 deep. A ray has no thickness and drops
            // straight to the bottom of it - measured on the A/B seam, the
            // centre ray reads 5.55 where the rays 0.25 to either side read
            // 5.70. The character then walks 15cm lower along every seam and
            // steps up out of it again on the far side, which is what reads
            // as tripping over the joins.
            //
            // A real body cannot fit in that groove. The character's radius is
            // 0.45, the gutter is 0.3 across, so it would bridge and rest on
            // the shoulders - exactly what a capsule or sphere-cast gives you
            // for free, and what a single ray cannot. So: if the centre sits
            // BELOW both rays of an opposing pair, and only slightly, stand on
            // the shoulders instead of in the groove.
            //
            // Depth-limited on purpose. A real step down is also "lower than
            // one side", but it is not lower than BOTH sides of a pair, and
            // anything deeper than GUTTER_MAX_DEPTH is terrain to walk down
            // rather than a seam to bridge.
            const GUTTER_MAX_DEPTH = 0.3;
            if (hasCenterHit) {
                let shoulderY = null;
                const considerPair = (a, b) => {
                    if (sampleY[a] === null || sampleY[b] === null) return;
                    const low = Math.min(sampleY[a], sampleY[b]);
                    if (low > centerY && low - centerY <= GUTTER_MAX_DEPTH) {
                        shoulderY = shoulderY === null ? low : Math.max(shoulderY, low);
                    }
                };
                considerPair(1, 2);   // +x / -x
                considerPair(3, 4);   // +z / -z
                if (shoulderY !== null) {
                    highestY = shoulderY;
                    // Bridging two shoulders - the rounding facet under the
                    // centre ray describes the groove, not the surface being
                    // stood on.
                    groundNormal.copy(_upVec);
                }
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
            // CRACK BRIDGING. The scan above samples a 0.5-wide cross
            // (offsets of 0.25), but the level's blocks are not butted
            // together - measured across the stairs level, only 7 of 34
            // level-topped neighbour pairs actually touch; the rest are
            // separated by real cracks of 0.06 up to 0.97 units. A crack
            // wider than 0.5 swallows every one of those five rays, the scan
            // reports no ground at all, and the character drops into the gap
            // and wedges there between the two blocks' collision boxes.
            //
            // So when nothing was found, check whether the character is
            // actually STRADDLING something rather than standing over open
            // air: probe opposing pairs a body-radius out, and only accept a
            // pair where BOTH sides hit. Both sides solid = a crack narrower
            // than the character, which they should stand across rather than
            // fall into. One side solid = a platform edge, which must keep
            // falling exactly as before - that asymmetry is the whole reason
            // this uses pairs instead of just widening the cross above.
            // Also runs when the scan DID find something but it is implausibly
            // far below - which is what happens on a shared block edge. A ray
            // landing exactly on the seam between two boxes can miss both
            // triangles, sail past, and hit the ground plane 6 units down; the
            // height filter above only rejects hits that are too HIGH, so that
            // distant floor was accepted as "the ground" and the character
            // walked off into the air on the spot. Measured on the A1/A2/B1/B2
            // corner: a cross-shaped hole about 0.1 wide, dead centre.
            const foundFarBelow = hitAnything && highestY < char.group.position.y - 0.6;
            if (!hitAnything || foundFarBelow) {
                // Every pair is evaluated and the HIGHEST support wins, rather
                // than stopping at the first that works. At the exact 4-block
                // corner the axis probes land in the roundings' gutter while
                // the diagonals reach flat top, so taking the first match put
                // the character 0.3 low on the one spot they walk over most.
                let bridged = false;
                for (let k = 0; k < _crackProbeA.length; k++) {
                    let yA = null, objA = null, yB = null;
                    for (let side = 0; side < 2; side++) {
                        const off = side === 0 ? _crackProbeA[k] : _crackProbeB[k];
                        _tempVec1.copy(char.group.position).add(off);
                        _tempVec1.y += 1.2;
                        rayDown.set(_tempVec1, _downVec);
                        const h = rayDown.intersectObjects(groundScanCollidables);
                        // Band-limited on BOTH sides. Without the lower bound a
                        // probe that also lands on a seam sails through to the
                        // distant ground plane and gets accepted as support,
                        // which "bridges" the character onto a floor 6 units
                        // down - the very failure this is here to prevent.
                        if (h.length > 0 && h[0].point.y <= char.group.position.y + 0.8
                                         && h[0].point.y >= char.group.position.y - 0.6) {
                            if (side === 0) { yA = h[0].point.y; objA = h[0].object; }
                            else yB = h[0].point.y;
                        }
                    }
                    if (yA !== null && yB !== null) {
                        const pairY = Math.max(yA, yB);
                        // Keep the best-supported pair, not the first one that
                        // qualifies - see the comment above the loop.
                        if (!bridged || pairY > highestY) {
                            highestY = pairY;
                            groundHitObject = objA;
                        }
                        bridged = true;
                        hitAnything = true;
                        // Flat by construction: the character is bridging two
                        // separate surfaces, so there is no single face whose
                        // normal is meaningful here. Reporting up keeps the
                        // slope/slide logic from reading the crack as terrain.
                        groundNormal.set(0, 1, 0);
                    }
                }
            }
            // ROUNDED-EDGE FALSE SLOPES. The level's blocks are not plain
            // cubes: they are 3x3x3-segment boxes with their vertices pushed
            // around, so every block edge is bevelled into a few facets. A
            // ground ray that lands on one of those facets reports a 60-75
            // degree normal even though the deck underfoot is flat, and that
            // is well past SLIDE_ENTER_ANGLE - so walking near a block edge,
            // and especially across the point where four blocks meet, kicked
            // off a slide and threw the character off the platform.
            //
            // A single facet normal cannot tell a bevel from a real slope,
            // but the SPREAD of the five ray heights can: measured at the
            // 4-block junction the rays came back 5.616 / 5.671 / 5.7, an 8cm
            // spread over a 0.5 footprint - about 9 degrees, i.e. flat - while
            // the centre facet claimed 22.5 and a neighbour 73.6. So when the
            // facet disagrees sharply with the height spread, trust the
            // heights and call it flat. A genuine ramp has both in agreement
            // (a 30 degree ramp drops 0.29 across the same span), so real
            // slopes and real sliding are untouched.
            // The gradient is measured by fitting a plane through the ray hits
            // rather than by clamping to straight up. Clamping was wrong on a
            // slope that also has bevelled edges: a real 30-degree ramp whose
            // edge facet reads 70 would have been flattened to 0 and its slide
            // killed. A fitted plane returns the ramp's actual 30.
            //
            // Opposing rays sit 0.5 apart, so with dy across each pair the
            // surface tangents are (0.5, dyx, 0) and (0, dyz, 0.5); their
            // cross product is proportional to (-2*dyx, 1, -2*dyz).
            _facetNormalBeforeFit.copy(groundNormal);
            const havePairX = sampleY[1] !== null && sampleY[2] !== null;
            const havePairZ = sampleY[3] !== null && sampleY[4] !== null;
            if (hitAnything && (havePairX || havePairZ)) {
                const dyx = havePairX ? sampleY[1] - sampleY[2] : 0;
                const dyz = havePairZ ? sampleY[3] - sampleY[4] : 0;
                _fitNormalScratch.set(-2 * dyx, 1, -2 * dyz).normalize();
                const facetSlope = groundNormal.angleTo(_upVec);
                const fitSlope = _fitNormalScratch.angleTo(_upVec);
                const FACET_DISAGREEMENT = THREE.MathUtils.degToRad(15);
                // Only ever used to CALM DOWN an over-steep facet, never to
                // introduce steepness. Standing beside a step, one ray can
                // legitimately land 0.8 higher than its opposite and the fit
                // would read ~58 degrees across ground that is really flat -
                // so a fit steeper than the facet is discarded.
                //
                // Placed after the steepest-ray latch above rather than before
                // it: that latch is what keeps an in-progress slide alive, so
                // correcting here is also what lets a slide started by a bevel
                // facet end again instead of running the length of the deck.
                if (fitSlope < facetSlope - FACET_DISAGREEMENT) {
                    groundNormal.copy(_fitNormalScratch);
                }
            }
            lastGroundObject = groundHitObject;
            _dbgGroundNormalOut.copy(groundNormal);
            updateGroundRayDbg(rayOffsets, sampleY, _facetNormalBeforeFit, groundNormal);

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
                // Same coarse-AABB problem as the hemisphere/ramps, but for
                // the lock: its cachedBox3 fallback is a tall, narrow shape
                // nothing like a normal climbable step, so stepping onto it
                // reads as blocked almost everywhere. Only bypassed once
                // unlocked (userData.keyInserted, set in
                // triggerKeyInsertion) - while still locked it must stay a
                // solid, un-standable obstacle.
                const hitLockGroup = groundHitObject && groundHitObject.parent && groundHitObject.parent.userData && groundHitObject.parent.userData.isLock ? groundHitObject.parent : null;
                const isOnActiveLock = !!(hitLockGroup && hitLockGroup.userData.keyInserted);
                const isSteppingUp = highestY > char.group.position.y + 0.05;
                const blockedByStandCheck = isSteppingUp && !isSteepSlope && !isOnRamp && !isOnHemisphere && !isOnActiveLock &&
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

        // window.dialogueInputLocked (see the village NPC dialogue) forces
        // both raw axes to 0 regardless of source - one gate here covers
        // joystick AND keyboard at once, since this is the single point
        // both funnel through before becoming actual movement.
        const rawX = window.dialogueInputLocked ? 0 : (Math.abs(input.left.x) > 0.1 ? input.left.x : (keys.a ? -1 : (keys.d ? 1 : 0)));
        const rawY = window.dialogueInputLocked ? 0 : (Math.abs(input.left.y) > 0.1 ? input.left.y : (keys.w ? -1 : (keys.s ? 1 : 0)));
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
        // Keyboard input only reaches full run magnitude while shift is
        // held - WASD alone used to always land at rawMag 1.0 (a single key
        // is fully on or off, nothing in between), which meant keyboard
        // players could never walk at all, only run. The touch joystick is
        // untouched by this - its own analog deflection still decides walk
        // vs run exactly as before.
        const isKeyboardInput = Math.abs(input.left.x) <= 0.1 && Math.abs(input.left.y) <= 0.1 && (keys.w || keys.a || keys.s || keys.d);
        let moveMag = 0, curX = 0, curY = 0;
        if (rawMag > JOYSTICK_DEADZONE) {
            const wantsRun = rawMag >= JOYSTICK_RUN_THRESHOLD;
            moveMag = (wantsRun && (!isKeyboardInput || keys.shift)) ? 1.0 : JOYSTICK_WALK_MAG;
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

            // Shooter-box projectiles only ever aimed at/checked against the
            // local player (targetPos above) - the AI bot could stand right
            // in the line of fire and every shot would just pass through it.
            // Same reaction pattern the charge-attack projectile's own
            // bot-hit check already uses elsewhere in this file (no
            // network event - the bot is local-only, nothing to broadcast).
            if (window.aiBot && window.aiBot.isLoaded && !window.aiBot.isRagdoll) {
                const botHitPos = window.aiBot.getHitReferencePoint();
                if (botHitPos.distanceTo(p.mesh.position) < hitRadius) {
                    const flashStrengthByIntensity = { low: 0.5, medium: 0.9, medium_high: 1.4, high: 2.5 };
                    const hitStrength = flashStrengthByIntensity[p.intensity] || 2.5;
                    window.aiBot.triggerHitFlash(hitStrength);
                    if (p.intensity === 'high') window.aiBot.initRagdoll(p.velocity, p.intensity);
                    else window.aiBot.applyProceduralRecoil(p.velocity, p.intensity);
                    scene.remove(p.mesh); projectiles.splice(i, 1);
                    continue;
                }
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
                    // Sandbag excluded the same way locks already are just
                    // above/below - its own hitRadius-based checkHit/applyHit
                    // (further down this function) is meant to be the ONLY
                    // way a thrown object interacts with it. Left in this
                    // generic bounce loop, its solid box (half-extents
                    // 0.6/1.2/0.6, centered mid-height) reliably deflected a
                    // thrown object's own 1x1x1 carryBox before the object's
                    // CENTER ever got within checkHit's distance threshold -
                    // a throw arriving anywhere near hand height (well above
                    // the box's own center) bounced off every single time,
                    // so checkHit's dedicated hit reaction never got a
                    // chance to fire at all, regardless of where the sandbag
                    // was positioned.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || obj.userData?.isSandbagCollider || activeLockInstances.includes(obj)) return;
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
                    // Sandbag excluded the same way locks already are just
                    // above/below - its own hitRadius-based checkHit/applyHit
                    // (further down this function) is meant to be the ONLY
                    // way a thrown object interacts with it. Left in this
                    // generic bounce loop, its solid box (half-extents
                    // 0.6/1.2/0.6, centered mid-height) reliably deflected a
                    // thrown object's own 1x1x1 carryBox before the object's
                    // CENTER ever got within checkHit's distance threshold -
                    // a throw arriving anywhere near hand height (well above
                    // the box's own center) bounced off every single time,
                    // so checkHit's dedicated hit reaction never got a
                    // chance to fire at all, regardless of where the sandbag
                    // was positioned.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || obj.userData?.isSandbagCollider || activeLockInstances.includes(obj)) return;
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
                    // Sandbag excluded the same way locks already are just
                    // above/below - its own hitRadius-based checkHit/applyHit
                    // (further down this function) is meant to be the ONLY
                    // way a thrown object interacts with it. Left in this
                    // generic bounce loop, its solid box (half-extents
                    // 0.6/1.2/0.6, centered mid-height) reliably deflected a
                    // thrown object's own 1x1x1 carryBox before the object's
                    // CENTER ever got within checkHit's distance threshold -
                    // a throw arriving anywhere near hand height (well above
                    // the box's own center) bounced off every single time,
                    // so checkHit's dedicated hit reaction never got a
                    // chance to fire at all, regardless of where the sandbag
                    // was positioned.
                    if (obj === ground || obj === c.mesh || obj.userData?.isCarryable || obj.userData?.isSandbagCollider || activeLockInstances.includes(obj)) return;
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
            if (moveMag < 0.1) { ledgeMoveLocked = false; ledgeSidewaysGesture = false; ledgeCornerBufferApplied = false; }

            // Runs every frame regardless of ledgeMoveLocked (unlike the
            // shimmy block below, which stops running the instant that's
            // set) so the corner-edge retreat below keeps easing in instead
            // of freezing right after the single frame that starts it.
            if (ledgeCornerRetreating) {
                char.group.position.x = THREE.MathUtils.lerp(char.group.position.x, ledgeCornerRetreatTarget.x, Math.min(1, 12 * delta));
                char.group.position.z = THREE.MathUtils.lerp(char.group.position.z, ledgeCornerRetreatTarget.z, Math.min(1, 12 * delta));
                if (Math.abs(char.group.position.x - ledgeCornerRetreatTarget.x) < 0.01 && Math.abs(char.group.position.z - ledgeCornerRetreatTarget.z) < 0.01) {
                    char.group.position.x = ledgeCornerRetreatTarget.x;
                    char.group.position.z = ledgeCornerRetreatTarget.z;
                    ledgeCornerRetreating = false;
                }
            }

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
                    // Debug: THIS is the ray that actually decides whether a
                    // corner turn happens (wrap-success below calls
                    // char.group.lookAt(...) to re-orient) - the ledge-top
                    // ray added earlier only gates the plain sideways drift
                    // when this one finds nothing, it never turns anything.
                    // Cyan, same 'Show Ledge Top Ray' toggle.
                    if (!window._sideRayLine) {
                        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                        window._sideRayLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false }));
                        window._sideRayLine.raycast = () => {};
                        window._sideRayLine.renderOrder = 999;
                        scene.add(window._sideRayLine);
                    }
                    const sideRayToggle = document.getElementById('toggle-side-ray');
                    const showSideRay = !!sideRayToggle && sideRayToggle.checked;
                    if (showSideRay) {
                        const sideRayEnd = sH.length > 0 ? sH[0].point.clone() : chest.clone().addScaledVector(mDir, 1.5);
                        window._sideRayLine.geometry.setFromPoints([chest.clone(), sideRayEnd]);
                        window._sideRayLine.material.color.setHex(sH.length > 0 && sH[0].distance < 0.8 ? 0x00ffff : 0xff00ff);
                        window._sideRayLine.visible = true;
                    } else {
                        window._sideRayLine.visible = false;
                    }
                    const sideRayHitDisplay = document.getElementById('side-ray-hit-display');
                    if (sideRayHitDisplay) sideRayHitDisplay.textContent = sH.length > 0 ? sH[0].distance.toFixed(2) : 'none';
                    const isBlockedByWall = sH.length > 0 && sH[0].distance < 0.65;
                    const isBlocked = isBlockedByWall && !handled;

                    let debugBranch = 'none', debugHeightDiff = null;
                    if (sH.length > 0 && sH[0].distance < 0.8 && !isBlocked) {
                        const n = sH[0].face.normal.clone().transformDirection(sH[0].object.matrixWorld).setY(0).normalize();
                        const top = sH[0].point.clone().add(n.clone().multiplyScalar(-0.2)).setY(sH[0].point.y+2.0);
                        rayDown.set(top, _downVec); const h = rayDown.intersectObjects(solidCollidables);
                        // Debug: ray #3 - the ledge-top check for the CORNER
                        // WRAP path specifically (different from ray #4's
                        // fallback-path ledge-top check below) - orange,
                        // own toggle, default off.
                        if (!window._wrapTopRayLine) {
                            const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                            window._wrapTopRayLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff8800, depthTest: false }));
                            window._wrapTopRayLine.raycast = () => {};
                            window._wrapTopRayLine.renderOrder = 999;
                            scene.add(window._wrapTopRayLine);
                        }
                        const wrapTopRayToggle = document.getElementById('toggle-wrap-top-ray');
                        if (wrapTopRayToggle && wrapTopRayToggle.checked) {
                            const wrapTopEnd = h.length > 0 ? h[0].point.clone() : top.clone().addScaledVector(_downVec, 4.0);
                            window._wrapTopRayLine.geometry.setFromPoints([top.clone(), wrapTopEnd]);
                            window._wrapTopRayLine.material.color.setHex(h.length > 0 ? 0xff8800 : 0xff0000);
                            window._wrapTopRayLine.visible = true;
                        } else {
                            window._wrapTopRayLine.visible = false;
                        }
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
                            const freshFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion);
                            _tempVec2.copy(_tempVec3).setY(_tempVec3.y + 1.1);
                            rayFwd.set(_tempVec2, freshFwd);
                            const freshWallHits = rayFwd.intersectObjects(solidCollidables);
                            // Debug: ray #4 - the fallback path's own
                            // forward wall check (from the tentatively
                            // shifted position, still facing the OLD
                            // direction) - yellow, own toggle, default off.
                            if (!window._fallbackFwdRayLine) {
                                const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                                window._fallbackFwdRayLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false }));
                                window._fallbackFwdRayLine.raycast = () => {};
                                window._fallbackFwdRayLine.renderOrder = 999;
                                scene.add(window._fallbackFwdRayLine);
                            }
                            const fallbackFwdRayToggle = document.getElementById('toggle-fallback-fwd-ray');
                            if (fallbackFwdRayToggle && fallbackFwdRayToggle.checked) {
                                const fwdEnd = freshWallHits.length > 0 ? freshWallHits[0].point.clone() : _tempVec2.clone().addScaledVector(freshFwd, 2.0);
                                window._fallbackFwdRayLine.geometry.setFromPoints([_tempVec2.clone(), fwdEnd]);
                                window._fallbackFwdRayLine.material.color.setHex(freshWallHits.length > 0 && freshWallHits[0].distance < 0.8 ? 0xffff00 : 0xff0000);
                                window._fallbackFwdRayLine.visible = true;
                            } else {
                                window._fallbackFwdRayLine.visible = false;
                            }

                            // Debug: the "is there a ledge/cube up there"
                            // probe (Debug Vis: 'Show Ledge Top Ray', default
                            // on) - GREEN when it finds a real ledge surface
                            // within height tolerance (movement commits),
                            // RED when it doesn't (movement stays put) - the
                            // color IS the pass/fail condition, not just
                            // where the ray goes.
                            if (!window._ledgeTopRayLine) {
                                const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
                                window._ledgeTopRayLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff0000, depthTest: false }));
                                window._ledgeTopRayLine.raycast = () => {};
                                window._ledgeTopRayLine.renderOrder = 999;
                                scene.add(window._ledgeTopRayLine);
                            }
                            const ledgeTopRayToggle = document.getElementById('toggle-ledge-top-ray');
                            const showLedgeTopRay = !!ledgeTopRayToggle && ledgeTopRayToggle.checked;

                            let validLedgeTop = false;
                            let rayOrigin, rayEnd;
                            if (freshWallHits.length > 0 && freshWallHits[0].distance < 0.8) {
                                const ledgeTopProbe = freshWallHits[0].point.clone().add(freshFwd.clone().multiplyScalar(0.2)).setY(freshWallHits[0].point.y + 3.0);
                                rayOrigin = ledgeTopProbe.clone();
                                rayDown.set(ledgeTopProbe, _downVec);
                                const freshLedgeHits = rayDown.intersectObjects(solidCollidables);
                                rayEnd = freshLedgeHits.length > 0 ? freshLedgeHits[0].point.clone() : ledgeTopProbe.clone().addScaledVector(_downVec, 4.0);
                                if (freshLedgeHits.length > 0 && Math.abs(freshLedgeHits[0].point.y - (char.group.position.y + 1.85)) < 0.8) {
                                    validLedgeTop = true;
                                    char.group.position.copy(_tempVec3);
                                    ledgeTarget.copy(freshLedgeHits[0].point);
                                }
                            } else {
                                // No wall at all directly ahead of the
                                // shifted position - nothing to probe upward
                                // from, so this shows where that forward
                                // probe itself ended up instead (always red,
                                // nothing here to hold onto either way) -
                                // this is the actual "hit a sharp corner's
                                // edge" case, which previously just hid the
                                // ray entirely instead of showing red.
                                rayOrigin = _tempVec2.clone();
                                rayEnd = _tempVec2.clone().addScaledVector(freshFwd, 1.5);
                            }
                            if (showLedgeTopRay) {
                                window._ledgeTopRayLine.geometry.setFromPoints([rayOrigin, rayEnd]);
                                window._ledgeTopRayLine.material.color.setHex(validLedgeTop ? 0x00ff00 : 0xff0000);
                                window._ledgeTopRayLine.visible = true;
                            } else {
                                window._ledgeTopRayLine.visible = false;
                            }
                            const ledgeTopValidDisplay = document.getElementById('ledge-top-valid-display');
                            if (ledgeTopValidDisplay) ledgeTopValidDisplay.textContent = validLedgeTop;
                            if (!validLedgeTop) {
                                currentPushS = 0;
                                // Forward/ledge check above is intentionally
                                // unshifted (margin-free) so round corners
                                // can still get close enough to trigger the
                                // wrap-success branch above - this only runs
                                // once we've genuinely confirmed there's
                                // nowhere left to go. A single retreat here
                                // (not a per-frame one) gives the grab-hand
                                // animation's fixed lateral offset some
                                // clearance instead of overhanging past a
                                // dead-end edge; ledgeMoveLocked stops this
                                // from oscillating forward-and-back while the
                                // shimmy key is still held.
                                if (!ledgeCornerBufferApplied) {
                                    // isHangPositionClear only confirms there's
                                    // nothing IN THE WAY - it says nothing about
                                    // whether there's still a wall to hang onto
                                    // at all, so on its own it can't tell "safe
                                    // retreat" from "step into open air past
                                    // the ledge" (the same gap documented for
                                    // it elsewhere). A real forward-wall
                                    // raycast at the retreat point is required
                                    // too, or this can yank the player off a
                                    // perfectly good grab.
                                    const HAND_EDGE_BUFFER = 0.3;
                                    _tempVec1.copy(char.group.position).addScaledVector(mDir, -HAND_EDGE_BUFFER);
                                    if (isHangPositionClear(_tempVec1.x, char.group.position.y, _tempVec1.z, currentWallObj)) {
                                        _tempVec2.copy(_tempVec1).setY(_tempVec1.y + 1.1);
                                        rayFwd.set(_tempVec2, freshFwd);
                                        const retreatWallHits = rayFwd.intersectObjects(solidCollidables);
                                        if (retreatWallHits.length > 0 && retreatWallHits[0].distance < 0.8) {
                                            const retreatLedgeProbe = retreatWallHits[0].point.clone().add(freshFwd.clone().multiplyScalar(0.2)).setY(retreatWallHits[0].point.y + 3.0);
                                            rayDown.set(retreatLedgeProbe, _downVec);
                                            const retreatLedgeHits = rayDown.intersectObjects(solidCollidables);
                                            if (retreatLedgeHits.length > 0 && Math.abs(retreatLedgeHits[0].point.y - (char.group.position.y + 1.85)) < 0.8) {
                                                // Eased into over a few frames
                                                // (below, every frame) instead
                                                // of snapped instantly - the
                                                // last valid forward step
                                                // already lands right at the
                                                // true edge for one frame, so
                                                // an instant jump back reads
                                                // as a visible pop; easing
                                                // hides that as a quick settle
                                                // instead.
                                                ledgeCornerRetreatTarget.set(_tempVec1.x, char.group.position.y, _tempVec1.z);
                                                ledgeCornerRetreating = true;
                                                ledgeTarget.copy(retreatLedgeHits[0].point);
                                            }
                                        }
                                    }
                                    ledgeCornerBufferApplied = true;
                                    ledgeMoveLocked = true;
                                }
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
            char.animate(delta, 'ledge', currentPushS !== 0 ? moveMag : 0, time, 0, currentPushS, justGrabbedLedge);
            justGrabbedLedge = false;
            networkStateName = 'hang_idle';

            // Hand IK: pin each hand onto the actual grabbed surface. The
            // hang_idle/hang_left/hang_right clips assume one fixed grip
            // shape which visibly floats or embeds on a rounded/beveled
            // block edge (the whole reason for this - see the level
            // editor's radius-adjustable shapes). MUST run here, right
            // after char.animate('ledge') has posed the skeleton for this
            // frame - the whole rest of the frame's per-state logic
            // (including the leg-IK block) lives in the sibling `else`
            // branch that never executes while hanging, which is exactly
            // where an earlier version of this wrongly sat and so never
            // ran at all.
            //
            // Targeting: keep EACH hand's own animated X/Z (the hang clip
            // already spreads/places the hands correctly relative to the
            // body - moving them to a guessed shared spread instead is what
            // made the arms look warped/mislocated), and correct ONLY the
            // height, dropping each hand onto the real surface directly
            // under it. The downward probe starts from a touch forward of
            // the hand (toward the wall the character faces) so a hand
            // sitting right at the front edge still lands on the top
            // surface rather than shooting the ray straight past the edge
            // into empty space below. If no surface is found within a
            // sane band of the hand's current height, that hand's target
            // is left null - the arm-aim call then leaves that arm's
            // animated pose alone for the frame rather than yanking it
            // somewhere wrong.
            //
            // Uses applyArmAim (shoulder-only re-aim, keeps the animated
            // arm shape) by default rather than the full 2-bone applyArmIK
            // (which warped the arm when its elbow pole was off) - the
            // whole problem is only a small rounded/beveled-edge float, so
            // nudging the arm's aim toward the real contact point looks far
            // more natural than a hard exact solve. window.ledgeHandUseIK
            // flips back to the full solve if ever wanted.
            if (char.fbxModel && char.leftHandBone && char.rightHandBone && ledgeTarget.lengthSq() > 0) {
                // Aim each arm at the ACTUAL grip point on the grabbed
                // block (ledgeTarget - the surface point the grab/shimmy
                // logic already computed, so it's a real point ON the
                // block, not wherever the clip's hand happens to float in
                // front of a rounded edge). A plain downward probe from the
                // hand itself misses exactly this case (the floating hand
                // is in front of the block, so the ray drops past the edge
                // to the ground). Spread the two aim points left/right of
                // ledgeTarget along the character's own right axis so the
                // hands don't converge. Aim (not full IK) keeps the clip's
                // natural arm shape and just pivots it toward the grip, so
                // an approximate target can't warp the arm.
                const rgt = _tempVec1.set(1, 0, 0).applyQuaternion(char.group.quaternion);
                const spread = window.ledgeHandSpread !== undefined ? window.ledgeHandSpread : -0.3;
                const yLift = window.ledgeHandGrip !== undefined ? window.ledgeHandGrip : 0.3;
                const lt = _tempVec2.copy(ledgeTarget).addScaledVector(rgt, -spread); lt.y += yLift;
                const rt = _tempVec3.copy(ledgeTarget).addScaledVector(rgt, spread); rt.y += yLift;
                const ikW = window.ledgeHandIKWeight !== undefined ? window.ledgeHandIKWeight : 1.0;
                if (window.ledgeHandUseIK) char.applyArmIK(lt, rt, ikW);
                else char.applyArmAim(lt, rt, ikW);
                window._dbgHangIK = { ran: true, ledgeTargetY: +ledgeTarget.y.toFixed(2), spread };
                // Debug viz (Debug Vis: 'Show Ledge Hand IK') - draws the
                // two aim targets (red=left, blue=right), the ledgeTarget
                // (yellow), a line from each actual hand bone to its aim
                // target (so the gap the arm is trying to close is visible),
                // and a readout above the head. All created lazily and
                // updated in place, hidden when the toggle is off (handled
                // in the always-run debug section further down). lt/rt were
                // read AFTER applyArmAim moved the arms above, so grab the
                // current hand world positions here for the gap lines.
                updateHangIKDebugViz(lt, rt, ledgeTarget, char, spread, yLift, ikW);
            } else {
                window._dbgHangIK = { ran: false, ledgeTargetLen: +ledgeTarget.lengthSq().toFixed(2) };
            }
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

            // Gradual step-back accompanying a drop/throw that had a wall too
            // close in front - see attemptCarryAction/isMakingRoom's own
            // comment. Movement/turning are already gated off elsewhere
            // (the !isMakingRoom checks added alongside isCarryStarting/
            // isCarryDropping) so this is the only thing moving the player
            // during this window. The drop/throw is already running by now;
            // this just carries the body back underneath it.
            if (isMakingRoom) {
                makeRoomElapsed += delta;
                const t = Math.min(1, makeRoomElapsed / makeRoomDuration);
                char.group.position.lerpVectors(makeRoomStartPos, makeRoomTargetPos, t);
                if (t >= 1) {
                    isMakingRoom = false;
                    // Only ever set for a blocked throw; everything else has
                    // already been running alongside the slide.
                    if (pendingCarryAction === 'throw') { pendingCarryAction = null; performThrow(); }
                }
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
            // Punch doesn't make sense with your hands full (carrying, or
            // mid carry-start/drop transition) or while hanging on a ledge -
            // hide the button entirely rather than just letting a press
            // silently do nothing. Also gated on window.punchButtonEnabled
            // (default false - see the "UI" panel's "Show Punch Button"
            // checkbox), since it's not part of the default control set
            // until a teaching level actually introduces the mechanic.
            if (punchBtnEl) punchBtnEl.style.display = (window.punchButtonEnabled && !isLedgeGrabbing && !window.isCarryingObj && !window.isCarryStarting && !window.isCarryDropping) ? 'flex' : 'none';

            // Village NPC proximity trigger - only relevant while that
            // level's NPC actually exists (villageNpcAvatar is null on
            // every other level). Approaching STARTS the dialogue (see
            // startVillageDialogue) rather than giving the quest directly -
            // villageQuestGiven only latches true once the dialogue
            // actually finishes (see endVillageDialogue), so walking away
            // and back mid-conversation can't retrigger it, and finishing
            // it once is enough to never show it again.
            if (villageNpcAvatar && !villageQuestGiven && !villageDialogueActive) {
                const ndx = char.group.position.x - villageNpcAvatar.group.position.x;
                const ndz = char.group.position.z - villageNpcAvatar.group.position.z;
                if (ndx * ndx + ndz * ndz < VILLAGE_NPC_TALK_RADIUS * VILLAGE_NPC_TALK_RADIUS) startVillageDialogue();
            }
            if (villageNpcAvatar) villageNpcAvatar.update(delta);
            if (villageDialogueActive) updateVillageDialogueTypewriter(delta);

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
                // Was the raw carry_start clip's own length - reasonable
                // for how long the animation takes to play, but with the
                // player now frozen for its whole duration (see the
                // position-lock above), that read as an unnecessarily long
                // hard stop just to pick something up. Scaling it down
                // shortens the freeze/lerp-to-hand window without touching
                // the clip itself - fadeToAction's own crossfade (called
                // once isCarryingObj takes over) smooths over the clip not
                // having finished playing yet.
                const duration = (char.originalClips['carry_start'] ? char.originalClips['carry_start'].duration : 1.0) * (window.carryStartSpeedMult !== undefined ? window.carryStartSpeedMult : 0.4);
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
            } else if (window.isCarryDropping && !heldCarryable) {
                // Belt-and-braces: this branch owns clearing isCarryDropping,
                // and it can only do that while heldCarryable still exists. If
                // anything else nulls the held object mid-drop the flag would
                // stay set forever and the character would hold the drop
                // (crouched) pose indefinitely, unable to walk it off. Rather
                // than trust every other site not to do that, end the state
                // here if the object has gone.
                window.isCarryDropping = false;
                char.stopUpperAction(0.2);
            } else if (window.isCarryDropping && heldCarryable) {
                carryStartElapsed += delta;
                // The "lowering" motion (arms visibly relaxing down from the
                // carry pose) is actually driven by stopUpperAction's own
                // fade in the animate() dispatch, not by carry_start's own
                // reverse playback - scrubbing carry_start in isolation shows
                // its own hand-height contribution barely changes across the
                // whole clip. Matches that fade's duration (see the
                // isCarryDropping branch in animate()) exactly, so this lerp
                // and the arm motion it's tracking finish together.
                //
                // Default is the clip's own natural length, not an arbitrary
                // shorter number - the reversed clip itself always plays back
                // at a flat real-time rate (playCarryDrop's timeScale is a
                // constant -1, untouched by this value), so a shorter
                // duration here only ends isCarryDropping (and hands off to
                // idle/walk) before carry_start had actually finished
                // reverse-playing to its true end pose, cutting it off
                // mid-motion every time.
                //
                // Full clip length alone read as too slow overall - rather
                // than shortening this back down (which reintroduces the
                // cutoff), playCarryDrop() now reverse-plays the clip faster
                // (timeScale -carryDropSpeedMult instead of a flat -1), so it
                // still covers the whole clip and reaches its true end pose,
                // just in less real time. This duration is derived from that
                // same speed so everything keeps finishing together.
                const duration = carryDropDuration();
                const t = Math.max(0.0, Math.min(1.0, carryStartElapsed / duration));

                // Tracks the live hand position (not a fixed snapshot from
                // the moment drop was pressed) same as the pickup lerp does
                // with handMidpoint above - the hands are still animating
                // downward through this whole window. A fixed start point
                // drifted out of sync with that motion (object visibly still
                // airborne after the animation had already finished its
                // placing motion); chasing the actual hand bones keeps the
                // two in step and only hands off to the fixed ground target
                // (dropTargetPos) as t approaches 1.
                let basePos = new THREE.Vector3();
                basePos.x = THREE.MathUtils.lerp(handMidpoint.x, dropTargetPos.x, t);
                basePos.z = THREE.MathUtils.lerp(handMidpoint.z, dropTargetPos.z, t);
                basePos.y = THREE.MathUtils.lerp(handMidpoint.y, dropTargetPos.y, t);

                const headY = char.group.position.y + 1.65;
                const heightDiff = basePos.y - headY;
                const range = 1.1;
                const factor = Math.max(0, 1 - Math.abs(heightDiff) / range);
                const smoothFactor = factor * factor * (3 - 2 * factor);

                // Push the object out in front of the body while it's still up
                // around chest/head height, so it doesn't sweep through the
                // character on the way down.
                //
                // The (1 - t) is what keeps the landing stable. smoothFactor
                // depends only on the object's height relative to the head, so
                // without it the offset is still ~0.6 at t=1 and the object
                // finishes that far IN FRONT of dropTargetPos - not on the spot
                // the placement search actually vetted as clear. Landing off
                // that spot left the carryable physics loop to resolve the
                // difference on the next frame, which is the sideways skid
                // right after a drop. Invisible on flat ground (heightDiff
                // exceeds `range` there, so smoothFactor is already 0) - it
                // only showed up when dropping onto something raised.
                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(char.group.quaternion);
                const offsetDistance = 0.8 * smoothFactor * (1 - t);
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
                    // Same isOnActiveLock exemption as the ground-follow
                    // gate above - an unlocked lock's near-vertical faces
                    // must stop reading as a wall too, or the character
                    // never gets close enough to climb onto it.
                    const hitParent = actualHits[0].object.parent;
                    const isActiveLockWall = !!(hitParent && hitParent.userData && hitParent.userData.isLock && hitParent.userData.keyInserted);
                    let treatAsWall = !isActiveLockWall && realSurfaceAngle > wallCutoffForHit;
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

                // Exposed so a charge punch's projectile (ClimbGame.html,
                // spawnChargeAttackProjectile) can add the player's own
                // motion into the throw, same as throwing a ball while
                // running adds your own running speed to it - captured here,
                // before finalMoveDir below gets multiplied down into a
                // per-frame displacement (it stops being a direction vector
                // after that line).
                window.playerVelocityVec = window.playerVelocityVec || new THREE.Vector3();
                window.playerVelocityVec.copy(finalMoveDir).multiplyScalar(actualSpeed);

                // Frozen during carry_start AND carry drop: both lerps
                // (pickup below, drop further down) blend the object between
                // a fixed start/target every frame, so if the player kept
                // moving during that window the target itself moved too, and
                // the object visibly chased/trailed behind them instead of
                // arriving in-hand (pickup) or landing where aimed (drop).
                // Standing still for the duration removes that moving-target
                // problem entirely.
                if (!isBuilding && !window.isCarryStarting && !window.isCarryDropping && !isMakingRoom && actualSpeed > 0.05) char.group.position.add(finalMoveDir.multiplyScalar(actualSpeed * delta));
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
                if (!isSliding && !isHitRecovering && !window.isCarryStarting && !window.isCarryDropping && !isMakingRoom) char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, mAng), window.CHAR_TURN_RATE*delta);
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
                    // Captured BEFORE the setY(0) flatten below destroys the
                    // real 3D normal - this is the grabbed face's actual
                    // steepness (its normal's angle from straight up; 90deg
                    // = a dead-vertical wall, less = a leaning/sloped face).
                    // Stashed for the hang-angle debug readout so it's
                    // possible to see WHY a surprisingly steep-looking face
                    // was still grabbable (anything past SLOPE_WALL_CUTOFF).
                    const grabWallAngleDeg = realWallNormal.angleTo(_upVec) * 180 / Math.PI;
                    const grabWallNormalWorld = realWallNormal.clone();
                    const n = realWallNormal.setY(0).normalize();
                    const top = wH[0].point.clone().add(fwd.clone().multiplyScalar(0.2)).setY(wH[0].point.y+3.0);
                    rayDown.set(top, _downVec); const lH = rayDown.intersectObjects(solidCollidables);
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
                            isLedgeGrabbing = true; ledgeMoveLocked = true; justGrabbedLedge = true;
                            // Clear any leftover corner-retreat from a PREVIOUS
                            // hang - if you shimmied into a corner (which arms
                            // ledgeCornerRetreating + ledgeCornerRetreatTarget)
                            // and released before that ease-in finished, the
                            // flag stayed set with the old target. On this
                            // fresh grab the hang branch's retreat lerp would
                            // then immediately drag you from THIS ledge back to
                            // that stale spot - the "grab somewhere, then grab
                            // elsewhere and teleport back to the first grab"
                            // bug. Reset the whole corner-retreat/shimmy
                            // sub-state here so a new grab always starts clean.
                            ledgeCornerRetreating = false;
                            ledgeCornerBufferApplied = false;
                            ledgeSidewaysGesture = false;
                            lockedHintAngle = null;
                            if (yVelocity < -22) { isSlipping = true; slipTimer = 0; } else isSlipping = false;
                            yVelocity = 0; ledgeTarget.copy(lH[0].point);
                            // Grabbed-surface info for the hang-angle debug
                            // readout (Debug Vis: 'Show Ledge Hand IK').
                            window._dbgGrabWallAngleDeg = grabWallAngleDeg;
                            window._dbgGrabWallCutoffDeg = SLOPE_WALL_CUTOFF * 180 / Math.PI;
                            window._dbgGrabWallNormal = grabWallNormalWorld;
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
            // Leg IK fades OUT while sliding. It used to stay on: sliding
            // happens on a slope, so isOnSlopeSurface is true, and the player
            // is usually not pushing anything, so the speed-based weight below
            // sits at its maximum of 1.0 - full-strength ground planting right
            // on top of the slide clip. The feet stayed pinned wherever the
            // walk cycle had just left them instead of taking the slide's own
            // pose, which is the odd-looking foot pose on entry.
            //
            // Faded over LEG_IK_FADE rather than switched off outright,
            // because a hard cut is what would make the feet jump at the exact
            // moment the slide starts. The other exclusions on this line are
            // hard cuts, but those states begin from a full-body clip change
            // that hides the transition; a slide starts mid-stride.
            const LEG_IK_FADE = 0.12;
            legIKBlend += ((isSliding ? 0 : 1) - legIKBlend) * Math.min(1, delta / LEG_IK_FADE);
            if ((isOnSlopeSurface || isOnBumpTerrain) && !isClimbingSlope && !isLedgeGrabbing && !isClimbingUp && legIKBlend > 0.01 && char.fbxModel) {
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
                const legIKWeight = THREE.MathUtils.clamp(1.0 - effectiveMoveMag, 0.35, 1.0) * legIKBlend;
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
        updateCompanion(delta);
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

        // Horizontal follow distance: normally just the plain sin(phi)-
        // scaled spherical formula, but blended down toward
        // cameraMinCloseDistance near the top and bottom of the tilt range
        // - see this block's own declaration comment.
        //
        // The two ends are keyed differently on purpose. Going DOWN, the
        // trigger is an absolute elevation above the horizon
        // (cameraCloseStartElevation, default 45 deg), so the approach
        // starts while the camera is still clearly above the player and
        // finishes at the bottom clamp. Keying it off the clamp margin
        // instead - what this used to do - meant nothing happened until the
        // camera was already at eye level or below. Going UP, the old
        // clamp-margin rule is kept as-is (cameraCloseStartAngle).
        //
        // closeT is 1 at full distance, 0 at cameraMinCloseDistance; the two
        // ends take whichever is tighter.
        const rawHorizDist = cameraRadius * Math.sin(cameraPhi);
        const closeStartAngle = window.cameraCloseStartAngle !== undefined ? window.cameraCloseStartAngle : 0.7;
        const minCloseDist = window.cameraMinCloseDistance !== undefined ? window.cameraMinCloseDistance : 5.0;
        const closeStartElev = window.cameraCloseStartElevation !== undefined ? window.cameraCloseStartElevation : 45.0;
        // phi measured from straight up, so the threshold elevation in phi
        // terms is 90 - elevation.
        const closeStartPhi = THREE.MathUtils.degToRad(90 - closeStartElev);
        let horizDist;
        if (cameraPhi > closeStartPhi) {
            // BELOW the threshold. Ease from the distance the camera had AT
            // the threshold down to minCloseDist at the bottom clamp.
            //
            // Referencing that fixed threshold distance - rather than the
            // live sin(phi) one - is the part that matters. sin(phi) keeps
            // GROWING all the way down to level, so blending against it made
            // the camera drift further out through most of the descent and
            // only rush in over the last few degrees. That is exactly the
            // "it only starts approaching once it's parallel to the ground"
            // complaint. Against a fixed reference the approach is monotonic:
            // every degree down brings the camera in.
            const span = Math.max(1e-4, CAMERA_PHI_MAX - closeStartPhi);
            const t = THREE.MathUtils.clamp((CAMERA_PHI_MAX - cameraPhi) / span, 0, 1);
            const refDist = cameraRadius * Math.sin(closeStartPhi);
            horizDist = THREE.MathUtils.lerp(minCloseDist, refDist, t);
        } else {
            // ABOVE it: the plain formula, plus the original close-in near the
            // top clamp (looking down from almost directly overhead). Its
            // reach is capped so it can never extend past the threshold - the
            // two rules meet there at full distance, so there is no step to
            // see when crossing. 0 disables the top-end shrink.
            const topMargin = Math.min(closeStartAngle, closeStartPhi - CAMERA_PHI_MIN);
            horizDist = rawHorizDist;
            if (topMargin > 0) {
                const t = THREE.MathUtils.clamp((cameraPhi - CAMERA_PHI_MIN) / topMargin, 0, 1);
                if (t < 1) horizDist = THREE.MathUtils.lerp(minCloseDist, rawHorizDist, t);
            }
        }

        let targetCamX = camTarget.x + horizDist * Math.sin(cameraTheta);
        let targetCamY = Math.max(floorY + 0.5, camTarget.y + cameraRadius * Math.cos(cameraPhi) + 1.5);
        let targetCamZ = camTarget.z + horizDist * Math.cos(cameraTheta);

        // Village dialogue overrides the normal follow-cam with a fixed
        // two-shot framing (computed once in startVillageDialogue) instead
        // of the usual orbit math - eased in with the same lerp rate so it
        // doesn't just snap there.
        if (window._dialogueCamPos) {
            camera.position.lerp(window._dialogueCamPos, 8 * delta);
            camera.lookAt(window._dialogueCamTarget);
        } else {
            camera.position.lerp(_tempVec2.set(targetCamX, targetCamY, targetCamZ), 15 * delta);
            camera.lookAt(camTarget.x, camTarget.y, camTarget.z);
        }
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
        // Ground-scan readout: which surface the slope/slide logic decided it
        // is standing on, and how steep it read. Chasing "the character
        // stumbles / starts sliding at the seam between two adjacent boxes"
        // is impossible without seeing the normal it actually picked.
        window._dbgIsSliding = isSliding;
        window._dbgSlopeDeg = +THREE.MathUtils.radToDeg(_dbgGroundNormalOut.angleTo(_upVec)).toFixed(1);
        window._dbgGroundNormalXYZ = [+_dbgGroundNormalOut.x.toFixed(3), +_dbgGroundNormalOut.y.toFixed(3), +_dbgGroundNormalOut.z.toFixed(3)];
        window._dbgCameraPhi = cameraPhi;
        // The follow-cam's horizontal distance after the close-in blend - the
        // number the "Close-In Start Elevation" slider is actually tuning, so
        // it's worth being able to read it off directly.
        window._dbgCamHorizDist = horizDist;
        window._dbgYVelocity = yVelocity;
        window._dbgIsLedgeGrabbing = isLedgeGrabbing;
        // Hang hand-IK debug markers/lines only make sense while hanging -
        // updateHangIKDebugViz shows/updates them during the hang branch;
        // hide them here every other frame so they don't freeze on-screen
        // at the last grip spot after letting go.
        if (!isLedgeGrabbing) setHangIKDebugVisible(false);
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
        const SPEED_LABEL_MAX_LINES = 8;
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
            // Every clip on the mixer, not just the base locomotion trio -
            // was hardcoded to ['idle','walk','run'] only, so anything else
            // playing (ledge/hang_idle, air, climbing, upper-body actions
            // like punches, ...) was invisible here even though it's
            // exactly what you'd need to see to debug a transition between
            // two non-locomotion states.
            Object.keys(char.actions || {}).forEach(name => {
                const a = char.actions[name];
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
                if (w > 0) parts.push({ name, w });
            });
            parts.sort((a, b) => b.w - a.w);
            const lines = [spd.toFixed(1) + ' u/s'].concat(parts.length ? parts.map(p => p.name + ' ' + p.w + '%') : ['-']).slice(0, SPEED_LABEL_MAX_LINES);
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
        // window.compassTarget overrides the default "point at the
        // finish" behavior - set once a quest gives the player somewhere
        // specific to go (see buildVillageLevel's forest-entrance quest),
        // cleared (null) by any level that doesn't use it, so this always
        // falls back to the original star-pointing behavior everywhere else.
        compassMesh.lookAt(window.compassTarget || star.position);
        compassMesh.updateMatrixWorld();

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
        // Guarded: resize can happen before the editor has ever been
        // opened, since it's now loaded lazily (see ensureLevelEditorLoaded).
        if (levelEditor) {
            levelEditor.camera.aspect = window.innerWidth/window.innerHeight; levelEditor.camera.updateProjectionMatrix();
            levelEditor.setSize(window.innerWidth, window.innerHeight);
        }
        // Same lazy-load guard as levelEditor above - Viewer.camera only
        // exists once the compendium button has been opened at least once.
        if (Viewer.camera) {
            Viewer.camera.aspect = window.innerWidth/window.innerHeight; Viewer.camera.updateProjectionMatrix();
            Viewer.renderer.setSize(window.innerWidth, window.innerHeight);
        }
    }
    window.addEventListener('resize', handleViewportResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', handleViewportResize);
}