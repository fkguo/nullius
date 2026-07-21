(* run_formcalc_reducer.wls

   Fresh-kernel FormCalc reducer:
   HEP_CALC_POSTCONDITION_VALIDATOR=<validator.py> wolframscript -noprompt -file run_formcalc_reducer.wls -- <job.snapshot.json> <out_dir> <job_bytes> <job_sha256>

   The FeynRules/FeynArts producer must have written a current-run
   auto_qft/producer_status.json and auto_qft/amplitude/amps_raw.m.
*)

ClearAll[
  HepCalcNormalizeForJSON,
  HepCalcWriteJSON,
  HepCalcReadJSON,
  HepCalcSecureRead,
  HepCalcDecodeSecureBytes,
  HepCalcPublishSnapshot,
  HepCalcFileHash,
  HepCalcVerifyInputChain,
  HepCalcReducerFail
];

HepCalcNormalizeForJSON[x_Association] := Map[HepCalcNormalizeForJSON, x];
HepCalcNormalizeForJSON[x_List] := HepCalcNormalizeForJSON /@ x;
HepCalcNormalizeForJSON[x_Rule] := Module[{k = First[x]},
  If[
    StringQ[k],
    k -> HepCalcNormalizeForJSON[Last[x]],
    ToString[k, InputForm] -> HepCalcNormalizeForJSON[Last[x]]
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

HepCalcSecureRead[path_String] := Module[{proc, payload},
  proc = Quiet@Check[
    RunProcess[
      {"python3", $HepCalcValidatorPath, "--stage", "secure_read", "--path", path},
      All
    ],
    $Failed
  ];
  If[proc === $Failed || Lookup[proc, "ExitCode", 1] =!= 0, Return[$Failed]];
  payload = Quiet@Check[ImportString[Lookup[proc, "StandardOutput", ""], "RawJSON"], $Failed];
  If[! AssociationQ[payload] || Lookup[payload, "status", "ERROR"] =!= "PASS", $Failed, payload]
];

HepCalcDecodeSecureBytes[payload_Association] := Quiet@Check[
  FromCharacterCode[Normal[BaseDecode[Lookup[payload, "base64", ""]]], "UTF8"],
  $Failed
];

HepCalcReadJSON[path_String] := Module[{payload, text},
  payload = HepCalcSecureRead[path];
  If[! AssociationQ[payload], Return[$Failed]];
  text = HepCalcDecodeSecureBytes[payload];
  If[! StringQ[text], Return[$Failed]];
  Quiet@Check[ImportString[text, "RawJSON"], $Failed]
];

HepCalcFileHash[path_String] := Module[{payload = HepCalcSecureRead[path]},
  If[AssociationQ[payload], Lookup[payload, "sha256", Null], Null]
];

HepCalcPublishSnapshot[] := Module[{proc, payload},
  proc = Quiet@Check[
    RunProcess[
      {
        "python3", $HepCalcValidatorPath,
        "--stage", "publish_snapshot",
        "--source", $HepCalcAmpsRawPath,
        "--destination", $HepCalcInputSnapshotPath,
        "--expected-bytes", ToString[$HepCalcRawBytes],
        "--expected-sha256", $HepCalcRawSHA
      },
      All
    ],
    $Failed
  ];
  If[proc === $Failed || Lookup[proc, "ExitCode", 1] =!= 0, Return[$Failed]];
  payload = Quiet@Check[ImportString[Lookup[proc, "StandardOutput", ""], "RawJSON"], $Failed];
  If[AssociationQ[payload] && Lookup[payload, "status", "ERROR"] === "PASS", payload, $Failed]
];

HepCalcVerifyInputChain[phase_String] := Module[
  {
    producerNow,
    handoffNow,
    producerAmpNow = <||>,
    rawPayload,
    snapshotPayload,
    rawBytesNow = Null,
    rawSHANow = Null,
    snapshotBytesNow = Null,
    snapshotSHANow = Null,
    errors = {}
  },
  producerNow = HepCalcReadJSON[$HepCalcProducerStatusPath];
  handoffNow = HepCalcReadJSON[$HepCalcFormCalcHandoffPath];

  If[! AssociationQ[producerNow],
    AppendTo[errors, "producer_status_unreadable"],
    If[Lookup[producerNow, "stage", ""] =!= "auto_qft_feynarts_producer", AppendTo[errors, "producer_stage_mismatch"]];
    If[Lookup[producerNow, "status", ""] =!= "PASS", AppendTo[errors, "producer_status_not_pass"]];
    If[Lookup[producerNow, "token", Null] =!= $HepCalcProducerToken, AppendTo[errors, "producer_token_mismatch"]];
    If[Lookup[producerNow, "handoff", ""] =!= $HepCalcHandoffRelativePath, AppendTo[errors, "producer_handoff_path_mismatch"]];
    producerAmpNow = Lookup[producerNow, "amplitude", <||>];
    If[! AssociationQ[producerAmpNow],
      AppendTo[errors, "producer_amplitude_witness_missing"],
      If[Lookup[producerAmpNow, "path", ""] =!= $HepCalcRawRelativePath, AppendTo[errors, "producer_raw_path_mismatch"]];
      If[Lookup[producerAmpNow, "bytes", Null] =!= $HepCalcRawBytes, AppendTo[errors, "producer_raw_bytes_mismatch"]];
      If[Lookup[producerAmpNow, "sha256", Null] =!= $HepCalcRawSHA, AppendTo[errors, "producer_raw_sha256_mismatch"]];
      If[Lookup[producerAmpNow, "amp_count", Null] =!= $HepCalcAmpCount, AppendTo[errors, "producer_amp_count_mismatch"]]
    ]
  ];

  If[! AssociationQ[handoffNow],
    AppendTo[errors, "handoff_unreadable"],
    If[Lookup[handoffNow, "stage", ""] =!= "auto_qft_formcalc_handoff", AppendTo[errors, "handoff_stage_mismatch"]];
    If[Lookup[handoffNow, "status", ""] =!= "PASS", AppendTo[errors, "handoff_status_not_pass"]];
    If[Lookup[handoffNow, "token", Null] =!= $HepCalcProducerToken, AppendTo[errors, "handoff_token_mismatch"]];
    If[Lookup[handoffNow, "raw_path", ""] =!= $HepCalcRawRelativePath, AppendTo[errors, "handoff_raw_path_mismatch"]];
    If[Lookup[handoffNow, "raw_bytes", Null] =!= $HepCalcRawBytes, AppendTo[errors, "handoff_raw_bytes_mismatch"]];
    If[Lookup[handoffNow, "raw_sha256", Null] =!= $HepCalcRawSHA, AppendTo[errors, "handoff_raw_sha256_mismatch"]];
    If[Lookup[handoffNow, "amp_count", Null] =!= $HepCalcAmpCount, AppendTo[errors, "handoff_amp_count_mismatch"]];
    If[Lookup[handoffNow, "pave_reduce", ""] =!= $HepCalcPaveReduce, AppendTo[errors, "handoff_pave_reduce_mismatch"]];
    If[Lookup[handoffNow, "memory_limit_mb", Null] =!= $HepCalcMemoryLimitMB, AppendTo[errors, "handoff_memory_limit_mismatch"]]
  ];

  rawPayload = HepCalcSecureRead[$HepCalcAmpsRawPath];
  If[AssociationQ[rawPayload],
    rawBytesNow = Lookup[rawPayload, "bytes", Null];
    rawSHANow = Lookup[rawPayload, "sha256", Null]
  ];
  If[! AssociationQ[rawPayload] || rawBytesNow =!= $HepCalcRawBytes || rawSHANow =!= $HepCalcRawSHA,
    AppendTo[errors, "current_raw_witness_mismatch"]
  ];

  snapshotPayload = HepCalcSecureRead[$HepCalcInputSnapshotPath];
  If[AssociationQ[snapshotPayload],
    snapshotBytesNow = Lookup[snapshotPayload, "bytes", Null];
    snapshotSHANow = Lookup[snapshotPayload, "sha256", Null]
  ];
  If[
    ! AssociationQ[snapshotPayload] ||
      snapshotBytesNow =!= $HepCalcRawBytes ||
      snapshotSHANow =!= $HepCalcRawSHA,
    AppendTo[errors, "input_snapshot_witness_mismatch"]
  ];

  If[
    Length[errors] == 0,
    <|
      "status" -> "PASS",
      "phase" -> phase,
      "producer_token" -> $HepCalcProducerToken,
      "input" -> <|
        "token" -> $HepCalcProducerToken,
        "path" -> $HepCalcRawRelativePath,
        "bytes" -> $HepCalcRawBytes,
        "sha256" -> $HepCalcRawSHA
      |>,
      "snapshot" -> <|
        "token" -> $HepCalcProducerToken,
        "path" -> $HepCalcSnapshotRelativePath,
        "source_path" -> $HepCalcRawRelativePath,
        "bytes" -> $HepCalcRawBytes,
        "sha256" -> $HepCalcRawSHA
      |>
    |>,
    <|"status" -> "ERROR", "reason" -> "formcalc_input_chain_mismatch", "phase" -> phase, "errors" -> DeleteDuplicates[errors]|>
  ]
];

HepCalcReducerFail[reason_String, extra_Association : <||>, exitCode_Integer : 1] := Module[
  {endedAt, formStatus, summary, options, formcalcOption, topStatus},
  endedAt = DateString[Now, "ISODateTime"];
  Print["[hep-calc-formcalc] ERROR reason=", reason];

  If[FileExistsQ[$HepCalcAmplitudeOutPath], Quiet@Check[DeleteFile[$HepCalcAmplitudeOutPath], Null]];
  If[FileExistsQ[$HepCalcAmplitudeTmpPath], Quiet@Check[DeleteFile[$HepCalcAmplitudeTmpPath], Null]];
  If[FileExistsQ[$HepCalcInputSnapshotTmpPath], Quiet@Check[DeleteFile[$HepCalcInputSnapshotTmpPath], Null]];

  formStatus = Join[
    <|
      "stage" -> "auto_qft_formcalc_reducer",
      "status" -> "ERROR",
      "reason" -> reason,
      "started_at" -> $HepCalcReducerStartedAt,
      "ended_at" -> endedAt,
      "memory_limit_mb" -> $HepCalcMemoryLimitMB
    |>,
    extra
  ];
  HepCalcWriteJSON[$HepCalcFormCalcStatusPath, formStatus];

  summary = HepCalcReadJSON[$HepCalcSummaryPath];
  If[! AssociationQ[summary], summary = <||>];
  options = Lookup[summary, "options", <||>];
  If[! AssociationQ[options], options = <||>];
  formcalcOption = <|
    "enable" -> True,
    "status" -> "ERROR",
    "reason" -> reason,
    "pave_reduce" -> $HepCalcPaveReduce,
    "memory_limit_mb" -> $HepCalcMemoryLimitMB,
    "reducer_status" -> "auto_qft/formcalc/status.json"
  |>;
  options = Join[options, <|"formcalc" -> formcalcOption|>];
  summary = Join[
    summary,
    <|
      "ts" -> endedAt,
      "status" -> "ERROR",
      "reason" -> "formcalc_failed",
      "options" -> options,
      "formcalc_diagnostics" -> extra
    |>
  ];
  HepCalcWriteJSON[$HepCalcSummaryPath, summary];

  topStatus = <|
    "stage" -> "auto_qft_one_loop",
    "status" -> "ERROR",
    "reason" -> "formcalc_failed",
    "started_at" -> $HepCalcProducerStartedAt,
    "ended_at" -> endedAt,
    "amplitude_level" -> "feynarts",
    "formcalc" -> <|
      "status" -> "ERROR",
      "reason" -> reason,
      "reducer_status" -> "auto_qft/formcalc/status.json"
    |>,
    "disclaimer" -> "FormCalc reduction failed; no reduced amplitude is accepted."
  |>;
  HepCalcWriteJSON[$HepCalcStatusPath, topStatus];
  Quit[exitCode];
];

$HistoryLength = 0;
args = Rest[$ScriptCommandLine];
If[Length[args] < 4,
  Print["ERROR: expected args: <job.snapshot.json> <out_dir> <job_bytes> <job_sha256>"];
  Quit[2];
];

jobPath = args[[1]];
$HepCalcOutDir = args[[2]];
$HepCalcValidatorPath = Environment["HEP_CALC_POSTCONDITION_VALIDATOR"];
If[! StringQ[$HepCalcValidatorPath] || StringTrim[$HepCalcValidatorPath] === "",
  Print["ERROR: HEP_CALC_POSTCONDITION_VALIDATOR is required"];
  Quit[2]
];
If[! StringMatchQ[args[[3]], DigitCharacter ..],
  Print["ERROR: invalid expected job byte count"];
  Quit[2]
];
$HepCalcJobBytes = ToExpression[args[[3]]];
$HepCalcJobSHA = ToLowerCase[args[[4]]];
If[
  ! IntegerQ[$HepCalcJobBytes] || $HepCalcJobBytes <= 0 ||
    ! StringMatchQ[$HepCalcJobSHA, RegularExpression["[0-9a-f]{64}"]],
  Print["ERROR: invalid expected job witness"];
  Quit[2]
];
$HepCalcJobRelativePath = "auto_qft/formcalc/job_snapshot.json";
$HepCalcReducerStartedAt = DateString[Now, "ISODateTime"];
autoDir = FileNameJoin[{$HepCalcOutDir, "auto_qft"}];
ampDir = FileNameJoin[{autoDir, "amplitude"}];
$HepCalcStatusPath = FileNameJoin[{autoDir, "status.json"}];
$HepCalcSummaryPath = FileNameJoin[{autoDir, "summary.json"}];
$HepCalcProducerStatusPath = FileNameJoin[{autoDir, "producer_status.json"}];
$HepCalcFormCalcHandoffPath = FileNameJoin[{autoDir, "formcalc", "handoff.json"}];
$HepCalcFormCalcStatusPath = FileNameJoin[{autoDir, "formcalc", "status.json"}];
$HepCalcAmpsRawPath = FileNameJoin[{ampDir, "amps_raw.m"}];
$HepCalcInputSnapshotPath = FileNameJoin[{autoDir, "formcalc", "input_snapshot.m"}];
$HepCalcInputSnapshotTmpPath = FileNameJoin[{autoDir, "formcalc", ".input_snapshot.m.tmp"}];
$HepCalcAmplitudeOutPath = FileNameJoin[{ampDir, "amplitude_summed.m"}];
$HepCalcAmplitudeTmpPath = FileNameJoin[{ampDir, ".amplitude_summed.m.tmp"}];
$HepCalcRawRelativePath = "auto_qft/amplitude/amps_raw.m";
$HepCalcSnapshotRelativePath = "auto_qft/formcalc/input_snapshot.m";
$HepCalcHandoffRelativePath = "auto_qft/formcalc/handoff.json";
$HepCalcMemoryLimitMB = 2048;
$HepCalcPaveReduce = "LoopTools";
$HepCalcProducerStartedAt = Null;
$HepCalcProducerToken = Null;
$HepCalcRawBytes = Null;
$HepCalcRawSHA = Null;
$HepCalcAmpCount = Null;

If[! DirectoryQ[ampDir], CreateDirectory[ampDir, CreateIntermediateDirectories -> True]];
If[! DirectoryQ[DirectoryName[$HepCalcInputSnapshotPath]], CreateDirectory[DirectoryName[$HepCalcInputSnapshotPath], CreateIntermediateDirectories -> True]];
If[FileExistsQ[$HepCalcInputSnapshotPath], Quiet@Check[DeleteFile[$HepCalcInputSnapshotPath], Null]];
If[FileExistsQ[$HepCalcInputSnapshotTmpPath], Quiet@Check[DeleteFile[$HepCalcInputSnapshotTmpPath], Null]];

jobPayload = HepCalcSecureRead[jobPath];
If[
  ! AssociationQ[jobPayload] ||
    Lookup[jobPayload, "bytes", Null] =!= $HepCalcJobBytes ||
    Lookup[jobPayload, "sha256", Null] =!= $HepCalcJobSHA,
  HepCalcReducerFail[
    "job_resolved_binding_mismatch",
    <|"job_path" -> jobPath, "expected_bytes" -> $HepCalcJobBytes, "expected_sha256" -> $HepCalcJobSHA|>,
    3
  ]
];
jobText = HepCalcDecodeSecureBytes[jobPayload];
job = Quiet@Check[ImportString[jobText, "RawJSON"], $Failed];
If[! AssociationQ[job], HepCalcReducerFail["job_resolved_json_unreadable", <|"job_path" -> jobPath|>, 3]];
auto = Lookup[job, "auto_qft", <||>];
If[! AssociationQ[auto], HepCalcReducerFail["auto_qft_not_object", <||>, 4]];
fcCfg = Lookup[auto, "formcalc", <||>];
If[! AssociationQ[fcCfg], HepCalcReducerFail["auto_qft_formcalc_not_object", <||>, 5]];
If[! TrueQ[Lookup[fcCfg, "enable", False]], HepCalcReducerFail["formcalc_not_requested", <||>, 6]];

$HepCalcPaveReduce = ToString[Lookup[fcCfg, "pave_reduce", "LoopTools"]];
If[! MemberQ[{"LoopTools", "False"}, $HepCalcPaveReduce],
  HepCalcReducerFail["invalid_formcalc_pave_reduce", <|"pave_reduce" -> $HepCalcPaveReduce|>, 7]
];
$HepCalcMemoryLimitMB = Lookup[fcCfg, "memory_limit_mb", 2048];
If[! IntegerQ[$HepCalcMemoryLimitMB] || $HepCalcMemoryLimitMB <= 0,
  HepCalcReducerFail["invalid_formcalc_memory_limit_mb", <|"memory_limit_mb" -> $HepCalcMemoryLimitMB|>, 8]
];
memoryLimitBytes = $HepCalcMemoryLimitMB*1024*1024;

producerStatus = HepCalcReadJSON[$HepCalcProducerStatusPath];
If[
  ! AssociationQ[producerStatus] ||
    Lookup[producerStatus, "stage", ""] =!= "auto_qft_feynarts_producer" ||
    Lookup[producerStatus, "status", ""] =!= "PASS",
  HepCalcReducerFail[
    "feynarts_producer_not_pass",
    <|"producer_status_path" -> $HepCalcProducerStatusPath|>,
    9
  ]
];
$HepCalcProducerStartedAt = Lookup[producerStatus, "started_at", Null];
$HepCalcProducerToken = Lookup[producerStatus, "token", Null];

handoff = HepCalcReadJSON[$HepCalcFormCalcHandoffPath];
If[
  ! AssociationQ[handoff] ||
    Lookup[handoff, "stage", ""] =!= "auto_qft_formcalc_handoff" ||
    Lookup[handoff, "status", ""] =!= "PASS",
  HepCalcReducerFail[
    "formcalc_handoff_not_pass",
    <|"handoff_path" -> $HepCalcFormCalcHandoffPath|>,
    10
  ]
];
If[
  ! StringQ[$HepCalcProducerToken] ||
    Lookup[handoff, "token", Null] =!= $HepCalcProducerToken,
  HepCalcReducerFail[
    "formcalc_handoff_token_mismatch",
    <|"producer_token" -> $HepCalcProducerToken, "handoff_token" -> Lookup[handoff, "token", Null]|>,
    11
  ]
];
If[
  Lookup[producerStatus, "handoff", ""] =!= $HepCalcHandoffRelativePath ||
    Lookup[handoff, "raw_path", ""] =!= $HepCalcRawRelativePath ||
    Lookup[handoff, "pave_reduce", ""] =!= $HepCalcPaveReduce ||
    Lookup[handoff, "memory_limit_mb", Null] =!= $HepCalcMemoryLimitMB,
  HepCalcReducerFail[
    "formcalc_handoff_configuration_mismatch",
    <|
      "raw_path" -> Lookup[handoff, "raw_path", Null],
      "pave_reduce" -> Lookup[handoff, "pave_reduce", Null],
      "memory_limit_mb" -> Lookup[handoff, "memory_limit_mb", Null]
    |>,
    12
  ]
];

rawPayloadBefore = HepCalcSecureRead[$HepCalcAmpsRawPath];
If[! AssociationQ[rawPayloadBefore] || Lookup[rawPayloadBefore, "bytes", 0] <= 0,
  HepCalcReducerFail[
    "feynarts_amplitude_missing_or_empty",
    <|"amps_raw" -> $HepCalcAmpsRawPath|>,
    13
  ]
];
rawBytesBefore = Lookup[rawPayloadBefore, "bytes", Null];
rawSHABefore = Lookup[rawPayloadBefore, "sha256", Null];
producerAmp = Lookup[producerStatus, "amplitude", <||>];
If[
  ! AssociationQ[producerAmp] ||
    ! StringQ[rawSHABefore] ||
    StringLength[rawSHABefore] =!= 64 ||
    Lookup[producerAmp, "path", ""] =!= $HepCalcRawRelativePath ||
    Lookup[producerAmp, "bytes", Null] =!= rawBytesBefore ||
    Lookup[producerAmp, "sha256", Null] =!= rawSHABefore ||
    Lookup[handoff, "raw_bytes", Null] =!= rawBytesBefore ||
    Lookup[handoff, "raw_sha256", Null] =!= rawSHABefore ||
    ! IntegerQ[Lookup[producerAmp, "amp_count", Null]] ||
    Lookup[producerAmp, "amp_count", 0] <= 0 ||
    Lookup[handoff, "amp_count", Null] =!= Lookup[producerAmp, "amp_count", Null],
  HepCalcReducerFail[
    "formcalc_handoff_amplitude_mismatch",
    <|
      "observed_bytes" -> rawBytesBefore,
      "observed_sha256" -> rawSHABefore,
      "producer_amplitude" -> producerAmp,
      "handoff_raw_bytes" -> Lookup[handoff, "raw_bytes", Null],
      "handoff_raw_sha256" -> Lookup[handoff, "raw_sha256", Null]
    |>,
    14
  ]
];

$HepCalcRawBytes = rawBytesBefore;
$HepCalcRawSHA = rawSHABefore;
$HepCalcAmpCount = Lookup[producerAmp, "amp_count", Null];

If[FileExistsQ[$HepCalcInputSnapshotPath] || FileExistsQ[$HepCalcInputSnapshotTmpPath],
  HepCalcReducerFail[
    "formcalc_input_snapshot_invalidation_failed",
    <|
      "snapshot_path" -> $HepCalcInputSnapshotPath,
      "snapshot_tmp_path" -> $HepCalcInputSnapshotTmpPath
    |>,
    21
  ]
];
snapshotPublishResult = HepCalcPublishSnapshot[];
If[! AssociationQ[snapshotPublishResult],
  HepCalcReducerFail["formcalc_input_snapshot_publish_failed", <||>, 24]
];
chainAfterSnapshot = HepCalcVerifyInputChain["after_snapshot_publish"];
If[Lookup[chainAfterSnapshot, "status", "ERROR"] =!= "PASS",
  HepCalcReducerFail[
    "formcalc_input_chain_mismatch_after_snapshot_publish",
    <|"input_chain" -> chainAfterSnapshot|>,
    25
  ]
];

Print["[hep-calc-formcalc] reducer_start=", $HepCalcReducerStartedAt];
Print["[hep-calc-formcalc] system_id=", $SystemID];
Print["[hep-calc-formcalc] memory_limit_mb=", $HepCalcMemoryLimitMB];
Print["[hep-calc-formcalc] amps_raw=", $HepCalcAmpsRawPath];
Print["[hep-calc-formcalc] input_snapshot=", $HepCalcInputSnapshotPath];
feynArtsFile = Quiet@Check[FindFile["FeynArts`"], $Failed];
formCalcFile = Quiet@Check[FindFile["FormCalc`"], $Failed];
Print["[hep-calc-formcalc] feynarts_file=", InputForm[feynArtsFile]];
Print["[hep-calc-formcalc] formcalc_file=", InputForm[formCalcFile]];

reducerResult = MemoryConstrained[
  Module[{faLoad, fcLoad, amps, heldAmps, snapshotPayloadForReduction, snapshotText, ampCount, calc, paveValue, savedContext, savedContextPath, chainCheck},
    Print["[hep-calc-formcalc] phase=feynarts_load begin"];
    savedContext = $Context;
    savedContextPath = $ContextPath;
    faLoad = CheckAbort[
      Check[Needs["FeynArts`"]; "PASS", "FAILED"],
      "ABORTED"
    ];
    If[faLoad =!= "PASS",
      $Context = savedContext;
      $ContextPath = savedContextPath;
    ];
    Print["[hep-calc-formcalc] phase=feynarts_load outcome=", faLoad];
    If[faLoad === "ABORTED", Return[<|"status" -> "ERROR", "reason" -> "feynarts_load_aborted", "phase" -> "feynarts_load"|>]];
    If[faLoad =!= "PASS", Return[<|"status" -> "ERROR", "reason" -> "feynarts_load_failed", "phase" -> "feynarts_load"|>]];

    Print["[hep-calc-formcalc] phase=formcalc_load begin"];
    savedContext = $Context;
    savedContextPath = $ContextPath;
    fcLoad = CheckAbort[
      Check[Needs["FormCalc`"]; "PASS", "FAILED"],
      "ABORTED"
    ];
    If[fcLoad =!= "PASS",
      $Context = savedContext;
      $ContextPath = savedContextPath;
    ];
    Print["[hep-calc-formcalc] phase=formcalc_load outcome=", fcLoad];
    If[fcLoad === "ABORTED", Return[<|"status" -> "ERROR", "reason" -> "formcalc_load_aborted", "phase" -> "formcalc_load"|>]];
    If[fcLoad =!= "PASS", Return[<|"status" -> "ERROR", "reason" -> "formcalc_load_failed", "phase" -> "formcalc_load"|>]];

    Print["[hep-calc-formcalc] phase=amplitude_read begin"];
    snapshotPayloadForReduction = HepCalcSecureRead[$HepCalcInputSnapshotPath];
    If[
      ! AssociationQ[snapshotPayloadForReduction] ||
        Lookup[snapshotPayloadForReduction, "bytes", Null] =!= $HepCalcRawBytes ||
        Lookup[snapshotPayloadForReduction, "sha256", Null] =!= $HepCalcRawSHA,
      Return[<|"status" -> "ERROR", "reason" -> "feynarts_amplitude_secure_read_mismatch", "phase" -> "amplitude_read"|>]
    ];
    snapshotText = HepCalcDecodeSecureBytes[snapshotPayloadForReduction];
    If[! StringQ[snapshotText],
      Return[<|"status" -> "ERROR", "reason" -> "feynarts_amplitude_decode_failed", "phase" -> "amplitude_read"|>]
    ];
    heldAmps = CheckAbort[Check[ToExpression[snapshotText, InputForm, HoldComplete], $Failed], $Aborted];
    amps = If[MatchQ[heldAmps, HoldComplete[_]], ReleaseHold[heldAmps], heldAmps];
    If[amps === $Aborted, Return[<|"status" -> "ERROR", "reason" -> "feynarts_amplitude_read_aborted", "phase" -> "amplitude_read"|>]];
    If[amps === $Failed, Return[<|"status" -> "ERROR", "reason" -> "feynarts_amplitude_read_failed", "phase" -> "amplitude_read"|>]];
    chainCheck = HepCalcVerifyInputChain["after_snapshot_read"];
    If[Lookup[chainCheck, "status", "ERROR"] =!= "PASS",
      Return[
        <|
          "status" -> "ERROR",
          "reason" -> "formcalc_input_chain_mismatch_after_snapshot_read",
          "phase" -> "amplitude_read",
          "input_chain" -> chainCheck
        |>
      ]
    ];
    If[Head[Head[amps]] =!= FeynArts`FeynAmpList,
      Return[<|"status" -> "ERROR", "reason" -> "feynarts_amplitude_wrong_head", "phase" -> "amplitude_read", "head" -> ToString[Head[Head[amps]], InputForm]|>]
    ];
    ampCount = Length[Cases[amps, FeynArts`FeynAmp[__], Infinity]];
    If[
      ampCount <= 0 ||
        $HepCalcAmpCount =!= ampCount,
      Return[
        <|
          "status" -> "ERROR",
          "reason" -> "feynarts_amplitude_count_mismatch",
          "phase" -> "amplitude_read",
          "observed_amp_count" -> ampCount,
          "expected_amp_count" -> $HepCalcAmpCount
        |>
      ]
    ];
    Print["[hep-calc-formcalc] phase=amplitude_read outcome=PASS"];

    If[
      Length[DownValues[FormCalc`CalcFeynAmp]] == 0 ||
        ! MemberQ[First /@ Options[FormCalc`CalcFeynAmp], FormCalc`PaVeReduce],
      Return[<|"status" -> "ERROR", "reason" -> "formcalc_api_unavailable", "phase" -> "formcalc_reduce"|>]
    ];
    paveValue = If[$HepCalcPaveReduce === "LoopTools", FormCalc`LoopTools, False];
    Print["[hep-calc-formcalc] phase=formcalc_reduce begin pave_reduce=", $HepCalcPaveReduce];
    calc = CheckAbort[
      Check[
        FormCalc`CalcFeynAmp[
          amps,
          FormCalc`PaVeReduce -> paveValue
        ],
        $Failed
      ],
      $Aborted
    ];
    If[calc === $Aborted, Return[<|"status" -> "ERROR", "reason" -> "formcalc_reduction_aborted", "phase" -> "formcalc_reduce"|>]];
    If[calc === $Failed, Return[<|"status" -> "ERROR", "reason" -> "formcalc_reduction_failed", "phase" -> "formcalc_reduce"|>]];
    If[! FreeQ[calc, FormCalc`CalcFeynAmp],
      Return[<|"status" -> "ERROR", "reason" -> "formcalc_reduction_unevaluated", "phase" -> "formcalc_reduce"|>]
    ];
    chainCheck = HepCalcVerifyInputChain["after_reduction"];
    If[Lookup[chainCheck, "status", "ERROR"] =!= "PASS",
      Return[
        <|
          "status" -> "ERROR",
          "reason" -> "formcalc_input_chain_mismatch_after_reduction",
          "phase" -> "formcalc_reduce",
          "input_chain" -> chainCheck
        |>
      ]
    ];
    Print["[hep-calc-formcalc] phase=formcalc_reduce outcome=PASS"];
    <|"status" -> "PASS", "reason" -> "", "phase" -> "complete", "amplitude" -> calc|>
  ],
  memoryLimitBytes,
  <|"status" -> "ERROR", "reason" -> "formcalc_memory_limit_exceeded", "phase" -> "memory_guard"|>
];

If[! AssociationQ[reducerResult],
  HepCalcReducerFail["formcalc_reducer_invalid_result", <|"result" -> ToString[reducerResult, InputForm]|>, 15]
];
If[Lookup[reducerResult, "status", "ERROR"] =!= "PASS",
  HepCalcReducerFail[
    ToString[Lookup[reducerResult, "reason", "formcalc_reducer_failed"]],
    KeyDrop[reducerResult, {"status", "reason", "amplitude"}],
    16
  ]
];

calcRes = Lookup[reducerResult, "amplitude", $Failed];
If[calcRes === $Failed || calcRes === $Aborted,
  HepCalcReducerFail["formcalc_reducer_missing_amplitude", <||>, 17]
];

Quiet@Check[Put[calcRes, $HepCalcAmplitudeTmpPath], $Failed];
If[! FileExistsQ[$HepCalcAmplitudeTmpPath] || FileByteCount[$HepCalcAmplitudeTmpPath] <= 0,
  HepCalcReducerFail["formcalc_amplitude_write_failed", <||>, 18]
];
If[FileExistsQ[$HepCalcAmplitudeOutPath], DeleteFile[$HepCalcAmplitudeOutPath]];
renameResult = Quiet@Check[RenameFile[$HepCalcAmplitudeTmpPath, $HepCalcAmplitudeOutPath], $Failed];
If[renameResult === $Failed || ! FileExistsQ[$HepCalcAmplitudeOutPath] || FileByteCount[$HepCalcAmplitudeOutPath] <= 0,
  HepCalcReducerFail["formcalc_amplitude_publish_failed", <||>, 19]
];

summary = HepCalcReadJSON[$HepCalcSummaryPath];
If[! AssociationQ[summary], HepCalcReducerFail["producer_summary_unreadable", <||>, 20]];
expCfg = Lookup[auto, "export", <||>];
If[! AssociationQ[expCfg], expCfg = <||>];
doAmpTeX = TrueQ[Lookup[expCfg, "amplitude_tex", False]];
doAmpMD = TrueQ[Lookup[expCfg, "amplitude_md", True]];

ampTexOut = "";
If[doAmpTeX,
  ampTexOut = FileNameJoin[{ampDir, "amplitude_summed.tex"}];
  Export[ampTexOut, ToString[TeXForm[calcRes]], "Text"];
];
ampMdOut = "";
If[doAmpMD,
  ampMdOut = FileNameJoin[{ampDir, "amplitude_summed.md"}];
  Export[
    ampMdOut,
    StringRiffle[
      {
        "# auto_qft amplitude (summed)",
        "",
        "- disclaimer: Amplitude is UNRENORMALIZED (UV poles may be present).",
        "- amplitude_level: formcalc",
        "- reducer: fresh Wolfram kernel",
        "- memory_limit_mb: " <> ToString[$HepCalcMemoryLimitMB],
        "",
        "## Wolfram Language InputForm",
        "",
        "```wl",
        ToString[calcRes, InputForm],
        "```",
        ""
      },
      "\n"
    ],
    "Text"
  ];
];

chainBeforePass = HepCalcVerifyInputChain["before_pass_publish"];
If[Lookup[chainBeforePass, "status", "ERROR"] =!= "PASS",
  HepCalcReducerFail[
    "formcalc_input_chain_mismatch_before_pass_publish",
    <|"input_chain" -> chainBeforePass|>,
    26
  ]
];

rawBytes = $HepCalcRawBytes;
rawSHA = $HepCalcRawSHA;
snapshotFinalPayload = HepCalcSecureRead[$HepCalcInputSnapshotPath];
outputFinalPayload = HepCalcSecureRead[$HepCalcAmplitudeOutPath];
If[! AssociationQ[snapshotFinalPayload] || ! AssociationQ[outputFinalPayload],
  HepCalcReducerFail["formcalc_final_witness_unreadable", <||>, 27]
];
snapshotBytes = Lookup[snapshotFinalPayload, "bytes", Null];
snapshotSHA = Lookup[snapshotFinalPayload, "sha256", Null];
outputBytes = Lookup[outputFinalPayload, "bytes", Null];
outputSHA = Lookup[outputFinalPayload, "sha256", Null];
endedAt = DateString[Now, "ISODateTime"];

formStatus = <|
  "stage" -> "auto_qft_formcalc_reducer",
  "status" -> "PASS",
  "reason" -> "",
  "started_at" -> $HepCalcReducerStartedAt,
  "ended_at" -> endedAt,
  "memory_limit_mb" -> $HepCalcMemoryLimitMB,
  "pave_reduce" -> $HepCalcPaveReduce,
  "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
  "producer_token" -> $HepCalcProducerToken,
  "system_id" -> $SystemID,
  "feynarts_file" -> feynArtsFile,
  "formcalc_file" -> formCalcFile,
  "input" -> <|
    "token" -> $HepCalcProducerToken,
    "path" -> $HepCalcRawRelativePath,
    "bytes" -> rawBytes,
    "sha256" -> rawSHA
  |>,
  "snapshot" -> <|
    "token" -> $HepCalcProducerToken,
    "path" -> $HepCalcSnapshotRelativePath,
    "source_path" -> $HepCalcRawRelativePath,
    "bytes" -> snapshotBytes,
    "sha256" -> snapshotSHA
  |>,
  "input_chain_checks" -> <|
    "after_snapshot_publish" -> "PASS",
    "after_snapshot_read" -> "PASS",
    "after_reduction" -> "PASS",
    "before_pass_publish" -> "PASS"
  |>,
  "output" -> <|"path" -> "auto_qft/amplitude/amplitude_summed.m", "bytes" -> outputBytes, "sha256" -> outputSHA|>
|>;
HepCalcWriteJSON[$HepCalcFormCalcStatusPath, formStatus];

options = Lookup[summary, "options", <||>];
If[! AssociationQ[options], options = <||>];
options = Join[
  options,
  <|
    "formcalc" -> <|
      "enable" -> True,
      "status" -> "PASS",
      "reason" -> "",
      "pave_reduce" -> $HepCalcPaveReduce,
      "memory_limit_mb" -> $HepCalcMemoryLimitMB,
      "reducer_status" -> "auto_qft/formcalc/status.json",
      "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
      "output_path" -> "auto_qft/amplitude/amplitude_summed.m",
      "output_bytes" -> outputBytes,
      "output_sha256" -> outputSHA
    |>,
    "pave_reduce" -> $HepCalcPaveReduce
  |>
];
artifacts = Lookup[summary, "artifacts", <||>];
If[! AssociationQ[artifacts], artifacts = <||>];
artifacts = Join[
  artifacts,
  <|
    "amplitude_summed" -> "auto_qft/amplitude/amplitude_summed.m",
    "amplitude_summed_tex" -> If[ampTexOut === "", Null, "auto_qft/amplitude/amplitude_summed.tex"],
    "amplitude_summed_md" -> If[ampMdOut === "", Null, "auto_qft/amplitude/amplitude_summed.md"],
    "formcalc_status" -> "auto_qft/formcalc/status.json",
    "formcalc_input_snapshot" -> $HepCalcSnapshotRelativePath
  |>
];
summary = Join[
  summary,
  <|
    "ts" -> endedAt,
    "status" -> "PASS",
    "reason" -> Null,
    "disclaimer" -> "Amplitude is UNRENORMALIZED (UV poles may be present).",
    "options" -> options,
    "artifacts" -> artifacts,
    "formcalc_reducer" -> formStatus
  |>
];
HepCalcWriteJSON[$HepCalcSummaryPath, summary];

HepCalcWriteJSON[
  $HepCalcStatusPath,
  <|
    "stage" -> "auto_qft_one_loop",
    "status" -> "PASS",
    "reason" -> Null,
    "started_at" -> $HepCalcProducerStartedAt,
    "ended_at" -> endedAt,
    "amplitude_level" -> "formcalc",
    "formcalc" -> <|
      "status" -> "PASS",
      "reason" -> "",
      "reducer_status" -> "auto_qft/formcalc/status.json",
      "pave_reduce" -> $HepCalcPaveReduce,
      "memory_limit_mb" -> $HepCalcMemoryLimitMB,
      "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
      "producer_token" -> $HepCalcProducerToken,
      "input_path" -> $HepCalcRawRelativePath,
      "snapshot_path" -> $HepCalcSnapshotRelativePath,
      "input_bytes" -> rawBytes,
      "input_sha256" -> rawSHA,
      "output_path" -> "auto_qft/amplitude/amplitude_summed.m",
      "output_bytes" -> outputBytes,
      "output_sha256" -> outputSHA
    |>,
    "disclaimer" -> "Amplitude is UNRENORMALIZED (UV poles may be present)."
  |>
];

Print["[hep-calc-formcalc] reducer_status=PASS"];
Print["[hep-calc-formcalc] output_bytes=", outputBytes];
Print["[hep-calc-formcalc] output_sha256=", outputSHA];
Quit[0];
