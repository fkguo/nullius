import { invalidParams, notFound } from '@autoresearch/shared';
import {
  findPdgParticlesByMcid,
  findPdgParticlesByName,
  findPdgParticlesByPdgid,
  type PdgParticleCandidate,
} from '../db/particles.js';
import { getPdgidRowByPdgid } from '../db/pdgid.js';
import { normalizeParticleNameInput } from './nameNormalization.js';

export interface ParticleSelectorInput {
  name?: string;
  mcid?: number;
  pdgid?: string;
  case_sensitive: boolean;
}

const RESOLVE_LIMIT = 200;
const PREVIEW_LIMIT = 50;

function throwTooManyMatches(message: string, selector: ParticleSelectorInput, preview: PdgParticleCandidate[]): never {
  throw invalidParams(message, {
    particle: selector,
    preview: preview.slice(0, PREVIEW_LIMIT),
  });
}

export async function resolveParticleCandidates(
  dbPath: string,
  selector: ParticleSelectorInput
): Promise<{ candidates: PdgParticleCandidate[]; normalized?: { pdgid?: string; name?: string } }> {
  const case_sensitive = selector.case_sensitive;

  const resolved = (() => {
    if (selector.name !== undefined) {
      const { normalized, changed } = normalizeParticleNameInput(selector.name);
      return { kind: 'name' as const, normalized, changed };
    }
    if (selector.mcid !== undefined) return { kind: 'mcid' as const };
    return { kind: 'pdgid' as const };
  })();

  const direct = await (async (): Promise<{
    candidates: PdgParticleCandidate[];
    normalized?: { pdgid?: string; name?: string };
  }> => {
    if (resolved.kind === 'name') {
      const { candidates, has_more } = await findPdgParticlesByName(dbPath, resolved.normalized, {
        mode: 'exact',
        case_sensitive,
        start: 0,
        limit: RESOLVE_LIMIT,
      });
      if (has_more) {
        throwTooManyMatches('Ambiguous particle selector; too many matches for name', selector, candidates);
      }
      if (resolved.changed) return { candidates, normalized: { name: resolved.normalized } };
      return { candidates };
    }

    if (resolved.kind === 'mcid') {
      const mcid = selector.mcid!;
      const { candidates, has_more } = await findPdgParticlesByMcid(dbPath, mcid, {
        start: 0,
        limit: RESOLVE_LIMIT,
      });
      if (has_more) {
        throwTooManyMatches('Ambiguous particle selector; too many matches for mcid', selector, candidates);
      }
      return { candidates };
    }

    const { candidates, has_more } = await findPdgParticlesByPdgid(dbPath, selector.pdgid!, {
      start: 0,
      limit: RESOLVE_LIMIT,
      case_sensitive,
    });
    if (has_more) {
      throwTooManyMatches('Ambiguous particle selector; too many matches for pdgid', selector, candidates);
    }
    return { candidates };
  })();

  if (direct.candidates.length > 0) return direct;

  if (selector.pdgid === undefined) return direct;

  const row = await getPdgidRowByPdgid(dbPath, selector.pdgid, case_sensitive);
  if (!row?.parent_pdgid) return direct;

  const { candidates, has_more } = await findPdgParticlesByPdgid(dbPath, row.parent_pdgid, {
    start: 0,
    limit: RESOLVE_LIMIT,
    case_sensitive,
  });
  if (has_more) {
    throwTooManyMatches('Ambiguous particle selector; too many matches for normalized pdgid', selector, candidates);
  }

  return { candidates, normalized: { pdgid: row.parent_pdgid } };
}

export async function requireUniqueBaseParticle(
  dbPath: string,
  selector: ParticleSelectorInput
): Promise<{
  base_pdgid: string;
  particle: {
    pdgid: string;
    pdgid_id: number;
    description: string | null;
    variants: Array<{ name: string; mcid: number | null; charge: number | null; cc_type: string | null }>;
  };
  candidates: PdgParticleCandidate[];
  normalized?: { pdgid?: string; name?: string };
}> {
  const { candidates, normalized } = await resolveParticleCandidates(dbPath, selector);

  if (candidates.length === 0) {
    throw notFound('Particle not found', { particle: selector });
  }

  const basePdgids = Array.from(new Set(candidates.map(c => c.pdgid)));
  if (basePdgids.length !== 1) {
    throw invalidParams('Ambiguous particle selector; multiple PDG identifiers matched', {
      particle: selector,
      candidates,
    });
  }

  const base_pdgid = basePdgids[0]!;
  const particle = {
    pdgid: base_pdgid,
    pdgid_id: candidates[0]!.pdgid_id,
    description: candidates[0]!.pdg_description,
    variants: candidates.map(c => ({
      name: c.name,
      mcid: c.mcid,
      charge: c.charge,
      cc_type: c.cc_type,
    })),
  };

  return { base_pdgid, particle, candidates, normalized };
}
