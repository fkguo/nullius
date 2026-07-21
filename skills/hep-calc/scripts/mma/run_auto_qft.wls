(* run_auto_qft.wls

   wolframscript entry point:
     HEP_CALC_POSTCONDITION_VALIDATOR=<validator.py> wolframscript -noprompt -file run_auto_qft.wls -- <job.snapshot.json> <out_dir> <job_bytes> <job_sha256>

   Purpose:
   - Deterministically run an automated pipeline:
       FeynRules (model/Lagrangian) -> FeynArts (diagrams) -> FormCalc (unrenormalized loop amplitude)
   - Emit auditable artifacts under out_dir/auto_qft/.
   - Always write:
       auto_qft/status.json
       auto_qft/summary.json
*)

ClearAll[
  HepCalcNormalizeForJSON,
  HepCalcWriteJSON,
  HepCalcWriteStatus,
  HepCalcWriteSummary,
  HepCalcSecureRead,
  HepCalcFeynArtsModelStage,
  HepCalcDecodeSecureBytes,
  HepCalcFail,
  HepCalcMissingQ,
  HepCalcToFeynArtsField,
  HepCalcParseFAField,
  HepCalcResolveFAFieldFromFRModel
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

HepCalcWriteStatus[path_String, status_Association] := HepCalcWriteJSON[path, status];
HepCalcWriteSummary[path_String, summary_Association] := HepCalcWriteJSON[path, summary];

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

HepCalcFeynArtsModelStage[stage_String, modelName_String] := Module[{proc, payload},
  proc = Quiet@Check[
    RunProcess[
      {
        "python3",
        $HepCalcValidatorPath,
        "--stage",
        stage,
        "--out",
        $HepCalcOutDir,
        "--model-name",
        modelName
      },
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

HepCalcMissingQ[x_] := (x === Null) || (x === "") || (x === None) || (x === $Failed) || (Head[x] === Missing);

HepCalcFail[reason_String, extra_Association : <||>, exitCode_Integer : 1] := Module[{},
  HepCalcWriteStatus[
    $HepCalcStatusPath,
    Join[
      <|
        "stage" -> "auto_qft_one_loop",
        "status" -> "ERROR",
        "reason" -> reason,
        "started_at" -> $HepCalcStartedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>,
      extra
    ]
  ];
  HepCalcWriteSummary[
    $HepCalcSummaryPath,
    Join[
      <|
        "ts" -> DateString[Now, "ISODateTime"],
        "status" -> "ERROR",
        "reason" -> reason
      |>,
      extra
    ]
  ];
  Quit[exitCode];
];

HepCalcModelBuildFail[reason_String, extra_Association : <||>, exitCode_Integer : 1] := Module[{},
  HepCalcWriteJSON[
    $HepCalcModelBuildStatusPath,
    Join[
      <|
        "stage" -> "auto_qft_model_build",
        "status" -> "ERROR",
        "reason" -> reason,
        "started_at" -> $HepCalcStartedAt,
        "ended_at" -> DateString[Now, "ISODateTime"]
      |>,
      extra
    ]
  ];
  HepCalcWriteJSON[
    $HepCalcModelBuildSummaryPath,
    Join[
      <|
        "ts" -> DateString[Now, "ISODateTime"],
        "status" -> "ERROR",
        "reason" -> reason
      |>,
      extra
    ]
  ];
  HepCalcFail["model_build:" <> reason, extra, exitCode];
];

HepCalcParseFAField[str_String] := Module[{s, ok, held},
  s = StringReplace[str, WhitespaceCharacter .. -> ""];
  ok = StringMatchQ[s, RegularExpression["-?(F|V|S|U|SV)\\[[0-9]+(,\\{[0-9]+(,[0-9]+)*\\})?\\]"]];
  If[! ok, Return[$Failed]];
  held = ToExpression[s, InputForm, HoldComplete];
  ReleaseHold[held]
];

HepCalcToFeynArtsField[expr_] := Module[{y = expr, sign = 1, headName, headFA},
  If[MatchQ[y, Times[-1, _]],
    sign = -1;
    y = -y;
  ];
  headName = SymbolName[Head[y]];
  headFA = ToExpression["FeynArts`" <> headName];
  sign*(headFA @@ (List @@ y))
];

HepCalcResolveFAFieldFromFRModel[name_String] := Module[
  {
    classes,
    norm,
    hit,
    cls,
    opts,
    pnRaw,
    apnRaw,
    pnList,
    apnList,
    pnNorm,
    apnNorm,
    idx,
    idxsRaw,
    idxs,
    base,
    expr
  },

  norm[x_] := If[StringQ[x], x, ToString[x, InputForm]];

  classes = Cases[FeynRules`M$ClassesDescription, HoldPattern[c_ == o_List] :> {c, o}, Infinity];
  hit = SelectFirst[
    classes,
    (
      opts = #[[2]];
      pnRaw = Cases[opts, Rule[ParticleName | FeynRules`ParticleName, v_] :> v, 1];
      apnRaw = Cases[opts, Rule[AntiParticleName | FeynRules`AntiParticleName, v_] :> v, 1];

      pnList = If[pnRaw === {}, {}, First[pnRaw]];
      apnList = If[apnRaw === {}, {}, First[apnRaw]];
      pnList = If[ListQ[pnList], pnList, If[pnList === {}, {}, {pnList}]];
      apnList = If[ListQ[apnList], apnList, If[apnList === {}, {}, {apnList}]];

      pnNorm = norm /@ pnList;
      apnNorm = norm /@ apnList;

      MemberQ[pnNorm, name] || MemberQ[apnNorm, name]
    ) &,
    $Failed
  ];

  If[hit === $Failed, Return[$Failed]];

  cls = hit[[1]];
  opts = hit[[2]];

  pnRaw = Cases[opts, Rule[ParticleName | FeynRules`ParticleName, v_] :> v, 1];
  apnRaw = Cases[opts, Rule[AntiParticleName | FeynRules`AntiParticleName, v_] :> v, 1];
  pnList = If[pnRaw === {}, {}, First[pnRaw]];
  apnList = If[apnRaw === {}, {}, First[apnRaw]];
  pnList = If[ListQ[pnList], pnList, If[pnList === {}, {}, {pnList}]];
  apnList = If[ListQ[apnList], apnList, If[apnList === {}, {}, {apnList}]];
  pnNorm = norm /@ pnList;
  apnNorm = norm /@ apnList;

  base = cls;

  idxsRaw = Cases[opts, Rule[Indices | FeynRules`Indices, v_] :> v, 1];
  idxs = If[idxsRaw === {}, {}, First[idxsRaw]];

  If[MemberQ[pnNorm, name],
    idx = First@FirstPosition[pnNorm, name];
    expr = base;,
    If[MemberQ[apnNorm, name],
      idx = First@FirstPosition[apnNorm, name];
      expr = -base;,
      Return[$Failed]
    ]
  ];

  If[idxs === {} || idxs === Null, Return[expr]];
  If[
    ListQ[idxs] && Length[idxs] == 1 &&
      SymbolName[Head[idxs[[1]]]] == "Index" &&
      Length[idxs[[1]]] >= 1 &&
      Head[idxs[[1, 1]]] === Symbol &&
      SymbolName[idxs[[1, 1]]] == "Generation",
    Return[expr /. base :> (Head[base] @@ Append[List @@ base, {idx}])]
  ];

  $Failed
];

(* -------- main -------- *)

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
$HepCalcStartedAt = DateString[Now, "ISODateTime"];

autoDir = FileNameJoin[{$HepCalcOutDir, "auto_qft"}];
modelDir = FileNameJoin[{autoDir, "feynarts_model"}];
diagDir = FileNameJoin[{autoDir, "diagrams"}];
ampDir = FileNameJoin[{autoDir, "amplitude"}];
mbDir = FileNameJoin[{autoDir, "model_build"}];
mbTexDir = FileNameJoin[{mbDir, "tex_preprocess"}];

If[! DirectoryQ[autoDir], CreateDirectory[autoDir, CreateIntermediateDirectories -> True]];
CreateDirectory[modelDir, CreateIntermediateDirectories -> True];
CreateDirectory[diagDir, CreateIntermediateDirectories -> True];
CreateDirectory[ampDir, CreateIntermediateDirectories -> True];
CreateDirectory[mbDir, CreateIntermediateDirectories -> True];

$HepCalcStatusPath = FileNameJoin[{autoDir, "status.json"}];
$HepCalcSummaryPath = FileNameJoin[{autoDir, "summary.json"}];

$HepCalcModelBuildStatusPath = FileNameJoin[{mbDir, "status.json"}];
$HepCalcModelBuildSummaryPath = FileNameJoin[{mbDir, "summary.json"}];

jobPayload = HepCalcSecureRead[jobPath];
If[
  ! AssociationQ[jobPayload] ||
    Lookup[jobPayload, "bytes", Null] =!= $HepCalcJobBytes ||
    Lookup[jobPayload, "sha256", Null] =!= $HepCalcJobSHA,
  HepCalcFail[
    "job_resolved_binding_mismatch",
    <|"jobPath" -> jobPath, "expected_bytes" -> $HepCalcJobBytes, "expected_sha256" -> $HepCalcJobSHA|>,
    3
  ]
];
jobText = HepCalcDecodeSecureBytes[jobPayload];
job = Quiet@Check[ImportString[jobText, "RawJSON"], $Failed];
If[job === $Failed, HepCalcFail["job_resolved_json_unreadable", <|"jobPath" -> jobPath|>, 3]];

auto = Lookup[job, "auto_qft", <||>];
enabled = TrueQ[Lookup[auto, "enable", False]];

If[! enabled,
  HepCalcWriteStatus[
    $HepCalcStatusPath,
    <|
      "stage" -> "auto_qft_one_loop",
      "status" -> "SKIPPED",
      "reason" -> "not_enabled",
      "started_at" -> $HepCalcStartedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  HepCalcWriteSummary[
    $HepCalcSummaryPath,
    <|
      "ts" -> DateString[Now, "ISODateTime"],
      "status" -> "SKIPPED",
      "reason" -> "not_enabled"
    |>
  ];
  Quit[0];
];

(* Read config *)

faModel = Lookup[auto, "feynarts_model", Null];
faGenModel = Lookup[auto, "feynarts_generic_model", Null];
useFeynArtsOnly = ! HepCalcMissingQ[faModel];

mbCfg = Lookup[auto, "model_build", <||>];
If[! AssociationQ[mbCfg], mbCfg = <||>];
mbEnableExplicit = Lookup[mbCfg, "enable", Missing["KeyAbsent", "enable"]];
mbTexPaths = Lookup[mbCfg, "tex_paths", {}];
mbInlineTeX = Lookup[mbCfg, "inline_tex", ""];
mbEnabled = False;
If[
  TrueQ[mbEnableExplicit],
  mbEnabled = True,
  If[
    mbEnableExplicit =!= False && (
      (ListQ[mbTexPaths] && Length[mbTexPaths] > 0) ||
        (StringQ[mbInlineTeX] && StringTrim[mbInlineTeX] =!= "")
    ),
    mbEnabled = True
  ]
];
mbBaseModelFiles = Lookup[mbCfg, "base_model_files", {}];
If[! ListQ[mbBaseModelFiles], mbBaseModelFiles = {}];
mbRewriteWLS = Lookup[mbCfg, "rewrite_wls", Null];
mbParsePolicy = ToString[Lookup[mbCfg, "parse_policy", "best_effort"]];
If[! MemberQ[{"best_effort", "strict"}, mbParsePolicy], mbParsePolicy = "best_effort"];

frRoot = Null;
modelFiles = {};
postLoadFiles = {};
lagSym = Null;
jobMeta = Lookup[job, "_meta", <||>];
jobDir = ToString[Lookup[jobMeta, "job_dir", DirectoryName[jobPath]]];

patchCfg = Lookup[auto, "feynarts_model_patch", <||>];
If[! AssociationQ[patchCfg], patchCfg = <||>];
patchEnable = TrueQ[Lookup[patchCfg, "enable", False]];
patchWLS = Lookup[patchCfg, "patch_wls", Null];
patchStatus = "SKIPPED";
patchReason = If[patchEnable, "not_run", "not_requested"];
patchNotes = {};
patchSHA = Null;
patchResolvedPath = Null;

If[! useFeynArtsOnly,
  frRoot = Lookup[auto, "feynrules_root", Null];
  If[HepCalcMissingQ[frRoot],
    frRoot = Environment["FEYNRULES_PATH"];
  ];
  If[HepCalcMissingQ[frRoot],
    frRoot = FileNameJoin[{$HomeDirectory, "Library", "Wolfram", "Applications", "FeynRules"}];
  ];

  modelFiles = Lookup[auto, "model_files", {}];
  If[! ListQ[modelFiles], modelFiles = {}];

  lagSym = ToString[Lookup[auto, "lagrangian_symbol", "LSM"]];
  If[! StringMatchQ[lagSym, RegularExpression["[A-Za-z\\$][A-Za-z0-9\\$]*"]], HepCalcFail["invalid_lagrangian_symbol", <|"lagrangian_symbol" -> lagSym|>]];
];

faCfg = Lookup[auto, "feynarts", <||>];
loopOrder = Lookup[faCfg, "loop_order", 1];
insLevel = ToString[Lookup[faCfg, "insertion_level", "Particles"]];
excludeTop = Lookup[faCfg, "exclude_topologies", {"Tadpoles"}];
counterTerms = TrueQ[Lookup[faCfg, "counterterms", False]];
adjacenciesCfg = Lookup[faCfg, "adjacencies", {3, 4}];
If[! ListQ[adjacenciesCfg], adjacenciesCfg = {adjacenciesCfg}];
adjacencies = ToExpression[ToString[#], InputForm] & /@ adjacenciesCfg;
If[! VectorQ[adjacencies, IntegerQ],
  HepCalcFail["invalid_feynarts_adjacencies", <|"adjacencies" -> adjacenciesCfg|>]
];
adjacencies = Sort@DeleteDuplicates@adjacencies;
If[Length[adjacencies] == 0 || Min[adjacencies] <= 2,
  HepCalcFail["invalid_feynarts_adjacencies", <|"adjacencies" -> adjacenciesCfg|>]
];
ctOrder = Lookup[faCfg, "ct_order", 0];
If[! IntegerQ[ctOrder] || ctOrder < 0,
  HepCalcFail["invalid_feynarts_ct_order", <|"ct_order" -> ctOrder|>]
];

fcCfg = Lookup[auto, "formcalc", <||>];
useFormCalc = TrueQ[Lookup[fcCfg, "enable", False]];
useFormCalcRequested = useFormCalc;
paveReduce = ToString[Lookup[fcCfg, "pave_reduce", "LoopTools"]];
formcalcMemoryLimitMB = Lookup[fcCfg, "memory_limit_mb", 2048];

expCfg = Lookup[auto, "export", <||>];
doDiagrams = TrueQ[Lookup[expCfg, "diagrams", True]];
doAmpTeX = TrueQ[Lookup[expCfg, "amplitude_tex", False]];
doAmpMD = TrueQ[Lookup[expCfg, "amplitude_md", True]];
doPerDiagram = TrueQ[Lookup[expCfg, "per_diagram", False]];

proc = Lookup[auto, "process", <||>];
procIn = Lookup[proc, "in", {}];
procOut = Lookup[proc, "out", {}];
procInFA = Lookup[proc, "in_fa", {}];
procOutFA = Lookup[proc, "out_fa", {}];

If[! ListQ[procInFA], procInFA = {}];
If[! ListQ[procOutFA], procOutFA = {}];
If[! ListQ[procIn], procIn = {}];
If[! ListQ[procOut], procOut = {}];

If[useFeynArtsOnly,
  If[Length[procInFA] == 0 || Length[procOutFA] == 0,
    HepCalcFail["missing_process_fa_fields", <|"process" -> proc|>]
  ];
  inFields = HepCalcParseFAField /@ procInFA;
  outFields = HepCalcParseFAField /@ procOutFA;
  If[MemberQ[inFields, $Failed] || MemberQ[outFields, $Failed],
    HepCalcFail["invalid_process_fa_fields", <|"in_fa" -> procInFA, "out_fa" -> procOutFA|>]
  ];,
  If[Length[procInFA] > 0 && Length[procOutFA] > 0,
    inFields = HepCalcParseFAField /@ procInFA;
    outFields = HepCalcParseFAField /@ procOutFA;
    If[MemberQ[inFields, $Failed] || MemberQ[outFields, $Failed],
      HepCalcFail["invalid_process_fa_fields", <|"in_fa" -> procInFA, "out_fa" -> procOutFA|>]
    ];,
    If[Length[procIn] == 0 || Length[procOut] == 0,
      HepCalcFail["missing_process", <|"process" -> proc|>]
    ];
  ];
];

modelName = "";
genericModelName = "";
frVersion = Null;
frDate = Null;
faMod = Null;
faGen = Null;
faPars = Null;

modelBuildStatus = "SKIPPED";
modelBuildReason = "not_requested";
modelBuildArtifacts = <||>;
modelBuildCounts = <||>;
modelBuildWarnings = {};

If[useFeynArtsOnly,
  modelName = ToString[faModel];
  genericModelName = If[HepCalcMissingQ[faGenModel], modelName, ToString[faGenModel]];
  HepCalcWriteJSON[
    $HepCalcModelBuildStatusPath,
    <|
      "stage" -> "auto_qft_model_build",
      "status" -> "SKIPPED",
      "reason" -> "feynarts_only_mode",
      "started_at" -> $HepCalcStartedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  HepCalcWriteJSON[
    $HepCalcModelBuildSummaryPath,
    <|
      "ts" -> DateString[Now, "ISODateTime"],
      "status" -> "SKIPPED",
      "reason" -> "feynarts_only_mode"
    |>
  ];,
  (* Load FeynRules *)
  $FeynRulesPath = frRoot;
  FR$Parallel = False;
  FR$Parallelize = False;

  If[! DirectoryQ[$FeynRulesPath], HepCalcFail["feynrules_root_not_found", <|"feynrules_root" -> frRoot|>]];
  If[! FileExistsQ[ToFileName[$FeynRulesPath, "FeynRules.m"]], HepCalcFail["feynrules_m_not_found", <|"feynrules_root" -> frRoot|>]];

  Quiet@Check[
    Get[ToFileName[$FeynRulesPath, "FeynRules.m"]],
    HepCalcFail["feynrules_load_failed", <|"feynrules_root" -> frRoot|>],
    {Get::noopen, Needs::nocont}
  ];

  frVersion = ToString[FeynRules`FR$VersionNumber];
  frDate = ToString[FeynRules`FR$VersionDate];

  (* Optional: build/augment FeynRules model from LaTeX blocks (agent provides rewrite rules). *)
  If[mbEnabled,
    If[Length[mbBaseModelFiles] > 0 && ! (And @@ (FileExistsQ /@ mbBaseModelFiles)),
      HepCalcModelBuildFail["base_model_files_not_found", <|"base_model_files" -> mbBaseModelFiles|>]
    ];
    If[HepCalcMissingQ[mbRewriteWLS],
      modelBuildStatus = "SKIPPED";
      modelBuildReason = "missing_rewrite_wls";
      ,
      If[! FileExistsQ[mbRewriteWLS], HepCalcModelBuildFail["rewrite_wls_not_found", <|"rewrite_wls" -> mbRewriteWLS|>]];
      rewriteSHA = Quiet@Check[FileHash[mbRewriteWLS, "SHA256", "HexString"], $Failed];
      If[rewriteSHA === $Failed, rewriteSHA = ToString@Quiet@Check[FileHash[mbRewriteWLS, "SHA256"], ""] ];

      preBlocksPath = FileNameJoin[{mbTexDir, "blocks_selected.json"}];
      If[! FileExistsQ[preBlocksPath], HepCalcModelBuildFail["missing_tex_preprocess_blocks", <|"expected" -> preBlocksPath|>]];

      blocksJSON = Quiet@Check[Import[preBlocksPath, "RawJSON"], $Failed];
      If[blocksJSON === $Failed, HepCalcModelBuildFail["blocks_selected_unreadable", <|"path" -> preBlocksPath|>]];

      rows = Lookup[blocksJSON, "rows", {}];
      If[! ListQ[rows], rows = {}];

      parsedBlocks = Table[
        Module[{rid, rtex, held, expr, ok},
          rid = ToString[Lookup[r, "id", ""]];
          rtex = ToString[Lookup[r, "normalized_tex", ""]];
          held = Quiet@Check[ToExpression[rtex, TeXForm, HoldComplete], $Failed];
          ok = held =!= $Failed;
          expr = If[ok, held, HoldComplete[$Failed]];
          <|
            "id" -> rid,
            "file" -> Lookup[r, "file", Null],
            "env" -> Lookup[r, "env", Null],
            "labels" -> Lookup[r, "labels", {}],
            "normalized_tex" -> rtex,
            "ok" -> ok,
            "expr_held" -> expr
          |>
        ],
        {r, rows}
      ];

      bad = Select[parsedBlocks, ! TrueQ[Lookup[#, "ok", False]] &];
      modelBuildCounts = <|"blocks_total" -> Length[parsedBlocks], "blocks_parsed_ok" -> (Length[parsedBlocks] - Length[bad]), "blocks_failed" -> Length[bad]|>;

      Put[
        parsedBlocks,
        FileNameJoin[{mbDir, "parsed_blocks.m"}]
      ];

      badIds = Lookup[bad, "id", {}];
      If[Length[bad] > 0,
        If[mbParsePolicy === "strict",
          HepCalcModelBuildFail["texform_parse_failed", <|"counts" -> modelBuildCounts, "failed_ids" -> badIds, "parse_policy" -> mbParsePolicy|>],
          modelBuildWarnings = Append[modelBuildWarnings, <|"warning" -> "texform_parse_partial", "failed_ids" -> badIds|>];
        ]
      ];

      Quiet@Check[
        Get[mbRewriteWLS],
        HepCalcModelBuildFail["rewrite_wls_load_failed", <|"rewrite_wls" -> mbRewriteWLS|>],
        {Get::noopen}
      ];

      If[Length[DownValues[HepCalcModelBuildRewrite]] == 0, HepCalcModelBuildFail["rewrite_function_missing", <|"expected" -> "HepCalcModelBuildRewrite"|>]];

      ctx = <|
        "job" -> job,
        "out_dir" -> $HepCalcOutDir,
        "auto_dir" -> autoDir,
        "model_build_dir" -> mbDir,
        "lagrangian_symbol" -> lagSym,
        "parse_policy" -> mbParsePolicy
      |>;

      rewriteRes = Quiet@Check[HepCalcModelBuildRewrite[parsedBlocks, ctx], $Failed];
      If[rewriteRes === $Failed, HepCalcModelBuildFail["rewrite_failed"]];

      lagRes = $Failed;
      lagSymOverride = lagSym;
      rewriteNotes = Null;
      rewriteWarnings = {};
      If[AssociationQ[rewriteRes],
        lagRes = Lookup[rewriteRes, "lagrangian", $Failed];
        lagSymOverride = ToString[Lookup[rewriteRes, "lagrangian_symbol", lagSym]];
        rewriteNotes = Lookup[rewriteRes, "notes", Null];
        rewriteWarnings = Lookup[rewriteRes, "warnings", {}];
        If[rewriteWarnings =!= {} && ! ListQ[rewriteWarnings], rewriteWarnings = {rewriteWarnings}];
        ,
        (* Back-compat: allow returning an expression directly, but record a warning. *)
        lagRes = rewriteRes;
        modelBuildWarnings = Append[modelBuildWarnings, <|"warning" -> "rewrite_return_not_association", "hint" -> "Prefer returning an Association with key 'lagrangian'."|>];
      ];

      If[lagRes === $Failed, HepCalcModelBuildFail["rewrite_returned_no_lagrangian"]];
      If[StringQ[lagSymOverride] && StringMatchQ[lagSymOverride, RegularExpression["[A-Za-z\\$][A-Za-z0-9\\$]*"]],
        lagSym = lagSymOverride;
      ];

      lagFile = FileNameJoin[{mbDir, "generated_lagrangian.fr"}];
      Export[
        lagFile,
        "(* Auto-generated by hep-calc from LaTeX blocks; do not edit. *)\n" <>
          lagSym <> " = " <> ToString[lagRes, InputForm] <> ";\n",
        "String"
      ];
      modelBuildArtifacts = <|
        "generated_lagrangian_fr" -> lagFile,
        "parsed_blocks_m" -> FileNameJoin[{mbDir, "parsed_blocks.m"}],
        "rewrite_wls" -> mbRewriteWLS,
        "rewrite_wls_sha256" -> rewriteSHA,
        "tex_blocks" -> preBlocksPath,
        "rewrite_notes" -> rewriteNotes,
        "rewrite_warnings" -> rewriteWarnings
      |>;

      (* Load strategy:
         - If a base model (or other model_files) exists, treat the generated file as a post-load snippet (Get[...]),
           because LoadModel merging expects each file to look like a full model file.
         - If no other model files are present, load the generated file via LoadModel (so users can generate a full model). *)
      If[Length[mbBaseModelFiles] > 0, modelFiles = DeleteDuplicates@Join[mbBaseModelFiles, modelFiles]];
      If[Length[modelFiles] > 0,
        postLoadFiles = Append[postLoadFiles, lagFile],
        modelFiles = Append[modelFiles, lagFile]
      ];

      modelBuildStatus = "PASS";
      modelBuildReason = If[Length[modelBuildWarnings] > 0, "warnings_present", Null];
    ];
  ];

  (* Write model_build status/summary (always, even if SKIPPED). *)
  HepCalcWriteJSON[
    $HepCalcModelBuildStatusPath,
    <|
      "stage" -> "auto_qft_model_build",
      "status" -> modelBuildStatus,
      "reason" -> modelBuildReason,
      "started_at" -> $HepCalcStartedAt,
      "ended_at" -> DateString[Now, "ISODateTime"]
    |>
  ];
  HepCalcWriteJSON[
    $HepCalcModelBuildSummaryPath,
    <|
      "ts" -> DateString[Now, "ISODateTime"],
      "status" -> modelBuildStatus,
      "reason" -> modelBuildReason,
      "counts" -> modelBuildCounts,
      "warnings" -> modelBuildWarnings,
      "artifacts" -> modelBuildArtifacts
    |>
  ];

  (* Load model *)
  If[Length[modelFiles] == 0, HepCalcFail["missing_model_files", <|"model_files" -> modelFiles, "model_build_status" -> modelBuildStatus|>]];
  If[! And @@ (FileExistsQ /@ modelFiles), HepCalcFail["model_file_not_found", <|"model_files" -> modelFiles|>]];
  SetDirectory[DirectoryName[First[modelFiles]]];
  Quiet@Check[
    FeynRules`LoadModel @@ modelFiles,
    HepCalcFail["load_model_failed", <|"model_files" -> modelFiles|>]
  ];
  If[Length[postLoadFiles] > 0,
    Quiet@Check[
      (Get /@ postLoadFiles),
      HepCalcFail["post_load_file_failed", <|"files" -> postLoadFiles|>],
      {Get::noopen}
    ];
  ];

  lag = ToExpression[lagSym];
  If[! ValueQ[lag], HepCalcFail["lagrangian_symbol_not_defined", <|"lagrangian_symbol" -> lagSym|>]];

  (* Resolve process fields if not given as explicit FeynArts fields *)
  If[!(Length[procInFA] > 0 && Length[procOutFA] > 0),
    inFields = HepCalcResolveFAFieldFromFRModel /@ procIn;
    outFields = HepCalcResolveFAFieldFromFRModel /@ procOut;
    If[MemberQ[inFields, $Failed] || MemberQ[outFields, $Failed],
      HepCalcFail["process_name_resolution_failed", <|"in" -> procIn, "out" -> procOut|>]
    ];
  ];

  (* Export FeynArts model *)
  modelName = "hep_calc_auto_model";
  genericModelName = modelName;
  faPrefix = FileNameJoin[{modelDir, modelName}];
  faMod = faPrefix <> ".mod";
  faGen = faPrefix <> ".gen";
  faPars = faPrefix <> ".pars";

  modelPrepare = HepCalcFeynArtsModelStage["prepare_feynarts_model", modelName];
  If[
    modelPrepare === $Failed,
    HepCalcFail[
      "feynarts_model_invalidation_failed",
      <|"expected" -> {faMod, faGen, faPars}|>
    ]
  ];

  writeFeynArtsResult = Quiet@CheckAbort[
    FeynRules`WriteFeynArtsOutput[lag, FeynRules`Output -> faPrefix, FeynRules`ScreenOutput -> False],
    $Aborted
  ];
  If[
    writeFeynArtsResult === $Aborted || writeFeynArtsResult === $Failed,
    HepCalcFail[
      "write_feynarts_output_failed",
      <|"model_files" -> modelFiles, "lagrangian_symbol" -> lagSym|>
    ]
  ];

  modelVerify = HepCalcFeynArtsModelStage["verify_feynarts_model", modelName];
  If[modelVerify === $Failed,
    HepCalcFail["feynarts_model_files_missing", <|"expected" -> {faMod, faGen, faPars}|>]
  ];

  (* Optional: apply a user/agent-provided patch to the generated FeynArts model
     BEFORE FeynArts loads it. This is useful for cases where FeynRules does not emit
     some bilinear mixing terms as explicit vertices, but the user wants to represent
     them as 2-point couplings in FeynArts. *)
  If[patchEnable,
    patchResolvedPath = ToString[patchWLS];
    If[HepCalcMissingQ[patchResolvedPath],
      HepCalcFail["feynarts_model_patch_missing_path", <|"patch_cfg" -> patchCfg|>]
    ];
    If[! FileExistsQ[patchResolvedPath],
      If[! StringStartsQ[patchResolvedPath, "/"],
        patchResolvedPath = FileNameJoin[{jobDir, patchResolvedPath}]
      ];
    ];
    If[! FileExistsQ[patchResolvedPath],
      HepCalcFail["feynarts_model_patch_not_found", <|"patch_wls" -> patchWLS, "resolved" -> patchResolvedPath|>]
    ];

    patchSHA = Quiet@Check[FileHash[patchResolvedPath, "SHA256", "HexString"], $Failed];
    If[patchSHA === $Failed, patchSHA = ToString@Quiet@Check[FileHash[patchResolvedPath, "SHA256"], ""] ];

    (* Load patch file and call HepCalcFeynArtsModelPatch[ctx_Association] if defined. *)
    Quiet@Check[
      Get[patchResolvedPath],
      HepCalcFail["feynarts_model_patch_get_failed", <|"patch_wls" -> patchResolvedPath|>],
      {Get::noopen, Needs::nocont}
    ];
    If[! NameQ["HepCalcFeynArtsModelPatch"],
      HepCalcFail["feynarts_model_patch_missing_entrypoint", <|"patch_wls" -> patchResolvedPath, "expected" -> "HepCalcFeynArtsModelPatch[ctx_Association]"|>]
    ];

    patchRes = Quiet@Check[
      HepCalcFeynArtsModelPatch[
        <|
          "job_dir" -> jobDir,
          "out_dir" -> $HepCalcOutDir,
          "auto_dir" -> autoDir,
          "model_dir" -> modelDir,
          "model_name" -> modelName,
          "generic_model_name" -> genericModelName,
          "fa_prefix" -> faPrefix,
          "fa_mod" -> faMod,
          "fa_gen" -> faGen,
          "fa_pars" -> faPars,
          "lagrangian_symbol" -> lagSym,
          "lagrangian" -> lag
        |>
      ],
      $Failed
    ];

    If[patchRes === $Failed,
      patchStatus = "ERROR";
      patchReason = "patch_failed";,
      If[AssociationQ[patchRes],
        patchStatus = ToString[Lookup[patchRes, "status", "PASS"]];
        patchReason = ToString[Lookup[patchRes, "reason", ""]];
        patchNotes = Lookup[patchRes, "notes", {}];
        If[! ListQ[patchNotes], patchNotes = {ToString[patchNotes]}];,
        patchStatus = "PASS";
        patchReason = ""
      ]
    ];

    If[patchStatus =!= "PASS",
      HepCalcFail["feynarts_model_patch_failed", <|"patch_status" -> patchStatus, "patch_reason" -> patchReason, "patch_notes" -> patchNotes, "patch_wls" -> patchResolvedPath|>]
    ];
  ];
];

(* FeynArts *)
Needs["FeynArts`"];

FeynArts`$ModelPath = Prepend[FeynArts`$ModelPath, modelDir];
$CounterTerms = counterTerms;

inFieldsFA = HepCalcToFeynArtsField /@ inFields;
outFieldsFA = HepCalcToFeynArtsField /@ outFields;

(* ExcludeTopologies: currently recognize only Tadpoles *)
excludeTokens = If[ListQ[excludeTop], excludeTop, {}];
excludeResolved = {};
If[MemberQ[excludeTokens, "Tadpoles"], excludeResolved = Append[excludeResolved, Tadpoles]];

top = CreateTopologies[
  loopOrder,
  Length[inFieldsFA] -> Length[outFieldsFA],
  ExcludeTopologies -> excludeResolved,
  Adjacencies -> adjacencies,
  CTOrder -> ctOrder
];
ins = InsertFields[top, inFieldsFA -> outFieldsFA, Model -> modelName, GenericModel -> genericModelName, InsertionLevel -> ToExpression[insLevel]];
If[ins === $Failed, HepCalcFail["insert_fields_failed", <|"model" -> modelName, "generic_model" -> genericModelName|>]];

Put[top, FileNameJoin[{autoDir, "topologies.m"}]];
Put[ins, FileNameJoin[{autoDir, "insertions.m"}]];

diagramFiles = {};
diagramIndexRel = Null;
If[doDiagrams,
  plt = Paint[
    ins,
    ColumnsXRows -> {2, 2},
    Numbering -> Simple,
    SheetHeader -> False,
    PaintLevel -> ToExpression[insLevel],
    DisplayFunction -> Identity
  ];
  diagPdf = FileNameJoin[{diagDir, "diagrams.pdf"}];
  diagExport = Quiet@Check[Export[diagPdf, plt], $Failed];
  If[diagExport =!= $Failed,
    If[FileExistsQ[diagPdf],
      diagramFiles = {diagPdf};,
      diagramFiles = FileNames["diagrams_*.pdf", diagDir];
      diagramFiles = SortBy[
        diagramFiles,
        Quiet@Check[
          ToExpression@StringReplace[FileBaseName[#], "diagrams_" -> ""],
          FileNameTake[#]
        ] &
      ];

      (* Best-effort merge to diagrams.pdf if pdfunite exists *)
      If[Length[diagramFiles] > 0,
        pu = Quiet@Check[StringTrim@RunProcess[{"bash", "-c", "command -v pdfunite"}, "StandardOutput"], ""];
        If[StringQ[pu] && StringLength[pu] > 0,
          rc = Quiet@Check[RunProcess[Join[{pu}, diagramFiles, {diagPdf}], "ExitCode"], 1];
          If[rc === 0 && FileExistsQ[diagPdf],
            diagramFiles = Prepend[diagramFiles, diagPdf];
          ];
        ]
      ];
    ];
  ];

  If[Length[diagramFiles] > 0,
    diagramIndex = FileNameJoin[{diagDir, "index.md"}];
    diagNames = FileNameTake /@ diagramFiles;
    md = StringRiffle[
      Join[
        {
          "# auto_qft diagrams",
          "",
          "- Generated by FeynArts `Paint`.",
          "- If `diagrams.pdf` exists, it is a best-effort merged PDF (requires `pdfunite`).",
          ""
        },
        {"## Files"},
        Map["- " <> # &, diagNames[[;; Min[Length[diagNames], 50]]]],
        If[Length[diagNames] > 50, {"- ... (truncated; list the directory for full set)"}, {}]
      ],
      "\n"
    ] <> "\n";
    Export[diagramIndex, md, "Text"];
    diagramIndexRel = "auto_qft/diagrams/index.md";
  ];
];

ampsFull = CreateFeynAmp[ins, Truncated -> True, PreFactor -> 1];
ampTerms = Cases[ampsFull, FeynAmp[__], Infinity];
If[Length[ampTerms] == 0, HepCalcFail["create_feynamp_failed", <|"result" -> ToString[ampsFull, InputForm]|>]];
ampCount = Length[ampTerms];
ampsRawPath = FileNameJoin[{ampDir, "amps_raw.m"}];
ampTermsPath = FileNameJoin[{ampDir, "amp_terms.m"}];
Put[ampsFull, ampsRawPath];
Put[ampTerms, ampTermsPath];
If[! FileExistsQ[ampsRawPath] || FileByteCount[ampsRawPath] <= 0,
  HepCalcFail["write_feynarts_amplitude_failed", <|"path" -> ampsRawPath|>]
];
ampsRawBytes = FileByteCount[ampsRawPath];
ampsRawSHA = Quiet@Check[FileHash[ampsRawPath, "SHA256", "HexString"], $Failed];
If[! StringQ[ampsRawSHA] || StringLength[ampsRawSHA] =!= 64,
  HepCalcFail["hash_feynarts_amplitude_failed", <|"path" -> ampsRawPath|>]
];
producerToken = CreateUUID["hep-calc-"];
producerEndedAt = DateString[Now, "ISODateTime"];
producerStatusPath = FileNameJoin[{autoDir, "producer_status.json"}];
formcalcHandoffPath = FileNameJoin[{autoDir, "formcalc", "handoff.json"}];
producerStatus = <|
  "stage" -> "auto_qft_feynarts_producer",
  "status" -> "PASS",
  "reason" -> "",
  "started_at" -> $HepCalcStartedAt,
  "ended_at" -> producerEndedAt,
  "token" -> producerToken,
  "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
  "handoff" -> "auto_qft/formcalc/handoff.json",
  "amplitude" -> <|
    "path" -> "auto_qft/amplitude/amps_raw.m",
    "bytes" -> ampsRawBytes,
    "sha256" -> ampsRawSHA,
    "head" -> ToString[Head[Head[ampsFull]], InputForm],
    "amp_count" -> ampCount
  |>
|>;
formcalcHandoff = <|
  "schema_version" -> 1,
  "stage" -> "auto_qft_formcalc_handoff",
  "status" -> "PASS",
  "created_at" -> producerEndedAt,
  "token" -> producerToken,
  "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
  "raw_path" -> "auto_qft/amplitude/amps_raw.m",
  "raw_bytes" -> ampsRawBytes,
  "raw_sha256" -> ampsRawSHA,
  "raw_head" -> ToString[Head[Head[ampsFull]], InputForm],
  "amp_count" -> ampCount,
  "pave_reduce" -> paveReduce,
  "memory_limit_mb" -> formcalcMemoryLimitMB
|>;
HepCalcWriteJSON[producerStatusPath, producerStatus];
HepCalcWriteJSON[formcalcHandoffPath, formcalcHandoff];

If[doPerDiagram,
  Do[
    Put[ampTerms[[i]], FileNameJoin[{ampDir, StringJoin["amp_raw_", IntegerString[i, 10, 3], ".m"]}]],
    {i, 1, ampCount}
  ];
];

(* FormCalc, when requested, is launched by the shell in a fresh kernel. *)
formcalcStatus = If[useFormCalcRequested, "NOT_RUN", "SKIPPED"];
formcalcReason = If[useFormCalcRequested, "fresh_kernel_reducer_pending", "disabled_by_job"];
ampBest = Total[ampTerms];
ampLevel = "feynarts";

ampOut = FileNameJoin[{ampDir, "amplitude_summed.m"}];
If[! useFormCalcRequested, Put[ampBest, ampOut]];

ampTexOut = "";
If[doAmpTeX && ! useFormCalcRequested,
  ampTexOut = FileNameJoin[{ampDir, "amplitude_summed.tex"}];
  Export[ampTexOut, ToString[TeXForm[ampBest]], "Text"];
];

ampMdOut = "";
If[doAmpMD && ! useFormCalcRequested,
  ampMdOut = FileNameJoin[{ampDir, "amplitude_summed.md"}];
  md = StringRiffle[
    {
      "# auto_qft amplitude (summed)",
      "",
      "- disclaimer: " <> ToString[If[ampLevel === "formcalc", "Amplitude is UNRENORMALIZED (UV poles may be present).", "Amplitude is a raw FeynArts expression (UNRENORMALIZED; FormCalc reduction not applied)."]],
      "- model: " <> modelName <> " (GenericModel=" <> genericModelName <> ")",
      "- loop_order: " <> ToString[loopOrder],
      "- insertion_level: " <> insLevel,
      "- adjacencies: " <> ToString[adjacencies, InputForm],
      "- counterterms: " <> ToString[counterTerms],
      "- ct_order: " <> ToString[ctOrder],
      "",
      "## Files",
      "",
      "- `amplitude_summed.m` (full Wolfram expression)",
      If[ampTexOut === "", "- `amplitude_summed.tex` not generated (set auto_qft.export.amplitude_tex: true)", "- `amplitude_summed.tex` (TeXForm, plain text)"],
      "",
      "## Wolfram Language InputForm",
      "",
      "```wl",
      ToString[InputForm[ampBest]],
      "```",
      ""
    },
    "\n"
  ];
  Export[ampMdOut, md, "Text"];
];

summary = <|
  "ts" -> DateString[Now, "ISODateTime"],
  "status" -> If[useFormCalcRequested, "NOT_RUN", "PASS"],
  "reason" -> If[useFormCalcRequested, "fresh_kernel_reducer_pending", Null],
  "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
  "disclaimer" -> If[ampLevel === "formcalc", "Amplitude is UNRENORMALIZED (UV poles may be present).", "Amplitude is a raw FeynArts expression (UNRENORMALIZED; FormCalc reduction not applied)."],
  "feynrules" -> If[useFeynArtsOnly, Null, <|"root" -> frRoot, "version" -> frVersion, "date" -> frDate|>],
  "model_files" -> modelFiles,
  "lagrangian_symbol" -> lagSym,
  "feynarts_model_patch" -> If[
    patchEnable,
    <|
      "enable" -> True,
      "patch_wls" -> patchWLS,
      "resolved" -> patchResolvedPath,
      "sha256" -> patchSHA,
      "status" -> patchStatus,
      "reason" -> patchReason,
      "notes" -> patchNotes
    |>,
    <|"enable" -> False, "status" -> "SKIPPED", "reason" -> "not_requested"|>
  ],
  "feynarts_model" -> If[
    useFeynArtsOnly,
    <|"name" -> modelName, "generic" -> genericModelName, "source" -> "builtin"|>,
    <|"name" -> modelName, "generic" -> genericModelName, "dir" -> modelDir, "files" -> {faMod, faGen, faPars}, "source" -> "feynrules_export"|>
  ],
  "process" -> <|
    "in" -> procIn,
    "out" -> procOut,
    "in_fa" -> (ToString[#, InputForm] & /@ inFieldsFA),
    "out_fa" -> (ToString[#, InputForm] & /@ outFieldsFA)
  |>,
  "options" -> <|
    "loop_order" -> loopOrder,
    "insertion_level" -> insLevel,
    "adjacencies" -> adjacencies,
    "exclude_topologies" -> excludeTokens,
    "counterterms" -> counterTerms,
    "ct_order" -> ctOrder,
    "formcalc" -> <|
      "enable" -> useFormCalcRequested,
      "status" -> formcalcStatus,
      "reason" -> formcalcReason,
      "pave_reduce" -> paveReduce,
      "memory_limit_mb" -> formcalcMemoryLimitMB,
      "reducer_status" -> "auto_qft/formcalc/status.json"
    |>,
    "pave_reduce" -> paveReduce,
    "export_diagrams" -> doDiagrams,
    "export_amplitude_tex" -> doAmpTeX,
    "export_per_diagram" -> doPerDiagram
  |>,
  "counts" -> <|"amps_raw_len" -> ampCount, "diagram_files" -> Length[diagramFiles]|>,
  "artifacts" -> <|
    "topologies" -> "auto_qft/topologies.m",
    "insertions" -> "auto_qft/insertions.m",
    "diagram_files" -> diagramFiles,
    "diagrams_index_md" -> diagramIndexRel,
    "amps_raw" -> "auto_qft/amplitude/amps_raw.m",
    "amp_terms" -> "auto_qft/amplitude/amp_terms.m",
    "producer_status" -> "auto_qft/producer_status.json",
    "formcalc_handoff" -> "auto_qft/formcalc/handoff.json",
    "amplitude_summed" -> If[useFormCalcRequested, Null, "auto_qft/amplitude/amplitude_summed.m"],
    "amplitude_summed_tex" -> If[ampTexOut === "", Null, "auto_qft/amplitude/amplitude_summed.tex"],
    "amplitude_summed_md" -> If[ampMdOut === "", Null, "auto_qft/amplitude/amplitude_summed.md"]
  |>
|>;

HepCalcWriteSummary[$HepCalcSummaryPath, summary];
  HepCalcWriteStatus[
    $HepCalcStatusPath,
    <|
      "stage" -> "auto_qft_one_loop",
      "status" -> summary["status"],
      "reason" -> summary["reason"],
      "started_at" -> $HepCalcStartedAt,
      "ended_at" -> DateString[Now, "ISODateTime"],
      "job" -> <|"path" -> $HepCalcJobRelativePath, "bytes" -> $HepCalcJobBytes, "sha256" -> $HepCalcJobSHA|>,
      "amplitude_level" -> ampLevel,
      "formcalc" -> <|
        "status" -> formcalcStatus,
        "reason" -> formcalcReason,
        "reducer_status" -> "auto_qft/formcalc/status.json"
      |>,
      "disclaimer" -> summary["disclaimer"]
    |>
  ];

If[MemberQ[{"PASS", "NOT_RUN"}, summary["status"]], Quit[0], Quit[21]];
