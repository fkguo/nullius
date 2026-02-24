(* rewrite_sm_identity.wls

   Demo rewrite hook for hep-calc auto_qft.model_build.
   This file is intentionally simple:
   - It ignores TeX blocks and reuses the SM Lagrangian symbol `LSM`
     from the base model (SM.fr), exporting it under the job-provided symbol.

   Contract:
     Must define HepCalcModelBuildRewrite[parsedBlocks_, ctx_]
     and return an Association with key "lagrangian" (required).
*)

ClearAll[HepCalcModelBuildRewrite];

HepCalcModelBuildRewrite[parsedBlocks_, ctx_] := Module[
  {bad, badIds, outSym, warnings},

  bad = Select[parsedBlocks, ! TrueQ[Lookup[#, "ok", False]] &];
  badIds = Lookup[bad, "id", {}];
  outSym = ToString[Lookup[ctx, "lagrangian_symbol", "LSMFromTeX"]];

  warnings = {};
  If[Length[badIds] > 0,
    warnings = Append[warnings, <|"warning" -> "texform_parse_failed_rows_present", "failed_ids" -> badIds|>];
  ];

  <|
    "lagrangian_symbol" -> outSym,
    "lagrangian" -> LSM,
    "notes" -> "demo rewrite: ignore TeX and reuse SM LSM from base_model_files (SM.fr).",
    "warnings" -> warnings
  |>
];

