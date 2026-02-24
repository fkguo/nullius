# Example — Analogy Mining

Project: <PROJECT_NAME>  
Date: 2026-01-14  
Owner: leader  
Profile: `theory_only`

## 0) Structure signature (example)

- Objects: an effective theory with two coupled sectors (slow/fast)
- Constraints: factorization / power counting / resummation (RG)
- Small parameter: $\lambda \ll 1$
- Key structure: Wilson lines / equivalence classes under shearing coordinates
- Outputs: controlled LP decoupling + NLP correction operators

## 1) Candidate source domains (example)

| Candidate | Why it matches signature | What falsifies quickly? |
|---|---|---|
| SCET | soft/collinear factorization structure matches | cannot align power counting / operator basis |
| WKB / multi-scale | slow/fast expansion looks similar | expansion parameter cannot be aligned to physical quantities |

## 2) Minimal literature anchors (example)

- SCET: a standard review (to be materialized into `knowledge_base/literature/`)

## 3) Mapping table (example)

| Source object | Target object | Mapping rule | Scope | Test |
|---|---|---|---|---|
| collinear field | drift-wave sector | $k_y\\sim O(1)$ | HM toy | check propagator |
| soft field | zonal sector | $k_y=0$ | strong shear allowed | check Jacobian=1 |

## 4) Minimal validation (example)

- V1: is the Jacobian equal to 1? (incompressible flow)
- V2: does the Kelvin-mode behavior reproduce under constant shear?

Kill criteria (example):
- if any minimal validation (V1/V2) fails, or the mapping requires introducing an undeclared new small parameter, reject the analogy

