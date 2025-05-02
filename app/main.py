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


ERROR_DOWNLOAD_MESSAGES: list[str] = [
    "💔 Oh no! The download couldn't complete this time! 🔄",
    '🚫 Oops! Something went wrong while fetching your video! 📱',
    "😱 Alert! The download didn't go as planned! 🎬",
    "🌩️ Technical issue! Couldn't download your video! ⚡",
    "🙈 Sorry! The video download didn't complete correctly! 🎥",
]

GENERAL_ERROR_MESSAGES: list[str] = [
    "💔 We've hit a small snag! 💫",
    '✨ Everyone has off days! Something went wrong! 🔧',
    "🌟 We encountered an error, but we'll get through this! 💪",
    '🎭 The show must go on, but after we fix this little hiccup! 🎪',
    "⏱️ This error is temporary! We'll try again! ✨",
]

FILE_NOT_FOUND_MESSAGES: list[str] = [
    '🕵️‍♀️ The file has mysteriously vanished! 👻',
    '🔍 Searching high and low, but this file is nowhere to be found! 📂',
    '📁 File not found! It seems to have disappeared! 💨',
    '🧐 The file is being quite elusive! 🔎',
    '🌪️ Oops! Your file has gone missing! 📱',
]

NO_LINK_MESSAGES: list[str] = [
    '💌 I need a link to work with! ✨',
    '🔮 Please provide a link to get started! 🔄',
    "🔗 Drop me a link and I'll download your video! 📲",
    '🎀 No link? No video! Send me something to download! 🎬',
    '✨ Link, please! Ready to download at your command! 🎥',
]


def get_random_message(message_list: list[str]) -> str:
    return random.choice(message_list)


@dp.message()
async def handle_link_handler(message: Message) -> None:
    if message.text is None:
        await message.reply(get_random_message(NO_LINK_MESSAGES))
        return

    async with chat_action.ChatActionSender.upload_video(
        chat_id=message.chat.id,
        bot=message.bot,  # pyright: ignore[reportArgumentType]
    ):
        logger.info('Trying to download %s', message.text)

        with tempfile.TemporaryDirectory() as tmpdir:
            logger.debug('Using temporary directory %s', tmpdir)

            try:
                video_information = download_video(message.text, tmpdir)
            except Exception:
                logger.exception('Error downloading video')
                await message.reply(get_random_message(ERROR_DOWNLOAD_MESSAGES))
                return

            logger.debug(video_information)

            try:
                await message.reply_video(
                    video=FSInputFile(video_information.file_path),
                    filename=video_information.file_path.name,
                    height=video_information.metadata.height,
                    width=video_information.metadata.width,
                )
            except exceptions.TelegramAPIError:
                logger.exception('Telegram API error')
                await message.reply(get_random_message(GENERAL_ERROR_MESSAGES))
                return
            except FileNotFoundError:
                logger.exception('File not found')
                await message.reply(get_random_message(FILE_NOT_FOUND_MESSAGES))
                return


async def main() -> None:
    bot = Bot(token=settings.TOKEN)

    await dp.start_polling(bot)


if __name__ == '__main__':
    logging.basicConfig(level=logging.DEBUG)
    asyncio.run(main())
