import * as THREE from 'three';

export class EditorUI {
    constructor(core) {
        this.core = core;
        this.timelineScale = 60;
        this.selectedLayerIndex = -1;
    }

    customPrompt(msg, defaultVal, callback) {
        const m = document.getElementById('custom-prompt'), inp = document.getElementById('custom-prompt-input');
        document.getElementById('custom-prompt-msg').textContent = msg; inp.value = defaultVal || '';
        m.style.display = 'flex'; inp.focus(); inp.select();
        const cleanup = () => { m.style.display = 'none'; document.getElementById('custom-prompt-ok').onclick = null; document.getElementById('custom-prompt-cancel').onclick = null; inp.onkeydown = null; };
        const confirm = () => { const v = inp.value.trim(); cleanup(); callback(v); };
        document.getElementById('custom-prompt-ok').onclick = confirm; document.getElementById('custom-prompt-cancel').onclick = cleanup;
        inp.onkeydown = (e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') cleanup(); };
    }

    updateLockIcon(locked) { 
        const b = document.getElementById('btn-lock-toggle'); 
        if(b) b.innerHTML = locked ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>'; 
    }

    refreshSelectionUI() {
        const core = this.core;
        core.editorRoot.traverse(m => { if(m.material && m.userData.originalEmissive!==undefined) m.material.emissive.setHex(m.userData.originalEmissive); });
        document.querySelectorAll('.outliner-item-container').forEach(el => el.classList.remove('selected'));

        const meshesToOutline = new Set();
        core.selectedObjects.forEach(obj => {
            if (core.useOutline) {
                obj.traverse(n => {
                    if (n.isMesh && !n.userData?.isHelper && n.userData?.shapeType !== 'Empty') meshesToOutline.add(n);
                });
            }
            obj.traverse(n => {
                if (core.useHighlight && n.material?.emissive) { if(n.userData.originalEmissive===undefined) n.userData.originalEmissive=n.material.emissive.getHex(); n.material.emissive.setHex(0x555555); }
            });
            const i = document.getElementById(`item-${obj.uuid}`); if(i) i.classList.add('selected');
        });
        core.outlinePass.selectedObjects = Array.from(meshesToOutline);

        if (core.selectedObjects.some(o => o.type === 'Group' || o.userData?.isDefCollection || o.userData?.defColId)) {
            core.outlinePass.visibleEdgeColor.set('#ffff00');
        } else {
            core.outlinePass.visibleEdgeColor.set(document.getElementById('set-out-color').value || '#ffffff');
        }

        const p = document.getElementById('floating-properties'), nE = document.getElementById('active-obj-name');
        if (core.selectedObjects.length > 0) {
            p.style.display = 'flex';
            if(core.selectedObjects.length > 1) { 
                if(nE) nE.textContent = `Multi-Edit (${core.selectedObjects.length})`; 
                core.updateMultiSelectPivot(); 
                if(!core.isShapeMode) { core.gizmo.attach(core.multiSelectPivot); core.gizmoTarget = core.multiSelectPivot; }
                if(core.shapeGizmo) core.shapeGizmo.detach();
            }
            else { 
                if(nE) nE.textContent = core.selectedObjects[0].name; 
                this.updateLockIcon(core.selectedObjects[0].userData.transformLock); 
                if(core.selectedObjects[0]!==core.editorRoot) { 
                    if (core.isShapeMode) {
                        core.gizmo.detach();
                        core.gizmoTarget = null;
                        if (core.shapeGizmo && core.selectedObjects[0].userData.shapeType && core.selectedObjects[0].userData.shapeType !== 'Empty' && core.selectedObjects[0].userData.shapeType !== 'GLTF') {
                            const stMap = { 'Cube': 'box', 'Cylinder': 'cyl', 'Cone': 'cone', 'Sphere': 'sphere', 'Torus': 'torus' };
                            core.shapeGizmo.attach(core.selectedObjects[0], core.selectedObjects[0].userData.params, stMap[core.selectedObjects[0].userData.shapeType]);
                        }
                    } else {
                        core.gizmo.attach(core.selectedObjects[0]); 
                        core.gizmoTarget = core.selectedObjects[0];
                        if(core.shapeGizmo) core.shapeGizmo.detach();
                    }
                } else { 
                    core.gizmo.detach(); 
                    core.gizmoTarget = null;
                    if(core.shapeGizmo) core.shapeGizmo.detach();
                } 
            }
            this.updateTransformUI(); this.renderGeometryUI(); this.renderMaterialUI(); this.renderObjectUI();
        } else { 
            p.style.display = 'none'; 
            core.gizmo.detach(); 
            core.gizmoTarget = null; 
            if(core.shapeGizmo) core.shapeGizmo.detach();
            this.updateTransformUI(); this.renderGeometryUI(); this.renderMaterialUI(); this.renderObjectUI(); 
        }
    }

    updateTransformUI() {
        const core = this.core;
        if (!core.selectedObjects.length) return;
        const f = [ {id:'posX',fn:o=>o.position.x.toFixed(2)}, {id:'posY',fn:o=>o.position.y.toFixed(2)}, {id:'posZ',fn:o=>o.position.z.toFixed(2)}, {id:'rotX',fn:o=>(o.rotation.x*180/Math.PI).toFixed(0)}, {id:'rotY',fn:o=>(o.rotation.y*180/Math.PI).toFixed(0)}, {id:'rotZ',fn:o=>(o.rotation.z*180/Math.PI).toFixed(0)}, {id:'scaleX',fn:o=>o.scale.x.toFixed(2)}, {id:'scaleY',fn:o=>o.scale.y.toFixed(2)}, {id:'scaleZ',fn:o=>o.scale.z.toFixed(2)} ];
        f.forEach(x => { const el=document.getElementById(x.id); if(el) el.value = core.getCommon(core.selectedObjects, x.fn) ?? ""; });
        const colEl = document.getElementById('obj-color');
        if (colEl) {
            const meshes = []; core.selectedObjects.forEach(o => o.traverse(c => { if(c.isMesh && !c.userData?.isHelper) meshes.push(c); }));
            const cVal = core.getCommon(meshes, o => o.userData.originalColor?new THREE.Color(...o.userData.originalColor).getHexString():null);
            colEl.value = cVal !== null ? '#'+cVal : "#ffffff";
        }
    }

    renderMaterialUI() {
        const core = this.core;
        const h = document.getElementById('acc-mat-header'), c = document.getElementById('acc-mat'), meshes = [];
        core.selectedObjects.forEach(o => o.traverse(x => { if(x.isMesh && !x.userData?.isHelper && x.userData.shapeType!=='Empty') meshes.push(x); }));
        if(!c || !h || !meshes.length) { if(h) h.style.display='none'; if(c) c.style.display='none'; return; }
        h.style.display = 'flex';
        const setV = (id, prop, def) => { 
            const el=document.getElementById(id); if(!el) return; 
            const v = core.getCommon(meshes, o=>o.userData[prop]); 
            if(el.type==='checkbox') { el.checked = !!v; el.indeterminate = (v===null||v===undefined); } 
            else if(el.type==='color') el.value = (v===null||v===undefined||!Array.isArray(v))?'#ffffff':'#'+new THREE.Color(...v).getHexString(); 
            else el.value = (v!==null&&v!==undefined)?v:(def??""); 
        };
        ['materialType','side','roughness','metalness','transparent','wireframe','opacity','emissive','emissiveIntensity','clearcoat','clearcoatRoughness','transmission','ior','thickness','flatShading','depthTest','depthWrite','alphaTest'].forEach(p => setV('mat-'+(p==='materialType'?'type':p), p));
        const tVal = document.getElementById('mat-type').value, isPBR = tVal==='Standard'||tVal==='Physical'||tVal==='';
        document.getElementById('mat-rough-group').style.display = isPBR?'grid':'none'; document.getElementById('mat-metal-group').style.display = isPBR?'grid':'none';
        document.querySelectorAll('.physical-prop').forEach(el => el.style.display = (tVal==='Physical'||tVal==='')?'grid':'none');
    }

    renderObjectUI() {
        const core = this.core;
        const c = document.getElementById('acc-obj'), h = document.getElementById('acc-obj-header');
        if(!c || !h || !core.selectedObjects.length) { if(h) h.style.display='none'; if(c) c.style.display='none'; return; }
        h.style.display = 'flex';
        ['castShadow','receiveShadow','visible'].forEach(p => { const el=document.getElementById('obj-'+p); if(el){ const v=core.getCommon(core.selectedObjects,o=>o.userData[p]); el.checked=v||false; el.indeterminate=v===null; } });
    }

    renderGeometryUI() {
        const core = this.core;
        const c = document.getElementById('geom-params-container'), h = document.getElementById('acc-shape-header'); 
        const cCuts = document.getElementById('cuts-params-container'), hCuts = document.getElementById('acc-cuts-header');
        if(!c || !h || !cCuts || !hCuts) return; 
        c.innerHTML = ''; cCuts.innerHTML = '';
        const m = core.selectedObjects.filter(o => o.isMesh && o.userData.shapeType && o.userData.shapeType!=='Empty' && o.userData.shapeType!=='GLTF');
        if(!m.length) { h.style.display='none'; hCuts.style.display='none'; return; }
        const st = core.getCommon(m, o => o.userData.shapeType); if(st === null) { h.style.display='none'; hCuts.style.display='none'; return; }
        h.style.display = 'flex'; hCuts.style.display = 'flex';
        
        const cutHierarchy = [
            { toggle: 'cutX', subs: ['capX', 'flipX', 'flatX', 'capFlatX', 'offsetX'] },
            { toggle: 'cutY', subs: ['capY', 'flipY', 'flatY', 'capFlatY', 'offsetY'] },
            { toggle: 'cutZ', subs: ['capZ', 'flipZ', 'flatZ', 'capFlatZ', 'offsetZ'] },
            { toggle: 'cutRadial', subs: ['radialAngle', 'radialOffset', 'radialCap'] }
        ];
        const bottomCuts = ['centerCut', 'centerBottom'];
        const allCutKeys = new Set([...bottomCuts]);
        cutHierarchy.forEach(g => { allCutKeys.add(g.toggle); g.subs.forEach(s => allCutKeys.add(s)); });

        const createInput = (key) => {
            const r = document.createElement('div'); r.className = 'transform-group'; 
            const l = document.createElement('label'); l.textContent = key.charAt(0).toUpperCase()+key.slice(1); l.title=key;
            const val = core.getCommon(m, o=>o.userData.params[key]);
            const isBool = typeof val === 'boolean';
            const inp = document.createElement('input'); inp.type = isBool ? 'checkbox' : 'number';
            if (isBool) inp.checked = !!val; else { inp.value = val??""; inp.step=(key.includes('egment')||key==='detail')?'1':(key.includes('Angle')?'1':'0.1'); }
            inp.onmousedown = () => { if(document.activeElement!==inp && !isBool) core.saveState(); };
            inp.onchange = (e) => {
                const v = isBool ? e.target.checked : parseFloat(e.target.value);
                if(!isBool && isNaN(v)) return;
                core.selectedObjects.forEach(so => { if(so.userData.shapeType===st) core.applyToLinkedInstances(so, t => { t.userData.params[key]=v; core.rebuildGeometry(t); }); });
                if(core.shapeGizmo) core.shapeGizmo.update();
                if(isBool && cutHierarchy.some(g=>g.toggle===key)) this.renderGeometryUI();
            };
            if (!isBool) inp.oninput = inp.onchange;
            r.append(l, inp); 
            return r;
        };

        for (let key in m[0].userData.params) {
            if (!allCutKeys.has(key)) c.appendChild(createInput(key));
        }
        
        cutHierarchy.forEach(group => {
            if (m[0].userData.params[group.toggle] !== undefined) {
                cCuts.appendChild(createInput(group.toggle));
                const isToggled = core.getCommon(m, o=>o.userData.params[group.toggle]);
                if (isToggled) {
                    const sub = document.createElement('div');
                    sub.style.cssText = 'display:flex;flex-direction:column;gap:1px;padding-left:4px;border-left:1px solid #444;margin-left:2px;margin-bottom:4px;';
                    group.subs.forEach(subKey => {
                        if (m[0].userData.params[subKey] !== undefined) sub.appendChild(createInput(subKey));
                    });
                    cCuts.appendChild(sub);
                }
            }
        });

        bottomCuts.forEach(key => {
            if (m[0].userData.params[key] !== undefined) cCuts.appendChild(createInput(key));
        });
        
        if(cCuts.children.length === 0) hCuts.style.display = 'none';
        if(c.children.length === 0) h.style.display = 'none';
    }

    populateOutliner() {
        const core = this.core;
        const container = document.getElementById('outliner'); if (!container) return;
        container.innerHTML = ''; core.outlinerFlatNodes = []; let pt = null, isD = false, ce = null;
        
        container.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); container.classList.add('drag-over'); };
        container.ondragleave = () => container.classList.remove('drag-over');
        container.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); container.classList.remove('drag-over'); core.saveState(); core.handleDrop(e, core.editorRoot); };

        const renderNode = (node, pEl) => {
            if(node.userData?.isHelper) return;
            core.outlinerFlatNodes.push(node);
            const w = document.createElement('div'), d = document.createElement('div'); d.className = 'outliner-item-container'; if(core.selectedObjects.includes(node)) d.classList.add('selected'); d.id = `item-${node.uuid}`;
            
            d.draggable = true; d.ondragstart = (e) => { if(core.isMultiSelectMode){e.preventDefault();return;} e.dataTransfer.setData('text/plain', node.uuid); e.stopPropagation(); };
            d.addEventListener('touchstart', () => { if(core.isMultiSelectMode)return; pt = setTimeout(() => { isD = true; ce = d.cloneNode(true); ce.style.position = 'fixed'; ce.style.opacity = '0.8'; ce.style.pointerEvents = 'none'; ce.style.zIndex = '9999'; document.body.appendChild(ce); d.style.opacity = '0.4'; }, 500); }, {passive:true});
            d.addEventListener('touchmove', (e) => { if(!isD) { clearTimeout(pt); return; } e.preventDefault(); const t = e.touches[0]; if(ce){ce.style.left=t.clientX+'px'; ce.style.top=t.clientY+'px';} const te = document.elementFromPoint(t.clientX, t.clientY); document.querySelectorAll('.outliner-item-container').forEach(el => el.classList.remove('drag-over')); if(te){const dc=te.closest('.outliner-item-container'); if(dc&&dc!==d)dc.classList.add('drag-over');} }, {passive:false});
            d.addEventListener('touchend', (e) => { clearTimeout(pt); if(!isD)return; isD=false; d.style.opacity='1'; if(ce){document.body.removeChild(ce); ce=null;} const t=e.changedTouches[0]; const te=document.elementFromPoint(t.clientX, t.clientY); document.querySelectorAll('.outliner-item-container').forEach(el=>el.classList.remove('drag-over')); if(te){const dc=te.closest('.outliner-item-container'); if(dc&&dc!==d){let tn=null; core.editorRoot.traverse(n=>{if(n.uuid===dc.id.replace('item-',''))tn=n;}); if(tn){core.saveState(); let ic=false; tn.traverseAncestors(a=>{if(a===node)ic=true;}); if(!ic){tn.attach(node); this.populateOutliner();}}}} });
            d.addEventListener('touchcancel', () => { clearTimeout(pt); if(isD){isD=false; d.style.opacity='1'; if(ce){document.body.removeChild(ce);ce=null;} document.querySelectorAll('.outliner-item-container').forEach(el=>el.classList.remove('drag-over'));} });
            
            d.ondragover = (e) => { e.preventDefault(); d.classList.add('drag-over'); e.stopPropagation(); }; d.ondragleave = () => d.classList.remove('drag-over');
            d.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); d.classList.remove('drag-over'); core.saveState(); core.handleDrop(e, node); };
            d.onclick = (e) => { e.stopPropagation(); if (core.isMultiSelectMode) return; if (e.shiftKey && core.lastSelectedNode) { const s = core.outlinerFlatNodes.indexOf(core.lastSelectedNode), end = core.outlinerFlatNodes.indexOf(node); if (s > -1 && end > -1) core.selectObject(core.outlinerFlatNodes.slice(Math.min(s, end), Math.max(s, end) + 1), e.ctrlKey); } else { core.selectObject(node, e.ctrlKey); core.lastSelectedNode = node; } };
            const vc = node.children?.filter(c => !c.userData?.isHelper) || [];
            const tog = document.createElement('span'); tog.className = 'outliner-toggle';
            if (vc.length) { 
                if (node.userData.collapsed === undefined) node.userData.collapsed = true;
                tog.textContent = node.userData.collapsed ? '+' : '-'; 
                tog.onclick = (e) => { e.stopPropagation(); node.userData.collapsed = !node.userData.collapsed; this.populateOutliner(); }; 
            }
            const ns = document.createElement('span'); ns.className = 'outliner-name'; let ltt = 0;
            ns.addEventListener('click', (e) => { e.stopPropagation(); if(core.isMultiSelectMode)return; const now=Date.now(); if(now-ltt<300){this.customPrompt("Rename object:", node.name, (nn)=>{if(nn){core.saveState();node.name=nn;this.populateOutliner();}});} ltt=now; d.click(); });
            if (node.userData.isDefCollection || node.userData.instanceOf) ns.innerHTML = (node.name||(node.type==='Group'?'Empty':'Object'))+' <span style="color: #f1c40f;">•</span>'; else ns.textContent = node.name||(node.type==='Group'?'Empty':'Object');
            const vis = document.createElement('span'); vis.className = 'outliner-vis'; vis.textContent = node.visible ? '👁' : '—'; vis.onclick = (e) => { e.stopPropagation(); core.saveState(); node.visible = !node.visible; vis.textContent = node.visible ? '👁' : '—'; };
            d.append(tog, ns, vis); w.appendChild(d);
            if (vc.length && !node.userData.collapsed) { const cd = document.createElement('div'); cd.className = 'children-container'; vc.forEach(c => renderNode(c, cd)); w.appendChild(cd); }
            pEl.appendChild(w);
        };
        core.editorRoot.children.forEach(c => {
            if (!c.userData?.isHelper) renderNode(c, container);
        });
    }

    updateCollectionListUI() {
        const core = this.core;
        const l = document.getElementById('collection-list'); if(!l) return; l.innerHTML = ''; let hc = false;
        for (let id in core.definedCollections) {
            hc = true; const e = document.createElement('div'); e.className = 'collection-entry'; e.textContent = core.definedCollections[id].name;
            e.onclick = () => { core.saveState(); const d = JSON.parse(JSON.stringify(core.definedCollections[id])); d.userData.isDefCollection = false; d.userData.instanceOf = id; d.position = [0,0,0]; const n = core.deserializeNode(d, core.editorRoot); n.position.set(0,0,0); n.updateMatrixWorld(true); this.populateOutliner(); core.selectObject(n, false); document.getElementById('collection-dropdown').style.display = 'none'; document.getElementById('add-selected-root-btn').style.display='none'; };
            const del = document.createElement('span'); del.className = 'del-btn'; del.textContent = '×'; del.onclick = (ev) => { ev.stopPropagation(); delete core.definedCollections[id]; this.updateCollectionListUI(); };
            e.appendChild(del); l.appendChild(e);
        }
        if(!hc) { const m = document.createElement('div'); m.style.cssText = 'padding: 4px; font-size: 9px; color: #888;'; m.textContent = 'No entities defined.'; l.appendChild(m); }
    }

    renderTimeline() {
        const am = this.core.animationManager;
        const trackLabels = document.getElementById('track-labels');
        const tracksContent = document.getElementById('tracks-content');
        const layerList = document.getElementById('layer-list');
        const clipList = document.getElementById('anim-clip-list');
        
        if (!trackLabels || !tracksContent) return;

        if (clipList) {
            clipList.innerHTML = '';
            am.baseActions.forEach(item => {
                const div = document.createElement('div');
                div.className = 'lib-item';
                div.textContent = `▶ ${item.name}`;
                div.onclick = () => {
                    am.baseActions.forEach(a => a.action.stop());
                    item.action.play();
                    this.core.saveState();
                };
                clipList.appendChild(div);
            });
        }

        if (layerList) {
            layerList.innerHTML = '';
            am.layers.forEach((layer, idx) => {
                const div = document.createElement('div');
                div.className = 'lib-item' + (this.selectedLayerIndex === idx ? ' active' : '');
                
                const nInp = document.createElement('input');
                nInp.type = 'text'; nInp.value = layer.name; nInp.style.cssText = "width: 60px; background: transparent; border: none; color: white; margin-right: 5px;";
                nInp.onchange = e => layer.name = e.target.value;
                
                const wInp = document.createElement('input');
                wInp.type = 'number'; wInp.step = '0.1'; wInp.value = layer.weight; wInp.style.cssText = "width: 30px; margin-right: 5px;";
                wInp.onchange = e => layer.weight = parseFloat(e.target.value);
                
                const vis = document.createElement('span');
                vis.textContent = layer.visible ? '👁' : '—'; vis.style.cursor = 'pointer'; vis.style.marginRight = "5px";
                vis.onclick = (e) => { e.stopPropagation(); layer.visible = !layer.visible; this.renderTimeline(); };

                div.onclick = () => { this.selectedLayerIndex = idx; this.renderTimeline(); };
                
                div.append(vis, nInp, wInp);
                layerList.appendChild(div);
            });
        }

        trackLabels.innerHTML = '';
        tracksContent.innerHTML = '';
        
        if (this.selectedLayerIndex >= 0 && am.layers[this.selectedLayerIndex]) {
            const layer = am.layers[this.selectedLayerIndex];
            layer.tracks.forEach(track => {
                const label = document.createElement('div');
                label.className = 'track-row';
                label.style.overflow = 'hidden';
                label.style.textOverflow = 'ellipsis';
                label.style.whiteSpace = 'nowrap';
                label.textContent = track.boneName + " . " + track.type;
                trackLabels.appendChild(label);

                const dataRow = document.createElement('div');
                dataRow.className = 'track-row';
                dataRow.style.width = "100%";
                
                track.times.forEach(t => {
                    const kf = document.createElement('div');
                    kf.className = 'timeline-keyframe';
                    kf.style.left = `${t * this.timelineScale}px`;
                    dataRow.appendChild(kf);
                });
                tracksContent.appendChild(dataRow);
            });
        }
    }

    updatePlayhead() {
        const ph = document.getElementById('timeline-playhead');
        const am = this.core.animationManager;
        const display = document.getElementById('tl-time-display');
        if (ph) ph.style.left = (am.currentTime * this.timelineScale) + 'px';
        if (display) display.textContent = am.currentTime.toFixed(2) + 's';
    }

    setupEventListeners() {
        const core = this.core;
        
        const makeDraggable = (id, handleId) => {
            const p = document.getElementById(id), h = document.getElementById(handleId);
            if(!p || !h) return;
            let dx = 0, dy = 0, zI = 200;
            h.onpointerdown = (e) => {
                dx = e.clientX - p.offsetLeft; dy = e.clientY - p.offsetTop;
                p.style.zIndex = ++zI;
                h.setPointerCapture(e.pointerId);
                const move = (em) => { p.style.left = (em.clientX - dx) + 'px'; p.style.top = (em.clientY - dy) + 'px'; };
                const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            };
            p.onpointerdown = () => p.style.zIndex = ++zI;
        };

        makeDraggable('gizmo-panel', 'gizmo-drag-grip');
        makeDraggable('add-panel', 'add-drag-grip');
        makeDraggable('tools-panel', 'tools-drag-grip');
        makeDraggable('settings-panel', 'settings-drag-header');
        makeDraggable('floating-properties', 'properties-drag-header');

        const sC = (id, fn) => { const e=document.getElementById(id); if(e) e.onclick=fn; };

        ['translate','rotate','scale','shape'].forEach(m => sC(`btn-${m}`, () => { 
            if (m === 'shape') {
                core.isShapeMode = true;
                core.gizmo.detach();
                if (core.selectedObjects.length === 1 && core.selectedObjects[0].userData.shapeType && core.selectedObjects[0].userData.shapeType !== 'Empty' && core.selectedObjects[0].userData.shapeType !== 'GLTF') {
                    const stMap = { 'Cube': 'box', 'Cylinder': 'cyl', 'Cone': 'cone', 'Sphere': 'sphere', 'Torus': 'torus' };
                    core.shapeGizmo.attach(core.selectedObjects[0], core.selectedObjects[0].userData.params, stMap[core.selectedObjects[0].userData.shapeType]);
                }
            } else {
                core.isShapeMode = false;
                core.shapeGizmo.detach();
                core.gizmo.updateMode(m);
                if (core.selectedObjects.length === 1) core.gizmo.attach(core.selectedObjects[0]);
                else if (core.selectedObjects.length > 1) core.gizmo.attach(core.multiSelectPivot);
            }
            document.querySelectorAll('.gizmo-btn').forEach(b=>b.classList.toggle('active',b.id===`btn-${m}`)); 
        }));

        sC('btn-space', (e) => { core.currentGizmoSpace = core.currentGizmoSpace === 'local' ? 'world' : 'local'; core.gizmo.setSpace(core.currentGizmoSpace); e.target.innerText=core.currentGizmoSpace==='local'?'LCL':'WLD'; });
        sC('btn-focus', () => { 
            if(!core.selectedObjects.length) return; 
            const b=new THREE.Box3(); core.selectedObjects.forEach(o=>b.expandByObject(o)); if(b.isEmpty()) return; 
            const c=new THREE.Vector3(), s=new THREE.Vector3(); b.getCenter(c); b.getSize(s); 
            const pad = core.useOutline ? 1.5 : 1.1;
            const d = Math.max(s.x,s.y,s.z)===0 ? 2.0 : Math.max(s.x,s.y,s.z)*pad; 
            const dir = new THREE.Vector3().subVectors(core.camera.position,core.controls.target).normalize(); 
            if(dir.lengthSq()===0) dir.set(0,0,1); 
            core.camera.position.copy(c).add(dir.multiplyScalar(d)); 
            core.controls.target.copy(c); core.controls.update(); 
        });
        
        sC('btn-undo', () => core.performUndo());
        sC('btn-redo', () => core.performRedo());

        sC('add-shape-toggle', () => { const g=document.getElementById('shape-dropdown'); if(g) {g.style.display = g.style.display === 'block' ? 'none' : 'block'; document.getElementById('collection-dropdown').style.display='none';} });
        document.querySelectorAll('.add-shape-btn').forEach(b => b.onclick = () => { core.addShape(b.dataset.shape); document.getElementById('shape-dropdown').style.display='none'; });
        sC('add-collection-toggle', () => { const c=document.getElementById('collection-dropdown'), b=document.getElementById('add-selected-root-btn'); if(!c||!b) return; if(c.style.display==='flex'){c.style.display='none';return;} this.updateCollectionListUI(); c.style.display='flex'; b.style.display='block'; document.getElementById('shape-dropdown').style.display='none'; });
        sC('settings-toggle', () => { const p=document.getElementById('settings-panel'); if(p) p.style.display=p.style.display==='none'?'flex':'none'; document.getElementById('shape-dropdown').style.display='none'; document.getElementById('collection-dropdown').style.display='none'; });
        sC('anim-lib-toggle', () => { const p=document.getElementById('anim-panel'); if(p) p.style.display=p.style.display==='none'?'flex':'none'; document.getElementById('shape-dropdown').style.display='none'; document.getElementById('collection-dropdown').style.display='none'; });
        
        const fileInput = document.getElementById('import-model-anim-input');
        if(fileInput) fileInput.onchange = (e) => core.importSceneFromGLTF(e);

        sC('btn-origin-bottom', () => {
            if(!core.selectedObjects.length) return; core.saveState();
            core.selectedObjects.forEach(o => {
                const children = o.children.filter(c=>!c.userData?.isHelper);
                if(!children.length) return;
                children.forEach(c => core.scene.attach(c));
                const b = new THREE.Box3(); children.forEach(c => { const cb=new THREE.Box3().setFromObject(c); if(!cb.isEmpty()&&cb.min.y!==Infinity) b.union(cb); }); if(b.isEmpty()||b.min.y===Infinity) { children.forEach(c => o.attach(c)); return; }
                const c = new THREE.Vector3(); b.getCenter(c); const pW = new THREE.Vector3(c.x, b.min.y, c.z);
                (o.parent||core.scene).worldToLocal(pW);
                const ot = o.userData.transformLock; o.userData.transformLock = false; o.position.copy(pW); o.updateMatrixWorld(true); o.userData.transformLock = ot;
                children.forEach(c => o.attach(c));
            });
            if(core.gizmoTarget) core.gizmo.attach(core.gizmoTarget); this.updateTransformUI(); this.refreshSelectionUI();
        });
        sC('btn-move-to-zero', () => { if(!core.selectedObjects.length) return; core.saveState(); core.selectedObjects.forEach(o=>{o.position.set(0,0,0);o.updateMatrixWorld(true);}); if(core.selectedObjects.length>1){core.multiSelectPivot.position.set(0,0,0);core.multiSelectPivot.updateMatrixWorld(true);if(core.gizmoTarget)core.gizmo.attach(core.multiSelectPivot);}else if(core.selectedObjects.length===1&&core.gizmoTarget)core.gizmo.attach(core.selectedObjects[0]); this.updateTransformUI(); });
        
        const disableMS = () => { core.isMultiSelectMode=false; document.getElementById('btn-multi-select')?.classList.remove('active'); core.controls.enabled=true; const o=document.getElementById('outliner'); if(o){o.style.touchAction='auto';o.style.overflow='auto';} };
        sC('btn-multi-select', (e) => { core.isMultiSelectMode=!core.isMultiSelectMode; e.currentTarget.classList.toggle('active', core.isMultiSelectMode); core.controls.enabled=!core.isMultiSelectMode; const o=document.getElementById('outliner'); if(o){o.style.touchAction=core.isMultiSelectMode?'none':'auto';o.style.overflow=core.isMultiSelectMode?'hidden':'auto';} });

        document.querySelectorAll('.accordion-header').forEach(h => {
            h.onclick = () => {
                const c = h.nextElementSibling;
                c.style.display = c.style.display === 'none' ? 'flex' : 'none';
            }
        });

        sC('tl-play', () => core.animationManager.play());
        sC('tl-pause', () => core.animationManager.pause());
        sC('tl-stop', () => core.animationManager.stop());
        
        sC('add-layer-btn', () => {
            core.animationManager.layers.push({ name: `Layer ${core.animationManager.layers.length}`, weight: 1.0, blendMode: 'override', visible: true, tracks: [] });
            this.selectedLayerIndex = core.animationManager.layers.length - 1;
            this.renderTimeline();
        });

        ['loop-start', 'loop-end'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', e => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) {
                        if (id === 'loop-start') core.animationManager.loopStart = v;
                        if (id === 'loop-end') core.animationManager.loopEnd = v;
                    }
                });
            }
        });

        const tlTracks = document.getElementById('timeline-tracks-area');
        if (tlTracks) {
            tlTracks.addEventListener('pointerdown', (e) => {
                const rect = document.getElementById('tracks-content').getBoundingClientRect();
                const x = e.clientX - rect.left + tlTracks.scrollLeft;
                core.animationManager.setTime(Math.max(0, x / this.timelineScale));
                this.updatePlayhead();
            });
        }

        sC('delete-btn', () => core.deleteSelectedObjects());

        const grip = document.getElementById('hierarchy-panel-toggle');
        if(grip) {
            let isResizingUI = false, uiStartX = 0, uiStartWidth = 0;
            grip.addEventListener('pointerdown', e => {
                isResizingUI = true; uiStartX = e.clientX;
                uiStartWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ui-width')) || 150;
                grip.setPointerCapture(e.pointerId); e.stopPropagation();
            });
            grip.addEventListener('pointermove', e => {
                if(!isResizingUI) return;
                const dx = uiStartX - e.clientX;
                document.documentElement.style.setProperty('--ui-width', Math.max(80, Math.min(600, uiStartWidth + dx)) + 'px');
            });
            const stopResize = e => { if(isResizingUI) { isResizingUI = false; grip.releasePointerCapture(e.pointerId); } };
            grip.addEventListener('pointerup', stopResize);
            grip.addEventListener('pointercancel', stopResize);
        }

        const uiBottomResizer = document.getElementById('ui-bottom-resizer');
        const outlinerPanel = document.getElementById('outliner-panel');
        if(uiBottomResizer && outlinerPanel) {
            let isResizingUIBottom = false, uiStartHeight = 0, uiStartY = 0;
            uiBottomResizer.addEventListener('pointerdown', e => {
                isResizingUIBottom = true; uiStartY = e.clientY;
                uiStartHeight = outlinerPanel.offsetHeight;
                uiBottomResizer.setPointerCapture(e.pointerId); e.stopPropagation();
            });
            uiBottomResizer.addEventListener('pointermove', e => {
                if(!isResizingUIBottom) return;
                const dy = e.clientY - uiStartY;
                outlinerPanel.style.height = Math.max(50, Math.min(window.innerHeight - 150, uiStartHeight + dy)) + 'px';
            });
            const stopUIBottomResize = e => { if(isResizingUIBottom) { isResizingUIBottom = false; uiBottomResizer.releasePointerCapture(e.pointerId); } };
            uiBottomResizer.addEventListener('pointerup', stopUIBottomResize);
            uiBottomResizer.addEventListener('pointercancel', stopUIBottomResize);
        }

        const tlResizer = document.getElementById('timeline-resizer');
        if (tlResizer) {
            let isResizingTl = false, startY, startH;
            tlResizer.addEventListener('pointerdown', e => {
                isResizingTl = true; startY = e.clientY;
                startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--timeline-height')) || 180;
                tlResizer.setPointerCapture(e.pointerId); e.stopPropagation();
            });
            tlResizer.addEventListener('pointermove', e => {
                if(!isResizingTl) return;
                const dy = startY - e.clientY;
                document.documentElement.style.setProperty('--timeline-height', Math.max(50, Math.min(window.innerHeight - 100, startH + dy)) + 'px');
            });
            const stopTlResize = e => { if(isResizingTl) { isResizingTl = false; tlResizer.releasePointerCapture(e.pointerId); } };
            tlResizer.addEventListener('pointerup', stopTlResize);
            tlResizer.addEventListener('pointercancel', stopTlResize);
        }

        const syncTransformProp = (id, val) => {
            if(!core.selectedObjects.length) return;
            core.selectedObjects.forEach(o => core.applyToLinkedInstances(o, t => {
                const mo = t.userData && !t.userData.transformLock; let lt = [];
                if(mo){ lt = t.children.filter(c=>!c.userData?.isHelper); lt.forEach(c => core.scene.attach(c)); }
                if(id==='posX') t.position.x=val; if(id==='posY') t.position.y=val; if(id==='posZ') t.position.z=val;
                if(id==='rotX') t.rotation.x=val*Math.PI/180; if(id==='rotY') t.rotation.y=val*Math.PI/180; if(id==='rotZ') t.rotation.z=val*Math.PI/180;
                if(id==='scaleX') t.scale.x=val; if(id==='scaleY') t.scale.y=val; if(id==='scaleZ') t.scale.z=val;
                if(mo){ t.updateMatrixWorld(true); lt.forEach(c => t.attach(c)); }
            }));
            core.updateMultiSelectPivot();
            if(core.gizmoTarget) core.gizmo.attach(core.gizmoTarget);
        };

        ['posX','posY','posZ', 'rotX','rotY','rotZ', 'scaleX','scaleY','scaleZ'].forEach(id => {
            const e = document.getElementById(id); 
            if(e){ 
                e.onmousedown=()=>core.saveState(); 
                e.oninput=(ev)=>{const v=parseFloat(ev.target.value); if(!isNaN(v)) syncTransformProp(id, v);}; 
            }
        });

        const ce = document.getElementById('obj-color');
        if(ce){ ce.onclick=()=>core.saveState(); ce.oninput=(e)=>{ if(!core.selectedObjects.length)return; const nc=new THREE.Color(e.target.value); core.selectedObjects.forEach(o=>core.applyToLinkedInstances(o, t=>{ if(t.material?.color){t.material.color.copy(nc);t.userData.originalColor=[nc.r,nc.g,nc.b,1.0];} })); }; }

        document.getElementById('wf-color')?.addEventListener('input', e => { core.wfColorHex = e.target.value; const c = new THREE.Color(core.wfColorHex); core.editorRoot.traverse(m => { if(m.userData?.wireframeLine?.material) m.userData.wireframeLine.material.color.copy(c); }); });
        document.getElementById('set-outline')?.addEventListener('change', e=>{core.useOutline=e.target.checked;this.refreshSelectionUI();});
        document.getElementById('set-highlight')?.addEventListener('change', e=>{core.useHighlight=e.target.checked;this.refreshSelectionUI();});

        let hiddenEdgeBaseColor = '#444444';
        let hiddenEdgeOpacity = 0.5;
        const updateHiddenEdgeColor = () => {
            const c = new THREE.Color(hiddenEdgeBaseColor);
            c.multiplyScalar(hiddenEdgeOpacity);
            core.outlinePass.hiddenEdgeColor.copy(c);
        };

        document.getElementById('set-out-color')?.addEventListener('input', e=>{ core.outlinePass.visibleEdgeColor.set(e.target.value); });
        document.getElementById('set-out-hidden-color')?.addEventListener('input', e=>{ hiddenEdgeBaseColor = e.target.value; updateHiddenEdgeColor(); });
        document.getElementById('set-out-hidden-opacity')?.addEventListener('input', e=>{ hiddenEdgeOpacity = parseFloat(e.target.value); updateHiddenEdgeColor(); });
        document.getElementById('set-out-thick')?.addEventListener('input', e=>{ core.outlinePass.edgeThickness=parseFloat(e.target.value); });
        document.getElementById('set-out-strength')?.addEventListener('input', e=>{ core.outlinePass.edgeStrength=parseFloat(e.target.value); });
        document.getElementById('set-out-glow')?.addEventListener('input', e=>{ core.outlinePass.edgeGlow=parseFloat(e.target.value); });
        document.getElementById('set-out-pulse')?.addEventListener('input', e=>{ core.outlinePass.pulsePeriod=parseFloat(e.target.value); });
        document.getElementById('set-dot-size')?.addEventListener('input', e=>{core.entityDotSize=parseFloat(e.target.value);if(isNaN(core.entityDotSize)||core.entityDotSize<=0)core.entityDotSize=0.01;core.editorRoot.traverse(n=>core.updateEntityDot(n));});
        document.getElementById('set-gizmo-size')?.addEventListener('input', e=>{core.gizmoSize=parseFloat(e.target.value);if(isNaN(core.gizmoSize)||core.gizmoSize<=0)core.gizmoSize=0.1;});
        document.getElementById('set-gizmo-ontop')?.addEventListener('change', e=>{core.gizmoOnTop=e.target.checked;});

        window.addEventListener('resize', () => { core.camera.aspect=window.innerWidth/window.innerHeight; core.camera.updateProjectionMatrix(); core.renderer.setSize(window.innerWidth, window.innerHeight); core.composer.setSize(window.innerWidth, window.innerHeight); });

        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); core.performUndo(); }
            if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); core.performRedo(); }
        });

        const pHead = document.getElementById('properties-drag-header');
        const pCont = document.querySelector('#floating-properties .floating-content');
        let pDrag = false;
        if(pHead) {
            pHead.addEventListener('pointerdown', () => pDrag = false);
            pHead.addEventListener('pointermove', () => pDrag = true);
            pHead.addEventListener('pointerup', (e) => {
                if(!pDrag && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SVG' && e.target.tagName !== 'path' && e.target.tagName !== 'rect') {
                    pCont.style.display = pCont.style.display === 'none' ? 'flex' : 'none';
                }
            });
        }
        
        sC('btn-lock-toggle', (e) => { if(e) e.stopPropagation(); if(!core.selectedObjects.length) return; core.saveState(); const wL=!core.selectedObjects[0].userData.transformLock; core.selectedObjects.forEach(o=>o.userData.transformLock=wL); this.updateLockIcon(wL); if(!wL&&core.gizmoTarget) core.gizmo.attach(core.gizmoTarget); });
        
        const mkm = { 'mat-type':'materialType', 'mat-side':'side', 'mat-roughness':'roughness', 'mat-metalness':'metalness', 'mat-transparent':'transparent', 'mat-wireframe':'wireframe', 'mat-opacity':'opacity', 'mat-emissive':'emissive', 'mat-emissiveIntensity':'emissiveIntensity', 'mat-clearcoat':'clearcoat', 'mat-clearcoatRoughness':'clearcoatRoughness', 'mat-transmission':'transmission', 'mat-ior':'ior', 'mat-thickness':'thickness', 'mat-flatShading':'flatShading', 'mat-depthTest':'depthTest', 'mat-depthWrite':'depthWrite', 'mat-alphaTest':'alphaTest' };
        Object.keys(mkm).forEach(id => {
            const el = document.getElementById(id);
            if(el){ el.onmousedown=()=>{if(document.activeElement!==el&&el.type!=='color')core.saveState();}; if(el.type==='color')el.onclick=()=>core.saveState();
                el.addEventListener(['mat-type','mat-side','mat-transparent','mat-wireframe','mat-flatShading','mat-depthTest','mat-depthWrite'].includes(id)?'change':'input', (e) => {
                    if(!core.selectedObjects.length) return; const pk = mkm[id]; let v;
                    if(el.type==='checkbox') v=el.checked; else if(id==='mat-emissive'){const c=new THREE.Color(el.value);v=[c.r,c.g,c.b];} else if(id==='mat-type'||id==='mat-side'){if(el.value==="")return; v=id==='mat-side'?parseInt(el.value):el.value;} else {v=parseFloat(el.value);if(isNaN(v))return;}
                    core.selectedObjects.forEach(o => core.applyToLinkedInstances(o, t => { if(!t.isMesh||t.userData.shapeType==='Empty')return; t.userData[pk]=v; t.material=core.createMaterialFromUserData(t.userData); if(pk==='flatShading')core.rebuildGeometry(t); }));
                    if(id==='mat-type') this.renderMaterialUI();
                });
            }
        });

        const okm = {'obj-castShadow':'castShadow', 'obj-receiveShadow':'receiveShadow', 'obj-visible':'visible'};
        Object.keys(okm).forEach(id => { const el=document.getElementById(id); if(el){el.onmousedown=()=>core.saveState(); el.onchange=(e)=>{if(!core.selectedObjects.length)return; const v=e.target.checked, pk=okm[id]; core.selectedObjects.forEach(o=>core.applyToLinkedInstances(o, t=>{t.userData[pk]=v;t[pk]=v;})); this.populateOutliner();};} });

    }
}