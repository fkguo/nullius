(* run_job.wls

   wolframscript entry point:
     wolframscript -noprompt -file run_job.wls -- <job.resolved.json> <out_dir>

   Responsibilities:
   - Load FeynCalc/FeynArts/FormCalc (best-effort).
   - If job.mathematica.entry provided:
       - .wls/.m: Get[file]
       - .nb: extract Input cells -> snapshot .wls -> Get[snapshot]
   - Provide helper HepCalcExportSymbolic[...] to entry scripts.
   - Always write symbolic/status.json and (at least) symbolic/symbolic.json.
*)

ClearAll[HepCalcNormalizeForJSON, HepCalcWriteJSON, HepCalcAddRisk, HepCalcExportSymbolic, HepCalcWriteStatus];

HepCalcNormalizeForJSON[x_Association] := Map[HepCalcNormalizeForJSON, x];
HepCalcNormalizeForJSON[x_List] := HepCalcNormalizeForJSON /@ x;
HepCalcNormalizeForJSON[x_Rule] := Module[{k = First[x]},
  Which[
    StringQ[k], k -> HepCalcNormalizeForJSON[Last[x]],
    True, ToString[k, InputForm] -> HepCalcNormalizeForJSON[Last[x]]
  ]
];
HepCalcNormalizeForJSON[x_?NumericQ] := x;
HepCalcNormalizeForJSON[True] := True;
HepCalcNormalizeForJSON[False] := False;
HepCalcNormalizeForJSON[Null] := Null;
HepCalcNormalizeForJSON[x_String] := x;
HepCalcNormalizeForJSON[x_] := ToString[x, InputForm];

HepCalcWriteJSON[path_String, data_] := Module[{dir},
  dir = DirectoryName[path];
  If[! DirectoryQ[dir], CreateDirectory[dir, CreateIntermediateDirectories -> True]];
  Export[path, HepCalcNormalizeForJSON[data], "JSON"];
];

$HepCalcRisks = {};

HepCalcAddRisk[msg_String] := AppendTo[$HepCalcRisks, msg];

HepCalcWriteStatus[path_String, status_Association] := HepCalcWriteJSON[path, status];

HepCalcExportSymbolic[data_] := Module[{out},
  out = <|
    "schema_version" -> 1,
    "generated_at" -> DateString[Now, "ISODateTime"],
    "data" -> data
  |>;
  HepCalcWriteJSON[FileNameJoin[{$HepCalcOutDir, "symbolic", "symbolic.json"}], out];
];

ClearAll[HepCalcExtractNotebookInputToWLS];

HepCalcExtractNotebookInputToWLS[nbPath_String, outWlsPath_String] := Module[
  {nb, boxes, exprs, lines, txt},
  nb = Quiet@Check[Import[nbPath, "Notebook"], $Failed];
  If[nb === $Failed, Return[$Failed]];

  boxes = Cases[nb, Cell[BoxData[box_], "Input", ___] :> box, Infinity];
  exprs = Quiet@Check[ToExpression[#, StandardForm, HoldComplete] & /@ boxes, $Failed];
  If[exprs === $Failed, Return[$Failed]];

  lines = ToString[(# /. HoldComplete[e_] :> e), InputForm] & /@ exprs;
  txt = StringRiffle[lines, "\n\n"];

  Export[outWlsPath, txt <> "\n", "Text"];
  outWlsPath
];

(* -------- main -------- *)

args = Rest[$ScriptCommandLine];
If[Length[args] < 2,
  Print["ERROR: expected args: <job.resolved.json> <out_dir>"];
  Quit[2];
];

jobPath = args[[1]];
$HepCalcOutDir = args[[2]];

If[! DirectoryQ[$HepCalcOutDir], CreateDirectory[$HepCalcOutDir, CreateIntermediateDirectories -> True]];
CreateDirectory[FileNameJoin[{$HepCalcOutDir, "symbolic"}], CreateIntermediateDirectories -> True];
CreateDirectory[FileNameJoin[{$HepCalcOutDir, "inputs"}], CreateIntermediateDirectories -> True];

startedAt = DateString[Now, "ISODateTime"];

job = Quiet@Check[Import[jobPath, "RawJSON"], $Failed];
If[job === $Failed,
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Failed to import job.resolved.json"}|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|"stage" -> "mathematica_symbolic", "status" -> "ERROR", "reason" -> "job_resolved_json_unreadable", "started_at" -> startedAt, "ended_at" -> DateString[Now, "ISODateTime"]|>
  ];
  Quit[3];
];

(* Load packages best-effort; failure here should still be reported as ERROR. *)
pkgOK = True;
pkgOK = pkgOK && Quiet@Check[Needs["FeynCalc`"]; True, False, {Get::noopen, Needs::nocont}];
pkgOK = pkgOK && Quiet@Check[Needs["FeynArts`"]; True, False, {Get::noopen, Needs::nocont}];
pkgOK = pkgOK && Quiet@Check[Needs["FormCalc`"]; True, False, {Get::noopen, Needs::nocont}];

If[! pkgOK,
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Failed to load Mathematica packages (FeynCalc/FeynArts/FormCalc)."}|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|"stage" -> "mathematica_symbolic", "status" -> "ERROR", "reason" -> "failed_to_load_mma_packages", "started_at" -> startedAt, "ended_at" -> DateString[Now, "ISODateTime"]|>
  ];
  Quit[4];
];

entry = Lookup[Lookup[job, "mathematica", <||>], "entry", None];

faFcEnabled = TrueQ[Lookup[job, "enable_fa_fc", False]] || KeyExistsQ[job, "feynarts_formcalc_spec"] && (job["feynarts_formcalc_spec"] =!= Null);
If[faFcEnabled,
  HepCalcAddRisk["FeynArts→FormCalc pipeline is enabled by job, but default runner is a scaffold; provide a custom entry/spec script for actual physics processes."];
];

If[entry === None || entry === "" || entry === Null,
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"No job.mathematica.entry provided; symbolic stage skipped."}|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "SKIPPED",
      "reason" -> "missing_mathematica_entry",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[0];
];

If[! FileExistsQ[entry],
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Mathematica entry path does not exist."}, "entry" -> entry|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "ERROR",
      "reason" -> "mathematica_entry_not_found",
      "entry" -> entry,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[10];
];

entryToRun = entry;
snapshotPath = Null;

If[StringMatchQ[ToLowerCase[entry], ___ ~~ ".nb"],
  HepCalcAddRisk["Input notebook (.nb) execution is best-effort: only Input cells are extracted; FrontEnd evaluation semantics/macros may differ."];
  snapshotPath = FileNameJoin[{$HepCalcOutDir, "inputs", FileBaseName[entry] <> ".snapshot.wls"}];
  conv = HepCalcExtractNotebookInputToWLS[entry, snapshotPath];
  If[conv === $Failed,
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Failed to extract Input cells from notebook."}, "entry" -> entry|>];
    HepCalcWriteStatus[
      FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "notebook_to_wls_failed",
        "entry" -> entry,
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"],
        "risks" -> $HepCalcRisks
      |>
    ];
    Quit[11];
  ];
  entryToRun = snapshotPath;
];

(* Run entry *)
runOK = Quiet@Check[Get[entryToRun]; True, False];

(* If user script didn't export, still produce empty symbolic.json *)
symPath = FileNameJoin[{$HepCalcOutDir, "symbolic", "symbolic.json"}];
If[! FileExistsQ[symPath],
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Entry executed but did not call HepCalcExportSymbolic[...]"}|>];
];

If[! runOK,
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "ERROR",
      "reason" -> "entry_execution_failed",
      "entry" -> entry,
      "entry_used" -> entryToRun,
      "snapshot" -> snapshotPath,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[20];
];

HepCalcWriteStatus[
  FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
  <|
    "stage" -> "mathematica_symbolic",
    "status" -> "PASS",
    "entry" -> entry,
    "entry_used" -> entryToRun,
    "snapshot" -> snapshotPath,
    "started_at" -> startedAt,
    "ended_at" -> DateString[Now, "ISODateTime"],
    "risks" -> $HepCalcRisks
  |>
];

Quit[0];
