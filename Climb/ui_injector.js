/**
 * Climb Game UI & CSS Injector Module
 * Ready to be hosted on GitHub and loaded as an ES Module.
 */

export function injectUIAndStyles() {
    const css = `
        body { margin: 0; overflow: hidden; background-color: #000; touch-action: none; user-select: none; -webkit-user-select: none; }
        #gameCanvas { display: block; width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; z-index: 1; }
        #ui { position: absolute; top: 25px; left: 0; color: white; font-family: monospace; background: rgba(0,0,0,0.85); padding: 12px; border-radius: 0 8px 8px 0; width: 240px; z-index: 10; transition: transform 0.3s cubic-bezier(0.1, 0.9, 0.2, 1); border: 1px solid rgba(255, 255, 255, 0.1); border-left: none; transform: translateX(0); }
        #ui.collapsed { transform: translateX(-100%); }
        .ui-controls { margin-top: 10px; background: rgba(255,255,255,0.05); padding: 4px; border-radius: 6px; max-height: 75vh; overflow-y: auto; }
        .category { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 4px; margin-bottom: 6px; overflow: hidden; }
        .category-header { background: rgba(255, 255, 255, 0.1); padding: 8px; cursor: pointer; font-weight: bold; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .category-header:hover { background: rgba(255, 255, 255, 0.2); }
        .category-content { padding: 8px; display: none; background: rgba(0, 0, 0, 0.4); }
        .category.active .category-content { display: block; }
        .category-header::after { content: '▶'; font-size: 10px; transition: transform 0.2s; }
        .category.active .category-header::after { transform: rotate(90deg); }
        #stamina-container { position: absolute; top: 10px; left: 10px; width: 150px; height: 4px; background: rgba(0,0,0,0.5); border-radius: 2px; overflow: hidden; border: 1px solid rgba(255,255,255,0.2); z-index: 11; }
        #stamina-bar { width: 100%; height: 100%; background: #44ff44; transition: width 0.1s linear, background-color 0.3s; }
        #dock-btn { position: absolute; right: -24px; top: 50%; transform: translateY(-50%); width: 24px; height: 40px; background: rgba(0,0,0,0.85); border: 1px solid rgba(255, 255, 255, 0.1); border-left: none; border-radius: 0 6px 6px 0; color: white; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .joystick-base { position: absolute; bottom: 30px; width: 120px; height: 120px; background: rgba(255, 255, 255, 0.1); border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.3); display: flex; justify-content: center; align-items: center; touch-action: none; z-index: 10; }
        #base-left { left: 30px; } #base-right { right: 30px; }
        .joystick-stick { width: 50px; height: 50px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; position: absolute; pointer-events: none; z-index: 5; }
        #jump-btn { position: absolute; bottom: 170px; right: 45px; width: 70px; height: 70px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.5); display: flex; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; touch-action: none; cursor: pointer; z-index: 10; background: rgba(100, 255, 100, 0.5); }
        #build-btn { position: absolute; bottom: 150px; right: 125px; width: 45px; height: 45px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.4); display: flex; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; font-size: 14px; touch-action: none; cursor: pointer; z-index: 10; background: rgba(255, 150, 50, 0.7); }
        #hold-btn { position: absolute; bottom: 100px; right: 155px; width: 55px; height: 55px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.4); display: none; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; font-size: 11px; touch-action: none; cursor: pointer; z-index: 10; background: rgba(50, 150, 255, 0.7); }
        #hold-btn:active { background: rgba(50, 150, 255, 0.9); }
        #carry-btn { position: absolute; bottom: 100px; right: 155px; width: 55px; height: 55px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.4); display: none; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; font-size: 11px; touch-action: none; cursor: pointer; z-index: 10; background: rgba(255, 50, 150, 0.7); }
        #drop-btn { position: absolute; bottom: 110px; right: 220px; width: 45px; height: 45px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.4); display: none; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; font-size: 10px; touch-action: none; cursor: pointer; z-index: 10; background: rgba(150, 150, 150, 0.8); }
        #throw-btn { position: absolute; bottom: 50px; right: 190px; width: 45px; height: 45px; border-radius: 50%; border: 1.5px solid rgba(255, 255, 255, 0.4); display: none; justify-content: center; align-items: center; color: white; font-family: monospace; font-weight: bold; font-size: 10px; touch-action: none; cursor: pointer; z-index: 10; background: rgba(255, 50, 50, 0.8); }
        #reset-cam-btn { position: absolute; bottom: 180px; left: 45px; width: 24px; height: 24px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.3); touch-action: none; cursor: pointer; z-index: 10; background: rgba(100, 100, 255, 0.15); }
        #jump-btn:active, #reset-cam-btn:active, #build-btn:active, #hold-btn:active, #carry-btn:active, #drop-btn:active, #throw-btn:active { opacity: 0.8; transform: scale(0.95); }
        .ledge-hint-container { position: absolute; width: 100%; height: 100%; pointer-events: none; opacity: 0; transition: opacity 0.2s; border-radius: 50%; overflow: hidden; }
        .ledge-hint-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: rgba(255, 0, 0, 0.2); transform: translateX(-50%); }
        .ledge-hint { position: absolute; font-size: 10px; font-weight: bold; color: #fff; background: rgba(255, 0, 0, 0.8); padding: 2px 10px; border-radius: 4px; left: 50%; transform: translateX(-50%); z-index: 2; font-family: monospace; }
        .ledge-hint.up { top: 5px; width: 40px; text-align: center; }
        .ledge-hint.down { bottom: 5px; width: 40px; text-align: center; }
        #base-left.ledge-mode #ledge-hint-container { opacity: 1; }
        #base-left.ledge-mode { border-color: rgba(255, 0, 0, 0.5); background: rgba(255, 0, 0, 0.1); }
        #base-left.hold-mode #push-pull-hint-container { opacity: 1; }
        #base-left.hold-mode { border-color: rgba(50, 150, 255, 0.5); background: rgba(50, 150, 255, 0.1); }
        #base-left.hold-mode #ledge-hint-container { opacity: 0 !important; }
        #msg-overlay { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: gold; font-family: monospace; font-weight: bold; font-size: 28px; text-shadow: 2px 2px #000; text-align: center; pointer-events: none; z-index: 20; }
        #standup-indicator { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #ff6600; font-family: monospace; font-weight: bold; font-size: 20px; text-shadow: 1px 1px #000; pointer-events: none; z-index: 20; background: rgba(0,0,0,0.5); padding: 8px 16px; border-radius: 8px; }
        #json-modal { display: none; position: absolute; top: 10%; left: 50%; transform: translateX(-50%); width: 80%; max-width: 600px; background: rgba(0,0,0,0.9); padding: 20px; border: 1px solid #fff; z-index: 100; color: #fff; font-family: monospace; }
        #json-modal textarea { width: 100%; height: 300px; background: #222; color: #0f0; font-family: monospace; margin-top: 10px; margin-bottom: 10px; }
        #json-modal button { padding: 5px 10px; margin-right: 10px; cursor: pointer; }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const uiContainer = document.createElement('div');
    uiContainer.innerHTML = `
        <div id="stamina-container"><div id="stamina-bar"></div></div>
        <div id="ui" class="collapsed">
            <button id="dock-btn">▶</button>
            <div class="ui-controls">
                <div class="category active">
                    <div class="category-header">Level & Data</div>
                    <div class="category-content">
                        <label>Select Level:</label><br>
                        <select id="level-select" style="width: 100%; margin-bottom: 10px; color: black;"></select><br>
                        <button id="btn-show-json" style="width: 100%; padding: 5px; color: black;">Import/Export JSON</button>
                    </div>
                </div>
                <div class="category">
                    <div class="category-header">Physics & Core</div>
                    <div class="category-content">
                        <label>Jump Force: <span id="force-val">1.0</span>x</label><br>
                        <input type="range" id="ledge-force-slider" min="0.2" max="3.0" step="0.1" value="1.0" style="width: 100%;"><br>
                        <label>Model Scale: <span id="scale-val">0.0065</span></label><br>
                        <input type="range" id="scale-slider" min="0.001" max="0.02" step="0.0005" value="0.0065" style="width: 100%;"><br>
                        <label>Ledge Offset: <span id="offset-val">0.06</span></label><br>
                        <input type="range" id="offset-slider" min="0.0" max="0.5" step="0.01" value="0.06" style="width: 100%;"><br>
                        <label>Wall Stop Threshold: <span id="wall-stop-val">0.90</span></label><br>
                        <input type="range" id="wall-stop-slider" min="0.0" max="1.0" step="0.01" value="0.90" style="width: 100%;"><br>
                    </div>
                </div>
                <div class="category">
                    <div class="category-header">Anim Timing</div>
                    <div class="category-content">
                        <label>Climb Speed: <span id="climb-speed-val">1.6</span>x</label><br>
                        <input type="range" id="climb-speed-slider" min="1.0" max="6.0" step="0.1" value="1.6" style="width: 100%;"><br>
                        <label>Land Speed: <span id="land-speed-val">2.4</span>x</label><br>
                        <input type="range" id="land-speed-slider" min="1.0" max="6.0" step="0.1" value="2.4" style="width: 100%;"><br>
                        <label>Land Duration: <span id="land-dur-val">0.25</span>s</label><br>
                        <input type="range" id="land-dur-slider" min="0.1" max="2.0" step="0.05" value="0.25" style="width: 100%;"><br>
                        <label>Climb Trans: <span id="climb-trans-val">0.20</span>s</label><br>
                        <input type="range" id="climb-trans-slider" min="0.0" max="1.0" step="0.05" value="0.20" style="width: 100%;"><br>
                        <label>Standup Start: <span id="standup-start-val">0.20</span>s</label><br>
                        <input type="range" id="standup-start-slider" min="0.0" max="4.0" step="0.05" value="0.20" style="width: 100%;"><br>
                        <label>Standup Speed: <span id="standup-speed-val">1.2</span>x</label><br>
                        <input type="range" id="standup-speed-slider" min="0.5" max="3.0" step="0.1" value="1.2" style="width: 100%;"><br>
                        <label>Standup Fade: <span id="standup-fade-val">0.45</span>s</label><br>
                        <input type="range" id="standup-fade-slider" min="0.0" max="1.0" step="0.01" value="0.45" style="width: 100%;"><br>
                        <label>Pose Duration: <span id="pose-dur-val">0.15</span>s</label><br>
                        <input type="range" id="pose-dur-slider" min="0.01" max="1.0" step="0.01" value="0.15" style="width: 100%;"><br>
                    </div>
                </div>
                <div class="category active">
                    <div class="category-header">Carry & Throw</div>
                    <div class="category-content">
                        <label>Carry Height: <span id="carry-height-val">2.45</span></label><br>
                        <input type="range" id="carry-height-slider" min="1.5" max="3.5" step="0.05" value="2.45" style="width: 100%;"><br>
                        <label>Carry Start Speed: <span id="carry-start-speed-val">1.0</span>x</label><br>
                        <input type="range" id="carry-start-speed-slider" min="0.5" max="3.0" step="0.1" value="1.0" style="width: 100%;"><br>
                        <label>Lift Start Ratio: <span id="lift-start-val">0.40</span></label><br>
                        <input type="range" id="lift-start-slider" min="0.0" max="0.9" step="0.05" value="0.40" style="width: 100%;"><br>
                        <label>Throw Anim Speed: <span id="throw-speed-val">1.0</span>x</label><br>
                        <input type="range" id="throw-speed-slider" min="0.5" max="3.0" step="0.1" value="1.0" style="width: 100%;"><br>
                        <label>Throw Trim Start: <span id="throw-trim-val">0.25</span>s</label><br>
                        <input type="range" id="throw-trim-slider" min="0.0" max="1.0" step="0.05" value="0.25" style="width: 100%;"><br>
                        <label>Spine Stabilize Blend: <span id="spine-blend-val">0.80</span></label><br>
                        <input type="range" id="spine-blend-slider" min="0.0" max="1.0" step="0.05" value="0.80" style="width: 100%;"><br>
                    </div>
                </div>
                <div class="category">
                    <div class="category-header">Debug Vis</div>
                    <div class="category-content">
                        <label><input type="checkbox" id="toggle-hitbox"> Show Hitboxes</label><br>
                        <label><input type="checkbox" id="toggle-ragdoll-colliders"> Show Ragdoll Overlay</label><br>
                        <label>Collider Density: <span id="collider-density-val">8</span></label><br>
                        <input type="range" id="collider-density-slider" min="4" max="32" step="2" value="8" style="width: 100%;"><br>
                        <label><input type="checkbox" id="toggle-debug-joints"> Show Debug Joints</label>
                    </div>
                </div>
            </div>
        </div>
        <div id="msg-overlay">LEVEL COMPLETED!</div>
        <div id="standup-indicator"></div>
        <div id="json-modal">
            <h3>Level JSON Data</h3>
            <textarea id="json-textarea"></textarea>
            <div>
                <button id="btn-apply-json">Load JSON</button>
                <button id="btn-close-json">Close</button>
            </div>
        </div>
        <div id="jump-btn">JUMP</div>
        <div id="build-btn">B</div>
        <div id="hold-btn">HOLD</div>
        <div id="carry-btn">CARRY</div>
        <div id="drop-btn">DROP</div>
        <div id="throw-btn">THROW</div>
        <div id="reset-cam-btn"></div>
        <div id="base-left" class="joystick-base">
            <div id="ledge-hint-container" class="ledge-hint-container">
                <div class="ledge-hint-line"></div>
                <span class="ledge-hint up">CLIMB</span>
                <span class="ledge-hint down">DROP</span>
            </div>
            <div id="push-pull-hint-container" class="ledge-hint-container">
                <div class="ledge-hint-line" style="background: rgba(50, 150, 255, 0.2);"></div>
                <span class="ledge-hint up" style="background: rgba(50, 150, 255, 0.8);">PUSH</span>
                <span class="ledge-hint down" style="background: rgba(50, 150, 255, 0.8);">PULL</span>
            </div>
            <div id="stick-left" class="joystick-stick"></div>
        </div>
        <div id="base-right" class="joystick-base">
            <div id="stick-right" class="joystick-stick"></div>
        </div>
    `;
    document.body.appendChild(uiContainer);

    document.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('pointerdown', () => {
            header.parentElement.classList.toggle('active');
        });
    });
}