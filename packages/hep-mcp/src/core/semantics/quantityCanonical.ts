import type { QuantityMentionV1 } from './quantityTypes.js';
import { normalizeForMatching } from './quantityText.js';

function detectKind(text: string): string | null {
  const normalized = normalizeForMatching(text);
  if (!normalized) return null;

  if (/(branching|branching ratio|\bbr\b|mathcal\s*b)/.test(normalized)) return 'branching_ratio';
  if (/cross[-\s\\]*section/.test(normalized)) return 'cross_section';
  if (/(sigma\s*\(|\bsigma\b)/.test(normalized) && /pp|->|\btev\b/.test(normalized)) return 'cross_section';
  if (/(baryon-to-photon|baryon to photon|baryon asymmetry|eta\s*_?b)/.test(normalized)) return 'baryon_asymmetry';
  if (/(cp asymmetry|a_cp|asymmetry)/.test(normalized)) return 'cp_asymmetry';
  if (/sin\s*\^?\s*2\s*theta/.test(normalized) || /theta\s*_?w/.test(normalized)) return 'mixing_angle';
  if (/alpha\s*_?s/.test(normalized) || /\bcoupling\b/.test(normalized)) return 'coupling';
  if (/(delta\s*m\^?2|dm\^?2|Δm\^?2)/.test(normalized)) return 'mass_squared_difference';
  if (/(lambda_qcd|qcd scale)/.test(normalized)) return 'scale';
  if (/(hubble|h_?0)/.test(normalized)) return 'hubble_constant';
  if (/(tensor-to-scalar|tensor to scalar)/.test(normalized)) return 'tensor_to_scalar_ratio';
  if (/\(g-2\)/.test(normalized) || /g-2/.test(normalized)) return 'anomalous_magnetic_moment';
  if (/(magnetic moment|mu_n)/.test(normalized)) return 'magnetic_moment';
  if (/(form factor|f_?1\(|f_?2\(|dirac|pauli)/.test(normalized)) return 'form_factor';
  if (/(lifetime|\btau\b)/.test(normalized)) return 'lifetime';
  if (/(width|\bgamma\b|decay width|total width)/.test(normalized)) return 'width';
  if (/\bmass\b/.test(normalized) || /\bm_\s*[a-z0-9]/.test(normalized)) return 'mass';
  return null;
}

function cleanEntityToken(input: string): string {
  return normalizeForMatching(input)
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[^a-z0-9_:+->]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractEntityForDecay(rawText: string): string | null {
  const prepared = rawText.replace(/\\to/g, '->').replace(/\s+/g, ' ');

  const parentheticalWithArrow = prepared.match(/\(([^)]*(?:->|\\to|→)[^)]*)\)/);
  const inside =
    parentheticalWithArrow?.[1]
      ?? (() => {
        const arrow = prepared.match(/\b(pp|B0|B\^0|B)\s*(?:->|\\to|→)\s*([^\s,.;)]+)/);
        if (arrow?.[1] && arrow?.[2]) return `${arrow[1]}->${arrow[2]}`;
        const firstParen = prepared.match(/\(([^)]+)\)/);
        return firstParen?.[1] ?? null;
      })();

  if (!inside) return null;

  const cleanedInside = inside
    .replace(/\\to/g, '->')
    .replace(/\\mu/g, 'mu')
    .replace(/\\gamma/g, 'gamma')
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, '')
    .replace(/\^/g, '')
    .replace(/_/g, '');
  const cleaned = cleanedInside.replace(/\\[a-zA-Z]+/g, '');
  return cleaned ? cleaned : null;
}

function extractEntity(text: string, kind: string | null): string | null {
  const rawText = text;
  const normalized = normalizeForMatching(text);

  const particle = rawText.match(/\b[A-Za-z]\(\s*\d{3,5}\s*\)\b/);
  if (particle?.[0]) return particle[0].replace(/\s+/g, '');

  if (kind === 'branching_ratio' || kind === 'cp_asymmetry') {
    const decay = extractEntityForDecay(rawText);
    if (decay) return decay;
  }

  if (kind === 'cross_section') {
    const process = extractEntityForDecay(rawText);
    if (process) return process;

    const arrow = rawText.match(/\bpp\s*(?:->|\\to|→)\s*([A-Za-z0-9/\\*^_{}+-]+)/i);
    if (arrow?.[1]) return `pp->${arrow[1]}`;
  }

  if (kind === 'baryon_asymmetry') {
    if (/eta[_\\s]*b/.test(normalized) || normalized.includes('baryon')) return 'eta_B';
  }

  if (kind === 'coupling') {
    const match = normalized.match(/alpha\s*_?s\s*\(\s*([^)]+)\s*\)/);
    if (match?.[1]) {
      const arg = cleanEntityToken(match[1]).replace(/_?m_?z/g, 'mZ');
      return `alpha_s(${arg || 'unknown'})`;
    }
    if (/alpha\s*_?s/.test(normalized)) return 'alpha_s(unknown)';
  }

  if (kind === 'mixing_angle') {
    if (/theta\s*_?w/.test(normalized)) return 'theta_W';
    if (normalized.includes('theta')) return 'theta';
  }

  if (kind === 'mass_squared_difference') {
    const index = normalized.match(/m\^?2_?\{?(\d+)\}?/);
    if (index?.[1]) return `nu_${index[1]}`;
  }

  if (kind === 'hubble_constant') return 'H0';
  if (kind === 'tensor_to_scalar_ratio') return 'r';

  if (kind === 'anomalous_magnetic_moment') {
    if (/\bmu\b/.test(normalized) || /_mu\b/.test(normalized) || normalized.includes('muon')) return 'muon';
    if (/_e\b/.test(normalized) || normalized.includes('electron')) return 'electron';
  }

  if (kind === 'magnetic_moment') {
    if (normalized.includes('proton') || /mu_p/.test(normalized)) return 'proton';
  }

  if (kind === 'form_factor') {
    if (normalized.includes('dirac') || /f_?1\(/.test(normalized)) return 'dirac';
    if (normalized.includes('pauli') || /f_?2\(/.test(normalized)) return 'pauli';
  }

  if (kind === 'scale') {
    if (normalized.includes('lambda_qcd')) return 'Lambda_QCD';
  }

  if (kind === 'mass' || kind === 'width' || kind === 'lifetime') {
    if (normalized.includes('higgs')) return 'H';
    const isMsbar = normalized.includes('msbar') || normalized.includes('ms-bar') || normalized.includes('ms̄');
    if (normalized.includes('top') || /\bm_\s*t\b/.test(normalized)) return isMsbar ? 'top_msbar' : 'top';
    if (normalized.includes('bottom') || /\bm_\s*b\b/.test(normalized)) return 'bottom';
    if (/\bm_?z\b/.test(normalized) || normalized.includes('z boson')) return 'Z';
    if (/\bm_?w\b/.test(normalized) || normalized.includes('w boson')) return 'W';
    if (/b\^0/i.test(rawText) || /\bb0\b/.test(normalized)) return 'B0';
  }

  return null;
}

export function canonicalQuantityKey(mention: QuantityMentionV1): string {
  const merged = `${mention.quantity} ${mention.context}`.trim();
  const kind = detectKind(merged);
  if (!kind) return 'unknown';
  const entity = extractEntity(merged, kind);
  const entityToken = entity ? cleanEntityToken(entity) : 'unknown';
  return `${kind}:${entityToken || 'unknown'}`;
}
