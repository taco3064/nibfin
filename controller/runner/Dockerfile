# Supply the approved base image by digest and an exact Codex CLI version.
# Build/deploy is an operator action, never selected by an Issue or Agent.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG CODEX_VERSION
USER root
RUN test -n "$CODEX_VERSION" && npm install -g "@openai/codex@$CODEX_VERSION"
USER 1000:1000
WORKDIR /work
# The runtime supplies an explicit command, read-only root and approved network.
CMD ["codex", "--version"]
