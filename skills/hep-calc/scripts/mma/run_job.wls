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

ClearAll[
  HepCalcNormalizeForJSON,
  HepCalcWriteJSON,
  HepCalcAddRisk,
  HepCalcExportSymbolic,
  HepCalcBoundInputText,
  HepCalcSecureReadBoundInput,
  HepCalcDecodeSecureBytes,
  HepCalcWriteStatus,
  HepCalcFiniteRealNumberQ,
  HepCalcEvaluateAssertions
];

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

HepCalcFiniteRealNumberQ[x_] := NumberQ[x] &&
  TrueQ[Im[N[x]] == 0] &&
  FreeQ[x, Indeterminate | ComplexInfinity | DirectedInfinity[_]];

HepCalcEvaluateAssertions[path_String, requireNonempty_: False] := Module[
  {
    symbolic,
    data,
    assertions,
    evaluated,
    total,
    passed,
    failed,
    invalid,
    failedIDs,
    duplicateIDs
  },
  symbolic = Quiet@Check[Import[path, "RawJSON"], $Failed];
  If[! AssociationQ[symbolic],
    Return[<|
      "contract_valid" -> False,
      "total" -> 1,
      "pass" -> 0,
      "fail" -> 1,
      "invalid" -> 1,
      "failed_ids" -> {"assertions_contract"}
    |>]
  ];

  data = Lookup[symbolic, "data", <||>];
  If[! AssociationQ[data],
    Return[<|
      "contract_valid" -> False,
      "total" -> 1,
      "pass" -> 0,
      "fail" -> 1,
      "invalid" -> 1,
      "failed_ids" -> {"assertions_contract"}
    |>]
  ];

  If[! KeyExistsQ[data, "assertions"],
    If[TrueQ[requireNonempty],
      Return[<|
        "contract_valid" -> False,
        "total" -> 1,
        "pass" -> 0,
        "fail" -> 1,
        "invalid" -> 1,
        "failed_ids" -> {"bound_symbolic_assertions_required"}
      |>]
    ];
    Return[<|
      "contract_valid" -> True,
      "total" -> 0,
      "pass" -> 0,
      "fail" -> 0,
      "invalid" -> 0,
      "failed_ids" -> {}
    |>]
  ];

  assertions = Lookup[data, "assertions", Missing["NotAvailable"]];
  If[! ListQ[assertions],
    Return[<|
      "contract_valid" -> False,
      "total" -> 1,
      "pass" -> 0,
      "fail" -> 1,
      "invalid" -> 1,
      "failed_ids" -> {"assertions_contract"}
    |>]
  ];

  evaluated = MapIndexed[
    Function[{assertion, position},
      Module[
        {
          id,
          passedValue,
          valid,
          hasResidual,
          hasTolerance,
          residual,
          tolerance,
          residualConsistent
        },
        id = If[
          AssociationQ[assertion] &&
            StringQ[Lookup[assertion, "id", None]] &&
            StringLength[StringTrim[Lookup[assertion, "id", ""]]] > 0,
          Lookup[assertion, "id", ""],
          "assertion_" <> ToString[First[position]]
        ];
        passedValue = If[AssociationQ[assertion], Lookup[assertion, "passed", Missing["NotAvailable"]], Missing["NotAvailable"]];
        valid = AssociationQ[assertion] &&
          StringQ[Lookup[assertion, "id", None]] &&
          StringLength[StringTrim[Lookup[assertion, "id", ""]]] > 0 &&
          MemberQ[{True, False}, passedValue];

        hasResidual = AssociationQ[assertion] && KeyExistsQ[assertion, "residual"];
        hasTolerance = AssociationQ[assertion] && KeyExistsQ[assertion, "tolerance"];
        residualConsistent = True;
        If[hasResidual || hasTolerance,
          valid = valid && hasResidual && hasTolerance;
          If[hasResidual && hasTolerance,
            residual = Lookup[assertion, "residual", Missing["NotAvailable"]];
            tolerance = Lookup[assertion, "tolerance", Missing["NotAvailable"]];
            valid = valid && HepCalcFiniteRealNumberQ[residual] && HepCalcFiniteRealNumberQ[tolerance] &&
              TrueQ[residual >= 0] && TrueQ[tolerance >= 0];
            If[valid,
              residualConsistent = TrueQ[passedValue === TrueQ[residual <= tolerance]];
              valid = valid && residualConsistent;
            ];
          ];
        ];

        <|
          "id" -> id,
          "valid" -> TrueQ[valid],
          "passed" -> TrueQ[valid] && TrueQ[passedValue]
        |>
      ]
    ],
    assertions
  ];

  total = Length[evaluated];
  If[TrueQ[requireNonempty] && total == 0,
    Return[<|
      "contract_valid" -> False,
      "total" -> 1,
      "pass" -> 0,
      "fail" -> 1,
      "invalid" -> 1,
      "failed_ids" -> {"bound_symbolic_assertions_required"}
    |>]
  ];
  duplicateIDs = First /@ Select[
    Tally[Lookup[evaluated, "id", {}]],
    Last[#] > 1 &
  ];
  If[Length[duplicateIDs] > 0,
    evaluated = Map[
      If[
        MemberQ[duplicateIDs, Lookup[#, "id", ""]],
        Join[#, <|"valid" -> False, "passed" -> False|>],
        #
      ] &,
      evaluated
    ];
  ];
  passed = Count[Lookup[evaluated, "passed", False], True];
  failed = total - passed;
  invalid = Count[Lookup[evaluated, "valid", False], False];
  failedIDs = DeleteDuplicates@Lookup[
    Select[evaluated, ! TrueQ[Lookup[#, "passed", False]] &],
    "id",
    {}
  ];

  <|
    "contract_valid" -> TrueQ[invalid == 0],
    "total" -> total,
    "pass" -> passed,
    "fail" -> failed,
    "invalid" -> invalid,
    "failed_ids" -> failedIDs
  |>
];

HepCalcExportSymbolic[data_] := Module[{out, enriched},
  enriched = data;
  If[
    AssociationQ[data] && ListQ[$HepCalcBoundInputConsumption] && Length[$HepCalcBoundInputConsumption] > 0,
    enriched = Join[
      data,
      <|"bound_inputs_consumed" -> $HepCalcBoundInputConsumption|>
    ]
  ];
  out = <|
    "schema_version" -> 1,
    "generated_at" -> DateString[Now, "ISODateTime"],
    "data" -> enriched
  |>;
  HepCalcWriteJSON[FileNameJoin[{$HepCalcOutDir, "symbolic", "symbolic.json"}], out];
];

HepCalcBoundInputText[id_String] := Module[{text, witness, consumedIDs},
  text = Lookup[$HepCalcBoundInputTexts, id, $Failed];
  witness = Lookup[$HepCalcBoundInputWitnesses, id, $Failed];
  If[text === $Failed || ! AssociationQ[witness], Return[$Failed]];
  consumedIDs = Lookup[$HepCalcBoundInputConsumption, "id", {}];
  If[! MemberQ[consumedIDs, id], AppendTo[$HepCalcBoundInputConsumption, witness]];
  text
];

HepCalcDecodeSecureBytes[payload_Association] := Quiet@Check[
  FromCharacterCode[Normal[BaseDecode[Lookup[payload, "base64", ""]]], "UTF8"],
  $Failed
];

HepCalcSecureReadBoundInput[path_String, expected_Association] := Module[{proc, payload, text},
  proc = Quiet@Check[
    RunProcess[
      {"python3", $HepCalcValidatorPath, "--stage", "secure_read", "--path", path},
      All
    ],
    $Failed
  ];
  If[proc === $Failed || Lookup[proc, "ExitCode", 1] =!= 0, Return[$Failed]];
  payload = Quiet@Check[ImportString[Lookup[proc, "StandardOutput", ""], "RawJSON"], $Failed];
  If[
    ! AssociationQ[payload] || Lookup[payload, "status", "ERROR"] =!= "PASS" ||
      Lookup[payload, "bytes", Missing["NotAvailable"]] =!= Lookup[expected, "bytes", Missing["Expected"]] ||
      Lookup[payload, "sha256", Missing["NotAvailable"]] =!= Lookup[expected, "sha256", Missing["Expected"]],
    Return[$Failed]
  ];
  text = HepCalcDecodeSecureBytes[payload];
  If[StringQ[text], text, $Failed]
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
$HepCalcBoundInputs = <||>;
$HepCalcBoundInputTexts = <||>;
$HepCalcBoundInputWitnesses = <||>;
$HepCalcBoundInputConsumption = {};
$HepCalcValidatorPath = Environment["HEP_CALC_POSTCONDITION_VALIDATOR"];
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
boundInputConfig = Lookup[Lookup[job, "mathematica", <||>], "bound_inputs", {}];

If[! ListQ[boundInputConfig],
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Bound symbolic input configuration is invalid."}|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "ERROR",
      "reason" -> "bound_symbolic_input_config_invalid",
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  Quit[23];
];

faFcEnabled = TrueQ[Lookup[job, "enable_fa_fc", False]] || KeyExistsQ[job, "feynarts_formcalc_spec"] && (job["feynarts_formcalc_spec"] =!= Null);
If[faFcEnabled,
  HepCalcAddRisk["FeynArts→FormCalc pipeline is enabled by job, but default runner is a scaffold; provide a custom entry/spec script for actual physics processes."];
];

If[entry === None || entry === "" || entry === Null,
  If[Length[boundInputConfig] > 0,
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Bound symbolic inputs require a Mathematica entry."}|>];
    HepCalcWriteStatus[
      FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_input_entry_required",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"],
        "risks" -> $HepCalcRisks
      |>
    ];
    Quit[29];
  ];
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

symPath = FileNameJoin[{$HepCalcOutDir, "symbolic", "symbolic.json"}];
statusPath = FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}];

(* A direct invocation may reuse an output directory.  Remove both acceptance
   surfaces before Get so only output produced by this entry can pass. *)
Do[
  If[FileExistsQ[path], Quiet@Check[DeleteFile[path], Null]],
  {path, {symPath, statusPath}}
];
If[FileExistsQ[symPath] || FileExistsQ[statusPath],
  Print["ERROR: could not invalidate stale symbolic acceptance output"];
  Quit[19];
];

If[Length[boundInputConfig] > 0,
  If[! StringQ[$HepCalcValidatorPath] || StringLength[$HepCalcValidatorPath] == 0,
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Secure bound-input validator is unavailable."}|>];
    HepCalcWriteStatus[
      statusPath,
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_input_validator_unavailable",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>
    ];
    Quit[24];
  ];
  boundInputBindProcess = Quiet@Check[
    RunProcess[
      {
        "python3", $HepCalcValidatorPath, "--stage", "bind_symbolic_inputs",
        "--job", jobPath, "--out", $HepCalcOutDir
      },
      All
    ],
    $Failed
  ];
  If[
    boundInputBindProcess === $Failed || Lookup[boundInputBindProcess, "ExitCode", 1] =!= 0,
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Required bound symbolic inputs could not be prepared."}|>];
    HepCalcWriteStatus[
      statusPath,
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_input_binding_failed",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>
    ];
    Quit[25];
  ];
  boundInputRecord = Quiet@Check[
    Import[FileNameJoin[{$HepCalcOutDir, "symbolic", "input_bindings.json"}], "RawJSON"],
    $Failed
  ];
  If[
    ! AssociationQ[boundInputRecord] || Lookup[boundInputRecord, "status", "ERROR"] =!= "PASS" ||
      ! ListQ[Lookup[boundInputRecord, "bindings", Missing["NotAvailable"]]],
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Required bound symbolic inputs are unavailable."}|>];
    HepCalcWriteStatus[
      statusPath,
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_inputs_unavailable",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>
    ];
    Quit[26];
  ];
  boundInputRows = Lookup[boundInputRecord, "bindings", {}];
  $HepCalcBoundInputs = Association@Map[
    Function[row,
      Lookup[row, "id", ""] -> FileNameJoin[{$HepCalcOutDir, Lookup[row, "snapshot_path", ""]}]
    ],
    boundInputRows
  ];
  If[
    Length[$HepCalcBoundInputs] =!= Length[boundInputConfig] ||
      AnyTrue[Values[$HepCalcBoundInputs], ! FileExistsQ[#] &],
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"A required bound symbolic input snapshot is unavailable."}|>];
    HepCalcWriteStatus[
      statusPath,
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_input_snapshot_unavailable",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>
    ];
    Quit[27];
  ];
  boundInputTexts = Map[
    Function[row,
      Module[{id, path, text},
        id = Lookup[row, "id", ""];
        path = FileNameJoin[{$HepCalcOutDir, Lookup[row, "snapshot_path", ""]}];
        text = HepCalcSecureReadBoundInput[path, Lookup[row, "snapshot", <||>]];
        id -> text
      ]
    ],
    boundInputRows
  ];
  If[AnyTrue[Last /@ boundInputTexts, # === $Failed &],
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"A bound symbolic input failed secure consumption."}|>];
    HepCalcWriteStatus[
      statusPath,
      <|
        "stage" -> "mathematica_symbolic",
        "status" -> "ERROR",
        "reason" -> "bound_symbolic_input_secure_read_failed",
        "started_at" -> startedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>
    ];
    Quit[28];
  ];
  $HepCalcBoundInputTexts = Association[boundInputTexts];
  $HepCalcBoundInputWitnesses = Association@Map[
    Lookup[#, "id", ""] ->
    <|
      "id" -> Lookup[#, "id", ""],
      "bytes" -> Lookup[Lookup[#, "snapshot", <||>], "bytes", Null],
      "sha256" -> Lookup[Lookup[#, "snapshot", <||>], "sha256", Null]
    |> &,
    boundInputRows
  ];
];

(* Run entry *)
entryResult = Quiet@Check[Get[entryToRun], $Failed];
runOK = entryResult =!= $Failed && entryResult =!= $Aborted;

If[! runOK,
  If[! FileExistsQ[symPath],
    HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Entry execution failed before exporting symbolic output."}|>];
  ];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "ERROR",
      "reason" -> If[entryResult === $Aborted, "entry_execution_aborted", "entry_execution_failed"],
      "entry" -> entry,
      "entry_used" -> entryToRun,
      "snapshot" -> snapshotPath,
      "bound_inputs_consumed" -> $HepCalcBoundInputConsumption,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[20];
];

If[! FileExistsQ[symPath],
  HepCalcExportSymbolic[<|"tasks" -> {}, "notes" -> {"Entry completed without exporting the required symbolic output."}|>];
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "ERROR",
      "reason" -> "missing_required_symbolic_output",
      "entry" -> entry,
      "entry_used" -> entryToRun,
      "snapshot" -> snapshotPath,
      "bound_inputs_consumed" -> $HepCalcBoundInputConsumption,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[22];
];

assertionSummary = HepCalcEvaluateAssertions[symPath, Length[boundInputConfig] > 0];

If[! TrueQ[Lookup[assertionSummary, "contract_valid", False]] || Lookup[assertionSummary, "fail", 0] > 0,
  HepCalcWriteStatus[
    FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
    <|
      "stage" -> "mathematica_symbolic",
      "status" -> "FAIL",
      "reason" -> If[
        TrueQ[Lookup[assertionSummary, "contract_valid", False]],
        "symbolic_assertions_failed",
        "invalid_symbolic_assertions_contract"
      ],
      "entry" -> entry,
      "entry_used" -> entryToRun,
      "snapshot" -> snapshotPath,
      "bound_inputs_consumed" -> $HepCalcBoundInputConsumption,
      "assertions" -> assertionSummary,
      "started_at" -> startedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "risks" -> $HepCalcRisks
    |>
  ];
  Quit[21];
];

HepCalcWriteStatus[
  FileNameJoin[{$HepCalcOutDir, "symbolic", "status.json"}],
  <|
    "stage" -> "mathematica_symbolic",
    "status" -> "PASS",
    "entry" -> entry,
    "entry_used" -> entryToRun,
    "snapshot" -> snapshotPath,
    "bound_inputs_consumed" -> $HepCalcBoundInputConsumption,
    "assertions" -> assertionSummary,
    "started_at" -> startedAt,
    "ended_at" -> DateString[Now, "ISODateTime"],
    "risks" -> $HepCalcRisks
  |>
];

Quit[0];
