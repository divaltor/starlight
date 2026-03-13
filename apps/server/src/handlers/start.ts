import { Composer } from "grammy";
import type { Context } from "@/types";

const composer = new Composer<Context>();

composer.command("start", async (ctx) => {
	const username = ctx.me.username;

	await ctx.reply(
		`Привет, я <b>Старка</b> ✨

Могу общаться с тобой в групповых чатах - просто добавь меня в чат и я буду иногда реагировать на сообщения

Так же могу скачивать посты с Twitter'а (X), просто отправь мне ссылку на пост. Можно использовать /q (url) или @${username} (url) для этого

Еще могу сохранять твои залайканные аниме картинки с Twitter'а, для этого скорми мне печеньки (cookies) в приложении. Все зашифровано и никто ничего не сможет прочитать, на свой страх и риск!
После этого можно будет смотреть свой каталог, искать картинки и делиться с друзьями`,
		{ parse_mode: "HTML" },
	);
});

export default composer;
