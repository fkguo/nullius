import { describe, it, expect } from 'vitest';

import { StyleProfileSchema } from '../../src/corpora/style/schemas.js';
import { defaultRmpProfile } from '../../src/corpora/profiles/rmp.js';
import { defaultPrlProfile } from '../../src/corpora/profiles/prl.js';
import { defaultNatphysProfile } from '../../src/corpora/profiles/natphys.js';
import { defaultPhysrepProfile } from '../../src/corpora/profiles/physrep.js';

describe('StyleCorpus profiles (R6)', () => {
  it('validates built-in profiles with StyleProfileSchema', () => {
    const profiles = [
      defaultRmpProfile(),
      defaultPrlProfile(),
      defaultNatphysProfile(),
      defaultPhysrepProfile(),
    ];

    const parsed = profiles.map(p => StyleProfileSchema.parse(p));
    expect(parsed.map(p => p.style_id).sort()).toEqual(['natphys', 'physrep', 'prl', 'rmp']);
  });
});

