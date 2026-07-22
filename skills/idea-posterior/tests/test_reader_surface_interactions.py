"""Real-browser checks for dynamically generated argument-graph text."""

from __future__ import annotations

import html
import json
import os
import re
import signal
import shutil
import subprocess
from pathlib import Path

from test_render_argument_graph import base_beliefs, base_ir, run_renderer, write_package


VISIBLE_PROBABILITY_DIGITS = 3


def chrome_executable() -> str | None:
    candidates = [
        os.environ.get("CHROME_BIN"),
        shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def browser_probe(page: Path, tmp_path: Path) -> dict:
    chrome = chrome_executable()
    assert chrome is not None, "real-browser interaction evidence unavailable: Chrome not found"
    result_id = "reader-surface-result"
    harness = tmp_path / "reader-surface-harness.html"
    target = html.escape(page.resolve().as_uri(), quote=True)
    harness.write_text(
        f"""<!doctype html>
<meta charset="utf-8">
<pre id="{result_id}">pending</pre>
<iframe id="target" onload="probe()" src="{target}"></iframe>
<script>
function finish(value) {{
  document.getElementById('{result_id}').textContent = JSON.stringify(value);
}}
function probe() {{
  try {{
    var doc = document.getElementById('target').contentDocument;
    var controlIds = [];
    function captureControlIds() {{
      Array.from(doc.querySelectorAll('button,input,select,textarea')).forEach(
        function (element) {{
          if (!element.id) throw new Error('reader control lacks a stable id');
          if (!controlIds.includes(element.id)) controlIds.push(element.id);
        }}
      );
    }}
    var root = doc.querySelector('.node-root[data-id]');
    var initial = root.querySelector('.bval').textContent.trim() + ' ' +
      doc.querySelector('.posterior-pill').innerText;
    captureControlIds();
    root.dispatchEvent(new MouseEvent('click', {{ bubbles: true }}));
    var detail = doc.getElementById('panel').innerText;
    captureControlIds();
    var observed = doc.querySelector('.node-evidence[data-id]');
    observed.dispatchEvent(new MouseEvent('click', {{ bubbles: true }}));
    var observedDetail = doc.getElementById('panel').innerText;
    captureControlIds();
    var edge = doc.querySelector('.chip[data-edge]');
    edge.dispatchEvent(new PointerEvent('pointermove', {{
      bubbles: true, clientX: 20, clientY: 20
    }}));
    var tooltip = doc.getElementById('tooltip').innerText;
    captureControlIds();
    var legend = doc.getElementById('legend');
    legend.open = true;
    captureControlIds();
    var contract = doc.getElementById('reader-surface-contract');
    var expandableIds = Array.from(doc.querySelectorAll('details')).map(
      function (element) {{
        if (!element.id) throw new Error('reader expandable lacks a stable id');
        return element.id;
      }}
    );
    finish({{
      initial: initial,
      detail: detail,
      observed_detail: observedDetail,
      tooltip: tooltip,
      legend: legend.innerText,
      control_ids: controlIds,
      expandable_ids: expandableIds,
      contract: contract ? JSON.parse(contract.textContent) : null
    }});
  }} catch (error) {{
    finish({{ error: String(error), stack: error.stack || '' }});
  }}
}}
</script>
""",
        encoding="utf-8",
    )
    profile = tmp_path / "chrome-profile"
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-background-networking",
            "--no-first-run",
            f"--user-data-dir={profile}",
            "--allow-file-access-from-files",
            "--virtual-time-budget=3000",
            "--dump-dom",
            harness.resolve().as_uri(),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=5)
    assert stdout, stderr
    match = re.search(
        rf'<pre id="{result_id}">(.*?)</pre>', stdout, flags=re.DOTALL
    )
    assert match, stdout
    result = json.loads(html.unescape(match.group(1)))
    assert "error" not in result, result
    return result


def probability_tokens(text: str) -> list[str]:
    without_likelihood_ratios = re.sub(r"[×÷]\s*\d+(?:\.\d+)?", "", text)
    return re.findall(
        r"(?<![\d.])(?:0|1)\.\d+(?![\d.])", without_likelihood_ratios
    )


def test_probability_token_extraction_ignores_likelihood_ratios() -> None:
    text = "P(e|h)=0.750 · P(e|¬h)=0.250 · modest update (×1.5) (÷1.25)"
    assert probability_tokens(text) == ["0.750", "0.250"]


def test_interactive_visible_probabilities_share_static_precision(tmp_path: Path) -> None:
    package = write_package(tmp_path / "fixture", base_ir(), base_beliefs())
    rendered = run_renderer(package)
    assert rendered.returncode == 0, rendered.stderr

    result = browser_probe(package / "argument-graph.html", tmp_path)
    assert result["initial"] == "0.847 worth 0.847"
    assert result["detail"]
    assert result["observed_detail"]
    assert result["tooltip"]
    assert result["legend"]
    assert result["control_ids"] == [
        "themetoggle",
        "zout",
        "zin",
        "zfit",
        "panel-close",
    ]
    assert result["expandable_ids"] == ["legend"]
    assert result["contract"] == {
        "artifact": "argument_graph_reader_surface_contract_v1",
        "control_ids": ["themetoggle", "zout", "zin", "zfit", "panel-close"],
        "expandable_ids": ["legend"],
        "filter_controls": [],
        "formatter": "visible_probability_v1",
        "interaction_evidence_required": True,
        "interaction_states": [
            "edge_tooltip",
            "node_detail_panel",
            "expanded_legend",
        ],
        "static_states": ["initial_canvas"],
        "visible_probability_digits": VISIBLE_PROBABILITY_DIGITS,
    }
    for surface in ("initial", "detail", "observed_detail", "tooltip", "legend"):
        tokens = probability_tokens(result[surface])
        if surface != "legend":
            assert tokens, f"{surface} exposed no probability text"
        assert all(
            len(token.partition(".")[2]) == VISIBLE_PROBABILITY_DIGITS
            for token in tokens
        ), (surface, tokens)
