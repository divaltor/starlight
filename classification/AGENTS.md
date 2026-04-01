Image classification and embeddings API service using CLIP/pHash models.

## Python Environment

- MUST use `uv` for package management, `ruff` for linting/formatting, and `ty` for type checking

## General Rules

- Use `pathlib` instead of `os` where possible
- Use `pydantic` and `BaseSettings` for environment variable loading
- Use `structlog` for logging instead of `print` statements
- Use % formatting in logger methods (e.g., `logger.info('Processing %s', file_path)`)
