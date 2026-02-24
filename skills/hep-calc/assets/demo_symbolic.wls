(* Demo entry for hep-calc.

   This file is executed by scripts/mma/run_job.wls.
   It should call HepCalcExportSymbolic[...] to emit a small, JSON-serializable payload.
*)

HepCalcExportSymbolic[
  <|
    "tasks" -> {
      <|
        "id" -> "demo_b0",
        "kind" -> "looptools",
        "fn" -> "B0",
        "args" -> {1.0, 2.0, 3.0}
      |>
    },
    "notes" -> {"demo job: LoopTools.B0(1.0,2.0,3.0) evaluated in Julia LoopTools.jl"}
  |>
];

