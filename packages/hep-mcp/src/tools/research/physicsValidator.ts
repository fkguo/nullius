/**
 * Physics Validator
 *
 * Validates physics content against fundamental axioms and conservation laws.
 * Detects potential violations of basic physics principles using heuristic checks.
 *
 * Key Features:
 * - Conservation law checks (probability, energy, momentum)
 * - Causality verification (no FTL signals)
 * - Symmetry checks (Lorentz invariance)
 * - Limit checks (unitarity bounds)
 * - Context-aware detection (distinguishes discussion from claims)
 *
 * @module physicsValidator
 */

/**
 * Validation result status
 */
export type ValidationStatus = 'pass' | 'violation' | 'warning' | 'unknown';

/**
 * Axiom severity level
 */
export type AxiomSeverity = 'error' | 'warning' | 'info';

/**
 * Axiom category
 */
export type AxiomCategory = 'conservation' | 'causality' | 'symmetry' | 'limit';

/**
 * Physics content to validate
 */
export interface PhysicsContent {
  /** LaTeX source content */
  latex?: string;
  /** Plain text content */
  text?: string;
  /** Extracted equations */
  equations?: Array<{ latex: string; label?: string }>;
  /** Extracted measurements */
  measurements?: Array<{
    quantity: string;
    value: number;
    uncertainty?: number;
    unit?: string;
  }>;
}

/**
 * Validation result for a single axiom check
 */
export interface ValidationResult {
  /** Validation status */
  status: ValidationStatus;
  /** Detailed message if violation/warning detected */
  message?: string;
  /** Evidence snippets supporting the violation */
  evidence?: string[];
}

/**
 * Physics axiom definition
 */
export interface PhysicsAxiom {
  /** Axiom name */
  name: string;
  /** Axiom category */
  category: AxiomCategory;
  /** Severity level if violated */
  severity: AxiomSeverity;
  /** Description of the axiom */
  description: string;
  /** Check function */
  check: (content: PhysicsContent) => ValidationResult;
}

/**
 * Violation in validation report
 */
export interface Violation {
  /** Axiom name */
  axiom: string;
  /** Axiom category */
  category: AxiomCategory;
  /** Severity level */
  severity: AxiomSeverity;
  /** Validation status */
  status: 'violation' | 'warning';
  /** Detailed message */
  message?: string;
  /** Evidence snippets */
  evidence?: string[];
}

/**
 * Overall validation status
 */
export type OverallStatus = 'clean' | 'concerns' | 'violations';

/**
 * Complete validation report
 */
export interface ValidationReport {
  /** Paper identifier (if provided) */
  paper_identifier?: string;
  /** Total number of checks performed */
  total_checks: number;
  /** Number of checks passed */
  passed: number;
  /** List of violations found */
  violations: Violation[];
  /** Overall status summary */
  overall_status: OverallStatus;
}

/**
 * Extract context around a keyword match
 */
function extractContext(text: string, match: string, windowSize: number = 100): string {
  const index = text.toLowerCase().indexOf(match.toLowerCase());
  if (index === -1) return '';

  const start = Math.max(0, index - windowSize);
  const end = Math.min(text.length, index + match.length + windowSize);

  return text.slice(start, end).trim();
}

/**
 * Check if text contains discussion rather than claim
 *
 * Discussion indicators: "if", "suppose", "hypothetical", "study", "investigate"
 * Claim indicators: "we observe", "we measure", "result shows", "confirmed"
 */
function isDiscussion(context: string): boolean {
  const discussionPatterns = [
    /\b(if|suppose|hypothetical|assume|consider|study|investigate|explore|propose)\b/gi,
    /\b(could|might|would|may)\s+(violate|break)/gi,
    /\b(search for|test|probe|constrain|bound on)\b/gi,
  ];

  const claimPatterns = [
    /\b(we\s+(observe|measure|find|detect|discover|confirm|show))\b/gi,
    /\b(result\s+shows|data\s+indicate|evidence\s+suggests)\b/gi,
    /\b(is|are)\s+(observed|measured|detected|confirmed|violated|broken)\b/gi,
    /\b(our\s+(results?|measurements?|data))\s+(indicate|show|confirm)/gi,
  ];

  const hasDiscussion = discussionPatterns.some(p => p.test(context));
  const hasClaim = claimPatterns.some(p => p.test(context));

  // If both, prefer discussion interpretation for safety
  if (hasDiscussion) return true;
  if (hasClaim) return false;

  return false; // Uncertain, treat as potential claim
}

/**
 * Check probability conservation
 *
 * Detects:
 * - Branching ratios summing > 1
 * - Probabilities exceeding 1
 * - Total cross sections inconsistent with partial sums
 */
function checkProbabilityConservation(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // Pattern 1: Explicit branching ratio statements - multiple formats
  const brPatterns = [
    /BR\s*[(\[]\s*([^)\]]+)\s*[)\]]\s*=\s*([\d.]+)/gi,  // BR(μν) = 0.6
    /BR\s*=\s*([\d.]+)/gi,                               // BR = 1.5
    /\\text\{BR\}\s*\([^)]+\)\s*=\s*([\d.]+)/gi,        // \text{BR}(\mu\nu) = 0.6
    /\\mathcal\{B\}\s*\([^)]+\)\s*=\s*([\d.]+)/gi,      // \mathcal{B}(D \to K\pi) = 0.7
  ];

  const allBRs: number[] = [];
  for (const pattern of brPatterns) {
    const matches = Array.from(text.matchAll(pattern));
    for (const match of matches) {
      // Extract the numeric value (it's in different capture groups for different patterns)
      const value = match[2] || match[1];
      if (value) {
        allBRs.push(parseFloat(value));
      }
    }
  }

  if (allBRs.length > 1) {
    const sum = allBRs.reduce((a, b) => a + b, 0);

    if (sum > 1.01) { // 1% tolerance for rounding
      const context = extractContext(text, 'BR');
      evidence.push(context);

      // Check if it's discussing theoretical possibilities
      if (isDiscussion(text)) {
        return {
          status: 'warning',
          message: `Branching ratios sum to ${sum.toFixed(3)} > 1 (may be discussing individual channels)`,
          evidence,
        };
      }

      return {
        status: 'violation',
        message: `Branching ratios sum to ${sum.toFixed(3)} exceeds 1`,
        evidence,
      };
    }
  }

  // Pattern 2: Generic probability statements
  const probPattern = /probability\s+(?:is|=)\s*([\d.]+)/gi;
  const probMatches = Array.from(text.matchAll(probPattern));

  for (const match of probMatches) {
    const prob = parseFloat(match[1]);
    if (prob > 1.0) {
      const context = extractContext(text, match[0]);
      evidence.push(context);

      return {
        status: 'violation',
        message: `Probability value ${prob} exceeds 1`,
        evidence,
      };
    }
  }

  // Pattern 3: Single BR statement exceeding 1
  if (allBRs.length === 1 && allBRs[0] > 1.0) {
    const context = extractContext(text, 'BR');
    evidence.push(context);

    return {
      status: 'violation',
      message: `Branching ratio ${allBRs[0]} exceeds 1`,
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Check causality (no faster-than-light signals)
 *
 * Detects:
 * - Claims of superluminal communication
 * - FTL particle propagation (excluding theoretical discussions)
 * - Causality violation claims
 */
function checkCausality(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // Keywords indicating FTL or causality violation
  const ftlPatterns = [
    { pattern: /faster[\s-]*than[\s-]*light/gi, term: 'faster than light' },
    { pattern: /superluminal\s+(signal|communication|propagation)/gi, term: 'superluminal' },
    { pattern: /FTL\s+(signal|communication|propagation)/gi, term: 'FTL' },
    { pattern: /(?:violat(?:es?|ing|ed)|break(?:s|ing|broken))\s+causality/gi, term: 'causality violation' },
    { pattern: /causality\s+(?:is|was)\s+(?:violated|broken)/gi, term: 'causality violation' },
    { pattern: /acausal\s+(behavior|propagation)/gi, term: 'acausal' },
  ];

  for (const { pattern } of ftlPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0]);

      // Skip if discussing theoretical possibilities or searches
      if (isDiscussion(context)) {
        continue;
      }

      // Skip if discussing tachyons theoretically
      if (/tachyon/i.test(context) && isDiscussion(context)) {
        continue;
      }

      // Skip if mentioning constraints or bounds
      if (/constraint|bound|limit/i.test(context)) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'violation',
      message: 'Potential causality violation or FTL signal claim detected',
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Check energy-momentum conservation
 *
 * Detects:
 * - Unexplained energy non-conservation
 * - Missing energy without explanation
 *
 * Allowed exceptions:
 * - Effective field theory context
 * - Quantum corrections
 * - Virtual particles
 */
function checkEnergyConservation(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // Look for energy non-conservation claims
  const violationPatterns = [
    /energy\s+(?:is\s+)?not\s+conserved/gi,
    /violat(?:es?|ing)\s+energy\s+conservation/gi,
    /non[-\s]*conservation\s+of\s+energy/gi,
  ];

  // Allowed contexts (theoretical discussions)
  const allowedContexts = [
    /effective\s+field\s+theory/gi,
    /quantum\s+correction/gi,
    /virtual\s+particle/gi,
    /curved\s+spacetime/gi,
    /general\s+relativity/gi,
    /cosmological/gi,
  ];

  for (const pattern of violationPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 200);

      // Check if it's a theoretical discussion
      if (isDiscussion(context)) {
        continue;
      }

      // Check if context includes allowed exceptions
      const hasException = allowedContexts.some(p => p.test(context));
      if (hasException) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'warning',
      message: 'Energy conservation violation claimed without clear theoretical justification',
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Check unitarity bound
 *
 * Detects:
 * - Unitarity violation claims
 * - Cross sections exceeding unitarity bounds
 * - S-matrix unitarity issues
 */
function checkUnitarityBound(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // Look for unitarity violation claims
  const violationPatterns = [
    /violat(?:es?|ing)\s+unitarity/gi,
    /unitarity\s+(?:is\s+)?(?:broken|violated)/gi,
    /non[-\s]*unitary/gi,
  ];

  // Allowed contexts
  const allowedContexts = [
    /restore\s+unitarity/gi,
    /preserv(?:e|ing)\s+unitarity/gi,
    /respect\s+unitarity/gi,
    /cut[-\s]*off/gi,
    /effective\s+theory/gi,
  ];

  for (const pattern of violationPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 200);

      // Check if discussing how to restore/preserve unitarity
      const hasException = allowedContexts.some(p => p.test(context));
      if (hasException || isDiscussion(context)) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'warning',
      message: 'Potential unitarity violation detected',
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Check Lorentz invariance
 *
 * Detects:
 * - Lorentz violation claims
 * - Preferred frame references (without proper context)
 *
 * Allowed exceptions:
 * - Papers explicitly studying Lorentz violation (research topic)
 * - Cosmological contexts (CMB frame)
 */
function checkLorentzInvariance(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // Look for Lorentz violation claims
  const violationPatterns = [
    /(?:violat(?:es?|ing|ed)|break(?:s|ing|broken))\s+Lorentz\s+(?:invariance|symmetry)/gi,
    /Lorentz\s+(?:invariance|symmetry)\s+(?:is|was)\s+(?:violated|broken)/gi,
    /Lorentz[-\s]*violating/gi,
    /preferred\s+(?:frame|reference\s+frame)/gi,
  ];

  // Allowed contexts (research topics, cosmology)
  // Check in wider context for these patterns
  const allowedContexts = [
    /search\s+for\s+(?:Lorentz|LV)/gi,
    /test(?:s|ing)\s+Lorentz/gi,
    /constraint(?:s)?\s+on\s+Lorentz/gi,
    /bound(?:s)?\s+on\s+Lorentz/gi,
    /set\s+(?:new\s+)?constraint/gi,
    /cosmological/gi,
    /CMB\s+frame/gi,
    /cosmic\s+microwave\s+background/gi,
    /quantum\s+gravity/gi,
  ];

  // First, check if entire text is about setting constraints/bounds
  const isConstraintPaper = allowedContexts.some(p => p.test(text));

  for (const pattern of violationPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 250);

      // Skip if the paper is about setting constraints
      if (isConstraintPaper) {
        continue;
      }

      // Check if it's the research topic itself
      const isResearchTopic = allowedContexts.some(p => p.test(context));
      if (isResearchTopic || isDiscussion(context)) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'warning',
      message: 'Lorentz invariance violation claimed (verify this is the research topic)',
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Check Heisenberg Uncertainty Principle
 *
 * Detects **conceptual** violations, not just formula checks:
 *
 * 1. **Simultaneous precise measurement claims**:
 *    - Claiming to measure conjugate variables (x,p or E,t) simultaneously with arbitrary precision
 *    - Claiming to determine exact quantum trajectories
 *
 * 2. **Violation/bypass claims**:
 *    - Claiming to violate, bypass, or overcome the uncertainty principle
 *    - Claiming "quantum certainty" without proper context
 *
 * 3. **Conceptual confusions** (harder to detect, lower severity):
 *    - Confusing observer effect with uncertainty principle
 *    - Confusing technical limitations with fundamental limits
 *
 * **Legitimate contexts (excluded from violation):**
 * - Weak measurement research (trade-off: low info per shot)
 * - Squeezed states (one variable tighter, other wider)
 * - EPR/entanglement discussions (correlations don't violate)
 * - Heisenberg limit in quantum metrology (legitimate research topic)
 * - Standard quantum limit (SQL) discussions
 * - Theoretical/hypothetical discussions
 */
function checkHeisenbergUncertainty(content: PhysicsContent): ValidationResult {
  const text = (content.text || '') + ' ' + (content.latex || '');
  const evidence: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // Pattern 1: Claims of violating/bypassing uncertainty principle
  // ═══════════════════════════════════════════════════════════════════════════
  const violationPatterns = [
    // Active voice: violate/bypass/overcome
    /(?:violat(?:es?|ing|ed)|bypass(?:es|ing|ed)?|overcome(?:s|ing)?|circumvent(?:s|ing|ed)?)\s+(?:the\s+)?(?:Heisenberg\s+)?uncertainty\s+(?:principle|relation)/gi,
    // Passive voice
    /uncertainty\s+(?:principle|relation)\s+(?:is|was|has\s+been)\s+(?:violated|bypassed|overcome|circumvented)/gi,
    // Beat/break the uncertainty
    /(?:beat(?:s|ing)?|break(?:s|ing)?)\s+(?:the\s+)?(?:Heisenberg\s+)?uncertainty/gi,
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // Pattern 2: Simultaneous precise measurement of conjugate variables
  // ═══════════════════════════════════════════════════════════════════════════
  const simultaneousMeasurementPatterns = [
    // Simultaneously measure x and p / position and momentum
    /simultaneously\s+(?:measure|determine|know)\s+(?:both\s+)?(?:position\s+and\s+momentum|x\s+and\s+p|Δx\s+and\s+Δp)/gi,
    // Precise/exact trajectory in quantum mechanics
    /(?:precise|exact|definite)\s+(?:quantum\s+)?trajector(?:y|ies)/gi,
    // Arbitrary precision on both
    /(?:arbitrary|unlimited|infinite)\s+precision\s+(?:on|for)\s+(?:both|position\s+and\s+momentum|conjugate)/gi,
    // Determine both with certainty
    /determine\s+both\s+(?:position\s+and\s+momentum|x\s+and\s+p)\s+(?:exactly|precisely|with\s+certainty)/gi,
    // Measure energy and time simultaneously
    /simultaneously\s+(?:measure|determine)\s+(?:energy\s+and\s+time|E\s+and\s+t|ΔE\s+and\s+Δt)/gi,
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // Pattern 3: Conceptual confusions (lower severity)
  // ═══════════════════════════════════════════════════════════════════════════
  const confusionPatterns = [
    // Claiming observation doesn't disturb (misconception: HUP is intrinsic, not just observer effect)
    /(?:measure|observe)\s+without\s+(?:disturbing|affecting|altering)\s+(?:the\s+)?(?:quantum\s+)?(?:state|system|particle)/gi,
    // "Quantum certainty" claims
    /achieve\s+(?:quantum\s+)?certainty/gi,
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // Legitimate contexts to exclude
  // ═══════════════════════════════════════════════════════════════════════════
  const legitimateContexts = [
    // Weak measurement (legitimate technique)
    /weak\s+measurement/gi,
    /weak\s+value/gi,
    // Squeezed states (can reduce uncertainty in one variable)
    /squeezed\s+(?:state|light|vacuum)/gi,
    // EPR and entanglement (correlations don't violate HUP)
    /EPR\s+(?:paradox|pair|correlation)/gi,
    /entangl(?:ed|ement)/gi,
    /Bell(?:'s)?\s+(?:inequality|theorem|test)/gi,
    // Heisenberg limit in quantum metrology (research topic)
    /Heisenberg\s+limit/gi,
    /standard\s+quantum\s+limit/gi,
    /SQL/g, // Standard Quantum Limit
    /quantum\s+metrology/gi,
    /quantum\s+sensing/gi,
    // Research/theoretical context
    /(?:test|probe|investigate|study)\s+(?:the\s+)?uncertainty/gi,
    /implications?\s+of\s+(?:the\s+)?uncertainty/gi,
  ];

  // Check if overall context is about legitimate research
  const isLegitimateResearchContext = legitimateContexts.some(p => p.test(text));

  // ─────────────────────────────────────────────────────────────────────────
  // Check violation patterns (severity: error)
  // ─────────────────────────────────────────────────────────────────────────
  for (const pattern of violationPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 200);

      // Skip if it's a discussion or theoretical context
      if (isDiscussion(context)) {
        continue;
      }

      // Skip if it's in a legitimate research context
      if (isLegitimateResearchContext || legitimateContexts.some(p => p.test(context))) {
        continue;
      }

      evidence.push(context);
    }
  }

  // If we found violation claims, return immediately
  if (evidence.length > 0) {
    return {
      status: 'violation',
      message: 'Claims to violate or bypass the Heisenberg uncertainty principle',
      evidence,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check simultaneous measurement patterns (severity: warning)
  // ─────────────────────────────────────────────────────────────────────────
  for (const pattern of simultaneousMeasurementPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 200);

      if (isDiscussion(context)) {
        continue;
      }

      // Check for legitimate techniques that can appear to measure "simultaneously"
      if (legitimateContexts.some(p => p.test(context))) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'warning',
      message: 'Claims simultaneous precise measurement of conjugate variables (verify context)',
      evidence,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check conceptual confusion patterns (severity: info/warning)
  // ─────────────────────────────────────────────────────────────────────────
  for (const pattern of confusionPatterns) {
    const matches = Array.from(text.matchAll(pattern));

    for (const match of matches) {
      const context = extractContext(text, match[0], 200);

      if (isDiscussion(context)) {
        continue;
      }

      // Weak measurement can legitimately "not disturb" in a technical sense
      if (legitimateContexts.some(p => p.test(context))) {
        continue;
      }

      evidence.push(context);
    }
  }

  if (evidence.length > 0) {
    return {
      status: 'warning',
      message: 'Possible conceptual confusion about uncertainty principle vs observer effect',
      evidence,
    };
  }

  return { status: 'pass' };
}

/**
 * Physics axioms to check
 */
export const PHYSICS_AXIOMS: PhysicsAxiom[] = [
  {
    name: 'Probability Conservation',
    category: 'conservation',
    severity: 'error',
    description: 'Total probability (or branching ratios) cannot exceed 1',
    check: checkProbabilityConservation,
  },
  {
    name: 'Causality (No FTL)',
    category: 'causality',
    severity: 'error',
    description: 'No faster-than-light signal propagation',
    check: checkCausality,
  },
  {
    name: 'Energy Conservation',
    category: 'conservation',
    severity: 'warning',
    description: 'Energy-momentum conservation (unless explicitly justified)',
    check: checkEnergyConservation,
  },
  {
    name: 'Unitarity Bound',
    category: 'limit',
    severity: 'warning',
    description: 'S-matrix unitarity must be preserved',
    check: checkUnitarityBound,
  },
  {
    name: 'Lorentz Invariance',
    category: 'symmetry',
    severity: 'warning',
    description: 'Lorentz invariance (unless violation is the research topic)',
    check: checkLorentzInvariance,
  },
  {
    name: 'Heisenberg Uncertainty Principle',
    category: 'limit',
    severity: 'warning',
    description: 'Conjugate variables cannot be simultaneously measured with arbitrary precision (conceptual check)',
    check: checkHeisenbergUncertainty,
  },
];

/**
 * Validation options
 */
export interface ValidationOptions {
  /** Only check specific axioms by name */
  axioms?: string[];
  /** Skip specific categories */
  skipCategories?: AxiomCategory[];
}

/**
 * Validate physics content against fundamental axioms
 *
 * @param content - Physics content to validate
 * @param options - Validation options
 * @returns Validation report with violations and overall status
 *
 * @example
 * ```typescript
 * const content = {
 *   text: 'The branching ratios are BR(1) = 0.6 and BR(2) = 0.5, totaling 1.1'
 * };
 *
 * const report = await validatePhysics(content);
 * console.log(report.overall_status); // 'violations'
 * console.log(report.violations[0].axiom); // 'Probability Conservation'
 * ```
 */
export async function validatePhysics(
  content: PhysicsContent,
  options?: ValidationOptions
): Promise<ValidationReport> {
  const violations: Violation[] = [];
  let checksPerformed = 0;
  let checksPassed = 0;

  // Filter axioms based on options
  const axiomsToCheck = PHYSICS_AXIOMS.filter(axiom => {
    // Skip if category is excluded
    if (options?.skipCategories?.includes(axiom.category)) {
      return false;
    }

    // Skip if specific axioms requested and this isn't one of them
    if (options?.axioms && !options.axioms.includes(axiom.name)) {
      return false;
    }

    return true;
  });

  // Run checks
  for (const axiom of axiomsToCheck) {
    checksPerformed++;

    try {
      const result = axiom.check(content);

      if (result.status === 'pass') {
        checksPassed++;
      } else if (result.status === 'violation' || result.status === 'warning') {
        violations.push({
          axiom: axiom.name,
          category: axiom.category,
          severity: axiom.severity,
          status: result.status,
          message: result.message,
          evidence: result.evidence,
        });

        if (result.status === 'warning') {
          checksPassed++; // Warnings don't fail the check
        }
      }
      // 'unknown' status doesn't count as pass or fail
    } catch (error) {
      // Log error but continue with other checks
      console.debug(
        `[physicsValidator] Error checking ${axiom.name}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  // Determine overall status
  let overallStatus: OverallStatus;
  const hasErrors = violations.some(v => v.severity === 'error');
  const hasWarnings = violations.some(v => v.severity === 'warning');

  if (hasErrors) {
    overallStatus = 'violations';
  } else if (hasWarnings) {
    overallStatus = 'concerns';
  } else {
    overallStatus = 'clean';
  }

  return {
    total_checks: checksPerformed,
    passed: checksPassed,
    violations,
    overall_status: overallStatus,
  };
}
