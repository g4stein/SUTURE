# Spec 02 §4.5 — Option C bridge: JS typed-array views -> one JsBuffer.assign_to memcpy per column into NumPy.
import builtins
import traceback
import time as _diag_time  # DIAG(temp)

import numpy as np
from pyodide.code import eval_code

_MAX_SAFE = 9007199254740991
_NP_DTYPE = {"date32": np.int32, "timestamp_us": np.int64}
_assign_count = 0


class _DivFlag:
    __slots__ = ("hit",)

    def __init__(self):
        self.hit = False

    def __call__(self, kind, flag):
        if kind == "divide by zero":
            self.hit = True


class _Inputs(dict):
    def __missing__(self, key):
        raise KeyError(f"undeclared input key {key!r}")


def _assign(js_buf, target):
    global _assign_count
    js_buf.assign_to(target)  # the single memcpy JS -> WASM linear memory
    _assign_count += 1


def _bits(js_bytes, bit_offset, n):
    raw = np.empty(js_bytes.byteLength, dtype=np.uint8)
    _assign(js_bytes, raw)
    return np.unpackbits(raw, bitorder="little")[bit_offset:bit_offset + n].astype(bool)


def _utf8(spec):
    out = []
    for c in spec.chunks:
        n = c.length
        offs = np.empty(n + 1, dtype=np.int32)
        _assign(c.offsets, offs)
        data = np.empty(c.data.byteLength, dtype=np.uint8)
        _assign(c.data, data)
        raw, base = data.tobytes(), int(offs[0])
        vals = [raw[int(offs[i]) - base:int(offs[i + 1]) - base].decode("utf-8") for i in range(n)]
        if c.hasValidity:
            valid = _bits(c.validity, c.validityBitOffset, n)
            vals = [v if ok else None for v, ok in zip(vals, valid)]
        out.extend(vals)
    return out


def _column(spec):
    if spec.dtype == "utf8":
        return _utf8(spec)
    n = spec.length
    if spec.dtype == "bool":
        vals = np.empty(n, dtype=bool)
        pos = 0
        for c in spec.chunks:
            vals[pos:pos + c.length] = _bits(c.data, c.bitOffset, c.length)
            pos += c.length
    else:
        vals = np.empty(n, dtype=_NP_DTYPE.get(spec.dtype, spec.dtype))
        pos = 0
        for c in spec.chunks:
            _assign(c.data, vals[pos:pos + c.length])
            pos += c.length
    if spec.dtype == "date32":
        vals = vals.astype("datetime64[D]")
    elif spec.dtype == "timestamp_us":
        vals = vals.view("datetime64[us]")
    if not any(c.hasValidity for c in spec.chunks):
        return vals
    mask = np.zeros(n, dtype=bool)
    pos = 0
    for c in spec.chunks:
        if c.hasValidity:
            mask[pos:pos + c.length] = ~_bits(c.validity, c.validityBitOffset, c.length)
        pos += c.length
    return np.ma.MaskedArray(vals, mask=mask)


def _range(v):
    rows, cols = int(v.rows), int(v.cols)
    if v.numeric:
        data = np.empty(rows * cols, dtype=np.float64)
        _assign(v.data, data)
        valid = np.empty(rows * cols, dtype=np.uint8)
        _assign(v.validity, valid)
        return np.ma.MaskedArray(data.reshape(rows, cols), mask=(valid == 0).reshape(rows, cols))
    vals = v.values.to_py()
    return [vals[r * cols:(r + 1) * cols] for r in range(rows)]


def _bind(v):
    k = v.kind
    if k == "scalar":
        t = v.type
        if t == "null":
            return None
        if t == "number":
            return float(v.value)
        if t == "boolean":
            return bool(v.value)
        return str(v.value)
    if k == "matrix":
        arr = np.empty(int(v.rows) * int(v.cols), dtype=np.float64)
        _assign(v.data, arr)
        return arr.reshape(int(v.rows), int(v.cols))
    if k == "table":
        return {c.name: _column(c) for c in v.columns}
    if k == "range":
        return _range(v)
    raise TypeError(f"unknown binding kind {k}")


def _to_result(v, div):
    if v is None:
        return ("null",)
    if isinstance(v, (bool, np.bool_)):
        return ("bool", bool(v))
    if isinstance(v, (int, np.integer)):
        iv = int(v)
        if abs(iv) > _MAX_SAFE:
            return ("err", "#NUM!", "integer exceeds 2^53-1")
        return ("num", float(iv), div)
    if isinstance(v, (float, np.floating)):
        return ("num", float(v), div)
    if isinstance(v, str):
        return ("str", v)
    if isinstance(v, np.ma.MaskedArray) and np.ma.is_masked(v):
        return ("err", "#PY!", "masked values cannot be returned")
    if isinstance(v, np.ndarray):
        if v.ndim == 0:
            return _to_result(v.item(), div)
        if v.dtype.kind not in "biuf":
            return ("err", "#PY!", f"unsupported array dtype {v.dtype}")
        if v.dtype.kind in "iu" and v.size and int(np.abs(v).max()) > _MAX_SAFE:
            return ("err", "#NUM!", "integer exceeds 2^53-1")
        if v.ndim == 1:
            v = v.reshape(-1, 1)
        if v.ndim != 2:
            return ("err", "#PY!", "arrays must be 0-, 1-, or 2-D")
        a = np.ascontiguousarray(v, dtype=np.float64)
        return ("mat", a.shape[0], a.shape[1], a, div)
    return ("err", "#PY!", f"unsupported return type {type(v).__name__}")


def _line(e, filename):
    for frame in reversed(traceback.extract_tb(e.__traceback__)):
        if frame.filename == filename:
            return f" (line {frame.lineno})"
    return ""


def _exec(code, filename, inputs, seed):
    _diag_started = _diag_time.time() * 1000.0  # DIAG(temp)
    np.random.seed(seed)
    ns = {"__builtins__": builtins, "np": np, "inputs": _Inputs(inputs), "rng": np.random.default_rng(seed)}
    flag = _DivFlag()
    try:
        with np.errstate(divide="call", call=flag):
            result = eval_code(code, globals=ns, filename=filename, return_mode="last_expr")
        return ("ok", result, flag.hit)
    except ZeroDivisionError as e:
        return ("err", "#DIV/0!", f"ZeroDivisionError: {e}")
    except KeyboardInterrupt:
        return ("interrupt", _diag_time.time() * 1000.0, _diag_started)  # DIAG(temp): caught / exec-start epoch ms
    except KeyError as e:
        msg = str(e.args[0]) if e.args else "KeyError"
        if msg.startswith("undeclared input key"):
            return ("err", "#PY!", msg)
        return ("err", "#PY!", f"KeyError: {msg}{_line(e, filename)}")
    except MemoryError:
        return ("err", "#PY!", "MemoryError")
    except BaseException as e:  # noqa: BLE001 — every Python failure is a cell value, never a crash
        return ("err", "#PY!", f"{type(e).__name__}: {e}{_line(e, filename)}")


def _finish(r):
    if r[0] == "ok":
        return _to_result(r[1], r[2])
    return r


def _stack(values):
    first = values[0]
    if all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) for v in values):
        data = np.array([0.0 if v is None else float(v) for v in values], dtype=np.float64)
        mask = np.array([v is None for v in values])
        return np.ma.MaskedArray(data, mask=mask) if mask.any() else data
    if all(isinstance(v, bool) for v in values):
        return np.array(values, dtype=bool)
    if all(isinstance(v, str) for v in values):
        return np.array(values, dtype=object)
    if isinstance(first, np.ndarray) and all(isinstance(v, np.ndarray) and v.shape == first.shape for v in values):
        return np.ma.stack(values) if any(isinstance(v, np.ma.MaskedArray) for v in values) else np.stack(values)
    return list(values)


def run_batch(code, vectorized, seed, shared, scenarios, filename):
    shared_vals = {b.key: _bind(b.value) for b in shared}
    if not vectorized:
        out = []
        for sc in scenarios:
            inputs = dict(shared_vals)
            for b in sc:
                inputs[b.key] = _bind(b.value)
            r = _exec(code, filename, inputs, seed)
            if r[0] == "interrupt":
                return [r]
            out.append(_finish(r))
        return out
    per = [{b.key: _bind(b.value) for b in sc} for sc in scenarios]
    n = len(per)
    inputs = dict(shared_vals)
    for k in (list(per[0].keys()) if n else []):
        inputs[k] = _stack([p[k] for p in per])
    r = _exec(code, filename, inputs, seed)
    if r[0] == "interrupt":
        return [r]
    if r[0] != "ok":
        return [r] * n
    try:
        values = list(r[1])
    except TypeError:
        return [("err", "#PY!", "a vectorized result must have one element per scenario")] * n
    if len(values) != n:
        return [("err", "#PY!", f"a vectorized result has {len(values)} elements for {n} scenarios")] * n
    return [_to_result(v, r[2]) for v in values]


def assign_count():
    return _assign_count


def numpy_version():
    return np.__version__
