"""Fake OpenAI-compatible chat-completions server for tests and CI."""

from fake_llm.app import create_app

__all__ = ["create_app"]
