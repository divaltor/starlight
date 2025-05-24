import base64
import json
from typing import Any, cast


def decode_cookies(value: str | None) -> dict[str, str] | None:
    if value is None:
        return None

    try:
        decoded = json.loads(base64.b64decode(value).decode())
    except Exception:  # noqa: BLE001
        decoded = json.loads(value)

    # Exported via extension `Cookie Quick Manager`
    if any(value.get('Host raw') for value in decoded):
        return {value['Name raw']: value['Content raw'] for value in decoded}

    # Just default cookies
    return cast('dict[str, str]', decoded)


def find_key_recursive(
    data: Any,
    target_key: str,
    target_prefix: str | None = None,
) -> Any:
    stack = [data]

    while stack:
        current = stack.pop()

        if isinstance(current, dict):
            if target_key in current:
                value = current[target_key]
                if target_prefix is None:
                    return value  # type: ignore

                if isinstance(value, str) and value.startswith(target_prefix):
                    return current

            stack.extend(list(current.values()))  # type: ignore

        elif isinstance(current, list):
            stack.extend(current)  # type: ignore

    return None
