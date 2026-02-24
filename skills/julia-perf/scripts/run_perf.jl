#!/usr/bin/env julia

using Dates
using SHA
using TOML
using BenchmarkTools
using JSON3
using Statistics

const USAGE = """
run_perf.jl

Usage:
  julia --project=scripts scripts/run_perf.jl --config <path> [options]

Required:
  --config <path>               Path to perf-config.toml

Options:
  --out-dir <path>              Explicit output directory override
  --mode <standalone|ecosystem|auto>
  --artifact-root <path>        Ecosystem root directory, e.g. artifacts/runs
  --tag <run_tag>               Ecosystem run tag
  --agent-id <id>               Optional writer namespace for parallel runs
  --save-baseline               Initialize/update baseline mode
  --help                        Show this help

Exit codes:
  0 pass
  1 hard fail
  2 soft warn only
  3 usage/config error
"""

function print_usage()
    println(USAGE)
end

function get_nested(cfg::Dict{String, Any}, path::Vector{String}, default)
    cur = cfg
    for (idx, key) in enumerate(path)
        if idx == length(path)
            return get(cur, key, default)
        end
        if !haskey(cur, key)
            return default
        end
        next_val = cur[key]
        if !(next_val isa Dict{String, Any})
            return default
        end
        cur = next_val
    end
    return default
end

function as_string_vector(value)::Vector{String}
    if value isa Vector
        return [string(v) for v in value]
    end
    return String[]
end

function parse_int(value, default::Int)
    if value isa Integer
        return Int(value)
    end
    if value isa AbstractString
        parsed = tryparse(Int, value)
        if parsed !== nothing
            return parsed
        end
    end
    return default
end

function parse_float(value, default::Float64)
    if value isa AbstractFloat
        return Float64(value)
    elseif value isa Integer
        return Float64(value)
    elseif value isa AbstractString
        parsed = tryparse(Float64, value)
        if parsed !== nothing
            return parsed
        end
    end
    return default
end

function parse_args(args::Vector{String})
    opts = Dict{String, Any}(
        "config" => nothing,
        "out_dir" => nothing,
        "mode" => nothing,
        "artifact_root" => nothing,
        "tag" => nothing,
        "agent_id" => nothing,
        "save_baseline" => false,
        "help" => false,
    )

    i = 1
    while i <= length(args)
        arg = args[i]
        if arg == "--help"
            opts["help"] = true
            i += 1
        elseif arg == "--save-baseline"
            opts["save_baseline"] = true
            i += 1
        elseif arg in ("--config", "--out-dir", "--mode", "--artifact-root", "--tag", "--agent-id")
            if i == length(args)
                error("Missing value for $(arg)")
            end
            value = args[i + 1]
            if arg == "--config"
                opts["config"] = value
            elseif arg == "--out-dir"
                opts["out_dir"] = value
            elseif arg == "--mode"
                opts["mode"] = value
            elseif arg == "--artifact-root"
                opts["artifact_root"] = value
            elseif arg == "--tag"
                opts["tag"] = value
            elseif arg == "--agent-id"
                opts["agent_id"] = value
            end
            i += 2
        else
            error("Unknown argument: $(arg)")
        end
    end

    if opts["help"] == true
        return opts
    end
    if opts["config"] === nothing
        error("--config is required")
    end
    mode = opts["mode"]
    if mode !== nothing && !(mode in ("standalone", "ecosystem", "auto"))
        error("--mode must be one of standalone|ecosystem|auto")
    end
    return opts
end

function resolve_path(base_dir::String, value)::Union{Nothing, String}
    if value === nothing
        return nothing
    end
    s = strip(string(value))
    if isempty(s)
        return nothing
    end
    return isabspath(s) ? s : normpath(joinpath(base_dir, s))
end

function choose_mode(cli_mode, cfg::Dict{String, Any}, artifact_root::Union{Nothing, String}, tag::Union{Nothing, String})
    mode = cli_mode
    if mode === nothing
        mode = get_nested(cfg, ["mode", "mode"], "auto")
    end
    mode = lowercase(string(mode))
    if mode == "auto"
        if artifact_root !== nothing && tag !== nothing
            return "ecosystem"
        end
        return "standalone"
    end
    return mode
end

function materialize_output_dir(raw_dir::String)
    resolved = abspath(raw_dir)
    latest_link = nothing
    if basename(resolved) == "latest"
        parent = dirname(resolved)
        mkpath(parent)
        ts = Dates.format(now(UTC), "yyyymmddTHHMMSS")
        run_dir = joinpath(parent, ts)
        mkpath(run_dir)
        latest_link = resolved
        try
            if ispath(latest_link)
                rm(latest_link; recursive=true, force=true)
            end
            symlink(ts, latest_link)
        catch
            # Symlink may fail on some systems; this is non-fatal.
        end
        return run_dir, latest_link
    end
    mkpath(resolved)
    return resolved, latest_link
end

function sha256_file(path::String)
    bytes = read(path)
    return bytes2hex(sha256(bytes))
end

function value_from_obj(obj, key::String, default=nothing)
    if obj isa Dict
        return get(obj, key, default)
    end
    try
        return obj[key]
    catch
        return default
    end
end

function normalize_benchmark_cases(raw)
    cases = Vector{Tuple{String, Function}}()
    warnings = String[]

    iter = raw isa Dict ? collect(raw) : raw
    if !(iter isa AbstractVector)
        push!(warnings, "benchmark suite object is not iterable")
        return cases, warnings
    end

    for item in iter
        name = nothing
        fn = nothing
        if item isa Pair
            name = string(first(item))
            fn = last(item)
        elseif item isa NamedTuple
            if (:name in keys(item)) && (:fn in keys(item))
                name = string(item[:name])
                fn = item[:fn]
            end
        elseif item isa Dict
            name_val = get(item, "name", get(item, :name, nothing))
            fn_val = get(item, "fn", get(item, :fn, nothing))
            if name_val !== nothing && fn_val !== nothing
                name = string(name_val)
                fn = fn_val
            end
        end

        if !(fn isa Function)
            push!(warnings, "invalid benchmark case dropped: expected callable function")
            continue
        end
        if name === nothing || isempty(strip(string(name)))
            push!(warnings, "invalid benchmark case dropped: missing name")
            continue
        end
        push!(cases, (strip(string(name)), fn))
    end

    return cases, warnings
end

function load_suite_cases(suite_file::String)
    warnings = String[]
    if !isfile(suite_file)
        push!(warnings, "suite file not found: $(suite_file)")
        return Tuple{String, Function}[], warnings
    end

    try
        include(suite_file)
    catch err
        push!(warnings, "failed to include suite file: $(sprint(showerror, err))")
        return Tuple{String, Function}[], warnings
    end

    raw = nothing
    if isdefined(Main, :JULIA_PERF_BENCHMARKS)
        raw = getfield(Main, :JULIA_PERF_BENCHMARKS)
    elseif isdefined(Main, :julia_perf_benchmarks)
        raw = Main.julia_perf_benchmarks()
    else
        push!(warnings, "suite did not define JULIA_PERF_BENCHMARKS or julia_perf_benchmarks()")
        return Tuple{String, Function}[], warnings
    end

    cases, norm_warnings = normalize_benchmark_cases(raw)
    append!(warnings, norm_warnings)
    return cases, warnings
end

function load_baseline_rows(path::String)
    rows_by_name = Dict{String, Dict{String, Any}}()
    if !isfile(path)
        return rows_by_name
    end

    text = read(path, String)
    parsed = try
        JSON3.read(text)
    catch
        return rows_by_name
    end

    rows = Any[]
    if parsed isa AbstractVector
        rows = parsed
    else
        maybe_rows = value_from_obj(parsed, "rows", nothing)
        if maybe_rows isa AbstractVector
            rows = maybe_rows
        end
    end

    for row in rows
        name = value_from_obj(row, "name", nothing)
        if name === nothing
            continue
        end
        rows_by_name[string(name)] = Dict{String, Any}(
            "median_ns" => value_from_obj(row, "current_median_ns", value_from_obj(row, "baseline_median_ns", nothing)),
            "allocations" => value_from_obj(row, "allocations", value_from_obj(row, "allocations_delta", nothing)),
            "memory_bytes" => value_from_obj(row, "memory_bytes", value_from_obj(row, "memory_bytes_delta", nothing)),
        )
    end
    return rows_by_name
end

function choose_evals(policy::String, cfg::Dict{String, Any}, estimate_ns::Float64)
    if policy == "fixed"
        return max(1, parse_int(get_nested(cfg, ["benchmark", "evals", "fixed_value"], 1), 1))
    end

    t1 = parse_float(get_nested(cfg, ["benchmark", "evals", "tier_1_threshold_ns"], 1000), 1000.0)
    t2 = parse_float(get_nested(cfg, ["benchmark", "evals", "tier_2_threshold_ns"], 1_000_000), 1_000_000.0)
    if estimate_ns < t1
        return 1000
    elseif estimate_ns < t2
        return 10
    else
        return 1
    end
end

function run_single_sample_ns(fn::F, evals::Int) where {F}
    t0 = time_ns()
    for _ in 1:evals
        fn()
    end
    elapsed = time_ns() - t0
    return Float64(elapsed) / Float64(evals)
end

function run_benchmark_case(name::String, fn::F, samples::Int, seconds::Float64, eval_policy::String, cfg::Dict{String, Any}) where {F}
    probe_samples = min(samples, 10)
    probe_times = Float64[]
    for _ in 1:probe_samples
        push!(probe_times, run_single_sample_ns(fn, 1))
    end
    estimate_ns = median(probe_times)
    evals = choose_evals(eval_policy, cfg, estimate_ns)

    # Respect wall-time budget approximately for long-running kernels.
    sample_times = Float64[]
    t_start = time()
    while length(sample_times) < samples
        push!(sample_times, run_single_sample_ns(fn, evals))
        if (time() - t_start) > seconds && length(sample_times) >= min(samples, 10)
            break
        end
    end

    current_median_ns = median(sample_times)
    # Warm-up before one-shot allocation sampling to reduce compilation noise.
    fn()
    alloc_bytes = @allocated fn()

    return Dict{String, Any}(
        "name" => name,
        "current_median_ns" => current_median_ns,
        "allocations" => alloc_bytes > 0 ? 1 : 0,
        "memory_bytes" => Int(alloc_bytes),
        "samples" => length(sample_times),
        "evals" => evals,
        "estimate_ns" => estimate_ns,
    )
end

function write_json(path::String, obj)
    open(path, "w") do io
        JSON3.write(io, obj)
        write(io, "\n")
    end
end

function main(args::Vector{String})
    opts = try
        parse_args(args)
    catch err
        println(stderr, "ERROR: ", sprint(showerror, err))
        print_usage()
        return 3
    end

    if opts["help"] == true
        print_usage()
        return 0
    end

    config_path = abspath(string(opts["config"]))
    if !isfile(config_path)
        println(stderr, "ERROR: config file not found: ", config_path)
        return 3
    end

    cfg = try
        TOML.parsefile(config_path)
    catch err
        println(stderr, "ERROR: failed to parse config: ", sprint(showerror, err))
        return 3
    end

    config_dir = dirname(config_path)
    artifact_root = resolve_path(config_dir, opts["artifact_root"] === nothing ? get_nested(cfg, ["integration", "artifact_root"], nothing) : opts["artifact_root"])
    tag = opts["tag"] === nothing ? get_nested(cfg, ["integration", "tag"], nothing) : opts["tag"]
    if tag !== nothing
        tag = strip(string(tag))
        isempty(tag) && (tag = nothing)
    end
    agent_id = opts["agent_id"] === nothing ? get_nested(cfg, ["integration", "agent_id"], "") : opts["agent_id"]
    agent_id = strip(string(agent_id))
    if isempty(agent_id)
        agent_id = nothing
    end

    mode = choose_mode(opts["mode"], cfg, artifact_root, tag)
    if mode == "ecosystem" && (artifact_root === nothing || tag === nothing)
        println(stderr, "ERROR: ecosystem mode requires artifact root and tag")
        return 3
    end

    configured_out_dir = resolve_path(config_dir, get_nested(cfg, ["output", "out_dir"], ".julia-perf/runs/latest"))
    cli_out_dir = resolve_path(config_dir, opts["out_dir"])
    output_root = if cli_out_dir !== nothing
        cli_out_dir
    elseif mode == "ecosystem"
        base = joinpath(artifact_root, tag, "julia-perf")
        agent_id === nothing ? base : joinpath(base, agent_id)
    else
        configured_out_dir === nothing ? abspath(".julia-perf/runs/latest") : configured_out_dir
    end

    resolved_out_dir, latest_link = materialize_output_dir(output_root)
    timestamp = Dates.format(now(UTC), dateformat"yyyy-mm-ddTHH:MM:SSZ")

    hard_failures = Vector{Dict{String, Any}}()
    soft_warnings = Vector{Dict{String, Any}}()
    notes = String[]

    save_baseline = opts["save_baseline"] == true
    baseline_file_cfg = resolve_path(config_dir, get_nested(cfg, ["benchmark", "baseline_file"], ""))
    has_baseline = baseline_file_cfg !== nothing && isfile(baseline_file_cfg)
    if !save_baseline && !has_baseline
        push!(hard_failures, Dict("check_id" => "missing-baseline", "detail" => "No baseline file and --save-baseline not provided"))
    elseif save_baseline
        push!(notes, "Baseline initialization mode enabled")
    end

    suite_file = resolve_path(config_dir, get_nested(cfg, ["benchmark", "suite_file"], ""))
    if suite_file === nothing
        push!(soft_warnings, Dict("check_id" => "missing-suite", "detail" => "benchmark.suite_file is empty"))
        suite_file = ""
    end

    cases, suite_warnings = load_suite_cases(suite_file)
    for msg in suite_warnings
        push!(soft_warnings, Dict("check_id" => "suite-warning", "detail" => msg))
    end

    samples = parse_int(get_nested(cfg, ["benchmark", "samples"], 100), 100)
    seconds = parse_float(get_nested(cfg, ["benchmark", "seconds"], 30), 30.0)
    timeout_seconds = parse_int(get_nested(cfg, ["benchmark", "timeout_seconds"], 600), 600)
    eval_policy = lowercase(string(get_nested(cfg, ["benchmark", "evals", "policy"], "auto")))

    benchmark_rows = Vector{Dict{String, Any}}()
    if !isempty(cases)
        for (name, fn) in cases
            row = try
                Base.invokelatest(run_benchmark_case, name, fn, samples, seconds, eval_policy, cfg)
            catch err
                push!(hard_failures, Dict("check_id" => "benchmark-execution-failed", "detail" => "$(name): $(sprint(showerror, err))"))
                continue
            end
            push!(benchmark_rows, row)
        end
    end

    if isempty(benchmark_rows)
        push!(notes, "No benchmark rows produced")
    end

    baseline_rows = baseline_file_cfg === nothing ? Dict{String, Dict{String, Any}}() : load_baseline_rows(baseline_file_cfg)
    for row in benchmark_rows
        name = row["name"]
        if haskey(baseline_rows, name)
            base = baseline_rows[name]
            base_median = value_from_obj(base, "median_ns", nothing)
            base_alloc = value_from_obj(base, "allocations", nothing)
            base_mem = value_from_obj(base, "memory_bytes", nothing)

            if base_median === nothing
                row["baseline_median_ns"] = nothing
                row["ratio"] = nothing
            else
                row["baseline_median_ns"] = parse_float(base_median, 0.0)
                row["ratio"] = row["current_median_ns"] / max(row["baseline_median_ns"], eps(Float64))
            end

            if base_alloc === nothing
                row["allocations_delta"] = nothing
            else
                row["allocations_delta"] = row["allocations"] - parse_int(base_alloc, 0)
            end

            if base_mem === nothing
                row["memory_bytes_delta"] = nothing
            else
                row["memory_bytes_delta"] = row["memory_bytes"] - parse_int(base_mem, 0)
            end
        else
            row["baseline_median_ns"] = nothing
            row["ratio"] = nothing
            row["allocations_delta"] = nothing
            row["memory_bytes_delta"] = nothing
        end
    end

    active_project = Base.active_project()
    manifest_path = active_project == nothing ? nothing : joinpath(dirname(active_project), "Manifest.toml")
    manifest_hash = (manifest_path !== nothing && isfile(manifest_path)) ? sha256_file(manifest_path) : "missing"
    if manifest_hash == "missing"
        push!(notes, "Manifest.toml not found; reproducibility hash unavailable")
    end

    manifest = Dict(
        "schema_version" => 1,
        "tool" => "julia-perf",
        "tool_version" => "0.2.0",
        "timestamp_utc" => timestamp,
        "mode" => mode,
        "config_path" => config_path,
        "output_dir" => resolved_out_dir,
        "latest_link" => latest_link,
        "julia_version" => string(VERSION),
        "threads" => Threads.nthreads(),
        "os" => string(Sys.KERNEL),
        "cpu" => try
            Sys.CPU_NAME
        catch
            "unknown"
        end,
        "active_project" => active_project,
        "manifest_toml_sha256" => manifest_hash,
        "benchmark_timeout_seconds" => timeout_seconds,
        "benchmark_samples" => samples,
        "benchmark_seconds" => seconds,
        "benchmark_evals_policy" => eval_policy,
    )

    verdict = "PASS"
    exit_code = 0
    if !isempty(hard_failures)
        verdict = "FAIL"
        exit_code = 1
    elseif !isempty(soft_warnings)
        verdict = "WARN"
        exit_code = 2
    end

    summary = Dict(
        "verdict" => verdict,
        "exit_code" => exit_code,
        "hard_failures" => hard_failures,
        "soft_warnings" => soft_warnings,
        "timestamp_utc" => timestamp,
        "mode" => mode,
        "notes" => notes,
    )

    write_json(joinpath(resolved_out_dir, "manifest.json"), manifest)
    write_json(joinpath(resolved_out_dir, "benchmarks.json"), benchmark_rows)
    write_json(joinpath(resolved_out_dir, "summary.json"), summary)

    open(joinpath(resolved_out_dir, "diagnostics.md"), "w") do io
        println(io, "# Julia Perf Diagnostics")
        println(io)
        println(io, "- timestamp: ", timestamp)
        println(io, "- mode: ", mode)
        println(io, "- verdict: ", verdict)
        println(io)
        println(io, "## Hard Failures")
        if isempty(hard_failures)
            println(io, "- none")
        else
            for item in hard_failures
                println(io, "- ", item["check_id"], ": ", item["detail"])
            end
        end
        println(io)
        println(io, "## Soft Warnings")
        if isempty(soft_warnings)
            println(io, "- none")
        else
            for item in soft_warnings
                println(io, "- ", item["check_id"], ": ", item["detail"])
            end
        end
        println(io)
        println(io, "## Notes")
        if isempty(notes)
            println(io, "- none")
        else
            for note in notes
                println(io, "- ", note)
            end
        end
    end

    println("wrote artifacts to: ", resolved_out_dir)
    println("verdict: ", verdict)
    return exit_code
end

exit(main(ARGS))
