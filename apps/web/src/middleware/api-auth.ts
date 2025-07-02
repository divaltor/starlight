import { verifyAuth, verifyOptionalAuth } from "@/lib/auth";

export interface AuthResult<T = any> {
	auth?: any;
	body?: T;
	error?: string;
	status?: number;
}

export async function withAuth<T = any>(
	request: Request,
	requireAuth = true,
): Promise<AuthResult<T>> {
	try {
		const body = await request.json();

		if (requireAuth) {
			const authResult = await verifyAuth(body.initData);
			if (!authResult.success) {
				return { error: authResult.error, status: 401 };
			}
			return { auth: authResult.auth, body };
		}
		const auth = await verifyOptionalAuth(body.initData);
		return { auth, body };
	} catch (error) {
		return { error: "Invalid request data", status: 400 };
	}
}

export async function withValidatedAuth<T = any>(
	request: Request,
	validator: (data: any) => { success: boolean; data?: T; error?: string },
): Promise<AuthResult<T>> {
	try {
		const body = await request.json();
		const validation = validator(body);

		if (!validation.success) {
			return { error: validation.error || "Invalid request data", status: 400 };
		}

		const authResult = await verifyAuth(validation.data!.initData);
		if (!authResult.success) {
			return { error: authResult.error, status: 401 };
		}

		return { auth: authResult.auth, data: validation.data };
	} catch (error) {
		return { error: "Invalid request data", status: 400 };
	}
}
