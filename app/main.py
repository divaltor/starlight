import logging
import glob
import os

import pathlib
import uuid
import tempfile
import asyncio
from aiogram import exceptions
from aiogram import Bot, Dispatcher
from aiogram.types import BufferedInputFile, Message

from app.settings import Settings

logger = logging.getLogger(__name__)

settings = Settings()  # type: ignore
dp = Dispatcher()


@dp.message()
async def handle_link_handler(message: Message):
    if message.text is None:
        await message.reply("Please send me a link")
        return

    logger.info("Trying to download %s", message.text)

    with tempfile.TemporaryDirectory() as tmpdir:
        filepath = pathlib.Path(tmpdir, str(uuid.uuid4()))

        logger.debug("Saving as %s", filepath)

        process_args = [
            "yt-dlp",
            "-q",
            message.text,
            "-o",
            str(filepath),
        ]

        process = await asyncio.create_subprocess_exec(
            "yt-dlp",
            "-q",
            message.text,
            "-o",
            str(filepath),
            stdout=asyncio.subprocess.PIPE,
        )

        logger.debug("Process created with args %s", process_args)

        status_code = await process.wait()

        logger.debug("Process finished with status code %s", status_code)

        if status_code != 0:
            await message.reply("Something went wrong")
            return

        # Youtube videos are saved with extension file even if args are passed without extension
        if not os.path.exists(filepath):
            files = glob.glob(filepath.as_posix() + ".*")

            logger.debug("Found files %s", files)

            if not files:
                await message.reply("File was not downloaded")
                return

            filepath = files[0]

        logger.debug("File size is %sMB", os.path.getsize(filepath))

        try:
            await message.reply_video(video=BufferedInputFile.from_file(filepath))
        except exceptions.TelegramEntityTooLarge:
            logger.exception("File is too large")
            await message.reply("File is too large")
            return
        except exceptions.TelegramAPIError:
            logger.exception("Telegram API error")
            await message.reply("Something went wrong")
            return

        logger.info("File %s was sent", filepath)


async def main() -> None:
    bot = Bot(token=settings.TOKEN)

    await dp.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    asyncio.run(main())
