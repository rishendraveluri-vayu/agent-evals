"""Shared adapter library for agent-evals harness workers (contract v2, docs/adapter-contract.md).

A harness adapter subclasses `Adapter`, implements `setup` and `run_turn`, and calls `main`.
"""

from evals_adapter.adapter import Adapter, TrialContext, TurnResult, main, run
from evals_adapter.spec import CONTRACT_VERSION, SETTING_NAMES, SpecError, TrialPaths

__all__ = [
    "CONTRACT_VERSION",
    "SETTING_NAMES",
    "Adapter",
    "SpecError",
    "TrialContext",
    "TrialPaths",
    "TurnResult",
    "main",
    "run",
]
