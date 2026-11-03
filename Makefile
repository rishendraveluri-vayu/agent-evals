# Shortcuts for the harness workflow (contract v2 section 4). None of these call a real model.
.PHONY: new-harness probe-harness test-harness dev-trials

## make new-harness NAME=langgraph   create workers/<name>/ from the scaffold
new-harness:
	@test -n "$(NAME)" || (echo "usage: make new-harness NAME=<name>" && exit 2)
	cd workers/adapterlib && uv run evals-new-harness $(NAME)

## make probe-harness NAME=ownloop   rewrite its capabilities.json from probe evidence
probe-harness:
	@test -n "$(NAME)" || (echo "usage: make probe-harness NAME=<name>" && exit 2)
	cd workers/$(NAME) && ./probe.sh

## make test-harness NAME=ownloop    gate tests and the capabilities drift test
test-harness:
	@test -n "$(NAME)" || (echo "usage: make test-harness NAME=<name>" && exit 2)
	cd workers/$(NAME) && uv run pytest -q

## make dev-trials                   record gate scenarios through LiteLLM into runs/
dev-trials:
	scripts/dev_trials.sh
