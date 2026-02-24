#!/usr/bin/env julia

using Dates

"""
eval_numeric.jl

Usage (positional):
  julia --startup-file=no eval_numeric.jl <job.resolved.json> <out_dir>

Reads:
  <out_dir>/symbolic/symbolic.json
Writes:
  <out_dir>/numeric/numeric.json
  <out_dir>/numeric/status.json
"""

struct JsonParser
    b::Vector{UInt8}
    i::Int
end

function _eof(p::JsonParser)
    return p.i > length(p.b)
end

function _peek(p::JsonParser)
    return _eof(p) ? UInt8(0) : p.b[p.i]
end

function _next!(p::JsonParser)
    c = _peek(p)
    return c, JsonParser(p.b, p.i + 1)
end

function _skipws(p::JsonParser)
    while !_eof(p)
        c = _peek(p)
        if c == 0x20 || c == 0x0a || c == 0x0d || c == 0x09
            p = JsonParser(p.b, p.i + 1)
        else
            break
        end
    end
    return p
end

function _expect(p::JsonParser, ch::Char)
    p = _skipws(p)
    if _peek(p) != UInt8(ch)
        error("Expected '$ch' at position $(p.i)")
    end
    _, p = _next!(p)
    return p
end

function _hexval(b::UInt8)
    if 0x30 <= b <= 0x39
        return Int(b - 0x30)
    elseif 0x41 <= b <= 0x46
        return Int(b - 0x41) + 10
    elseif 0x61 <= b <= 0x66
        return Int(b - 0x61) + 10
    end
    error("Invalid hex digit in \\u escape")
end

function _parse_u16(p::JsonParser)
    if p.i + 3 > length(p.b)
        error("Invalid \\u escape (truncated)")
    end
    a = _hexval(p.b[p.i])
    b = _hexval(p.b[p.i + 1])
    c = _hexval(p.b[p.i + 2])
    d = _hexval(p.b[p.i + 3])
    code = (a << 12) | (b << 8) | (c << 4) | d
    return code, JsonParser(p.b, p.i + 4)
end

function _parse_string(p::JsonParser)
    p = _expect(p, '"')
    buf = IOBuffer()
    while true
        if _eof(p)
            error("Unterminated string")
        end
        c = _peek(p)
        if c == UInt8('"')
            _, p = _next!(p)
            return String(take!(buf)), p
        elseif c == UInt8('\\')
            _, p = _next!(p)
            esc = _peek(p)
            _, p = _next!(p)
            if esc == UInt8('"') || esc == UInt8('\\') || esc == UInt8('/')
                write(buf, esc)
            elseif esc == UInt8('b')
                write(buf, UInt8(0x08))
            elseif esc == UInt8('f')
                write(buf, UInt8(0x0c))
            elseif esc == UInt8('n')
                write(buf, '\n')
            elseif esc == UInt8('r')
                write(buf, '\r')
            elseif esc == UInt8('t')
                write(buf, '\t')
            elseif esc == UInt8('u')
                code, p = _parse_u16(p)
                # Handle surrogate pairs
                if 0xD800 <= code <= 0xDBFF
                    # Expect \uXXXX for low surrogate
                    if p.i + 5 <= length(p.b) && p.b[p.i] == UInt8('\\') && p.b[p.i + 1] == UInt8('u')
                        p = JsonParser(p.b, p.i + 2)
                        low, p = _parse_u16(p)
                        if 0xDC00 <= low <= 0xDFFF
                            code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                        else
                            error("Invalid low surrogate in \\u escape")
                        end
                    else
                        error("Missing low surrogate for \\u escape")
                    end
                end
                write(buf, codeunits(String(Char(code))))
            else
                error("Invalid escape in string")
            end
        else
            write(buf, c)
            p = JsonParser(p.b, p.i + 1)
        end
    end
end

function _parse_number(p::JsonParser)
    p = _skipws(p)
    start = p.i
    i = p.i
    b = p.b
    while i <= length(b)
        c = b[i]
        if (UInt8('0') <= c <= UInt8('9')) || c == UInt8('-') || c == UInt8('+') || c == UInt8('.') || c == UInt8('e') || c == UInt8('E')
            i += 1
        else
            break
        end
    end
    token = String(copy(b[start:i-1]))
    p = JsonParser(b, i)
    if occursin('.', token) || occursin('e', lowercase(token))
        return parse(Float64, token), p
    end
    return parse(Int, token), p
end

function _match_bytes(p::JsonParser, lit::String)
    bytes = codeunits(lit)
    if p.i + length(bytes) - 1 > length(p.b)
        return false
    end
    for j in 1:length(bytes)
        if p.b[p.i + j - 1] != bytes[j]
            return false
        end
    end
    return true
end

function _parse_value(p::JsonParser)
    p = _skipws(p)
    c = _peek(p)
    if c == UInt8('{')
        return _parse_object(p)
    elseif c == UInt8('[')
        return _parse_array(p)
    elseif c == UInt8('"')
        return _parse_string(p)
    elseif c == UInt8('t')
        if _match_bytes(p, "true")
            return true, JsonParser(p.b, p.i + 4)
        end
        error("Invalid token at position $(p.i)")
    elseif c == UInt8('f')
        if _match_bytes(p, "false")
            return false, JsonParser(p.b, p.i + 5)
        end
        error("Invalid token at position $(p.i)")
    elseif c == UInt8('n')
        if _match_bytes(p, "null")
            return nothing, JsonParser(p.b, p.i + 4)
        end
        error("Invalid token at position $(p.i)")
    else
        return _parse_number(p)
    end
end

function _parse_array(p::JsonParser)
    p = _expect(p, '[')
    arr = Any[]
    p = _skipws(p)
    if _peek(p) == UInt8(']')
        _, p = _next!(p)
        return arr, p
    end
    while true
        v, p = _parse_value(p)
        push!(arr, v)
        p = _skipws(p)
        c = _peek(p)
        if c == UInt8(',')
            _, p = _next!(p)
            continue
        elseif c == UInt8(']')
            _, p = _next!(p)
            return arr, p
        else
            error("Expected ',' or ']' at position $(p.i)")
        end
    end
end

function _parse_object(p::JsonParser)
    p = _expect(p, '{')
    obj = Dict{String, Any}()
    p = _skipws(p)
    if _peek(p) == UInt8('}')
        _, p = _next!(p)
        return obj, p
    end
    while true
        k, p = _parse_string(p)
        p = _expect(p, ':')
        v, p = _parse_value(p)
        obj[k] = v
        p = _skipws(p)
        c = _peek(p)
        if c == UInt8(',')
            _, p = _next!(p)
            continue
        elseif c == UInt8('}')
            _, p = _next!(p)
            return obj, p
        else
            error("Expected ',' or '}' at position $(p.i)")
        end
    end
end

function json_load(path::String)
    b = read(path)
    v, p = _parse_value(JsonParser(b, 1))
    p = _skipws(p)
    if !_eof(p)
        error("Trailing content at position $(p.i)")
    end
    return v
end

function _json_escape(s::String)
    buf = IOBuffer()
    for c in s
        if c == '"'
            write(buf, "\\\"")
        elseif c == '\\'
            write(buf, "\\\\")
        elseif c == '\n'
            write(buf, "\\n")
        elseif c == '\r'
            write(buf, "\\r")
        elseif c == '\t'
            write(buf, "\\t")
        else
            write(buf, c)
        end
    end
    return String(take!(buf))
end

function json_dump(io::IO, v)
    if v === nothing
        write(io, "null")
    elseif v isa Bool
        write(io, v ? "true" : "false")
    elseif v isa Integer || v isa AbstractFloat
        write(io, string(v))
    elseif v isa String
        write(io, "\"", _json_escape(v), "\"")
    elseif v isa Dict
        write(io, "{")
        first = true
        for (k, vv) in v
            if !first
                write(io, ",")
            end
            first = false
            write(io, "\"", _json_escape(string(k)), "\":")
            json_dump(io, vv)
        end
        write(io, "}")
    elseif v isa AbstractVector
        write(io, "[")
        for (idx, vv) in enumerate(v)
            if idx > 1
                write(io, ",")
            end
            json_dump(io, vv)
        end
        write(io, "]")
    else
        write(io, "\"", _json_escape(string(v)), "\"")
    end
end

function json_dump(path::String, v)
    mkpath(dirname(path))
    open(path, "w") do io
        json_dump(io, v)
        write(io, "\n")
    end
end

function now_utc()
    return Dates.format(Dates.now(Dates.UTC), dateformat"yyyy-mm-ddTHH:MM:SS.sssZ")
end

function value_to_json(v)
    if v isa Complex
        return Dict("re" => real(v), "im" => imag(v))
    end
    return v
end

function main()
    if length(ARGS) < 2
        println("ERROR: expected args: <job.resolved.json> <out_dir>")
        return 2
    end
    job_path = ARGS[1]
    out_dir = ARGS[2]
    started = now_utc()

    sym_path = joinpath(out_dir, "symbolic", "symbolic.json")
    status_path = joinpath(out_dir, "numeric", "status.json")
    out_path = joinpath(out_dir, "numeric", "numeric.json")

    try
        if !isfile(sym_path)
            json_dump(out_path, Dict("schema_version" => 1, "generated_at" => now_utc(), "results" => Any[], "errors" => Any[]))
            json_dump(status_path, Dict(
                "stage" => "julia_numeric",
                "status" => "SKIPPED",
                "reason" => "missing_symbolic_json",
                "started_at" => started,
                "ended_at" => now_utc(),
            ))
            return 0
        end

        sym = json_load(sym_path)
        data = (sym isa AbstractDict) ? get(sym, "data", Dict{String,Any}()) : Dict{String,Any}()
        tasks = (data isa AbstractDict) ? get(data, "tasks", Any[]) : Any[]
        results = Any[]
        errors = Any[]

        if (tasks isa AbstractVector) && isempty(tasks)
            json_dump(out_path, Dict("schema_version" => 1, "generated_at" => now_utc(), "results" => Any[], "errors" => Any[]))
            json_dump(status_path, Dict(
                "stage" => "julia_numeric",
                "status" => "SKIPPED",
                "reason" => "no_tasks",
                "started_at" => started,
                "ended_at" => now_utc(),
                "counts" => Dict("total" => 0, "ok" => 0, "error" => 0, "skipped" => 0),
            ))
            return 0
        end

        # Load LoopTools only if needed.
        need_looptools = any(t -> (t isa AbstractDict) && get(t, "kind", "") == "looptools", tasks)
        if need_looptools
            try
                @eval using LoopTools
            catch e
                push!(errors, Dict("stage" => "import", "error" => string(e)))
            end
        end

        for t in tasks
            if !(t isa AbstractDict)
                push!(results, Dict("id" => "", "status" => "SKIPPED", "reason" => "task_not_an_object"))
                continue
            end
            id = get(t, "id", "")
            kind = get(t, "kind", "")
            if kind == "looptools"
                fn = get(t, "fn", "")
                args = get(t, "args", Any[])
                try
                    f = getproperty(LoopTools, Symbol(fn))
                    # Convert args to Float64 when possible
                    fargs = map(a -> a isa Integer ? float(a) : a, args)
                    val = Base.invokelatest(f, fargs...)
                    push!(results, Dict("id" => id, "status" => "OK", "value" => value_to_json(val), "kind" => kind, "fn" => fn, "args" => args))
                catch e
                    push!(results, Dict("id" => id, "status" => "ERROR", "error" => string(e), "kind" => kind, "fn" => fn, "args" => args))
                    push!(errors, Dict("id" => id, "error" => string(e)))
                end
            elseif kind == "julia_expr"
                expr = get(t, "expr", "")
                try
                    @warn "Executing julia_expr task (id=$(id)). Ensure the job input is trusted."
                    ex = Meta.parse(expr)
                    val = eval(ex)
                    push!(results, Dict("id" => id, "status" => "OK", "value" => value_to_json(val), "kind" => kind, "expr" => expr))
                catch e
                    push!(results, Dict("id" => id, "status" => "ERROR", "error" => string(e), "kind" => kind, "expr" => expr))
                    push!(errors, Dict("id" => id, "error" => string(e)))
                end
            else
                push!(results, Dict("id" => id, "status" => "SKIPPED", "reason" => "unsupported_kind", "kind" => kind))
            end
        end

        json_dump(out_path, Dict("schema_version" => 1, "generated_at" => now_utc(), "results" => results, "errors" => errors))

        st = Dict(
            "stage" => "julia_numeric",
            "status" => isempty(errors) ? "PASS" : "ERROR",
            "started_at" => started,
            "ended_at" => now_utc(),
            "counts" => Dict(
                "total" => length(tasks),
                "ok" => count(r -> get(r, "status", "") == "OK", results),
                "error" => count(r -> get(r, "status", "") == "ERROR", results),
                "skipped" => count(r -> get(r, "status", "") == "SKIPPED", results),
            ),
        )
        json_dump(status_path, st)

        return isempty(errors) ? 0 : 1
    catch e
        json_dump(out_path, Dict("schema_version" => 1, "generated_at" => now_utc(), "results" => Any[], "errors" => [Dict("stage" => "fatal", "error" => string(e))]))
        json_dump(status_path, Dict(
            "stage" => "julia_numeric",
            "status" => "ERROR",
            "reason" => "exception",
            "error" => string(e),
            "started_at" => started,
            "ended_at" => now_utc(),
        ))
        return 1
    end
end

exit(main())
