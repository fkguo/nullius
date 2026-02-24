#!/usr/bin/env python3
"""
CPU-only toy training run that emits the deep-learning-lab artifact trio:
- manifest.json (code/env/data provenance/hparams/seed)
- summary.json  (stable metrics + definitions + best checkpoint pointer)
- analysis.json  (training curves + headline results)

Acceptance (example):
  python3 examples/toy_run.py --out-dir /tmp/dl_run --seed 0
"""

from __future__ import annotations

import argparse
import json
import math
import random
import struct
import sys
import time
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dl_lab.artifacts import (  # noqa: E402
    ARTIFACT_SCHEMA_VERSION,
    ArtifactPaths,
    collect_environment,
    get_git_metadata,
    sha256_file,
    write_json,
)


def _randn(rng: random.Random) -> float:
    # Box–Muller (deterministic given rng.random())
    u1 = max(rng.random(), 1e-12)
    u2 = rng.random()
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _sigmoid(z: float) -> float:
    if z >= 0.0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _bce_with_logits(logit: float, y: int) -> float:
    # Stable binary cross-entropy; y in {0,1}
    if logit >= 0.0:
        return (1 - y) * logit + math.log1p(math.exp(-logit))
    return -y * logit + math.log1p(math.exp(logit))


def _accuracy_from_logit(logit: float, y: int) -> int:
    # sigmoid(logit) >= 0.5  <=>  logit >= 0
    pred = 1 if logit >= 0.0 else 0
    return 1 if pred == y else 0


def _evaluate(data: list[tuple[list[float], int]], w: list[float], b: float) -> tuple[float, float]:
    total_loss = 0.0
    total_correct = 0
    for x, y in data:
        logit = _dot(w, x) + b
        total_loss += _bce_with_logits(logit, y)
        total_correct += _accuracy_from_logit(logit, y)
    n = max(len(data), 1)
    return total_loss / n, total_correct / n


def _dataset_sha256(data: list[tuple[list[float], int]]) -> str:
    h = sha256()
    for x, y in data:
        for v in x:
            h.update(struct.pack("!d", float(v)))
        h.update(struct.pack("!b", int(y)))
    return h.hexdigest()


def _load_run_card(path: Path) -> dict[str, Any]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise TypeError("run-card JSON must be an object")
    return obj


def _round8(x: float) -> float:
    return float(f"{x:.8f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--epochs", type=int, default=None)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--run-card", type=Path, default=None, help="Optional JSON run-card (seed/hparams/data).")
    args = ap.parse_args()

    run_card: dict[str, Any] = {}
    run_card_path: Optional[Path] = None
    run_card_sha256: Optional[str] = None
    if args.run_card is not None:
        run_card_path = args.run_card.expanduser().resolve()
        run_card = _load_run_card(run_card_path)
        run_card_sha256 = sha256_file(run_card_path)

    hparams_rc = run_card.get("hyperparameters", {}) if isinstance(run_card.get("hyperparameters", {}), dict) else {}
    data_rc = run_card.get("data", {}) if isinstance(run_card.get("data", {}), dict) else {}

    seed = int(args.seed if args.seed is not None else run_card.get("seed", 0))
    epochs = int(args.epochs if args.epochs is not None else hparams_rc.get("epochs", 10))
    lr = float(args.lr if args.lr is not None else hparams_rc.get("lr", 0.2))
    batch_size = int(args.batch_size if args.batch_size is not None else hparams_rc.get("batch_size", 64))

    n_train = int(data_rc.get("n_train", 512))
    n_val = int(data_rc.get("n_val", 256))
    n_features = int(data_rc.get("n_features", 6))
    noise_std = float(data_rc.get("noise_std", 0.3))

    run_dir = args.out_dir.expanduser().resolve()
    paths = ArtifactPaths.in_dir(run_dir)
    paths.run_dir.mkdir(parents=True, exist_ok=True)

    started_at = time.time()

    rng = random.Random(seed)
    w_true = [_randn(rng) for _ in range(n_features)]
    b_true = _randn(rng)

    def sample() -> tuple[list[float], int]:
        x = [_randn(rng) for _ in range(n_features)]
        logit = _dot(w_true, x) + b_true + noise_std * _randn(rng)
        y = 1 if logit > 0.0 else 0
        return x, y

    train = [sample() for _ in range(n_train)]
    val = [sample() for _ in range(n_val)]
    train_sha256 = _dataset_sha256(train)
    val_sha256 = _dataset_sha256(val)

    w = [0.0 for _ in range(n_features)]
    b = 0.0

    best = {
        "epoch": 0,
        "val_loss": float("inf"),
        "val_accuracy": 0.0,
        "train_loss": float("inf"),
        "train_accuracy": 0.0,
    }

    history: list[dict[str, Any]] = []
    indices = list(range(len(train)))
    for epoch in range(1, epochs + 1):
        rng.shuffle(indices)
        for start in range(0, len(indices), batch_size):
            batch_idx = indices[start : start + batch_size]
            if not batch_idx:
                continue
            grad_w = [0.0 for _ in range(n_features)]
            grad_b = 0.0
            for i in batch_idx:
                x, y = train[i]
                logit = _dot(w, x) + b
                p = _sigmoid(logit)
                g = p - y
                for k in range(n_features):
                    grad_w[k] += g * x[k]
                grad_b += g
            scale = 1.0 / len(batch_idx)
            for k in range(n_features):
                w[k] -= lr * grad_w[k] * scale
            b -= lr * grad_b * scale

        train_loss, train_acc = _evaluate(train, w, b)
        val_loss, val_acc = _evaluate(val, w, b)

        history.append(
            {
                "epoch": epoch,
                "train_loss": _round8(train_loss),
                "train_accuracy": _round8(train_acc),
                "val_loss": _round8(val_loss),
                "val_accuracy": _round8(val_acc),
            }
        )

        if val_loss < best["val_loss"]:
            best = {
                "epoch": epoch,
                "val_loss": val_loss,
                "val_accuracy": val_acc,
                "train_loss": train_loss,
                "train_accuracy": train_acc,
            }
            ckpt_path = paths.run_dir / "checkpoints" / "best.json"
            write_json(
                ckpt_path,
                {
                    "schema_version": ARTIFACT_SCHEMA_VERSION,
                    "epoch": epoch,
                    "model": {"type": "logreg", "weights": [_round8(x) for x in w], "bias": _round8(b)},
                    "selected_by": "val_loss",
                    "metrics": {
                        "val_loss": _round8(val_loss),
                        "val_accuracy": _round8(val_acc),
                        "train_loss": _round8(train_loss),
                        "train_accuracy": _round8(train_acc),
                    },
                },
            )

    finished_at = time.time()
    duration_s = finished_at - started_at

    metric_definitions = {
        "train_loss_best": {
            "definition": "Average binary cross-entropy (with logits) on the train split at best epoch.",
            "unit": "nats",
            "higher_is_better": False,
        },
        "val_loss_best": {
            "definition": "Average binary cross-entropy (with logits) on the validation split at best epoch.",
            "unit": "nats",
            "higher_is_better": False,
        },
        "train_accuracy_best": {
            "definition": "Accuracy on the train split at best epoch (threshold=0.5).",
            "unit": "fraction",
            "higher_is_better": True,
        },
        "val_accuracy_best": {
            "definition": "Accuracy on the validation split at best epoch (threshold=0.5).",
            "unit": "fraction",
            "higher_is_better": True,
        },
        "best_epoch": {
            "definition": "Epoch index that minimized val_loss.",
            "unit": "epoch",
            "higher_is_better": False,
        },
        "duration_seconds": {
            "definition": "Wall-clock duration of this run in seconds.",
            "unit": "s",
            "higher_is_better": False,
        },
    }

    summary_metrics: dict[str, Any] = {
        "train_loss_best": _round8(best["train_loss"]),
        "val_loss_best": _round8(best["val_loss"]),
        "train_accuracy_best": _round8(best["train_accuracy"]),
        "val_accuracy_best": _round8(best["val_accuracy"]),
        "best_epoch": int(best["epoch"]),
        "duration_seconds": _round8(duration_s),
    }

    summary = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(finished_at)),
        "primary_metric": "val_loss_best",
        "metrics": summary_metrics,
        "metric_definitions": metric_definitions,
        "best_checkpoint": {
            "path": "checkpoints/best.json",
            "selected_by": "val_loss",
            "metric_value": _round8(best["val_loss"]),
            "epoch": int(best["epoch"]),
        },
    }
    write_json(paths.summary, summary)

    analysis = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "created_at": summary["created_at"],
        "results": {
            # keep flat keys for research-writer quoting
            "val_loss_best": summary_metrics["val_loss_best"],
            "val_accuracy_best": summary_metrics["val_accuracy_best"],
            "best_epoch": summary_metrics["best_epoch"],
        },
        "history": history,
        "diagnostics": {
            "num_features": n_features,
            "n_train": n_train,
            "n_val": n_val,
        },
    }
    write_json(paths.analysis, analysis)

    outputs = [
        {"path": "manifest.json"},
        {"path": "summary.json"},
        {"path": "analysis.json"},
        {"path": "checkpoints/best.json"},
    ]

    manifest = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "created_at": summary["created_at"],
        "run": {
            "command": [sys.executable, *sys.argv],
            "run_dir": str(paths.run_dir),
            "duration_seconds": _round8(duration_s),
        },
        "code": {"git": get_git_metadata(repo_root=ROOT)},
        "environment": collect_environment(include_pip_freeze=True),
        "data": [
            {
                "name": "toy_classification_train",
                "path": "generated://toy_classification_train",
                "url": None,
                "sha256": train_sha256,
                "provenance": {
                    "kind": "generated",
                    "generator": "examples/toy_run.py",
                    "seed": seed,
                    "spec": {
                        "n": n_train,
                        "n_features": n_features,
                        "noise_std": noise_std,
                    },
                },
            },
            {
                "name": "toy_classification_val",
                "path": "generated://toy_classification_val",
                "url": None,
                "sha256": val_sha256,
                "provenance": {
                    "kind": "generated",
                    "generator": "examples/toy_run.py",
                    "seed": seed,
                    "spec": {
                        "n": n_val,
                        "n_features": n_features,
                        "noise_std": noise_std,
                    },
                },
            },
        ],
        "hyperparameters": {
            "seed": seed,
            "epochs": epochs,
            "lr": lr,
            "batch_size": batch_size,
        },
        "inputs": {
            "run_card": {
                "path": str(run_card_path) if run_card_path else None,
                "sha256": run_card_sha256,
            }
        },
        "outputs": outputs,
        "paths_are_relative_to": "run_dir",
    }
    write_json(paths.manifest, manifest)

    print(f"[ok] wrote run artifacts: {paths.run_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
