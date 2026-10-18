// Registry of the stage-owned surface materials (src/world/stages/<id>/surfaces.js) for texlib.js + levelMaterial.js.
// PATTERN slots 0–27 are the shared kit (mapkit.js); each stage owns a few slots from 28 up (STAGE_SLOTS below). The
// slots only exist in the shader's slot table — a stage that isn't loaded costs its three texlib layers and nothing else.
// Imports only the surfaces files (no props / layout), so texlib.js never pulls in stage geometry.
import * as cargo from './cargo/surfaces.js';

const PACKS = { cargo };
export const STAGE_SLOTS = { cargo: [28, 29, 30] };
export const FIRST_STAGE_SLOT = 28, LAST_STAGE_SLOT = 30;
// flat list: { stage, slot, name (texlib layer name, '<stage>:<name>'), group (texlib uber-program), mat, onWall, onTop }
// Stage layers join the existing stairs program (group 2) instead of adding a program of their own: no extra material
// objects at boot, so the other stages boot exactly as before (down to the seeded random sequence the audits rely on).
export const STAGE_SURFACES = [];
Object.keys(STAGE_SLOTS).forEach((stage) => {
  for (const s of PACKS[stage].SURFACES || []) {
    if (!STAGE_SLOTS[stage].includes(s.slot)) { console.warn(`[inkwave] ${stage} surface '${s.name}' is not on one of its slots`, STAGE_SLOTS[stage]); continue; }
    STAGE_SURFACES.push({ stage, slot: s.slot, name: `${stage}:${s.name}`, group: 2, mat: s.mat, onWall: s.onWall, onTop: s.onTop });
  }
});
