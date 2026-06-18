import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const level2Json = {
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

export function exportLevelToJson(context, buildPreview) {
  const data = { metadata: { author: "Player", version: "1.0" }, voxels: [], entities: [] };
  context.collidables.forEach(c => {
    if (c !== context.ground && c.geometry && c.geometry.type === 'RoundedBoxGeometry' && c !== buildPreview) {
      if (c.userData && c.userData.isCarryable) return;
      data.voxels.push([
        Math.round(c.position.x / context.cubeSize), 
        Math.round((c.position.y - context.cubeSize / 2) / context.cubeSize), 
        Math.round(c.position.z / context.cubeSize)
      ]);
    }
    if (c.geometry && c.geometry.type === 'SphereGeometry') {
      data.entities.push({ type: 'hemisphere', pos: [c.position.x, c.position.y, c.position.z] });
    }
  });
  data.entities.push({ type: 'star', pos: [context.star.position.x, context.star.position.y, context.star.position.z] });
  data.entities.push({ type: 'playerStart', pos: [context.char.group.position.x, context.char.group.position.y, context.char.group.position.z] });
  context.shooters.forEach(s => data.entities.push({ type: 'shooter', pos: [s.mesh.position.x, s.mesh.position.y, s.mesh.position.z] }));
  return JSON.stringify(data, null, 2);
}

export function buildLevelFromJson(data, context, ShooterBox) {
  while (context.levelGroup.children.length > 0) {
    context.levelGroup.remove(context.levelGroup.children[0]);
  }
  context.shooters.forEach(s => context.scene.remove(s.mesh));
  context.shooters.length = 0;
  context.projectiles.forEach(p => context.scene.remove(p.mesh));
  context.projectiles.length = 0;
  context.carryables.length = 0;
  context.collidables.length = 0;
  context.collidables.push(context.ground);

  if (data.voxels) {
    data.voxels.forEach(v => {
      const mesh = new THREE.Mesh(context.boxGeoTemplate, context.platMat);
      mesh.position.set(v[0] * context.cubeSize, context.cubeSize / 2 + v[1] * context.cubeSize, v[2] * context.cubeSize);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      context.levelGroup.add(mesh);
      context.collidables.push(mesh);
    });
  }
  if (data.entities) {
    data.entities.forEach(e => {
      if (e.type === 'star') {
        context.star.position.set(e.pos[0], e.pos[1], e.pos[2]);
        context.star.visible = true;
      }
      if (e.type === 'playerStart') {
        context.char.group.position.set(e.pos[0], e.pos[1], e.pos[2]);
        context.char.group.rotation.y = Math.PI;
      }
      if (e.type === 'shooter') {
        const shooter = new ShooterBox(context.levelGroup, e.pos[0], e.pos[1], e.pos[2]);
        context.shooters.push(shooter);
        context.collidables.push(shooter.mesh);
      }
      if (e.type === 'hemisphere') {
        const hemisphere = new THREE.Mesh(
          new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: context.threeTone })
        );
        hemisphere.position.set(e.pos[0], e.pos[1], e.pos[2]);
        hemisphere.castShadow = true;
        hemisphere.receiveShadow = true;
        context.levelGroup.add(hemisphere);
        context.collidables.push(hemisphere);
      }
    });
  }
}

export function buildStairsLevel(context) {
  const hemisphere = new THREE.Mesh(
    new THREE.SphereGeometry(6, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshToonMaterial({ color: 0xaa5555, gradientMap: context.threeTone })
  );
  hemisphere.position.set(10, 0, -10);
  hemisphere.castShadow = true;
  hemisphere.receiveShadow = true;
  context.levelGroup.add(hemisphere);
  context.collidables.push(hemisphere);

  const startMesh = new THREE.Mesh(context.boxGeoTemplate, context.platMat);
  startMesh.position.set(0, context.cubeSize / 2, 0);
  startMesh.castShadow = true;
  startMesh.receiveShadow = true;
  context.levelGroup.add(startMesh);
  context.collidables.push(startMesh);

  for (let i = 0; i < 6; i++) {
    const mesh = new THREE.Mesh(context.boxGeoTemplate, context.platMat);
    mesh.position.set(0, context.cubeSize / 2 + i * context.cubeSize * 0.9, -10 - i * context.cubeSize);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    context.levelGroup.add(mesh);
    context.collidables.push(mesh);
  }

  const movableBoxGeo = new RoundedBoxGeometry(context.cubeSize, context.cubeSize, context.cubeSize, 1, 0.15);
  const movableBoxMat = new THREE.MeshToonMaterial({ color: 0xffaa00, gradientMap: context.threeTone });
  const mBox = new THREE.Mesh(movableBoxGeo, movableBoxMat);
  mBox.position.set(-10, context.cubeSize / 2, 0);
  mBox.castShadow = true;
  mBox.receiveShadow = true;
  mBox.userData.isMovable = true;
  context.levelGroup.add(mBox);
  context.collidables.push(mBox);

  const smallBoxGeo = new RoundedBoxGeometry(1.0, 1.0, 1.0, 1, 0.05);
  const smallBoxMat = new THREE.MeshToonMaterial({ color: 0x00ffaa, gradientMap: context.threeTone });
  const smallBox = new THREE.Mesh(smallBoxGeo, smallBoxMat);
  smallBox.position.set(-6, 0.5, 0);
  smallBox.castShadow = true;
  smallBox.receiveShadow = true;
  smallBox.userData.isCarryable = true;
  context.levelGroup.add(smallBox);
  context.collidables.push(smallBox);
  context.carryables.push({ mesh: smallBox, velocity: new THREE.Vector3(), isCarried: false, wasThrown: false });

  context.star.position.set(0, (5 * context.cubeSize * 0.9) + context.cubeSize + 2, -10 - 5 * context.cubeSize);
  context.star.visible = true;
  context.char.group.position.set(0, context.cubeSize, 0);
  context.char.group.rotation.y = Math.PI;
}

export async function buildLevel(currentLevel, context, ShooterBox) {
  while (context.levelGroup.children.length > 0) {
    context.levelGroup.remove(context.levelGroup.children[0]);
  }
  context.shooters.forEach(s => context.scene.remove(s.mesh));
  context.shooters.length = 0;
  context.projectiles.forEach(p => context.scene.remove(p.mesh));
  context.projectiles.length = 0;
  context.carryables.length = 0;
  context.collidables.length = 0;
  context.collidables.push(context.ground);

  if (currentLevel === "local_stairs") {
    buildStairsLevel(context);
  } else if (currentLevel === "local_json") {
    buildLevelFromJson(level2Json, context, ShooterBox);
  } else {
    try {
      if (currentLevel.endsWith('.js')) {
        const module = await import(currentLevel);
        if (module.default) {
          module.default(
            context.scene, 
            context.levelGroup, 
            context.collidables, 
            THREE, 
            context.cubeSize, 
            context.platMat, 
            context.boxGeoTemplate, 
            context.star, 
            context.char
          );
        }
      } else if (currentLevel.endsWith('.json')) {
        const res = await fetch(currentLevel);
        buildLevelFromJson(await res.json(), context, ShooterBox);
      }
    } catch (e) {
      buildStairsLevel(context);
    }
  }
}

export async function populateLevelsAndLoad(selectElement, defaultLevel, context, ShooterBox, callback) {
  selectElement.innerHTML = '<option value="local_stairs">Level 1 (Stairs)</option><option value="local_json">Level 2 (JSON)</option>';
  try {
    const res = await fetch('https://api.github.com/repos/XYremesher/CustomGizmo/contents/Levels');
    if (res.ok) {
      const files = await res.json();
      files.forEach(file => {
        if (file.name.endsWith('.js') || file.name.endsWith('.json')) {
          const opt = document.createElement('option');
          opt.value = `https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Levels/${file.name}`;
          opt.textContent = `Remote: ${file.name}`;
          selectElement.appendChild(opt);
        }
      });
    }
  } catch (e) {}
  selectElement.value = defaultLevel;
  await buildLevel(defaultLevel, context, ShooterBox);
  if (callback) callback();
}