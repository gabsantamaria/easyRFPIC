// Registry of built-in templates.
//
// Templates exist as default-exported modules under this directory.
// Adding a new template:
//   1. Create src/templates/my_template.js exporting a default object
//      of shape { id, name, description, insert(prev, ctx) => nextScene }.
//   2. Add an import + entry to BUILTIN_TEMPLATES below.
//
// The "Save as built-in template" command in the library panel
// generates step 1 for you, but it still asks you to perform step 2
// manually so unfamiliar code doesn't ship by accident.
import racetrack from './racetrack.js';
import ringResonator from './ring-resonator.js';
import meanderElectrode from './meander-electrode.js';
import meanderElectrodeHorizontal from './meander-electrode-horizontal.js';

export const BUILTIN_TEMPLATES = [
  racetrack,
  ringResonator,
  meanderElectrode,
  meanderElectrodeHorizontal,
];
