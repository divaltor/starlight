import re
from aiogram.filters import Filter
from aiogram.types import Message


TWITTER_REGEX = re.compile(r"^https://(?:twitter.com|x.com)/.*/status/.*")


class TwitterLinkFilter(Filter):
    async def __call__(self, message: Message) -> bool:
        if msg_text := message.text:
            return bool(TWITTER_REGEX.match(msg_text))

        return False
