import * as THREE from 'three';
import { RemoteAvatar } from './remote_avatar.js';

const SEND_RATE = 1 / 10; // 10Hz
const ROOM_NAME = 'climb-game-room';

// Talks to the room-based WebSocket relay in Multiplayer/server/uws-server.js.
// That server is generic (not A-Frame specific): join a room, then any
// "broadcast" message gets relayed to everyone in the room, including the
// sender - so we filter our own id back out client-side.
export class MultiplayerClient {
    constructor(scene, threeTone) {
        this.scene = scene;
        this.threeTone = threeTone;
        this.ws = null;
        this.id = null;
        this.connected = false;
        this.remotes = new Map();
        this.sendTimer = 0;
        this.onStatusChange = null;
        this.remoteHeldIdx = new Map(); // carryable index -> remote player id currently holding it

        // Kept separate from `remotes` (not just another entry in that map)
        // because `remotes` gets pruned on every occupantsChanged event
        // against the server's real socket-id list - the bot's fixed id
        // ('ai-bot-1') would never match a real occupant and get disposed
        // the moment anyone joined or left. Also why it's never cleaned up
        // if whoever spawned it disconnects - simple, on purpose.
        this.aiBotAvatar = null;
        this.aiBotSendTimer = 0;

        // uws-server.js already stamps `connectSuccess` with its own Date.now()
        // (joinedTime) - we use that single sample as a client/server clock
        // offset so time-based logic (e.g. shooter fire cycles) lines up across
        // machines regardless of whether each player's own OS clock is accurate,
        // instead of trusting every client's raw wall-clock to already agree.
        this.serverTimeOffset = 0;
    }

    getSyncedTime() {
        return Date.now() + this.serverTimeOffset;
    }

    connect(url) {
        this._disconnect();
        this._setStatus('connecting...');

        let socket;
        try {
            socket = new WebSocket(url);
        } catch (e) {
            this._setStatus('invalid address');
            return;
        }
        this.ws = socket;

        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ event: 'joinRoom', data: { room: ROOM_NAME } }));
        });

        socket.addEventListener('message', (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch (e) { return; }
            this._handleMessage(msg);
        });

        socket.addEventListener('close', () => {
            this.connected = false;
            this._setStatus('disconnected');
        });

        socket.addEventListener('error', () => {
            this._setStatus('connection error');
        });
    }

    _disconnect() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
        }
        this.ws = null;
        this.connected = false;
        this.remotes.forEach(avatar => avatar.dispose());
        this.remotes.clear();
        this._releaseAllRemoteHeld();
    }

    _releaseAllRemoteHeld() {
        const carryables = window.carryables;
        if (carryables) {
            this.remoteHeldIdx.forEach((_, idx) => {
                const cObj = carryables.find(c => c.netId === idx);
                if (cObj) { cObj.isCarried = false; cObj.velocity.set(0, 0, 0); }
            });
        }
        this.remoteHeldIdx.clear();
    }

    _handleMessage(msg) {
        if (msg.event === 'connectSuccess') {
            this.id = msg.data.socketId;
            this.connected = true;
            if (typeof msg.data.joinedTime === 'number') {
                this.serverTimeOffset = msg.data.joinedTime - Date.now();
            }
            this._setStatus('connected');
        } else if (msg.event === 'occupantsChanged') {
            const occupantIds = new Set(Object.keys(msg.data.occupants || {}));
            for (const [remoteId, avatar] of this.remotes) {
                if (!occupantIds.has(remoteId)) {
                    avatar.dispose();
                    this.remotes.delete(remoteId);
                    this._releaseHeldByRemote(remoteId);
                }
            }
            const count = occupantIds.size;
            this._setStatus(`connected (${count} player${count === 1 ? '' : 's'})`);
        } else if (msg.event === 'broadcast') {
            this._handlePlayerUpdate(msg.data);
        } else if (msg.event === 'send') {
            this._applyPunchEvent(msg.data && msg.data.pu);
        }
    }

    _handlePlayerUpdate(data) {
        if (!data || !data.id || data.id === this.id) return;

        if (data.te) {
            this._applyThrowEvent(data.id, data.te);
            return;
        }
        if (data.de) {
            this._applyDropEvent(data.id, data.de);
            return;
        }
        if (data.he) {
            this._applyHitEvent(data.id, data.he);
            return;
        }
        if (data.rd) {
            this._applyRagdollEvent(data.id, data.rd);
            return;
        }
        if (data.re) {
            this._applyRecoilEvent(data.id, data.re);
            return;
        }
        if (data.sb) {
            this._applySandbagHitEvent(data.sb);
            return;
        }
        if (data.su) {
            this._applyStandupEvent(data.id, data.su);
            return;
        }
        if (data.bc) {
            this._applyBuildCubeEvent(data.bc);
            return;
        }
        if (data.ab) {
            this._applyAiBotState(data.ab);
            return;
        }

        let avatar = this.remotes.get(data.id);
        if (!avatar) {
            avatar = new RemoteAvatar(this.scene, this.threeTone, data.id);
            this.remotes.set(data.id, avatar);
        }
        avatar.setNetworkState(data.p, data.q, data.s, data.cu);
        this._syncHeldObject(data.id, data.h);
    }

    // One-shot event fired at the moment of a throw, instead of streaming the
    // thrown object's position every frame: physics (gravity, collision) is
    // deterministic and already runs locally on every client once an object's
    // `isCarried` flag is false, so sending just the initial position/velocity
    // lets each client's own existing simulation reproduce the same arc rather
    // than needing to network-drive every frame of the flight.
    _applyThrowEvent(remoteId, te) {
        const carryables = window.carryables;
        if (!carryables || !te) return;
        const cObj = carryables.find(c => c.netId === te.idx);
        if (!cObj) return;

        this.remoteHeldIdx.delete(te.idx);
        const avatar = this.remotes.get(remoteId);
        if (avatar && avatar.heldMesh === cObj.mesh) avatar.heldMesh = null;

        cObj.isCarried = false;
        cObj.wasThrown = true;
        cObj.mesh.position.set(te.p[0], te.p[1], te.p[2]);
        cObj.mesh.quaternion.set(te.q[0], te.q[1], te.q[2], te.q[3]);
        cObj.velocity.set(te.v[0], te.v[1], te.v[2]);
    }

    // One-shot event fired the instant a drop starts (not when the local
    // gentle lower-to-ground tween finishes). Local drop keeps `isCarried`
    // true for its whole tween, gravity-free; without this, remotes would
    // keep seeing it as "held" only until the very next 10Hz tick reports
    // isCarryingObj=false, then release it into real gravity from hand
    // height, letting it crash to the floor (and possibly shatter jars).
    // Teleporting straight to the same floor-raycasted resting spot the
    // local tween is heading toward avoids that fall entirely.
    _applyDropEvent(remoteId, de) {
        const carryables = window.carryables;
        if (!carryables || !de) return;
        const cObj = carryables.find(c => c.netId === de.idx);
        if (!cObj) return;

        this.remoteHeldIdx.delete(de.idx);
        const avatar = this.remotes.get(remoteId);
        if (avatar && avatar.heldMesh === cObj.mesh) avatar.heldMesh = null;

        cObj.isCarried = false;
        cObj.velocity.set(0, 0, 0);
        cObj.mesh.position.set(de.p[0], de.p[1], de.p[2]);
        cObj.mesh.quaternion.set(de.q[0], de.q[1], de.q[2], de.q[3]);
    }

    // One-shot event fired the instant a shooter's projectile hits the local
    // player. Shooters aim only at their own client's local character (each
    // client independently simulates the same level's turrets against just
    // its own player), so remotes have no way to know a hit happened unless
    // told; this only drives the cosmetic hit-flash, no ragdoll/recoil.
    _applyHitEvent(remoteId, he) {
        if (!he) return;
        const avatar = this.remotes.get(remoteId);
        if (avatar) avatar.triggerHitFlash(he.strength);
        if (he.p) {
            const pos = new THREE.Vector3(he.p[0], he.p[1], he.p[2]);
            if (window.createHandHitEffect) window.createHandHitEffect(pos);
            if (window.spawnHitEffect) window.spawnHitEffect(pos);
        }
    }

    // One-shot event fired the instant the local player's own ragdoll trigger
    // fires (a "high" intensity shooter hit). No joint/particle data crosses
    // the network - each client runs RagdollPhysics locally on the RemoteAvatar,
    // seeded with just this velocity+intensity, the same way sendThrowEvent
    // lets each client's own deterministic physics reproduce a thrown object's
    // arc from a single initial condition instead of streaming every frame.
    _applyRagdollEvent(remoteId, rd) {
        if (!rd) return;
        const avatar = this.remotes.get(remoteId);
        if (!avatar) return;
        const velocity = new THREE.Vector3(rd.v[0], rd.v[1], rd.v[2]);
        avatar.initRagdoll(velocity, rd.i);
    }

    // One-shot event for non-ragdoll hits (low/medium/medium_high intensity):
    // a lightweight decaying lean/flinch on spine/neck, same RagdollPhysics
    // method (applyProceduralRecoil) Character uses, seeded with just the
    // projectile velocity + intensity - no continuous streaming needed since
    // the reaction is a short, deterministic decay curve.
    _applyRecoilEvent(remoteId, re) {
        if (!re) return;
        const avatar = this.remotes.get(remoteId);
        if (!avatar) return;
        const velocity = new THREE.Vector3(re.v[0], re.v[1], re.v[2]);
        avatar.applyProceduralRecoil(velocity, re.i);
    }

    // Sandbag is a single shared level object every client renders its own
    // instance of (like carryables) but never had its punch reaction synced -
    // Sandbag.applyHit is a pure impulse (sets a decaying recoil velocity +
    // flash timer) so, same as recoil/ragdoll above, one broadcast of the
    // punch direction/magnitude is enough for every client to reproduce the
    // same wobble+flash locally.
    _applySandbagHitEvent(sb) {
        const sacks = window.sacks;
        if (!sacks || !sb || !sacks[sb.idx]) return;
        const direction = new THREE.Vector3(sb.d[0], sb.d[1], sb.d[2]);
        sacks[sb.idx].applyHit(direction, sb.m);
    }

    // Punches are the one case that needs a *targeted* message rather than a
    // room-wide broadcast: only the specific player who got punched should
    // apply the hit to their own character. uws-server.js auto-subscribes
    // every socket to a topic named after its own socketId, so its generic
    // "send" event (not "broadcast") reaches just them. That client then
    // applies the same triggerHitFlash/applyProceduralRecoil/initRagdoll
    // reaction a projectile hit already uses, and rebroadcasts it with the
    // existing hit/recoil/ragdoll events so bystanders see it too.
    _applyPunchEvent(pu) {
        if (!pu || !pu.d) return;
        const char = window.localChar;
        if (!char || char.isRagdoll) return;

        // The attacker's own client already shows its white hit-dot/yellow
        // hand-flash locally (see detectMeleeHits in the HTML file) - those
        // never reached the victim or any bystander before, since only the
        // reaction (flash/recoil/ragdoll) was ever sent. Spawning the same
        // pair of cosmetic effects here, at the impact point the attacker
        // measured, closes that gap for the victim; sendHitEvent's broadcast
        // below carries the same position so bystanders see it too.
        const impactPos = pu.p ? new THREE.Vector3(pu.p[0], pu.p[1], pu.p[2]) : null;
        if (impactPos) {
            if (window.createHandHitEffect) window.createHandHitEffect(impactPos);
            if (window.spawnHitEffect) window.spawnHitEffect(impactPos);
        }

        const intensity = pu.m >= 70 ? 'high' : (pu.m >= 45 ? 'medium_high' : 'medium');
        // forceMagnitude (up to window.chargePunchForce for a mature charge
        // punch) is tuned for the sandbag's own hit response (wobble + flash),
        // not for how far it should send a player flying - fed straight into
        // initRagdoll it noticeably out-launched even a "high" intensity
        // shooter projectile (velocity ~20). window.chargePunchKnockback is
        // the actual, independently tunable ragdoll launch speed.
        const knockback = window.chargePunchKnockback !== undefined ? window.chargePunchKnockback : 20;
        const magnitudeForRagdoll = intensity === 'high' ? knockback : pu.m;
        const velocity = new THREE.Vector3(pu.d[0], pu.d[1], pu.d[2]).multiplyScalar(magnitudeForRagdoll);
        const flashStrengthByIntensity = { medium: 0.9, medium_high: 1.4, high: 2.5 };
        const strength = flashStrengthByIntensity[intensity] || 1.0;

        char.triggerHitFlash(strength);
        this.sendHitEvent(strength, impactPos);

        if (intensity === 'high') {
            char.initRagdoll(velocity, intensity);
            this.sendRagdollEvent(velocity, intensity);
            this._resetStagger();
            return;
        }

        // Hidden poise/stagger pool: a mature charge punch always knocks
        // someone down outright, but a flurry of ordinary punches should be
        // able to finish the job too, instead of the victim only ever
        // flinching from anything short of a charge hit. Each non-ragdoll hit
        // chips away at it; once exhausted, that hit (even a "light" one)
        // knocks them down instead, then the pool refills.
        if (window.playerStagger === undefined) window.playerStagger = window.playerStaggerMax !== undefined ? window.playerStaggerMax : 100;
        const staggerDamage = intensity === 'medium_high' ? 35 : 20;
        window.playerStagger -= staggerDamage;
        window.playerStaggerRegenCooldown = window.playerStaggerRegenDelay !== undefined ? window.playerStaggerRegenDelay : 2.5;

        if (window.playerStagger <= 0) {
            this._resetStagger();
            char.initRagdoll(velocity, 'high');
            this.sendRagdollEvent(velocity, 'high');
        } else {
            char.applyProceduralRecoil(velocity, intensity);
            this.sendRecoilEvent(velocity, intensity);
        }
    }

    _resetStagger() {
        window.playerStagger = window.playerStaggerMax !== undefined ? window.playerStaggerMax : 100;
        window.playerStaggerRegenCooldown = window.playerStaggerRegenDelay !== undefined ? window.playerStaggerRegenDelay : 2.5;
    }

    // Each client's RemoteAvatar ragdoll is its own independent simulation
    // (random jitter, and a starting pose that isn't frame-perfectly synced
    // with the real player's animation at the moment of the hit), so the fall
    // direction it works out on its own can end up facing a noticeably
    // different way than the real player's own beginStandUp actually computed.
    // Rather than trying to make the whole physics run deterministically, we
    // just broadcast the real result once standup begins and let the
    // RemoteAvatar snap to it, applied in RemoteAvatar.update() the moment its
    // own local ragdoll flag flips off (see _applyPendingStandupCorrection),
    // whichever order the correction and its own beginStandUp happen to land in.
    _applyStandupEvent(remoteId, su) {
        if (!su) return;
        const avatar = this.remotes.get(remoteId);
        if (avatar) avatar.setStandupOrientation(su.p, su.q);
    }

    // One-shot event fired when a player places a build-mode cube (B
    // button) - was purely local before (never broadcast at all), so other
    // players never saw cubes someone else placed.
    _applyBuildCubeEvent(bc) {
        if (!bc || !bc.p || !window.placeNetworkCube) return;
        window.placeNetworkCube(bc.p);
    }

    // Repeating state broadcast for the AI bot (see game_js.js's updateAiBot
    // call site) - whoever spawned it runs the actual wander/chase logic
    // locally and just streams the result, same as a real player's own
    // sendLocalState, just under the bot's fixed id instead of this.id.
    _applyAiBotState(ab) {
        if (!ab) return;
        if (!this.aiBotAvatar) this.aiBotAvatar = new RemoteAvatar(this.scene, this.threeTone, 'ai-bot-1');
        this.aiBotAvatar.setNetworkState(ab.p, ab.q, ab.s, false);
    }

    // A carryable is a shared level object (box/cylinder/jar), not something
    // networked per-player. While a remote player holds one, we freeze its
    // local physics (same "isCarried" gate the local pickup uses) and let
    // their RemoteAvatar position it from its own hand bones every frame
    // (see RemoteAvatar.updateHeldMesh) instead of snapping it to raw 10Hz
    // network samples, which ticked/stuttered. Matched by a permanent `netId`
    // (not array index) since jars get spliced out of `carryables` when they
    // shatter, which would otherwise shift indices out of sync between peers.
    _syncHeldObject(remoteId, held) {
        const carryables = window.carryables;
        if (!carryables) return;
        const avatar = this.remotes.get(remoteId);

        for (const [idx, holderId] of this.remoteHeldIdx) {
            if (holderId === remoteId && (!held || held.idx !== idx)) {
                const cObj = carryables.find(c => c.netId === idx);
                if (cObj) { cObj.isCarried = false; cObj.velocity.set(0, 0, 0); }
                this.remoteHeldIdx.delete(idx);
            }
        }

        if (avatar) avatar.heldMesh = null;

        if (held) {
            const cObj = carryables.find(c => c.netId === held.idx);
            if (cObj) {
                cObj.isCarried = true;
                cObj.velocity.set(0, 0, 0);
                if (avatar) avatar.heldMesh = cObj.mesh;
                this.remoteHeldIdx.set(held.idx, remoteId);
            }
        }
    }

    _releaseHeldByRemote(remoteId) {
        const carryables = window.carryables;
        for (const [idx, holderId] of this.remoteHeldIdx) {
            if (holderId === remoteId) {
                const cObj = carryables && carryables.find(c => c.netId === idx);
                if (cObj) { cObj.isCarried = false; cObj.velocity.set(0, 0, 0); }
                this.remoteHeldIdx.delete(idx);
            }
        }
    }

    _setStatus(text) {
        if (this.onStatusChange) this.onStatusChange(text);
    }

    sendLocalState(position, quaternion, stateName, carryUpper, heldNetId, delta) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.sendTimer -= delta;
        if (this.sendTimer > 0) return;
        this.sendTimer = SEND_RATE;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                p: [position.x, position.y, position.z],
                q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
                s: stateName,
                cu: !!carryUpper,
                h: (heldNetId !== null && heldNetId !== undefined) ? { idx: heldNetId } : null
            }
        }));
    }

    sendThrowEvent(netId, position, quaternion, velocity) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (netId === null || netId === undefined) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                te: {
                    idx: netId,
                    p: [position.x, position.y, position.z],
                    q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
                    v: [velocity.x, velocity.y, velocity.z]
                }
            }
        }));
    }

    sendDropEvent(netId, position, quaternion) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (netId === null || netId === undefined) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                de: {
                    idx: netId,
                    p: [position.x, position.y, position.z],
                    q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
                }
            }
        }));
    }

    sendHitEvent(strength, position) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                he: position ? { strength, p: [position.x, position.y, position.z] } : { strength }
            }
        }));
    }

    sendRagdollEvent(velocity, intensity) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                rd: { v: [velocity.x, velocity.y, velocity.z], i: intensity }
            }
        }));
    }

    sendRecoilEvent(velocity, intensity) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                re: { v: [velocity.x, velocity.y, velocity.z], i: intensity }
            }
        }));
    }

    sendSandbagHitEvent(idx, direction, magnitude) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                sb: { idx, d: [direction.x, direction.y, direction.z], m: magnitude }
            }
        }));
    }

    sendPunchEvent(targetId, direction, magnitude, position) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'send',
            data: {
                to: targetId,
                pu: position
                    ? { d: [direction.x, direction.y, direction.z], m: magnitude, p: [position.x, position.y, position.z] }
                    : { d: [direction.x, direction.y, direction.z], m: magnitude }
            }
        }));
    }

    sendStandupEvent(position, quaternion) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                su: { p: [position.x, position.y, position.z], q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] }
            }
        }));
    }

    sendBuildCubeEvent(position) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                bc: { p: [position.x, position.y, position.z] }
            }
        }));
    }

    sendAiBotState(position, quaternion, stateName, delta) {
        if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.aiBotSendTimer -= delta;
        if (this.aiBotSendTimer > 0) return;
        this.aiBotSendTimer = SEND_RATE;
        this.ws.send(JSON.stringify({
            event: 'broadcast',
            data: {
                id: this.id,
                ab: { p: [position.x, position.y, position.z], q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w], s: stateName }
            }
        }));
    }

    update(delta) {
        this.remotes.forEach(avatar => avatar.update(delta));
        if (this.aiBotAvatar) this.aiBotAvatar.update(delta);
    }
}
