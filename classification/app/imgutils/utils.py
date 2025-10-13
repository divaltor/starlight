import os
import threading
from collections import defaultdict
from functools import lru_cache, wraps
from typing import Literal

from onnxruntime import (
    GraphOptimizationLevel,  # pyright: ignore[reportAttributeAccessIssue]
    InferenceSession,
    SessionOptions,  # pyright: ignore[reportAttributeAccessIssue]
    get_all_providers,  # pyright: ignore[reportAttributeAccessIssue]
    get_available_providers,  # pyright: ignore[reportAttributeAccessIssue]
)

LevelTyping = Literal['global', 'process', 'thread']


def _get_context_key(level: LevelTyping = 'global'):
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


def ts_lru_cache(level: LevelTyping = 'global', **options):
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

    def _decorator(func):
        """
        Inner decorator function that wraps the original function.

        :param func: The function to be decorated.
        :type func: function

        :return: The wrapped function with thread-safe caching.
        :rtype: function
        """

        @lru_cache(**options)
        @wraps(func)
        def _cached_func(*args, __context_key=None, **kwargs):
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
        def _new_func(*args, **kwargs):
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
                _context_lock = lock_pool[context_key]
            with _context_lock:
                return _cached_func(*args, __context_key=context_key, **kwargs)

        # Preserve cache_info and cache_clear methods if they exist
        if hasattr(_cached_func, 'cache_info'):
            _new_func.cache_info = _cached_func.cache_info
        if hasattr(_cached_func, 'cache_clear'):
            _new_func.cache_clear = _cached_func.cache_clear

        return _new_func

    return _decorator


alias = {
    'gpu': 'CUDAExecutionProvider',
    'trt': 'TensorrtExecutionProvider',
}


def get_onnx_provider(provider: str | None = None):
    """
    Overview:
        Get onnx provider.

    :param provider: The provider for ONNX runtime. ``None`` by default and will automatically detect
        if the ``CUDAExecutionProvider`` is available. If it is available, it will be used,
        otherwise the default ``CPUExecutionProvider`` will be used.
    :return: String of the provider.
    """
    if not provider:
        if 'CUDAExecutionProvider' in get_available_providers():
            return 'CUDAExecutionProvider'
        return 'CPUExecutionProvider'
    if provider.lower() in alias:
        return alias[provider.lower()]
    for p in get_all_providers():
        if provider.lower() == p.lower() or f'{provider}ExecutionProvider'.lower() == p.lower():
            return p

    raise ValueError(
        f'One of the {get_all_providers()!r} expected, but unsupported provider {provider!r} found.',
    )


def _open_onnx_model(ckpt: str, provider: str, use_cpu: bool = True) -> InferenceSession:
    options = SessionOptions()
    options.graph_optimization_level = GraphOptimizationLevel.ORT_ENABLE_ALL
    if provider == 'CPUExecutionProvider':
        options.intra_op_num_threads = os.cpu_count()

    providers = [provider]
    if use_cpu and 'CPUExecutionProvider' not in providers:
        providers.append('CPUExecutionProvider')

    return InferenceSession(ckpt, options, providers=providers)


def open_onnx_model(ckpt: str, mode: str | None = None) -> InferenceSession:
    """
    Overview:
        Open an ONNX model and load its ONNX runtime.

    :param ckpt: ONNX model file.
    :param mode: Provider of the ONNX. Default is ``None`` which means the provider will be auto-detected,
        see :func:`get_onnx_provider` for more details.
    :return: A loaded ONNX runtime object.

    .. note::
        When ``mode`` is set to ``None``, it will attempt to detect the environment variable ``ONNX_MODE``.
        This means you can decide which ONNX runtime to use by setting the environment variable. For example,
        on Linux, executing ``export ONNX_MODE=cpu`` will ignore any existing CUDA and force the model inference
        to run on CPU.
    """
    return _open_onnx_model(ckpt, get_onnx_provider(mode or os.environ.get('ONNX_MODE', None)))
