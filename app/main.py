import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import SimpleEventIsolation
from aiogram.fsm.storage.redis import RedisStorage

from app.handlers import setup_handlers
from app.services.twitter import TwitterAPI
from app.settings import settings

logger = logging.getLogger(__name__)

storage = RedisStorage.from_url(settings.REDIS_URI.encoded_string())
dp = Dispatcher(storage=storage, events_isolation=SimpleEventIsolation())

if settings.X_COOKIES is not None:
    dp['twitter'] = TwitterAPI(cookies=settings.X_COOKIES)
else:
    dp['twitter'] = None


async def main() -> None:
    bot = Bot(token=settings.TOKEN)

    setup_handlers(dp)

    await dp.start_polling(bot)


if __name__ == '__main__':
    if settings.is_production:
        logging.basicConfig(level=logging.INFO)
    else:
        logging.basicConfig(level=logging.DEBUG)

    asyncio.run(main())
