# Example — Problem Framing / Problem Framing-R (excerpt)

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader  
Profile: `mixed`

## 0) Problem Interpretation (example)

- Question: compute the collinear propagator $G_R$ in a fixed soft background, then construct the soft closure kernel $\\Pi_s$.
- Inputs: soft shear profile $v_s(x,t)$ (allow $O(1)$ amplitude but soft gradients)
- Outputs: a computable expression for $G_R$; a kernel / derivative expansion for $\\Pi_s$
- Scope: HM toy / later match to HW/ITG
- Anti-scope: do not do full numerical coefficient matching in this round
- Falsification / kill: if sign/normalization ambiguity appears and cannot be eliminated by a minimal discriminating test, fork into competing hypotheses and proceed separately

## 1) P/D separation (example)

Principles:
- P1: incompressible $E\\times B$ flow ⇒ Jacobian = 1 (source: derivation)
- P2: Kelvin modes under constant shear (source: literature)

Derivation:
- D1: shearing coordinate transform and Laplace distortion (steps >= 3 ...)

