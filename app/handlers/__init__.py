from aiogram import Dispatcher

from app.handlers import image, video


def setup_handlers(dp: Dispatcher) -> None:
    dp.include_router(video.router)
    dp.include_router(image.router)
