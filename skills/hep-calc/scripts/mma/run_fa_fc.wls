(* run_fa_fc.wls

   wolframscript entry point:
     wolframscript -noprompt -file run_fa_fc.wls -- <job.resolved.json> <out_dir>

   Purpose:
   - Optional FeynArts → FormCalc pipeline stage (gated by job.enable_fa_fc or job.feynarts_formcalc_spec).
   - Default behavior is audit-safe: if not enabled, write a SKIPPED status (and do nothing).
   - If enabled and spec provides `entry`, execute that Mathematica script.
     The entry script is responsible for producing any additional artifacts under out_dir/feynarts_formcalc/.
*)

ClearAll[HepCalcWriteJSON];

HepCalcWriteJSON[path_String, data_] := Module[{dir},
  dir = DirectoryName[path];
  If[! DirectoryQ[dir], CreateDirectory[dir, CreateIntermediateDirectories -> True]];
  Export[path, data, "JSON"];
];

args = Rest[$ScriptCommandLine];
If[Length[args] < 2,
  Print["ERROR: expected args: <job.resolved.json> <out_dir>"];
  Quit[2];
];

jobPath = args[[1]];
outDir = args[[2]];
faDir = FileNameJoin[{outDir, "feynarts_formcalc"}];
CreateDirectory[faDir, CreateIntermediateDirectories -> True];

startedAt = DateString[Now, "ISODateTime"];

job = Quiet@Check[Import[jobPath, "RawJSON"], $Failed];
If[job === $Failed,
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "ERROR",
      "reason" -> "job_resolved_json_unreadable",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[3];
];

enabled = TrueQ[Lookup[job, "enable_fa_fc", False]] || (KeyExistsQ[job, "feynarts_formcalc_spec"] && job["feynarts_formcalc_spec"] =!= Null);

If[! enabled,
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "SKIPPED",
      "reason" -> "not_enabled",
      "hint" -> "Set enable_fa_fc: true or provide feynarts_formcalc_spec to run this stage.",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[0];
];

spec = Lookup[job, "feynarts_formcalc_spec", Null];
entry = Null;
If[AssociationQ[spec], entry = Lookup[spec, "entry", Null]];

If[entry === Null || entry === "" || entry === None,
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "SKIPPED",
      "reason" -> "enabled_but_missing_spec_entry",
      "hint" -> "Provide feynarts_formcalc_spec.entry (a .wls/.m file) to execute the FA/FC pipeline.",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[0];
];

If[! FileExistsQ[entry],
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "ERROR",
      "reason" -> "spec_entry_not_found",
      "entry" -> entry,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[10];
];

(* Load packages best-effort *)
pkgOK = True;
pkgOK = pkgOK && Quiet@Check[Needs["FeynArts`"]; True, False, {Get::noopen, Needs::nocont}];
pkgOK = pkgOK && Quiet@Check[Needs["FormCalc`"]; True, False, {Get::noopen, Needs::nocont}];

If[! pkgOK,
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "ERROR",
      "reason" -> "failed_to_load_mma_packages",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[4];
];

(* Provide outDir variables for user entry *)
$HepCalcOutDir = outDir;
$HepCalcFAFCOutDir = faDir;

runOK = Quiet@Check[Get[entry]; True, False];

If[! runOK,
  HepCalcWriteJSON[
    FileNameJoin[{faDir, "status.json"}],
    <|
      "stage" -> "feynarts_formcalc",
      "status" -> "ERROR",
      "reason" -> "spec_entry_execution_failed",
      "entry" -> entry,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[20];
];

HepCalcWriteJSON[
  FileNameJoin[{faDir, "status.json"}],
  <|
    "stage" -> "feynarts_formcalc",
    "status" -> "PASS",
    "entry" -> entry,
    "started_at" -> startedAt,
    "ended_at" -> DateString[Now, "ISODateTime"]
  |>
];

Quit[0];

