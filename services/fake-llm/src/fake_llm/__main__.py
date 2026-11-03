"""Run the server: `fake-llm` or `python -m fake_llm`. Reads FAKE_LLM_PORT and
FAKE_LLM_SCRIPTS_DIR. Always one worker: fault counters and the capture are in memory.
"""

import logging
import os

import uvicorn

from fake_llm.app import app_from_env


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    port = int(os.environ.get("FAKE_LLM_PORT", "8080"))
    uvicorn.run(
        app_from_env(),
        host="0.0.0.0",
        port=port,
        workers=1,
        timeout_graceful_shutdown=2,
    )


if __name__ == "__main__":
    main()
