export type ChallengeType =
  | 'systematic_uncertainty'
  | 'background_control'
  | 'selection_bias'
  | 'model_dependence'
  | 'acceptance_or_coverage_limit'
  | 'simulation_mismatch'
  | 'fit_instability'
  | 'extrapolation_risk'
  | 'cross_cutting_methodology';

export interface ChallengeRule {
  type: ChallengeType;
  strong: string[];
  weak?: string[];
}

export const CHALLENGE_NORMALIZATION_HINTS: ChallengeRule[] = [
  { type: 'systematic_uncertainty', strong: ['systematic uncertainty', 'systematic uncertainties', 'uncertainty budget', 'nuisance parameter'], weak: ['systematic', 'uncertainty'] },
  { type: 'background_control', strong: ['background contamination', 'background subtraction', 'background model', 'sideband', 'control region'], weak: ['background'] },
  { type: 'selection_bias', strong: ['selection bias', 'trigger bias', 'selection efficiency', 'reconstruction bias'], weak: ['trigger selection'] },
  { type: 'model_dependence', strong: ['model dependent', 'model-dependent', 'model dependence', 'ansatz dependence', 'prior dependence'] },
  { type: 'acceptance_or_coverage_limit', strong: ['limited detector coverage', 'limited coverage', 'acceptance limit', 'acceptance correction', 'fiducial coverage'], weak: ['acceptance', 'coverage'] },
  { type: 'simulation_mismatch', strong: ['simulation mismatch', 'simulation mismodelling', 'simulation mismodeling', 'monte carlo disagreement', 'detector response mismatch'], weak: ['mismodelling', 'mismodeling'] },
  { type: 'fit_instability', strong: ['fit instability', 'unstable fit', 'local minima', 'non convergent fit', 'non-convergent fit'], weak: ['fit unstable'] },
  { type: 'extrapolation_risk', strong: ['outside the measured phase space', 'outside measured phase space', 'extrapolation risk', 'model-dependent extrapolation'], weak: ['extrapolation'] },
];

export const OPEN_CHALLENGE_MARKERS = [
  'bias',
  'challenge',
  'contamination',
  'depends on',
  'difficult',
  'instability',
  'limitation',
  'limited',
  'mismatch',
  'risk',
  'sensitive to',
  'suffers from',
  'uncertain',
  'uncertainty',
  'unstable',
];

export const UNCERTAIN_CUES = ['under study', 'further validation', 'ongoing', 'still being assessed', 'sensitivity to assumptions'];
export const EXPLICIT_NO_CHALLENGE = ['no major methodological limitation', 'standard validated control strategy', 'validated control strategy'];
export const NON_METHODOLOGY_CUES = ['independent confirmation', 'more data', 'ultraviolet completion', 'uv completion'];
