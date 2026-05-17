import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

export class ShapeGenerator {
    constructor() {
        this.generators = {
            box: this.getRoundedBoxGeo.bind(this), cyl: this.getCylinderGeo.bind(this),
            cone: this.getConeGeo.bind(this), sphere: this.getSphereGeo.bind(this), torus: this.getTorusGeo.bind(this)
        };
    }
    
    generate(type, params) { return this.generators[type] ? this.generators[type](params) : new THREE.BufferGeometry(); }
    
    flipFaces(geometry) {
        const index = geometry.index;
        if (index) { const arr = index.array; for (let i = 0; i < index.count; i += 3) { const tmp = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = tmp; } }
        const normals = geometry.attributes.normal;
        if (normals) for (let i = 0; i < normals.count; i++) normals.setXYZ(i, -normals.getX(i), -normals.getY(i), -normals.getZ(i));
    }
    
    applyInversion2D(P_normal, r) {
        const S = new THREE.Vector2(Math.abs(P_normal.x) > 1e-6 ? Math.sign(P_normal.x) * r : 0, Math.abs(P_normal.y) > 1e-6 ? Math.sign(P_normal.y) * r : 0);
        const S_to_P = S.clone().sub(P_normal); let P_inv = new THREE.Vector2();
        if (S_to_P.lengthSq() > 1e-12) { S_to_P.setLength(r); P_inv.copy(S).sub(S_to_P); } else P_inv.copy(P_normal);
        return P_inv;
    }
    
    getProfileCorner(cx, cy, r, angleStart, angleSweep, progress, p) {
        if (r === 0) return new THREE.Vector2(cx, cy);
        const a = angleStart + angleSweep * progress;
        let P = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
        if (p.invertRadius) P = this.applyInversion2D(P, r);
        return new THREE.Vector2(cx + P.x, cy + P.y);
    }
    
    getLatheCuts(points, p, isClosedProfile = false) {
        if (points.length < 2) return new THREE.BufferGeometry();
        const cleanPoints = [points[0]];
        for (let i = 1; i < points.length; i++) if (points[i].distanceTo(cleanPoints[cleanPoints.length - 1]) > 1e-6) cleanPoints.push(points[i]);
        points = cleanPoints; if (points.length < 2) return new THREE.BufferGeometry();
        let pStart = 0, pLen = Math.PI * 2, doCaps = true;
        if (p.cutRadial) { pLen = p.radialAngle * Math.PI / 180; pStart = p.radialOffset * Math.PI / 180; doCaps = p.radialCap; } 
        else {
            const offX = p.offsetX * Math.PI, offZ = p.offsetZ * Math.PI;
            if (p.cutX && p.cutZ) { pLen = Math.PI / 2; if (!p.flipX && !p.flipZ) pStart = -Math.PI / 2 + offZ; if (!p.flipX && p.flipZ) pStart = 0 + offX; if (p.flipX && !p.flipZ) pStart = Math.PI + offX; if (p.flipX && p.flipZ) pStart = Math.PI / 2 + offZ; }
            else if (p.cutX) { pLen = Math.PI + (p.flipX ? offX : -offX); pStart = p.flipX ? Math.PI / 2 - offX : -Math.PI / 2; } 
            else if (p.cutZ) { pLen = Math.PI + (p.flipZ ? offZ : -offZ); pStart = p.flipZ ? 0 : Math.PI - offZ; }
        }
        const activeSegs = Math.max(3, Math.floor(p.radialSegments * (pLen / (Math.PI * 2))));
        const lathe = new THREE.LatheGeometry(points, activeSegs, pStart, pLen);
        if (pLen < Math.PI * 2 && doCaps) {
            const shape = new THREE.Shape();
            if (isClosedProfile) { shape.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) shape.lineTo(points[i].x, points[i].y); shape.lineTo(points[0].x, points[0].y); }
            else { shape.moveTo(0, points[0].y); points.forEach(pt => shape.lineTo(pt.x, pt.y)); shape.lineTo(0, points[points.length - 1].y); }
            const c0 = new THREE.ShapeGeometry(shape); c0.rotateY(-Math.PI / 2 + pStart);
            const c1 = new THREE.ShapeGeometry(shape); c1.rotateY(-Math.PI / 2 + pStart + pLen); this.flipFaces(c1);
            return BufferGeometryUtils.mergeGeometries([lathe, c0, c1]);
        }
        return lathe;
    }
    
    getCylinderGeo(p) {
        const points = [], w2 = p.width / 2, h2 = p.height / 2, r = p.cornerSegments === 0 ? 0 : Math.min(p.radius, w2, h2), oy = p.offsetY * h2;
        const fullPoints = []; fullPoints.push(new THREE.Vector2(0, -h2));
        for (let i = 0; i <= p.cornerSegments; i++) { let prog = i / Math.max(1, p.cornerSegments); prog = Math.sin(prog * Math.PI / 2); fullPoints.push(this.getProfileCorner(w2 - r, -h2 + r, r, -Math.PI / 2, Math.PI / 2, prog, p)); }
        const hSegs = Math.max(1, p.heightSegments || 1);
        for (let i = 1; i < hSegs; i++) { const t = i / hSegs; fullPoints.push(new THREE.Vector2(w2, (-h2 + r) * (1 - t) + (h2 - r) * t)); }
        for (let i = 0; i <= p.cornerSegments; i++) { let prog = i / Math.max(1, p.cornerSegments); prog = 1 - Math.cos(prog * Math.PI / 2); fullPoints.push(this.getProfileCorner(w2 - r, h2 - r, r, 0, Math.PI / 2, prog, p)); }
        fullPoints.push(new THREE.Vector2(0, h2));
        if (p.cutY) {
            if (p.flipY) {
                for (let i = 0; i < fullPoints.length; i++) { const pt = fullPoints[i]; if (pt.y <= oy) points.push(pt); else { if (i > 0) { const prev = fullPoints[i-1]; const t = (oy - prev.y) / (pt.y - prev.y); points.push(new THREE.Vector2(prev.x + t * (pt.x - prev.x), oy)); } break; } }
                points.push(new THREE.Vector2(0, oy));
            } else {
                points.push(new THREE.Vector2(0, oy)); let foundStart = false;
                for (let i = 0; i < fullPoints.length; i++) { const pt = fullPoints[i]; if (pt.y >= oy) { if (!foundStart && i > 0) { const prev = fullPoints[i-1]; const t = (oy - prev.y) / (pt.y - prev.y); points.push(new THREE.Vector2(prev.x + t * (pt.x - prev.x), oy)); } foundStart = true; points.push(pt); } }
            }
        } else points.push(...fullPoints);
        const geo = this.getLatheCuts(points, p, false); if (p.width > 0) geo.scale(1, 1, p.depth / p.width); return geo;
    }
    
    getConeGeo(p) {
        const points = [], w2 = p.width / 2, h2 = p.height / 2, cr = p.cornerSegments === 0 ? 0 : Math.min(p.radius, w2, p.height), oy = p.offsetY * h2;
        const dx = w2 - cr, dy = p.height - 2 * cr, normAngle = dy === 0 ? Math.PI / 2 : Math.atan2(dx, dy);
        const fullPoints = []; fullPoints.push(new THREE.Vector2(0, -h2));
        const bottomSweep = normAngle + Math.PI / 2;
        for (let i = 0; i <= p.cornerSegments; i++) { let prog = i / Math.max(1, p.cornerSegments); prog = Math.sin(prog * Math.PI / 2); fullPoints.push(this.getProfileCorner(w2 - cr, -h2 + cr, cr, -Math.PI / 2, bottomSweep, prog, p)); }
        const hSegs = Math.max(1, p.heightSegments || 1);
        for (let i = 1; i < hSegs; i++) {
            const t = i / hSegs, cx = (w2 - cr) * (1 - t), cy = (-h2 + cr) * (1 - t) + (h2 - cr) * t;
            let P = new THREE.Vector2(Math.cos(normAngle) * cr, Math.sin(normAngle) * cr);
            if (p.invertRadius) P = this.applyInversion2D(P, cr);
            fullPoints.push(new THREE.Vector2(cx + P.x, cy + P.y));
        }
        if (p.coneRoundTip) {
            const topSweep = Math.PI / 2 - normAngle;
            for (let i = 0; i <= p.cornerSegments; i++) { let prog = i / Math.max(1, p.cornerSegments); prog = 1 - Math.cos(prog * Math.PI / 2); fullPoints.push(this.getProfileCorner(0, h2 - cr, cr, normAngle, topSweep, prog, p)); }
            fullPoints.push(new THREE.Vector2(0, h2));
        } else fullPoints.push(new THREE.Vector2(0, h2));
        
        if (p.cutY) {
            if (p.flipY) {
                for (let i = 0; i < fullPoints.length; i++) { const pt = fullPoints[i]; if (pt.y <= oy) points.push(pt); else { if (i > 0) { const prev = fullPoints[i-1]; const t = (oy - prev.y) / (pt.y - prev.y); points.push(new THREE.Vector2(prev.x + t * (pt.x - prev.x), oy)); } break; } }
                points.push(new THREE.Vector2(0, oy));
            } else {
                points.push(new THREE.Vector2(0, oy)); let foundStart = false;
                for (let i = 0; i < fullPoints.length; i++) { const pt = fullPoints[i]; if (pt.y >= oy) { if (!foundStart && i > 0) { const prev = fullPoints[i-1]; const t = (oy - prev.y) / (pt.y - prev.y); points.push(new THREE.Vector2(prev.x + t * (pt.x - prev.x), oy)); } foundStart = true; points.push(pt); } }
            }
        } else points.push(...fullPoints);
        const geo = this.getLatheCuts(points, p, false); if (p.width > 0) geo.scale(1, 1, p.depth / p.width); return geo;
    }
    
    getSphereGeo(p) {
        if (p.isIcosahedron) {
            const radius = p.width / 2;
            const detail = Math.max(0, Math.floor(p.cornerSegments));
            const geo = new THREE.IcosahedronGeometry(radius, detail);
            if (p.width > 0) geo.scale(1, p.height / p.width, p.depth / p.width);
            return geo;
        }
        const points = [], r = p.width / 2; let aStart = -Math.PI / 2, aEnd = Math.PI / 2;
        const limit = Math.asin(Math.max(-1, Math.min(1, p.offsetY)));
        if (p.cutY) { if (p.flipY) aEnd = limit; else aStart = limit; }
        const detail = Math.max(4, p.cornerSegments * 2);
        for (let i = 0; i <= detail; i++) {
            const angle = aStart + (aEnd - aStart) * (i / detail);
            let P = new THREE.Vector2(Math.cos(angle) * r, Math.sin(angle) * r);
            if (p.invertRadius) P = this.applyInversion2D(P, r);
            points.push(P);
        }
        const geo = this.getLatheCuts(points, p, false); if (p.width > 0) geo.scale(1, 1, p.depth / p.width); return geo;
    }
    
    getTorusGeo(p) {
        const points = [], rMain = p.width / 2, rTube = p.torusTube;
        let aStart = 0, aEnd = Math.PI * 2, isClosed = true;
        if (p.cutY) { isClosed = false; const limit = p.offsetY * Math.PI; if (p.flipY) { aStart = Math.PI + limit; aEnd = Math.PI * 2 - limit; } else { aStart = 0 + limit; aEnd = Math.PI - limit; } }
        const detail = Math.max(4, p.cornerSegments * 2);
        for (let i = 0; i <= detail; i++) {
            const angle = aStart + (aEnd - aStart) * (i / detail);
            let P = new THREE.Vector2(Math.cos(angle) * rTube, Math.sin(angle) * rTube);
            if (p.invertRadius) P = this.applyInversion2D(P, rTube);
            points.push(new THREE.Vector2(rMain + P.x, P.y));
        }
        const geo = this.getLatheCuts(points, p, isClosed); if (p.width > 0) geo.scale(1, 1, p.depth / p.width); return geo;
    }
    
    getGrid(size, cut, flip, r, s, offset = 0) {
        const pos = [], shift = offset * size / 2;
        if (s === 0) { if (cut) pos.push(flip ? -size / 2 : shift, flip ? shift : size / 2); else pos.push(-size / 2, size / 2); return pos; }
        if (cut) { if (flip) { for (let i = 0; i <= s; i++) pos.push(-size / 2 + r * (i / s)); pos.push(shift); } else { pos.push(shift); for (let i = 0; i <= s; i++) pos.push(size / 2 - r + r * (i / s)); } } 
        else { for (let i = 0; i <= s; i++) pos.push(-size / 2 + r * (i / s)); for (let i = 0; i <= s; i++) pos.push(size / 2 - r + r * (i / s)); }
        return pos;
    }
    
    getRoundedBoxGeo(p) {
        const w = p.width, h = p.height, d = p.depth, r = p.cornerSegments === 0 ? 0 : Math.min(p.radius, w / 2, h / 2, d / 2);
        const rx = p.flatX ? 0 : r, ry = p.flatY ? 0 : r, rz = p.flatZ ? 0 : r;
        const boxSegs = p.cornerSegments === 0 ? 0 : Math.max(1, Math.round(p.cornerSegments / 2));
        const sx = p.flatX || r === 0 ? 0 : boxSegs, sy = p.flatY || r === 0 ? 0 : boxSegs, sz = p.flatZ || r === 0 ? 0 : boxSegs;
        const xGrid = this.getGrid(w, p.cutX, p.flipX, rx, sx, p.offsetX), yGrid = this.getGrid(h, p.cutY, p.flipY, ry, sy, p.offsetY), zGrid = this.getGrid(d, p.cutZ, p.flipZ, rz, sz, p.offsetZ);
        const segX = p.cutX ? sx + 1 : (sx === 0 ? 1 : 2 * sx + 1), segY = p.cutY ? sy + 1 : (sy === 0 ? 1 : 2 * sy + 1), segZ = p.cutZ ? sz + 1 : (sz === 0 ? 1 : 2 * sz + 1);
        const geo = new THREE.BoxGeometry(1, 1, 1, segX, segY, segZ), pos = geo.attributes.position;
        const offX = p.offsetX * w / 2, offY = p.offsetY * h / 2, offZ = p.offsetZ * d / 2;
        const lims = {
            x: p.cutX ? (p.flipX ? [-w / 2 + rx, offX] : [offX, w / 2 - rx]) : [-w / 2 + rx, w / 2 - rx],
            y: p.cutY ? (p.flipY ? [-h / 2 + ry, offY] : [offY, h / 2 - ry]) : [-h / 2 + ry, h / 2 - ry],
            z: p.cutZ ? (p.flipZ ? [-d / 2 + rz, offZ] : [offZ, d / 2 - rz]) : [-d / 2 + rz, d / 2 - rz]
        };
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            const ix = Math.max(0, Math.min(xGrid.length - 1, Math.round((x + 0.5) * segX))), iy = Math.max(0, Math.min(yGrid.length - 1, Math.round((y + 0.5) * segY))), iz = Math.max(0, Math.min(zGrid.length - 1, Math.round((z + 0.5) * segZ)));
            const nx = xGrid[ix] ?? 0, ny = yGrid[iy] ?? 0, nz = zGrid[iz] ?? 0;
            const v = new THREE.Vector3(nx, ny, nz);
            const c = new THREE.Vector3(Math.max(lims.x[0], Math.min(lims.x[1], v.x)), Math.max(lims.y[0], Math.min(lims.y[1], v.y)), Math.max(lims.z[0], Math.min(lims.z[1], v.z)));
            const delta = v.clone().sub(c); const distSq = delta.lengthSq();
            if (distSq > 1e-12 && !isNaN(distSq)) {
                if (p.invertRadius && r > 0) {
                    delta.normalize(); const P_normal = delta.clone().multiplyScalar(r);
                    const S = new THREE.Vector3(Math.abs(delta.x) > 1e-6 ? Math.sign(delta.x) * r : 0, Math.abs(delta.y) > 1e-6 ? Math.sign(delta.y) * r : 0, Math.abs(delta.z) > 1e-6 ? Math.sign(delta.z) * r : 0);
                    const S_to_P = S.clone().sub(P_normal); let P_inv = new THREE.Vector3();
                    if (S_to_P.lengthSq() > 1e-12) { S_to_P.setLength(r); P_inv.copy(S).sub(S_to_P); } else P_inv.copy(P_normal);
                    delta.copy(P_inv); v.copy(c).add(delta);
                } else { delta.setLength(r); v.copy(c).add(delta); }
            } else { pos.setXYZ(i, isNaN(v.x) ? 0 : v.x, isNaN(v.y) ? 0 : v.y, isNaN(v.z) ? 0 : v.z); continue; }
            pos.setXYZ(i, isNaN(v.x) ? 0 : v.x, isNaN(v.y) ? 0 : v.y, isNaN(v.z) ? 0 : v.z);
        }
        return geo;
    }
    
    processTriangles(geometry, p) {
        if (!geometry.index) return geometry;
        const pos = geometry.attributes.position, indices = geometry.index.array, newIndices = [], eps = 0.001;
        const hw = p.width / 2, hh = p.height / 2, hd = p.depth / 2, offX = p.offsetX * hw, offY = p.offsetY * hh, offZ = p.offsetZ * hd;
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i], b = indices[i + 1], c = indices[i + 2];
            if (p.cleanDegenerate && (a === b || b === c || a === c)) continue;
            const x0 = pos.getX(a), y0 = pos.getY(a), z0 = pos.getZ(a), x1 = pos.getX(b), y1 = pos.getY(b), z1 = pos.getZ(b), x2 = pos.getX(c), y2 = pos.getY(c), z2 = pos.getZ(c);
            if (p.cutX && !p.capX && Math.abs(x0 - offX) < eps && Math.abs(x1 - offX) < eps && Math.abs(x2 - offX) < eps) continue;
            if (p.cutY && !p.capY && Math.abs(y0 - offY) < eps && Math.abs(y1 - offY) < eps && Math.abs(y2 - offY) < eps) continue;
            if (p.cutZ && !p.capZ && Math.abs(z0 - offZ) < eps && Math.abs(z1 - offZ) < eps && Math.abs(z2 - offZ) < eps) continue;
            if (p.flatX && !p.capFlatX) { if (Math.abs(x0 - hw) < eps && Math.abs(x1 - hw) < eps && Math.abs(x2 - hw) < eps) continue; if (Math.abs(x0 + hw) < eps && Math.abs(x1 + hw) < eps && Math.abs(x2 + hw) < eps) continue; }
            if (p.flatY && !p.capFlatY) { if (Math.abs(y0 - hh) < eps && Math.abs(y1 - hh) < eps && Math.abs(y2 - hh) < eps) continue; if (Math.abs(y0 + hh) < eps && Math.abs(y1 + hh) < eps && Math.abs(y2 + hh) < eps) continue; }
            if (p.flatZ && !p.capFlatZ) { if (Math.abs(z0 - hd) < eps && Math.abs(z1 - hd) < eps && Math.abs(z2 - hd) < eps) continue; if (Math.abs(z0 + hd) < eps && Math.abs(z1 + hd) < eps && Math.abs(z2 + hd) < eps) continue; }
            newIndices.push(a, b, c);
        }
        geometry.setIndex(newIndices);
        return geometry;
    }
}