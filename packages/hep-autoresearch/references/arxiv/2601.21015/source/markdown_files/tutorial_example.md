# Tutorial 5: BSM Effective Field Theories in MadGraph

In this tutorial you will extend the Standard Model simulations you have already performed to include Beyond-the-Standard-Model (BSM) effects described by Effective Field Theories (EFTs). EFTs add higher-dimensional operators to the Standard Model, weighted by **Wilson coefficients** that parameterize possible new physics at scales beyond direct reach.

You will learn how to:

- Import an EFT UFO model into MadGraph5_aMC@NLO (MG5_aMC).
- Identify EFT-specific parameters (Wilson coefficients) in `param_card.dat`.
- Generate simple LHC processes (such as Drell–Yan–like channels) with EFT contributions at parton level.
- Organize multiple runs corresponding to different EFT parameter points in preparation for later Simulation-Based Inference (SBI) studies.

> **Important:** Treat this tutorial directory as read-only instructions. Do all your own work, models, cards, scripts, and runs in:
>
> - `/output/tutorials/my_work/05_bsm_eft_models`

You can consult this `README.md` at any time while working in your own area.

---

## 1. Prerequisites

Before starting this tutorial, you should:

- Have completed Tutorials 1–4:
  - MG5 basics and the MG5 → Pythia → Delphes pipeline.
  - Standard Model Drell–Yan generation at parton level.
  - Pythia showering and hadronization.
  - Delphes detector simulation.
- Be comfortable with:
  - Defining and generating processes in MG5.
  - Locating and editing `run_card.dat` and `param_card.dat`.
  - Running Pythia and Delphes via MG5’s run interface (conceptually, you will still focus mainly on the hard-scattering stage here).
- Have a basic conceptual understanding of EFTs:
  - The idea of extending the Standard Model Lagrangian with higher-dimensional operators.
  - The role of Wilson coefficients as parameters controlling the strength of these operators.

All practical work for this tutorial should be carried out in:

- `/output/tutorials/my_work/05_bsm_eft_models`

---

## 2. UFO models and EFTs in MG5

MG5 uses **UFO models** (Universal FeynRules Output) to encode the particle content, interactions, and parameters of a theory. A UFO model typically provides:

- A list of particles (including any new states).
- A set of parameters (masses, couplings, mixing angles, Wilson coefficients, etc.).
- The interaction vertices needed to build amplitudes.

### 2.1 Standard Model vs. EFT-extended models

- The default Standard Model implementation (e.g. `sm`) contains only Standard Model particles and parameters.
- An EFT-extended UFO model adds **new parameters** that represent coefficients of higher-dimensional operators, often denoted symbolically as $C_i$ or similar.
- In many EFT models, no new light particles are introduced; instead, the new physics manifests through modified interactions among existing Standard Model fields.

### 2.2 Importing an EFT UFO model

To use an EFT model, you first need a UFO implementation installed in a location MG5 can see (for example, inside the `models/` directory of your MG5 installation or in a path you configure explicitly). The exact model name and installation procedure depend on your local setup and chosen EFT.

At the MG5 prompt, you typically import the model via:

```text
MG5_aMC > import model MODEL_NAME
```

Here `MODEL_NAME` is a placeholder for the EFT UFO model you have installed. Examples in the literature include SMEFT-like models or simplified contact-interaction models, but this tutorial remains agnostic about the specific choice.

Once imported, you can inspect the model’s content:

```text
MG5_aMC > display particles
MG5_aMC > display parameters
MG5_aMC > display interactions
```

Look for new parameters and interactions compared to the pure Standard Model.

---

## 3. EFT parameters and `param_card.dat`

The **param card** (`param_card.dat`) in a process directory stores numerical values for all model parameters, including any EFT additions.

### 3.1 Locating EFT parameters (Wilson coefficients)

After importing an EFT model and generating a process (see Section 4), MG5 will create a process directory with a `Cards/param_card.dat`. Inside this file, you should find:

- Standard Model parameters (masses, gauge couplings, etc.).
- Additional parameters corresponding to EFT operators (e.g. Wilson coefficients), usually grouped into dedicated blocks.

You can identify EFT parameters by:

- Reading block names and comments in `param_card.dat`.
- Comparing with the model’s documentation to understand which operators each parameter controls.

### 3.2 Modifying EFT parameters

There are two common ways to change EFT parameter values:

1. **Editing `param_card.dat` directly**
   - Open `Cards/param_card.dat` in a text editor.
   - Locate the block and entries corresponding to the parameters you want to modify.
   - Change the numerical values as desired.

2. **Using MG5 `set param_card` commands** (when supported)
   - Within the MG5 run interface, you can often use commands like:

     ```text
     > set param_card NAME INDEX VALUE
     ```

     where `NAME` and `INDEX` identify the parameter and `VALUE` is the new numerical value.

   - The exact syntax and availability depend on the model and MG5 version; use `help set` within MG5 for details.

In this tutorial, you do **not** need any specific “correct” values for EFT parameters. Instead, you will pick a few representative settings (keeping them within modest ranges suggested by the model documentation) and compare the resulting event samples qualitatively.

> **Note:** Always keep track of which param card you used for each run. Saving copies of `param_card.dat` with descriptive filenames can help you later when building SBI datasets.

---

## 4. Simple EFT processes at the LHC

To connect with your earlier work, you can consider processes where EFT operators modify familiar Standard Model channels.

### 4.1 Drell–Yan–like processes

EFT operators can alter dilepton production at the LHC, for example in processes of the form

$$p p \to \ell^+ \ell^- + X,$$

where new four-fermion or gauge–fermion operators modify the kinematics or overall rates compared to the pure Standard Model.

Using an EFT UFO model, you can define a Drell–Yan–like process similarly to the Standard Model case, but with the EFT model active:

```text
MG5_aMC > import model MODEL_NAME
MG5_aMC > define p = g u c d s u~ c~ d~ s~
MG5_aMC > define l+ = e+ mu+
MG5_aMC > define l- = e- mu-
MG5_aMC > generate p p > l+ l-
MG5_aMC > output EFT_DY_ll
```

Here `MODEL_NAME` stands for your chosen EFT model. The process definition is structurally similar to the Standard Model Drell–Yan case, but now EFT interactions are available in the amplitude.

### 4.2 Other illustrative processes

Depending on your EFT model, other channels might be interesting:

- Diboson production, e.g. $p p \to W^+ W^- + X$.
- Contact-interaction–like processes involving jets and leptons.

You can define such processes in the same way, using `generate` with the EFT model imported.

### 4.3 Workflow summary

A typical EFT simulation workflow at parton level is:

1. Start MG5 and import the EFT model.
2. Define any multiparticle labels (e.g. `p`, `l+`, `l-`).
3. Generate the process of interest.
4. Output the process directory.
5. Inspect and modify `Cards/param_card.dat` to set EFT parameters.
6. Launch parton-level runs (and, if desired, subsequent Pythia and Delphes steps) using `launch`.

You can then compare EFT-deformed samples to their Standard Model counterparts following similar steps but using the Standard Model model file.

---

## 5. Parameter scans and organizing multiple runs

In many EFT studies, you are interested not just in a single point in parameter space, but in how observables change as Wilson coefficients vary.

### 5.1 Conceptual view of a parameter scan

A simple parameter scan might involve:

- Choosing one or more EFT parameters (e.g. one coefficient $C$ and possibly additional ones).
- Selecting a set of parameter points (different choices of $C$ values) that sample a range of interest.
- Generating event samples for each parameter point under consistent simulation settings (beam energy, cuts, PDFs, shower and detector configurations).

The objective is to build a collection of samples that can later be turned into SBI-ready datasets, where each sample is labeled by its underlying parameter values.

### 5.2 Organizing multiple runs

There are several ways to organize multiple EFT runs. For example:

- **Single process directory with multiple runs**
  - Use one process directory (e.g. `EFT_DY_ll`).
  - For each parameter point, copy or edit `param_card.dat` and launch a new run with a distinct run label.
  - Keep a record of which param card corresponds to each run (e.g. by saving a copy in a dedicated subdirectory).

- **Multiple process directories**
  - Create separate process directories for different parameter configurations or for SM vs. EFT comparisons.
  - This can make bookkeeping simpler but may duplicate code and increase disk usage.

Whichever approach you choose, it is important to:

- Maintain a clear naming scheme that encodes which EFT parameters were used.
- Store param cards and run logs alongside event files.
- Record random seeds and software versions when possible.

### 5.3 Metadata for later analysis

For future SBI work, you will want to know, for each event sample:

- Which process and model were used.
- Which EFT parameters (and their values) were active.
- Which run card settings (e.g. cuts, beam energy) were applied.
- Which versions of MG5, Pythia, and Delphes were used.
- How many events were generated and which random seeds were used.

A simple way to capture this information is to create a lightweight metadata file (for example, in JSON or YAML format) in each run directory, summarizing the key settings. You will formalize this further in Tutorial 6.

---

## 6. Exercises (no solutions or numeric answers in this file)

Carry out all hands-on tasks in your own workspace:

- `/output/tutorials/my_work/05_bsm_eft_models`

This `README.md` provides prompts only. It does not contain solutions, numeric answers, or fully worked command files.

### Exercise 1 – Importing an EFT model and inspecting its content

1. Install or locate an EFT UFO model accessible to your MG5 installation.
2. In MG5, use `import model` to load this EFT model.
3. Use `display particles`, `display parameters`, and `display interactions` to identify:
   - Any new particles compared to the Standard Model.
   - New parameters that correspond to EFT operators or Wilson coefficients.
4. In your notes, summarize how the EFT model extends the Standard Model content.

### Exercise 2 – Generating an EFT-extended Drell–Yan–like process

1. Using your EFT model, define multiparticle labels for proton beams and leptons.
2. Generate a Drell–Yan–like process (e.g. with an oppositely charged lepton pair in the final state) using the EFT model.
3. Output the process to a new directory in your work area and inspect the `Cards/param_card.dat` file.
4. Identify which parameters in `param_card.dat` correspond to EFT operators that can affect your chosen process.

### Exercise 3 – Varying one EFT parameter and comparing samples

1. Choose one EFT parameter (for example, a single Wilson coefficient) that is relevant for your process.
2. Define a small set of distinct parameter choices for this coefficient.
3. For each choice, modify `param_card.dat` accordingly and run a parton-level simulation (and optionally Pythia and Delphes).
4. Compare the resulting samples qualitatively, focusing on how selected observables (such as dilepton invariant mass or angular distributions) appear to change.

### Exercise 4 – Organizing runs and naming conventions

1. Design a naming scheme for process directories and run labels that encodes:
   - The process type (e.g. Drell–Yan).
   - The EFT model name.
   - The values (or labels) of the EFT parameters used.
2. Apply this scheme consistently to the runs you produced in Exercises 2 and 3.
3. Create a short documentation file in your work area that explains the naming convention and how to interpret each component.

### Exercise 5 – Extending to additional processes

1. Choose a second process (for example, a diboson or contact-interaction–like channel) where your EFT model is expected to have an impact.
2. Generate EFT-extended events for this process using at least two different EFT parameter settings.
3. Compare, in qualitative terms, how the EFT effects manifest differently in this process compared to the Drell–Yan–like case.
4. Update your run organization and naming scheme to accommodate multiple processes.

### Exercise 6 – Planning for SBI datasets

1. Based on your EFT runs, list the key pieces of information you would want recorded in a metadata file for each sample (e.g. process name, model name, EFT parameters, run card settings, number of events, seeds).
2. Sketch, in a text document or pseudocode, how you would automatically generate such metadata files after each run.
3. Reflect on how this metadata will help when you later prepare datasets for SBI in Tutorial 6.

---

By completing this tutorial, you will have learned how to incorporate EFT UFO models into MG5, control EFT parameters via `param_card.dat`, and organize multiple runs across parameter space. These skills are essential for building EFT-aware datasets suitable for Simulation-Based Inference.
