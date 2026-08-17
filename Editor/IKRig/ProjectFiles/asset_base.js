// Where the shared art lives - the FBX clips, GLB props and textures that sit
// in Editor/IKRig rather than next to this file.
//
// They were fetched from raw.githubusercontent.com from every environment,
// including a local dev server sitting on the very same files. That is slower
// than reading them off disk, it needs a working connection to play at all,
// and it is rate limited: raw.githubusercontent.com answers 429 after enough
// requests, which is exactly what a few dozen page reloads produces. Every
// asset then fails at once and the game never leaves its loading screen.
//
// GitHub Pages still has to use the remote copy - Pages serves this folder,
// not its parent, so there is no relative path from there to Editor/IKRig.
// Anywhere else - localhost, a LAN address, a file server - reads them
// directly, provided the server root is Editor/IKRig (see the note below).
//
// Serve for local development with the root ONE LEVEL UP from this folder:
//     cd Editor/IKRig && python -m http.server 8123
//     http://localhost:8123/ProjectFiles/ClimbGame.html
// Started inside ProjectFiles instead, '../' climbs above the server root and
// every asset 404s - set window.assetBase before the module loads to point
// somewhere else if that is the layout you want.
const REMOTE = 'https://raw.githubusercontent.com/XYremesher/CustomGizmo/main/Editor/IKRig/';

export const ASSET_BASE =
    (typeof window !== 'undefined' && window.assetBase) ? window.assetBase :
    (typeof location !== 'undefined' && /(^|\.)github\.io$/i.test(location.hostname)) ? REMOTE :
    '../';

// The published copy, for anything that genuinely wants it regardless of where
// it is running.
export const ASSET_BASE_REMOTE = REMOTE;
