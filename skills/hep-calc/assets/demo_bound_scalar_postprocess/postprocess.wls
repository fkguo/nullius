boundText = HepCalcBoundInputText["bare_amplitude"];
If[boundText === $Failed, Abort[]];
ToExpression[boundText, InputForm];

localCounterterm = -coupling^2 uvPole;
finiteAmplitude = Expand[bareAmplitude + localCounterterm];
poleResidual = Coefficient[finiteAmplitude, uvPole];
finiteIdentityResidual = Expand[finiteAmplitude - coupling^2 finitePart];

HepCalcExportSymbolic[<|
  "assertions" -> {
    <|"id" -> "uv_pole_cancelled", "passed" -> TrueQ[PossibleZeroQ[poleResidual]]|>,
    <|"id" -> "finite_symbolic_identity", "passed" -> TrueQ[PossibleZeroQ[finiteIdentityResidual]]|>
  },
  "checks" -> <|
    "finite_amplitude" -> ToString[finiteAmplitude, InputForm]
  |>,
  "tasks" -> {},
  "notes" -> {"Generic scalar witness using a user-supplied local counterterm."}
|>];
