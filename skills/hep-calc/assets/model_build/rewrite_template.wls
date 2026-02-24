(* rewrite_template.wls

   Template for hep-calc auto_qft.model_build rewrite hook.

   You MUST define:
     HepCalcModelBuildRewrite[parsedBlocks_, ctx_]

   Inputs:
   - parsedBlocks: list of associations with fields like:
       "id", "file", "env", "labels", "normalized_tex", "ok", "expr_held" (HoldComplete[...])
   - ctx: association with keys like:
       "job", "out_dir", "auto_dir", "model_build_dir", "lagrangian_symbol", "parse_policy"

   Output (recommended):
     <|
       "lagrangian" -> <Mathematica expression>,
       "lagrangian_symbol" -> "LSM",         (* optional override *)
       "notes" -> "...",                    (* optional *)
       "warnings" -> { ... }                (* optional *)
     |>

   Security note:
   This file executes inside Mathematica with full privileges (Get[...] is used).
*)

ClearAll[HepCalcModelBuildRewrite];

(* Helper: unwrap HoldComplete[expr] -> expr *)
HepCalcHoldRelease[h_] := Quiet@Check[ReleaseHold[h], $Failed];

(* Helper: try to interpret a TeXForm-parsed equation L == rhs *)
HepCalcExtractRHS[expr_] := Module[{e = expr},
  Which[
    MatchQ[e, HoldComplete[_Equal | _SameQ | _Unequal]],
      $Failed,
    MatchQ[e, HoldComplete[_ == _]],
      Last @ First @ Cases[e, HoldComplete[a_ == b_] :> {a, b}, Infinity],
    MatchQ[e, HoldComplete[_ =!= _]],
      $Failed,
    True,
      e
  ]
];

HepCalcModelBuildRewrite[parsedBlocks_, ctx_] := Module[
  {okBlocks, exprs, lag, outSym},

  okBlocks = Select[parsedBlocks, TrueQ[Lookup[#, "ok", False]] &];
  exprs = HepCalcHoldRelease /@ Lookup[okBlocks, "expr_held", {}];
  outSym = ToString[Lookup[ctx, "lagrangian_symbol", "LSM"]];

  (* TODO(agent): implement physics mapping here.
     For example, you might:
     - select only blocks containing \\mathcal{L}
     - map Slash[...] to a DiracSlash object
     - convert traces, chiral building blocks, external sources, etc.
  *)

  lag = 0;
  <|
    "lagrangian_symbol" -> outSym,
    "lagrangian" -> lag,
    "notes" -> "template rewrite: replace lag=0 with a real Lagrangian expression."
  |>
];

