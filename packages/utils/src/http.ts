import ky from "ky";

export const http = ky.create({
	throwHttpErrors: false,
	retry: 0,
});
