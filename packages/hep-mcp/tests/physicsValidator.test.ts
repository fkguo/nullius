/**
 * Physics Validator Tests
 * Tests for the physics axiom validation system
 */

import { describe, it, expect } from 'vitest';
import {
  validatePhysics,
  PHYSICS_AXIOMS,
  type PhysicsContent,
} from '../src/tools/research/physicsValidator.js';

describe('physicsValidator', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Probability Conservation Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Probability Conservation', () => {
    it('should detect branching ratios exceeding 1', async () => {
      const content: PhysicsContent = {
        text: 'The branching ratios are BR(μν) = 0.6 and BR(eν) = 0.5, totaling 1.1',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
      expect(report.overall_status).toBe('violations');
    });

    it('should pass for valid branching ratios', async () => {
      const content: PhysicsContent = {
        text: 'The branching ratios are BR(μν) = 0.6 and BR(eν) = 0.4, totaling 1.0',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(false);
      expect(report.overall_status).toBe('clean');
    });

    it('should detect probability > 1', async () => {
      const content: PhysicsContent = {
        text: 'The decay probability is 1.2 for this channel',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
      expect(report.overall_status).toBe('violations');
    });

    it('should allow discussion of hypothetical probabilities', async () => {
      const content: PhysicsContent = {
        text: 'If we assume BR(μν) = 0.6 and BR(eν) = 0.5, this would violate conservation',
      };

      const report = await validatePhysics(content);

      // Should be warning, not violation, due to "if we assume" discussion context
      const violation = report.violations.find(v => v.axiom === 'Probability Conservation');
      if (violation) {
        expect(violation.status).toBe('warning');
      }
    });

    it('should tolerate small rounding errors', async () => {
      const content: PhysicsContent = {
        text: 'BR(1) = 0.334, BR(2) = 0.333, BR(3) = 0.334, totaling 1.001',
      };

      const report = await validatePhysics(content);

      // 1.001 is within 1% tolerance
      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Causality Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Causality', () => {
    it('should detect FTL claims', async () => {
      const content: PhysicsContent = {
        text: 'We observe faster-than-light signal propagation in this experiment',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(true);
      expect(report.overall_status).toBe('violations');
    });

    it('should detect superluminal communication claims', async () => {
      const content: PhysicsContent = {
        text: 'The data confirm superluminal communication between detectors',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(true);
    });

    it('should allow discussion of FTL searches', async () => {
      const content: PhysicsContent = {
        text: 'We search for faster-than-light signals but find no evidence',
      };

      const report = await validatePhysics(content);

      // Discussion of searching is allowed
      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(false);
    });

    it('should allow theoretical tachyon discussions', async () => {
      const content: PhysicsContent = {
        text: 'If tachyons exist, they would travel faster than light, but this remains hypothetical',
      };

      const report = await validatePhysics(content);

      // Theoretical discussion with "if" is allowed
      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(false);
    });

    it('should allow constraints/bounds on FTL', async () => {
      const content: PhysicsContent = {
        text: 'We set constraints on faster-than-light propagation',
      };

      const report = await validatePhysics(content);

      // Setting constraints is allowed
      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(false);
    });

    it('should detect causality violation claims', async () => {
      const content: PhysicsContent = {
        text: 'Our measurements show that causality is violated in this process',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Energy Conservation Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Energy Conservation', () => {
    it('should detect unexplained energy non-conservation', async () => {
      const content: PhysicsContent = {
        text: 'Energy is not conserved in this decay process',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(true);
      // Should be warning, not error
      const violation = report.violations.find(v => v.axiom === 'Energy Conservation');
      expect(violation?.severity).toBe('warning');
    });

    it('should allow energy non-conservation in EFT context', async () => {
      const content: PhysicsContent = {
        text: 'In the effective field theory framework, energy is not conserved at this scale',
      };

      const report = await validatePhysics(content);

      // EFT context is allowed
      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(false);
    });

    it('should allow quantum corrections', async () => {
      const content: PhysicsContent = {
        text: 'Quantum corrections lead to apparent energy non-conservation',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(false);
    });

    it('should allow virtual particles', async () => {
      const content: PhysicsContent = {
        text: 'Virtual particles can violate energy conservation temporarily',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(false);
    });

    it('should allow cosmological contexts', async () => {
      const content: PhysicsContent = {
        text: 'In cosmological evolution with curved spacetime, energy is not conserved globally',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(false);
    });

    it('should allow discussions of energy conservation', async () => {
      const content: PhysicsContent = {
        text: 'We investigate whether energy is conserved in this scenario',
      };

      const report = await validatePhysics(content);

      // Discussion/investigation is allowed
      expect(report.violations.some(v => v.axiom === 'Energy Conservation')).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Unitarity Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Unitarity Bound', () => {
    it('should detect unitarity violation claims', async () => {
      const content: PhysicsContent = {
        text: 'The cross section violates unitarity at high energies',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Unitarity Bound')).toBe(true);
      expect(report.violations.find(v => v.axiom === 'Unitarity Bound')?.severity).toBe('warning');
    });

    it('should allow restoring unitarity discussions', async () => {
      const content: PhysicsContent = {
        text: 'New physics is needed to restore unitarity at the TeV scale',
      };

      const report = await validatePhysics(content);

      // Discussion of restoring unitarity is allowed
      expect(report.violations.some(v => v.axiom === 'Unitarity Bound')).toBe(false);
    });

    it('should allow EFT with cutoff', async () => {
      const content: PhysicsContent = {
        text: 'The effective theory violates unitarity above the cut-off scale',
      };

      const report = await validatePhysics(content);

      // EFT with cutoff is allowed
      expect(report.violations.some(v => v.axiom === 'Unitarity Bound')).toBe(false);
    });

    it('should detect non-unitary S-matrix claims', async () => {
      const content: PhysicsContent = {
        text: 'We find that the S-matrix is non-unitary in this model',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Unitarity Bound')).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Lorentz Invariance Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Lorentz Invariance', () => {
    it('should detect Lorentz violation claims', async () => {
      const content: PhysicsContent = {
        text: 'Our results indicate that Lorentz invariance is violated',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(true);
      expect(report.violations.find(v => v.axiom === 'Lorentz Invariance')?.severity).toBe('warning');
    });

    it('should allow search for Lorentz violation', async () => {
      const content: PhysicsContent = {
        text: 'We search for Lorentz violation signatures but find no evidence',
      };

      const report = await validatePhysics(content);

      // Research topic is allowed
      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });

    it('should allow testing Lorentz symmetry', async () => {
      const content: PhysicsContent = {
        text: 'This experiment tests Lorentz symmetry to unprecedented precision',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });

    it('should allow CMB frame references in cosmology', async () => {
      const content: PhysicsContent = {
        text: 'We use the CMB frame as a preferred reference frame for cosmological analysis',
      };

      const report = await validatePhysics(content);

      // CMB frame in cosmology is allowed
      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });

    it('should allow quantum gravity contexts', async () => {
      const content: PhysicsContent = {
        text: 'Quantum gravity effects may break Lorentz invariance at the Planck scale',
      };

      const report = await validatePhysics(content);

      // Quantum gravity context is allowed
      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });

    it('should allow setting constraints', async () => {
      const content: PhysicsContent = {
        text: 'We set new constraints on Lorentz-violating operators',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Options Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Validation Options', () => {
    it('should check only specific axioms when requested', async () => {
      const content: PhysicsContent = {
        text: 'BR = 1.5 and we observe faster-than-light signals',
      };

      const report = await validatePhysics(content, {
        axioms: ['Probability Conservation'],
      });

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
      expect(report.violations.some(v => v.axiom === 'Causality (No FTL)')).toBe(false);
      expect(report.total_checks).toBe(1);
    });

    it('should skip categories when requested', async () => {
      const content: PhysicsContent = {
        text: 'BR = 1.5 and Lorentz invariance is violated',
      };

      const report = await validatePhysics(content, {
        skipCategories: ['symmetry'],
      });

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
      expect(report.violations.some(v => v.axiom === 'Lorentz Invariance')).toBe(false);
    });

    it('should check all axioms by default', async () => {
      const content: PhysicsContent = {
        text: 'Valid physics content',
      };

      const report = await validatePhysics(content);

      expect(report.total_checks).toBe(PHYSICS_AXIOMS.length);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Overall Status Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Overall Status', () => {
    it('should report "clean" for valid content', async () => {
      const content: PhysicsContent = {
        text: 'We measure the Higgs mass to be 125.1 ± 0.2 GeV',
      };

      const report = await validatePhysics(content);

      expect(report.overall_status).toBe('clean');
      expect(report.violations.length).toBe(0);
    });

    it('should report "violations" for error-level violations', async () => {
      const content: PhysicsContent = {
        text: 'The probability is 1.5',
      };

      const report = await validatePhysics(content);

      expect(report.overall_status).toBe('violations');
    });

    it('should report "concerns" for warning-level violations', async () => {
      const content: PhysicsContent = {
        text: 'Energy is not conserved in this process',
      };

      const report = await validatePhysics(content);

      expect(report.overall_status).toBe('concerns');
    });

    it('should prioritize errors over warnings', async () => {
      const content: PhysicsContent = {
        text: 'BR = 1.5 and energy is not conserved',
      };

      const report = await validatePhysics(content);

      expect(report.overall_status).toBe('violations');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ───────────────────────────────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('should handle empty content', async () => {
      const content: PhysicsContent = {};

      const report = await validatePhysics(content);

      expect(report.overall_status).toBe('clean');
    });

    it('should handle LaTeX content', async () => {
      const content: PhysicsContent = {
        latex: '\\text{BR}(\\mu\\nu) = 0.6 \\text{ and } \\text{BR}(e\\nu) = 0.5',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
    });

    it('should combine text and LaTeX', async () => {
      const content: PhysicsContent = {
        text: 'The branching ratio',
        latex: 'BR = 1.2',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
    });

    it('should provide evidence snippets', async () => {
      const content: PhysicsContent = {
        text: 'The measurement shows BR = 1.3 which exceeds unity',
      };

      const report = await validatePhysics(content);

      const violation = report.violations.find(v => v.axiom === 'Probability Conservation');
      expect(violation?.evidence).toBeDefined();
      expect(violation?.evidence?.length).toBeGreaterThan(0);
    });

    it('should count passed checks correctly', async () => {
      const content: PhysicsContent = {
        text: 'Normal physics measurement',
      };

      const report = await validatePhysics(content);

      expect(report.passed).toBe(report.total_checks);
    });

    it('should handle warnings correctly in pass count', async () => {
      const content: PhysicsContent = {
        text: 'Energy is not conserved',
      };

      const report = await validatePhysics(content);

      // Warnings still count as passed in the sense that they don't fail the check
      expect(report.passed).toBe(report.total_checks);
      expect(report.violations.length).toBe(1);
      expect(report.violations[0].status).toBe('warning');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Integration Tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Integration', () => {
    it('should detect multiple violations', async () => {
      const content: PhysicsContent = {
        text: 'BR = 1.5 and we observe faster-than-light signals, with energy not conserved',
      };

      const report = await validatePhysics(content);

      expect(report.violations.length).toBeGreaterThanOrEqual(2);
      expect(report.overall_status).toBe('violations');
    });

    it('should provide detailed report structure', async () => {
      const content: PhysicsContent = {
        text: 'Invalid physics: BR = 1.5',
      };

      const report = await validatePhysics(content);

      expect(report).toHaveProperty('total_checks');
      expect(report).toHaveProperty('passed');
      expect(report).toHaveProperty('violations');
      expect(report).toHaveProperty('overall_status');
      expect(Array.isArray(report.violations)).toBe(true);
    });

    it('should handle complex LaTeX with equations', async () => {
      const content: PhysicsContent = {
        text: 'Analysis of branching fractions',
        latex: '$\\mathcal{B}(D \\to K\\pi) = 0.7$ and $\\mathcal{B}(D \\to \\pi\\pi) = 0.4$',
      };

      const report = await validatePhysics(content);

      expect(report.violations.some(v => v.axiom === 'Probability Conservation')).toBe(true);
    });
  });
});
