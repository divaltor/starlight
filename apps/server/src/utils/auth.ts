import type { Context } from "@/bot";

export const isAdminOrCreator = (ctx: Context) => {
	if (ctx.isSupervisor) {
		return true;
	}

	const status = ctx.userChatMember?.status;
	return status === "administrator" || status === "creator";
};
