HepCalcWriteJSON[
  FileNameJoin[{$HepCalcOutDir, "symbolic", "symbolic.json"}],
  <|
    "schema_version" -> 1,
    "generated_at" -> DateString[Now, "ISODateTime"]
  |>
];
