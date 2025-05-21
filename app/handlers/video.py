import asyncio
import logging
import random
import tempfile

from aiogram import Bot, F, Router, exceptions
from aiogram.types import FSInputFile, Message
from aiogram.utils import chat_action

from app.services.video import download_video
from app.settings import settings

logger = logging.getLogger(__name__)

router = Router(name=__name__)


@router.message(F.text.startswith('https://x.com'))
async def handle_link_handler(message: Message, bot: Bot) -> None:
    assert message.text is not None

    bot_instance = await bot.me()

    if bot_instance.username == settings.OLD_USERNAME:
        await message.reply(
            'Please, use @StarlightManagerBot instead. This bot is deprecated, thanks.'
        )

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

            # TODO: Change to media group
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


@router.message()
async def handle_message(message: Message) -> None:
    await message.reply('Please, provide a valid link to X post.')
