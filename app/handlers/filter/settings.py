from aiogram.filters import BaseFilter
from aiogram.types import Message

from app.settings import settings


class AdminTwitterFilter(BaseFilter):
    async def __call__(self, message: Message) -> bool:
        if message.from_user is None:
            return False

        if settings.ALLOWED_USER is None:
            return False

        return message.from_user.id == settings.ALLOWED_USER
