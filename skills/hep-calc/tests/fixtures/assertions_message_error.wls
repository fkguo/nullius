HepCalcExportSymbolic[
  <|
    "assertions" -> {
      <|
        "id" -> "message_path_failure",
        "passed" -> False
      |>
    },
    "tasks" -> {},
    "notes" -> {"Deliberate entry message after exporting a false assertion."}
  |>
];
HepCalcSeed::failure = "Deliberate seeded message.";
Message[HepCalcSeed::failure];
