import asyncio
import logging
import random
import tempfile

from aiogram import Bot, Dispatcher, exceptions
from aiogram.types import (
    FSInputFile,
    Message,
)
from aiogram.utils import chat_action

from app.settings import Settings
from app.video import download_video

logger = logging.getLogger(__name__)

settings = Settings()  # pyright: ignore[reportCallIssue]
dp = Dispatcher()


@dp.message()
async def handle_link_handler(message: Message) -> None:
    if message.text is None:
        await message.reply('Please, provide a valid link to X post.')
        return

    async with chat_action.ChatActionSender.upload_video(
        chat_id=message.chat.id,
        bot=message.bot,  # pyright: ignore[reportArgumentType]
    ):
        logger.info('Trying to download %s', message.text)

        with tempfile.TemporaryDirectory() as tmpdir:
            logger.debug('Using temporary directory %s', tmpdir)

            try:
                videos = download_video(message.text, tmpdir)
            except Exception:
                logger.exception('Error downloading video')
                await message.reply(
                    'Error downloading video, probably X is blocking the request.',
                )
                return

            for video in videos:
                try:
                    await message.reply_video(
                        video=FSInputFile(video.file_path),
                        filename=video.file_path.name,
                        height=video.metadata.height,
                        width=video.metadata.width,
                    )
                    await asyncio.sleep(random.randint(1, 2))
                except exceptions.TelegramAPIError:
                    logger.exception('Telegram API error')
                    await message.reply(
                        'Error happened while uploading video, probably it is too large.',
                    )
                    return
                except FileNotFoundError:
                    logger.exception('File not found')
                    await message.reply('File not found, probably could not be downloaded.')
                    return


async def main() -> None:
    bot = Bot(token=settings.TOKEN)

    await dp.start_polling(bot)


if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    asyncio.run(main())
