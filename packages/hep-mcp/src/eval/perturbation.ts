export type PerturbationExpectation = 'retain_success' | 'fail_closed';

export type PerturbationClassification =
  | 'canonical_success_retained'
  | 'acceptable_fail_closed_rejection'
  | 'overfit_failure'
  | 'bad_shortcut_success';

export type PerturbationProbe = {
  ok: boolean;
  success_signature?: string[];
  error_code?: string | null;
  next_action_tools?: string[];
};

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function classifyPerturbation(params: {
  expectation: PerturbationExpectation;
  canonical: PerturbationProbe;
  perturbed: PerturbationProbe;
  allowed_error_codes?: string[];
  required_next_action_tools?: string[];
}): {
  classification: PerturbationClassification;
  passed: boolean;
} {
  const allowedErrorCodes = params.allowed_error_codes ?? ['INVALID_PARAMS'];
  const requiredNextActionTools = params.required_next_action_tools ?? [];

  if (params.expectation === 'retain_success') {
    const retained =
      params.canonical.ok
      && params.perturbed.ok
      && sameStringArray(params.canonical.success_signature, params.perturbed.success_signature);
    return {
      classification: retained ? 'canonical_success_retained' : 'overfit_failure',
      passed: retained,
    };
  }

  const failClosed =
    !params.perturbed.ok
    && allowedErrorCodes.includes(params.perturbed.error_code ?? '')
    && requiredNextActionTools.every(tool => params.perturbed.next_action_tools?.includes(tool));

  if (failClosed) {
    return {
      classification: 'acceptable_fail_closed_rejection',
      passed: true,
    };
  }

  return {
    classification: params.perturbed.ok ? 'bad_shortcut_success' : 'overfit_failure',
    passed: false,
  };
}
