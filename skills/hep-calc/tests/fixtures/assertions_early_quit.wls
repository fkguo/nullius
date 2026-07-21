HepCalcExportSymbolic[
  <|
    "assertions" -> {
      <|
        "id" -> "early_quit_failure",
        "passed" -> False,
        "residual" -> 2.*^-12,
        "tolerance" -> 1.*^-12
      |>
    },
    "tasks" -> {
      <|
        "id" -> "seeded_later_error",
        "kind" -> "julia_expr",
        "expr" -> "error(\"seeded later-stage error\")"
      |>
    },
    "notes" -> {"Deliberate early zero exit after exporting a false assertion."}
  |>
];
Quit[0];
