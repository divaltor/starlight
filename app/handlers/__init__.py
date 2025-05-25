from aiogram import Dispatcher

from app.handlers import video


def setup_handlers(dp: Dispatcher) -> None:
    dp.include_router(video.router)
