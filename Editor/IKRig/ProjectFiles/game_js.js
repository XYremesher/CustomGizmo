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
    window.pixelEffectEnabled = true;
    const composer = new EffectComposer(renderer);
    // Pixel size 1 - no pixelation at all. The pass is kept purely for its
    // depth-edge outline; raise the Pixel Size slider for the chunky look.
    const renderPixelatedPass = new RenderPixelatedPass(1, scene, camera);
    renderPixelatedPass.normalEdgeStrength = 0.0;
    // 7, well past the 0..1 the pass's own maths assumes: the indicator is
    // quantised to 0 / 0.5 / 1 and the result is texel * (1 - strength * dei),
    // so anything over 2 drives an edge fragment negative and it clamps to
    // solid black. That is the point - a hard black outline rather than a
    // darkened one.
    renderPixelatedPass.depthEdgeStrength = 7.0;
    composer.addPass(renderPixelatedPass);
    composer.addPass(new OutputPass());

    // ---- Depth-edge fix ----
    // The stock pass differences the RAW depth buffer and thresholds it at a
    // fixed smoothstep(0.01, 0.02). Depth buffers are wildly non-linear, so
    // that threshold is only meaningful right in front of the camera: with
    // near 0.1 / far 1000, a half-unit step is 0.0100 of buffer range at 2
    // units out, 0.0018 at 5, and 0.00003 at 40. Everything past a couple of
    // metres therefore falls under the threshold and produces no edge at all -
    // which is exactly the "only works on very close things" complaint. Turning
    // depthEdgeStrength up cannot help, because the indicator it multiplies is
    // already zero.
    //
    // The fix is to compare LINEAR view depth and to make the comparison
    // relative (difference divided by distance), which is scale-invariant: a
    // 3% depth step reads as an edge whether it is 2 metres away or 200.
    //
    // Done by patching the pass's own shader rather than by forking the class,
    // and every replacement is verified - if a three.js update changes the
    // source out from under this, it leaves the stock shader alone and says so
    // rather than silently rendering a broken pass.
    window.pixelDepthEdgeSensitivity = 0.055;  // relative depth step counted as an edge
    const _pixelEdgeUniforms = {
        uEdgeNear: { value: 0.1 },
        uEdgeFar: { value: 1000 },
        uEdgeOrtho: { value: 0 },
        uEdgeLo: { value: 0.055 },
        uEdgeHi: { value: 0.1375 },
    };
    (function patchPixelDepthEdge() {
        const mat = renderPixelatedPass.pixelatedMaterial;
        if (!mat) { console.warn('RenderPixelatedPass: no material to patch'); return; }
        let fs = mat.fragmentShader;
        // 1. helpers + uniforms, right after the varying every version declares
        const declRe = /varying\s+vec2\s+vUv\s*;/;
        if (!declRe.test(fs)) { console.warn('RenderPixelatedPass: shader layout changed, depth-edge fix skipped'); return; }
        fs = fs.replace(declRe, `varying vec2 vUv;
                uniform float uEdgeNear, uEdgeFar, uEdgeOrtho, uEdgeLo, uEdgeHi;
                float linearizeDepth(float d) {
                    // Orthographic depth is already linear in view space.
                    if (uEdgeOrtho > 0.5) return uEdgeNear + d * (uEdgeFar - uEdgeNear);
                    float z = d * 2.0 - 1.0;
                    return (2.0 * uEdgeNear * uEdgeFar) / (uEdgeFar + uEdgeNear - z * (uEdgeFar - uEdgeNear));
                }
                float getLinearDepth(int x, int y) {
                    return linearizeDepth(texture2D(tDepth, vUv + vec2(x, y) * resolution.zw).r);
                }`);
        // 2. the depth-edge indicator itself. getDepth is deliberately left
        //    alone - neighborNormalEdgeIndicator uses it with a hardcoded
        //    0.0025 bias tuned for raw buffer values, so linearising it
        //    globally would change the NORMAL edges too.
        const indRe = /float\s+depthEdgeIndicator\s*\(([^)]*)\)\s*\{[\s\S]*?smoothstep\([^)]*\)[^}]*\}/;
        if (!indRe.test(fs)) { console.warn('RenderPixelatedPass: depthEdgeIndicator not found, fix skipped'); return; }
        fs = fs.replace(indRe, `float depthEdgeIndicator($1) {
                    // INVERSE depth, and a second difference rather than a
                    // first one.
                    //
                    // A first difference calls any depth step an edge, and a
                    // surface seen at a grazing angle is nothing but depth
                    // steps: on flat ground 150 units out, one pixel of
                    // screen space is already 7.6 units further away - a 5%
                    // relative step, past any usable sensitivity. Every row of
                    // pixels near the horizon therefore lit up, which is the
                    // thick band along it. Tightening the threshold does not
                    // help; it only moves the band.
                    //
                    // 1/z is LINEAR in screen space across any plane, whatever
                    // its angle, so the second difference of 1/z is zero on
                    // flat ground and large only where the surface actually
                    // breaks. That is the difference between "far away" and
                    // "a silhouette".
                    float w  = 1.0 / max(getLinearDepth( 0,  0), 1e-4);
                    float wl = 1.0 / max(getLinearDepth(-1,  0), 1e-4);
                    float wr = 1.0 / max(getLinearDepth( 1,  0), 1e-4);
                    float wd = 1.0 / max(getLinearDepth( 0, -1), 1e-4);
                    float wu = 1.0 / max(getLinearDepth( 0,  1), 1e-4);
                    float curv = abs(wl + wr - 2.0 * w) + abs(wd + wu - 2.0 * w);
                    // Normalised by w, so the measure stays the same relative
                    // depth step the sensitivity slider is calibrated in.
                    float edge = curv / w;
                    // Only the NEARER side of a break draws, so a silhouette
                    // yields one line instead of one on each surface.
                    float nearer = step(0.0, w - 0.25 * (wl + wr + wd + wu));
                    return floor(smoothstep(uEdgeLo, uEdgeHi, edge) * 2.) / 2. * nearer;
                }`);
        mat.fragmentShader = fs;
        Object.assign(mat.uniforms, _pixelEdgeUniforms);
        mat.needsUpdate = true;
    })();

    // ---- Light budget ----
    // ONE shadow-casting directional, not two. There used to be a tight,
    // sharp "near" light plus a wide, coarse "far" one, and that split was
    // the direct cause of two separate complaints:
    //
    //   - A visible SEAM. The two boxes cover different areas with no
    //     blending between them, so shadow depth changed in a step exactly
    //     where the near box ended. That is what a real cascaded shadow map
    //     solves by blending cascades; three.js has no built-in blend, so
    //     the seam was not tunable away.
    //   - NO SELF-SHADOWING. Only the fine near map could resolve the head
    //     onto the shoulders or a contact patch on the ground, but anything
    //     outside its box reads as fully lit BY IT regardless of occlusion,
    //     so its intensity was a hard floor under how dark a distant shadow
    //     could get. Splitting the budget to fix distant shadows starved
    //     the near light down to ~10% and its detail stopped being visible.
    //
    // A single light removes the seam by construction and gets the whole
    // budget, so its detail actually shows. The box is sized so the texel
    // density MATCHES the old near light (0.039 world units) while covering
    // twice the radius, because the map is 4096 rather than 2048 - 160/4096
    // is the same as 80/2048. It is also one shadow pass instead of two.
    //
    // What is genuinely given up: beyond shadowRange from the player there
    // is no shadow at all, where the old far light reached 200 units. That
    // edge is a cliff rather than a seam, and it sits twice as far out.
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.55);
    dirLight.position.set(0.1, 40, 0.1);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 4096; dirLight.shadow.mapSize.height = 4096;
    dirLight.shadow.camera.near = 0.5; dirLight.shadow.camera.far = 200;
    // Live-tunable: the one meaningful knob now that there is a single
    // light. Smaller = sharper shadows and better self-shadowing over a
    // smaller area; larger = shadows further out but blurrier, and
    // eventually too coarse to resolve the character onto itself.
    window.shadowRange = 120;
    window._shadowCameraHalfExtent = window.shadowRange;
    function applyShadowRange() {
        const r = window.shadowRange;
        window._shadowCameraHalfExtent = r;
        dirLight.shadow.camera.left = -r; dirLight.shadow.camera.right = r;
        dirLight.shadow.camera.top = r; dirLight.shadow.camera.bottom = -r;
        dirLight.shadow.camera.updateProjectionMatrix();
        // Bias has to scale with texel size or it stops matching: too little
        // and surfaces self-shadow into acne, too much and shadows detach
        // from their casters (the head losing contact with the ground).
        // These are the values that worked at the old 0.039 density,
        // expressed as a ratio of it.
        const texel = (r * 2) / dirLight.shadow.mapSize.width;
        dirLight.shadow.normalBias = 0.02 * (texel / 0.039);
        dirLight.shadow.bias = -0.0001 * (texel / 0.039);
    }
    applyShadowRange();
    scene.add(dirLight); scene.add(dirLight.target);

    // Angled "fill" light - no shadow map (the expensive part of a light,
    // not the lighting math itself), so it is cheap to have a second
    // directional source giving depth/rim definition from the side instead
    // of everything being lit from directly overhead. Kept well below its
    // original 1.0 because it can never be occluded, and an unshadowable
    // light of that weight stopped flat-normal surfaces (grass, leaf cards)
    // from reading as shadowed at all: with ambient it sets the floor on how
    // dark anything in shadow can get, currently 1.05 of a 2.60 total (40%).
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
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
    const groundTex = texLoader.load('ground.jpg');
    groundTex.wrapS = THREE.RepeatWrapping; groundTex.wrapT = THREE.RepeatWrapping;
    groundTex.repeat.set(150, 150);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshToonMaterial({ map: groundTex, gradientMap: threeTone }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);

    window.ground = ground;

    // ---- Forest clearing tint ----
    // Turns the ground yellow wherever the forest's own noise says no tree
    // belongs, so the gaps between the trees read as worn paths rather than
    // uniform grass. Driven by a mask painted from the SAME noise the scatter
    // uses (see buildForestLevel), so the yellow lands exactly where the trees
    // are not - anything else would only be a coincidence that drifts the
    // moment the seed or density changes.
    //
    // A tint on the existing texture rather than a second material or a
    // replacement map: the ground is one 1000-unit plane shared by every
    // level, so it has to stay one draw call and be switchable off. It
    // MULTIPLIES the sampled colour rather than replacing it, which keeps the
    // grass detail visible through the yellow instead of flattening it to a
    // solid patch.
    const _groundTintUniforms = {
        uForestMask: { value: null },
        uForestTintOn: { value: 0 },
        uForestArea: { value: 1 },
        // Target colour for the worn ground, and how far to go toward it.
        // A per-channel MULTIPLIER was tried first and cannot reach beige:
        // the grass texture's green channel is the strongest, so scaling
        // channels keeps green dominant and only ever yields a yellow-green.
        // Tinting toward an explicit colour is the only way to actually leave
        // the green behind.
        uForestTintColor: { value: new THREE.Color(0xd9c9a6) },
        uForestTintAmt: { value: 0.85 },
    };
    ground.material.onBeforeCompile = (shader) => {
        shader.uniforms.uForestMask = _groundTintUniforms.uForestMask;
        shader.uniforms.uForestTintOn = _groundTintUniforms.uForestTintOn;
        shader.uniforms.uForestArea = _groundTintUniforms.uForestArea;
        shader.uniforms.uForestTintColor = _groundTintUniforms.uForestTintColor;
        shader.uniforms.uForestTintAmt = _groundTintUniforms.uForestTintAmt;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                uniform sampler2D uForestMask;
                uniform float uForestTintOn;
                uniform float uForestArea;
                uniform vec3 uForestTintColor;
                uniform float uForestTintAmt;
                varying vec3 vGroundWorld;`)
            .replace('#include <map_fragment>', `#include <map_fragment>
                if (uForestTintOn > 0.5) {
                    // World xz -> mask uv. The mask only covers the forest
                    // area; outside it the ground stays plain grass, which is
                    // what bounds the effect to the wood itself.
                    vec2 muv = vGroundWorld.xz / uForestArea + 0.5;
                    if (muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0) {
                        float openness = texture2D(uForestMask, muv).r;
                        // Tint toward beige while keeping the texture's own
                        // light and dark variation: the target is scaled by
                        // the grass luminance, so blades and dirt still read
                        // through instead of the path becoming a flat blob.
                        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
                        vec3 worn = uForestTintColor * (0.55 + 0.9 * lum);
                        diffuseColor.rgb = mix(diffuseColor.rgb, worn, openness * uForestTintAmt);
                    }
                }`);
    };
    // onBeforeCompile is not part of three's program cache key, so without
    // this the ground could be handed an identically-configured material's
    // compiled program and silently lose the injection.
    ground.material.customProgramCacheKey = () => 'ground-forest-tint';

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
    // 4000, up from 2000. Instanced, so the cost of the extra blades is a
    // bigger instance buffer and nothing else - and with 60% of the budget now
    // going to tree bases, 2000 worked out to about six blades per tree, which
    // does not read as a ring around anything.
    window.grassCount = 4000;
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
    // ---- Grass at the foot of trees ----
    // The scatter is uniform random over grassArea, which spreads a fixed
    // budget of blades evenly across the whole level - so the wooded parts,
    // where grass actually belongs, got no more of it than the bare paths did.
    // This share of the budget goes into a ring around a trunk instead, which
    // both thickens the green areas and puts grass against the trees.
    window.grassTreeShare = 0.6;    // fraction of blades placed at tree bases
    // A collar hugging the trunk, not a wide apron: the point is to hide the
    // seam where the trunk meets the ground, which is what the soil patches
    // used to do.
    window.grassTreeInner = 0.25;   // ring starts this far from the trunk axis
    window.grassTreeSpread = 0.75;  // ...and extends this much further out
    // Collar tufts vary more in size than the scattered ones - a uniform ring
    // reads as a manufactured collar rather than as something growing there.
    window.grassTreeSizeMin = 0.45, window.grassTreeSizeMax = 1.75;
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
        // box get receiveShadow, instances outside it don't - see
        // window.shadowRange on dirLight for why. A small margin short of the
        // true edge because shadow sampling gets unreliable in the last few
        // units near the frustum boundary too (the PCF filter kernel reaches
        // past the edge), not just strictly outside it.
        const shadowSafe = (window._shadowCameraHalfExtent || 80) - 3;
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
        // Tree bases to cluster around, when there are any. _forestPlacements
        // is the scatter's own list, so the grass follows wherever the trees
        // actually ended up rather than re-deriving it from the noise.
        const treeSpots = (currentLevel === 'local_forest' && _forestPlacements && _forestPlacements.length)
            ? _forestPlacements : null;
        while (placed < total && attempts++ < maxAttempts) {
            let x, z;
            let collarTree = null;
            if (treeSpots && Math.random() < window.grassTreeShare) {
                const t = treeSpots[(Math.random() * treeSpots.length) | 0];
                collarTree = t;
                // A ring, not a disc: the inner radius scales with the tree so
                // blades never sprout out of the middle of a trunk, and the
                // sqrt keeps the remaining area evenly covered rather than
                // bunching everything against the inner edge.
                const inner = window.grassTreeInner * t.scale;
                const outer = inner + window.grassTreeSpread * t.scale;
                const rr = Math.sqrt(inner * inner + Math.random() * (outer * outer - inner * inner));
                const a = Math.random() * Math.PI * 2;
                x = t.x + Math.cos(a) * rr;
                z = t.z + Math.sin(a) * rr;
            } else {
                x = (Math.random() * 2 - 1) * half;
                z = (Math.random() * 2 - 1) * half;
                // With the exemption above, a uniformly placed blade can now
                // land inside a trunk. The raycast cannot catch that - the
                // collider is front-faced, so a ray straight down the middle
                // of a trunk reports only the canopy far above it - so it is
                // rejected here by distance instead.
                if (treeSpots) {
                    let inTrunk = false;
                    for (let i = 0; i < treeSpots.length; i++) {
                        const t = treeSpots[i];
                        const rr = window.grassTreeInner * t.scale;
                        if ((x - t.x) * (x - t.x) + (z - t.z) * (z - t.z) < rr * rr) { inTrunk = true; break; }
                    }
                    if (inTrunk) continue;
                }
            }
            // Nothing grows in the water. The raycast cannot rule this out on
            // its own - a lake bed and a river bed are perfectly good solid
            // ground as far as a downward ray is concerned, so tufts were
            // sprouting up through the surface. Tested against the BANK, not
            // the waterline: the torus is a wet shore that shelves into the
            // lake, and blades on its inner slope stand half-submerged.
            if (currentLevel === 'local_forest') {
                let inWater = false;
                for (let i = 0; i < _forestLakes.length; i++) {
                    const L = _forestLakes[i];
                    const rr = L.r + FOREST_LAKE_RIM_TUBE;
                    if ((x - L.x) * (x - L.x) + (z - L.z) * (z - L.z) < rr * rr) { inWater = true; break; }
                }
                // The river channel, plus its banks for the same reason.
                if (!inWater && Math.abs(x - FOREST_GAP_X) < FOREST_GAP_W * 0.5 + FOREST_GAP_CLEAR) inWater = true;
                if (inWater) continue;
            }
            _grassFrom.set(x, 60, z);
            _grassRay.set(_grassFrom, _grassDown);
            const hits = _grassRay.intersectObjects(blockers, true);
            // No ground under it at all. On a level with a shared ground plane
            // that never happens, but the forest is two islands over open
            // space - and a miss was being treated as "clear ground", so tufts
            // were being planted in mid-air off the edges and over the chasm.
            if (!hits.length && !ground.visible) continue;
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
                // Trees are exempt from this test. Their collider is ONE
                // merged mesh per tree - trunk plus canopy chunks - so its
                // Box3 always starts at the trunk base whatever part the ray
                // actually hit, and the test therefore rejected every point
                // under a canopy. Which is precisely where grass belongs, and
                // why the wooded areas had none. A trunk is thin; being under
                // its branches is not being under an overhang.
                if (!hits[0].object.userData.isTreeCollider && !hits[0].object.userData.isGroundSlab) {
                    window.getObstacleBox(hits[0].object, _grassObstacleBox);
                    if (_grassObstacleBox.min.y < maxGrassClearance) continue;
                }
            }
            const sizeLo = collarTree ? window.grassTreeSizeMin : 0.65;
            const sizeHi = collarTree ? window.grassTreeSizeMax : 1.35;
            const s = window.grassSize * (sizeLo + Math.random() * (sizeHi - sizeLo));
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
            // Collar tufts turn to face the trunk they belong to, so the ring
            // reads as one thing wrapping the base rather than as scattered
            // blades that happen to be nearby. The tuft is a CROSS of two
            // quads, so facing is a 90-degree-periodic property - a small
            // random skew stops the four cardinal directions from lining up
            // into a visible pinwheel around the trunk.
            _grassQuat.setFromAxisAngle(_upVec, collarTree
                ? Math.atan2(collarTree.x - x, collarTree.z - z) + (Math.random() - 0.5) * 0.5
                : Math.random() * Math.PI * 2);
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
                // RECEIVES shadows in both buckets. Originally 'near'-only,
                // because tufts outside the shadow camera's box sampled its
                // map past the edge and showed random dark speckling on
                // ground nothing was actually shadowing. Kept on for both now
                // that there is a single light: three.js's getShadow does its
                // own in-frustum test and simply returns "lit" outside the
                // box, so the failure mode is a missing shadow rather than a
                // wrong one. Only the boundary itself is delicate, where the
                // PCF kernel can still reach past the edge - that is what the
                // shadowSafe margin above is for.
                inst.castShadow = false;
                inst.receiveShadow = true;
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

    // ---- Scattered flowers ----
    // Real flower props (Flower.glb / Flower2.glb - each a single alpha-cut
    // textured plane, not a crossed pair like the grass tufts) sprinkled
    // much more sparingly across the same field, replacing the flowers that
    // used to be painted directly into the ground texture image (removed
    // once these took over that job). Same InstancedMesh-per-asset,
    // raycast-for-open-ground scatter technique as buildGrass() above, just
    // with real geometry/texture pulled from the loaded GLB instead of a
    // generated quad-cross.
    let flowerTemplates = [null, null];
    let pendingFlowerBuild = false;
    // Independent of grassAlphaTest (was borrowing it at first, but the
    // flower texture's alpha fade profile isn't the same as the grass
    // tufts' - grass's tuned 0.90 cutoff was clipping way too much of the
    // flower card away). Live-tunable via the Flower Alpha Cutoff slider,
    // same "dial it in by eye" reasoning as grass's own slider.
    window.flowerAlphaTest = 0.55;
    const flowerMats = [];
    function extractFlowerTemplate(gltfScene) {
        let mesh = null;
        gltfScene.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
        if (!mesh) return null;
        // Bakes the source node's own export scale (~0.097 - these were
        // authored at roughly real-world flower size in Blender) directly
        // into the geometry, so instance matrices below only have to carry
        // the random per-instance size variation, exactly like grassCrossGeo
        // is already a ready-to-scale unit shape.
        const geometry = mesh.geometry.clone();
        geometry.scale(mesh.scale.x, mesh.scale.y, mesh.scale.z);
        const srcMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const material = new THREE.MeshToonMaterial({
            map: srcMat && srcMat.map ? srcMat.map : null,
            gradientMap: threeTone,
            side: THREE.DoubleSide,
            alphaTest: window.flowerAlphaTest,
            transparent: false,
        });
        flowerMats.push(material);
        return { geometry, material };
    }
    const flowerLoader = new GLTFLoader();
    function onFlowerLoaded(idx, gltf) {
        flowerTemplates[idx] = extractFlowerTemplate(gltf.scene);
        if (flowerTemplates[0] && flowerTemplates[1] && pendingFlowerBuild) { pendingFlowerBuild = false; buildFlowers(); }
    }
    flowerLoader.load('Flower.glb', (g) => onFlowerLoaded(0, g), undefined, () => {
        flowerLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/Flower.glb',
            (g) => onFlowerLoaded(0, g), undefined, (e) => console.error('Flower.glb load failed:', e));
    });
    flowerLoader.load('Flower2.glb', (g) => onFlowerLoaded(1, g), undefined, () => {
        flowerLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/Flower2.glb',
            (g) => onFlowerLoaded(1, g), undefined, (e) => console.error('Flower2.glb load failed:', e));
    });

    const flowerMeshes = [];
    // Much lower than grassCount - "sprinkled occasionally", not a full
    // field like the grass tufts.
    window.flowerCount = 120;
    window.flowerSize = 1.0;
    function clearFlowers() {
        flowerMeshes.forEach(m => { scene.remove(m); m.dispose && m.dispose(); });
        flowerMeshes.length = 0;
    }
    const _flowerRay = new THREE.Raycaster();
    const _flowerFrom = new THREE.Vector3();
    const _flowerObstacleBox = new THREE.Box3();
    const _flowerPos = new THREE.Vector3();
    const _flowerQuat = new THREE.Quaternion();
    const _flowerScale = new THREE.Vector3();
    function buildFlowers() {
        scene.updateMatrixWorld(true);
        clearFlowers();
        // Not ready yet (async GLB load) - buildLevel()'s own grass rebuild
        // runs synchronously well before these typically finish loading, so
        // this defers to onFlowerLoaded() above to retry once both are in.
        if (!flowerTemplates[0] || !flowerTemplates[1]) { pendingFlowerBuild = true; return; }
        const toggle = document.getElementById('toggle-grass');
        if (toggle && !toggle.checked) return;
        const total = Math.max(0, Math.round(window.flowerCount));
        if (!total) return;
        const half = window.grassArea;
        const blockers = collidables.filter(c => c !== ground);
        const maxFlowerClearance = window.flowerSize * 1.3 + 0.3;
        const perTemplate = [[], []];
        let attempts = 0;
        const maxAttempts = total * 6;
        let placed = 0;
        while (placed < total && attempts++ < maxAttempts) {
            const x = (Math.random() * 2 - 1) * half;
            const z = (Math.random() * 2 - 1) * half;
            _flowerFrom.set(x, 60, z);
            _flowerRay.set(_flowerFrom, _grassDown);
            const hits = _flowerRay.intersectObjects(blockers, true);
            if (hits.length > 0) {
                window.getObstacleBox(hits[0].object, _flowerObstacleBox);
                if (_flowerObstacleBox.min.y < maxFlowerClearance) continue;
            }
            const s = window.flowerSize * (0.8 + Math.random() * 0.5);
            _flowerPos.set(x, 0, z);
            _flowerQuat.setFromAxisAngle(_upVec, Math.random() * Math.PI * 2);
            _flowerScale.set(s, s, s);
            perTemplate[placed % 2].push(new THREE.Matrix4().compose(_flowerPos, _flowerQuat, _flowerScale));
            placed++;
        }
        perTemplate.forEach((mats, i) => {
            if (!mats.length) return;
            const tmpl = flowerTemplates[i];
            const inst = new THREE.InstancedMesh(tmpl.geometry, tmpl.material, mats.length);
            mats.forEach((m, k) => inst.setMatrixAt(k, m));
            inst.instanceMatrix.needsUpdate = true;
            inst.castShadow = false;
            inst.receiveShadow = false;
            inst.raycast = () => {};
            inst.frustumCulled = false;
            inst.userData.isFlower = true;
            scene.add(inst);
            flowerMeshes.push(inst);
        });
    }
    window.rebuildFlowers = buildFlowers;

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
    let currentLevel = "local_forest";

    const network = new MultiplayerClient(scene, threeTone);
    window.multiplayerClient = network;

    // Reuses RemoteAvatar as-is (same rendering/animation, ragdoll, hit
    // reactions a real networked player gets) but drives it locally with
    // simple wander AI instead of MultiplayerClient network messages - no
    // server/connection involved, so it works offline and doesn't touch the
    // multiplayer system at all. Not created until spawnAiBot() runs (panel
    // button) so it doesn't wander into every normal test session uninvited.
    let aiBot = null;
    // AI_WANDER_SPEED doubles as the bot's ordinary walking pace - what it
    // uses while wandering AND while following something it is already close
    // to. AI_CHASE_SPEED is the far end, only reached when it has fallen
    // behind. Wander used to be 5.0, past the run threshold, so the bot
    // crossed the level at running pace playing a walk cycle and slid.
    // 9.5, against the player's own full-tilt 8.0 (see actualSpeed in the
    // movement block). It has to exceed that or a sprinting player simply
    // outruns it forever and the chase never resolves - the old 6.5 was
    // slower than the thing it was chasing. The margin is small on purpose:
    // enough to close a gap over a few seconds, not enough to be inescapable.
    // 3.2, up from 2.2 - the walk was a stroll. Deliberately kept under
    // COMP_RUN_ENTER (3.5), which is the speed the gait picker switches to the
    // run clip at: any faster and the "walking alongside" band disappears
    // entirely and they only ever run.
    const AI_WANDER_SPEED = 3.2, AI_CHASE_SPEED = 15.0;
    // Bots push each other apart rather than occupying the same spot. They all
    // chase the same victim, so without this they converge on one point and
    // walk through one another - three overlapping bodies reading as one.
    // Roughly two body radii; the push is soft (a fraction resolved per frame)
    // so it reads as jostling rather than as a collision impulse.
    const AI_BOT_SEPARATION = 1.15;
    const AI_BOT_SEPARATION_PUSH = 0.5;   // share of the overlap aimed at per second
    // Ceiling on how fast the push can actually move a bot. Without it, two
    // bots spawned on the same spot resolve the whole 1.15 in one frame - a
    // half-unit jump each, which reads as a teleport rather than as being
    // shouldered aside. Well under the walk pace, so separation always looks
    // like drift on top of a walk, never like being shoved.
    const AI_BOT_SEPARATION_MAX_SPEED = 2.0;
    // Only bots on roughly the same level shove each other. One standing on a
    // block above another is not overlapping it, and pushing them apart there
    // would drag a bot off its ledge.
    const AI_BOT_SEPARATION_DY = 1.4;
    // Two paces, not one continuous ramp from walking to sprinting. Lerping
    // all the way up from AI_WANDER_SPEED meant that at ordinary chase
    // distances the bot was doing 4-6 - already playing the run clip, but
    // moving at a jog, and slower than the player at every separation short
    // of 12. "Running" has to actually mean running.
    //
    // So: below AI_CATCHUP_NEAR it walks alongside; the moment it needs to
    // run it runs at AI_RUN_SPEED, which is the player's own full-tilt 8.0,
    // and only leans past that into AI_CHASE_SPEED once the gap is wide
    // enough that it has ground to make up.
    const AI_RUN_SPEED = 12.0;      // half again the player's own 8.0
    // Speed the run clip is authored for - the player's own top speed, since
    // it is the same Running.fbx. Used to rate-match the animation below.
    const AI_RUN_ANIM_REF = 8.0;
    // Pace the walk cycle is authored for, same idea as AI_RUN_ANIM_REF.
    const AI_WALK_ANIM_REF = 2.6;
    // The bot's OWN walk/run gait thresholds, not the companion's.
    //
    // It used to be judged by COMP_RUN_ENTER/EXIT (3.5 / 2.8), which worked
    // only while its walking pace was 2.2. Raising that pace to 3.2 put it
    // ABOVE the run-exit threshold: a bot that had been chasing and then
    // slowed to walk alongside never dropped below 2.8, so it kept playing the
    // run clip at walking speed forever. These sit either side of the step
    // change aiBotChaseSpeed actually makes - it returns either
    // AI_WANDER_SPEED (3.2) or at least AI_RUN_SPEED (12), never anything in
    // between - so there is a wide dead band and no chance of flicker.
    const AI_RUN_ENTER = 5.5, AI_RUN_EXIT = 4.5;
    // 2.5, not 5 - it keeps running until it is nearly on top of you, and
    // only walks the last stretch before the punch lands (AI_PUNCH_RANGE is
    // 1.3). Dropping to a walk five units out meant it spent the whole final
    // approach strolling, which read as losing interest right when it should
    // look most committed.
    const AI_CATCHUP_NEAR = 2.5;    // at or inside this, walking keeps up
    const AI_CATCHUP_FAR = 14.0;    // beyond this, full sprint
    // Small enough to still leave a walking band between it and punch range,
    // rather than running until the moment it swings.
    const AI_CATCHUP_HYST = 0.6;    // has to close this much inside NEAR before dropping back to a walk
    // Latched rather than a bare comparison: walk and run pace now differ by
    // a step change, so sitting exactly at AI_CATCHUP_NEAR would otherwise
    // flip the speed every frame.
    let _aiChaseRunning = false;
    function aiBotChaseSpeed(dist) {
        if (!_aiChaseRunning && dist > AI_CATCHUP_NEAR) _aiChaseRunning = true;
        else if (_aiChaseRunning && dist < AI_CATCHUP_NEAR - AI_CATCHUP_HYST) _aiChaseRunning = false;
        if (!_aiChaseRunning) return AI_WANDER_SPEED;
        const t = THREE.MathUtils.clamp((dist - AI_CATCHUP_NEAR) / (AI_CATCHUP_FAR - AI_CATCHUP_NEAR), 0, 1);
        return THREE.MathUtils.lerp(AI_RUN_SPEED, AI_CHASE_SPEED, t);
    }

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
    // FARTHEST manual-follow stand-off. Companions no longer all stand at this
    // distance - they queue between it and the player, ordered by index (see
    // _compFollowDist). All three at one radius put them shoulder to shoulder
    // in a row behind you, which read as a wall rather than as a group.
    const COMP_FOLLOW_DIST = 2.8;
    // Nearest any of them will stand. Above COMP_MIN_PLAYER_GAP (0.55), since
    // that guard freezes a companion outright and one parked permanently on
    // its own limit would never settle - but only just above it, so the lead
    // companion is genuinely at your shoulder.
    const COMP_FOLLOW_NEAR = 0.8;
    // Floor on the stand-off fallbacks below. Without it the lead companion's
    // shorter attempts (its own 0.8 scaled by 0.5 and 0.39) land at 0.4 and
    // 0.31 - inside COMP_MIN_PLAYER_GAP, which does not move it closer, it
    // freezes it. A fallback that cannot be stood on is worse than no fallback.
    const COMP_FOLLOW_MIN = 0.7;
    // This companion's own stand-off, set from its record on activate.
    let _compFollowDist = COMP_FOLLOW_DIST;
    // Stand-off distances tried in order until one lands on solid ground at
    // the player's level - see the follow-target block. 0.7 is close enough
    // to share a single 3-unit block with the player.
    // Ratios now, not absolutes - each companion tries its OWN stand-off first
    // and then closes in from there. As fixed numbers the near companions were
    // already inside the first two fallbacks, so their first "shorter" attempt
    // was actually further away than where they were trying to stand.
    const COMP_FOLLOW_FALLBACKS = [1.0, 0.72, 0.5, 0.39];
    const COMP_TRAIL_KEEP = 15.0;   // seconds of trail kept - long enough that after a
                                    // fall the companion can walk back and re-replay the
                                    // same recorded climb instead of being stuck below
    const _compTrail = [];          // {t,x,y,z,qx,qy,qz,qw,state}
    let _compTrailT = 0;
    let _compMode = 'follow';       // 'follow' | 'replay' | 'leap' | 'shimmy' | 'hang' | 'climbup'
    let _replayStartT = 0, _replayT = 0;
    // Top out nearer than this to the player and it waits on the ledge
    // instead. Tight on purpose - being merely near the ledge is handled by
    // COMP_FOLLOW_FALLBACKS taking a shorter stand-off, so this only catches
    // "the landing spot is literally occupied".
    const COMP_TOPOUT_CLEAR = 0.6;
    // Sideways offsets along the ledge tried when the top-out is occupied,
    // nearest first - the companion shuffles along the edge to a clear spot
    // and mantles up there instead of hanging until the player moves.
    const COMP_SHIMMY_STEPS = [1.0, 1.8, 2.6];
    const COMP_SHIMMY_SPEED = 1.6;  // units/sec sliding along the ledge
    const COMP_LEDGE_WALL_REACH = 1.2; // a hang spot needs wall within this, or there's nothing to hold
    let _shimmyHang = new THREE.Vector3();   // where to hang once shuffled across
    let _shimmyTop = new THREE.Vector3();    // the clear surface to mantle onto
    let _shimmyFaceQuat = new THREE.Quaternion();
    // HANG mode: committed to holding a ledge. Captured once when the replay
    // finds its top-out occupied, then owned by that mode - the point being
    // that the decision is made ONCE. Re-deciding every frame inside the
    // replay (advance, notice it's blocked, rewind, snap back down) is what
    // made it lunge at the ledge and throw itself back repeatedly.
    let _hangPos = new THREE.Vector3();
    let _hangQuat = new THREE.Quaternion();
    let _hangTop = new THREE.Vector3();   // the surface it wants to end up on
    let _hangFwd = new THREE.Vector3();   // horizontal, hang position -> over the edge
    // Both taken from the player's own ledge grab rather than guessed, so an
    // AI hang sits exactly where yours does. See the grab site: the root goes
    // to (wallHit + normal*ledgeOffset) at (lipY - 1.85).
    //
    // The guessed values were 0.35 out and 1.5 down - nearly six times too far
    // from the wall and a third of a metre too high. That is the hang looking
    // wrong: floating off the face, hooked at chest height instead of hanging
    // from the hands. It was never really a matter of failing to FIND the
    // ledge; it found it and then held it in the wrong place.
    const COMP_HANG_OUT = 0.06;             // matches ledgeOffset
    const COMP_HANG_DROP = 1.85;            // matches the player's hangGroupY drop
    const _ledgeFwdVec = new THREE.Vector3();
    const _ledgeSpotTop = new THREE.Vector3();
    // How far apart two grips have to be. Roughly two body radii (0.45 each),
    // so shoulders clear; the first shimmy step is 1.0, which is enough to
    // resolve a clash in one move.
    //
    // This constant was USED by nudgeHangClearOfPlayer and never declared -
    // an undeclared identifier in a module is a ReferenceError, so that
    // function threw every single time it ran and the exception propagated
    // out through updateCompanion. Which is why companions have been grabbing
    // on wherever they liked: the code meant to stop it never completed.
    const COMP_LEDGE_MIN_SEP = 0.9;
    // Only bodies within this much height of each other count as sharing a
    // grip. A hang is 1.85 below its lip, so anything looser would have a
    // companion on the ledge above competing with one on the ledge below.
    const COMP_LEDGE_SEP_DY = 1.2;
    // How long a companion stands off after finding the ledge occupied.
    //
    // Refusing the grab on its own is not enough: the refusal is re-derived
    // every frame from the same geometry, so it just re-probes the same wall
    // sixty times a second and presses against it. This makes the refusal
    // STICK for long enough that the one already on the ledge can top out -
    // a climb-up clip plus the post-climb hold is a little over a second - and
    // turns "both scrambling at the same grip" into a queue.
    const COMP_LEDGE_WAIT = 1.1;
    // Jitter on that wait. Two companions blocked by the same climber would
    // otherwise come off cooldown on the same frame, re-probe together, and
    // block each other again - the retry has to be desynchronised or the queue
    // is just a slower deadlock.
    const COMP_LEDGE_WAIT_JITTER = 0.5;
    let _compLedgeWaitT = 0;
    // CLIMBUP: the same shape as the player's own climb-up (see isClimbingUp
    // in the movement block) - hold the root still, play the climb clip, then
    // place the root on the ledge at the end. The generic mantle arc was
    // standing in for this, which is why coming up off a ledge didn't look
    // like the player's version of the same move.
    let _climbFrom = new THREE.Vector3();
    let _climbTo = new THREE.Vector3();
    let _climbQuat = new THREE.Quaternion();
    let _climbT = 0, _climbDur = 1.0;
    const COMP_CLIMB_STAND_IN = 0.25;       // matches the player's own ledgeTarget + fwd*0.25
    const _compFaceEuler = new THREE.Euler();
    let _compFaceQuat = new THREE.Quaternion();
    const _compBehindDir = new THREE.Vector3();
    const _compGroundOrigin = new THREE.Vector3();
    const _compGroundList = [];
    const _compVisPos = new THREE.Vector3();   // player's VISUAL (fbxModel) world pos
    // Ledge/gap leap - the companion's ordinary follow movement is a plain
    // walk plus a vertical glide toward whatever ground is straight below
    // it (see the FOLLOW section's dy handling), which only works for
    // ramps/steps where solid footing is close by directly underneath.
    // Approaching a genuine drop-off it just walked off the edge and glided
    // straight down at whatever xz it happened to be at when the ground
    // vanished from under it - fine for a short drop onto ground still
    // beneath it, but never actually covers a horizontal gap, so it either
    // fell short of the far side or froze at the edge waiting for ground
    // that was never going to appear directly below. See the edge-detect
    // block in FOLLOW for how a leap gets triggered.
    let _compLeapStart = new THREE.Vector3();
    let _compLeapEnd = new THREE.Vector3();
    let _compLeapFaceQuat = new THREE.Quaternion();
    let _compLeapT = 0, _compLeapDur = 0.35;
    const COMP_LEAP_EDGE_FWD = 0.6;     // how far ahead to probe for "is there ground where I'm about to step"
    const COMP_LEAP_EDGE_DROP = 1.3;    // bigger than this counts as an edge, not a step/ramp (those keep gliding)
    const COMP_LEAP_MAX_DIST = 6.0;     // furthest the landing scan looks for solid footing
    const COMP_LEAP_LANDING_BAND = 3.0; // how far BELOW launch height a landing may be
    // How far ABOVE launch height a landing may be. Deliberately just under
    // the player's own jump apex: their jump is v0=10 against gravity 30
    // (see the jump code), so v0^2/2g = 1.67 units. The companion must never
    // out-jump the player - it is the same world. Anything higher than this
    // is reachable only by climbing, and the climb paths own it.
    const COMP_LEAP_RISE_MAX = 1.6;
    const COMP_LEAP_SPEED = 6.0;        // horizontal m/s while airborne - sets the leap's duration
    const COMP_LEAP_ARC_HEIGHT = 1.4;   // visual arc peak above the straight launch->landing line
    // Climb-up: the same leap, aimed at the TOP of a rise too tall to step
    // onto, rather than across a gap. This is what lets the companion get
    // itself out of somewhere the player has never been - the breadcrumb
    // replay can only climb walls the player already climbed (it needs a
    // recorded crumb at the companion's own height), so a fall into an
    // unvisited spot leaves it with no recorded route at all and only its
    // own ability to haul itself up.
    // 3.4, not 3.0: a single level block IS exactly cubeSize (3.0) tall, so
    // a flush "one block up" measures right at the limit and floating point
    // decides whether it counts - the most common climb in the game must
    // not be the marginal case.
    const COMP_CLIMB_MAX = 3.4;         // tallest rise it can pull itself onto
    const COMP_CLIMB_INSET = 0.7;       // how far past the lip to land, so it ends up ON the surface not at its edge
    const COMP_CLIMB_INSET_TIGHT = 0.3; // ...but only this far when the next step starts immediately (stairs)
    const COMP_STEP_UP = 0.9;           // tallest rise it just walks up, no climb needed
    // How far above the companion the player must be before climbing an
    // obstacle is worth it at all. Matches the steering gate, so exactly one
    // of "go around" and "go over" applies at any height difference.
    const COMP_CLIMB_WORTH_IT = 1.0;
    // How far ahead to look for "the wall is right here, just climb it". A
    // bit past the body so it registers while still walking up to the face,
    // not only once pressed against it.
    const COMP_CLIMB_REACH_PROBE = 0.8;
    // Beyond this the recorded takeoff is far enough that climbing something
    // nearer is worth trying first.
    const COMP_TAKEOFF_PREFER_DIST = 6.0;
    // ---- Companion stuck detection ----
    // Every individual stall has had its own cause and its own fix, and there
    // keep being more. The follow logic is a stack of interacting rules
    // (takeoff route, steering, climb, leap, the refuse-the-move guard) and
    // there is no way to be confident some combination cannot deadlock. So:
    // measure the one thing that is unambiguous - whether it is actually
    // moving - and break the deadlock when it is not.
    //
    // The escape is a short sidestep, not a teleport. Deadlocks here are
    // symmetric (pressed at a wall, or steering flip-flopping between two
    // equally blocked sides), and moving perpendicular for a moment breaks
    // the symmetry so the normal rules find a different answer next frame.
    let _compStuckAt = new THREE.Vector3();
    let _compUnstickDir = new THREE.Vector3();
    let _compStuckT = 0, _compUnstickT = 0;
    const COMP_STUCK_TIME = 1.2;    // no progress for this long = deadlocked
    const COMP_STUCK_DIST = 0.25;   // moved less than this in that time = no progress
    const COMP_UNSTICK_TIME = 0.5;  // how long to sidestep before resuming normal follow
    // Set at each decision point so the debug readout can say WHY it is doing
    // nothing - "decided to hold" and "every branch declined" look identical
    // from outside, and they need opposite fixes.
    let _compWhy = 'init';
    // Above this travel speed the companion faces where it is going; below it
    // (i.e. standing about) it turns to face the player. Matches the walk
    // threshold, so it turns to you exactly when it stops walking.
    const COMP_FACE_TRAVEL_MIN = 0.4;
    // Close enough to the follow spot to just stand there. Generous on
    // purpose - the spot itself moves constantly, so a tight radius means
    // never actually arriving.
    const COMP_ARRIVE_DEADZONE = 0.7;
    // How long the companion stands and collects itself after a hit before it
    // is willing to go anywhere again.
    let _compRecoverT = 0;
    const COMP_RECOVER_SETTLE = 0.8;
    // Grace period straight after topping out, during which the companion
    // will not step back off the ledge it just climbed. Without it the follow
    // spot - which sits BEHIND the player, and so hangs out over the edge
    // whenever they stand near one - pulled it straight back off, and it
    // climbed again, and again. That is the almost-gets-up-then-gives-up
    // loop: each attempt genuinely succeeded, and was immediately undone.
    let _compJustClimbedT = 0;
    const COMP_POST_CLIMB_HOLD = 1.2;
    // Closest the companion may stand to the player on the level. Roughly two
    // body widths - enough that they never occupy the same spot.
    const COMP_MIN_PLAYER_GAP = 0.55;
    // Timestamp of the takeoff crumb currently being headed for, -1 for none.
    // Latched so a knock-back does not silently re-pick a different one.
    let _compTakeoffT = -1;
    // Set when a punch lands: wherever the blow leaves the companion, it stays
    // there as long as that is still a reasonable place to be, instead of
    // immediately trudging back to its exact follow spot. Walking back the
    // moment it stops reeling makes the hit look like it did not matter, and
    // the follow spot was never a place it needed to be to the centimetre.
    // Cleared once the player has moved far enough that following again is
    // the point.
    let _compHitSettled = false;
    const COMP_HIT_OK_DIST = 3.2;
    // Post-climb model offset: cancels the root placement's jump, then decays
    // so the model settles back onto its root. See the CLIMBUP completion.
    let _climbModelRest = new THREE.Vector3();
    const _climbMoveDiff = new THREE.Vector3();
    const _climbTmpQuat = new THREE.Quaternion();
    let _climbBlendT = 0;
    const COMP_CLIMB_BLEND = 0.3;
    let _compLeapToHang = false;        // this leap ends by catching a ledge, not by landing on ground
    // Locomotion clip picker state - low-pass filtered speed plus hysteresis
    // between the run/walk/idle thresholds. Feeding the raw per-frame speed
    // straight into a single threshold made the clip flicker between
    // idle/walk/run every frame whenever the companion's actual speed
    // happened to sit right at 0.4 or 3.5 (very common: it's usually
    // accelerating into or decelerating out of its follow spot, not moving
    // at a constant speed) - see companionLocoState.
    let _compSpeedSmooth = 0;
    let _compLocoState = 'idle';
    // ---- Companion retaliation ----
    // Companions do not pick fights - they hit back. Being punched arms a
    // counter-attack (see COMP_RETALIATE_CHANCE), and once the stagger and
    // settle are over they turn on whichever bot is nearest and throw a short
    // combo at it. Reactive rather than aggressive keeps them reading as
    // companions rather than as a second set of enemies, and it means the
    // fight only starts when a bot has already committed to one.
    let _compPunchT = -1;        // <0 = not swinging
    let _compPunchIndex = 0;     // next swing whose hit frame has yet to fire
    let _compPunchTarget = null;
    let _compRetaliate = false;
    const COMP_PUNCH_SWING = 0.42;    // seconds per swing in the combo
    const COMP_PUNCH_RANGE = 1.9;     // has to be this close when the fist lands
    const COMP_PUNCH_SEEK = 4.5;      // how far it will look for who to hit back at
    // Per hit. Chips the bot's 100-point poise pool by the standard 'medium'
    // damage, so a 2-hit combo is a real contribution without a companion
    // being able to floor a bot on its own.
    const COMP_PUNCH_FORCE = 16;
    // What a whole counter-attack is worth against a bot's 100-point poise
    // pool, however many hits it is split into.
    const COMP_PUNCH_TOTAL_POISE = 30;
    let _compFullCombo = false;
    let _compCharge = false;
    let _compAttackCD = 0;
    // Proactive engage: a bot this close gets attacked without waiting to be
    // hit first. Shorter than COMP_PUNCH_SEEK (which is how far it will look
    // for whoever just hit it) - answering a punch is worth crossing a bit of
    // ground for, starting one is not.
    const COMP_ATTACK_SEEK = 3.0;
    const COMP_ATTACK_COOLDOWN = 1.8;
    // Charge attack (the dark blue one). Deliberately under the hold clip's
    // own length - see the swingAnim comment for why that matters.
    const COMP_CHARGE_HOLD = 0.75;
    const COMP_CHARGE_SWING = 0.5;
    const COMP_CHARGE_HIT_T = 0.28;   // the player's own chargePunchHitTime
    const COMP_CHARGE_FORCE = 60;     // matches window.chargePunchKnockback
    const COMP_CHARGE_COOLDOWN = 4.5; // one knockdown at a time, not a loop
    window.companionEnabled = true;   // on by default - toggle stays available from the panel ('Companion' → Add Companion)
    // Wide enough that the bot actually follows rather than losing interest
    // the moment you walk away - 8/11 meant it gave up almost immediately and
    // went back to wandering. Still bounded, so it does return to wandering
    // if you get properly far from it.
    const AI_CHASE_RADIUS = 35, AI_CHASE_GIVEUP_RADIUS = 45, AI_PUNCH_RANGE = 1.3;
    const AI_PUNCH_DURATION = 0.7, AI_PUNCH_HIT_TIME = 0.35, AI_PUNCH_COOLDOWN = 0.8, AI_PUNCH_FORCE = 22;
    // Combo attack (the orange enemy). Same Punch_Combo.fbx and the same five
    // normalized hit times the player's own combo uses, so it reads as the
    // same move rather than a bot-only approximation - RemoteAvatar already
    // fires swing particles on these exact frames for the clip, and this is
    // what makes the damage land on them too.
    const AI_COMBO_HIT_TIMES = [0.15, 0.32, 0.48, 0.65, 0.82];
    // Per-hit force well under AI_PUNCH_FORCE: five of these in a row against
    // a 100-point stagger pool has to add up to roughly one heavy punch's
    // worth of pressure, not five of them, or the combo alone ragdolls you
    // every time it connects. The last hit is the one with weight behind it.
    const AI_COMBO_FORCE = 9, AI_COMBO_FINISH_FORCE = 20;
    // Longer than AI_PUNCH_COOLDOWN - a combo is a committed attack, and the
    // recovery after it is the window you get to hit back in.
    const AI_COMBO_COOLDOWN = 1.6;
    // Charge attack (the red enemy). Winds up visibly first, then throws one
    // heavy punch - the same two-clip shape the player's own charge uses
    // (punch_charge_hold -> punch_charge_punch).
    //
    // The hold is the whole point of the move. It lands at 'high' intensity,
    // which ragdolls outright rather than staggering, so it has to be
    // telegraphed long enough to run from or interrupt - an untelegraphed
    // knockdown is just an unavoidable one.
    const AI_CHARGE_HOLD = 1.1;
    // Fraction into the swing clip where the fist connects - the player's own
    // number, so both charge punches land on the same frame of the same clip.
    const AI_CHARGE_HIT_T = 0.28;
    // Matches window.chargePunchKnockback (60), the force an orange-intensity
    // hit throws its target with. Deliberately not chargePunchForce (80):
    // that is the number used to CLASSIFY the hit as 'high', and feeding it
    // to a limp ragdoll flings it across the level - the knockback constant is
    // the one tuned for the impulse itself.
    const AI_CHARGE_FORCE = 60;
    // It gets one heavy hit; the recovery is correspondingly long.
    const AI_CHARGE_COOLDOWN = 2.2;
    // Slightly further out than a jab - a wound-up swing has reach.
    const AI_CHARGE_RANGE = 1.8;
    // Tallest rise the bot's ordinary walk snaps up (a stair step, not a
    // climb). Module scope because the climb code needs the same number to
    // know where walking stops and climbing starts - it used to be a local
    // inside moveAiBotToward's ground-snap block.
    const AI_MAX_STEP_UP = 0.4;
    // NOT a const, and neither are the _ai* registers further down: there is
    // more than one bot now, and rather than thread a bot handle through the
    // ~1200 lines of tuned chase/climb logic below (every line of which was
    // arrived at by a lot of trial and error, and none of which wants
    // rewriting), each bot owns its own copy of this state and
    // activateAiBot() re-points these bindings at whichever one is being
    // updated. See the registry near spawnAiBot.
    let aiBotState = {
        mode: 'wander', // 'wander' | 'chase' | 'punch' | 'cooldown'
        target: new THREE.Vector3(char.group.position.x + 4, char.group.position.y, char.group.position.z + 4),
        waitTimer: 0,
        punchTimer: 0,
        punchHasHit: false,
        cooldownTimer: 0,
        // Combo swings alternate hands and land several hits per attack -
        // see AI_COMBO_HITS. Only bots flagged `combo` use these.
        comboIndex: 0,
        comboHand: 'punch_left',
        // Locked in when a swing starts (char or companion) so the bot can't
        // switch targets mid-punch and pivot to face someone else.
        victim: null,
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

    // Locomotion clip from how fast the bot is actually travelling, using the
    // same thresholds the companion picks by, so the two agents change gait
    // at the same speeds.
    //
    // Hysteresis (enter high, exit low) matters now that chase pace ramps
    // continuously with distance: the bot can sit at exactly the separation
    // where its speed equals the run threshold, and a single comparison would
    // flip the clip every frame there. Same fix, same reason, as
    // companionLocoState's.
    let _aiLocoState = 'idle';
    function aiBotLocoState(speed) {
        if (_aiLocoState === 'run') {
            if (speed < AI_RUN_EXIT) _aiLocoState = speed > COMP_WALK_EXIT ? 'walk' : 'idle';
        } else if (_aiLocoState === 'walk') {
            if (speed > AI_RUN_ENTER) _aiLocoState = 'run';
            else if (speed < COMP_WALK_EXIT) _aiLocoState = 'idle';
        } else {
            if (speed > AI_RUN_ENTER) _aiLocoState = 'run';
            else if (speed > COMP_WALK_ENTER) _aiLocoState = 'walk';
        }
        // Rate-match the clip to the ground speed. A cycle is authored for one
        // pace and plays at it no matter how fast the bot is actually
        // travelling - so at 12-15 units/s the run's feet skate badly, which
        // is exactly what "moving faster" would otherwise look like, and the
        // walk has the same problem now that walking pace is 3.2 rather than
        // the 2.2 it used to be. Scaling playback keeps the stride matched to
        // the distance covered. Clamped so a near-stationary frame cannot
        // freeze a clip or a burst send it into a blur.
        const runAction = aiBot.actions && aiBot.actions['run'];
        if (runAction) {
            runAction.timeScale = _aiLocoState === 'run'
                ? THREE.MathUtils.clamp(speed / AI_RUN_ANIM_REF, 0.75, 2.2)
                : 1;
        }
        const walkAction = aiBot.actions && aiBot.actions['walk'];
        if (walkAction) {
            walkAction.timeScale = _aiLocoState === 'walk'
                ? THREE.MathUtils.clamp(speed / AI_WALK_ANIM_REF, 0.8, 1.5)
                : 1;
        }
        return _aiLocoState;
    }

    // Pushes a bot's intended next XZ out of any other bot it would be
    // standing inside. Writes into `out` (x/z only - the caller does its own
    // ground snap AFTER this, so the height still comes from the surface the
    // bot actually ends up over rather than the one it was heading for).
    //
    // Applied to the step target rather than to the finished position for that
    // reason: shoving a bot sideways after it has been snapped to the ground
    // moves it over a different surface without updating its height, which is
    // exactly how a bot ends up buried in a block.
    const _aiSepOut = new THREE.Vector2();
    function aiBotSeparate(x, z, y, delta, out) {
        out.set(x, z);
        const maxPush = AI_BOT_SEPARATION_MAX_SPEED * delta;
        for (let i = 0; i < aiBots.length; i++) {
            const other = aiBots[i].bot;
            if (other === aiBot || !other.isLoaded) continue;
            const op = other.group.position;
            if (Math.abs(op.y - y) > AI_BOT_SEPARATION_DY) continue;
            let dx = out.x - op.x, dz = out.y - op.z;
            let d = Math.hypot(dx, dz);
            if (d >= AI_BOT_SEPARATION) continue;
            // Exactly coincident (a shared spawn point, or both snapped to the
            // same wander target): no direction to separate along, so pick one
            // off their ids instead of leaving them welded together.
            if (d < 1e-4) {
                const a = (i + 1) * 2.399963;   // golden angle, so ids fan out
                dx = Math.cos(a); dz = Math.sin(a); d = 1;
            }
            const push = Math.min((AI_BOT_SEPARATION - d) * AI_BOT_SEPARATION_PUSH, maxPush) / d;
            out.x += dx * push;
            out.y += dz * push;
        }
    }

    // Straight at the target, no obstacle steering, same ground snap.
    //
    // Exists because the steering in moveAiBotToward is actively wrong when
    // the target is ABOVE: the thing "in the way" is the very block the bot
    // needs to climb, so avoiding it means orbiting the base forever and
    // never presenting the head-on approach tryAiBotClimb probes for. That
    // orbit is the bot getting stuck. The companion never had the problem
    // because its own steering is gated off at exactly this height
    // difference - this is the bot's version of that gate.
    function moveAiBotDirect(destTarget, speed, delta) {
        const pos = aiBot.group.position;
        let dx = destTarget.x - pos.x, dz = destTarget.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.001) return dist;
        dx /= dist; dz /= dist;
        const step = Math.min(dist, speed * delta);
        let nx = pos.x + dx * step, nz = pos.z + dz * step;
        aiBotSeparate(nx, nz, pos.y, delta, _aiSepOut);
        nx = _aiSepOut.x; nz = _aiSepOut.y;
        let ny = pos.y;
        let blocked = false;
        rayDown.set(_tempVec1.set(nx, pos.y + 2.0, nz), _downVec);
        const groundHits = rayDown.intersectObjects(collidables);
        if (groundHits.length > 0) {
            const newY = groundHits[0].point.y;
            // Too tall to step: refuse the HORIZONTAL move as well, don't just
            // decline the height change. Keeping xz while leaving y behind is
            // what buries the bot in a box - its feet stay below the block's
            // top while its position is already over that block's footprint.
            // Height and position have to stay consistent with each other.
            if (newY - pos.y <= AI_MAX_STEP_UP) ny = newY;
            else { nx = pos.x; nz = pos.z; blocked = true; }
        }
        _tempVec3.set(dx, 0, dz);
        const facingQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _tempVec3);
        // Actual step, not the requested speed - arriving at the target the
        // step shrinks, and the gait should settle with it.
        aiBot.setNetworkState([nx, ny, nz], [facingQuat.x, facingQuat.y, facingQuat.z, facingQuat.w],
            aiBotLocoState(blocked ? 0 : step / Math.max(delta, 1e-3)), false);
        // -1 means "walked into something and could not pass". The caller has
        // to have somewhere else to go: this function has no steering of its
        // own, so on its own it would just press against the wall forever.
        return blocked ? -1 : dist;
    }

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
        aiBotSeparate(nextPos.x, nextPos.z, pos.y, delta, _aiSepOut);
        nextPos.x = _aiSepOut.x; nextPos.z = _aiSepOut.y;
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
            //
            // Refusing the height change alone is not enough though: the
            // horizontal move has to be refused with it, or the bot ends up
            // standing over the block's footprint with its feet still at the
            // old height - buried inside the box. Position and height must
            // agree.
            const newY = groundHits[0].point.y;
            if (newY - pos.y <= AI_MAX_STEP_UP) nextPos.y = newY;
            else { nextPos.x = pos.x; nextPos.z = pos.z; }
        }

        aiBot.setNetworkState([nextPos.x, nextPos.y, nextPos.z], [facingQuat.x, facingQuat.y, facingQuat.z, facingQuat.w],
            aiBotLocoState(speed), false);
        return dist;
    }
    // ---- AI bot climbing ----
    // Same two-move vocabulary the companion uses - jump and catch the ledge,
    // then pull up - so the bot getting onto a block reads the same as anyone
    // else doing it. Kept as its own small state block rather than sharing
    // the companion's: that machinery is written against the single
    // `companion` object and a dozen `_comp*`/`_hang*` module variables, and
    // making it serve two agents means threading all of it through a state
    // parameter. Not worth it for the subset the bot actually needs (it never
    // hangs around waiting, shimmies, or replays a route).
    // Last-resort unstick. Every individual "it got stuck" has had its own
    // specific cause and its own fix, but the chase is a pile of interacting
    // rules (steering, climb, leap, the refuse-the-move guard) and there is
    // no way to be sure some combination of them cannot deadlock. If the bot
    // has genuinely not moved for a while, stop trusting the current plan and
    // go wander - wandering picks a fresh direction, which breaks whatever
    // the configuration was.
    let _aiStuckAt = new THREE.Vector3();
    let _aiStuckT = 0;
    const AI_STUCK_TIME = 1.5;      // seconds of no progress before giving up on the route
    const AI_STUCK_DIST = 0.35;     // moved less than this in that time = not moving
    // Matches the companion's COMP_RECOVER_SETTLE - both take the same beat
    // after a hit before they are willing to move again.
    let _aiRecoverT = 0;
    const AI_RECOVER_SETTLE = 0.8;
    // Sidestep used to break a wedge - see the watchdog.
    let _aiUnstickDir = new THREE.Vector3();
    let _aiUnstickT = 0;
    const AI_UNSTICK_TIME = 0.5;
    let _aiClimbFrom = new THREE.Vector3();
    let _aiClimbHang = new THREE.Vector3();
    let _aiClimbTop = new THREE.Vector3();
    let _aiClimbQuat = new THREE.Quaternion();
    // Post-climb model offset, mirroring the companion's - cancels the root
    // placement's jump, then decays so the model settles back onto its root.
    let _aiClimbModelRest = new THREE.Vector3();
    const _aiClimbMoveDiff = new THREE.Vector3();
    const _aiClimbTmpQuat = new THREE.Quaternion();
    let _aiClimbBlendT = 0;
    const _aiHangFwd = new THREE.Vector3();
    const _aiHangNormal = new THREE.Vector3();
    // Why the last climb attempt did or did not happen. Set at every exit of
    // tryAiBotClimb and shown by the debug readout - "it cannot climb here" is
    // the same picture for half a dozen different refusals, and they need
    // different fixes.
    let _aiClimbWhy = 'none', _aiClimbRise = 0;
    let _aiClimbPhase = 'none';   // 'none' | 'jump' | 'pull' | 'leap'
    let _aiClimbT = 0, _aiClimbDur = 0;
    const AI_CLIMB_PROBE = 0.8;   // how far ahead to look for the wall
    const AI_CLIMB_INSET = 0.7;   // land this far past the lip, not balanced on it

    function aiBotSurfaceY(x, z, fromTopY) {
        _tempVec1.set(x, fromTopY, z);
        rayDown.set(_tempVec1, _downVec);
        const hits = rayDown.intersectObjects(collidables, true);
        return hits.length ? hits[0].point.y : -Infinity;
    }


    // Starts a climb if something climbable is directly between the bot and
    // where it is trying to get to. Returns true if one began.
    // maxRise caps how tall an obstacle this will take on. Callers pass the
    // hop height when the target is only level with the bot - climbing a full
    // block just because it is in the way is the "tries to get on top of the
    // stacked cubes" behaviour, and going around is right there.
    function tryAiBotClimb(pos, destPos, maxRise = COMP_CLIMB_MAX) {
        if (_aiClimbPhase !== 'none') { _aiClimbWhy = 'busy:' + _aiClimbPhase; return false; }
        // Where the model normally sits on its root - captured before any
        // offset is applied, so the decay has something true to return to.
        if (aiBot.fbxModel && _aiClimbBlendT <= 0) _aiClimbModelRest.copy(aiBot.fbxModel.position);
        let dx = destPos.x - pos.x, dz = destPos.z - pos.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 1e-4) return false;
        dx /= dl; dz /= dl;
        const px = pos.x + dx * AI_CLIMB_PROBE, pz = pos.z + dz * AI_CLIMB_PROBE;
        // Cast from above the tallest thing it could possibly climb, so a
        // block taller than that is seen as too tall rather than missed
        // entirely and mistaken for the lower surface behind it.
        const topY = aiBotSurfaceY(px, pz, pos.y + COMP_CLIMB_MAX + 1.0);
        const rise = topY - pos.y;
        _aiClimbRise = rise;
        if (rise <= AI_MAX_STEP_UP) { _aiClimbWhy = 'no wall (rise ' + rise.toFixed(2) + ')'; return false; }
        if (rise > maxRise) { _aiClimbWhy = 'too tall ' + rise.toFixed(2) + ' > ' + maxRise.toFixed(2); return false; }
        // Landing spot past the lip, and it must be the same surface - one
        // hop, not the first step of a staircase.
        let lx = px + dx * AI_CLIMB_INSET, lz = pz + dz * AI_CLIMB_INSET;
        let landY = aiBotSurfaceY(lx, lz, topY + 1.0);
        // Next step starting immediately past the lip = stairs. Land shorter
        // rather than refusing to climb at all - see the same case in
        // tryCompanionClimbUp.
        if (landY > topY + 0.6) {
            lx = px + dx * COMP_CLIMB_INSET_TIGHT; lz = pz + dz * COMP_CLIMB_INSET_TIGHT;
            landY = aiBotSurfaceY(lx, lz, topY + 1.0);
        }
        // Only a surface that DROPS away is unusable - see the same case in
        // tryCompanionClimbUp. A rising one is a ramp or stairs.
        if (landY < topY - 0.6) {
            _aiClimbWhy = 'ledge too narrow (top ' + topY.toFixed(2) + ' vs ' + landY.toFixed(2) + ')';
            return false;
        }
        if (landY - pos.y > maxRise) {
            _aiClimbWhy = 'landing too high ' + (landY - pos.y).toFixed(2);
            return false;
        }
        _aiClimbTop.set(lx, landY, lz);
        _aiClimbFrom.copy(pos);
        _compFaceEuler.set(0, Math.atan2(dx, dz), 0);
        _aiClimbQuat.setFromEuler(_compFaceEuler);
        // Low enough to hop straight onto - see the matching case in
        // tryCompanionClimbUp. The hang sits COMP_HANG_DROP below the lip, so
        // for a short rise it lands below the bot's own feet and the whole
        // hang-then-pull sequence is nonsense for a step it can just jump.
        if (rise <= COMP_LEAP_RISE_MAX) {
            _aiClimbPhase = 'leap';
            _aiClimbT = 0;
            _aiClimbDur = Math.max(0.35, _aiClimbFrom.distanceTo(_aiClimbTop) / COMP_LEAP_SPEED);
            _aiClimbWhy = 'hop ' + rise.toFixed(2);
            return true;
        }
        // Hang below the lip, then check the jump can even reach it - the
        // bot may not out-jump the player any more than the companion may.
        aiBotLedgeHang(px, pz, topY, dx, dz, _aiClimbHang);
        // Face the wall, not the walk-in direction - matches the player's grab.
        const wallN = aiBotSquareHang(dx, dz, _aiClimbHang);
        if (wallN) {
            _compFaceEuler.set(0, Math.atan2(-wallN.x, -wallN.z), 0);
            _aiClimbQuat.setFromEuler(_compFaceEuler);
        }
        if (_aiClimbHang.y - pos.y > COMP_LEAP_RISE_MAX) {
            _aiClimbWhy = 'grip too high (' + (_aiClimbHang.y - pos.y).toFixed(2) + ' > ' + COMP_LEAP_RISE_MAX + ')';
            return false;
        }
        _aiClimbPhase = 'jump';
        _aiClimbT = 0;
        _aiClimbDur = Math.max(0.35, _aiClimbFrom.distanceTo(_aiClimbHang) / COMP_LEAP_SPEED);
        _aiClimbWhy = 'grab+pull ' + rise.toFixed(2);
        return true;
    }

    // Where the player left `pos`'s own level, and which way they went up
    // from there. Chasing their CURRENT position is useless once they are
    // overhead: the straight line to them runs into the block face, so the
    // follower ends up pressed against a wall it may not even be able to
    // climb, metres away from the spot they actually got up by. The takeoff
    // point is a place that CAN be stood on, and the crumb after it says
    // which way the climb goes.
    //
    // Shared by the bot and the companion - both have the same problem and
    // the trail is the same answer for both.
    const _aiApproach = new THREE.Vector3();
    function findTakeoffApproach(pos, trail = _compTrail) {
        // Walks BACK from the newest crumb to the moment the player left this
        // level - the last crumb still at our height, with higher crumbs after
        // it. That is the spot they actually went up from.
        //
        // Not "nearest crumb at my height", which is what this did before:
        // that returns any point on their ground path, quite possibly one they
        // merely walked across on the way somewhere else, with no way up at
        // all. The follower would trek to it and find nothing.
        //
        // `up` ends up holding the EARLIEST high crumb seen while walking back
        // (each assignment overwrites the later one), so it is the first place
        // they got to off the ground - which is the direction the climb goes.
        let up = null;
        for (let i = trail.length - 1; i >= 0; i--) {
            const cr = trail[i];
            if (cr.y > pos.y + 1.0) { up = cr; continue; }
            if (up && Math.abs(cr.y - pos.y) <= 0.9) return { at: cr, up };
        }
        return null;
    }

    // The companion leaves its own trail, so the bot can follow IT up as well
    // as the player. Only the player was recorded before, which meant a bot
    // chasing the companion had no route to work from the moment the chase
    // went vertical - the companion would climb away and the bot would stand
    // at the bottom with nothing recorded to retrace. Since the companion is
    // itself good at finding a way up, its path is exactly the right thing to
    // copy.
    //
    // Deliberately a separate list rather than merging into one: the two
    // wander off in different directions, and a single interleaved trail
    // would have the bot cutting between whichever crumbs happened to be
    // adjacent in time.
    let _companionTrail = [];
    let _companionTrailT = 0;
    function recordCompanionTrail(delta) {
        if (!companion || !companion.isLoaded || !companion.group.visible) return;
        const c = companion.group.position;
        const q = companion.group.quaternion;
        _companionTrailT += delta;
        const last = _companionTrail.length ? _companionTrail[_companionTrail.length - 1] : null;
        if (last && Math.hypot(c.x - last.x, c.y - last.y, c.z - last.z) > 5) _companionTrail.length = 0; // teleport → reset
        _companionTrail.push({ t: _companionTrailT, x: c.x, y: c.y, z: c.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, state: 'walk' });
        while (_companionTrail.length > 2 && (_companionTrailT - _companionTrail[0].t) > COMP_TRAIL_KEEP) _companionTrail.shift();
    }

    // Where to hang in order to climb onto (topX, topZ) at height topY.
    // Walks BACK from the top point until the surface falls away - that is
    // the lip - and sits just outside it. The bot's own version of the
    // companion's computeLedgeHang.
    //
    // The hang used to be placed a fixed distance back from the PROBE point,
    // which has nothing to do with where the wall is: the probe is simply
    // AI_CLIMB_PROBE ahead of the bot, so the hang always landed about 0.45
    // ahead of wherever it happened to be standing - buried in the wall if it
    // had walked right up to it, hanging off nothing if it had stopped short.
    // That is the grabbing-on-in-odd-places. The lip is a property of the
    // geometry and has to be measured, not assumed.
    function aiBotLedgeHang(topX, topZ, topY, dirX, dirZ, out) {
        let lo = 0, hi = 1.2;   // lo: known on the surface, hi: assumed past the edge
        for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) * 0.5;
            const sy = aiBotSurfaceY(topX - dirX * mid, topZ - dirZ * mid, topY + 1.0);
            if (Math.abs(sy - topY) <= 0.4) lo = mid; else hi = mid;
        }
        out.set(topX - dirX * (hi + COMP_HANG_OUT), topY - COMP_HANG_DROP, topZ - dirZ * (hi + COMP_HANG_OUT));
    }

    // Squares an already-computed hang against the wall it is holding, using
    // that wall's own normal, and returns the facing direction to use.
    // Returns null if there is no wall in reach, leaving `out` untouched.
    //
    // The player's grab does exactly this - lookAt(position - n) off the wall
    // normal - so taking the facing from the direction the bot happened to
    // walk in only matches when it approached dead-on. Any angled approach
    // left it hanging skewed across the face.
    function aiBotSquareHang(fwdX, fwdZ, hang) {
        _aiHangFwd.set(fwdX, 0, fwdZ);
        _tempVec1.set(hang.x, hang.y + 0.4, hang.z);
        rayFwd.set(_tempVec1, _aiHangFwd);
        const hits = rayFwd.intersectObjects(collidables);
        if (!hits.length || hits[0].distance > COMP_LEDGE_WALL_REACH || !hits[0].face) return null;
        _aiHangNormal.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
        _aiHangNormal.y = 0;
        if (_aiHangNormal.lengthSq() < 1e-6) return null;
        _aiHangNormal.normalize();      // outward from the wall
        hang.set(
            hits[0].point.x + _aiHangNormal.x * COMP_HANG_OUT,
            hang.y,
            hits[0].point.z + _aiHangNormal.z * COMP_HANG_OUT);
        return _aiHangNormal;           // face INTO the wall = negated
    }

    // Hop OVER something rather than onto it. tryAiBotClimb only ever lands
    // on top of an obstacle, and refuses anything it cannot stand on - so a
    // narrow prop like a lock, where the far side of the lip is thin air,
    // fails that check and nothing else picks it up. The bot then just stood
    // against it. Vaulting is the obvious answer and it was simply missing.
    function tryAiBotHopOver(pos, destPos) {
        if (_aiClimbPhase !== 'none') return false;
        let dx = destPos.x - pos.x, dz = destPos.z - pos.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 1e-4) return false;
        dx /= dl; dz /= dl;
        const aheadY = aiBotSurfaceY(pos.x + dx * AI_CLIMB_PROBE, pos.z + dz * AI_CLIMB_PROBE, pos.y + COMP_CLIMB_MAX + 1.0);
        const rise = aheadY - pos.y;
        // Low enough to clear with a jump, tall enough to be in the way.
        if (rise <= AI_MAX_STEP_UP || rise > COMP_LEAP_RISE_MAX) return false;
        for (let d = AI_CLIMB_PROBE + 0.5; d <= COMP_LEAP_MAX_DIST; d += 0.4) {
            const lx = pos.x + dx * d, lz = pos.z + dz * d;
            const ly = aiBotSurfaceY(lx, lz, pos.y + COMP_CLIMB_MAX + 1.0);
            if (ly === -Infinity) continue;
            // Landing has to be at roughly its own level and BELOW the
            // obstacle's top - that is what makes this clearing something
            // rather than climbing onto it.
            if (Math.abs(ly - pos.y) > COMP_LEAP_RISE_MAX) continue;
            if (ly > aheadY - 0.3) continue;
            _aiClimbFrom.copy(pos);
            _aiClimbTop.set(lx, ly, lz);
            _compFaceEuler.set(0, Math.atan2(dx, dz), 0);
            _aiClimbQuat.setFromEuler(_compFaceEuler);
            _aiClimbPhase = 'leap';
            _aiClimbT = 0;
            _aiClimbDur = Math.max(0.35, _aiClimbFrom.distanceTo(_aiClimbTop) / COMP_LEAP_SPEED);
            return true;
        }
        return false;
    }

    // Gap leap - the companion's, with the same two rules that keep it
    // honest: never gain more height than the player's own jump, and never
    // take a drop unless the target is actually down there. Without this the
    // bot simply stopped at every edge, which is the other half of getting
    // stuck.
    function tryAiBotGapLeap(pos, destPos) {
        if (_aiClimbPhase !== 'none') return false;
        let dx = destPos.x - pos.x, dz = destPos.z - pos.z;
        const dl = Math.hypot(dx, dz);
        if (dl < 1e-4) return false;
        dx /= dl; dz /= dl;
        const aheadY = aiBotSurfaceY(pos.x + dx * COMP_LEAP_EDGE_FWD, pos.z + dz * COMP_LEAP_EDGE_FWD, pos.y + 3.0);
        if (pos.y - aheadY <= COMP_LEAP_EDGE_DROP) return false;   // a step or a ramp, just walk it
        let landing = null;
        for (let d = COMP_LEAP_EDGE_FWD + 0.5; d <= COMP_LEAP_MAX_DIST; d += 0.5) {
            const lx = pos.x + dx * d, lz = pos.z + dz * d;
            const ly = aiBotSurfaceY(lx, lz, pos.y + 3.0);
            if (ly === -Infinity) continue;
            if (ly - pos.y > COMP_LEAP_RISE_MAX) continue;         // that is a climb, not a jump
            if (pos.y - ly > COMP_LEAP_LANDING_BAND) continue;
            landing = { x: lx, y: ly, z: lz };
            break;
        }
        if (!landing) return false;
        // Dropping down only makes sense if that is where the target is -
        // otherwise it is a descent it will immediately have to undo.
        if ((pos.y - landing.y) > COMP_LEAP_EDGE_DROP && destPos.y > landing.y + 1.0) return false;
        _aiClimbFrom.copy(pos);
        _aiClimbTop.set(landing.x, landing.y, landing.z);
        _compFaceEuler.set(0, Math.atan2(dx, dz), 0);
        _aiClimbQuat.setFromEuler(_compFaceEuler);
        _aiClimbPhase = 'leap';
        _aiClimbT = 0;
        _aiClimbDur = Math.max(0.35, _aiClimbFrom.distanceTo(_aiClimbTop) / COMP_LEAP_SPEED);
        return true;
    }

    // Drives an in-progress climb. Returns true while it owns the bot.
    function updateAiBotClimb(delta) {
        if (_aiClimbPhase === 'none') return false;
        _aiClimbT += delta;
        const t = Math.min(1, _aiClimbT / _aiClimbDur);
        if (_aiClimbPhase === 'leap') {
            const gx = THREE.MathUtils.lerp(_aiClimbFrom.x, _aiClimbTop.x, t);
            const gz = THREE.MathUtils.lerp(_aiClimbFrom.z, _aiClimbTop.z, t);
            const gy = THREE.MathUtils.lerp(_aiClimbFrom.y, _aiClimbTop.y, t) + COMP_LEAP_ARC_HEIGHT * 4 * t * (1 - t);
            aiBot.group.position.set(gx, gy, gz);
            aiBot.setNetworkState([gx, gy, gz], [_aiClimbQuat.x, _aiClimbQuat.y, _aiClimbQuat.z, _aiClimbQuat.w],
                t < 1 ? (_aiClimbT < 0.18 ? 'jump_start' : 'fall') : 'land', false);
            aiBot.update(delta);
            if (t >= 1) _aiClimbPhase = 'none';
            return true;
        }
        if (_aiClimbPhase === 'jump') {
            const jx = THREE.MathUtils.lerp(_aiClimbFrom.x, _aiClimbHang.x, t);
            const jz = THREE.MathUtils.lerp(_aiClimbFrom.z, _aiClimbHang.z, t);
            const jy = THREE.MathUtils.lerp(_aiClimbFrom.y, _aiClimbHang.y, t) + COMP_LEAP_ARC_HEIGHT * 4 * t * (1 - t);
            aiBot.group.position.set(jx, jy, jz);
            aiBot.setNetworkState([jx, jy, jz], [_aiClimbQuat.x, _aiClimbQuat.y, _aiClimbQuat.z, _aiClimbQuat.w],
                t < 1 ? (_aiClimbT < 0.18 ? 'jump_start' : 'fall') : 'hang_idle', false);
            if (t >= 1) {
                _aiClimbPhase = 'pull';
                _aiClimbT = 0;
                const climbAction = aiBot.actions && aiBot.actions['climb'];
                _aiClimbDur = climbAction ? climbAction.getClip().duration : 1.0;
            }
            aiBot.update(delta);
            return true;
        }
        // pull: root held while the climb clip plays, placed on top at the end
        const done = t >= 1;
        const at = done ? _aiClimbTop : _aiClimbHang;
        aiBot.group.position.copy(at);
        if (done && aiBot.fbxModel) {
            // The click. By the end of the clip the body is already on the
            // ledge, so moving the root there as well applies the rise twice
            // and it jumps. Shift the MODEL back by what the root gained to
            // cancel it, then decay that offset so the model settles onto its
            // root. Same fix the companion's climb uses, and the player's.
            _aiClimbMoveDiff.copy(_aiClimbTop).sub(_aiClimbHang);
            _aiClimbTmpQuat.copy(_aiClimbQuat).invert();
            _aiClimbMoveDiff.applyQuaternion(_aiClimbTmpQuat);
            aiBot.fbxModel.position.sub(_aiClimbMoveDiff);
            _aiClimbBlendT = COMP_CLIMB_BLEND;
        }
        aiBot.setNetworkState([at.x, at.y, at.z], [_aiClimbQuat.x, _aiClimbQuat.y, _aiClimbQuat.z, _aiClimbQuat.w],
            done ? 'idle' : 'climb', false);
        aiBot.update(delta);
        if (done) _aiClimbPhase = 'none';
        return true;
    }

    // A punch landing ON a bot, poise pool and all. Shared by everything that
    // can hit one - the player's melee (ClimbGame.html's detectMeleeHits) and
    // the companions' counter-attack below - so the "how much does it take to
    // put a bot down" rule lives in exactly one place. It used to be inlined
    // in detectMeleeHits, which meant a second attacker either duplicated the
    // pool arithmetic or quietly used different numbers.
    //
    // Returns true if the bot went down, so the caller can react.
    // poiseOverride replaces the intensity's own poise cost while leaving the
    // recoil/flash it drives alone - so a long combo can look like every one
    // of its hits landed without being worth the sum of them. See the
    // companions' full combo.
    window.staggerBot = function staggerBot(bot, velocity, intensity, flashStrength, poiseOverride) {
        if (!bot || !bot.isLoaded || bot.isRagdoll) return false;
        const staggerMax = window.aiBotStaggerMax !== undefined ? window.aiBotStaggerMax : 100;
        const regenDelay = window.aiBotStaggerRegenDelay !== undefined ? window.aiBotStaggerRegenDelay : 2.5;
        bot.triggerHitFlash(flashStrength);
        if (intensity === 'high') {
            bot.initRagdoll(velocity, intensity);
            bot.staggerPool = staggerMax;
            bot.staggerRegenCooldown = regenDelay;
            return true;
        }
        // Hidden poise pool: a mature charge punch knocks a bot down outright
        // ('high' above), but a flurry of ordinary hits that never lets it
        // recover (regen only resumes after a gap without being hit) has to be
        // able to finish the job too - otherwise every non-charge hit only
        // ever flinches it.
        if (bot.staggerPool === undefined) bot.staggerPool = staggerMax;
        const staggerDamage = poiseOverride !== undefined ? poiseOverride
            : intensity === 'medium_high'
            ? (window.staggerDamageMediumHigh !== undefined ? window.staggerDamageMediumHigh : 35)
            : (window.staggerDamageMedium !== undefined ? window.staggerDamageMedium : 10);
        bot.staggerPool -= staggerDamage;
        bot.staggerRegenCooldown = regenDelay;
        if (bot.staggerPool <= 0) {
            bot.staggerPool = staggerMax;
            bot.initRagdoll(velocity, 'high');
            return true;
        }
        bot.applyProceduralRecoil(velocity, intensity);
        return false;
    };

    // Ragdolling or getting back up means it is already being dealt with -
    // hitting it again would just reset an animation that is mid-play.
    function aiBotVictimAvailable(v) {
        if (!v) return false;
        if (v.isRagdoll || v.isStandingUp) return false;
        // A companion that has not loaded yet, or is switched off, is not
        // something to walk over to and punch.
        if (v !== char) return v.isLoaded && v.group.visible;
        return true;
    }

    // Nearest thing worth attacking. Companions are targets in their own
    // right, not scenery - so the bot picks a fight with whichever of them it
    // runs into, rather than walking past one to get to the player.
    function aiBotPickVictim(pos) {
        let best = null, bestD = Infinity;
        if (aiBotVictimAvailable(char)) {
            const d = pos.distanceTo(char.group.position);
            if (d < bestD) { bestD = d; best = char; }
        }
        for (let i = 0; i < companions.length; i++) {
            const cmp = companions[i].comp;
            if (!aiBotVictimAvailable(cmp)) continue;
            const d = pos.distanceTo(cmp.group.position);
            if (d < bestD) { bestD = d; best = cmp; }
        }
        return best;
    }

    // One punch landing. Character and RemoteAvatar both carry
    // triggerHitFlash and RagdollPhysics' applyProceduralRecoil, so the same
    // call works on either - only the networking differs.
    function aiBotHitVictim(v, pos, force = AI_PUNCH_FORCE, intensity = 'medium') {
        const vp = v.group.position;
        const velocity = _tempVec2.set(vp.x - pos.x, 0, vp.z - pos.z).normalize().multiplyScalar(force);
        const hitPoint = vp.clone().setY(vp.y + 1.2);
        const flash = intensity === 'high' ? 2.5 : (intensity === 'low' ? 0.55 : 0.9);
        v.triggerHitFlash(flash);
        // 'high' knocks down outright rather than staggering - the same split
        // every other hit path in the game uses for that intensity. Without
        // this the charge bot's finisher would read as a light shove.
        if (intensity === 'high') v.initRagdoll(velocity, intensity);
        else v.applyProceduralRecoil(velocity, intensity);
        // Only the local player's own reaction is broadcast. The companion
        // is driven identically on every client from the same inputs, so
        // mirroring its hit would apply the recoil twice over there.
        if (v === char && network) {
            network.sendHitEvent(flash, hitPoint);
            if (intensity === 'high') network.sendRagdollEvent(velocity, intensity);
            else network.sendRecoilEvent(velocity, intensity);
        }
        if (window.createHandHitEffect) window.createHandHitEffect(hitPoint);
        if (window.spawnHitEffect) window.spawnHitEffect(hitPoint.clone());
    }

    function updateAiBot(delta) {
        if (!aiBot || !aiBot.isLoaded) return;
        // A hit mid-climb drops it - being knocked off a wall should look
        // like being knocked off a wall, not like finishing the climb anyway.
        if (aiBot.isRagdoll || aiBot.isStandingUp) {
            _aiClimbPhase = 'none';
            // Ragdoll drives the bones directly - a leftover model offset
            // would displace the whole ragdoll, so drop it outright.
            if (_aiClimbBlendT > 0 && aiBot.fbxModel) { aiBot.fbxModel.position.copy(_aiClimbModelRest); _aiClimbBlendT = 0; }
            aiBot.update(delta);
            return;
        }
        // Settle the model back onto its root after a climb. Ahead of
        // everything else so it keeps decaying whatever the bot does next.
        if (_aiClimbBlendT > 0 && aiBot.fbxModel) {
            _aiClimbBlendT -= delta;
            if (_aiClimbBlendT <= 0) aiBot.fbxModel.position.copy(_aiClimbModelRest);
            else aiBot.fbxModel.position.lerp(_aiClimbModelRest, Math.min(1, delta / _aiClimbBlendT));
        }
        // Owns the bot outright while it runs, ahead of the stagger step and
        // the mode machine, so nothing interrupts it halfway up.
        if (updateAiBotClimb(delta)) return;

        const pos = aiBot.group.position;

        if (window._botDebug) {
            // One panel per bot, stacked - a shared id had the two of them
            // overwriting each other's readout every frame, which is worse
            // than useless when the whole point is comparing what they are
            // each doing.
            const panelId = 'bot-debug-' + aiBot.id;
            let el = document.getElementById(panelId);
            if (!el) {
                el = document.createElement('div');
                el.id = panelId;
                const slot = aiBots.findIndex(r => r.bot === aiBot);
                el.style.cssText = 'position:fixed;bottom:' + Math.max(0, slot) * 130 + 'px;right:0;background:rgba(0,0,0,.85);color:#fd6;font:12px monospace;padding:8px;z-index:99999;white-space:pre;text-align:left;';
                document.body.appendChild(el);
            }
            const v = aiBotPickVictim(pos);
            el.textContent = [
                aiBot.id + (aiBotState.combo ? '  (combo)' : aiBotState.charge ? '  (charge)' : ''),
                'mode    ' + aiBotState.mode + (_aiClimbPhase !== 'none' ? '  [' + _aiClimbPhase + ']' : ''),
                'victim  ' + (v ? (v === char ? 'player' : 'companion') : 'none'),
                'dist    ' + (v ? pos.distanceTo(v.group.position).toFixed(2) : '-') +
                    '   dY ' + (v ? (v.group.position.y - pos.y).toFixed(2) : '-'),
                'climb   ' + _aiClimbWhy,
                'rise    ' + _aiClimbRise.toFixed(2) + '  (step<=' + AI_MAX_STEP_UP + ' hop<=' + COMP_LEAP_RISE_MAX + ' max ' + COMP_CLIMB_MAX + ')',
                'stuck   ' + _aiStuckT.toFixed(1) + 's' + (_aiUnstickT > 0 ? '  UNSTICKING' : '')
            ].join('\n');
        }

        // Progress watchdog - see _aiStuckAt. Deliberately measured on the
        // bot's real position rather than on any of the decisions that got it
        // there, so it catches a deadlock regardless of which rule caused it.
        // Punching and cooling down are legitimately stationary, so they do
        // not count as being stuck.
        if (pos.distanceToSquared(_aiStuckAt) > AI_STUCK_DIST * AI_STUCK_DIST) {
            _aiStuckAt.copy(pos);
            _aiStuckT = 0;
        } else if ((aiBotState.mode === 'chase' || aiBotState.mode === 'wander') && _aiUnstickT <= 0) {
            // Wandering counts too. It used to only watch during a chase, so
            // a bot that wedged itself between blocks while wandering had
            // nothing looking out for it at all.
            _aiStuckT += delta;
            if (_aiStuckT > AI_STUCK_TIME) {
                // Physically step sideways, rather than only picking a new
                // destination. Wedged in a gap, a new destination changes
                // nothing - every route out of the gap is blocked the same
                // way, so it re-derives the same jam and stays put. Moving
                // perpendicular breaks the wedge itself.
                _aiUnstickDir.set(-(pos.z - _aiStuckAt.z), 0, pos.x - _aiStuckAt.x);
                if (_aiUnstickDir.lengthSq() < 1e-6) _aiUnstickDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
                if (_aiUnstickDir.lengthSq() < 1e-6) _aiUnstickDir.set(1, 0, 0);
                _aiUnstickDir.normalize();
                _aiUnstickT = AI_UNSTICK_TIME;
                _aiClimbPhase = 'none';
                aiBotState.mode = 'wander';
                pickNewAiWanderTarget();
                _aiStuckT = 0;
                _aiStuckAt.copy(pos);
            }
        } else {
            _aiStuckT = 0;
        }

        // Deadlock escape, ahead of every routing decision - the point is to
        // do something none of them would have chosen. Ignores the normal
        // step-up refusal too: being wedged is exactly the case where the
        // ordinary "do not move onto that" rules are what is holding it.
        if (_aiUnstickT > 0) {
            _aiUnstickT -= delta;
            const us = Math.min(AI_WANDER_SPEED * 2.0 * delta, 0.2);
            const ux = pos.x + _aiUnstickDir.x * us, uz = pos.z + _aiUnstickDir.z * us;
            const ugy = aiBotSurfaceY(ux, uz, pos.y + 2.0);
            // A body-height ray as well as the ground check. Ground height
            // alone says nothing about a wall standing in that direction, so
            // the sidestep could - and did - walk straight into the side of a
            // block, which is how it ended up inside them.
            _tempVec3.set(_aiUnstickDir.x, 0, _aiUnstickDir.z);
            rayFwd.set(_tempVec1.set(pos.x, pos.y + 0.5, pos.z), _tempVec3);
            const uWall = rayFwd.intersectObjects(collidables);
            const uClear = !(uWall.length > 0 && uWall[0].distance < 0.6);
            // Only step somewhere it could stand: not into a wall, not up
            // one, not off a cliff. If this side is no good, try the other
            // next frame.
            if (uClear && ugy !== -Infinity && ugy - pos.y <= AI_MAX_STEP_UP && pos.y - ugy < 2.0) {
                _tempVec3.set(_aiUnstickDir.x, 0, _aiUnstickDir.z);
                const uq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _tempVec3);
                aiBot.group.position.set(ux, ugy, uz);
                aiBot.setNetworkState([ux, ugy, uz], [uq.x, uq.y, uq.z, uq.w], 'walk', false);
                aiBot.update(delta);
                return;
            }
            _aiUnstickDir.negate();
        }

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
            _aiClimbPhase = 'none';      // a hit drops whatever it was climbing
            _aiRecoverT = AI_RECOVER_SETTLE;
            _aiStuckT = 0; _aiStuckAt.copy(pos);   // not stuck, just hurt
            const recoveryStepSpeed = window.recoveryStepSpeed || 3.5;
            const recoveryStrengthMult = THREE.MathUtils.clamp(aiBot.hitRecoveryStrength / 12.0, 0.5, window.recoveryStrengthMultMax || 2.0);
            const stepSpeed = recoveryStepSpeed * recoveryStrengthMult * Math.min(1, aiBot.hitRecoveryTimer / hitRecoveryDuration);
            const nextPos = _tempVec3.copy(pos).addScaledVector(aiBot.hitRecoveryDir, stepSpeed * delta);
            rayDown.set(_tempVec1.copy(nextPos).setY(nextPos.y + 2.0), _downVec);
            const groundHits = rayDown.intersectObjects(collidables);
            // Falls rather than snapping - see the companion's own stagger for
            // why. Hit in mid-air, an outright snap teleports it to the floor.
            if (groundHits.length > 0) {
                const gY = groundHits[0].point.y;
                if (gY < pos.y - 0.05) nextPos.y = pos.y + Math.max(gY - pos.y, -16 * delta);
                else nextPos.y = gY;
            }
            // Moved DIRECTLY, not left to setNetworkState's lerp to chase.
            // That lerp is a smoothing filter for network samples, and running
            // the knockback through it swallowed most of the displacement -
            // which is why the bot barely budged from a thrown object while
            // the companion, which sets its position outright, was flung
            // properly. Same hit, different plumbing.
            aiBot.group.position.copy(nextPos);
            aiBot.setNetworkState([nextPos.x, nextPos.y, nextPos.z],
                [aiBot.group.quaternion.x, aiBot.group.quaternion.y, aiBot.group.quaternion.z, aiBot.group.quaternion.w], 'walk', false);
            aiBot.update(delta);
            return;
        }
        // Settle - stands and collects itself before going anywhere, the same
        // pause the companion takes. It is what makes the hit read as having
        // landed rather than being shrugged off.
        if (_aiRecoverT > 0) {
            _aiRecoverT -= delta;
            _aiStuckT = 0; _aiStuckAt.copy(pos);
            let ry = pos.y;
            rayDown.set(_tempVec1.set(pos.x, pos.y + 2.0, pos.z), _downVec);
            const settleHits = rayDown.intersectObjects(collidables);
            if (settleHits.length > 0) ry = settleHits[0].point.y;
            aiBot.group.position.set(pos.x, ry, pos.z);
            aiBot.setNetworkState([pos.x, ry, pos.z],
                [aiBot.group.quaternion.x, aiBot.group.quaternion.y, aiBot.group.quaternion.z, aiBot.group.quaternion.w], 'idle', false);
            aiBot.update(delta);
            return;
        }

        const victim = aiBotPickVictim(pos);
        const distToVictim = victim ? pos.distanceTo(victim.group.position) : Infinity;

        // Combat mode transitions - punch/cooldown run their own timers below
        // and aren't interrupted by distance checks mid-swing.
        if (aiBotState.mode === 'wander' && victim && distToVictim < AI_CHASE_RADIUS) {
            aiBotState.mode = 'chase';
        } else if (aiBotState.mode === 'chase' && (!victim || distToVictim > AI_CHASE_GIVEUP_RADIUS)) {
            aiBotState.mode = 'wander';
            pickNewAiWanderTarget();
        }

        if (aiBotState.mode === 'punch') {
            aiBotState.punchTimer += delta;
            // Whoever the swing started against - not re-picked mid-punch, or
            // the bot would spin to face someone else halfway through.
            const pv = aiBotState.victim;
            const pvPos = pv ? pv.group.position : null;
            const comboAction = aiBotState.combo && aiBot.actions && aiBot.actions['punch_combo'];
            const chargeAction = aiBotState.charge && aiBot.actions && aiBot.actions['punch_charge_punch'];
            // Wind-up first, then the swing - the charge bot's swingAnim flips
            // partway through the same 'punch' mode rather than needing a
            // separate state.
            const charging = chargeAction && aiBotState.punchTimer < AI_CHARGE_HOLD;
            const swingAnim = charging ? 'punch_charge_hold'
                : chargeAction ? 'punch_charge_punch'
                : comboAction ? 'punch_combo' : 'punch_left';
            if (pvPos) {
                const facingDir = _tempVec1.set(pvPos.x - pos.x, 0, pvPos.z - pos.z);
                if (facingDir.lengthSq() > 0.0001) {
                    facingDir.normalize();
                    const facingQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facingDir);
                    aiBot.setNetworkState([pos.x, pos.y, pos.z], [facingQuat.x, facingQuat.y, facingQuat.z, facingQuat.w], swingAnim, false);
                }
            }

            if (chargeAction) {
                const swingDur = chargeAction.getClip().duration;
                // One hit, at the same point in the clip the player's own
                // charge connects, and only if the victim is still in front of
                // it - the wind-up gives them a full second to leave, and the
                // punch landing on an empty spot afterwards is the whole
                // reward for reacting to the telegraph.
                if (!aiBotState.punchHasHit && aiBotState.punchTimer >= AI_CHARGE_HOLD + swingDur * AI_CHARGE_HIT_T) {
                    aiBotState.punchHasHit = true;
                    if (pv && aiBotVictimAvailable(pv) && pos.distanceTo(pvPos) < AI_CHARGE_RANGE + 0.6) {
                        aiBotHitVictim(pv, pos, AI_CHARGE_FORCE, 'high');
                    }
                }
                if (aiBotState.punchTimer >= AI_CHARGE_HOLD + swingDur) {
                    aiBotState.mode = 'cooldown';
                    aiBotState.cooldownTimer = AI_CHARGE_COOLDOWN;
                }
                aiBot.update(delta);
                return;
            }

            if (comboAction) {
                // Five hits paced off the clip's own duration rather than off
                // fixed seconds, so the damage stays on the frames the swings
                // visibly land on however long the clip happens to be.
                const comboDur = comboAction.getClip().duration;
                const nt = aiBotState.punchTimer / Math.max(comboDur, 1e-3);
                for (let i = aiBotState.comboIndex; i < AI_COMBO_HIT_TIMES.length; i++) {
                    if (nt < AI_COMBO_HIT_TIMES[i]) break;
                    aiBotState.comboIndex = i + 1;
                    const last = i === AI_COMBO_HIT_TIMES.length - 1;
                    // Re-checked per hit, not once for the whole combo: five
                    // hits take most of a second, and the victim can ragdoll,
                    // be knocked away or walk off partway through. Landing the
                    // rest of the string on empty air afterwards is the bug
                    // this guard exists for.
                    if (pv && aiBotVictimAvailable(pv) && pos.distanceTo(pvPos) < AI_PUNCH_RANGE + 0.6) {
                        aiBotHitVictim(pv, pos, last ? AI_COMBO_FINISH_FORCE : AI_COMBO_FORCE, last ? 'medium' : 'low');
                    }
                }
                if (aiBotState.punchTimer >= comboDur) {
                    aiBotState.mode = 'cooldown';
                    aiBotState.cooldownTimer = AI_COMBO_COOLDOWN;
                }
                aiBot.update(delta);
                return;
            }

            if (!aiBotState.punchHasHit && aiBotState.punchTimer >= AI_PUNCH_HIT_TIME) {
                aiBotState.punchHasHit = true;
                if (pv && aiBotVictimAvailable(pv) && pos.distanceTo(pvPos) < AI_PUNCH_RANGE + 0.6) {
                    aiBotHitVictim(pv, pos);
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
            if (aiBotState.cooldownTimer <= 0) aiBotState.mode = (victim && distToVictim < AI_CHASE_RADIUS) ? 'chase' : 'wander';
            aiBot.update(delta);
            return;
        }

        if (aiBotState.mode === 'chase') {
            // The charge bot starts its wind-up from further out - the swing
            // has more reach, and starting it at jab distance would put it
            // nose-to-nose with the victim for the whole telegraph.
            if (distToVictim < (aiBotState.charge ? AI_CHARGE_RANGE : AI_PUNCH_RANGE)) {
                aiBotState.mode = 'punch';
                aiBotState.punchTimer = 0;
                aiBotState.punchHasHit = false;
                aiBotState.comboIndex = 0;
                aiBotState.victim = victim;
                aiBot.update(delta);
                return;
            }
            const vPos = victim.group.position;
            const chaseSpeed = aiBotChaseSpeed(distToVictim);
            const vAbove = vPos.y - pos.y > COMP_CLIMB_WORTH_IT;

            // CLIMB FIRST. If there is something climbable directly in front,
            // climbing it is the answer regardless of what else is going on -
            // this used to be tried last, so the bot would walk off toward a
            // recorded takeoff crumb metres away while standing against a
            // perfectly good wall, and if the takeoff was unreachable it never
            // got back to trying the wall at all.
            //
            // Full reach when the target is above, hop height when level. That
            // distinction is what keeps it from scaling blocks for no reason
            // on flat ground while still letting it follow upward.
            if (tryAiBotClimb(pos, vPos, vAbove ? COMP_CLIMB_MAX : COMP_LEAP_RISE_MAX)) { aiBot.update(delta); return; }
            // Couldn't land on it - it may still be something to vault.
            if (tryAiBotHopOver(pos, vPos)) { aiBot.update(delta); return; }

            if (vAbove) {
                // Nothing climbable here, so go by way of where the player
                // left this level - see findTakeoffApproach. Steering is
                // deliberately skipped while heading up: avoiding the block is
                // the wrong instinct when the block IS the route.
                // Retrace whoever it is actually chasing. Following the
                // player's route to reach the companion is no use when the
                // companion went up somewhere else entirely.
                const app = findTakeoffApproach(pos, trailForVictim(victim));
                if (app && Math.hypot(app.at.x - pos.x, app.at.z - pos.z) >= 0.7) {
                    _aiApproach.set(app.at.x, pos.y, app.at.z);
                    if (moveAiBotDirect(_aiApproach, chaseSpeed, delta) >= 0) { aiBot.update(delta); return; }
                }
                // No takeoff, or the way to it is blocked - close head-on and
                // let the climb above catch the wall once it arrives.
                if (moveAiBotDirect(vPos, chaseSpeed, delta) >= 0) { aiBot.update(delta); return; }
                // Genuinely walled in with nothing climbable: fall through to
                // steering and look for a way round.
            }
            if (tryAiBotGapLeap(pos, vPos)) { aiBot.update(delta); return; }
            if (moveAiBotToward(vPos, chaseSpeed, delta) < 0) pickNewAiWanderTarget();
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
        if (aiBots.length) return;
        // Yellow, to tell it apart from the blue companion at a glance.
        addAiBot({ id: 'ai-bot-1', color: 0xffd633, offset: [3, 0, 3] });
        // The orange one. Same chase/climb brain, different attack: it throws
        // the five-hit combo instead of a single punch (see AI_COMBO_*).
        addAiBot({ id: 'ai-bot-2', color: 0xff7a1a, offset: [-3.5, 0, 3.5], combo: true });
        // The red one - charge punch. Winds up visibly, then one knockdown
        // blow (see AI_CHARGE_*). Spawned behind the other two so the three
        // do not start life inside one another.
        addAiBot({ id: 'ai-bot-3', color: 0xd42a2a, offset: [0, 0, -4.5], charge: true });

        const spawnBtn = document.getElementById('ai-bot-spawn-btn');
        const despawnBtn = document.getElementById('ai-bot-despawn-btn');
        const statusEl = document.getElementById('ai-bot-status');
        if (spawnBtn) spawnBtn.style.display = 'none';
        if (despawnBtn) despawnBtn.style.display = 'block';
        if (statusEl) statusEl.textContent = aiBots.length + ' spawned (yellow, orange=combo, red=charge)';
    }

    function despawnAiBot() {
        if (!aiBots.length) return;
        aiBots.forEach(rec => {
            activateAiBot(rec);
            disposeAiBotPathLines();
            saveAiBot(rec);
            rec.bot.dispose();
        });
        aiBots.length = 0;
        aiBot = null;
        window.aiBot = null;
        window.aiBots = [];

        const spawnBtn = document.getElementById('ai-bot-spawn-btn');
        const despawnBtn = document.getElementById('ai-bot-despawn-btn');
        const statusEl = document.getElementById('ai-bot-status');
        if (spawnBtn) spawnBtn.style.display = 'block';
        if (despawnBtn) despawnBtn.style.display = 'none';
        if (statusEl) statusEl.textContent = 'not spawned';
    }

    // ---- Bot registry ----
    // One record per enemy. Everything in here is state the chase/climb code
    // above keeps between frames; the module-level `aiBot`/`aiBotState`/`_ai*`
    // bindings it actually reads are re-pointed at one record at a time by
    // activateAiBot, and written back by saveAiBot.
    //
    // Done this way, rather than passing a bot handle into all forty-odd
    // functions, because that logic is heavily tuned and touching every line
    // of it to add a parameter is a lot of risk for no behavioural gain. The
    // rule to keep it honest: anything the bot code REMEMBERS across frames
    // belongs in both functions below. Per-call scratch (_aiAvoidPerp,
    // _aiHangFwd, _aiClimbMoveDiff, _aiApproach, ...) deliberately does not -
    // it is written and consumed inside a single call, so sharing it between
    // bots is free.
    const aiBots = [];
    window.aiBots = [];
    function addAiBot(opts) {
        const rec = {
            bot: new RemoteAvatar(scene, threeTone, opts.id),
            // Safe before the model has loaded: setColor stores the value and
            // the material constructor reads it back (see bodyColor).
            state: {
                mode: 'wander',
                target: new THREE.Vector3(),
                waitTimer: 0, punchTimer: 0, punchHasHit: false, cooldownTimer: 0,
                comboIndex: 0, comboHand: 'punch_left',
                combo: !!opts.combo, charge: !!opts.charge,
                victim: null, avoidSide: 0,
            },
            chaseRunning: false, locoState: 'idle',
            stuckAt: new THREE.Vector3(), stuckT: 0,
            recoverT: 0,
            unstickDir: new THREE.Vector3(), unstickT: 0,
            climbFrom: new THREE.Vector3(), climbHang: new THREE.Vector3(),
            climbTop: new THREE.Vector3(), climbQuat: new THREE.Quaternion(),
            climbModelRest: new THREE.Vector3(), climbBlendT: 0,
            climbWhy: 'none', climbRise: 0, climbPhase: 'none', climbT: 0, climbDur: 0,
            goalLine: null, stepLine: null,
        };
        rec.bot.setColor(opts.color);
        const spawnPos = char.group.position;
        rec.bot.group.position.copy(spawnPos).add(
            new THREE.Vector3(opts.offset[0], opts.offset[1], opts.offset[2]));
        rec.state.target.set(
            spawnPos.x + opts.offset[0], spawnPos.y, spawnPos.z + opts.offset[2]);
        rec.stuckAt.copy(rec.bot.group.position);
        aiBots.push(rec);
        // Every damage path in the game (melee, projectiles, thrown props)
        // needs the whole list; window.aiBot stays pointed at the first one
        // for the multiplayer send, which has a single 'ai-bot-1' slot.
        window.aiBots = aiBots.map(r => r.bot);
        if (!aiBot) { aiBot = rec.bot; window.aiBot = rec.bot; }
        // Path lines are per-bot too, so two bots do not overwrite one
        // another's debug geometry every frame.
        activateAiBot(rec);
        createAiBotPathLines();
        saveAiBot(rec);
        return rec;
    }
    function activateAiBot(rec) {
        aiBot = rec.bot;
        aiBotState = rec.state;
        _aiChaseRunning = rec.chaseRunning; _aiLocoState = rec.locoState;
        _aiStuckAt = rec.stuckAt; _aiStuckT = rec.stuckT;
        _aiRecoverT = rec.recoverT;
        _aiUnstickDir = rec.unstickDir; _aiUnstickT = rec.unstickT;
        _aiClimbFrom = rec.climbFrom; _aiClimbHang = rec.climbHang;
        _aiClimbTop = rec.climbTop; _aiClimbQuat = rec.climbQuat;
        _aiClimbModelRest = rec.climbModelRest; _aiClimbBlendT = rec.climbBlendT;
        _aiClimbWhy = rec.climbWhy; _aiClimbRise = rec.climbRise;
        _aiClimbPhase = rec.climbPhase; _aiClimbT = rec.climbT; _aiClimbDur = rec.climbDur;
        aiBotGoalLine = rec.goalLine; aiBotStepLine = rec.stepLine;
    }
    function saveAiBot(rec) {
        // Objects (state, vectors, quaternion) are shared BY REFERENCE with
        // the record, so they need no copying back - only the scalars, which
        // the bot code reassigns rather than mutates, do.
        rec.chaseRunning = _aiChaseRunning; rec.locoState = _aiLocoState;
        rec.stuckT = _aiStuckT;
        rec.recoverT = _aiRecoverT;
        rec.unstickT = _aiUnstickT;
        rec.climbBlendT = _aiClimbBlendT;
        rec.climbWhy = _aiClimbWhy; rec.climbRise = _aiClimbRise;
        rec.climbPhase = _aiClimbPhase; rec.climbT = _aiClimbT; rec.climbDur = _aiClimbDur;
        rec.goalLine = aiBotGoalLine; rec.stepLine = aiBotStepLine;
    }
    function updateAiBots(delta) {
        for (let i = 0; i < aiBots.length; i++) {
            activateAiBot(aiBots[i]);
            updateAiBot(delta);
            saveAiBot(aiBots[i]);
        }
    }

    // Same debug path-line pair aiBot's own createAiBotPathLines/
    // updateAiBotPathVisual draw (goal = where it's headed, step = the
    // direction it actually chose this frame after steering) - a separate
    // copy with its own colors so both can be shown at once without
    // confusing which line belongs to which. Shares the AI bot's own
    // ai-bot-path-toggle rather than getting a new checkbox: it's the same
    // "show me what the steering is doing" tool, just pointed at the
    // companion, useful for exactly the same reason (diagnosing why it
    // flickers/stutters going around an obstacle).
    let companionGoalLine = null, companionStepLine = null;
    function createCompanionPathLines() {
        const goalGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        companionGoalLine = new THREE.Line(goalGeo, new THREE.LineBasicMaterial({ color: 0xff66cc }));
        companionGoalLine.frustumCulled = false;
        scene.add(companionGoalLine);

        const stepGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        companionStepLine = new THREE.Line(stepGeo, new THREE.LineBasicMaterial({ color: 0x66ffcc }));
        companionStepLine.frustumCulled = false;
        scene.add(companionStepLine);
    }
    function updateCompanionPathVisual(botPos, goalPos, stepPos) {
        if (!companionGoalLine || !companionStepLine) return;
        companionGoalLine.visible = window.aiBotPathVisible;
        companionStepLine.visible = window.aiBotPathVisible;
        if (!window.aiBotPathVisible) return;
        const goalY = botPos.y + 0.1;
        companionGoalLine.geometry.setFromPoints([
            new THREE.Vector3(botPos.x, goalY, botPos.z),
            new THREE.Vector3(goalPos.x, goalY, goalPos.z)
        ]);
        companionStepLine.geometry.setFromPoints([
            new THREE.Vector3(botPos.x, goalY, botPos.z),
            new THREE.Vector3(stepPos.x, goalY, stepPos.z)
        ]);
    }

    // ---- Companion registry ----
    // Same shape as the bot registry (see addAiBot): one record per companion
    // holding everything the follow/climb code remembers between frames, with
    // activateCompanion re-pointing the module-level `companion`/`_comp*`/
    // `_hang*`/`_climb*` bindings at whichever one is being updated. Threading
    // a handle through all of updateCompanion instead would mean editing every
    // line of the most heavily iterated-on code in this file.
    //
    // Same rule as the bots: anything REMEMBERED across frames goes in both
    // activate and save. Per-call scratch (_compBehindDir, _compGroundOrigin,
    // _compGroundList, _compVisPos, _compFaceEuler, _ledge*, _climbMoveDiff,
    // _climbTmpQuat) stays shared - it is written and consumed inside one call.
    const companions = [];
    window.companions = [];
    // How likely a hit is to be answered, and how long the answer runs. The
    // blue one hits back only sometimes and short; the pale one always does,
    // and throws the full three.
    let _compRetaliateChance = 0.5;
    let _compPunchCount = 2;
    function addCompanion(opts) {
        const rec = {
            comp: new RemoteAvatar(scene, threeTone, opts.id),
            retaliateChance: opts.retaliateChance,
            punchCount: opts.punchCount,
            fullCombo: !!opts.fullCombo,
            charge: !!opts.charge,
            followDist: COMP_FOLLOW_DIST,
            mode: 'follow', replayStartT: 0, replayT: 0,
            shimmyHang: new THREE.Vector3(), shimmyTop: new THREE.Vector3(),
            shimmyFaceQuat: new THREE.Quaternion(),
            hangPos: new THREE.Vector3(), hangQuat: new THREE.Quaternion(),
            hangTop: new THREE.Vector3(), hangFwd: new THREE.Vector3(),
            climbFrom: new THREE.Vector3(), climbTo: new THREE.Vector3(),
            climbQuat: new THREE.Quaternion(), climbT: 0, climbDur: 1.0,
            climbModelRest: new THREE.Vector3(), climbBlendT: 0,
            faceQuat: new THREE.Quaternion(),
            leapStart: new THREE.Vector3(), leapEnd: new THREE.Vector3(),
            leapFaceQuat: new THREE.Quaternion(), leapT: 0, leapDur: 0.35, leapToHang: false,
            stuckAt: new THREE.Vector3(), unstickDir: new THREE.Vector3(),
            stuckT: 0, unstickT: 0,
            why: 'init', recoverT: 0, justClimbedT: 0, takeoffT: -1, hitSettled: false,
            speedSmooth: 0, locoState: 'idle',
            avoidSide: 0, steerDirSmooth: new THREE.Vector3(),
            steerDirValid: false, steerBlockedFor: 0,
            punchT: -1, punchIndex: 0, punchTarget: null, retaliate: false, attackCD: 0,
            ledgeWaitT: 0,
            // Its OWN breadcrumb trail. Deliberately not shared: the two
            // wander off in different directions, and a bot retracing one
            // interleaved trail would cut between whichever crumbs happened to
            // be adjacent in time. Same reasoning as keeping the companion's
            // trail separate from the player's in the first place.
            trail: [], trailT: 0,
            goalLine: null, stepLine: null,
        };
        if (opts.color !== undefined) rec.comp.setColor(opts.color);
        // Spawn BEHIND the player, on ground, not on top of them. Copying the
        // player's position outright put the two in the same place, and the
        // companion then spent its first moments resolving an overlap it
        // should never have been in - reading as climbing the player and
        // hopping about. The bot has always offset itself at spawn; this just
        // never did. The side offset then keeps two companions from starting
        // life inside each other for exactly the same reason.
        _compBehindDir.set(0, 0, 1).applyQuaternion(char.group.quaternion).negate();
        _compBehindDir.y = 0;
        if (_compBehindDir.lengthSq() < 1e-6) _compBehindDir.set(0, 0, 1);
        _compBehindDir.normalize();
        companions.push(rec);
        window.companions = companions.map(r => r.comp);
        // Re-spread the whole queue every time one joins, so the spacing is
        // right whatever the roster ends up being rather than only for three.
        // The LAST one keeps COMP_FOLLOW_DIST - that is the far end of the
        // line - and the rest are stepped evenly in toward the player.
        //
        // Before the spawn placement below, not after: that reads followDist
        // to decide where to stand, and a companion placed at the old value
        // would spend its first seconds walking to the spot it should have
        // started on.
        for (let i = 0; i < companions.length; i++) {
            companions[i].followDist = companions.length < 2
                ? COMP_FOLLOW_DIST
                : THREE.MathUtils.lerp(COMP_FOLLOW_NEAR, COMP_FOLLOW_DIST, i / (companions.length - 1));
        }
        const side = opts.sideOffset || 0;
        const sx = char.group.position.x + _compBehindDir.x * rec.followDist - _compBehindDir.z * side;
        const sz = char.group.position.z + _compBehindDir.z * rec.followDist + _compBehindDir.x * side;
        // Drop onto whatever is actually under that spot rather than
        // inheriting the player's height, which on a ledge would leave it
        // hanging in the air behind them.
        rayDown.set(_tempVec1.set(sx, char.group.position.y + 3.0, sz), _downVec);
        const spawnHits = rayDown.intersectObjects(collidables, true);
        const sy = spawnHits.length ? spawnHits[0].point.y : char.group.position.y;
        rec.comp.group.position.set(sx, sy, sz);
        rec.stuckAt.copy(rec.comp.group.position);
        // window.companion stays pointed at the first one - the thrown-object
        // hit path and the head-scale pass reference it by name.
        if (!companion) { companion = rec.comp; window.companion = rec.comp; }
        activateCompanion(rec);
        createCompanionPathLines();
        saveCompanion(rec);
        return rec;
    }
    function spawnCompanion() {
        if (companions.length) return;
        // Retaliation is near-certain now rather than a coin flip - they were
        // shrugging off half the hits they took, which read as not noticing.
        addCompanion({ id: 'companion', retaliateChance: 0.85, punchCount: 2, sideOffset: 0 });
        // Between the blue companion and the grey player - a paler, washed-out
        // blue, so the two read as a pair rather than as unrelated characters.
        addCompanion({
            id: 'companion-2', color: 0xa1c3ee,
            retaliateChance: 1.0, punchCount: 3, fullCombo: true, sideOffset: 1.3,
        });
        // Dark blue - the heavy. One wound-up knockdown rather than a string.
        addCompanion({
            id: 'companion-3', color: 0x1b3fa0,
            retaliateChance: 1.0, punchCount: 1, charge: true, sideOffset: -1.3,
        });
    }
    function activateCompanion(rec) {
        companion = rec.comp;
        _compRetaliateChance = rec.retaliateChance; _compPunchCount = rec.punchCount;
        _compFullCombo = rec.fullCombo; _compCharge = rec.charge;
        _compFollowDist = rec.followDist;
        _compAttackCD = rec.attackCD; _compLedgeWaitT = rec.ledgeWaitT;
        _compMode = rec.mode; _replayStartT = rec.replayStartT; _replayT = rec.replayT;
        _shimmyHang = rec.shimmyHang; _shimmyTop = rec.shimmyTop; _shimmyFaceQuat = rec.shimmyFaceQuat;
        _hangPos = rec.hangPos; _hangQuat = rec.hangQuat; _hangTop = rec.hangTop; _hangFwd = rec.hangFwd;
        _climbFrom = rec.climbFrom; _climbTo = rec.climbTo; _climbQuat = rec.climbQuat; _climbT = rec.climbT; _climbDur = rec.climbDur;
        _climbModelRest = rec.climbModelRest; _climbBlendT = rec.climbBlendT;
        _compFaceQuat = rec.faceQuat;
        _compLeapStart = rec.leapStart; _compLeapEnd = rec.leapEnd;
        _compLeapFaceQuat = rec.leapFaceQuat; _compLeapT = rec.leapT;
        _compLeapDur = rec.leapDur; _compLeapToHang = rec.leapToHang;
        _compStuckAt = rec.stuckAt; _compUnstickDir = rec.unstickDir;
        _compStuckT = rec.stuckT; _compUnstickT = rec.unstickT;
        _compWhy = rec.why; _compRecoverT = rec.recoverT;
        _compJustClimbedT = rec.justClimbedT; _compTakeoffT = rec.takeoffT;
        _compHitSettled = rec.hitSettled;
        _compSpeedSmooth = rec.speedSmooth; _compLocoState = rec.locoState;
        _compAvoidSide = rec.avoidSide; _compSteerDirSmooth = rec.steerDirSmooth;
        _compSteerDirValid = rec.steerDirValid; _compSteerBlockedFor = rec.steerBlockedFor;
        _compPunchT = rec.punchT; _compPunchIndex = rec.punchIndex;
        _compPunchTarget = rec.punchTarget; _compRetaliate = rec.retaliate;
        _companionTrail = rec.trail; _companionTrailT = rec.trailT;
        companionGoalLine = rec.goalLine; companionStepLine = rec.stepLine;
    }
    function saveCompanion(rec) {
        // Objects (vectors, quaternions, the trail array) are shared BY
        // REFERENCE with the record and need no copying back - only the
        // scalars, which the companion code reassigns rather than mutates.
        rec.mode = _compMode; rec.replayStartT = _replayStartT; rec.replayT = _replayT;
        rec.climbT = _climbT; rec.climbDur = _climbDur; rec.climbBlendT = _climbBlendT;
        rec.leapT = _compLeapT; rec.leapDur = _compLeapDur; rec.leapToHang = _compLeapToHang;
        rec.stuckT = _compStuckT; rec.unstickT = _compUnstickT;
        rec.why = _compWhy; rec.recoverT = _compRecoverT;
        rec.justClimbedT = _compJustClimbedT; rec.takeoffT = _compTakeoffT;
        rec.hitSettled = _compHitSettled;
        rec.speedSmooth = _compSpeedSmooth; rec.locoState = _compLocoState;
        rec.avoidSide = _compAvoidSide; rec.steerDirValid = _compSteerDirValid;
        rec.steerBlockedFor = _compSteerBlockedFor;
        rec.punchT = _compPunchT; rec.punchIndex = _compPunchIndex;
        rec.punchTarget = _compPunchTarget; rec.retaliate = _compRetaliate;
        rec.attackCD = _compAttackCD; rec.ledgeWaitT = _compLedgeWaitT;
        rec.trailT = _companionTrailT;
        rec.goalLine = companionGoalLine; rec.stepLine = companionStepLine;
    }
    function updateCompanions(delta) {
        if (!window.companionEnabled) {
            companions.forEach(r => { r.comp.group.visible = false; });
            return;
        }
        if (!companions.length) spawnCompanion();
        for (let i = 0; i < companions.length; i++) {
            activateCompanion(companions[i]);
            updateCompanion(delta);
            saveCompanion(companions[i]);
        }
    }
    function recordCompanionTrails(delta) {
        for (let i = 0; i < companions.length; i++) {
            activateCompanion(companions[i]);
            recordCompanionTrail(delta);
            saveCompanion(companions[i]);
        }
    }
    // Companion equivalent of aiBotSeparate - see that function for why the
    // push is applied to the step TARGET and why it is speed-capped rather
    // than resolving the whole overlap in one frame.
    const _compSepOut = new THREE.Vector2();
    const COMP_SEPARATION = 1.15;
    const COMP_SEPARATION_PUSH = 0.5;
    const COMP_SEPARATION_MAX_SPEED = 2.0;
    const COMP_SEPARATION_DY = 1.4;   // only shove ones on roughly the same level
    function companionSeparate(x, z, y, delta, out) {
        out.set(x, z);
        const maxPush = COMP_SEPARATION_MAX_SPEED * delta;
        for (let i = 0; i < companions.length; i++) {
            const other = companions[i].comp;
            if (other === companion || !other.isLoaded) continue;
            const op = other.group.position;
            if (Math.abs(op.y - y) > COMP_SEPARATION_DY) continue;
            let dx = out.x - op.x, dz = out.y - op.z;
            let d = Math.hypot(dx, dz);
            if (d >= COMP_SEPARATION) continue;
            // Exactly coincident - no direction to separate along, so pick one
            // off the index rather than leaving them welded together.
            if (d < 1e-4) {
                const a = (i + 1) * 2.399963;   // golden angle, so they fan out
                dx = Math.cos(a); dz = Math.sin(a); d = 1;
            }
            const push = Math.min((COMP_SEPARATION - d) * COMP_SEPARATION_PUSH, maxPush) / d;
            out.x += dx * push;
            out.y += dz * push;
        }
    }

    // Which breadcrumb trail retraces this victim's route up. A bot chasing a
    // companion has to follow THAT companion's crumbs - the other one may have
    // gone somewhere else entirely.
    function trailForVictim(v) {
        for (let i = 0; i < companions.length; i++) {
            if (companions[i].comp === v) return companions[i].trail;
        }
        return _compTrail;
    }

    // Highest solid surface under (x,z) (falls back to fallbackY on a miss).
    // Casts against _compGroundList, rebuilt once per updateCompanion frame.
    // Highest surface under (x,z) that is not more than `maxAbove` over the
    // reference height - i.e. something the companion could actually be
    // standing on, or step onto.
    //
    // Taking the topmost hit (which this used to do) is wrong whenever there
    // is anything OVERHEAD: the ray starts above the player, so with the
    // player up on a block the first hit at a point near that block's
    // footprint is the block's top, not the ground the companion is standing
    // on. Right at the footprint boundary a few centimetres of movement flips
    // the answer between the two, and the vertical follow alternates between
    // rising and falling - the up-and-down jitter.
    //
    // The climb probes genuinely do want the obstacle above, so they pass a
    // larger maxAbove rather than this having to guess which caller it is.
    function companionGroundY(x, z, fallbackY, maxAbove = COMP_STEP_UP) {
        _compGroundOrigin.set(x, Math.max(fallbackY, char.group.position.y) + 3.0, z);
        rayDown.set(_compGroundOrigin, _downVec);
        const hits = rayDown.intersectObjects(_compGroundList, true);
        const ceiling = fallbackY + maxAbove;
        // Hits come back top-down, so the first at or under the ceiling is the
        // highest qualifying surface.
        for (let i = 0; i < hits.length; i++) {
            if (hits[i].point.y <= ceiling) return hits[i].point.y;
        }
        // Everything here is overhead - nothing to stand on at this height.
        return hits.length ? hits[hits.length - 1].point.y : fallbackY;
    }

    // Starts a climb-up leap onto whatever is blocking a step to
    // (destX, destZ), if there is something there and it's within reach.
    // Returns true if a leap was started, in which case the caller must
    // return immediately and let LEAP mode drive.
    //
    // Shared by both movement paths, because either can walk face-first
    // into a wall and neither can do anything about it on its own: the
    // breadcrumb replay only climbs walls the PLAYER already climbed (it
    // needs a recorded crumb at the companion's own height), so a fall into
    // somewhere unvisited leaves no recorded route, and the plain follow
    // walk has no upward move beyond a single step.
    function tryCompanionClimbUp(c, destX, destZ, dirX, dirZ) {
        // Asks for surfaces ABOVE, up to climb reach - this wants the height
        // of the thing in the way, not the floor it is standing on.
        const topY = companionGroundY(destX, destZ, c.y, COMP_CLIMB_MAX);
        const rise = topY - c.y;
        if (rise <= COMP_STEP_UP || rise > COMP_CLIMB_MAX) return false;
        // Aim past the lip, or it lands balanced exactly on the edge and the
        // next frame's ground probe can miss the block entirely.
        let climbX = destX + dirX * COMP_CLIMB_INSET;
        let climbZ = destZ + dirZ * COMP_CLIMB_INSET;
        let climbTopY = companionGroundY(climbX, climbZ, topY, 0.6);
        // Something TALLER starting right past the lip is a staircase, and
        // refusing the climb because of it - which is what the old
        // "same surface" test did - meant the companion simply stopped at
        // every flight of stairs. The next step being higher is no reason not
        // to get onto this one; it just means landing shorter, nearer the
        // edge, so aim there instead.
        if (climbTopY > topY + 0.6) {
            climbX = destX + dirX * COMP_CLIMB_INSET_TIGHT;
            climbZ = destZ + dirZ * COMP_CLIMB_INSET_TIGHT;
            climbTopY = companionGroundY(climbX, climbZ, topY, 0.6);
        }
        // Reject ONLY a surface that drops away past the lip - that is a ledge
        // too narrow to stand on. A surface that keeps RISING is a slope or a
        // staircase, and landing on it is still progress.
        //
        // The old test rejected both directions equally, which meant any
        // continuously rising ground failed it: the steep test ramps rise
        // more than the 0.6 tolerance even over the short inset, so the climb
        // was refused and the companion simply stopped at the bottom of them.
        if (climbTopY < topY - 0.6) return false;
        // ...but the landing still has to be somewhere it can actually get to.
        if (climbTopY - c.y > COMP_CLIMB_MAX) return false;
        // Jump for the ledge and hang, rather than arcing straight onto the
        // top. Going up in one smooth curve to standing was the move that
        // read as flying: nothing in this game rises like that. The player
        // gets onto a wall by jumping, grabbing, and then climbing, so the
        // companion does the same - this call is only the jump, HANG decides
        // when to climb.
        _ledgeSpotTop.set(climbX, climbTopY, climbZ);
        // Low enough to simply hop onto - so hop. Routing everything through
        // hang-then-pull was wrong for short rises: the hang sits
        // COMP_HANG_DROP below the lip, so for anything under about 1.5 that
        // is BELOW the companion's own feet, and it would try to jump down
        // into a hang in order to climb a step it could step onto. Nobody
        // grabs a ledge at knee height.
        if (rise <= COMP_LEAP_RISE_MAX) {
            _compLeapStart.copy(c);
            _compLeapEnd.copy(_ledgeSpotTop);
            _compLeapDur = Math.max(0.35, _compLeapStart.distanceTo(_compLeapEnd) / COMP_LEAP_SPEED);
            _compLeapT = 0;
            _compLeapToHang = false;   // lands on top, no ledge involved
            _compFaceEuler.set(0, Math.atan2(dirX, dirZ), 0);
            _compLeapFaceQuat.setFromEuler(_compFaceEuler);
            _compMode = 'leap';
            return true;
        }
        return startCompanionJumpGrab(c, _ledgeSpotTop, dirX, dirZ);
    }

    // Jump from the ground and catch `top`'s ledge, ending in a hang.
    // Refuses anything the player's own jump could not reach, so the
    // companion is never doing something you could not.
    function startCompanionJumpGrab(c, top, fwdX, fwdZ) {
        computeLedgeHang(top, fwdX, fwdZ, _hangPos);
        _hangFwd.set(fwdX, 0, fwdZ);
        // Square up to the wall before committing, so the grab lands facing
        // the face rather than facing however it happened to walk in. The
        // player takes its hang facing from the wall normal too (its grab does
        // lookAt(position - n)); taking it from the travel direction only
        // matches when the approach was dead-on.
        squareHangToWall();
        if (_hangPos.y - c.y > COMP_LEAP_RISE_MAX) return false;
        _hangTop.copy(top);
        // Clear of whoever is already on this ledge before committing to the
        // jump. This path had no such check at all, which is the main way two
        // companions ended up on one grip: they both probe the same wall on
        // the same frame, both compute the same hang from the same geometry,
        // and both leap to it. Refusing sends this one back to following, and
        // it tries again once the ledge is free or from somewhere else along it.
        if (!nudgeHangClear(char.group.position)) {
            _compLedgeWaitT = COMP_LEDGE_WAIT * (1 + Math.random() * COMP_LEDGE_WAIT_JITTER);
            _compWhy = 'ledge busy, waiting';
            return false;
        }
        // The nudge may have slid the grip along the ledge, so the reach test
        // is re-run against where it will ACTUALLY jump to.
        if (_hangPos.y - c.y > COMP_LEAP_RISE_MAX) return false;
        _compFaceEuler.set(0, Math.atan2(_hangFwd.x, _hangFwd.z), 0);
        _hangQuat.setFromEuler(_compFaceEuler);
        _compLeapStart.copy(c);
        _compLeapEnd.copy(_hangPos);
        _compLeapDur = Math.max(0.35, _compLeapStart.distanceTo(_compLeapEnd) / COMP_LEAP_SPEED);
        _compLeapT = 0;
        _compLeapToHang = true;
        _compLeapFaceQuat.copy(_hangQuat);
        _compMode = 'leap';
        return true;
    }

    // Looks left and right along the ledge currently being hung from (the
    // HANG state) for somewhere clear to come up, and starts a shimmy toward
    // it. Returns true if one was found - SHIMMY mode drives from there.
    //
    // _hangFwd points from the hang position out over the edge, so its
    // perpendicular runs ALONG the edge: that's the axis to search and the
    // axis to slide down. Each candidate gets two rays, because a spot needs
    // BOTH halves of a ledge to be usable:
    //   - down, to confirm the top surface continues at the same height
    //     (otherwise the edge has run out, or that's a different step);
    //   - forward, to confirm there's still a wall face to hold onto
    //     (otherwise it's an outside corner and there's nothing to hang from
    //     even though the floor above continues).
    function tryCompanionShimmy(p) {
        const sx = -_hangFwd.z, sz = _hangFwd.x;
        for (let i = 0; i < COMP_SHIMMY_STEPS.length; i++) {
            const d = COMP_SHIMMY_STEPS[i];
            for (let s = 0; s < 2; s++) {
                const sign = s === 0 ? 1 : -1;
                const off = d * sign;
                const tx = _hangTop.x + sx * off, tz = _hangTop.z + sz * off;
                // Far enough along that it isn't landing on the player again.
                if (Math.hypot(tx - p.x, tz - p.z) < COMP_TOPOUT_CLEAR + 0.4) continue;
                // Hang derived from THIS spot's own lip, not the current hang
                // slid sideways - the edge can bend or set back as it runs,
                // and offsetting the old position blindly is how it ended up
                // hanging somewhere the wall isn't.
                _ledgeSpotTop.set(tx, _hangTop.y, tz);
                if (!validateLedgeSpot(_ledgeSpotTop, _hangFwd.x, _hangFwd.z, _shimmyHang)) continue;
                _shimmyTop.copy(_ledgeSpotTop);
                _shimmyFaceQuat.copy(_hangQuat);
                _compMode = 'shimmy';
                return true;
            }
        }
        return false;
    }

    // Where to hang in order to climb onto `top`, given the direction the
    // climb runs over the edge. Finds the lip by walking BACK from the top
    // point until the surface falls away, then sits just outside it.
    //
    // Computed from the ledge itself rather than reused from a recorded
    // hang_idle crumb, which is what put the companion in the wrong place:
    // the crumb search took the last hang before this moment in the trail,
    // and that can easily be a completely different ledge from an earlier
    // grab. A pose that was correct somewhere else is still the wrong place
    // here.
    function computeLedgeHang(top, fwdX, fwdZ, out) {
        let lo = 0, hi = 1.2;   // lo: known on the surface, hi: assumed past the edge
        for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) * 0.5;
            _tempVec2.set(top.x - fwdX * mid, top.y + 5.0, top.z - fwdZ * mid);
            rayDown.set(_tempVec2, _downVec);
            const hits = rayDown.intersectObjects(_compGroundList, true);
            let onSurface = false;
            for (let hh = 0; hh < hits.length; hh++) {
                if (Math.abs(hits[hh].point.y - top.y) <= 0.4) { onSurface = true; break; }
            }
            if (onSurface) lo = mid; else hi = mid;
        }
        const outset = hi + COMP_HANG_OUT;
        out.set(top.x - fwdX * outset, top.y - COMP_HANG_DROP, top.z - fwdZ * outset);
    }

    // Is `top` somewhere the companion could actually hang from, given the
    // wall runs along (fwdX, fwdZ)? Snaps top.y onto the real surface and
    // fills `outHang` with the hang position. A spot needs BOTH halves of a
    // ledge, which is why there are two rays:
    //   - down: the top surface continues at this height (otherwise the edge
    //     has run out, or that's a different step);
    //   - forward: there is still a wall face within reach to hold (otherwise
    //     it's an outside corner - floor above, nothing to grip).
    function validateLedgeSpot(top, fwdX, fwdZ, outHang) {
        _tempVec2.set(top.x, top.y + 5.0, top.z);
        rayDown.set(_tempVec2, _downVec);
        const hits = rayDown.intersectObjects(_compGroundList, true);
        let surfaceY = null;
        for (let i = 0; i < hits.length; i++) {
            if (Math.abs(hits[i].point.y - top.y) <= 0.4) { surfaceY = hits[i].point.y; break; }
        }
        if (surfaceY === null) return false;
        top.y = surfaceY;
        computeLedgeHang(top, fwdX, fwdZ, outHang);
        _ledgeFwdVec.set(fwdX, 0, fwdZ);
        _tempVec2.set(outHang.x, outHang.y + 0.4, outHang.z);
        rayFwd.set(_tempVec2, _ledgeFwdVec);
        const wallHits = rayFwd.intersectObjects(_compGroundList, true);
        return wallHits.length > 0 && wallHits[0].distance <= COMP_LEDGE_WALL_REACH;
    }

    // Squares the hang up against the wall it is actually holding, using that
    // wall's own normal.
    //
    // Before this the facing came from the direction the PLAYER happened to
    // travel while climbing (takeoff crumb -> top-out crumb), which is only
    // perpendicular to the wall if they went straight at it. Approach a ledge
    // at an angle, or turn while climbing, and the companion ends up hanging
    // skewed across the face instead of square to it - the misalignment.
    // Re-placing off the hit point also puts it a consistent distance out,
    // rather than wherever the lip search happened to land.
    function squareHangToWall() {
        _tempVec2.set(_hangPos.x, _hangPos.y + 0.4, _hangPos.z);
        rayFwd.set(_tempVec2, _hangFwd);
        const hits = rayFwd.intersectObjects(_compGroundList, true);
        if (!hits.length || hits[0].distance > COMP_LEDGE_WALL_REACH || !hits[0].face) return;
        _ledgeFwdVec.copy(hits[0].face.normal).transformDirection(hits[0].object.matrixWorld);
        _ledgeFwdVec.y = 0;
        if (_ledgeFwdVec.lengthSq() < 1e-6) return;
        _ledgeFwdVec.normalize();          // outward from the wall
        _hangFwd.set(-_ledgeFwdVec.x, 0, -_ledgeFwdVec.z);   // face into it
        _hangPos.set(
            hits[0].point.x + _ledgeFwdVec.x * COMP_HANG_OUT,
            _hangPos.y,
            hits[0].point.z + _ledgeFwdVec.z * COMP_HANG_OUT);
    }

    // Is (x,z) already taken, at this height, by the player or by another
    // companion? Measured against everyone's actual position rather than
    // against their recorded hang spot: a companion hanging IS at its grip, so
    // one test covers hanging, climbing and standing at the lip alike.
    function hangSpotTaken(x, z, y, p) {
        // Height-gated throughout: two companions on ledges one above the
        // other are not sharing a grip, and pushing them apart there would
        // send one shimmying off along a ledge for no reason.
        const clashes = (ox, oy, oz) =>
            Math.abs(oy - y) < COMP_LEDGE_SEP_DY && Math.hypot(x - ox, z - oz) < COMP_LEDGE_MIN_SEP;
        // The player counts only if it is actually ON the ledge. Its raw
        // position was being tested with the same generous height window as a
        // grip, and a grip sits 1.85 below its lip - so on a 3-unit wall a
        // player STANDING AT THE BOTTOM was 1.15 from the grip in y, inside
        // the window, and blocked the grab from below.
        if (window.playerIsLedgeGrabbing && clashes(p.x, p.y, p.z)) return true;
        for (let i = 0; i < companions.length; i++) {
            const rec = companions[i];
            if (rec.comp === companion) continue;
            // ONLY companions actually on, or committed to, a ledge. Testing
            // raw positions here is what deadlocked two of them at the foot of
            // a wall: each saw the other standing a metre away, decided the
            // grip was taken, and waited - symmetrically, forever, neither
            // ever climbing. Standing near a wall is not holding it.
            if (rec.mode === 'leap' && rec.leapToHang) {
                if (clashes(rec.leapEnd.x, rec.leapEnd.y, rec.leapEnd.z)) return true;
            } else if (rec.mode === 'hang' || rec.mode === 'shimmy') {
                if (clashes(rec.hangPos.x, rec.hangPos.y, rec.hangPos.z)) return true;
            } else if (rec.mode === 'climbup') {
                if (clashes(rec.climbTo.x, rec.climbTo.y, rec.climbTo.z)) return true;
                // ...and where it physically is while the clip plays, since
                // that is on the ledge too.
                const op = rec.comp.group.position;
                if (clashes(op.x, op.y, op.z)) return true;
            }
        }
        return false;
    }

    // Slides the hang along the ledge until it is not on top of anyone else.
    // Two bodies cannot share one grip, and the top-out clearance test says
    // nothing about where the companion HANGS - only where it would end up
    // standing - so nothing was stopping it grabbing on right where someone
    // already was.
    function nudgeHangClear(p) {
        if (!hangSpotTaken(_hangPos.x, _hangPos.z, _hangPos.y, p)) return true;
        const sx = -_hangFwd.z, sz = _hangFwd.x;
        for (let i = 0; i < COMP_SHIMMY_STEPS.length; i++) {
            for (let s = 0; s < 2; s++) {
                const off = COMP_SHIMMY_STEPS[i] * (s === 0 ? 1 : -1);
                _ledgeSpotTop.set(_hangTop.x + sx * off, _hangTop.y, _hangTop.z + sz * off);
                // Validate FIRST, then test the grip it would actually produce
                // - the top point and the hang hang half a body apart, and it
                // is the grip that has to be clear, not the lip above it.
                if (!validateLedgeSpot(_ledgeSpotTop, _hangFwd.x, _hangFwd.z, _shimmyHang)) continue;
                if (hangSpotTaken(_shimmyHang.x, _shimmyHang.z, _shimmyHang.y, p)) continue;
                _hangTop.copy(_ledgeSpotTop);
                _hangPos.copy(_shimmyHang);
                return true;
            }
        }
        // Every spot along this ledge is occupied. The caller decides what to
        // do about it - grabbing on regardless is the one thing it must not do.
        return false;
    }

    // Climb from the current hang onto `target`, the way the player does it:
    // root held still while the climb clip plays, then placed on the ledge.
    function startCompanionLedgeClimb(c, target, fwdX, fwdZ) {
        // Where the model sits on its root normally - captured now so the
        // post-climb offset below has something to decay back to.
        if (companion.fbxModel && _climbBlendT <= 0) _climbModelRest.copy(companion.fbxModel.position);
        _climbFrom.copy(c);
        _climbTo.set(target.x + fwdX * COMP_CLIMB_STAND_IN, target.y, target.z + fwdZ * COMP_CLIMB_STAND_IN);
        _compFaceEuler.set(0, Math.atan2(fwdX, fwdZ), 0);
        _climbQuat.setFromEuler(_compFaceEuler);
        const climbAction = companion.actions && companion.actions['climb'];
        _climbDur = climbAction ? climbAction.getClip().duration : 1.0;
        _climbT = 0;
        _compMode = 'climbup';
    }

    // Picks the companion's idle/walk/run clip from its actual closing
    // speed toward wherever it's headed this frame (follow spot or replay
    // takeoff point) - smoothed first, then run through hysteresis, instead
    // of a bare "speed > threshold" comparison. Two separate fixes for the
    // same symptom (the clip stuttering between idle/walk/run):
    //   - the low-pass filter removes the frame-to-frame speed noise that's
    //     inherent to closing a shrinking gap (the companion is essentially
    //     always accelerating or decelerating, rarely at a flat speed), so
    //     the value reaching the thresholds is stable rather than jittery;
    //   - hysteresis (a lower exit threshold than the enter threshold)
    //     means a speed that settles right at the boundary can't flicker
    //     the clip back and forth every frame - it has to cross the gap
    //     between enter and exit, not just cross one line, to switch again.
    const COMP_RUN_ENTER = 3.5, COMP_RUN_EXIT = 2.8;
    const COMP_WALK_ENTER = 0.4, COMP_WALK_EXIT = 0.15;
    function companionLocoState(rawSpeed, delta) {
        const smoothT = Math.min(1, delta * 10);
        _compSpeedSmooth += (rawSpeed - _compSpeedSmooth) * smoothT;
        if (_compLocoState === 'run') {
            if (_compSpeedSmooth < COMP_RUN_EXIT) _compLocoState = _compSpeedSmooth > COMP_WALK_EXIT ? 'walk' : 'idle';
        } else if (_compLocoState === 'walk') {
            if (_compSpeedSmooth > COMP_RUN_ENTER) _compLocoState = 'run';
            else if (_compSpeedSmooth < COMP_WALK_EXIT) _compLocoState = 'idle';
        } else {
            if (_compSpeedSmooth > COMP_RUN_ENTER) _compLocoState = 'run';
            else if (_compSpeedSmooth > COMP_WALK_ENTER) _compLocoState = 'walk';
        }
        return _compLocoState;
    }

    // Steers the companion around solid obstacles on its way to destTarget,
    // the same technique moveAiBotToward already uses for the AI bot (try
    // the direct line first, then increasingly wide angles, testing a
    // 3-ray bundle - center plus two sideways offsets - so a clear
    // centerline that still grazes an obstacle's edge doesn't count as
    // clear). Kept as its own copy rather than sharing moveAiBotToward
    // directly - that function is wound tightly around aiBotState (its own
    // avoid-side persistence, its own setNetworkState calls) and threading
    // the companion through it would mean more special-casing than just
    // repeating the steering loop here.
    //
    // Before this, the companion's FOLLOW/pre-replay movement had no
    // horizontal obstacle check at all - only the vertical ground-follow
    // below existed, and that only handles standing ON TOP of something
    // (or falling below it). A box taller than that vertical step's own
    // 0.9 cap never triggered the step-up, so the companion just walked
    // straight into the box's side and stayed there, horizontally embedded
    // in it, since nothing ever stopped nx/nz from landing inside its
    // footprint.
    //
    // Returns a unit direction to move along this frame, or null if truly
    // stuck (see COMP_STEER_HOLD below) - callers should just hold position
    // for the frame rather than clip through in that case.
    //
    // The direct line to destTarget is tried FIRST and, if clear, returned
    // RAW - not smoothed, not held. That matters: callers cap their step by
    // Math.min(remainingDistance, speed*delta), which only lands exactly ON
    // the target (and therefore actually stops there) if the direction used
    // is the true direction to that target. Smoothing was tried for this
    // common case too and broke exactly that: destTarget is recomputed
    // fresh every frame (the follow spot moves as the player does, even
    // idle micro-adjustments shift it slightly), so a direction lagging
    // behind it via a lerp perpetually overshot, corrected, overshot again
    // - the companion never actually stopped, it endlessly circled its own
    // target, and since its facing is separately locked to "face the
    // player" while its movement circled around some other point, that
    // circling read as constant aimless wandering/strafing.
    //
    // Only once the direct line is genuinely blocked does the widened-angle
    // search kick in, and only THAT result gets smoothed + given a brief
    // hold - the case it actually targets (see the comments below).
    let _compAvoidSide = 0;
    let _compSteerDirSmooth = new THREE.Vector3();
    let _compSteerDirValid = false;
    let _compSteerBlockedFor = 0;
    const COMP_STEER_HOLD = 0.12;
    // Tests a 3-ray bundle (centerline plus two sideways offsets, so a
    // clear centerline that still grazes an obstacle's edge doesn't count
    // as clear) along `dir` from `rayOrigin`.
    function companionRayClear(rayOrigin, dir) {
        _aiAvoidPerp.set(-dir.z, 0, dir.x);
        for (const sideMul of [0, 1, -1]) {
            _aiAvoidSideOrigin.copy(rayOrigin);
            if (sideMul !== 0) _aiAvoidSideOrigin.addScaledVector(_aiAvoidPerp, sideMul * AI_AVOID_RADIUS);
            rayFwd.set(_aiAvoidSideOrigin, dir);
            const hits = rayFwd.intersectObjects(collidables);
            if (hits.length > 0 && hits[0].distance <= AI_AVOID_LOOKAHEAD) return false;
        }
        return true;
    }
    function companionSteerDir(pos, destTarget, delta) {
        const toTarget = _tempVec1.set(destTarget.x - pos.x, 0, destTarget.z - pos.z);
        if (toTarget.lengthSq() < 1e-6) { _compSteerDirValid = false; return null; }
        toTarget.normalize();
        const rayOrigin = _tempVec2.copy(pos).setY(pos.y + 0.5);

        if (companionRayClear(rayOrigin, toTarget)) {
            _compAvoidSide = 0;
            _compSteerDirValid = false;
            _compSteerBlockedFor = 0;
            return toTarget.clone();
        }

        // Blocked straight on - widen the angle. This IS the case the
        // smoothing/hold below is for: going around a large obstacle, the
        // winning angle can jump between e.g. +25deg and +100deg frame to
        // frame (both "the same side" per _compAvoidSide, but a
        // discontinuous direction change each time), and right at a corner
        // the ray bundle can graze the edge on one frame and clear the next
        // as position shifts by a hair - a momentary "nothing found" that
        // isn't actually a dead end.
        const angleOrder = _compAvoidSide < 0 ? AI_AVOID_ANGLES_LEFT_FIRST : AI_AVOID_ANGLES_RIGHT_FIRST;
        let found = null;
        for (const angleDeg of angleOrder) {
            if (angleDeg === 0) continue; // already tried above
            const candidate = _tempQuat.setFromAxisAngle(_upVec, angleDeg * Math.PI / 180);
            _tempVec3.copy(toTarget).applyQuaternion(candidate);
            if (companionRayClear(rayOrigin, _tempVec3)) { found = _tempVec3.clone(); _compAvoidSide = Math.sign(angleDeg); break; }
        }
        if (found) {
            _compSteerBlockedFor = 0;
            if (!_compSteerDirValid) { _compSteerDirSmooth.copy(found); _compSteerDirValid = true; }
            else _compSteerDirSmooth.lerp(found, Math.min(1, delta * 8)).normalize();
            return _compSteerDirSmooth.clone();
        }
        _compSteerBlockedFor += delta;
        if (_compSteerDirValid && _compSteerBlockedFor < COMP_STEER_HOLD) return _compSteerDirSmooth.clone();
        _compAvoidSide = 0;
        _compSteerDirValid = false;
        return null;
    }

    // ---- Head size ----
    // Scales the head BONE, so it carries the whole head through animation
    // (and its children - hair, anything parented above the neck) rather than
    // being a mesh-level trick that the skinning would fight.
    //
    // Reapplied every frame rather than set once on change: the animation
    // mixer rewrites bone transforms each update, and although the clips in
    // use only animate rotation (and hip position), that is a property of
    // these particular clips and not a guarantee. Writing it after the
    // avatars have updated costs a handful of assignments and cannot be
    // silently undone by a clip that does carry a scale track.
    window.headScale = 0.7;
    function getHeadBone(avatar) {
        if (!avatar || !avatar.fbxModel) return null;
        if (avatar._headBone !== undefined) return avatar._headBone;
        let found = null;
        // Same match the rigs' own findBone uses, so this picks the identical
        // bone their ragdoll/IK setups do.
        avatar.fbxModel.traverse(o => {
            if (!found && o.isBone && o.name.toLowerCase().includes('head')) found = o;
        });
        avatar._headBone = found;   // cached, including a null result
        return found;
    }
    function applyHeadScale() {
        const s = window.headScale;
        const set = (a) => { const b = getHeadBone(a); if (b) b.scale.setScalar(s); };
        set(char);
        companions.forEach(r => set(r.comp));
        aiBots.forEach(r => set(r.bot));
        if (window.multiplayerClient && window.multiplayerClient.remotes) {
            window.multiplayerClient.remotes.forEach(set);
        }
    }

    // Records the player's pose + anim state into the trail. Its own function,
    // called unconditionally from the frame loop, because the trail is no
    // longer just the companion's: the AI bot reads it too, to find where the
    // player left its level (findTakeoffApproach). It used to live inside
    // updateCompanion, below the companionEnabled early-out, which meant
    // switching the companion off silently took the bot's ability to follow
    // anyone upstairs with it.
    //
    // Uses the player's VISUAL position (fbxModel world pos), not the raw
    // group: at the climb-end the group SNAPS to ledgeTarget while the model
    // is offset back to hide it (see the isClimbingUp transition) - recording
    // the compensated visual replays that SMOOTH climb-out instead of the raw
    // root snap.
    function recordPlayerTrail(delta) {
        const q = char.group.quaternion;
        if (char.fbxModel) char.fbxModel.getWorldPosition(_compVisPos); else _compVisPos.copy(char.group.position);
        _compTrailT += delta;
        const last = _compTrail.length ? _compTrail[_compTrail.length - 1] : null;
        if (last && Math.hypot(_compVisPos.x - last.x, _compVisPos.y - last.y, _compVisPos.z - last.z) > 5) _compTrail.length = 0; // teleport → reset
        _compTrail.push({ t: _compTrailT, x: _compVisPos.x, y: _compVisPos.y, z: _compVisPos.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, state: networkStateName });
        while (_compTrail.length > 2 && (_compTrailT - _compTrail[0].t) > COMP_TRAIL_KEEP) _compTrail.shift();
    }

    // On-screen readout of what the companion thinks it is doing. Off unless
    // window._compDebug is set from the console.
    //
    // Worth having because "it is stuck" is the same picture for several
    // completely different causes - deliberately holding a ledge, walking at
    // an unreachable takeoff, every movement branch declining - and they need
    // opposite fixes. Guessing between them from a screenshot has not worked.
    function companionDebugReport(c, p) {
        // One panel per companion, stacked - a shared id had the two of them
        // overwriting each other's readout every frame.
        const panelId = 'companion-debug-' + companion.id;
        let el = document.getElementById(panelId);
        if (!el) {
            el = document.createElement('div');
            el.id = panelId;
            const slot = companions.findIndex(r => r.comp === companion);
            el.style.cssText = 'position:fixed;top:' + Math.max(0, slot) * 130 + 'px;right:0;background:rgba(0,0,0,.85);color:#6cf;font:12px monospace;padding:8px;z-index:99999;white-space:pre;text-align:left;';
            document.body.appendChild(el);
        }
        const takeoff = findTakeoffApproach(c);
        const dTk = takeoff ? Math.hypot(takeoff.at.x - c.x, takeoff.at.z - c.z) : -1;
        el.textContent = [
            companion.id + (_compCharge ? '   charge' : _compFullCombo ? '   full combo' : '   combo x' + _compPunchCount)
                + (_compAttackCD > 0 ? '  cd ' + _compAttackCD.toFixed(1) : ''),
            'mode    ' + _compMode,
            'why     ' + _compWhy,
            'dPlayer ' + Math.hypot(p.x - c.x, p.z - c.z).toFixed(2) + '  dY ' + (p.y - c.y).toFixed(2),
            'takeoff ' + (takeoff ? ('d=' + dTk.toFixed(2) + (dTk > COMP_TAKEOFF_PREFER_DIST ? ' (far)' : ' (near)')) : 'none'),
            'trail   ' + _compTrail.length + ' crumbs',
            'stuck   ' + _compStuckT.toFixed(1) + 's' + (_compUnstickT > 0 ? '  UNSTICKING' : '')
        ].join('\n');
    }

    // Drives ONE companion - whichever activateCompanion last pointed the
    // module bindings at. updateCompanions is the entry point.
    function updateCompanion(delta) {
        if (!companion) return;
        if (!companion.isLoaded) { companion.update(delta); return; }
        companion.group.visible = true;
        if (companion.isRagdoll || companion.isStandingUp) {
            // Ragdoll drives the bones directly - leaving a model offset in
            // place would displace the whole ragdoll. Drop it immediately.
            if (_climbBlendT > 0 && companion.fbxModel) { companion.fbxModel.position.copy(_climbModelRest); _climbBlendT = 0; }
            companion.update(delta);
            return;
        }
        // Settle the model back onto its root after a climb. Runs before the
        // mode dispatch so it keeps decaying whatever the companion goes on
        // to do next - the climb is already over by the time this matters.
        if (_climbBlendT > 0 && companion.fbxModel) {
            _climbBlendT -= delta;
            if (_climbBlendT <= 0) companion.fbxModel.position.copy(_climbModelRest);
            else companion.fbxModel.position.lerp(_climbModelRest, Math.min(1, delta / _climbBlendT));
        }

        // Ground-cast list for this frame's rays.
        _compGroundList.length = 0;
        for (let i = 0; i < collidables.length; i++) _compGroundList.push(collidables[i]);
        _compGroundList.push(ground);

        const p = char.group.position, q = char.group.quaternion;
        const c = companion.group.position;

        // ---- Hit recovery ----
        // Being punched has to interrupt whatever it was doing. Without this
        // the follow logic kept running straight through the hit: the
        // companion would be knocked back and, in the same breath, start
        // walking to reclaim its spot behind the player - which reads as it
        // not having noticed being hit at all.
        //
        // Two stages. First the stagger itself, stepping in the direction of
        // the blow (the fields RagdollPhysics.applyProceduralRecoil already
        // populates). Then a short settle where it stands and collects itself
        // before it is willing to go anywhere - that pause is the part that
        // makes the hit land, and it is why this is not just a movement lock.
        const compHitRecoveryDuration = window.hitRecoveryDuration !== undefined ? window.hitRecoveryDuration : 0.35;
        if (companion.hitRecoveryTimer > 0 && companion.hitRecoveryTimer <= compHitRecoveryDuration) {
            _compWhy = 'staggering';
            _compMode = 'follow';        // abandon any route it was mid-way through
            // Roll for a counter-attack ONCE per hit, not once per frame of
            // the stagger. _compRecoverT is only ever 0 here on the first
            // frame of a new one - every later frame of the same stagger has
            // already re-armed it on the line below.
            if (_compRecoverT <= 0) _compRetaliate = Math.random() < _compRetaliateChance;
            _compRecoverT = COMP_RECOVER_SETTLE;
            _compHitSettled = true;      // hold wherever this leaves it, if that spot is fine
            _compStuckT = 0; _compStuckAt.copy(c);   // not stuck, just hurt
            const recoveryStepSpeed = window.recoveryStepSpeed || 3.5;
            const strengthMult = THREE.MathUtils.clamp(companion.hitRecoveryStrength / 12.0, 0.5, window.recoveryStrengthMultMax || 2.0);
            const stepSpeed = recoveryStepSpeed * strengthMult * Math.min(1, companion.hitRecoveryTimer / compHitRecoveryDuration);
            const rx = c.x + companion.hitRecoveryDir.x * stepSpeed * delta;
            const rz = c.z + companion.hitRecoveryDir.z * stepSpeed * delta;
            const rgy = companionGroundY(rx, rz, c.y);
            let ry = c.y;
            // FALL to the ground, do not snap to it. The old test was
            // `rgy - c.y <= COMP_STEP_UP`, which a companion hit in mid-air
            // passes trivially - the ground is far BELOW, so the difference is
            // hugely negative - and it teleported straight down. Punch it
            // off a wall it was climbing and it did not get knocked off, it
            // vanished to the floor, restarting the whole route. Combined
            // with the bot now hunting it, that made getting anywhere upward
            // nearly impossible.
            if (rgy < c.y - 0.05) ry += Math.max(rgy - c.y, -16 * delta);
            else if (rgy > c.y + 0.05 && rgy - c.y <= COMP_STEP_UP) ry = rgy;
            companion.group.position.set(rx, ry, rz);
            companion.setNetworkState([rx, ry, rz], [companion.group.quaternion.x, companion.group.quaternion.y, companion.group.quaternion.z, companion.group.quaternion.w], 'walk', false);
            companion.update(delta);
            return;
        }
        if (_compRecoverT > 0) {
            _compRecoverT -= delta;
            _compWhy = 'recovering';
            _compStuckT = 0; _compStuckAt.copy(c);
            // Still falls if it was knocked somewhere with nothing under it -
            // collecting itself should not mean hanging in the air.
            const rgy = companionGroundY(c.x, c.z, c.y);
            let ry = c.y;
            if (rgy < c.y - 0.05) ry += Math.max(rgy - c.y, -16 * delta);
            else if (rgy > c.y + 0.05 && rgy - c.y <= COMP_STEP_UP) ry = rgy;
            _compFaceEuler.set(0, Math.atan2(p.x - c.x, p.z - c.z), 0);
            _compFaceQuat.setFromEuler(_compFaceEuler);
            companion.group.position.set(c.x, ry, c.z);
            companion.setNetworkState([c.x, ry, c.z], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], companionLocoState(0, delta), false);
            companion.update(delta);
            return;
        }

        if (_compAttackCD > 0) _compAttackCD -= delta;
        // Nearest bot worth swinging at, within `range`.
        const nearestBot = (range) => {
            let best = null, bestD = range;
            for (let i = 0; i < aiBots.length; i++) {
                const b = aiBots[i].bot;
                if (!b.isLoaded || b.isRagdoll || b.isStandingUp) continue;
                const d = c.distanceTo(b.group.position);
                if (d < bestD) { bestD = d; best = b; }
            }
            return best;
        };
        const startAttack = (target) => {
            _compPunchTarget = target;
            _compPunchT = 0;
            _compPunchIndex = 0;
            _compAttackCD = _compCharge ? COMP_CHARGE_COOLDOWN : COMP_ATTACK_COOLDOWN;
        };
        // Whether it is free to start swinging at anything at all.
        //
        // 'follow' specifically, not just "not busy": this block sits ahead of
        // the mode dispatch, so without it a companion breaks off a climb, a
        // ledge hang or a breadcrumb replay to throw punches - and an attack
        // holds it still, which mid-route is how it ends up stranded.
        //
        // _compJustClimbedT matters just as much, and is the subtler half. A
        // climb ends by setting mode back to 'follow' the instant the clip
        // finishes, while the companion is still standing right on the lip. An
        // attack starting on that frame pins it there and runs its own ground
        // scan, and at the lip that scan can just as easily find the level
        // BELOW - so it drops off the ledge it has only just climbed. That is
        // the "gets to the top and goes back down" case. The post-climb hold
        // already exists to stop it leaping or walking back down; this puts
        // punching under the same rule.
        const canStartAttack = _compMode === 'follow' && _compJustClimbedT <= 0;
        // Counter-attack, once the stagger and the settle are both over - the
        // hit has to visibly land before the answer to it does.
        //
        // The flag is left ARMED while it cannot act rather than being
        // consumed and dropped: punched off a wall halfway up, a companion
        // should still hit back when it gets there, not forget it was hit.
        if (_compRetaliate && canStartAttack) {
            _compRetaliate = false;
            const hitBack = nearestBot(COMP_PUNCH_SEEK);
            if (hitBack) startAttack(hitBack);
        }
        // ...and they no longer WAIT to be hit. A bot that wanders into reach
        // gets swung at on its own - but never at the cost of finishing a
        // climb, per the gate above.
        if (!_compPunchTarget && _compAttackCD <= 0 && canStartAttack) {
            const prey = nearestBot(COMP_ATTACK_SEEK);
            if (prey) startAttack(prey);
        }
        if (_compPunchTarget) {
            // Whoever it started swinging at, held for the whole combo - so it
            // does not pivot mid-string to face a bot that wandered closer.
            const tp = _compPunchTarget.group.position;
            _compPunchT += delta;
            _compFaceEuler.set(0, Math.atan2(tp.x - c.x, tp.z - c.z), 0);
            _compFaceQuat.setFromEuler(_compFaceEuler);
            // The REAL combo clip when this companion has one - Punch_Combo.fbx,
            // the same five-hit string the player and the orange bot throw, on
            // its own hit frames. The alternating left/right jabs below are the
            // fallback for a companion without the clip (and what the short
            // two-hit counter still uses).
            const comboAction = _compFullCombo && companion.actions && companion.actions['punch_combo'];
            const comboDur = comboAction ? comboAction.getClip().duration : 0;
            const chargeAction = _compCharge && companion.actions && companion.actions['punch_charge_punch'];
            const hitCount = chargeAction ? 1
                : comboAction ? AI_COMBO_HIT_TIMES.length : _compPunchCount;
            // Total poise the whole string is worth, split evenly across it.
            // Held at COMP_PUNCH_TOTAL_POISE whatever the hit count, so the
            // full five-hit combo is a longer, better-looking attack rather
            // than a straight damage upgrade - five hits at the flat 'medium'
            // 10 would be 50, half a bot's pool from one companion.
            // The charge is the exception: it is ONE hit and it is meant to
            // put a bot down, so it ignores the shared budget entirely.
            const poisePerHit = COMP_PUNCH_TOTAL_POISE / hitCount;
            const hitT = window.punchHitTime !== undefined ? window.punchHitTime : 0.42;
            // Where in this attack's own timeline each hit lands.
            const hitAt = (i) => chargeAction
                ? COMP_CHARGE_HOLD + COMP_CHARGE_SWING * COMP_CHARGE_HIT_T
                : comboAction ? AI_COMBO_HIT_TIMES[i] * comboDur
                : (i + hitT) * COMP_PUNCH_SWING;
            const totalDur = chargeAction ? COMP_CHARGE_HOLD + COMP_CHARGE_SWING
                : comboAction ? comboDur : hitCount * COMP_PUNCH_SWING;
            // Fire every hit frame this step crossed. A long frame can span a
            // whole swing, and skipping it would silently drop a punch.
            while (_compPunchIndex < hitCount && _compPunchT >= hitAt(_compPunchIndex)) {
                const i = _compPunchIndex++;
                const target = _compPunchTarget;
                // Re-checked per swing: a combo takes most of a second and the
                // bot can ragdoll, be knocked back or walk off partway through.
                if (target.isLoaded && !target.isRagdoll &&
                    c.distanceTo(target.group.position) < COMP_PUNCH_RANGE) {
                    // Last swing carries visible weight - more knockback, a
                    // brighter flash - but the same poise cost as the rest.
                    // Companions are meant to contribute to a fight, not win it
                    // while you watch: with the pool regenerating 20/s after a
                    // 2.5s gap, a 30-point string cannot grind a bot down on
                    // its own between your hits.
                    const last = i === hitCount - 1;
                    const vel = _tempVec2.set(tp.x - c.x, 0, tp.z - c.z).normalize()
                        .multiplyScalar(chargeAction ? COMP_CHARGE_FORCE
                            : last ? COMP_PUNCH_FORCE * 1.7 : COMP_PUNCH_FORCE);
                    const hitPoint = tp.clone().setY(tp.y + 1.2);
                    if (chargeAction) {
                        // Knocks down outright, like every other charge punch
                        // in the game. Affordable because it is rare: a long
                        // wind-up, a long cooldown, and a companion cannot
                        // chase - it follows the player, so it only ever gets
                        // the chance when a bot comes to it.
                        window.staggerBot(target, vel, 'high', 2.5);
                    } else {
                        window.staggerBot(target, vel, 'medium', last ? 1.3 : 0.9, poisePerHit);
                    }
                    if (window.createHandHitEffect) window.createHandHitEffect(hitPoint);
                    if (window.spawnHitEffect) window.spawnHitEffect(hitPoint.clone());
                }
            }
            if (_compPunchT >= totalDur) {
                _compPunchTarget = null;
                _compPunchT = -1;
            } else {
                // Stationary, feet planted - it is throwing punches, not
                // walking. Ground height still tracked so it does not hang in
                // the air if it was knocked off something.
                const pgy = companionGroundY(c.x, c.z, c.y);
                let py = c.y;
                if (pgy < c.y - 0.05) py += Math.max(pgy - c.y, -16 * delta);
                else if (pgy > c.y + 0.05 && pgy - c.y <= COMP_STEP_UP) py = pgy;
                companion.group.position.set(c.x, py, c.z);
                let swingAnim;
                if (chargeAction) {
                    // Wind-up, then the swing - the same two-clip shape the
                    // player and the red bot use. COMP_CHARGE_HOLD is
                    // deliberately SHORTER than the hold clip: RemoteAvatar
                    // spawns a charge projectile when that clip reaches its
                    // last frame, and a companion firing one would land a
                    // second, uncontrolled knockdown on top of this one.
                    // Stopping short leaves the wind-up read intact without it.
                    swingAnim = _compPunchT < COMP_CHARGE_HOLD ? 'punch_charge_hold' : 'punch_charge_punch';
                } else if (comboAction) {
                    // One clip, held for its whole natural duration - it plays
                    // at its authored speed, which is what makes it read as
                    // the same combo the player throws.
                    swingAnim = 'punch_combo';
                } else {
                    const swing = Math.floor(_compPunchT / COMP_PUNCH_SWING);
                    swingAnim = swing % 2 === 0 ? 'punch_left' : 'punch_right';
                    // Rate-match the clip to the slot it has to fit in. The
                    // punch clips run about a second each; at their own speed a
                    // string would take that long per hit and only the first
                    // 40% of each swing would be seen before the next restarted
                    // it. Same trick the bot's run cycle uses to stop its feet
                    // skating.
                    const swingAction = companion.actions && companion.actions[swingAnim];
                    if (swingAction) {
                        swingAction.timeScale = THREE.MathUtils.clamp(
                            swingAction.getClip().duration / COMP_PUNCH_SWING, 0.5, 3.0);
                    }
                }
                companion.setNetworkState([c.x, py, c.z],
                    [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w],
                    swingAnim, false);
                companion.update(delta);
                _compWhy = 'punching ' + _compPunchIndex + '/' + hitCount;
                _compStuckT = 0; _compStuckAt.copy(c);
                return;
            }
        }

        if (_compJustClimbedT > 0) _compJustClimbedT -= delta;
        if (_compLedgeWaitT > 0) {
            _compLedgeWaitT -= delta;
            // Standing in a queue is not being stuck. Without this the
            // progress watchdog reads a waiting companion as wedged and sends
            // it off to wander, which is the opposite of holding its place.
            _compStuckT = 0; _compStuckAt.copy(c);
        }

        // Progress watchdog - see _compStuckAt. Measured on the real position,
        // so it catches a deadlock whichever rule caused it. Only counts while
        // there is somewhere to be: standing still next to the player is not
        // being stuck, and the deliberate holds (hanging, climbing, mid-leap)
        // are not either.
        const farFromPlayer = Math.hypot(p.x - c.x, p.z - c.z) > _compFollowDist + 0.8 || Math.abs(p.y - c.y) > 1.0;
        const shouldBeMoving = farFromPlayer && (_compMode === 'follow' || _compMode === 'replay');
        if (c.distanceToSquared(_compStuckAt) > COMP_STUCK_DIST * COMP_STUCK_DIST) {
            _compStuckAt.copy(c); _compStuckT = 0;
        } else if (shouldBeMoving && _compUnstickT <= 0) {
            _compStuckT += delta;
            if (_compStuckT > COMP_STUCK_TIME) {
                // Break the symmetry: sidestep perpendicular to the player for
                // a moment. Which side does not matter, only that it is not
                // the direction that is jammed.
                _compUnstickDir.set(-(p.z - c.z), 0, p.x - c.x);
                if (_compUnstickDir.lengthSq() < 1e-6) _compUnstickDir.set(1, 0, 0);
                _compUnstickDir.normalize();
                if (Math.random() < 0.5) _compUnstickDir.negate();
                _compUnstickT = COMP_UNSTICK_TIME;
                _compStuckT = 0;
                _compMode = 'follow';
                _compStuckAt.copy(c);
            }
        } else {
            _compStuckT = 0;
        }
        if (window._compDebug) companionDebugReport(c, p);

        const gy = companionGroundY(c.x, c.z, c.y);
        const playerElevated = isGrounded && !isLedgeGrabbing && !isClimbingUp && (p.y - gy) > 1.0;

        // ---- LEAP (a jump: across a gap, or up to catch a ledge) ----
        // Only ever a jump now. There used to be a second "mantle" arc here
        // that rose straight onto a ledge top, which is the move that read as
        // flying - nothing in this game ascends like that. Getting onto a wall
        // is a jump to a hang (startCompanionJumpGrab) followed by a climb
        // (CLIMBUP), and both of those are real moves the player also has.
        if (_compMode === 'leap') {
            _compLeapT += delta;
            const t = Math.min(1, _compLeapT / _compLeapDur);
            const lx = THREE.MathUtils.lerp(_compLeapStart.x, _compLeapEnd.x, t);
            const lz = THREE.MathUtils.lerp(_compLeapStart.z, _compLeapEnd.z, t);
            // Parabolic bump on top of the straight launch->landing height
            // lerp, peaking at t=0.5 - 4*t*(1-t) is 0 at t=0/1 and 1 at t=0.5.
            const ly = THREE.MathUtils.lerp(_compLeapStart.y, _compLeapEnd.y, t) + COMP_LEAP_ARC_HEIGHT * 4 * t * (1 - t);
            // jump_start is a short one-shot push-off, fall loops through the
            // airborne middle, land is a one-shot touchdown right at the end -
            // same three clips a real jump already uses elsewhere. A jump that
            // ends by catching a ledge finishes on hang_idle instead: it never
            // lands on anything.
            let leapState;
            if (t >= 1) leapState = _compLeapToHang ? 'hang_idle' : 'land';
            else if (_compLeapT < 0.18) leapState = 'jump_start';
            else leapState = 'fall';
            companion.group.position.set(lx, ly, lz);
            companion.setNetworkState([lx, ly, lz], [_compLeapFaceQuat.x, _compLeapFaceQuat.y, _compLeapFaceQuat.z, _compLeapFaceQuat.w], leapState, false);
            companion.update(delta);
            if (t >= 1) {
                // Catching a ledge hands over to HANG, which then decides
                // between holding on, shuffling along, and climbing up.
                _compMode = _compLeapToHang ? 'hang' : 'follow';
                // A leap that ENDED HIGHER is a hop onto something, and it
                // leaves the companion on a lip exactly like a full climb
                // does. It gets the same post-climb hold, so nothing - a
                // separation nudge, an attack, a leap back down - can knock it
                // off in the moment it lands. Landing level or lower is just
                // crossing a gap and needs no such protection.
                if (!_compLeapToHang && _compLeapEnd.y > _compLeapStart.y + 0.3) {
                    _compJustClimbedT = COMP_POST_CLIMB_HOLD;
                }
                _compLeapToHang = false;
            }
            return;
        }

        // ---- SHIMMY (sidestep along a ledge to a clear top-out) ----
        // Slides the hang along the edge, then climbs at the far end.
        if (_compMode === 'shimmy') {
            const sdx = _shimmyHang.x - c.x, sdz = _shimmyHang.z - c.z;
            const sd = Math.hypot(sdx, sdz);
            if (sd > 0.12) {
                const step = Math.min(sd, COMP_SHIMMY_SPEED * delta);
                const nx = c.x + sdx / sd * step, nz = c.z + sdz / sd * step;
                companion.group.position.set(nx, _shimmyHang.y, nz);
                companion.group.quaternion.copy(_shimmyFaceQuat);
                // Which way along the wall it is sliding, in its own frame, so
                // the real shimmy clip plays rather than the idle hang being
                // dragged sideways. +X local is its right.
                _ledgeFwdVec.set(1, 0, 0).applyQuaternion(_shimmyFaceQuat);
                const alongRight = sdx * _ledgeFwdVec.x + sdz * _ledgeFwdVec.z;
                companion.setNetworkState([nx, _shimmyHang.y, nz], [_shimmyFaceQuat.x, _shimmyFaceQuat.y, _shimmyFaceQuat.z, _shimmyFaceQuat.w], alongRight > 0 ? 'hang_right' : 'hang_left', false);
                companion.update(delta);
                return;
            }
            // Arrived alongside the clear spot - now the climb, same as the
            // player's: hold the root, play the clip, place it at the end.
            startCompanionLedgeClimb(c, _shimmyTop, _hangFwd.x, _hangFwd.z);
            return;
        }

        // ---- CLIMBUP (pulling onto a ledge from a hang) ----
        if (_compMode === 'climbup') {
            _climbT += delta;
            // Root stays put for the whole clip and is placed once at the
            // end - the clip carries the body up, the root move just commits
            // it.
            const done = _climbT >= _climbDur;
            const pos = done ? _climbTo : _climbFrom;
            companion.group.position.copy(pos);
            companion.group.quaternion.copy(_climbQuat);
            if (done && companion.fbxModel) {
                // The pop. By the end of the clip the body is already stood on
                // the ledge - the animation put it there - so moving the root
                // up as well applies that same rise a second time and the
                // companion visibly jumps.
                //
                // Same fix the player uses (see the isClimbingUp transition):
                // shift the MODEL back by exactly what the root just gained,
                // which cancels the jump outright, then let that offset decay
                // so the model settles onto its root over a few frames. Local
                // space, since fbxModel is a child of the group.
                _climbMoveDiff.copy(_climbTo).sub(_climbFrom);
                _climbTmpQuat.copy(_climbQuat).invert();
                _climbMoveDiff.applyQuaternion(_climbTmpQuat);
                companion.fbxModel.position.sub(_climbMoveDiff);
                _climbBlendT = COMP_CLIMB_BLEND;
            }
            companion.setNetworkState([pos.x, pos.y, pos.z], [_climbQuat.x, _climbQuat.y, _climbQuat.z, _climbQuat.w], done ? 'idle' : 'climb', false);
            companion.update(delta);
            if (done) { _compMode = 'follow'; _compJustClimbedT = COMP_POST_CLIMB_HOLD; }
            return;
        }

        // ---- HANG (holding a ledge whose top-out is occupied) ----
        // Committed state, entered from the replay. It does three things in
        // priority order every frame and nothing else, so there is no way for
        // it to oscillate: go up if the spot freed, shuffle sideways if the
        // ledge offers a clear one, otherwise just hold on.
        if (_compMode === 'hang') {
            const topClear = Math.hypot(_hangTop.x - p.x, _hangTop.z - p.z) >= COMP_TOPOUT_CLEAR
                || p.y < _hangTop.y - 0.6;   // player left, or dropped below this ledge entirely
            if (topClear) {
                startCompanionLedgeClimb(c, _hangTop, _hangFwd.x, _hangFwd.z);
                return;
            }
            _compWhy = "hang-look-sideways";
            if (tryCompanionShimmy(p)) return;
            companion.group.position.copy(_hangPos);
            companion.group.quaternion.copy(_hangQuat);
            companion.setNetworkState([_hangPos.x, _hangPos.y, _hangPos.z], [_hangQuat.x, _hangQuat.y, _hangQuat.z, _hangQuat.w], 'hang_idle', false);
            companion.update(delta);
            return;
        }

        // ---- CLIMB (breadcrumb replay) ----
        if (_compMode === 'replay') {
            _replayT += delta;
            const endCr = _compTrail[_compTrail.length - 1];
            const wantT = _replayStartT + _replayT;
            let cr = endCr;
            for (let i = 0; i < _compTrail.length; i++) { if (_compTrail[i].t >= wantT) { cr = _compTrail[i]; break; } }
            // Wait, hanging, if the spot we'd top out onto is where the
            // player is standing. No timeout - it holds the ledge for as
            // long as the spot is occupied. COMP_TOPOUT_CLEAR is deliberately
            // tight (practically on top of them): merely being NEAR the ledge
            // is not a reason to wait, since the follow-target fallbacks let
            // the companion take a shorter stand-off and share the space.
            const blocked = cr.y >= p.y - 0.6 && Math.hypot(cr.x - p.x, cr.z - p.z) < COMP_TOPOUT_CLEAR;
            if (blocked) {
                // Commit to the ledge once, here, and hand off to HANG mode.
                // This used to rewind _replayT and re-run the same test next
                // frame, which meant the replay kept stepping up, noticing it
                // was blocked, and snapping back down to a hang pose - the
                // lunge-and-recoil loop. Deciding once removes the loop.
                //
                // The climb direction comes from THIS replay - takeoff crumb
                // to top-out crumb - and the hang position is then measured
                // off the real ledge (computeLedgeHang). Both are properties
                // of the wall being climbed right now, unlike the previous
                // approach of reusing the last recorded hang_idle pose, which
                // could belong to a different ledge entirely and put the
                // companion nowhere near this one.
                let takeoff = _compTrail[0];
                for (let i = 0; i < _compTrail.length; i++) {
                    if (_compTrail[i].t >= _replayStartT) { takeoff = _compTrail[i]; break; }
                }
                let fx = cr.x - takeoff.x, fz = cr.z - takeoff.z;
                const flen = Math.hypot(fx, fz);
                if (flen < 1e-3) { fx = 0; fz = 1; } else { fx /= flen; fz /= flen; }
                _hangFwd.set(fx, 0, fz);
                _hangTop.set(cr.x, cr.y, cr.z);
                computeLedgeHang(_hangTop, fx, fz, _hangPos);
                squareHangToWall();
                if (!nudgeHangClear(p)) {
                    // Ledge full - stay on the ground and keep following
                    // rather than piling onto an occupied grip. The route is
                    // still recorded, so it retries once the wait expires.
                    _compLedgeWaitT = COMP_LEDGE_WAIT * (1 + Math.random() * COMP_LEDGE_WAIT_JITTER);
                    _compWhy = 'ledge busy, waiting';
                    _compMode = 'follow';
                    companion.update(delta);
                    return;
                }
                _compFaceEuler.set(0, Math.atan2(_hangFwd.x, _hangFwd.z), 0);
                _hangQuat.setFromEuler(_compFaceEuler);
                _compMode = 'hang';
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

        // Deadlock escape, ahead of every routing decision - the whole point
        // is to do something none of them would have chosen.
        if (_compUnstickT > 0) {
            _compUnstickT -= delta;
            _compWhy = 'unsticking';
            const s = Math.min(COMP_SHIMMY_SPEED * 2.0 * delta, 0.2);
            const ux = c.x + _compUnstickDir.x * s, uz = c.z + _compUnstickDir.z * s;
            const ugy = companionGroundY(ux, uz, c.y);
            // Same rule as everywhere else: only take the step if the ground
            // there is somewhere it could stand.
            if (ugy - c.y <= COMP_STEP_UP && c.y - ugy < 2.0) {
                // Face where it is GOING, not at the player. Facing the player
                // while moving perpendicular is a strafe, and there is no
                // strafe clip - the walk cycle just slides sideways.
                _compFaceEuler.set(0, Math.atan2(_compUnstickDir.x, _compUnstickDir.z), 0);
                _compFaceQuat.setFromEuler(_compFaceEuler);
                companion.group.position.set(ux, ugy > c.y ? ugy : c.y, uz);
                const up2 = companion.group.position;
                companion.setNetworkState([up2.x, up2.y, up2.z], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], 'walk', false);
                companion.update(delta);
                return;
            }
            // That way is blocked too - try the other side next frame.
            _compUnstickDir.negate();
        }

        // Below a wall the player just climbed: walk to the spot they actually
        // went up from (findTakeoffApproach), then replay the recorded climb
        // from there. If there is no such spot, fall through to normal follow.
        if (playerElevated && (p.y - c.y) > 1.0) {
            _compWhy = 'takeoff-route';
            // Latch the takeoff once chosen rather than re-deriving it every
            // frame. findTakeoffApproach keys off the follower's OWN height,
            // so anything that moves the companion vertically - being punched
            // by the bot, knocked down, falling - makes a different crumb
            // qualify as "at my height" and the destination jumps elsewhere.
            // Committing to the first answer means a disruption costs it the
            // attempt, not the plan: it returns to the same spot and jumps
            // from the same place.
            let takeoff = null;
            if (_compTakeoffT >= 0) {
                for (let i = 0; i < _compTrail.length; i++) {
                    if (_compTrail[i].t !== _compTakeoffT) continue;
                    // Only still valid if it is genuinely reachable from where
                    // the companion now is - knocked onto a different level,
                    // the old plan is void.
                    if (Math.abs(_compTrail[i].y - c.y) <= 0.9) {
                        let up = null;
                        for (let j = i + 1; j < _compTrail.length; j++) {
                            if (_compTrail[j].y > _compTrail[i].y + 1.0) { up = _compTrail[j]; break; }
                        }
                        if (up) takeoff = { at: _compTrail[i], up };
                    }
                    break;
                }
                if (!takeoff) _compTakeoffT = -1;   // aged out of the trail, or no longer reachable
            }
            if (!takeoff) {
                takeoff = findTakeoffApproach(c);
                _compTakeoffT = takeoff ? takeoff.at.t : -1;
            }
            const dTakeoff = takeoff ? Math.hypot(takeoff.at.x - c.x, takeoff.at.z - c.z) : Infinity;
            // The recorded takeoff is the RIGHT answer, but not at any price.
            // It is wherever the player happened to go up, which can be right
            // across the level - and walking all that way past a wall that
            // would have done just as well is what reads as the companion not
            // finding the route at all. So when the takeoff is far off, check
            // for a way up here first; when it is close, go and use it.
            if (dTakeoff > COMP_TAKEOFF_PREFER_DIST) {
                let fx = p.x - c.x, fz = p.z - c.z;
                const fl = Math.hypot(fx, fz);
                if (fl > 1e-4) {
                    fx /= fl; fz /= fl;
                    if (_compLedgeWaitT <= 0
                        && tryCompanionClimbUp(c, c.x + fx * COMP_CLIMB_REACH_PROBE, c.z + fz * COMP_CLIMB_REACH_PROBE, fx, fz)) return;
                }
            }
            if (takeoff) {
                const tk = takeoff.at;
                const dTk = Math.hypot(tk.x - c.x, tk.z - c.z);
                _compWhy = "walk-to-takeoff";
            // Arrived - the latch has done its job, release it so the next
            // climb picks a fresh takeoff rather than inheriting this one.
            if (dTk < 0.55) { _compMode = 'replay'; _replayStartT = tk.t; _replayT = 0; _compTakeoffT = -1; return; }
                // Walk straight at the takeoff spot - deliberately no
                // obstacle steering here. tk sits right at the base of the
                // wall the player is about to be replayed climbing, so a
                // clear line-of-sight check against that same wall reads it
                // as "blocked" and the widened-angle search can't find a
                // clear angle either (the wall fills the whole forward arc
                // right at its own base) - the companion never got within
                // the 0.55 trigger radius and the follow-climb just stopped
                // happening. The recorded crumb is trusted as reachable
                // on its own: the player themselves stood there.
                const dirTkX = (tk.x - c.x) / dTk, dirTkZ = (tk.z - c.z) / dTk;
                const s = Math.min(dTk, 7.5 * delta);
                const nx = c.x + dirTkX * s, nz = c.z + dirTkZ * s;
                const gyH = companionGroundY(nx, nz, c.y);
                const dyy = gyH - c.y;
                // The crumb being reachable BY THE PLAYER doesn't make the
                // straight line to it walkable - the nearest crumb at this
                // height can easily be somewhere the player reached by a
                // completely different route, with a wall across the direct
                // line. Walking blind into that wall (which is what this did,
                // returning unconditionally every frame) is the "can't find
                // the way" stall. So when the way is blocked, deliberately
                // DON'T return - drop through to FOLLOW, which has steering,
                // the gap leap and the climb to try instead of pressing into
                // geometry forever.
                //
                // Note this branch does NOT climb on its own, even though
                // the helper is right there. Replaying the player's own
                // recorded climb looks considerably better than the generic
                // mantle, so anything still heading for a takeoff spot
                // should keep heading for it; climbing here stole that and
                // the recorded climb stopped happening at all.
                if (dyy <= COMP_STEP_UP) {
                    updateCompanionPathVisual(c, { x: tk.x, y: c.y, z: tk.z }, { x: nx, y: c.y, z: nz });
                    let ny = c.y;
                    if (dyy < -0.05) ny += Math.max(dyy, -16 * delta); else if (dyy > 0.05) ny += Math.min(dyy, 6 * delta);
                    _compFaceEuler.set(0, Math.atan2(dirTkX, dirTkZ), 0);
                    _compFaceQuat.setFromEuler(_compFaceEuler);
                    const mv = Math.hypot(nx - c.x, nz - c.z) / Math.max(delta, 1e-3);
                    companion.group.position.set(nx, ny, nz);
                    companion.setNetworkState([nx, ny, nz], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], companionLocoState(mv, delta), false);
                    companion.update(delta);
                    return;
                }
            }
        }

        // Knocked somewhere perfectly reasonable - stay there. See
        // _compHitSettled. Only the distance to the PLAYER matters here, not
        // the distance to the follow spot: the spot is an ideal, and after
        // taking a punch "near enough" is the honest standard.
        if (_compHitSettled) {
            if (Math.hypot(p.x - c.x, p.z - c.z) <= COMP_HIT_OK_DIST && Math.abs(p.y - c.y) < 1.0) {
                _compWhy = 'hit-settled';
                _compStuckT = 0; _compStuckAt.copy(c);   // standing here on purpose
                _compFaceEuler.set(0, Math.atan2(p.x - c.x, p.z - c.z), 0);
                _compFaceQuat.setFromEuler(_compFaceEuler);
                companion.setNetworkState([c.x, c.y, c.z], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], companionLocoState(0, delta), false);
                companion.update(delta);
                return;
            }
            // Player has moved on - following is the point again.
            _compHitSettled = false;
        }

        // ---- FOLLOW (manual, distance-based) ----
        let dirx, dirz;
        let wantsBehind = networkStateName === 'idle' && Math.abs(p.y - c.y) < 1.0;
        if (wantsBehind) {
            _compBehindDir.set(0, 0, 1).applyQuaternion(q).negate(); // player -> behind-spot direction
            // Only actually worth it if that spot is clear. If the player's
            // back is to a wall/box, "behind" lands inside or right up
            // against it - the companion can't ever actually reach it, but
            // kept trying every frame, and companionSteerDir's candidate
            // angle flipped frame to frame as it hunted for a way in. That
            // showed up as the run/walk clip flickering (repeatedly
            // starting/stopping) rather than a smooth, settled approach.
            _tempVec2.set(p.x, p.y + 0.9, p.z);
            rayFwd.set(_tempVec2, _compBehindDir);
            const behindHits = rayFwd.intersectObjects(collidables);
            if (behindHits.length > 0 && behindHits[0].distance < COMP_FOLLOW_DIST + 0.3) wantsBehind = false;
            else {
                // Wall-clear isn't enough on its own - the spot also has to
                // still be solid ground, not the far side of a ledge. A
                // player standing with their back to a drop-off made
                // "behind" send the companion over the edge (the new leap
                // can actually reach it now) just to immediately climb back
                // up once it re-targeted the player next frame - a pointless
                // round trip that read as falling for no reason.
                _tempVec2.set(p.x + _compBehindDir.x * COMP_FOLLOW_DIST, p.y + 3.0, p.z + _compBehindDir.z * COMP_FOLLOW_DIST);
                rayDown.set(_tempVec2, _downVec);
                const behindGroundHits = rayDown.intersectObjects(_compGroundList, true);
                const behindGroundY = behindGroundHits.length ? behindGroundHits[0].point.y : -Infinity;
                if (p.y - behindGroundY > COMP_LEAP_EDGE_DROP) wantsBehind = false;
            }
        }
        if (wantsBehind) {
            dirx = _compBehindDir.x; dirz = _compBehindDir.z;
        } else {
            dirx = c.x - p.x; dirz = c.z - p.z;
            let len = Math.hypot(dirx, dirz);
            if (len < 0.001) { dirx = 0; dirz = 1; len = 1; }
            dirx /= len; dirz /= len;
        }
        // Stand-off distance, shortened until the spot is actually solid
        // ground at the player's own level. A fixed COMP_FOLLOW_DIST assumes
        // there is always that much room behind the player, which on a single
        // block or a narrow ledge there simply isn't - the target landed out
        // in the air past the edge, so the companion either never arrived or
        // treated its own follow spot as a gap to leap. Closing in when the
        // space is tight is better than standing politely off a cliff.
        let followDist = _compFollowDist;
        if (playerElevated && (p.y - c.y) < 1.0) followDist = 0.9; // up on the block with them: hug close anyway
        for (let attempt = 0; attempt < COMP_FOLLOW_FALLBACKS.length; attempt++) {
            const d = Math.max(COMP_FOLLOW_MIN, Math.min(followDist, _compFollowDist * COMP_FOLLOW_FALLBACKS[attempt]));
            _tempVec2.set(p.x + dirx * d, p.y + 3.0, p.z + dirz * d);
            rayDown.set(_tempVec2, _downVec);
            const spotHits = rayDown.intersectObjects(_compGroundList, true);
            const spotY = spotHits.length ? spotHits[0].point.y : -Infinity;
            // Same level as the player, not the floor far below a ledge.
            if (p.y - spotY <= COMP_LEAP_EDGE_DROP) { followDist = d; break; }
            // Nothing worked even at the closest fallback - keep the original
            // distance and let the ordinary edge/leap logic deal with it.
            if (attempt === COMP_FOLLOW_FALLBACKS.length - 1) followDist = Math.max(COMP_FOLLOW_MIN, Math.min(followDist, _compFollowDist * COMP_FOLLOW_FALLBACKS[attempt]));
        }
        let tgx = p.x + dirx * followDist, tgz = p.z + dirz * followDist;

        const toX = tgx - c.x, toZ = tgz - c.z; const h = Math.hypot(toX, toZ);

        // Deadzone. The follow spot is recomputed every frame and drifts with
        // every small move the player makes, so without this the companion is
        // permanently making tiny corrections - which is the fidgeting back
        // and forth. Near enough is near enough: stand still and face them.
        if (h < COMP_ARRIVE_DEADZONE && Math.abs(p.y - c.y) < 1.0) {
            _compWhy = 'arrived';
            _compFaceEuler.set(0, Math.atan2(p.x - c.x, p.z - c.z), 0);
            _compFaceQuat.setFromEuler(_compFaceEuler);
            companion.setNetworkState([c.x, c.y, c.z], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], companionLocoState(0, delta), false);
            companion.update(delta);
            return;
        }

        // ---- Edge/gap detection: leap instead of trying to walk it ----
        // Suppressed right after a climb - see _compJustClimbedT. Leaping back
        // down off the ledge it has just hauled itself onto is the single
        // worst thing it could do at that moment.
        if (h > 1e-4 && _compJustClimbedT <= 0) {
            const travelX = toX / h, travelZ = toZ / h;
            // Short probe just past the companion's own footprint, in the
            // direction it's actually trying to go - a normal ramp/step
            // still finds ground close by here, so this only fires for a
            // genuine drop-off (see COMP_LEAP_EDGE_DROP).
            _tempVec2.set(c.x + travelX * COMP_LEAP_EDGE_FWD, c.y + 3.0, c.z + travelZ * COMP_LEAP_EDGE_FWD);
            rayDown.set(_tempVec2, _downVec);
            const edgeHits = rayDown.intersectObjects(_compGroundList, true);
            const edgeGroundY = edgeHits.length ? edgeHits[0].point.y : -Infinity;
            if (c.y - edgeGroundY > COMP_LEAP_EDGE_DROP) {
                // It's an edge, not a step - scan further out along the same
                // direction for where solid footing actually resumes.
                let landing = null;
                for (let dist = COMP_LEAP_EDGE_FWD + 0.5; dist <= COMP_LEAP_MAX_DIST; dist += 0.5) {
                    _tempVec2.set(c.x + travelX * dist, c.y + 3.0, c.z + travelZ * dist);
                    rayDown.set(_tempVec2, _downVec);
                    const hits = rayDown.intersectObjects(_compGroundList, true);
                    if (!hits.length) continue;
                    const ly = hits[0].point.y;
                    // A leap may never gain more height than the player's own
                    // jump can. The band used to be symmetric at 3.0, so a
                    // spot 3 units up counted as a valid landing and the
                    // companion launched itself at it - that is the "super
                    // jump", and nothing in this game can do it. Anything
                    // higher belongs to the climb paths.
                    if (ly - c.y > COMP_LEAP_RISE_MAX) continue;
                    if (c.y - ly > COMP_LEAP_LANDING_BAND) continue;
                    landing = { x: c.x + travelX * dist, y: ly, z: c.z + travelZ * dist };
                    break;
                }
                // Dropping off a ledge is only worth it if the player is
                // actually down there. The follow target drifts around the
                // player every frame, and when it drifted out past an edge
                // the companion would take the drop purely to chase it - then
                // immediately have to get back up again. That down-then-up
                // round trip is where the flying came from; the fix is to not
                // make the pointless descent in the first place.
                if (landing && (c.y - landing.y) > COMP_LEAP_EDGE_DROP && p.y > landing.y + 1.0) landing = null;
                if (landing) {
                    _compLeapStart.copy(c);
                    _compLeapEnd.set(landing.x, landing.y, landing.z);
                    const leapDist = _compLeapStart.distanceTo(_compLeapEnd);
                    _compLeapDur = Math.max(0.35, leapDist / COMP_LEAP_SPEED);
                    _compLeapT = 0;
                    _compLeapToHang = false;
                    _compFaceEuler.set(0, Math.atan2(travelX, travelZ), 0);
                    _compLeapFaceQuat.setFromEuler(_compFaceEuler);
                    _compMode = 'leap';
                    return;
                }
                // No safe landing found within range - fall through to the
                // ordinary glide below rather than stranding it worse.
            }
        }

        _compWhy = 'follow-walk';
        let nx = c.x, nz = c.z;
        let steerDir = null;
        if (h > 1e-4) {
            // Steering only applies roughly on the level (matches the
            // "behind player" height gate above) - it exists for genuine
            // side obstacles (a box sitting between companion and player on
            // flat ground), not for stairs/ramps/ledges. Once there's a
            // real height gap the target is very likely sitting on or past
            // exactly that kind of rise, and a chest-height ray can't tell
            // "wall to steer around" from "step to walk into and climb" -
            // it read every stair/ledge as blocked, which is what stopped
            // the companion from ever closing the distance needed to reach
            // a climb takeoff spot or step up onto nearby terrain.
            if (Math.abs(p.y - c.y) < 1.0) {
                steerDir = companionSteerDir(c, { x: tgx, z: tgz }, delta);
                if (steerDir) {
                    const s = Math.min(h, 7.5 * delta);
                    nx += steerDir.x * s; nz += steerDir.z * s;
                }
            } else {
                const s = Math.min(h, 7.5 * delta);
                nx += (toX / h) * s; nz += (toZ / h) * s;
            }
        }
        // Refuse the horizontal move if it would step onto something taller
        // than a normal step, rather than taking it and sorting the height
        // out vertically afterwards. Which of those two the code does is
        // the whole difference between the two bugs this has bounced
        // between:
        //   - Capping the RISE but still moving xz (the original) let ny
        //     freeze while nx/nz carried on, so the companion ended up with
        //     its feet below a block's top while standing over that block's
        //     footprint - embedded inside it.
        //   - Uncapping the rise (the fix for that) removed the embedding
        //     but meant any height at all got glided up in place, which is
        //     the "riding an elevator" look - it ascended the side of a
        //     block instead of climbing it.
        // Blocking the xz move keeps position and height consistent with
        // each other at all times: it simply stops at the base. Getting up
        // there is then left to the paths that actually animate a climb -
        // the breadcrumb replay (playerElevated, above) and the leap - which
        // is the jump-and-grab-the-ledge behaviour this should always have
        // been using for a real rise.
        // Never close inside the player's own footprint. The follow spot is
        // meant to keep a distance, but it drifts every frame and on a tight
        // ledge the fallbacks pull it in to 0.7 - close enough that the two
        // end up standing in each other. Overlapping is what makes the
        // companion start scrambling: it reads the shared spot as somewhere
        // it has to resolve, and climbs or hops to get out of it.
        if (Math.hypot(nx - p.x, nz - p.z) < COMP_MIN_PLAYER_GAP && Math.abs(p.y - c.y) < 1.0) {
            nx = c.x; nz = c.z;
        }
        // ...and never inside EACH OTHER either. Both companions aim at the
        // same follow spot behind the player, so they converge on one point
        // and walk through one another. Applied here, before gyHere is read
        // off nx/nz below, for the same reason the bots' own separation runs
        // before their ground snap: nudging them sideways afterwards would
        // move them over a different surface while keeping the old height.
        // Suspended right after a climb. The push is applied to the step
        // target, and on the lip of a ledge a sideways nudge of even a few
        // centimetres puts the companion over the edge - the ground scan below
        // then finds the lower level and it walks straight back down. Standing
        // where it landed matters more for that second than being spaced out.
        if (_compJustClimbedT <= 0) {
            companionSeparate(nx, nz, c.y, delta, _compSepOut);
            nx = _compSepOut.x; nz = _compSepOut.y;
        }
        // Two separate questions, and conflating them is what made the
        // companion jitter. `gyHere` is what it would be STANDING on - never
        // something overhead - and drives the vertical follow. `obstacleY`
        // asks whether there is something in the way worth climbing, which
        // deliberately does look upward.
        let gyHere = companionGroundY(nx, nz, c.y);
        // The obstacle is looked for a fixed distance AHEAD, not at the next
        // step position. A step is only 0.125 at walking speed, so probing
        // there means the companion cannot see a ledge until it is already
        // 12cm from the face - and anything that halts it before that (the
        // arrival deadzone, the min-gap guard, simply reaching its follow
        // spot) meant the step was never noticed at all. It would stand next
        // to a knee-high ledge doing nothing. The bot has always probed a
        // fixed distance out; this now does the same.
        const probeDx = h > 1e-4 ? toX / h : 0, probeDz = h > 1e-4 ? toZ / h : 0;
        const probeX = c.x + probeDx * COMP_CLIMB_REACH_PROBE;
        const probeZ = c.z + probeDz * COMP_CLIMB_REACH_PROBE;
        const obstacleY = companionGroundY(probeX, probeZ, c.y, COMP_CLIMB_MAX);
        // ...and it must not simply WALK off either. The leap is suppressed
        // above, but the ordinary glide would happily carry it over the edge
        // one step at a time, which is the same undo by a slower route.
        if (_compJustClimbedT > 0 && c.y - gyHere > COMP_LEAP_EDGE_DROP) {
            nx = c.x; nz = c.z;
            gyHere = companionGroundY(c.x, c.z, c.y);
        }
        if (obstacleY - c.y > COMP_STEP_UP) {
            // Climb only when the player is actually up there. A wall in the
            // way is not a reason to climb it - the player, walking the same
            // ground, just goes around, and the companion should read the
            // same way. Without this it treated every obstacle as something
            // to scale: walk into the stacked test cubes while the player
            // stands beside them on the flat, and it would haul itself up
            // onto them instead of stepping around, which is nothing a
            // player would ever do.
            //
            // Going around is already handled - companionSteerDir runs
            // exactly when the two are on the level, which is exactly when
            // this now declines to climb.
            _compWhy = 'blocked-try-climb';
            // A short hop needs no justification. The "is the player high
            // enough to be worth climbing for" test exists to stop the
            // companion scaling random boxes on level ground - but applied to
            // EVERY rise it also blocked knee-to-waist height steps whenever
            // the player was only slightly above, which is neither walkable
            // (over COMP_STEP_UP) nor climbable (gate refuses), so it just
            // stopped. That gap is why it could only get up somewhere it had
            // watched the player jump: the recorded route was the sole way
            // through. Anyone would simply hop a step this size.
            const riseHere = obstacleY - c.y;
            const climbWorthIt = riseHere <= COMP_LEAP_RISE_MAX || p.y - c.y > COMP_CLIMB_WORTH_IT;
            // Climb toward the probed spot, which is where the step actually
            // is - passing the next-step position would have it measuring the
            // ledge from somewhere it has not reached yet.
            if (climbWorthIt && h > 1e-4
                && _compLedgeWaitT <= 0
                && tryCompanionClimbUp(c, probeX, probeZ, probeDx, probeDz)) return;
            nx = c.x; nz = c.z; gyHere = companionGroundY(c.x, c.z, c.y);
        }
        updateCompanionPathVisual(c, { x: tgx, y: c.y, z: tgz }, { x: nx, y: c.y, z: nz });
        let ny = c.y; const dy = gyHere - c.y;
        // Falling stays uncapped in distance (only in speed) - dropping to
        // follow the player down is always legitimate, and it is only the
        // upward direction that ever produced either bug above.
        if (dy < -0.05) ny += Math.max(dy, -16 * delta);            // fall to follow down
        else if (dy > 0.05) ny += Math.min(dy, 6 * delta);          // step up onto the ground actually under us
        // Face the direction of travel while actually travelling, and only
        // turn to the player once stopped. Facing the player the whole time
        // meant that any movement not straight at them - going round an
        // obstacle, heading for a follow spot off to one side, closing on a
        // takeoff point - was played as a sideways slide, because the only
        // locomotion clips are forward ones. Walking forwards to where it is
        // going is what it should have been doing.
        const movedX = nx - c.x, movedZ = nz - c.z;
        const movedH = Math.hypot(movedX, movedZ) / Math.max(delta, 1e-3);
        _compFaceEuler.set(0, movedH > COMP_FACE_TRAVEL_MIN
            ? Math.atan2(movedX, movedZ)
            : Math.atan2(p.x - c.x, p.z - c.z), 0);
        _compFaceQuat.setFromEuler(_compFaceEuler);
        const st = companionLocoState(movedH, delta);
        companion.group.position.set(nx, ny, nz);
        companion.setNetworkState([nx, ny, nz], [_compFaceQuat.x, _compFaceQuat.y, _compFaceQuat.z, _compFaceQuat.w], st, false);
        companion.update(delta);
    }

    const aiBotSpawnBtn = document.getElementById('ai-bot-spawn-btn');
    const aiBotDespawnBtn = document.getElementById('ai-bot-despawn-btn');
    if (aiBotSpawnBtn) aiBotSpawnBtn.addEventListener('pointerdown', spawnAiBot);
    if (aiBotDespawnBtn) aiBotDespawnBtn.addEventListener('pointerdown', despawnAiBot);
    // On by default, same as the companion. spawnAiBot also flips the panel's
    // own spawn/despawn buttons and status text, so the UI still matches.
    spawnAiBot();

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
    let treeModel = null;
    let pendingVillageLevelBuild = false;
    // Materials held permanently "dithering", relying entirely on the shader's
    // own screen-circle + depth test to decide where anything is actually
    // discarded (see makeDitherable, far below - declared up here only so the
    // async Tree.glb callback can never touch it before its initialiser runs).
    // This is how the trees work, and it is not a shortcut but the only
    // option: all ~193 forest trees share one InstancedMesh per source mesh,
    // so there is no per-tree material to raise or lower, and any
    // raycast-driven value would dissolve every tree the moment one of them
    // occluded. Holding the amount at full is still correct, because the
    // shader only discards fragments inside the hole AND in front of the
    // player - precisely "this tree is between the camera and the player,
    // right where you are looking". A tree behind or beside you never loses a
    // pixel.
    const ditherAlwaysOnMats = [];
    const villageLoader = new GLTFLoader();
    const onVillageLoaded = (gltf) => {
        villageScene = gltf.scene;
        // Repairs NaN transforms before anything can read a bounding box off
        // this scene. Village.glb has a lock assembly baked into the whitebox,
        // and its "Star" node is exported with an all-zero 3x3 matrix (scale
        // 0 - that star is meant to start hidden). GLTFLoader feeds a node
        // matrix through Object3D.applyMatrix4, which decomposes it, and
        // Matrix4.decompose divides the rotation basis by the scale: 1/0 is
        // Infinity, 0 * Infinity is NaN, so the node lands with a NaN
        // quaternion. That poisons its matrixWorld and therefore any
        // Box3.setFromObject of it OR OF ITS PARENT (setFromObject expands
        // over children), so LockStarContainer's obstacle box came out NaN.
        // A NaN Box3 makes intersectsBox return TRUE against everything -
        // every early-out comparison is false when NaN is involved - so that
        // single node reported a collision at every point in the level. That
        // is what made ledge-grabbing impossible anywhere in Village: the
        // hang-clearance check (isVerticalSpaceClear) always hit this one
        // phantom obstacle first and bailed out. Scale is deliberately left
        // at 0 - the star is supposed to be invisible - only the unusable
        // rotation is reset.
        villageScene.traverse(o => {
            const q = o.quaternion, p = o.position, s = o.scale;
            if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
                console.warn(`Village.glb: "${o.name || '(unnamed)'}" arrived with a NaN rotation (zero-scale node matrix) - reset to identity.`);
                q.set(0, 0, 0, 1);
            }
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) p.set(0, 0, 0);
            if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) s.set(1, 1, 1);
        });
        if (pendingVillageLevelBuild && treeModel && mountainGeometry) { pendingVillageLevelBuild = false; buildVillageLevel(); }
    };
    villageLoader.load('VillageModel/Village.glb', onVillageLoaded, undefined, () => {
        villageLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/VillageModel/Village.glb',
            onVillageLoaded, undefined, (e) => console.error('Village.glb load failed:', e));
    });

    // Real tree prop (VillageModel/Tree.glb, copied from the top-level
    // IKRig/Tree.glb) that replaces the whitebox trunk+foliage-sphere
    // placeholder trees baked into Village.glb - loaded once here (not per
    // rebuild) and cloned onto each placeholder's spot in buildVillageLevel.
    // Same proactive-load/pending-rebuild pattern as villageScene above,
    // except buildVillageLevel now waits on BOTH before it will actually
    // build (see the gate at its top) so the level never renders with the
    // whitebox trees still in place waiting for this to catch up.
    const villageTreeLoader = new GLTFLoader();
    const onVillageTreeLoaded = (gltf) => {
        treeModel = gltf.scene;
        // Re-materials once here on the shared template (every per-instance
        // clone() in buildVillageLevel references these same material
        // objects, not a copy) - all as MeshToonMaterial using the source
        // texture as `map` and the shared threeTone gradientMap, but with
        // per-material alpha handling driven by the exported material NAME
        // (there are 3, each used across all 4 leaf-bunch meshes' 2
        // primitives plus the trunk - not one name per mesh/node):
        //   "TreeBody"        - trunk, opaque, no alpha discard.
        //   "leave"           - matches the grass field's own alphaTest
        //                       (window.grassAlphaTest) exactly, per author.
        //   "TreeLeaveBunch"  - a harder cutout than grass, NOT meant to
        //                       match it (explicit author instruction).
        treeModel.traverse(o => {
            if (!o.isMesh) return;
            const srcMats = Array.isArray(o.material) ? o.material : [o.material];
            const newMats = srcMats.map(m => {
                // Strips Blender's auto-dedup ".001"/".002" suffix (every
                // re-export that leaves an old same-named material block
                // lying around gets one) so this still recognizes "leave",
                // "leave.001", "leave.002", etc. as the same material -
                // an exact-string match here previously silently fell
                // through to opaque/no-cutout the moment a re-export
                // picked up a suffix, which is what made the leaf
                // background render as solid black instead of cutting out.
                const name = ((m && m.name) || '').replace(/\.\d+$/, '');
                let alphaTest = 0;
                let isLeaf = false, isCosmeticLeaf = false;
                // The model is 9 meshes: a trunk, 4 solid canopy chunks
                // ("TreeLeaveBunch"), and 4 decorative fringe meshes
                // ("leave") parented one-to-one under those chunks. Every
                // node is NAMED "TreeLeaveBunch.*" regardless of which it
                // is, so the material name is the only thing that tells the
                // two apart - hence keying off it here rather than off
                // o.name. The fringe is cosmetic only: it neither casts
                // shadows (its scattered alpha-cut edges throw a speckled,
                // noisy shadow instead of a readable silhouette) nor takes
                // part in collision (see the collidables filter in
                // buildVillageLevel). The chunk underneath it does both, so
                // the tree still blocks and shadows exactly as before.
                // isLeaf covers both and only drives the normal-flip shader
                // fix below, which they equally need.
                if (name === 'leave') { alphaTest = window.grassAlphaTest; isLeaf = true; isCosmeticLeaf = true; }
                else if (name === 'TreeLeaveBunch') { alphaTest = 0.85; isLeaf = true; }
                // DoubleSide, and FrontSide was tried and measured worse on
                // both counts it was supposed to help. The idea was sound -
                // these are closed-ish volumes, so culling backfaces should
                // have halved the leaf fragments in the fill-rate-bound
                // canopy - but three.js maps a FrontSide material to
                // shadowSide BackSide, which renders the far surface into the
                // shadow map, and that lost the canopy's ground shadows
                // entirely. It also came out SLOWER: 121fps against 134.
                // Reverted rather than chased.
                const mat = new THREE.MeshToonMaterial({
                    map: m && m.map ? m.map : null,
                    gradientMap: threeTone,
                    side: THREE.DoubleSide,
                    alphaTest,
                    transparent: false,
                });
                if (isCosmeticLeaf) {
                    // Read back per-mesh by the level builders to drop both
                    // shadow casting and collision on exactly the meshes
                    // using this material. Safe as a per-MESH decision even
                    // though it is made per MATERIAL: in this model each
                    // fringe mesh is its own node with this one material, so
                    // castShadow (per-Object3D, not per-material) and
                    // collidables membership can both be set independently
                    // of the chunk it hangs off.
                    mat.userData.isCosmeticLeaf = true;
                }
                // Which parts skip the shadow maps. Separate from the
                // collision decision (isTreeVisualOnly) because the two do
                // not line up: BaseTreeLeaveBunch casts but never collides,
                // while the trunk collides but no longer casts. The trunk is
                // excluded on an art call - it stands under its own canopy,
                // permanently inside that shadow, so its own contribution is
                // not visible. Worth knowing it is a small win: the trunk is
                // 48 of the 720 shadow-casting tris per tree (6.7%), and the
                // only opaque one, i.e. the cheapest per pixel. The alpha-cut
                // canopy is the real shadow cost.
                if (name === 'leave' || name === 'TreeBody') mat.userData.noShadow = true;
                if (isLeaf) {
                    mat.userData.isLeaf = true;
                    // Same normal-flip cancel as grassMats' own onBeforeCompile
                    // above - without it, this real leaf-cluster mesh's actual
                    // per-vertex normals get DoubleSide's automatic backface
                    // flip, so whichever side of a curved leaf blob faces away
                    // from the camera goes darker than its neighbor under
                    // otherwise uniform lighting - reads as half the canopy
                    // patchy/two-toned rather than reflecting anything real
                    // about the geometry or the light.
                    mat.onBeforeCompile = (shader) => {
                        shader.fragmentShader = shader.fragmentShader.replace(
                            '#include <normal_fragment_begin>',
                            'vec3 normal = normalize( vNormal );'
                        );
                    };
                }
                return mat;
            });
            o.material = Array.isArray(o.material) ? newMats : newMats[0];
        });
        // Registered AFTER the loop above, so makeDitherable wraps the
        // normal-flip onBeforeCompile those leaf materials just got rather
        // than being overwritten by it.
        treeModel.traverse(o => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(m => {
                if (!m || ditherAlwaysOnMats.includes(m)) return;
                makeDitherable(m);
                ditherAlwaysOnMats.push(m);
            });
        });
        if (pendingVillageLevelBuild && villageScene && mountainGeometry) { pendingVillageLevelBuild = false; buildVillageLevel(); }
        // The forest level is built entirely out of this one model, so it has
        // nothing else to wait on - retry as soon as it lands.
        if (pendingForestLevelBuild) { pendingForestLevelBuild = false; buildForestLevel(); }
    };
    villageTreeLoader.load('VillageModel/Tree.glb', onVillageTreeLoaded, undefined, () => {
        villageTreeLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/VillageModel/Tree.glb',
            onVillageTreeLoaded, undefined, (e) => console.error('Tree.glb load failed:', e));
    });

    // Real mountain prop, replacing the whitebox cones baked into Village.glb
    // ("Cyl 16" and its copies) exactly the way Tree.glb replaces the
    // placeholder trees. mountains.glb was authored in the village's own
    // coordinate space - its two instances sit at roughly two of the cones'
    // positions and carry the same scales - so it is the intended stand-in
    // for them rather than a separate piece of set dressing.
    //
    // Only ONE mesh in the file, instanced twice by the author with different
    // yaw; the swap below clones it onto every cone and varies the yaw itself,
    // so the whole ridge line the level author composed survives instead of
    // dropping from five peaks to two.
    // The GEOMETRY, deliberately, not the loaded scene. Cloning gltf.scene
    // would drag the author's own two placements along with it - each of those
    // nodes carries a translation out at (-209, -22, -119) and a scale of 136,
    // so a clone re-scaled onto a proxy would land nowhere near it and at the
    // product of the two scales. The mesh's own local frame is the useful part:
    // y:[0,1] with the base on the origin plane and roughly unit radius, which
    // is exactly the frame the whitebox cones use, so a proxy's transform drops
    // straight onto it.
    let mountainGeometry = null, mountainMaterial = null;
    // Where the whitebox cones stood, read off Village.glb the first time the
    // village is built and kept because that read is destructive - see the
    // swap in buildVillageLevel.
    let _villageMountainPlacements = null;
    const mountainLoader = new GLTFLoader();
    const onMountainLoaded = (gltf) => {
        let src = null;
        gltf.scene.traverse(o => { if (o.isMesh && !src) src = o; });
        if (!src) { console.error('mountains.glb: no mesh found'); return; }
        mountainGeometry = src.geometry;
        // Same re-material the tree gets: toon + the shared gradient map,
        // keeping the asset's own baseColor texture. One material, shared by
        // every peak - they are identical apart from their transform.
        const m0 = Array.isArray(src.material) ? src.material[0] : src.material;
        mountainMaterial = new THREE.MeshToonMaterial({
            map: m0 && m0.map ? m0.map : null,
            color: m0 && m0.map ? 0xffffff : 0x8fa3b0,
            gradientMap: threeTone,
        });
        if (pendingVillageLevelBuild && villageScene && treeModel) {
            pendingVillageLevelBuild = false;
            buildVillageLevel();
        }
    };
    mountainLoader.load('VillageModel/mountains.glb', onMountainLoaded, undefined, () => {
        mountainLoader.load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/ProjectFiles/VillageModel/mountains.glb',
            onMountainLoaded, undefined, (e) => console.error('mountains.glb load failed:', e));
    });


    // Single place both level builders ask "should this part of the tree take
    // part in collision at all?", because the two exclusions are told apart by
    // DIFFERENT things and getting either one wrong is invisible until
    // something walks into it:
    //   - the "leave" fringe has its own material, flagged at load time;
    //   - "BaseTreeLeaveBunch" (the big lower canopy mass) shares the SAME
    //     material as the walkable upper chunks, so nothing but its node name
    //     distinguishes it.
    // What is left collidable is the trunk plus the four upper canopy chunks -
    // the surfaces actually meant to be walked/climbed on.
    function isTreeVisualOnly(mesh) {
        if (mesh.name && mesh.name.startsWith('BaseTreeLeaveBunch')) return true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return mats.some(m => m && m.userData && m.userData.isCosmeticLeaf);
    }
    // Only the four upper canopy chunks reach the shadow maps. The trunk and
    // the fringe are excluded by their materials' own noShadow flag; the
    // BaseTreeLeaveBunch mass is excluded here by NAME, because it shares its
    // material with the chunks that do cast and so cannot be told apart any
    // other way - the same reason isTreeVisualOnly has to check the name.
    //
    // Measured before removing it: the Base was 336 of the 720 shadow-casting
    // triangles per tree, 46.7%, and alpha-cut ones at that (the expensive
    // kind, since alpha test defeats early-Z in the shadow pass too). Its
    // silhouette also largely coincides with the chunks sitting on top of it,
    // so what it contributed was mostly redundant.
    function treeCastsShadow(mesh) {
        if (isTreeVisualOnly(mesh)) return false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return !mats.some(m => m && m.userData && m.userData.noShadow);
    }

    // ---- Forest level ----
    // Procedural, ported from the Unity generators the author supplied
    // (TreeGenerator / GrassGenerator / WayObjectGenerator): walk a grid over
    // the play area, sample Perlin noise per cell, plant a tree where the
    // noise clears a threshold, jitter and scale it from that same noise, and
    // reject anything landing too close to an already-placed tree. Cells that
    // fail the threshold are what the Unity side filled with "way" prefabs -
    // here they simply stay open, and the existing grass/flower scatter
    // (buildGrass/buildFlowers, which already reject spots blocked near the
    // ground) fills them, matching GrassGenerator's own tree-avoidance step
    // without a second implementation of it.
    let pendingForestLevelBuild = false;
    // Mathf.PerlinNoise stand-in - classic 2D Perlin with a seeded
    // permutation table, so `seed` reshuffles the whole field the way the
    // Unity version's seed offset does. Values land in 0..1 like Unity's,
    // NOT the -1..1 a raw gradient-noise implementation returns, so the
    // thresholds carried over from those scripts mean the same thing here.
    const _perlinPerm = new Uint8Array(512);
    function seedPerlin(seed) {
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        // Deterministic shuffle from a plain LCG - Math.random() would make
        // the same seed produce a different forest on every rebuild.
        let s = (seed | 0) || 1;
        for (let i = 255; i > 0; i--) {
            s = (s * 1664525 + 1013904223) | 0;
            const j = (s >>> 8) % (i + 1);
            const t = p[i]; p[i] = p[j]; p[j] = t;
        }
        for (let i = 0; i < 512; i++) _perlinPerm[i] = p[i & 255];
    }
    function perlinFade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    function perlinGrad(hash, x, y) {
        // 8 gradient directions, picked by the low 3 bits of the hash.
        switch (hash & 7) {
            case 0: return x + y;
            case 1: return x - y;
            case 2: return -x + y;
            case 3: return -x - y;
            case 4: return x;
            case 5: return -x;
            case 6: return y;
            default: return -y;
        }
    }
    function perlin2(x, y) {
        const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
        const xf = x - Math.floor(x), yf = y - Math.floor(y);
        const u = perlinFade(xf), v = perlinFade(yf);
        const aa = _perlinPerm[_perlinPerm[xi] + yi];
        const ab = _perlinPerm[_perlinPerm[xi] + yi + 1];
        const ba = _perlinPerm[_perlinPerm[xi + 1] + yi];
        const bb = _perlinPerm[_perlinPerm[xi + 1] + yi + 1];
        const x1 = THREE.MathUtils.lerp(perlinGrad(aa, xf, yf), perlinGrad(ba, xf - 1, yf), u);
        const x2 = THREE.MathUtils.lerp(perlinGrad(ab, xf, yf - 1), perlinGrad(bb, xf - 1, yf - 1), u);
        // Gradient noise spans roughly -1..1; remap to Unity's 0..1 range.
        return THREE.MathUtils.clamp((THREE.MathUtils.lerp(x1, x2, v) + 1) * 0.5, 0, 1);
    }

    // Same names/defaults as the Unity components' inspector fields, so the
    // numbers the author already tuned there transfer directly.
    window.forestAreaSize = 120;
    window.forestGridSize = 60;
    window.forestNoiseScale = 18;
    window.forestTreeThreshold = 0.55;
    window.forestMinScale = 0.8;
    window.forestMaxScale = 1.6;
    window.forestBaseMinDistance = 4.0;
    window.forestSeed = 1337;
    // Radius around spawn kept clear of trees, so the level never opens with
    // the camera buried inside a canopy.
    window.forestClearingRadius = 9;

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
        // `instanceof`, not a plain truthiness check: a level authored in the
        // shape editor and exported as glTF carries its own `cachedBox3` in
        // each node's `extras`, and GLTFLoader copies `extras` wholesale into
        // `userData` - so a freshly loaded level (Village.glb: 63 of its 74
        // mesh nodes) arrives with this field ALREADY set to a plain JSON
        // object left over from the editor's scene. Box3.copy() reads .min.x
        // etc., which those plain objects do have, so it silently succeeded
        // and handed back the editor's stale world box instead of this
        // object's real one - measured up to ~24 units off (Village's
        // "Box 10" caches X[-5.7,-3.7] while it actually sits at
        // X[18.6,20.6]). Every box-based test downstream - ledge hang/stand
        // clearance, grass and flower placement, carry drop spots - was
        // therefore checking phantom volumes and missing real ones. Only a
        // Box3 this function itself built is trusted as a cache; anything
        // else is recomputed from the object's actual loaded transform.
        if (obj.userData && obj.userData.cachedBox3 instanceof THREE.Box3) {
            targetBox3.copy(obj.userData.cachedBox3);
            return targetBox3;
        }
        if (!obj.userData) obj.userData = {};
        const fresh = new THREE.Box3().setFromObject(obj);
        // A non-finite box is worse than no box at all: Box3.intersectsBox
        // early-outs on a chain of comparisons that are ALL false when NaN is
        // involved, so it falls through and reports a hit against every box
        // it is ever tested with - one poisoned object then reads as a solid
        // obstacle filling the entire level (see the NaN-transform repair in
        // onVillageLoaded for the case that actually shipped). Failing to an
        // empty box instead makes a broken object collide with nothing, which
        // degrades one prop rather than silently disabling ledge grabbing,
        // grass placement and carry drops everywhere.
        if (!Number.isFinite(fresh.min.x) || !Number.isFinite(fresh.min.y) || !Number.isFinite(fresh.min.z) ||
            !Number.isFinite(fresh.max.x) || !Number.isFinite(fresh.max.y) || !Number.isFinite(fresh.max.z)) {
            console.warn('getObstacleBox: non-finite bounds for', obj.name || obj.uuid, '- treating as empty (collides with nothing).');
            fresh.makeEmpty();
        }
        obj.userData.cachedBox3 = fresh;
        targetBox3.copy(fresh);
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
            // Objects flagged softObstacle sit this test out. It compares
            // against an AXIS-ALIGNED BOUNDING BOX, which is fine for the
            // blocks it was written for (a box IS their shape) but wildly
            // wrong for something sparse: a tree's box wraps its whole
            // canopy spread, so every spot under the leaves counted as
            // solid and the player could not stand on a build block placed
            // anywhere near a tree - without ever touching it. They still
            // collide for real; only this box approximation skips them, so
            // standing inside a tree's canopy is allowed, which is what a
            // tree should behave like anyway.
            if (obj.userData && obj.userData.softObstacle) continue;
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
        // >0 means the body is a disc of this radius, not a rectangle, and the
        // "am I in it?" test below is a circle test instead of a box one. A
        // box around a round lake bulges sqrt(2) past the water at the
        // corners, and anything standing in that bulge at the right height
        // foams - which is how the lake bank ended up with a white ring
        // running along its OUTER slope, on dry ground facing away from the
        // water, in the four diagonal quadrants only.
        uFoamRadius: { value: new Array(MAX_WATER_BODIES).fill(0) },
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
                    uniform vec2 uFoamMax[${MAX_WATER_BODIES}];
                    uniform float uFoamRadius[${MAX_WATER_BODIES}];`)
                .replace('#include <dithering_fragment>', `
                    // Pick the water body this fragment belongs to: the one
                    // whose XZ footprint it is inside (or nearest to), ties
                    // broken toward the SMALLER footprint so a pond sitting
                    // on top of the sea's huge plane wins over it.
                    float fFoamBestDist = 1e9;
                    float fFoamBestArea = 1e9;
                    float fFoamBestSlack = 0.5;
                    float fFoamLevel = 0.0, fFoamSpeed = 0.0, fFoamAmp = 0.0, fFoamBand = 0.0, fFoamOn = 0.0;
                    for (int i = 0; i < ${MAX_WATER_BODIES}; i++) {
                        if (float(i) >= uFoamCount) continue;
                        if (uFoamOn[i] < 0.5) continue;
                        vec2 mn = uFoamMin[i];
                        vec2 mx = uFoamMax[i];
                        float dd;
                        // A disc body measures from its centre; a rectangular
                        // one from its edges. Same units either way (squared
                        // distance to the footprint), so the pick below and
                        // the cutoff after it do not care which it was.
                        float rr = uFoamRadius[i];
                        if (rr > 0.0) {
                            vec2 dc = vFoamPositionW.xz - (mn + mx) * 0.5;
                            float dr = max(length(dc) - rr, 0.0);
                            dd = dr * dr;
                        } else {
                            float dxx = max(max(mn.x - vFoamPositionW.x, vFoamPositionW.x - mx.x), 0.0);
                            float dzz = max(max(mn.y - vFoamPositionW.z, vFoamPositionW.z - mx.y), 0.0);
                            dd = dxx * dxx + dzz * dzz;
                        }
                        float aa = (mx.x - mn.x) * (mx.y - mn.y);
                        if (dd < fFoamBestDist - 1e-4 || (abs(dd - fFoamBestDist) <= 1e-4 && aa < fFoamBestArea)) {
                            fFoamBestDist = dd; fFoamBestArea = aa;
                            // A disc gets a wider tolerance than a box. The
                            // band climbs a sloped bank, so it reaches further
                            // out than the water's own edge, and a disc has no
                            // corner bulge to spend the slack on - the whole
                            // point of testing it as a circle.
                            fFoamBestSlack = rr > 0.0 ? 1.0 : 0.5;
                            fFoamLevel = uFoamLevel[i]; fFoamSpeed = uFoamSpeed[i];
                            fFoamAmp = uFoamAmp[i]; fFoamBand = uFoamBand[i]; fFoamOn = 1.0;
                        }
                    }
                    // Nearest is not the same as inside. The loop above keeps
                    // the closest body no matter how far away it is, which was
                    // fine when the only water was a 256-unit sea that covered
                    // everything worth foaming - but with small ponds, EVERY
                    // point in the level is "nearest to" one of them, so a
                    // character standing in dry grass on the far side of the
                    // map still got a foam band across its shins.
                    //
                    // Requiring the fragment to be essentially within the
                    // footprint fixes that. The tolerance is small and in
                    // squared units; it exists only so the band does not cut
                    // off hard exactly at the boundary.
                    if (fFoamBestDist > fFoamBestSlack * fFoamBestSlack) fFoamOn = 0.0;
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
    // icon: null, or a key into a {key: dataUrlGetter} map (see
    // dialogueIconUrlFor) - only the compass line has one right now.
    const VILLAGE_DIALOGUE_LINES = [
        { text: 'Listen to me.', icon: null },
        { text: 'My apprentice went into the forest yesterday and still hasn\'t returned.', icon: null },
        { text: 'He didn\'t even take his compass with him.', icon: 'compass' },
        { text: 'If you can find him, could you bring him back to the village?', icon: null },
        { text: 'Please, please bring him back.', icon: null },
    ];
    function dialogueIconUrlFor(key) {
        if (key === 'compass') return window.compassIconDataUrl || null;
        return null;
    }
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
        ctx.fillStyle = 'rgba(15,15,20,0.92)';
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
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
        ctx.fillStyle = '#fff';
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
            img.style.cssText = `height:${(window.iconSize || 40)}px; width:auto; flex:0 0 auto;`;
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
    const Viewer = { scene: null, camera: null, renderer: null, controls: null, active: false, playerModel: null, loaded: false, mixer: null, clock: new THREE.Clock(), category: 'player' };
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

    // ---- Items (Viewer's second tab) ----
    // CompassObject.glb, loaded once and shared between two uses: shown
    // live in the Viewer's "Items" tab, and rendered to a small icon used
    // inline in the NPC dialogue line that mentions it ("Pusulasını da
    // yanına almamış."). Auto-framed from its own bounding box (unlike
    // the player/StickMan camera positions above, which are hand-tuned
    // guesses) since this model's native scale isn't already known the
    // way the player rig's is.
    let compassObjectModel = null;
    let compassObjectLoading = false;
    const compassObjectReadyCallbacks = [];
    function loadCompassObject(onReady) {
        if (compassObjectModel) { onReady(compassObjectModel); return; }
        compassObjectReadyCallbacks.push(onReady);
        if (compassObjectLoading) return;
        compassObjectLoading = true;
        new GLTFLoader().load('https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/CompassObject.glb', (gltf) => {
            compassObjectModel = gltf.scene;
            // Same treatment as the in-world Compass.glb needle model
            // (compassGltfLoader above): 'CompassContainer' becomes a
            // fixed dark toon shell (with its normals flipped - it comes
            // in facing the wrong way here too), everything else becomes
            // flat/unlit with ITS OWN original color preserved and drawn
            // depth-ignoring so it isn't hidden inside the container's
            // opaque volume. The one part Compass.glb doesn't have -
            // 'CompasFrame' (sic - that's the actual name baked into this
            // file, not a typo on this end), the outer metal ball/ring -
            // gets a toon material too (still cell-shaded, still matte,
            // per request) but keeps ITS OWN color read from the source
            // file instead of a hardcoded one.
            const toonColorFrom = (mat, fallback) => {
                const c = Array.isArray(mat) ? (mat[0] && mat[0].color) : (mat && mat.color);
                return c ? c.clone() : new THREE.Color(fallback);
            };
            const flatUnlitFrom = (mat) => {
                const nm = new THREE.MeshBasicMaterial({
                    color: mat && mat.color ? mat.color.clone() : 0xffffff,
                    transparent: !!(mat && mat.transparent),
                    opacity: mat && mat.opacity !== undefined ? mat.opacity : 1,
                });
                nm.depthTest = false; nm.depthWrite = false;
                return nm;
            };
            compassObjectModel.traverse(c => {
                if (!c.isMesh) return;
                c.castShadow = true; c.receiveShadow = true;
                if (c.name === 'CompassContainer') {
                    if (c.geometry.attributes.normal) {
                        const normalAttr = c.geometry.attributes.normal;
                        for (let i = 0; i < normalAttr.count; i++) normalAttr.setXYZ(i, -normalAttr.getX(i), -normalAttr.getY(i), -normalAttr.getZ(i));
                        normalAttr.needsUpdate = true;
                    }
                    c.material = new THREE.MeshToonMaterial({ color: 0x1c2a4a, gradientMap: threeTone });
                    c.renderOrder = 0;
                } else if (c.name === 'CompasFrame') {
                    c.material = new THREE.MeshToonMaterial({ color: toonColorFrom(c.material, 0x888888), gradientMap: threeTone });
                } else {
                    c.material = Array.isArray(c.material) ? c.material.map(flatUnlitFrom) : flatUnlitFrom(c.material);
                    c.renderOrder = 1;
                }
            });
            generateIconFromObject(compassObjectModel, url => { window.compassIconDataUrl = url; });
            compassObjectReadyCallbacks.forEach(cb => cb(compassObjectModel));
            compassObjectReadyCallbacks.length = 0;
        });
    }
    // Generic version of generatePlayerIcon above - auto-frames the
    // camera from the object's own Box3 instead of a hand-picked position,
    // since (unlike the player rig) this is meant to work for whatever
    // item gets added next without re-tuning a camera position by eye
    // each time. Temporarily reparents into a throwaway scene for the
    // render, then puts it back where it was (or leaves it detached if it
    // had no parent yet) - doesn't require Viewer.scene to exist, so this
    // can run before the Viewer has ever been opened.
    function generateIconFromObject(object, onDone) {
        const box = new THREE.Box3().setFromObject(object);
        const size = new THREE.Vector3(); box.getSize(size);
        const center = new THREE.Vector3(); box.getCenter(center);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const iconScene = new THREE.Scene();
        iconScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.8));
        const l = new THREE.DirectionalLight(0xffffff, 1.2); l.position.set(2, 4, 2); iconScene.add(l);
        const prevParent = object.parent;
        iconScene.add(object);
        const iconCamera = new THREE.PerspectiveCamera(40, 1, 0.01, Math.max(10, maxDim * 20));
        iconCamera.position.set(center.x + maxDim * 1.2, center.y + maxDim, center.z + maxDim * 1.8);
        iconCamera.lookAt(center);
        const RENDER_PX = 256; // bigger than the displayed size so the crop below still lands on a sharp image
        const iconRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        iconRenderer.setSize(RENDER_PX, RENDER_PX);
        iconRenderer.setClearColor(0x000000, 0);
        iconRenderer.render(iconScene, iconCamera);
        // Crop to the object's actual opaque pixels. The camera above frames
        // the object generously (and the object need not be square), so the
        // raw render always carries transparent padding on at least one axis -
        // which shows up as dead space above/below the icon wherever it's
        // placed inline next to text. Cropping to the alpha bounding box
        // makes the PNG's own edges the object's edges, so "no margin" holds
        // for any object without per-object camera tuning.
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = RENDER_PX; cropCanvas.height = RENDER_PX;
        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(iconRenderer.domElement, 0, 0);
        const pixels = cropCtx.getImageData(0, 0, RENDER_PX, RENDER_PX).data;
        let minX = RENDER_PX, minY = RENDER_PX, maxX = -1, maxY = -1;
        for (let y = 0; y < RENDER_PX; y++) {
            for (let x = 0; x < RENDER_PX; x++) {
                if (pixels[(y * RENDER_PX + x) * 4 + 3] > 8) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        let dataUrl;
        if (maxX >= minX && maxY >= minY) {
            const cw = maxX - minX + 1, ch = maxY - minY + 1;
            const outCanvas = document.createElement('canvas');
            outCanvas.width = cw; outCanvas.height = ch;
            outCanvas.getContext('2d').drawImage(cropCanvas, minX, minY, cw, ch, 0, 0, cw, ch);
            dataUrl = outCanvas.toDataURL('image/png');
        } else {
            dataUrl = iconRenderer.domElement.toDataURL('image/png'); // fully transparent render - nothing to crop to
        }
        onDone(dataUrl);
        iconRenderer.dispose();
        if (prevParent) prevParent.add(object); else iconScene.remove(object);
    }
    const viewerLabelEl = document.getElementById('viewer-label');
    function setViewerCategory(cat) {
        Viewer.category = cat;
        document.querySelectorAll('.viewer-cat-btn').forEach(b => {
            const active = b.dataset.cat === cat;
            b.classList.toggle('active', active);
            b.style.background = active ? '#2563eb' : 'transparent';
            b.style.color = active ? '#fff' : '#aaa';
        });
        if (cat === 'player') {
            if (Viewer.playerModel) Viewer.playerModel.visible = true;
            if (compassObjectModel) compassObjectModel.visible = false;
            if (viewerLabelEl) viewerLabelEl.textContent = 'Player';
            Viewer.camera.position.set(2.5, 2.0, 5.0);
            Viewer.controls.target.set(0, 0.9, 0);
        } else {
            if (Viewer.playerModel) Viewer.playerModel.visible = false;
            if (viewerLabelEl) viewerLabelEl.textContent = 'Compass';
            loadCompassObject(obj => {
                if (Viewer.category !== 'items') return; // tab may have been switched away while this was loading
                if (obj.parent !== Viewer.scene) Viewer.scene.add(obj);
                obj.visible = true;
                const box = new THREE.Box3().setFromObject(obj);
                const size = new THREE.Vector3(); box.getSize(size);
                const center = new THREE.Vector3(); box.getCenter(center);
                const maxDim = Math.max(size.x, size.y, size.z) || 1;
                Viewer.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 2.2);
                Viewer.controls.target.copy(center);
            });
        }
        Viewer.controls.update();
    }
    document.querySelectorAll('.viewer-cat-btn').forEach(b => b.addEventListener('click', () => setViewerCategory(b.dataset.cat)));

    function buildForestLevel() {
        if (!treeModel) { pendingForestLevelBuild = true; return; }
        while (levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0;
        // Same reason buildVillageLevel sets this - nothing here loads the
        // Cubes.glb prop that normally flips it, so the loading overlay would
        // otherwise never hide.
        window._cubesLoaded = true;
        // A slab under the forest instead of the shared 1000x1000 plane, so
        // the world visibly ENDS at the treeline with void beyond it rather
        // than running off flat to the horizon. The border walls (Pass 3a) sit
        // well inside the slab's edge, so the drop is something you see, never
        // something you can walk off.
        ground.visible = false;
        star.visible = false;
        buildForestGroundBox();

        // ---- Pass 1: decide where trees go (no geometry built yet) ----
        seedPerlin(window.forestSeed);
        buildForestGroundMask();
        const area = window.forestAreaSize, grid = Math.max(2, Math.round(window.forestGridSize));
        const step = area / grid, half = area * 0.5;
        const noiseScale = window.forestNoiseScale;
        // Chosen BEFORE the trees so the scatter can avoid them. The other
        // way round would mean deleting trees a lake happened to land on, or
        // leaving lakes with trunks standing in the middle of them.
        const lakes = pickForestLakes(half, noiseScale);
        const placements = [];
        for (let xi = 0; xi < grid; xi++) {
            for (let zi = 0; zi < grid; zi++) {
                const x = -half + xi * step;
                const z = -half + zi * step;
                const spawnNoise = perlin2((x + window.forestSeed) / noiseScale, (z + window.forestSeed) / noiseScale);
                if (spawnNoise < window.forestTreeThreshold) continue;
                // Jitter within the cell, from a second noise lookup with the
                // axes swapped - same trick the Unity generator uses to break
                // up the grid without needing a separate RNG.
                const offX = (perlin2((x + window.forestSeed) / noiseScale, (z + window.forestSeed) / noiseScale) - 0.5) * step;
                const offZ = (perlin2((z + window.forestSeed) / noiseScale, (x + window.forestSeed) / noiseScale) - 0.5) * step;
                const px = x + offX, pz = z + offZ;
                // Keep the spawn pocket open.
                if (Math.hypot(px, pz) < window.forestClearingRadius) continue;
                // ...and nothing standing over the chasm.
                if (Math.abs(px - FOREST_GAP_X) < FOREST_GAP_W * 0.5 + FOREST_GAP_CLEAR) continue;
                // ...and keep the lakes clear, with a bank around them.
                let inLake = false;
                for (let L = 0; L < lakes.length; L++) {
                    if (Math.hypot(px - lakes[L].x, pz - lakes[L].z) < lakes[L].r + FOREST_LAKE_BANK) { inLake = true; break; }
                }
                if (inLake) continue;
                const scale = THREE.MathUtils.lerp(window.forestMinScale, window.forestMaxScale, spawnNoise);
                // Overlap rejection, scaled by both trees' sizes so big trees
                // claim more room than saplings (straight from TreeGenerator).
                let tooClose = false;
                for (let k = 0; k < placements.length; k++) {
                    const o = placements[k];
                    const minDist = window.forestBaseMinDistance * ((scale + o.scale) * 0.5);
                    if (Math.hypot(px - o.x, pz - o.z) < minDist) { tooClose = true; break; }
                }
                if (tooClose) continue;
                // Facing comes from its own hash of the position, NOT from
                // spawnNoise. spawnNoise is above forestTreeThreshold by
                // construction - that is what decided a tree belongs here at
                // all - so it only ever spans [threshold, 1], and scaling that
                // to a full turn gave every tree a facing inside the same
                // ~160-degree arc. They all pointed roughly one way.
                //
                // Position-hashed rather than Math.random() so the forest is
                // still reproducible from forestSeed: same seed, same wood.
                placements.push({ x: px, z: pz, scale, rotY: forestHash01(px, pz) * Math.PI * 2 });
            }
        }

        // No border ring of trees any more. It existed because the scatter is
        // pure noise, and noise has no notion of an edge, so the wood thinned
        // out toward the boundary and you could see straight out of the level.
        // The ground slab now ends at a hard cliff instead, which closes the
        // view just as well and does not need a hedge to explain it.

        // ---- Pass 2: one InstancedMesh per source mesh, not one clone per tree ----
        // Tree.glb is 9 meshes (4 leaf nodes x 2 primitives, plus the trunk),
        // so cloning it per tree costs 9 draw calls each - and every one of
        // those is drawn a further two times, once into each shadow-casting
        // light's map. That is what made a mere 13 cloned trees cost ~40fps in
        // the village. Instancing collapses the whole forest to those same 9
        // draw calls no matter how many trees there are, because every tree
        // shares one geometry and differs only by its per-instance matrix.
        treeModel.updateMatrixWorld(true);
        const _srcInv = new THREE.Matrix4().copy(treeModel.matrixWorld).invert();
        const sources = [];
        treeModel.traverse(o => {
            if (!o.isMesh) return;
            // The mesh's transform RELATIVE to the model root - baked into
            // each instance matrix below, since an InstancedMesh has no
            // parent chain of its own to inherit it from.
            const rel = new THREE.Matrix4().multiplyMatrices(_srcInv, o.matrixWorld);
            const mat = Array.isArray(o.material) ? o.material[0] : o.material;
            const cosmetic = (Array.isArray(o.material) ? o.material : [o.material])
                .some(m => m && m.userData && m.userData.isCosmeticLeaf);
            sources.push({ geometry: o.geometry, material: mat, rel, visualOnly: isTreeVisualOnly(o), cosmetic });
        });

        const _treeMat = new THREE.Matrix4();
        const _instMat = new THREE.Matrix4();
        const _q = new THREE.Quaternion();
        const _pos = new THREE.Vector3();
        const _scl = new THREE.Vector3();
        sources.forEach(src => {
            const inst = new THREE.InstancedMesh(src.geometry, src.material, placements.length);
            placements.forEach((p, i) => {
                _q.setFromAxisAngle(_upVec, p.rotY);
                _pos.set(p.x, p.y || 0, p.z);
                _scl.setScalar(p.scale);
                _treeMat.compose(_pos, _q, _scl);
                _instMat.multiplyMatrices(_treeMat, src.rel);
                inst.setMatrixAt(i, _instMat);
            });
            inst.instanceMatrix.needsUpdate = true;
            // Same split as the village trees: the cosmetic "leave" fringe
            // (isCosmeticLeaf) stays out of the shadow maps, the canopy
            // chunks and trunk cast normally.
            // src.visualOnly covers both parts that must not cast (the fringe
            // and the Base mass); noShadow covers the trunk. See
            // treeCastsShadow, which is the same rule for the village's
            // non-instanced trees.
            inst.castShadow = !src.visualOnly && !(src.material && src.material.userData && src.material.userData.noShadow);
            inst.receiveShadow = true;
            // Nothing instanced answers a world probe here - not even the
            // trunk - because collision goes through the invisible per-tree
            // boxes below instead. That is forced by instancing, not a
            // preference: all ~193 trees share ONE InstancedMesh per source
            // mesh, so the box-based checks (getObstacleBox and everything
            // built on it) would measure a single bounding volume spanning
            // the entire forest and treat the whole level as solid. Real
            // per-mesh collision would mean going back to one clone per
            // tree, which is exactly the ~9-draw-calls-per-tree cost
            // instancing exists to avoid.
            inst.raycast = () => {};
            inst.frustumCulled = false;
            levelGroup.add(inst);
        });

        // ---- Pass 3: real, walkable collision geometry per tree ----
        // Back to the model's actual triangles rather than the box proxies
        // this briefly used: a box wrapping a rounded blob puts its solid
        // surface well outside the visible shell, so you stand on thin air at
        // the corners and hit flat walls where the art curves - it did not
        // read as a comfortable walk or climb. The real surface does.
        //
        // What is affordable changed with the model. The canopy chunks were
        // halved (168 -> 84 tris each, upper hemisphere only) and the heavy
        // lower mass was split out as its own BaseTreeLeaveBunch node, which
        // is visual-only - so the collision set is now the trunk plus four
        // 84-tri chunks (~384 tris) instead of the 720 that measured 47fps.
        // isTreeVisualOnly is what draws that line; see it for why the two
        // exclusions need different tests.
        //
        // Merging matters for cost: adding the parts as separate collidables
        // would put ~965 objects in the array that every raycast and
        // obstacle-box test walks, where merged it stays at one per tree.
        // Position-only attributes, all non-indexed: mergeGeometries refuses
        // a mix of indexed and non-indexed inputs or differing attribute
        // sets, and collision needs nothing else - Mesh.raycast derives the
        // hit face normal from the triangle's own vertices, not from a
        // normal attribute.
        const collisionParts = [];
        sources.forEach(src => {
            if (src.visualOnly) return;
            const flat = src.geometry.index ? src.geometry.toNonIndexed() : src.geometry.clone();
            const part = new THREE.BufferGeometry();
            part.setAttribute('position', flat.getAttribute('position').clone());
            part.applyMatrix4(src.rel);
            collisionParts.push(part);
            flat.dispose();
        });
        const treeCollisionGeo = collisionParts.length ? BufferGeometryUtils.mergeGeometries(collisionParts, false) : null;
        collisionParts.forEach(g => g.dispose());
        // Invisible via the MATERIAL, deliberately not via object.visible -
        // three.js skips a material-hidden mesh at render time but still
        // raycasts it, which is exactly what an invisible collider needs.
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        if (treeCollisionGeo) {
            placements.forEach(p => {
                // Border trees are VISUAL only - the four walls below stand in
                // for all of them. Giving each its own collider would add
                // ~500 meshes to `collidables`, and that array is walked by
                // every raycast in the game (ground scan, foot IK, dither
                // probes, both AI characters' obstacle checks). The drawing is
                // free because it is instanced; the collision would not be.
                // Four boxes also make a better barrier than a row of trunks,
                // which has gaps to squeeze between.
                const col = new THREE.Mesh(treeCollisionGeo, colliderMat);
                col.position.set(p.x, p.y || 0, p.z);
                col.rotation.y = p.rotY;
                col.scale.setScalar(p.scale);
                col.castShadow = false;
                col.receiveShadow = false;
                // Real raycast collision, but exempt from the bounding-box
                // clearance test - see softObstacle in isVerticalSpaceClear.
                col.userData.softObstacle = true;
                // The only per-tree object that exists (visuals are
                // instanced), so this is what the dither probes and the x-ray
                // ghost test read to mean "a tree is in the way".
                col.userData.isTreeCollider = true;
                col.updateMatrixWorld(true);
                levelGroup.add(col);
                collidables.push(col);
            });
        }

        // ---- Lakes ----
        // One shared water body for all of them: they sit at the same height,
        // and a body carries a whole shader/uniform set, so five would be five
        // times the cost for identical water.
        if (!forestLakeBody) forestLakeBody = createWaterBody({
            // waveAmplitude 0 on purpose - the rise and fall is driven from
            // JS instead (updateForestLakeSurfaces), so that the surface
            // height, the disc's radius and the foam band all come from one
            // number. A non-zero value here would add a SECOND, independent
            // bob on top of it.
            waterLevel: FOREST_LAKE_Y, waveSpeed: FOREST_LAKE_WAVE_SPEED, waveAmplitude: 0, foamDepth: 0.14,
            textureSize: 40, colorNear: 0x4fc6e8, colorFar: 0x14618c,
        });
        // Re-enabled every build, not just at creation: buildLevel switches
        // foam off on every body before dispatching, and the `if (!...)` guard
        // means the constructor default only ever applies the first time. Same
        // trap the Water Test pond documents.
        forestLakeBody.uniforms.uFoamEnabled.value = 1;
        // Rebuilt every time the level is - the old entries point at meshes
        // levelGroup has already dropped, and scaling those each frame would
        // be work done on nothing.
        _forestLakeMeshes.length = 0;
        lakes.forEach(L => {
            // Sized to meet the bank at the water's height, not to L.r. L.r is
            // where the bank's tube centre line crosses, which is BELOW the
            // water: the bank's inner face leans outwards as it rises, so at
            // the surface it has already pulled back over a metre. A disc cut
            // to L.r left that metre as a ring of dry ground between the water
            // and the shore, which read as a small puddle sitting in an
            // oversized crater rather than a lake filling its basin.
            // Cut for the HIGHEST the water ever rises, not for its resting
            // height. A flat disc meeting a sloped bank already produces a
            // waterline that slides up and down as the disc rises - that comes
            // free from the geometry - so the disc only has to be big enough
            // never to fall short. Oversize is invisible: the bank is above
            // the water everywhere past the contact ring, so the excess is
            // hidden under the slope.
            const fillR = forestLakeInnerRadius(L.r, FOREST_LAKE_Y + FOREST_LAKE_WAVE_AMP) + FOREST_LAKE_FILL_BITE;
            const lake = new THREE.Mesh(new THREE.CircleGeometry(fillR, 40), forestLakeBody.waterMaterial);
            lake.rotation.x = -Math.PI / 2;
            lake.position.set(L.x, FOREST_LAKE_Y, L.z);
            levelGroup.add(lake);
            // Kept so the surface can be widened and narrowed every frame to
            // keep its edge on the bank as the wave rises - see
            // updateForestLakeSurfaces.
            _forestLakeMeshes.push({ mesh: lake, baseR: fillR, lakeR: L.r });
            // NOT a collidable, deliberately - you wade through it. Pushing it
            // into collidables (which the Water Test pond does, because there
            // it is a surface you stand on) would make the surface solid, and
            // it would also become ground for every probe in the game: the
            // foot IK, the AI ground scans and the climb checks all read that
            // array, and a lake would read as a floor at 0.38 - a step to
            // climb onto rather than water to walk into.
            //
            // Passing through is also what makes the foam work: the shoreline
            // band keys off the character's height against uWaterLevel, so it
            // only appears once you are actually standing in the water.
            linkWaterMeshToBody(lake, forestLakeBody);

            // Lake bed, in the bank's colour, so looking down through the
            // water shows a shore-coloured basin instead of the grass the
            // ground plane would otherwise give. Purely visual - you still
            // stand on the ground plane underneath it.
            if (!forestLakeBedMaterial) {
                // No shoreline foam here, unlike the bank: the bed sits
                // entirely below the water line, so the band that marks where
                // a surface enters the water would cover the whole thing.
                forestLakeBedMaterial = new THREE.MeshToonMaterial({
                    color: FOREST_LAKE_RIM_COLOR, gradientMap: threeTone,
                });
            }
            // Runs out to where the bank meets the ground, plus a little, so
            // it tucks under the bank's foot. Beyond that the bank's own
            // inner slope is the floor - same colour, so the two read as one
            // continuous basin, shelving up from the bed to the shore.
            const bed = new THREE.Mesh(
                new THREE.CircleGeometry(forestLakeInnerRadius(L.r, 0) + FOREST_LAKE_BED_OVERLAP, 40),
                forestLakeBedMaterial);
            bed.rotation.x = -Math.PI / 2;
            // Lifted a hair off the ground plane to stay out of a z-fight
            // with it.
            bed.position.set(L.x, FOREST_LAKE_BED_Y, L.z);
            bed.receiveShadow = true;
            levelGroup.add(bed);

            // Raised bank. Ring radius puts the tube's inner face at the
            // water's edge, so the water meets the slope rather than stopping
            // short of it with a strip of grass between.
            if (!forestLakeRimMaterial) {
                forestLakeRimMaterial = new THREE.MeshToonMaterial({ color: FOREST_LAKE_RIM_COLOR, gradientMap: threeTone });
                // Wet line where the bank enters the water.
                applyShorelineFoam(forestLakeRimMaterial);
            }
            const rim = new THREE.Mesh(
                new THREE.TorusGeometry(L.r + FOREST_LAKE_RIM_TUBE, FOREST_LAKE_RIM_TUBE, FOREST_LAKE_RIM_TUBE_SEGS, FOREST_LAKE_RIM_SEGS),
                forestLakeRimMaterial);
            rim.rotation.x = -Math.PI / 2;    // torus is authored in XY; lay it flat
            // Squash applied on world Y. Done after the rotation, so this is
            // the torus's own tube axis - see FOREST_LAKE_RIM_FLATTEN.
            rim.scale.set(1, 1, FOREST_LAKE_RIM_FLATTEN);
            // Sunk below the ground plane rather than centred on it, so less
            // of the bank stands proud - a low mound at the water's edge
            // instead of a ring you have to climb. Sinking also shortens the
            // exposed outer face, which flattens the walk-up further.
            rim.position.set(L.x, -FOREST_LAKE_RIM_SINK, L.z);
            rim.castShadow = true;
            rim.receiveShadow = true;
            // Walkable, so it needs real collision. Exempt from the
            // bounding-box clearance test for the same reason the tree
            // colliders are: a torus's box is mostly empty air, and letting
            // that veto standing spots would block the whole clearing.
            rim.userData.softObstacle = true;
            rim.updateMatrixWorld(true);
            levelGroup.add(rim);
            collidables.push(rim);
        });
        _forestLakes = lakes;

        // ---- Pass 3a: the cliff wall that frames the level ----
        // The invisible walls are gone. They existed to stop you leaving, but
        // there is a sea to fall into now and falling into it is meant to be
        // possible - for the player and for every bot and companion. What
        // bounds the level instead is a real wall of grey blocks, tall as the
        // biggest tree, standing along the outer edge of the islands.
        //
        // Solid geometry rather than an invisible barrier means it also reads
        // as the far side of the world from anywhere in the level, and its top
        // carries the same earth-and-grass treatment as the ground, with its
        // own trees, so the eye reads it as land continuing upward rather than
        // as a lid.
        {
            const step = FOREST_BORDER_BLOCK;
            const top = FOREST_BORDER_HEIGHT;
            if (!_forestBorderMat) {
                _forestBorderMat = new THREE.MeshToonMaterial({ color: 0x8d8d93, gradientMap: threeTone });
            }
            // Grass projected onto the caps, the same triplanar treatment the
            // Level 1 blocks get - so the tops read as earth with grass rather
            // than as painted grey.
            if (!_forestBorderCapMat) {
                _forestBorderCapMat = new THREE.MeshToonMaterial({ color: 0xa89880, gradientMap: threeTone });
                applyTriplanarGrass(_forestBorderCapMat);
            }
            const spots = [];
            forestBorderLayout((bx, bz) => spots.push([bx, bz]));
            // INSTANCED, not one mesh per block. There are ~85 of them and
            // three.js does not batch identical meshes on its own, so the
            // straightforward version would be 170 extra draw calls for a
            // wall that never moves.
            const mk = (geo, mat, yc) => {
                const inst = new THREE.InstancedMesh(geo, mat, spots.length);
                const m = new THREE.Matrix4();
                spots.forEach(([bx, bz], i) => {
                    m.makeTranslation(bx, yc, bz);
                    inst.setMatrixAt(i, m);
                });
                inst.instanceMatrix.needsUpdate = true;
                inst.castShadow = true; inst.receiveShadow = true;
                inst.frustumCulled = false;
                levelGroup.add(inst);
                return inst;
            };
            mk(new THREE.BoxGeometry(step, top, step), _forestBorderMat, top * 0.5);
            mk(new THREE.BoxGeometry(step, FOREST_BORDER_CAP, step), _forestBorderCapMat,
                top + FOREST_BORDER_CAP * 0.5);
            // Collision is a few long boxes rather than one per block: an
            // InstancedMesh reports ONE bounding box for the whole ring, which
            // every box-based test in the game would read as the entire level
            // being solid. Nothing climbs an 11-unit wall, so a plain barrier
            // is all this has to be.
            const bh = forestSlabHalf();
            const gapLo = FOREST_GAP_X - FOREST_GAP_W * 0.5 - step;
            const gapHi = FOREST_GAP_X + FOREST_GAP_W * 0.5 + step;
            const segs = [];
            [bh, -bh].forEach(bz => {
                // Split around the strait, on the two sides it crosses.
                segs.push([(-bh + gapLo) * 0.5, bz, gapLo + bh, step]);
                segs.push([(gapHi + bh) * 0.5, bz, bh - gapHi, step]);
            });
            [bh, -bh].forEach(bx => segs.push([bx, 0, step, bh * 2]));
            segs.forEach(([cx, cz, sx, sz]) => {
                if (sx <= 0.01 || sz <= 0.01) return;
                const w = new THREE.Mesh(new THREE.BoxGeometry(sx, top + FOREST_BORDER_CAP, sz),
                    new THREE.MeshBasicMaterial({ visible: false }));
                w.position.set(cx, (top + FOREST_BORDER_CAP) * 0.5, cz);
                w.updateMatrixWorld(true);
                levelGroup.add(w); collidables.push(w);
            });
        }

        // ---- Pass 3b: analytic canopy spheres for the dither probe ----
        // BaseTreeLeaveBunch is intentionally non-collidable, so the dither
        // probes - which raycast collidables - cannot see it, leaving the part
        // most likely to be covering the player unable to trigger the dissolve
        // on its own. Two mesh-based fixes were tried and both cost too much:
        // real geometry per tree measured 88fps against 128, and even a box
        // proxy still meant 193 extra Object3Ds being raycast and culled.
        //
        // No mesh at all here. A canopy is close enough to a ball that a
        // segment-to-sphere distance test answers "is a tree between the
        // camera and the player" directly - about ten floating point
        // operations per tree, against a Mesh.raycast that inverts a matrix
        // and walks bounding sphere, bounding box and triangles. It also
        // sidesteps the backface problem for free: with the camera INSIDE the
        // canopy the nearest point on the segment is the camera itself, so
        // the test still reports a hit, where a FrontSide mesh reported
        // nothing at all.
        //
        // Radius comes from the horizontal spread rather than the box
        // diagonal - a circumscribing sphere would reach well past the leaves
        // and start dissolving trees that are merely near the player.
        const canopyBox = new THREE.Box3();
        let haveCanopy = false;
        sources.forEach(src => {
            if (!src.visualOnly || src.cosmetic) return;
            const placed = src.geometry.clone().applyMatrix4(src.rel);
            placed.computeBoundingBox();
            if (haveCanopy) canopyBox.union(placed.boundingBox); else { canopyBox.copy(placed.boundingBox); haveCanopy = true; }
            placed.dispose();
        });
        if (haveCanopy) {
            const cSize = new THREE.Vector3(); canopyBox.getSize(cSize);
            const cCenter = new THREE.Vector3(); canopyBox.getCenter(cCenter);
            const localR = 0.5 * Math.max(cSize.x, cSize.z);
            placements.forEach(p => {
                // Tree transforms are position + Y rotation + uniform scale,
                // and a sphere is rotation invariant, so the Y rotation can
                // simply be ignored when placing the centre.
                ditherProbeSpheres.push({
                    x: p.x + cCenter.x * p.scale,
                    y: cCenter.y * p.scale,
                    z: p.z + cCenter.z * p.scale,
                    r: localR * p.scale,
                });
            });
        }

        // Kept for the grass scatter, which clusters tufts around each
        // trunk - see the tree ring in rebuildGrass.
        _forestPlacements = placements;

        char.group.position.set(0, 2.0, 0);
        char.group.rotation.y = 0;
        window.compassTarget = null;
        console.log(`Forest: ${placements.length} trees, ${sources.length} draw calls (instanced), collision ${treeCollisionGeo ? treeCollisionGeo.getAttribute('position').count / 3 : 0} tris/tree.`);
    }

    // Paints the clearing mask from the forest's own spawn noise: 1 where the
    // noise falls short of the tree threshold (open ground - a path), 0 where
    // trees stand.
    //
    // Must be called AFTER seedPerlin, since it reads the same perlin2 the
    // scatter does - that shared source is the whole point. Evaluating the
    // real function beats approximating it in GLSL: a shader re-implementation
    // would have to match this Perlin exactly, and any drift would show up as
    // yellow creeping under the trees.
    //
    // The soft edge matters more than the resolution here. A hard cut at the
    // threshold gives a stencilled outline; ramping across a band either side
    // makes the paths fade into the grass the way worn ground does.
    // Deterministic 0..1 from a position, folded with forestSeed so the whole
    // forest still regenerates identically from that one number. Used for
    // tree facing and for the border's jitter/scale - anywhere Math.random()
    // would have broken reproducibility.
    function forestHash01(x, z) {
        const h = Math.sin(x * 12.9898 + z * 78.233 + window.forestSeed) * 43758.5453;
        return h - Math.floor(h);
    }
    // ---- Forest lakes ----
    // Small ponds dropped into the clearings. They go where the spawn noise
    // says NO tree belongs, which is the same test that paints the beige
    // paths - so a lake always lands in an opening rather than having to
    // clear trees out of its way, and the two features agree about where the
    // wood is thin instead of contradicting each other.
    //
    // Sitting just above the ground plane rather than in a dug basin: the
    // forest floor is one flat plane, so there is nothing to sink into. The
    // shoreline foam band (uFoamDepth) is what sells the edge.
    // 4, not more: every linked water mesh takes one of MAX_WATER_BODIES
    // slots, because each needs its own footprint even though all the lakes
    // share a single water body. A fifth would be clamped out of foamCount
    // and end up as a lake with no foam at all. Raising the limit is possible
    // but it widens a per-fragment loop that runs on every foam material,
    // including the full-screen ground plane - not worth one more pond.
    // 3, not 4. The foam shader carries MAX_WATER_BODIES (4) footprints, and
    // the river now takes one of those slots - a fifth entry would simply be
    // dropped from the array, and the thing dropped would be the river.
    const FOREST_LAKE_COUNT = 3;
    const FOREST_LAKE_MIN_R = 3.0, FOREST_LAKE_MAX_R = 6.0;
    // High enough to actually wash around the legs - at 0.07 it was level with
    // the grass and read as a painted puddle. This is what gives the foam band
    // something to sit on.
    const FOREST_LAKE_Y = 0.30;
    // Tree-free margin around each lake. Has to clear the whole bank, not just
    // the water: the torus reaches its full half-width out from L.r, so a
    // smaller margin plants trees on the outer slope, half-sunk in it.
    const FOREST_LAKE_BANK = 4.8;
    const FOREST_LAKE_RIM_COLOR = 0xa08154;   // shared by the bank and the bed
    const FOREST_LAKE_BED_Y = 0.02;           // clear of a z-fight with the ground
    const FOREST_LAKE_BED_OVERLAP = 0.25;     // past the bank's foot, tucked under it
    const FOREST_LAKE_FILL_BITE = 0.05;       // water edge buried in the bank, no seam

    // Radius of the bank's inner face at height `y`. The bank is an ellipse in
    // cross-section, so its inner wall pulls outwards the higher you go - which
    // means the water's edge and the bed's edge are at different radii, and
    // neither is L.r. L.r is only where the tube's centre line crosses, which
    // sits FOREST_LAKE_RIM_SINK below the ground.
    function forestLakeInnerRadius(baseR, y) {
        const a = FOREST_LAKE_RIM_TUBE;
        const b = a * FOREST_LAKE_RIM_FLATTEN;
        const dy = (y + FOREST_LAKE_RIM_SINK) / b;      // up from the tube centre, normalised
        // Above the crest there is no wall left to meet; clamp so the caller
        // still gets a sane radius instead of a NaN out of the sqrt.
        const half = Math.abs(dy) >= 1 ? 0 : a * Math.sqrt(1 - dy * dy);
        return baseR + a - half;
    }
    // Raised bank around each lake - a torus, half-buried so only the upper
    // half shows. Its curved cross-section is what makes it walkable: the
    // outer face starts almost flat and steepens gradually, so you stroll up
    // it instead of hitting a wall, and the same curve carries you back down
    // into the water on the inside.
    // Wide and FLATTENED, not a round tube. A circular cross-section is very
    // steep at its outer edge - about 64 degrees a tenth of the way in, which
    // is well past the ~39.6-degree slide threshold, so the player would slide
    // straight back off instead of walking up, and no amount of shrinking it
    // helps because the angle profile of a circle is the same at any size.
    // Squashing it vertically turns the cross-section into an ellipse and
    // scales every angle down with it. A broad shallow bank is also closer to
    // what a real lake shore looks like.
    // The bank is a torus with an elliptical (squashed) cross-section. Only
    // the ratio flatten/1 sets the slope, so widening the tube while keeping
    // the crest height buys walk-up margin. Sinking it steepens the foot -
    // the exposed face starts further up the ellipse - which is why the tube
    // got wider when the sink went in.
    const FOREST_LAKE_RIM_TUBE = 2.4;      // horizontal half-width of the bank
    const FOREST_LAKE_RIM_FLATTEN = 0.29;  // vertical squash -> tube half-height 0.70
    const FOREST_LAKE_RIM_SINK = 0.28;     // tube centre below ground -> crest 0.42 proud
    const FOREST_LAKE_RIM_SEGS = 30;       // around the ring
    const FOREST_LAKE_RIM_TUBE_SEGS = 8;   // around the cross-section
    let forestLakeRimMaterial = null;
    let forestLakeBedMaterial = null;
    let forestLakeBody = null;
    // Foam is opt-in PER MATERIAL - applyShorelineFoam injects the band into
    // whatever it is given, and a material that never got it simply cannot
    // show one no matter how the water is set up. Only buildWaterTestLevel
    // was calling it, so the forest lakes had no foam anywhere: not on the
    // characters wading through, not on the bank.
    //
    // Called every frame while the forest is up rather than once at build
    // time, because the avatars' materials do not exist until their FBX
    // finishes loading - which is usually after the level is built, and for
    // the companion/bot can be much later. applyShorelineFoam early-outs on
    // an already-treated material, so the steady-state cost is a handful of
    // boolean checks.
    function applyForestFoam() {
        const avatars = [char, ...companions.map(r => r.comp), ...aiBots.map(r => r.bot)];
        for (let i = 0; i < avatars.length; i++) {
            const a = avatars[i];
            if (!a || !a.bodyMaterials) continue;
            a.bodyMaterials.forEach(m => applyShorelineFoam(m, { objScale: window.charFoamScale, trackGlobal: 'charFoamScale' }));
        }
        // The ground itself, which is what draws the wet ring where the
        // lake meets the grass.
        if (ground && ground.material) applyShorelineFoam(ground.material);
    }
    function pickForestLakes(half, noiseScale) {
        const lakes = [];
        for (let i = 0; i < 500 && lakes.length < FOREST_LAKE_COUNT; i++) {
            const x = (forestHash01(i * 7.31, i * 2.17) - 0.5) * 2 * (half - 12);
            const z = (forestHash01(i * 3.97, i * 5.73) - 0.5) * 2 * (half - 12);
            // Never on the spawn pocket - you would start in the water.
            if (Math.hypot(x, z) < window.forestClearingRadius + 8) continue;
            // Never straddling the chasm either. Measured against the BANK's
            // full reach, not the water's: the torus extends FOREST_LAKE_BANK
            // past the lake radius, and half a torus hanging over a drop is
            // worse than half a lake.
            if (Math.abs(x - FOREST_GAP_X) < FOREST_LAKE_MAX_R + FOREST_LAKE_BANK + FOREST_GAP_W) continue;
            // Only where the noise says the wood is open.
            const n = perlin2((x + window.forestSeed) / noiseScale, (z + window.forestSeed) / noiseScale);
            if (n >= window.forestTreeThreshold) continue;
            const r = FOREST_LAKE_MIN_R + forestHash01(x * 1.7, z * 2.3) * (FOREST_LAKE_MAX_R - FOREST_LAKE_MIN_R);
            let clash = false;
            for (let k = 0; k < lakes.length; k++) {
                if (Math.hypot(x - lakes[k].x, z - lakes[k].z) < r + lakes[k].r + 10) { clash = true; break; }
            }
            if (clash) continue;
            lakes.push({ x, z, r });
        }
        return lakes;
    }

    let _forestMaskTex = null;
    const FOREST_MASK_RES = 256;
    const FOREST_MASK_FEATHER = 0.12;
    function buildForestGroundMask() {
        const res = FOREST_MASK_RES;
        const area = window.forestAreaSize;
        const noiseScale = window.forestNoiseScale;
        const threshold = window.forestTreeThreshold;
        const data = new Uint8Array(res * res * 4);
        for (let j = 0; j < res; j++) {
            for (let i = 0; i < res; i++) {
                const wx = ((i + 0.5) / res - 0.5) * area;
                const wz = ((j + 0.5) / res - 0.5) * area;
                const n = perlin2((wx + window.forestSeed) / noiseScale, (wz + window.forestSeed) / noiseScale);
                const openness = THREE.MathUtils.clamp((threshold - n) / FOREST_MASK_FEATHER, 0, 1);
                const v = Math.round(openness * 255);
                const o = (j * res + i) * 4;
                data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
            }
        }
        if (_forestMaskTex) _forestMaskTex.dispose();
        _forestMaskTex = new THREE.DataTexture(data, res, res);
        _forestMaskTex.needsUpdate = true;
        // Clamped, or the mask would tile across the whole 1000-unit plane and
        // paint paths far outside the wood.
        _forestMaskTex.wrapS = _forestMaskTex.wrapT = THREE.ClampToEdgeWrapping;
        _forestMaskTex.minFilter = _forestMaskTex.magFilter = THREE.LinearFilter;
        _groundTintUniforms.uForestMask.value = _forestMaskTex;
        _groundTintUniforms.uForestArea.value = area;
        _groundTintUniforms.uForestTintOn.value = 1;
    }

    let _forestPlacements = null;
    let _forestLakes = [];
    const _forestLakeMeshes = [];
    // Half-extent of the forest slab: past the outermost row of border trees,
    // with a margin so the edge is not flush with a trunk.
    const FOREST_BOX_MARGIN = 4;
    // Deep enough that the sides read as a land mass hanging in the void
    // rather than as a sheet of card seen edge-on. Nothing stands on the
    // underside, so the cost is six more triangles and no draw-call change.
    const FOREST_BOX_DEPTH = 40;
    // The forest is TWO masses, not one, split by a chasm running north-south.
    // FOREST_GAP_X is where the seam sits: deliberately off-centre, because the
    // spawn clearing is at the origin and a chasm through it would drop you in
    // on the first frame. That makes the two sides unequal, which is the point
    // - a main wood and a smaller shelf reads better than two matching halves.
    const FOREST_GAP_X = 18;
    // Width of the channel the river runs down. Wider than a jump now (the
    // player's flat reach is 5.33), which is fine because it is no longer a
    // drop into nothing: it has a bed you wade across. That also means there
    // is no way to strand yourself in it, which matters - there is NO fall
    // recovery anywhere in this game.
    const FOREST_GAP_W = 7.0;
    // The channel floor, and the water sitting in it.
    //
    // 3.0 deep, which is not an arbitrary "looks about right" - it is the
    // shallowest bank you can actually HANG from. A ledge grab puts the root
    // 1.85 below the lip (COMP_HANG_DROP, taken from the player's own grab)
    // and needs the 2.0 above that clear, so a 0.6 ditch left the hang
    // position underground and the grab simply never triggered. At 3.0 the
    // hanging feet still clear the bed by 1.15.
    //
    // Capped at the other end by what the AI can get back out of: a bot climbs
    // COMP_CLIMB_MAX (3.4) at most, so 3.0 leaves a little margin and both it
    // and the companion climb out the same way you do - jump, catch the lip,
    // pull up. Deeper and they would live in the river.
    const FOREST_RIVER_BED_Y = -3.0;
    const FOREST_RIVER_Y = -2.3;    // 0.7 of water to wade in at the bottom
    // The bed is cut slightly WIDER than the channel so its side faces end up
    // buried inside the land masses. Flush would put two solid faces in the
    // same plane down the whole length of the river, which z-fights.
    const FOREST_RIVER_BED_OVERLAP = 0.06;
    // Matches the Water Test sea's own plane, so the horizon reads the same.
    const FOREST_SEA_SIZE = 256;
    // The frame. Height is set to match a large tree so the wall reads as the
    // far side of the same wood rather than as an arbitrary barrier.
    const FOREST_BORDER_HEIGHT = 11;
    const FOREST_BORDER_BLOCK = 6;     // one block's footprint along the edge
    const FOREST_BORDER_CAP = 0.8;     // the earth-and-grass layer on top
    let _forestBorderMat = null, _forestBorderCapMat = null;
    // Walks every block position along the four edges, skipping the stretch
    // the strait runs out through. Shared so the trees planted on top (pass 1)
    // and the blocks themselves (pass 3a) cannot disagree about where the wall
    // is - they are built in different passes, and any drift would leave trees
    // standing on nothing.
    function forestBorderLayout(cb) {
        const bh = forestSlabHalf();
        const step = FOREST_BORDER_BLOCK;
        for (let side = 0; side < 4; side++) {
            for (let t = -bh; t <= bh + 0.01; t += step) {
                const bx = (side < 2) ? t : (side === 2 ? bh : -bh);
                const bz = (side === 0) ? bh : (side === 1 ? -bh : t);
                // The sea has to continue past the islands rather than be
                // dammed by the frame.
                if (Math.abs(bx - FOREST_GAP_X) < FOREST_GAP_W * 0.5 + step) continue;
                cb(bx, bz);
            }
        }
    }
    // How far back from the drop trees and lakes are kept, so nothing hangs
    // over the edge with its roots in the air.
    const FOREST_GAP_CLEAR = 1.6;
    let _forestGroundBoxes = [];
    // Where the land ends and the void begins. Shared with the barrier walls,
    // which now sit just inside it - with the border trees gone there is
    // nothing else out there to be stopped by, and being stopped at a visible
    // cliff edge reads far better than being stopped in open grass.
    function forestSlabHalf() {
        return window.forestAreaSize * 0.5 + FOREST_BOX_MARGIN;
    }
    function buildForestGroundBox() {
        const half = forestSlabHalf();
        _forestGroundBoxes = [];
        // [xMin, xMax] of each mass, either side of the chasm.
        const spans = [
            [-half, FOREST_GAP_X - FOREST_GAP_W * 0.5],
            [FOREST_GAP_X + FOREST_GAP_W * 0.5, half],
        ];
        spans.forEach(([x0, x1]) => buildForestSlab(x0, x1, -half, half));
        // The SEABED - one floor under the whole sea, not just under the
        // channel. It is what makes falling off an island survivable rather
        // than a bottomless drop, and it puts the strait and the open water on
        // the same bottom, because they are the same sea.
        //
        // Its top sits FOREST_RIVER_BED_Y down, which makes every island edge
        // a 3.0 wall: tall enough for the player to hang from (a grip is 1.85
        // below its lip) and just inside what a bot can climb back out of
        // (COMP_CLIMB_MAX 3.4). Those two numbers are why it is 3.0 and not
        // something rounder.
        const seaHalf = FOREST_SEA_SIZE * 0.5;
        buildForestSlab(-seaHalf, seaHalf, -seaHalf, seaHalf, FOREST_RIVER_BED_Y);

        // The sea. Not a river-shaped strip any more: it is the SAME body of
        // water inside the channel and out past the ends of the islands, so it
        // is one big plane on the Water Test level's own sea material, and the
        // land is simply what pokes above it. Sized like that sea (256) so it
        // runs to the horizon in every direction - the two slabs read as
        // islands in it, and the channel between them as the strait you cross.
        defaultWaterBody.uniforms.uFoamEnabled.value = 1;
        const sea = new THREE.Mesh(
            new THREE.PlaneGeometry(FOREST_SEA_SIZE, FOREST_SEA_SIZE), defaultWaterBody.waterMaterial);
        sea.rotation.x = -Math.PI / 2;
        sea.position.set(0, FOREST_RIVER_Y, 0);
        levelGroup.add(sea);
        // NOT a collidable - you wade and swim through it, exactly as with the
        // lakes, and adding it would make it read as a floor to every ground
        // scan in the game.
        linkWaterMeshToBody(sea, defaultWaterBody);
    }
    function buildForestSlab(x0, x1, z0, z1, topY = 0) {
        const sx = x1 - x0, sz = z1 - z0;
        // Every slab's underside sits at the same depth, so a lowered one (the
        // river bed) is shorter rather than hanging below the rest.
        const depth = FOREST_BOX_DEPTH + topY;
        const geo = new THREE.BoxGeometry(sx, depth, sz);
        // BoxGeometry's uv runs 0..1 per face, and the ground texture repeats
        // 150x - which across a face this size would be a tile per metre
        // instead of the plane's one per 6.67. Remapping the uv to
        // worldXZ/1000 reproduces the plane's exact texel density, since that
        // plane is 1000 units wide with the same repeat.
        //
        // World coordinates, not each slab's own 0..1: the two masses are
        // different widths and sit at different offsets, so a per-face uv would
        // restart the pattern at each slab's edge and the grass would visibly
        // change scale and phase across the chasm.
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
            uv.setXY(i,
                (uv.getX(i) * sx + x0) / 1000,
                (uv.getY(i) * sz + z0) / 1000);
        }
        uv.needsUpdate = true;
        // Sides get their own plain material - the ground material carries the
        // forest path tint and the shoreline foam, both of which are keyed off
        // world XZ and would smear down a vertical face.
        if (!_forestBoxSideMaterial) {
            _forestBoxSideMaterial = new THREE.MeshToonMaterial({ color: 0x6b5433, gradientMap: threeTone });
            // The sides ARE the river banks - the channel is cut into them -
            // so they need the waterline band. Everywhere else on the slab
            // this is a cliff face hundreds of units from any water, and the
            // per-fragment footprint test (see foamSharedUniforms) keeps the
            // band off it.
            applyShorelineFoam(_forestBoxSideMaterial);
        }
        // BoxGeometry group order is +x, -x, +y, -y, +z, -z - index 2 is the
        // top. Grass on the land masses; the river bed is underwater, so it
        // takes the same earth material as the banks around it.
        const topMat = topY < 0 ? _forestBoxSideMaterial : ground.material;
        const mats = [
            _forestBoxSideMaterial, _forestBoxSideMaterial, topMat,
            _forestBoxSideMaterial, _forestBoxSideMaterial, _forestBoxSideMaterial,
        ];
        const slab = new THREE.Mesh(geo, mats);
        // Top face flush with y=0, where the plane used to be, so nothing else
        // in the level has to move.
        slab.position.set((x0 + x1) * 0.5, topY - depth / 2, (z0 + z1) * 0.5);
        slab.receiveShadow = true;
        slab.castShadow = false;
        // The forest's floor. Its Box3 runs 40 units DOWN, so the grass
        // scatter's overhang test would read every point on the island as
        // standing under something and reject the lot - the same trap the tree
        // colliders hit. This says "I am the ground, not a thing above it".
        slab.userData.isGroundSlab = true;
        slab.updateMatrixWorld(true);
        levelGroup.add(slab);
        // Takes the plane's place as the level's floor - every ground scan,
        // foot IK probe and climb check reads this array.
        collidables.push(slab);
        _forestGroundBoxes.push(slab);
    }
    let _forestBoxSideMaterial = null;
    // Makes the lake surface actually LOOK like it is rising.
    //
    // The water material already bobs the disc vertically (uWaveAmplitude in
    // createStylizedWaterMaterial's vertex shader) and the foam band already
    // tracks that same sine - they were never out of sync. The problem is that
    // you cannot SEE a flat disc move 5cm: its edge is buried in the bank, so
    // the only visible waterline is where the water meets the shore, and on a
    // fixed-radius disc that contact ring never moves. The foam band, being
    // computed from world height, slides 0.54 up and down the slope over a
    // cycle - so the foam visibly climbed while the water sat still.
    //
    // ONE source of truth for the level, and it is this function.
    //
    // The wave used to be computed in three places off the same numbers: the
    // water material's vertex shader bobbed the disc, the foam shader added
    // its own sine to the waterline, and this widened the disc. All three
    // agreed on paper, but the disc's height came from the GPU while its
    // radius came from the CPU, and the foam uniforms were uploaded at a
    // different point in the frame from this call - so the contact ring and
    // the foam band could sit at heights that disagreed by a frame's worth of
    // wave, which is exactly the strip of bare bank between the water and its
    // foam. Three clocks that only happen to match is a bug waiting for a
    // reordering.
    //
    // Now the body is created with waveAmplitude 0, which switches OFF both
    // the shader bob and the foam's own sine, and the height is set here on
    // mesh.position.y. The foam reads uWaterLevel straight off that position
    // (see waterMeshSyncs), so the band is pinned to wherever the surface
    // actually is, by construction rather than by coincidence.
    //
    // Scaled rather than rebuilt: the geometry is authored in local XY (it is
    // rotated flat), so x/y scale the radius. z is untouched.
    const FOREST_LAKE_WAVE_SPEED = 0.5;
    const FOREST_LAKE_WAVE_AMP = 0.06;
    function updateForestLakeSurfaces() {
        if (!_forestLakeMeshes.length) return;
        const wave = Math.sin(clock.elapsedTime * FOREST_LAKE_WAVE_SPEED) * FOREST_LAKE_WAVE_AMP;
        const y = FOREST_LAKE_Y + wave;
        for (let i = 0; i < _forestLakeMeshes.length; i++) {
            // Height ONLY. The radius used to be re-fitted to the bank every
            // frame as well, which was both unnecessary and the source of a
            // visible gap: the disc's edge and the foam band were two separate
            // calculations of the same waterline, and they only had to
            // disagree by a fraction for a ring of dry bank to open between
            // them. Sized once for the top of the wave (see fillR), the disc
            // always reaches past the contact ring and the bank hides the
            // rest, so there is nothing left to disagree about.
            _forestLakeMeshes[i].mesh.position.y = y;
        }
    }

    function buildVillageLevel() {
        if (!villageScene || !treeModel || !mountainGeometry) { pendingVillageLevelBuild = true; return; }
        while (levelGroup.children.length > 0) levelGroup.remove(levelGroup.children[0]);
        shooters.forEach(s => scene.remove(s.mesh)); shooters.length = 0;
        projectiles.forEach(p => scene.remove(p.mesh)); projectiles.length = 0;
        carryables.forEach(c => { if (c.debugHelper) scene.remove(c.debugHelper); });
        carryables.length = 0;
        nextCarryNetId = 0;
        debugHelpers.forEach(h => scene.remove(h)); debugHelpers.length = 0;
        collidables.length = 0;

        // The loading overlay (see animate()) waits on window._cubesLoaded,
        // which is normally only set by buildStairsLevel()'s loadCubesProp()
        // call - this level has no such prop, so without this the overlay
        // never hides and the game looks stuck at "Loading..." forever.
        window._cubesLoaded = true;

        // Kicked off now (fire-and-forget) rather than only on first
        // Viewer-open, so window.compassIconDataUrl is normally already
        // there by the time the player's dialogue reaches the line that
        // wants it - see updateDialogueIconForCurrentLine's graceful
        // fallback (hides the icon slot) for the rare case it isn't yet.
        loadCompassObject(() => {});

        // Unlike Level 2/Water Test, this whitebox's own floor blocks sit
        // well above y=0 in most places and don't form a continuous
        // floor - the generic grass ground plane (left visible, see
        // buildLevel()'s own default) shows through the gaps around/under
        // them instead of clashing, AND has to be pushed back into
        // `collidables` here (the line above just wiped it) so it's
        // actually solid ground wherever the whitebox itself has no floor
        // prop - without this, the NPC's own ground-snap raycast below
        // (and the player, walking off the edge of any explicit block)
        // found nothing there and fell back to a floating guess.
        collidables.push(ground);

        villageScene.traverse(o => {
            if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; collidables.push(o); }
        });
        levelGroup.add(villageScene);
        villageScene.updateMatrixWorld(true);

        // Whitebox trees (a trunk "Cyl_6" cylinder + 4 "Sphere_7" foliage
        // blobs, grouped under nodes named "tree_8"/"tree_12"/etc - or
        // "Entity_1" for one of them, so detected by that child shape
        // rather than by name) are placeholder geometry from the original
        // whitebox pass - swapped here for real Tree.glb clones at the
        // same ground position/facing the modeler already placed them at.
        const treeProxyGroups = [];
        villageScene.traverse(o => {
            if (!o.children || o.children.length < 2) return;
            const hasTrunk = o.children.some(c => c.name && c.name.startsWith('Cyl_6'));
            const foliageCount = o.children.filter(c => c.name && c.name.startsWith('Sphere_7')).length;
            if (hasTrunk && foliageCount >= 3) treeProxyGroups.push(o);
        });
        treeProxyGroups.forEach(group => {
            const pos = new THREE.Vector3();
            const quat = new THREE.Quaternion();
            group.getWorldPosition(pos);
            group.getWorldQuaternion(quat);
            const rotY = new THREE.Euler().setFromQuaternion(quat, 'YXZ').y;

            // Ground height: the whitebox placeholder's own real-world
            // bounding-box min.y is exactly the height the level author
            // already visually tuned this tree to sit at. A downward
            // raycast (tried first, same technique the NPC placement below
            // uses) turned out unreliable here - the village's own floor
            // mesh has gaps it doesn't cover, so the ray shoots past
            // everything down to the generic flat fallback ground plane at
            // y=0, far below where these trees actually belong (confirmed
            // via an on-screen debug dump: groundY was landing at 0.00
            // against a proxy position around 4.5-4.7).
            const proxyBox = new THREE.Box3().setFromObject(group);
            const groundY = proxyBox.min.y;

            // Pulls this proxy's own meshes out of collidables (already
            // pushed by the traverse above) before detaching it, so no
            // invisible leftover collision volume is left where the
            // placeholder used to be.
            group.traverse(c => {
                if (c.isMesh) {
                    const idx = collidables.indexOf(c);
                    if (idx !== -1) collidables.splice(idx, 1);
                }
            });
            if (group.parent) group.parent.remove(group);

            const tree = treeModel.clone(true);
            tree.rotation.y = rotY;
            // No bounding-box base offset here (an earlier attempt
            // subtracted box.min.y to "ground" the model's own lowest
            // point) - Tree.glb's own scene-root origin already sits
            // essentially at its base (its local bounding-box minimum is
            // only about -1.3 units below origin, read as the roots
            // dipping slightly below the trunk's nominal base, which looks
            // normal rather than "floating"). Subtracting that offset on
            // top of groundY was adding an unwanted extra lift, which is
            // what was actually causing the floating look.
            tree.position.set(pos.x, groundY, pos.z);
            // Forces this clone's whole ancestor chain to actually reflect
            // the placement just set above before the Box3 below reads it.
            // Box3.expandByObject calls object.updateWorldMatrix(false,
            // false) - updateParents=false - so it trusts each ancestor's
            // existing matrixWorld rather than recomputing it, and this
            // freshly-cloned tree has never been through a render pass, so
            // every node's matrixWorld is still stuck at the identity
            // default. Without this, the BaseTreeLeaveBunch dither-probe
            // sphere below (bc/bs) is computed against that stale identity
            // chain and lands near local (0,0,0) instead of this tree's
            // real spot - it would only ever trigger for a player standing
            // near whatever coordinate that stale chain happens to work out
            // to, not near this actual tree.
            tree.updateMatrixWorld(true);
            tree.traverse(c => {
                if (!c.isMesh) return;
                // Visual-only parts (the "leave" fringe and the
                // BaseTreeLeaveBunch lower mass - see isTreeVisualOnly) are
                // kept OUT of collidables entirely. collidables is what
                // every raycast in the game probes (ground scan, foot IK,
                // wall checks, ledge hang clearance, grass/flower
                // placement), so leaving decoration in there means thousands
                // of triangles answering rays that should only ever see the
                // solid tree. What stays collidable is the trunk and the
                // four upper canopy chunks - the surfaces meant to be walked
                // and climbed on.
                const visualOnly = isTreeVisualOnly(c);
                // Still a separate call from the collision one even though the
                // two now happen to exclude the same parts - the trunk
                // collides but does not cast, so the rules are not
                // interchangeable. See treeCastsShadow.
                const mats = Array.isArray(c.material) ? c.material : [c.material];
                c.castShadow = treeCastsShadow(c);
                c.receiveShadow = true;
                if (visualOnly) {
                    const cosmetic = mats.some(m => m && m.userData && m.userData.isCosmeticLeaf);
                    if (cosmetic) {
                        // The fringe answers nothing at all - belt and braces
                        // alongside the collidables skip, since a raycast
                        // aimed at the scene graph rather than at collidables
                        // would otherwise still hit it.
                        c.raycast = () => {};
                    } else {
                        // BaseTreeLeaveBunch: still no collision and no
                        // raycast, but the dither probe has to know it is
                        // there or the part most likely to be hiding the
                        // player never triggers the dissolve. Registered as a
                        // plain sphere, same as the forest canopies.
                        c.raycast = () => {};
                        const bb = new THREE.Box3().setFromObject(c);
                        const bc = bb.getCenter(new THREE.Vector3());
                        const bs = bb.getSize(new THREE.Vector3());
                        ditherProbeSpheres.push({ x: bc.x, y: bc.y, z: bc.z, r: 0.5 * Math.max(bs.x, bs.z) });
                    }
                    return;
                }
                // Same exemption the forest colliders get - a canopy chunk's
                // bounding box is nothing like its actual shape, so it must
                // not veto standing spots. See isVerticalSpaceClear.
                c.userData.softObstacle = true;
                c.userData.isTreeCollider = true;
                collidables.push(c);
            });
            levelGroup.add(tree);
        });

        // Whitebox mountains ("Cyl 16" + its copies - a 231-vertex cone each,
        // all sharing one mesh, scattered along the horizon at scales from 64
        // to 136) swapped for mountains.glb clones, the same trade the trees
        // just went through. Matched by name: unlike the tree proxies there is
        // no distinctive child structure to detect them by, but "Cyl 16" is
        // used for nothing else in the file.
        //
        // Captured ONCE, into a cache that survives rebuilds. Detaching the
        // proxies mutates villageScene permanently, but villageScene is loaded
        // once and re-added to a levelGroup that gets wiped on every build - so
        // reading the proxies fresh each time would find them on the first
        // entry and nothing at all on the second, and the mountains would
        // simply stop appearing after you left the village and came back.
        if (!_villageMountainPlacements) {
            _villageMountainPlacements = [];
            const mountainProxies = [];
            villageScene.traverse(o => {
                if (o.isMesh && o.name && o.name.startsWith('Cyl_16')) mountainProxies.push(o);
            });
            mountainProxies.forEach(proxy => {
                const pos = new THREE.Vector3();
                const quat = new THREE.Quaternion();
                const scale = new THREE.Vector3();
                proxy.updateWorldMatrix(true, false);
                proxy.matrixWorld.decompose(pos, quat, scale);
                _villageMountainPlacements.push({ pos, scale });
                if (proxy.parent) proxy.parent.remove(proxy);
            });
        }
        _villageMountainPlacements.forEach((placement, idx) => {
            const pos = placement.pos, scale = placement.scale;
            // The proxy cone and the mountain share the same local frame -
            // both authored y:[0,1] with the base on the origin plane and
            // roughly unit radius - so the proxy's own scale carries straight
            // across and the new peak stands exactly as tall, and on exactly
            // the same ground line, as the one it replaces. The mountain
            // reaches a little further on +x/+z (local max 1.42/1.25 against
            // the cone's 1.02/1.0), which just makes it a touch broader.
            const mountain = new THREE.Mesh(mountainGeometry, mountainMaterial);
            mountain.position.copy(pos);
            mountain.scale.copy(scale);
            // Yaw only. The proxies are all axis-aligned, which on identical
            // cloned geometry means five copies of the same silhouette in a
            // row - the same "every tree faces one way" problem the forest
            // had. Spread around the circle by index, offset by the author's
            // own second instance (-94 degrees) so the two shapes they placed
            // by hand still read the way they intended.
            mountain.rotation.y = -1.642 + idx * (Math.PI * 2 / _villageMountainPlacements.length);
            mountain.castShadow = false;
            mountain.receiveShadow = false;
            // NOT collidable, and not answering raycasts either. These sit
            // 100-220 units out and 21 below the play area, purely a skyline;
            // the proxies were in collidables only because the blanket traverse
            // at the top of this function sweeps up every mesh in the file.
            // Putting the detailed versions back would be strictly worse - 1888
            // vertices each against the cone's 231, sitting in the array that
            // every ground scan, foot IK probe and ledge check reads.
            mountain.raycast = () => {};
            mountain.updateMatrixWorld(true);
            levelGroup.add(mountain);
        });

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
        villageNpcBubble.position.set(0, 3.1, 0);
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
    const dialogueTapCatcherEl = document.getElementById('dialogue-tap-catcher');
    const dialogueTextEl = document.getElementById('dialogue-text');
    const dialogueContinueEl = document.getElementById('dialogue-continue');
    const dialogueIconEl = document.getElementById('dialogue-icon');
    // Shows/hides the icon for whichever line is current - called on both
    // start and every advance. Silently no-ops (hides) if that line wants
    // an icon that isn't ready yet (e.g. CompassObject.glb still loading) -
    // see loadCompassObject, kicked off proactively in buildVillageLevel
    // so it's normally ready well before the player reaches this line.
    function updateDialogueIconForCurrentLine() {
        if (!dialogueIconEl) return;
        const iconKey = VILLAGE_DIALOGUE_LINES[villageDialogueLineIndex].icon;
        const url = iconKey ? dialogueIconUrlFor(iconKey) : null;
        if (url) {
            dialogueIconEl.src = url;
            // Height only - the icon PNG is cropped to its own opaque
            // bounds (generateIconFromObject), so it carries the object's
            // real aspect ratio and forcing it square would squash it.
            dialogueIconEl.style.height = (window.iconSize || 40) + 'px';
            dialogueIconEl.style.width = 'auto';
            dialogueIconEl.style.display = 'inline-block';
        } else { dialogueIconEl.style.display = 'none'; }
    }
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
        updateDialogueIconForCurrentLine();
        if (dialogueBoxEl2) dialogueBoxEl2.style.display = 'block';
        if (dialogueTapCatcherEl) dialogueTapCatcherEl.style.display = 'block';
        // Clears the joysticks/buttons out from under your hands during
        // the conversation - same helper the editor toggle already uses.
        setGameControlsVisible(false);

        // The player is deliberately NOT re-aimed here. Snapping them to
        // face the NPC was tried and rejected: you already walk up to the
        // NPC facing them, so the snap only ever fires when the approach
        // angle differed slightly - and then it reads as the character
        // spinning on the spot for no reason the player can see. Freezing
        // whatever facing they walked in with is both stiller and closer to
        // what actually happens. Only the NPC turns (they're the one being
        // addressed, and they're far enough away for it to read as natural).
        const toNpc = new THREE.Vector3().subVectors(villageNpcAvatar.group.position, char.group.position);
        toNpc.y = 0;
        toNpc.normalize();
        villageNpcAvatar.group.rotation.y = Math.atan2(-toNpc.x, -toNpc.z);
        // Held for the whole conversation (re-applied every frame in the
        // dialogue camera block in animate) - capturing it once isn't
        // enough, since several later systems write to char.group.quaternion
        // and would otherwise drift the character while they "stand still".
        window._dialogueFacingQuat = char.group.quaternion.clone();
        const side = new THREE.Vector3(-toNpc.z, 0, toNpc.x); // player's right
        // Borrows the normal follow-cam's own distance/height (cameraRadius/
        // cameraPhi) rather than hand-tuned constants. The offsets below are
        // deliberately MOSTLY-BEHIND (0.8) with only a modest sideways step
        // (0.6): a side offset larger than the behind offset puts the camera
        // beside the player instead of behind them, which shows the player in
        // profile and reads as "the player is turned the wrong way" even
        // when they are, in fact, squarely facing the NPC.
        // window.dialogueCamZoom scales all three components together, so it
        // can only change how CLOSE the shot is, never the angle it looks
        // from. Wrapped in a re-runnable function so the panel slider can
        // recompute the framing live, mid-conversation.
        window._recomputeDialogueCam = () => {
            if (!villageNpcAvatar) return;
            const zoom = window.dialogueCamZoom || 0.35;
            const horiz = cameraRadius * Math.sin(cameraPhi) * zoom;
            const height = (cameraRadius * Math.cos(cameraPhi) + 1.5) * zoom;
            window._dialogueCamPos = char.group.position.clone()
                .addScaledVector(toNpc, -horiz * 0.8)
                .addScaledVector(side, horiz * 0.6)
                .add(new THREE.Vector3(0, height, 0));
            window._dialogueCamTarget = new THREE.Vector3()
                .lerpVectors(char.group.position, villageNpcAvatar.group.position, 0.5)
                .add(new THREE.Vector3(0, 1.5, 0));
        };
        window._recomputeDialogueCam();
        // Deliberately NOT snapped into place - the camera eases across from
        // wherever the gameplay follow-cam was (see the dialogue block in
        // animate, which lerps both the position AND the look-at point at
        // window.dialogueCamEase). Starting the look-at pan from null makes
        // that block seed it from the live follow-cam target on its first
        // frame, so the pan begins exactly where the player was looking.
        window._dialogueCamLookNow = null;
    }
    function updateVillageDialogueTypewriter(delta) {
        if (villageTypewriterDone) return;
        const rate = VILLAGE_TYPEWRITER_CPS * (villageDialogueFastForward ? VILLAGE_TYPEWRITER_FAST_MULT : 1);
        villageTypewriterProgress += rate * delta;
        const line = VILLAGE_DIALOGUE_LINES[villageDialogueLineIndex].text;
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
            updateDialogueIconForCurrentLine();
        }
    }
    function endVillageDialogue() {
        villageDialogueActive = false;
        window.dialogueInputLocked = false;
        if (dialogueBoxEl2) dialogueBoxEl2.style.display = 'none';
        if (dialogueTapCatcherEl) dialogueTapCatcherEl.style.display = 'none';
        setGameControlsVisible(true);
        // Without this, the normal follow-cam resumes from cameraTheta/Phi -
        // whatever they were BEFORE dialogue started, since dialogue drove
        // camera.position directly and never touched them. That reads as the
        // camera whipping to a different angle the instant the conversation
        // ends. Resyncing them from where the camera actually is right now
        // (see resyncCameraFollowFromCurrentPosition's own comment - same
        // fix, same reason, for editor-mode exit) means gameplay picks up
        // from the exact angle the dialogue camera ended at.
        //
        // cameraRadius AND cameraPhi are deliberately restored right after.
        // Neither was ever touched during dialogue (the dialogue camera
        // drives camera.position directly, ignoring the orbit vars
        // entirely), so both are still whatever the player's normal
        // gameplay view was before the conversation started - but resync
        // would overwrite both with the DIALOGUE camera's own numbers
        // (much closer, and a shallower pitch from the low OTS height).
        // That shallow pitch is a second, sneakier way to stay "zoomed in":
        // it lands close to the near-horizontal end of the orbit range,
        // which a separate, pre-existing system (the closeStartElevation
        // logic further down) deliberately pulls the camera in close for -
        // so restoring radius alone still read as stuck-zoomed. Only
        // cameraTheta (which way the camera faces horizontally) is kept
        // from the resync; that's the actual "same angle" continuity that
        // was asked for. Restoring the rest lets the existing follow-cam
        // lerp smoothly ease back out to the player's real zoom/pitch.
        const preDialogueCameraRadius = cameraRadius;
        const preDialogueCameraPhi = cameraPhi;
        resyncCameraFollowFromCurrentPosition();
        cameraRadius = preDialogueCameraRadius;
        cameraPhi = preDialogueCameraPhi;
        window._dialogueCamPos = null;
        window._dialogueCamTarget = null;
        window._dialogueCamLookNow = null;
        window._dialogueFacingQuat = null;
        window._recomputeDialogueCam = null;
        if (!villageQuestGiven) {
            villageQuestGiven = true;
            // window.playerIconDataUrl only exists once the Viewer has been
            // opened at least once (lazy-loaded) - undefined is fine here,
            // the toast just shows text-only until then.
            addNotificationToast('New Quest: The Lost Apprentice', window.playerIconDataUrl);
            if (window.villageForestEntrance) window.compassTarget = window.villageForestEntrance;
        }
    }
    // Same handlers on the box AND on the full-screen catcher behind it, so
    // a tap anywhere on the screen advances/fast-forwards - the box itself
    // is a small target, especially on a phone.
    const stopFastForward = () => { villageDialogueFastForward = false; };
    const onDialogueTapDown = (e) => {
        e.preventDefault();
        if (!villageDialogueActive) return;
        if (villageTypewriterDone) advanceVillageDialogueLine();
        else villageDialogueFastForward = true;
    };
    [dialogueBoxEl2, dialogueTapCatcherEl].forEach(el => {
        if (!el) return;
        el.addEventListener('pointerdown', onDialogueTapDown);
        el.addEventListener('pointerup', stopFastForward);
        el.addEventListener('pointercancel', stopFastForward);
        el.addEventListener('pointerleave', stopFastForward);
    });

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
        makeLevelOccluder(ramp, { grass: true });

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
        makeLevelOccluder(lower);

        const upper = new THREE.Mesh(boxGeoTemplate, platMat);
        upper.position.set(x, cubeSize + gap + cubeSize/2, z);
        upper.castShadow = true; upper.receiveShadow = true;
        levelGroup.add(upper); collidables.push(upper);
        makeLevelOccluder(upper);
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
            if (window.rebuildFlowers) window.rebuildFlowers();
        });
    }

    // Drops one real Tree.glb clone at a fixed spot, wired up exactly like a
    // village/forest tree: visual-only fringe/Base excluded from collision
    // and raycast (isTreeVisualOnly), the walkable trunk+canopy chunks
    // pushed into collidables as a softObstacle (so they don't veto standing
    // spots the way a plain AABB obstacle would), shadow rules split the
    // same way (treeCastsShadow), and the Base gets an analytic dither-probe
    // sphere since it carries no collidable mesh for the probe to see. Not
    // instanced (unlike the forest) - a handful of standalone trees don't
    // need InstancedMesh's draw-call savings, and a plain clone keeps each
    // one an independent, individually-placed Object3D.
    function spawnStandaloneTree(x, z, rotY = 0, scale = 1) {
        if (!treeModel) return null;
        const tree = treeModel.clone(true);
        tree.rotation.y = rotY;
        tree.scale.setScalar(scale);
        tree.position.set(x, 0, z);
        // Box3.setFromObject below reads c.parent.matrixWorld as-is rather
        // than recomputing it (Box3.expandByObject calls
        // object.updateWorldMatrix(false, false) - updateParents=false), and
        // this clone has never been through a render pass, so every
        // ancestor's matrixWorld is still the identity default from
        // Object3D's constructor. Without this call the Base's world box
        // would be computed against that stale identity chain - ignoring
        // the position/rotation/scale just set above entirely - so the
        // dither probe sphere lands near local (0,0,0) instead of this
        // tree's actual spot.
        tree.updateMatrixWorld(true);
        tree.traverse(c => {
            if (!c.isMesh) return;
            const visualOnly = isTreeVisualOnly(c);
            c.castShadow = treeCastsShadow(c);
            c.receiveShadow = true;
            if (visualOnly) {
                const mats = Array.isArray(c.material) ? c.material : [c.material];
                const cosmetic = mats.some(m => m && m.userData && m.userData.isCosmeticLeaf);
                c.raycast = () => {};
                if (!cosmetic) {
                    const bb = new THREE.Box3().setFromObject(c);
                    const bc = bb.getCenter(new THREE.Vector3());
                    const bs = bb.getSize(new THREE.Vector3());
                    ditherProbeSpheres.push({ x: bc.x, y: bc.y, z: bc.z, r: 0.5 * Math.max(bs.x, bs.z) });
                }
                return;
            }
            c.userData.softObstacle = true;
            c.userData.isTreeCollider = true;
            collidables.push(c);
        });
        levelGroup.add(tree);
        return tree;
    }

    // Wraps a static level prop so it can dissolve when it ends up between the
    // camera and the player - the same screen-door dither placeCube already
    // gives player-built blocks, just extended to the level's own geometry
    // (stairs, ramps, the walkway, turrets, the hemisphere). Clones the
    // material first rather than dithering the one passed in: stair steps,
    // ramps and walkway slabs all share one platMat instance, and
    // updateDitherOccluders drives each occluder's fade off its OWN
    // material.userData.ditherUniform - if many meshes pointed at the same
    // material they'd all be fighting over the same uniform, and whichever
    // one's turn came last in that frame's loop would win, stomping every
    // other object using that material. A per-mesh clone gives each one an
    // independent uniform so they fade in/out on their own.
    function makeLevelOccluder(mesh, opts) {
        mesh.material = mesh.material.clone();
        // BEFORE makeDitherable, and on the CLONE rather than on the shared
        // platMat. Both of these chain onBeforeCompile using the same
        // replace-the-include-and-re-insert-it pattern, so they stack in
        // either order - but Material.clone() does not carry an
        // onBeforeCompile across, so anything applied to the source material
        // would be silently lost here.
        if (opts && opts.grass) applyTriplanarGrass(mesh.material);
        makeDitherable(mesh.material);
        ditherOccluders.push(mesh);
        return mesh;
    }

    // ---- Triplanar grass ----
    // Projects the terrain's own grass texture onto a mesh from world space
    // instead of from its uv, and blends by the world normal: grass on
    // anything facing up, earth down the sides.
    //
    // World-projected because these are RoundedBoxGeometry blocks and ramps
    // whose uv is per-face 0..1 - mapping a texture through that stretches it
    // to whatever each face happens to measure, so a tall block and a thin
    // slab would show grass at completely different scales, and a ramp's
    // sloped face would show it stretched along the slope. Sampling by world
    // position gives every surface in the level the same texel density
    // regardless of shape, and neighbouring blocks line up.
    //
    // Live-tunable, following the panel convention - see the globals below.
    window.triGrassScale = 0.16;    // world units -> uv; smaller = bigger blades
    window.triGrassUpStart = 0.35;  // normal.y where earth starts turning to grass
    window.triGrassUpEnd = 0.72;    // ...and where it is fully grass
    window.triGrassSharpness = 4.0; // how hard the three projections cut over
    const _triGrassUniforms = {
        uTriMap: { value: groundTex },
        uTriScale: { value: window.triGrassScale },
        uTriUp0: { value: window.triGrassUpStart },
        uTriUp1: { value: window.triGrassUpEnd },
        uTriSharp: { value: window.triGrassSharpness },
        // Sides are the same grass texture pushed toward earth rather than a
        // second texture - one sampler, and the two always match in scale and
        // pattern, which is what makes the transition read as one surface.
        uTriSideTint: { value: new THREE.Color(0x9c7b4e) },
        uTriTopTint: { value: new THREE.Color(0xffffff) },
    };
    function applyTriplanarGrass(material) {
        if (!material || material.userData.hasTriplanarGrass) return;
        material.userData.hasTriplanarGrass = true;
        const prev = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (prev) prev(shader, renderer);
            Object.assign(shader.uniforms, _triGrassUniforms);
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', `#include <common>
                    varying vec3 vTriWorld;
                    varying vec3 vTriNormal;`)
                .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
                    vTriNormal = normalize(mat3(modelMatrix) * objectNormal);`)
                // Same anchor applyShorelineFoam uses, for the same reason:
                // <skinning_vertex> runs in every material's template and
                // `transformed` is the posed vertex, where `position` at
                // <begin_vertex> would be the bind pose.
                .replace('#include <skinning_vertex>', `#include <skinning_vertex>
                    vTriWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', `#include <common>
                    varying vec3 vTriWorld;
                    varying vec3 vTriNormal;
                    uniform sampler2D uTriMap;
                    uniform float uTriScale, uTriUp0, uTriUp1, uTriSharp;
                    uniform vec3 uTriSideTint, uTriTopTint;`)
                .replace('#include <map_fragment>', `#include <map_fragment>
                    {
                        vec3 triN = normalize(vTriNormal);
                        // Blend weights from the normal, sharpened so the
                        // three projections cut over quickly instead of
                        // smearing all three across every curved surface -
                        // these are rounded boxes, and a soft blend on the
                        // fillets reads as blur.
                        vec3 triW = pow(abs(triN), vec3(uTriSharp));
                        triW /= max(triW.x + triW.y + triW.z, 1e-4);
                        vec3 triX = texture2D(uTriMap, vTriWorld.zy * uTriScale).rgb;
                        vec3 triY = texture2D(uTriMap, vTriWorld.xz * uTriScale).rgb;
                        vec3 triZ = texture2D(uTriMap, vTriWorld.xy * uTriScale).rgb;
                        vec3 triCol = triX * triW.x + triY * triW.y + triZ * triW.z;
                        // Grass only where it would actually grow. Underside
                        // faces (normal.y < 0) never qualify, so the bottom of
                        // an overhang stays earth.
                        float triUp = smoothstep(uTriUp0, uTriUp1, triN.y);
                        diffuseColor.rgb = triCol * mix(uTriSideTint, uTriTopTint, triUp);
                    }`);
        };
        // onBeforeCompile is not part of three's program cache key, so without
        // this a treated material could share a compiled program with an
        // untreated one.
        const prevKey = material.customProgramCacheKey;
        material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|triGrass';
        material.needsUpdate = true;
    }

    function buildStairsLevel() {
        rampAngleLabels.length = 0;
        stairNumberLabels.length = 0;
        const hemisphere = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: threeTone }));
        hemisphere.position.set(10, 0, -10); hemisphere.castShadow = true; hemisphere.receiveShadow = true;
        // See isOnHemisphere in the movement code.
        hemisphere.userData.isHemisphere = true;
        levelGroup.add(hemisphere); collidables.push(hemisphere);
        makeLevelOccluder(hemisphere);
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
        makeLevelOccluder(startMesh, { grass: true });

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
                makeLevelOccluder(mesh, { grass: true });

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
        makeLevelOccluder(jumpTestBlock, { grass: true });
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
            makeLevelOccluder(seg, { grass: true });
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
        makeLevelOccluder(rampEndShooter.mesh);

        buildNarrowLedgeTestRig(15, 8, 1.2);
        buildNarrowLedgeTestRig(20, 8, 0.4);
        buildNarrowLedgeTestRig(25, 8, 0);

        // A few real trees, same setup (materials/collision/shadow/dither)
        // as Village/Forest - open ground on the +Z side of spawn, clear of
        // the hemisphere (centered (10,0,-10), r=6, so entirely -Z), the
        // stair columns (x -4.5..1.5, z -10..-28), and the bump fields
        // (starting at z=20).
        spawnStandaloneTree(7, 6, 0.4);
        spawnStandaloneTree(-9, 8, 2.1);
        spawnStandaloneTree(12, 11, 4.7);
        spawnStandaloneTree(3, 13, 5.6);

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
        makeLevelOccluder(sLow.mesh);
        const sMed = new ShooterBox(levelGroup, 25, 1.0, 1.5, 'medium');
        shooters.push(sMed); collidables.push(sMed.mesh);
        makeLevelOccluder(sMed.mesh);
        const sMedHigh = new ShooterBox(levelGroup, 25, 1.0, -1.5, 'medium_high');
        shooters.push(sMedHigh); collidables.push(sMedHigh.mesh);
        makeLevelOccluder(sMedHigh.mesh);
        const sHigh = new ShooterBox(levelGroup, 25, 1.0, -4.5, 'high');
        shooters.push(sHigh); collidables.push(sHigh.mesh);
        makeLevelOccluder(sHigh.mesh);

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
                makeLevelOccluder(under, { grass: true });
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
                makeLevelOccluder(under, { grass: true });
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
        // Both lists hold per-level objects that levelGroup's wipe above just
        // detached. Deliberately NOT ditherAlwaysOnMats: the tree materials in
        // there are registered once by the Tree.glb loader and never again, so
        // clearing that list would silently kill tree dithering from the first
        // rebuild onward.
        ditherOccluders.length = 0;
        ditherProbeSpheres.length = 0;
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
        // Same reason as ground.visible and the greyscale reset above: the
        // ground is shared, so a level that tints it has to be undone by every
        // other level rather than assumed never to have happened.
        // buildForestLevel turns it back on.
        _groundTintUniforms.uForestTintOn.value = 0;
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
        const dialogueCatcherEl = document.getElementById('dialogue-tap-catcher');
        if (dialogueCatcherEl) dialogueCatcherEl.style.display = 'none';

        if (currentLevel === "local_blank") buildBlankLevel();
        else if (currentLevel === "local_stairs") buildStairsLevel();
        else if (currentLevel === "local_glb") buildLevelFromGlb();
        else if (currentLevel === "local_water") buildWaterTestLevel();
        else if (currentLevel === "local_json") buildLevelFromJson(level2Json);
        else if (currentLevel === "local_village") buildVillageLevel();
        else if (currentLevel === "local_forest") buildForestLevel();
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
        if (currentLevel === "local_water") { clearGrass(); clearFlowers(); } else { buildGrass(); buildFlowers(); }
    }

    async function populateLevelsAndLoad() {
        const select = document.getElementById('level-select');
        select.innerHTML = '<option value="local_stairs">Level 1 (Stairs)</option><option value="local_glb">Level 2 (Model)</option><option value="local_json">Level 3 (JSON)</option><option value="local_water">Water Test</option><option value="local_village">Village</option><option value="local_forest">Forest</option><option value="local_blank">Blank (UI screenshots)</option>';
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
        select.value = 'local_forest'; currentLevel = select.value;
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

    // ---- Screen-door dithering for camera occluders ----
    // Anything standing between the camera and the player dissolves into a
    // stipple pattern instead of hiding them. Chosen over real transparency
    // deliberately: a discard needs no blending, no back-to-front sorting and
    // no second render pass, so an occluder costs the same as it always did
    // apart from a few ALU ops - the only real GPU consequence is that a
    // discarding material loses early-Z, which is irrelevant for the handful
    // of blocks that are ever occluding at once.
    //
    // Ordered 4x4 Bayer rather than a noise hash: the pattern is stable
    // frame to frame, so a fading block reads as a clean stipple instead of
    // crawling static. Computed arithmetically (b2 = mod(2x + 3y, 4), then
    // the standard 4*b2(hi) + b2(lo) decomposition) because indexing a const
    // array with a non-constant index is not allowed in GLSL ES 1.00, which
    // is what three.js still emits.
    const DITHER_GLSL = `
        float _ditherB2(float x, float y){ return mod(2.0*x + 3.0*y, 4.0); }
        float _ditherBayer4(vec2 p){
            float x = mod(p.x, 4.0), y = mod(p.y, 4.0);
            float hi = _ditherB2(floor(x*0.5), floor(y*0.5));
            float lo = _ditherB2(mod(x, 2.0), mod(y, 2.0));
            return (4.0*hi + lo) / 16.0;
        }`;
    // How much of a fully-dithered occluder is discarded. Not 1.0 - leaving
    // a quarter of the pixels keeps the block's shape and edges readable, so
    // you can still judge what you are standing on/next to while seeing
    // through it.
    window.ditherStrength = 0.98;
    // Seconds to fade in/out. Snapping straight to full dither pops
    // distractingly as the camera swings past a block edge.
    window.ditherFadeSpeed = 2.0;
    // Radius of the see-through hole, in FRAMEBUFFER pixels (gl_FragCoord is
    // in framebuffer space, so this is compared against a drawing-buffer size,
    // not CSS pixels - they differ by devicePixelRatio on a phone).
    window.ditherHoleRadius = 200;
    // Where the fade from clear to solid happens, as a fraction of the radius.
    // A hard cutoff draws an obvious circle outline on the block.
    window.ditherHoleFeather = 0.50;
    // Hole on: only a soft circle around the player dissolves. Hole off: a
    // detected occluder dissolves whole, which is the cruder original
    // behaviour and mostly here to compare against. On by default - a block
    // vanishing entirely makes it hard to read what you are standing on, and
    // the hole is also what lets this work on instanced trees at all (see
    // ditherAlwaysOnMats).
    window.ditherHoleEnabled = true;
    // Shared by every dithering material - one object each, assigned into all
    // their shaders, so the per-frame update writes them once.
    const _ditherScreenUniform = { value: new THREE.Vector2(0, 0) };
    const _ditherDepthUniform = { value: 0 };
    const _ditherRadiusUniform = { value: window.ditherHoleRadius };
    const _ditherFeatherUniform = { value: window.ditherHoleFeather };
    const _ditherHoleOnUniform = { value: 1 };
    // Depth band (world units in front of the player) the dissolve ramps
    // across, so objects spanning the player's depth thin out instead of being
    // sliced. Larger = softer, but starts eating things well in front of the
    // player too.
    window.ditherDepthFade = 4.5;
    const _ditherDepthFadeUniform = { value: window.ditherDepthFade };
    // Turns a material into one that can dissolve. Returns the uniform so the
    // per-frame code can drive it; the material keeps its own reference too.
    function makeDitherable(material) {
        if (material.userData.ditherUniform) return material.userData.ditherUniform;
        const uniform = { value: 0 };
        material.userData.ditherUniform = uniform;
        const prevOnBeforeCompile = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
            shader.uniforms.uDitherAmount = uniform;
            shader.uniforms.uDitherScreen = _ditherScreenUniform;
            shader.uniforms.uDitherPlayerDepth = _ditherDepthUniform;
            shader.uniforms.uDitherRadius = _ditherRadiusUniform;
            shader.uniforms.uDitherFeather = _ditherFeatherUniform;
            shader.uniforms.uDitherHoleOn = _ditherHoleOnUniform;
            shader.uniforms.uDitherDepthFade = _ditherDepthFadeUniform;
            shader.fragmentShader = shader.fragmentShader
                .replace('void main() {',
                    `uniform float uDitherAmount;\nuniform vec2 uDitherScreen;\nuniform float uDitherPlayerDepth;\nuniform float uDitherRadius;\nuniform float uDitherFeather;\nuniform float uDitherHoleOn;\nuniform float uDitherDepthFade;\n${DITHER_GLSL}\nvoid main() {`)
                // First statement in main, before any lighting work is done
                // for a fragment that is about to be thrown away.
                //
                // The dissolve is confined to a soft-edged circle around the
                // player's own position on screen rather than eating the whole
                // object. Two reasons: a block vanishing entirely is
                // disorienting when you are trying to judge what you are
                // standing on, and a hole only needs to be as big as the thing
                // it is revealing. It also makes the occluder test forgiving -
                // the circle covers the player even when a probe ray slips
                // past an edge, which is most of what a real spherecast would
                // have bought.
                //
                // vViewPosition.z is this fragment's distance in front of the
                // camera (three.js sets vViewPosition = -mvPosition.xyz for
                // lit materials). Only geometry actually IN FRONT of the
                // player dissolves, so the far side of the same block, and
                // anything behind the player, stays solid.
                .replace('#include <clipping_planes_fragment>',
                    `if (uDitherAmount > 0.001 && vViewPosition.z < uDitherPlayerDepth - 0.35) {
        float _dr = length(gl_FragCoord.xy - uDitherScreen) / max(uDitherRadius, 1.0);
        float _dHole = 1.0 - smoothstep(1.0 - uDitherFeather, 1.0, _dr);
        float _dEdge = mix(1.0, _dHole, uDitherHoleOn);
        // Depth is faded, not cut. A hard "is this nearer than the player"
        // test slices any object that spans that plane - a tree trunk running
        // from in front of the player to behind them lost its near half in one
        // step and read as a sawn-off stump. Ramping the amount across a depth
        // band instead lets the trunk thin out along its length.
        float _dDepth = 1.0 - smoothstep(uDitherPlayerDepth - uDitherDepthFade, uDitherPlayerDepth - 0.35, vViewPosition.z);
        float _dCut = uDitherAmount * _dEdge * _dDepth;
        if (_dCut > 0.001 && _ditherBayer4(gl_FragCoord.xy) < _dCut) discard;
    }
    #include <clipping_planes_fragment>`);
        };
        // onBeforeCompile closures are not part of three.js's program cache
        // key, so without this a dithering material could be handed the
        // compiled program of an otherwise-identical non-dithering one.
        const prevKey = material.customProgramCacheKey;
        material.customProgramCacheKey = () => (prevKey ? prevKey.call(material) : '') + '|dither';
        material.needsUpdate = true;
        return uniform;
    }

    // Player-placed blocks, probed individually so only the ones genuinely
    // covering the player dissolve.
    const ditherOccluders = [];
    // Stand-ins for geometry that hides the player but is deliberately absent
    // from collidables - the BaseTreeLeaveBunch canopy mass. Plain
    // {x,y,z,r} spheres tested with arithmetic, NOT scene objects: see the
    // canopy-sphere pass in buildForestLevel for why a mesh proxy was too
    // expensive at 193 trees.
    const ditherProbeSpheres = [];
    const _ditherRay = new THREE.Raycaster();
    const _ditherDir = new THREE.Vector3();
    const _ditherRight = new THREE.Vector3();
    const _ditherUp = new THREE.Vector3();
    const _ditherProbeDir = new THREE.Vector3();
    const _ditherTargetPoint = new THREE.Vector3();
    const _ditherScreenVec = new THREE.Vector3();
    const _ditherDrawSize = new THREE.Vector2();
    // Radius of the probe bundle in world units - roughly the player's own
    // half-width, so the sampled volume is about the size of the thing being
    // kept visible.
    window.ditherProbeRadius = 0.20;
    // How long a probe hit keeps a block armed after the rays stop finding it.
    // Insurance rather than the fix - the box test below is what actually
    // stopped stacked blocks toggling - but a grazing hit can still land on
    // one frame and miss the next, and bridging a couple of frames costs
    // nothing perceptible while a single dropped frame would otherwise start
    // a visible fade back to solid.
    window.ditherHoldTime = 0.15;
    const _ditherBox = new THREE.Box3();
    const _ditherBoxHit = new THREE.Vector3();
    // Faded amount for the trees, which can only move as one group: all ~193
    // of them share one InstancedMesh per source mesh, so there is no
    // per-tree material to raise or lower.
    let _ditherTreeAmount = 0;
    function updateDitherOccluders(cam, playerPoint, delta) {
        _ditherScreenVec.copy(playerPoint).project(cam);
        renderer.getDrawingBufferSize(_ditherDrawSize);
        // The hole is measured in gl_FragCoord, i.e. in whatever buffer the
        // scene is actually being drawn into. With the pixelation pass on that
        // is NOT the drawing buffer - RenderPixelatedPass renders the scene at
        // 1/pixelSize resolution and upscales afterwards. Sizing the hole from
        // the full drawing buffer therefore put its centre at pixelSize times
        // the right coordinates and made its radius pixelSize times too big,
        // which is the "hole is in the wrong place and too large at pixel size
        // 2" report. Both are the same divide.
        const pixelDiv = (window.pixelEffectEnabled && renderPixelatedPass.pixelSize > 0)
            ? renderPixelatedPass.pixelSize : 1;
        _ditherScreenUniform.value.set(
            (_ditherScreenVec.x * 0.5 + 0.5) * _ditherDrawSize.x / pixelDiv,
            (_ditherScreenVec.y * 0.5 + 0.5) * _ditherDrawSize.y / pixelDiv);
        // Matches vViewPosition.z in the shader: distance in front of the
        // camera, not straight-line distance to it.
        _ditherDepthUniform.value = -_ditherTargetPoint.copy(playerPoint).applyMatrix4(cam.matrixWorldInverse).z;
        _ditherRadiusUniform.value = window.ditherHoleRadius / pixelDiv;
        _ditherFeatherUniform.value = window.ditherHoleFeather;
        _ditherHoleOnUniform.value = window.ditherHoleEnabled ? 1 : 0;
        _ditherDepthFadeUniform.value = Math.max(window.ditherDepthFade, 0.4);

        // Everything is gated on these probes. Letting the shader decide
        // alone - "in front of the player and inside the hole" - reads as the
        // occlusion test but is not one: stand BESIDE a wall and the part of
        // it nearer the camera than you still satisfies both conditions, so it
        // dissolved with nothing hidden behind it. Only a ray that actually
        // reaches the player can tell "in front of" from "covering".
        //
        // A bundle rather than a single ray, standing in for the spherecast
        // three.js does not have: the player centre plus four offsets on the
        // axes PERPENDICULAR to the view direction, sweeping a rough cylinder
        // the width of the body. One ray kept slipping past edges while the
        // body was still visibly behind them.
        // Decayed rather than cleared, so a hit lingers for ditherHoldTime.
        for (let i = 0; i < ditherOccluders.length; i++) {
            const ud = ditherOccluders[i].userData;
            ud._ditherHold = Math.max(0, (ud._ditherHold || 0) - delta);
        }
        let treeWanted = false;
        _ditherDir.copy(playerPoint).sub(cam.position);
        if (_ditherDir.lengthSq() > 1e-6) {
            _ditherDir.normalize();
            _ditherRight.crossVectors(_ditherDir, _upVec);
            if (_ditherRight.lengthSq() < 1e-6) _ditherRight.set(1, 0, 0); // looking straight down
            _ditherRight.normalize();
            _ditherUp.crossVectors(_ditherRight, _ditherDir).normalize();
        }
        const r = window.ditherProbeRadius;
        for (let sIdx = 0; sIdx < 5; sIdx++) {
            _ditherTargetPoint.copy(playerPoint);
            if (sIdx === 1) _ditherTargetPoint.addScaledVector(_ditherRight, r);
            else if (sIdx === 2) _ditherTargetPoint.addScaledVector(_ditherRight, -r);
            else if (sIdx === 3) _ditherTargetPoint.addScaledVector(_ditherUp, r);
            else if (sIdx === 4) _ditherTargetPoint.addScaledVector(_ditherUp, -r);
            const dir = _ditherProbeDir.copy(_ditherTargetPoint).sub(cam.position);
            const dist = dir.length();
            if (dist < 0.01) continue;
            _ditherRay.set(cam.position, dir.normalize());
            _ditherRay.far = dist - 0.3;
            // Ray-vs-BOX, not the mesh raycast this used to do, and that is
            // the actual fix for stacked blocks flickering.
            //
            // Mesh.raycast passes material.side into the triangle test as a
            // backface-culling flag, and these blocks are FrontSide. A ray
            // descending from the camera through a tower enters the TOP block
            // through its outside top face - a clean, unambiguous hit - but
            // can only enter each block below through the seam it shares with
            // the one above, where two coplanar faces sit at exactly the same
            // depth. Whether that counted as an entry came down to floating
            // point, so the lower blocks toggled on and off frame to frame
            // while the top one never did. That asymmetry was the tell.
            //
            // A box has no faces to cull and no coplanar seam to resolve: the
            // slab test just asks whether the segment passes through the
            // volume. These blocks are axis-aligned cubes, so their AABB is
            // their exact shape - this is not an approximation, it is the
            // same query asked in a form that cannot be ambiguous. It is also
            // cheaper than walking 12 triangles.
            for (let i = 0; i < ditherOccluders.length; i++) {
                const obj = ditherOccluders[i];
                getObstacleBox(obj, _ditherBox);
                // Camera inside the block counts as covering: intersectBox
                // would hand back the far exit point, which can sit past the
                // segment end and read as a miss.
                if (_ditherBox.containsPoint(cam.position)) { obj.userData._ditherHold = window.ditherHoldTime; continue; }
                if (_ditherRay.ray.intersectBox(_ditherBox, _ditherBoxHit) === null) continue;
                if (cam.position.distanceToSquared(_ditherBoxHit) <= _ditherRay.far * _ditherRay.far) {
                    obj.userData._ditherHold = window.ditherHoldTime;
                }
            }
            // Canopy spheres: closest point on the camera-to-player segment,
            // compared against the radius. Squared distances throughout, so
            // there is no square root anywhere in the loop. Stops at the first
            // hit since every sphere can only set the same one flag.
            if (!treeWanted) {
                for (let c = 0; c < ditherProbeSpheres.length; c++) {
                    const sp = ditherProbeSpheres[c];
                    const ox = sp.x - cam.position.x, oy = sp.y - cam.position.y, oz = sp.z - cam.position.z;
                    // Projection of the sphere centre onto the ray, clamped to
                    // the segment. Clamping at 0 is what makes a camera
                    // already inside the canopy report a hit rather than
                    // sliding past it.
                    let t = ox * dir.x + oy * dir.y + oz * dir.z;
                    if (t < 0) t = 0; else if (t > _ditherRay.far) t = _ditherRay.far;
                    const dx = ox - dir.x * t, dy = oy - dir.y * t, dz = oz - dir.z * t;
                    if (dx * dx + dy * dy + dz * dz <= sp.r * sp.r) { treeWanted = true; break; }
                }
            }
        }

        // Diagnostic for the stacked-block flicker, off unless
        // window._ditherProbeDebug is set from the console. Counts how often
        // each block's ARMED state flips per second. That single number
        // settles what no amount of reading the code could: a high count
        // means the probe itself is unstable and the flicker is this
        // function's fault; a count of zero while flicker is visible on
        // screen means the probe is rock solid and the artifact is in
        // rendering (z-fighting between the coplanar faces two stacked cubes
        // share, or the screen-space dither pattern crawling), which would
        // need a completely different fix.
        if (window._ditherProbeDebug && ditherOccluders.length) {
            const now = performance.now();
            if (!window._ditherDbgT0) window._ditherDbgT0 = now;
            for (let i = 0; i < ditherOccluders.length; i++) {
                const ud = ditherOccluders[i].userData;
                const armed = ud._ditherHold > 0;
                if (ud._ditherDbgPrev !== armed) { ud._ditherDbgFlips = (ud._ditherDbgFlips || 0) + 1; ud._ditherDbgPrev = armed; }
            }
            if (now - window._ditherDbgT0 >= 1000) {
                for (let i = 0; i < ditherOccluders.length; i++) {
                    const ud = ditherOccluders[i].userData;
                    ud._ditherDbgRate = ud._ditherDbgFlips || 0;
                    ud._ditherDbgFlips = 0;
                }
                window._ditherDbgT0 = now;
            }
            let el = document.getElementById('dither-probe-debug');
            if (!el) {
                el = document.createElement('div'); el.id = 'dither-probe-debug';
                el.style.cssText = 'position:fixed;top:0;left:0;background:rgba(0,0,0,.85);color:#0f0;font:13px monospace;padding:8px;z-index:99999;white-space:pre;';
                document.body.appendChild(el);
            }
            const rows = ['flips/sec per block (move the camera and watch)'];
            for (let i = 0; i < ditherOccluders.length; i++) {
                const o = ditherOccluders[i], ud = o.userData;
                const u = o.material && o.material.userData.ditherUniform;
                rows.push(`block${i} y=${o.position.y.toFixed(1).padStart(5)}  armed=${ud._ditherHold > 0 ? 'Y' : 'n'}  flips/s=${String(ud._ditherDbgRate || 0).padStart(3)}  amount=${(u ? u.value : 0).toFixed(2)}`);
            }
            el.textContent = rows.join('\n');
        }

        const step = window.ditherFadeSpeed * delta;
        const treeTarget = (window.ditherHoleEnabled && treeWanted) ? window.ditherStrength : 0;
        _ditherTreeAmount += THREE.MathUtils.clamp(treeTarget - _ditherTreeAmount, -step, step);
        for (let i = 0; i < ditherAlwaysOnMats.length; i++) {
            const m = ditherAlwaysOnMats[i];
            if (m.userData.ditherUniform) m.userData.ditherUniform.value = _ditherTreeAmount;
        }
        for (let i = 0; i < ditherOccluders.length; i++) {
            const obj = ditherOccluders[i];
            const u = obj.material && obj.material.userData.ditherUniform;
            if (!u) continue;
            const blockTarget = obj.userData._ditherHold > 0 ? window.ditherStrength : 0;
            u.value += THREE.MathUtils.clamp(blockTarget - u.value, -step, step);
        }
    }

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
        // placeCube already clones platMat per block, so each one owns its
        // material and can dissolve independently - no extra clone needed.
        makeDitherable(newCube.material);
        ditherOccluders.push(newCube);
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

    // The stick sticking - walking off in one direction until you drag it that
    // way and let go, and never releasing at all on mobile - was this only
    // ever listening for `pointerup`.
    //
    // A touch does not always end in pointerup. The browser fires
    // `pointercancel` instead whenever it takes the pointer over: a second
    // finger starting a system gesture, the OS deciding a scroll or back-swipe
    // has begun, a call arriving. That cancel was unhandled, so activePointer
    // stayed set, the input vector kept its last value, and the character kept
    // running. The only way out was to press again, drag to that same
    // direction (so the ids matched again) and release - exactly the recovery
    // described. It shows up on mobile far more because that is where the
    // browser steals pointers.
    //
    // Fixed by capturing the pointer, which routes the whole stream to this
    // element until it is explicitly released, and by treating every way a
    // pointer can end - up, cancel, and losing the capture - as a release.
    function setupJoystick(baseId, stickId, inputRef) {
        const base = document.getElementById(baseId), stick = document.getElementById(stickId);
        let activePointer = null;
        const maxR = 40;
        const release = () => {
            activePointer = null;
            stick.style.transform = 'translate(0,0)';
            inputRef.x = 0; inputRef.y = 0;
        };
        const update = (e) => {
            if (e.pointerId !== activePointer) return;
            const rect = base.getBoundingClientRect(), cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
            let dx = e.clientX - cx, dy = e.clientY - cy, dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > maxR) { dx *= maxR/dist; dy *= maxR/dist; }
            stick.style.transform = `translate(${dx}px, ${dy}px)`; inputRef.x = dx/maxR; inputRef.y = dy/maxR;
        };
        const onEnd = (e) => { if (e.pointerId === activePointer) release(); };
        base.addEventListener('pointerdown', (e) => {
            if (activePointer !== null) return;
            activePointer = e.pointerId;
            // Capture means move/up/cancel for this pointer all arrive here
            // even once the finger leaves the base, so there is no longer any
            // need for window-level listeners that outlive the gesture.
            try { base.setPointerCapture(e.pointerId); } catch (err) { /* not capturable - handlers below still fire */ }
            update(e);
        });
        base.addEventListener('pointermove', (e) => { if (e.pointerId === activePointer) update(e); });
        base.addEventListener('pointerup', onEnd);
        // The two that were missing. lostpointercapture is the backstop: if
        // capture is broken for any reason not covered above, that is still
        // the gesture ending, and the stick must not be left held.
        base.addEventListener('pointercancel', onEnd);
        base.addEventListener('lostpointercapture', onEnd);
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
    //
    // These are the SHARED TUNING (max/rate/delay); the pool itself is per
    // enemy, on the avatar as bot.staggerPool/bot.staggerRegenCooldown. It
    // used to be a global too, which with more than one bot meant they drew
    // down a single pool between them - punch one, and the other went down.
    window.aiBotStaggerMax = 100.0;
    window.aiBotStaggerRegenRate = 20.0;
    window.aiBotStaggerRegenDelay = 2.5;
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
        { id: 'head-scale-slider', vId: 'head-scale-val', func: v => window.headScale = v, fix: 2 },
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
        { id: 'flower-size-slider', vId: 'flower-size-val', func: v => window.flowerSize = v, fix: 2 },
        // Dither: all read straight off window.* by the per-frame uniform
        // update, so recording the value here is all that is needed - no
        // rebuild, no material touch.
        // Re-scatters grass as well: its 'near'/'far' shadow-receiving split
        // is keyed to this same extent (see shadowSafe in buildGrass).
        { id: 'shadow-range-slider', vId: 'shadow-range-val', func: v => { window.shadowRange = v; applyShadowRange(); }, fix: 0, raw: true },
        { id: 'dither-strength-slider', vId: 'dither-strength-val', func: v => window.ditherStrength = v, fix: 2 },
        { id: 'dither-hole-radius-slider', vId: 'dither-hole-radius-val', func: v => window.ditherHoleRadius = v, fix: 0 },
        { id: 'dither-hole-feather-slider', vId: 'dither-hole-feather-val', func: v => window.ditherHoleFeather = v, fix: 2 },
        { id: 'dither-depth-fade-slider', vId: 'dither-depth-fade-val', func: v => window.ditherDepthFade = v, fix: 1 },
        { id: 'dither-fade-speed-slider', vId: 'dither-fade-speed-val', func: v => window.ditherFadeSpeed = v, fix: 1 },
        { id: 'dither-probe-radius-slider', vId: 'dither-probe-radius-val', func: v => window.ditherProbeRadius = v, fix: 2 },
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
    const ditherHoleToggleEl = document.getElementById('toggle-dither-hole');
    if (ditherHoleToggleEl) ditherHoleToggleEl.addEventListener('change', e => { window.ditherHoleEnabled = e.target.checked; });
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
    ['grass-count-slider', 'grass-size-slider', 'grass-height-slider', 'grass-sink-slider'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => buildGrass());
    });
    // grass-area-slider affects both fields (buildFlowers() reads the same
    // window.grassArea as its own scatter radius), so it rebuilds both.
    const grassAreaEl = document.getElementById('grass-area-slider');
    if (grassAreaEl) grassAreaEl.addEventListener('change', () => { buildGrass(); buildFlowers(); });
    const flowerSizeEl = document.getElementById('flower-size-slider');
    if (flowerSizeEl) flowerSizeEl.addEventListener('change', () => buildFlowers());
    const grassToggleEl = document.getElementById('toggle-grass');
    if (grassToggleEl) grassToggleEl.addEventListener('change', () => { buildGrass(); buildFlowers(); });
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
    const flowerAlphaEl = document.getElementById('flower-alpha-slider');
    if (flowerAlphaEl) flowerAlphaEl.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.flowerAlphaTest = v;
        flowerMats.forEach(m => { m.alphaTest = v; m.needsUpdate = true; });
        const disp = document.getElementById('flower-alpha-val');
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
    window.punchButtonEnabled = true;
    const togglePunchBtnEl = document.getElementById('toggle-punch-btn');
    if (togglePunchBtnEl) {
        // Keep the checkbox showing the real state - it starts on now, and a
        // box that reads unchecked while the button is visible is worse than
        // no box at all.
        togglePunchBtnEl.checked = window.punchButtonEnabled;
        togglePunchBtnEl.addEventListener('change', e => { window.punchButtonEnabled = e.target.checked; });
    }
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
    // Shared size for every small UI icon (toast icon, dialogue icon) -
    // read live by addNotificationToast/updateDialogueIconForCurrentLine
    // rather than baked into their CSS, so this one slider covers both.
    window.iconSize = 40;
    const iconSizeSliderEl = document.getElementById('icon-size-slider');
    if (iconSizeSliderEl) iconSizeSliderEl.addEventListener('input', e => {
        window.iconSize = parseFloat(e.target.value);
        const v = document.getElementById('icon-size-val'); if (v) v.textContent = window.iconSize;
        // Live-update whichever icon is on screen right now, if any.
        const dIcon = document.getElementById('dialogue-icon');
        if (dIcon && dIcon.style.display !== 'none') { dIcon.style.height = window.iconSize + 'px'; dIcon.style.width = 'auto'; }
    });
    // Dialogue panel vertical placement, as a % up from the bottom of the
    // screen. Applied to `bottom` (not `top`) so the panel grows upward and
    // its lower edge stays anchored as lines wrap to different heights.
    window.dialogueY = 70;
    const dialogueYSliderEl = document.getElementById('dialogue-y-slider');
    if (dialogueYSliderEl) dialogueYSliderEl.addEventListener('input', e => {
        window.dialogueY = parseFloat(e.target.value);
        const v = document.getElementById('dialogue-y-val'); if (v) v.textContent = window.dialogueY;
        const box = document.getElementById('dialogue-box');
        if (box) box.style.bottom = window.dialogueY + '%';
    });
    // Uniform scale on the dialogue camera's offset - see startVillageDialogue.
    // Changing it moves the camera closer/further along the SAME line, so the
    // angle of the shot is unaffected. Re-applied live below so dragging this
    // during a conversation updates the framing you're looking at.
    window.dialogueCamZoom = 0.35;
    const dialogueZoomSliderEl = document.getElementById('dialogue-cam-zoom-slider');
    if (dialogueZoomSliderEl) dialogueZoomSliderEl.addEventListener('input', e => {
        window.dialogueCamZoom = parseFloat(e.target.value);
        const v = document.getElementById('dialogue-cam-zoom-val'); if (v) v.textContent = window.dialogueCamZoom.toFixed(2);
        if (window._recomputeDialogueCam) window._recomputeDialogueCam();
    });
    // How fast the camera eases from the gameplay follow-cam into the dialogue
    // shot (and how fast it pans its look-at across). Lower = slower glide.
    window.dialogueCamEase = 2.0;
    const dialogueEaseSliderEl = document.getElementById('dialogue-cam-ease-slider');
    if (dialogueEaseSliderEl) dialogueEaseSliderEl.addEventListener('input', e => {
        window.dialogueCamEase = parseFloat(e.target.value);
        const v = document.getElementById('dialogue-cam-ease-val'); if (v) v.textContent = window.dialogueCamEase.toFixed(1);
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
        aiBots.forEach(r => r.bot.setDynamicShading(enabled));
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

    // How big a depth step counts as an edge, as a FRACTION of the distance to
    // it - so one setting works at every range. The Strength slider above
    // scales how dark the edge is drawn; this decides whether there is one.
    document.getElementById('pixel-depth-sens-slider').addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        window.pixelDepthEdgeSensitivity = v;
        document.getElementById('pixel-depth-sens-val').textContent = v.toFixed(3);
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
        // Panel globals -> triplanar uniforms. Cheap enough to copy every
        // frame, and it means the sliders retune every treated block at once
        // with no level rebuild - the same pattern the water sliders use.
        _triGrassUniforms.uTriScale.value = window.triGrassScale;
        _triGrassUniforms.uTriUp0.value = window.triGrassUpStart;
        _triGrassUniforms.uTriUp1.value = window.triGrassUpEnd;
        _triGrassUniforms.uTriSharp.value = window.triGrassSharpness;
        // Before the uniform upload below, never after: uWaterLevel and
        // uFoamLevel are both read straight off mesh.position.y, so moving the
        // surface afterwards would leave the foam a frame behind it.
        if (currentLevel === 'local_forest') updateForestLakeSurfaces();
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
            // Round water gets tested as a circle, not as its bounding box -
            // see uFoamRadius. Read off the geometry rather than a flag on the
            // mesh so an editor-added circle picks it up too. Scale is folded
            // in the same way the half-extents above do it.
            foamSharedUniforms.uFoamRadius.value[i] = (g.type === 'CircleGeometry' && g.parameters)
                ? g.parameters.radius * Math.max(Math.abs(mesh.scale.x), Math.abs(mesh.scale.y))
                : 0;
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
        // Same regen tick as the player's own stagger pool above, run per
        // enemy - each carries its own pool (see window.aiBotStaggerMax).
        for (let i = 0; i < aiBots.length; i++) {
            const b = aiBots[i].bot;
            if (b.staggerPool === undefined) b.staggerPool = window.aiBotStaggerMax;
            if (b.staggerRegenCooldown > 0) {
                b.staggerRegenCooldown -= delta;
            } else if (b.staggerPool < window.aiBotStaggerMax) {
                b.staggerPool = Math.min(window.aiBotStaggerMax, b.staggerPool + window.aiBotStaggerRegenRate * delta);
            }
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
                    // remote to send it to.
                    //
                    // A projectile thrown BY a bot cannot hit any bot.
                    //
                    // The remotes branch above notes that this projectile only
                    // ever comes from the local player - that stopped being
                    // true when the red bot got a charge punch. RemoteAvatar
                    // spawns the projectile from its hand on the mature-charge
                    // frame exactly as it does for anyone else, and that start
                    // point is inside the thrower's own hit radius, so it
                    // knocked ITSELF down on the frame it punched. Exactly the
                    // self-hit the remotes branch already guards against; it
                    // just did not apply to bots until one of them could throw.
                    //
                    // Skipping the whole group rather than only the thrower,
                    // because bots do not fight each other - aiBotPickVictim
                    // only ever picks the player or a companion - and letting
                    // one flatten its neighbours with a stray projectile would
                    // contradict that. Its melee charge already carries the
                    // damage; this projectile is the visual.
                    const chargeFromBot = aiBots.some(r => r.bot.id === cp.ownerId);
                    for (let bi = 0; bi < aiBots.length && !consumed && !chargeFromBot; bi++) {
                        const bot = aiBots[bi].bot;
                        if (!bot.isLoaded || bot.isRagdoll) continue;
                        const botHitPos = bot.getHitReferencePoint();
                        if (botHitPos.distanceTo(cp.mesh.position) < chargeHitRadius + 1.0) {
                            if (window.createHandHitEffect) window.createHandHitEffect(cp.mesh.position);
                            if (window.spawnHitEffect) window.spawnHitEffect(cp.mesh.position.clone());
                            const intensity = chargeForce >= 70 ? 'high' : (chargeForce >= 45 ? 'medium_high' : 'medium');
                            const flashStrengthByIntensity = { medium: 0.9, medium_high: 1.4, high: 2.5 };
                            const strength = flashStrengthByIntensity[intensity] || 1.0;
                            const knockback = window.chargePunchKnockback !== undefined ? window.chargePunchKnockback : 15;
                            const magnitudeForRagdoll = intensity === 'high' ? knockback : chargeForce;
                            const botVelocity = impactDir.clone().multiplyScalar(magnitudeForRagdoll);
                            bot.triggerHitFlash(strength);
                            if (intensity === 'high') bot.initRagdoll(botVelocity, intensity);
                            else bot.applyProceduralRecoil(botVelocity, intensity);
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

        // Both shadow lights follow the player, and their X/Z is SNAPPED to
        // whole shadow-map texels rather than tracking continuously. Without
        // that snap the texel grid slides across the world by a fraction of a
        // texel every frame the player moves, so which texel a given surface
        // point lands in keeps changing and shadow edges crawl - the classic
        // "shadow swimming" shimmer. It reads as flicker on stacked blocks
        // and, tellingly, never on the topmost one, whose top face has
        // nothing above it to cast onto it in the first place.
        //
        // Snapping X/Z alone is enough because both lights point straight
        // down (position is target + 40 on Y), so the shadow camera's own
        // axes are the world X/Z axes. Y is left continuous: for an
        // orthographic camera looking down, moving along its view direction
        // does not change which world point maps to which texel.
        //
        const dirTexel = (window.shadowRange * 2) / dirLight.shadow.mapSize.width;
        const dirSnapX = Math.round(lightTrack.x / dirTexel) * dirTexel;
        const dirSnapZ = Math.round(lightTrack.z / dirTexel) * dirTexel;
        dirLight.position.set(dirSnapX, lightTrack.y + 40, dirSnapZ);
        dirLight.target.position.set(dirSnapX, lightTrack.y, dirSnapZ);

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
            let projectileHitBot = false;
            for (let bi = 0; bi < aiBots.length; bi++) {
                const bot = aiBots[bi].bot;
                if (!bot.isLoaded || bot.isRagdoll) continue;
                const botHitPos = bot.getHitReferencePoint();
                if (botHitPos.distanceTo(p.mesh.position) < hitRadius) {
                    const flashStrengthByIntensity = { low: 0.5, medium: 0.9, medium_high: 1.4, high: 2.5 };
                    const hitStrength = flashStrengthByIntensity[p.intensity] || 2.5;
                    bot.triggerHitFlash(hitStrength);
                    if (p.intensity === 'high') bot.initRagdoll(p.velocity, p.intensity);
                    else bot.applyProceduralRecoil(p.velocity, p.intensity);
                    scene.remove(p.mesh); projectiles.splice(i, 1);
                    projectileHitBot = true;
                    break;
                }
            }
            if (projectileHitBot) continue;

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
                    // Throwing something at one of the AI characters. Both of
                    // them, not just the bot - the companion was not checked
                    // here at all, so objects passed straight through it.
                    //
                    // A thrown object registers at 'medium_high' - the orange
                    // turret's own intensity - rather than being graded down
                    // from throwHitForce. The force ladder put a default throw
                    // (35) in 'medium', which is the light tap reaction; but
                    // heaving a crate at someone is a deliberate, heavy hit
                    // and should land like one. 'high' is still reserved for
                    // a genuinely huge throw, since that ragdolls outright.
                    const throwHit = (victim) => {
                        if (consumed || !victim || !victim.isLoaded || victim.isRagdoll || victim.isStandingUp) return;
                        if (victim.group && victim.group.visible === false) return;
                        const vHitPos = victim.getHitReferencePoint();
                        if (vHitPos.distanceTo(c.mesh.position) >= hitRadius + 1.0) return;
                        if (window.createHandHitEffect) window.createHandHitEffect(c.mesh.position);
                        if (window.spawnHitEffect) window.spawnHitEffect(c.mesh.position.clone());
                        // A thrown object floors the AI bot outright, whatever
                        // the force - taking a crate to the head should put it
                        // down, not make it stumble. Everyone else keeps the
                        // graded reaction, so a throw still has to be a big one
                        // to ragdoll the companion or a remote player.
                        const alwaysRagdoll = aiBots.some(r => r.bot === victim);
                        const intensity = (alwaysRagdoll || hitForce >= 70) ? 'high' : 'medium_high';
                        const flashStrengthByIntensity = { medium: 0.9, medium_high: 1.4, high: 2.5 };
                        const strength = flashStrengthByIntensity[intensity] || 1.0;
                        const knockback = window.chargePunchKnockback !== undefined ? window.chargePunchKnockback : 15;
                        // Ragdoll takes the knockback constant rather than the
                        // raw throw force: the force number is tuned for a
                        // stagger impulse, and feeding it straight into a limp
                        // body flings it across the level.
                        const magnitudeForRagdoll = intensity === 'high' ? knockback : hitForce;
                        const vVelocity = impactDir.clone().multiplyScalar(magnitudeForRagdoll);
                        victim.triggerHitFlash(strength);
                        if (intensity === 'high') victim.initRagdoll(vVelocity, intensity);
                        else victim.applyProceduralRecoil(vVelocity, intensity);
                        consumed = true;
                    };
                    for (let bi = 0; bi < aiBots.length && !consumed; bi++) throwHit(aiBots[bi].bot);
                    for (let ci = 0; ci < companions.length && !consumed; ci++) throwHit(companions[ci].comp);

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
                // Also skipped during dialogue: startVillageDialogue snaps
                // the character to face the NPC, but the trigger frame's
                // rawX/rawY were already read BEFORE the input lock went up
                // (they're computed far earlier in this same frame), so
                // moveMag is still non-zero here - and curX/curY only decay
                // toward 0 over several more frames. Without this guard,
                // this slerp turns the character straight back to their
                // walk-in direction for as long as that decay lasts, which
                // is exactly the "player isn't facing the NPC" bug.
                if (!isSliding && !isHitRecovering && !window.isCarryStarting && !window.isCarryDropping && !isMakingRoom && !window.dialogueInputLocked) char.group.quaternion.slerp(_tempQuat.setFromAxisAngle(_upVec, mAng), window.CHAR_TURN_RATE*delta);
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
        // Before both consumers - the bot reads the trail to find where the
        // player left its level, the companion to retrace their route.
        if (currentLevel === 'local_forest') applyForestFoam();
        // Published for the companions' ledge-clearance test, which has to
        // know whether the player is HOLDING a grip or merely standing near
        // one - see hangSpotTaken.
        window.playerIsLedgeGrabbing = isLedgeGrabbing || isClimbingUp;
        recordPlayerTrail(delta);
        updateAiBots(delta);
        updateCompanions(delta);
        // After the companion has moved for this frame, so the crumb is where
        // it actually ended up.
        recordCompanionTrails(delta);
        // After every avatar has had its mixer run for this frame, so nothing
        // can overwrite it before it is drawn.
        applyHeadScale();
        // Broadcasts under a fixed id ('ai-bot-1') so every connected client
        // renders the same bot, driven by whoever spawned it - not
        // synced/cleaned up if that person disconnects, it just stays put
        // wherever it last was on everyone else's screen (simple, matches
        // what was asked for; no ownership handoff or despawn-on-leave).
        // Only the first bot goes over the wire: the protocol has a single
        // 'ai-bot-1' slot, and widening it is a server change. The second one
        // is local-only until that happens.
        const netBot = aiBots.length ? aiBots[0].bot : null;
        if (netBot && network) network.sendAiBotState(netBot.group.position, netBot.group.quaternion, netBot.stateName, delta);

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
        // two-shot framing (computed in startVillageDialogue) instead of the
        // usual orbit math, easing across from wherever the gameplay camera
        // was rather than cutting.
        if (window._dialogueCamPos) {
            // Last write wins: this runs after every movement/slide/carry
            // system that touches char.group.quaternion, so re-stamping the
            // frozen rotation here is what actually guarantees the character
            // stands still for the whole conversation.
            if (window._dialogueFacingQuat) char.group.quaternion.copy(window._dialogueFacingQuat);
            const ease = (window.dialogueCamEase || 2.0) * delta;
            // The look-at point is panned too, not just the position - a
            // position-only lerp keeps the camera aimed at the final target
            // from frame one, which whips the view around before the camera
            // has actually travelled anywhere. Seeded from the live follow-cam
            // target so the pan starts exactly where the player was looking.
            if (!window._dialogueCamLookNow) window._dialogueCamLookNow = new THREE.Vector3(camTarget.x, camTarget.y, camTarget.z);
            window._dialogueCamLookNow.lerp(window._dialogueCamTarget, ease);
            camera.position.lerp(window._dialogueCamPos, ease);
            camera.lookAt(window._dialogueCamLookNow);
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
        // Player-placed blocks in the way dissolve instead of hiding the
        // player - see makeDitherable. Runs before the ghost test below (and
        // unconditionally) both so that test sees this frame's fade values,
        // and because a block that has stopped occluding still needs its fade
        // driven back down to solid.
        updateDitherOccluders(camera, trackingPoint, delta);

        const toPlayer = _tempVec3.copy(trackingPoint).sub(camera.position);
        const distToPlayer = toPlayer.length();
        let playerOccluded = false;
        if (distToPlayer > 0.01) {
            xrayRaycaster.set(camera.position, toPlayer.normalize());
            xrayRaycaster.far = distToPlayer - 0.3;
            const occluders = xrayRaycaster.intersectObjects(collidables);
            for (let i = 0; i < occluders.length; i++) {
                const obj = occluders[i].object;
                // An occluder that is already dissolving is showing the
                // player through itself, so stacking the ghost on top of it
                // just muddies both - that washed-out doubled look. Only
                // something still solid earns one. Trees are recognised by
                // their collider flag, since that mesh carries no material of
                // its own to read the dither state from.
                if (obj.userData.isTreeCollider) { if (_ditherTreeAmount > 0.3) continue; }
                else {
                    const m = obj.material;
                    const u = m && !Array.isArray(m) && m.userData ? m.userData.ditherUniform : null;
                    if (u && u.value > 0.3) continue;
                }
                playerOccluded = true;
                break;
            }
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
            // Linearising depth needs the camera's own near/far, and which
            // projection it is - read here rather than at setup because the
            // ortho toggle can swap the camera at any time.
            _pixelEdgeUniforms.uEdgeNear.value = activeCamera.near;
            _pixelEdgeUniforms.uEdgeFar.value = activeCamera.far;
            _pixelEdgeUniforms.uEdgeOrtho.value = activeCamera.isOrthographicCamera ? 1 : 0;
            const sens = Math.max(0.002, window.pixelDepthEdgeSensitivity);
            _pixelEdgeUniforms.uEdgeLo.value = sens;
            // 2.5x gives the smoothstep a band to work in; too tight and the
            // half-step quantisation below it turns into aliasing.
            _pixelEdgeUniforms.uEdgeHi.value = sens * 2.5;
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