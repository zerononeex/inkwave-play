// Stage modules (src/world/stages/<id>/): a stage that owns its whole folder — layout.js (LAYOUT), props.js (register,
// PLACEMENTS), surfaces.js (SURF, SURFACES) and murals.js (drawMurals). Only Cargo Terminal is built this way (ported
// from PR #8); the original stages keep their data in maps.js / dressing.js / murals.js. Static imports: a stage that
// ships is always loaded, so there is no dynamic loader to go wrong.
import * as cargoLayout from './cargo/layout.js';
import * as cargoProps from './cargo/props.js';
import * as cargoSurfaces from './cargo/surfaces.js';
import * as cargoMurals from './cargo/murals.js';

// STAGES[id] = { LAYOUT, register, PLACEMENTS, SURF, SURFACES, drawMurals }
export const STAGES = {
  cargo: { ...cargoLayout, ...cargoProps, ...cargoSurfaces, ...cargoMurals },
};
