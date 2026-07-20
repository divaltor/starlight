from __future__ import annotations

import os
import threading
from collections import defaultdict
from functools import lru_cache, wraps
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from collections.abc import Callable

LevelTyping = Literal['global', 'process', 'thread']


def _get_context_key(level: LevelTyping = 'global') -> int | tuple[int, int] | None:
    """
    Get a context key based on the specified caching level.

    :param level: The caching level to use. Can be 'global', 'process', or 'thread'.
    :type level: LevelTyping

    :return: A context key appropriate for the specified level.
    :rtype: tuple or None

    :raises ValueError: If an invalid cache level is specified.

    .. note::
        The function returns:

        - None for 'global' level
        - Process ID for 'process' level
        - (Process ID, Thread ID) tuple for 'thread' level
    """
    if level == 'global':
        return None
    if level == 'process':
        return os.getpid()
    if level == 'thread':
        return os.getpid(), threading.get_ident()
    raise ValueError(
        f"Invalid cache level, 'global', 'process' or 'thread' expected but {level!r} found.",
    )


def ts_lru_cache(
    level: LevelTyping = 'global',
    **options: Any,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    A thread-safe version of the lru_cache decorator.

    This decorator wraps the standard lru_cache with a threading lock to ensure
    thread-safety in multithreaded environments. It maintains the same interface
    as the built-in lru_cache, allowing you to specify options like maxsize.

    :param level: The caching level ('global', 'process', or 'thread').
    :type level: LevelTyping
    :param options: Keyword arguments to be passed to the underlying lru_cache.
    :type options: dict

    :return: A thread-safe cached version of the decorated function.
    :rtype: function

    :example:
        >>> @ts_lru_cache(level='thread', maxsize=100)
        >>> def my_function(x, y):
        ...     # Function implementation
        ...     return x + y

    .. note::
        The decorator provides three levels of caching:

        - global: Single cache shared across all processes and threads
        - process: Separate cache for each process
        - thread: Separate cache for each thread

    .. note::
        While this decorator ensures thread-safety, it may introduce some overhead
        due to lock acquisition. Use it when thread-safety is more critical than
        maximum performance in multithreaded scenarios.

    .. note::
        The decorator preserves the cache_info() and cache_clear() methods
        from the original lru_cache implementation.
    """
    _ = _get_context_key(level)

    def _decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        """
        Inner decorator function that wraps the original function.

        :param func: The function to be decorated.
        :type func: function

        :return: The wrapped function with thread-safe caching.
        :rtype: function
        """

        @lru_cache(**options)
        @wraps(func)
        def _cached_func(
            *args: Any,
            __context_key: int | tuple[int, int] | None = None,
            **kwargs: Any,
        ) -> Any:
            """
            Cached version of the original function.

            :param args: Positional arguments to be passed to the original function.
            :param __context_key: Internal context key for cache separation.
            :param kwargs: Keyword arguments to be passed to the original function.

            :return: The result of the original function call.
            """
            return func(*args, **kwargs)

        lock_pool = defaultdict(threading.Lock)
        lock = threading.Lock()

        @wraps(_cached_func)
        def _new_func(*args: Any, **kwargs: Any) -> Any:
            """
            Thread-safe wrapper around the cached function.

            This function acquires a lock before calling the cached function,
            ensuring thread-safety.

            :param args: Positional arguments to be passed to the cached function.
            :param kwargs: Keyword arguments to be passed to the cached function.

            :return: The result of the cached function call.
            """
            context_key = _get_context_key(level=level)
            with lock:
                context_lock = lock_pool[context_key]
            with context_lock:
                return _cached_func(*args, __context_key=context_key, **kwargs)

        # Preserve cache_info and cache_clear methods if they exist
        if hasattr(_cached_func, 'cache_info'):
            _new_func.cache_info = _cached_func.cache_info
        if hasattr(_cached_func, 'cache_clear'):
            _new_func.cache_clear = _cached_func.cache_clear

        return _new_func

    return _decorator
