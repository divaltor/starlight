import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import Message

from app.handlers.filter.settings import AdminTwitterFilter
from app.services.twitter import TwitterAPI

logger = logging.getLogger(__name__)
admin_router = Router(name=__name__)

admin_router.message.filter(AdminTwitterFilter())


@admin_router.message(Command('img'), F.text.startswith('https://x.com'))
async def handle_link_handler(message: Message, twitter: TwitterAPI | None) -> None:
    assert twitter is not None
    assert message.text is not None
