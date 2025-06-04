import sharp, { type SharpOptions } from "sharp";

const SAMPLE_SIZE = 32;
const LOW_SIZE = 8;

function initSQRT(N: number): number[] {
	const c = new Array(N);
	for (let i = 1; i < N; i++) {
		c[i] = 1;
	}
	c[0] = 1 / Math.sqrt(2.0);
	return c;
}

const SQRT = initSQRT(SAMPLE_SIZE);

function initCOS(N: number): number[][] {
	const cosines = new Array(N);
	for (let k = 0; k < N; k++) {
		cosines[k] = new Array(N);
		for (let n = 0; n < N; n++) {
			cosines[k][n] = Math.cos(((2 * k + 1) / (2.0 * N)) * n * Math.PI);
		}
	}
	return cosines;
}

const COS = initCOS(SAMPLE_SIZE);

function applyDCT(f: number[][], size: number): number[][] {
	const N = size;
	const F = new Array(N);

	for (let u = 0; u < N; u++) {
		F[u] = new Array(N);
		for (let v = 0; v < N; v++) {
			let sum = 0;
			for (let i = 0; i < N; i++) {
				for (let j = 0; j < N; j++) {
					sum += COS[i][u] * COS[j][v] * f[i][j];
				}
			}
			sum *= (SQRT[u] * SQRT[v]) / 4;
			F[u][v] = sum;
		}
	}
	return F;
}


export function hashToInt(hash: string): number {
	return Number.parseInt(hash, 2);
}

export async function calculatePerceptualHash(
	image: Parameters<typeof sharp>[0],
	options?: SharpOptions,
): Promise<string> {
	const data = await sharp(image, options)
		.greyscale()
		.resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "fill" })
		.rotate()
		.raw()
		.toBuffer();

	const s = new Array(SAMPLE_SIZE);
	for (let x = 0; x < SAMPLE_SIZE; x++) {
		s[x] = new Array(SAMPLE_SIZE);
		for (let y = 0; y < SAMPLE_SIZE; y++) {
			s[x][y] = data[SAMPLE_SIZE * y + x];
		}
	}

	const dct = applyDCT(s, SAMPLE_SIZE);

	let totalSum = 0;
	for (let x = 0; x < LOW_SIZE; x++) {
		for (let y = 0; y < LOW_SIZE; y++) {
			totalSum += dct[x + 1][y + 1];
		}
	}

	const avg = totalSum / (LOW_SIZE * LOW_SIZE);

	let fingerprint = "";
	for (let x = 0; x < LOW_SIZE; x++) {
		for (let y = 0; y < LOW_SIZE; y++) {
			fingerprint += dct[x + 1][y + 1] > avg ? "1" : "0";
		}
	}

	return fingerprint;
}

export function calculateHashDistance(hashA: string, hashB: string): number {
	let count = 0;
	for (let i = 0; i < hashA.length; i++) {
		if (hashA[i] !== hashB[i]) {
			count++;
		}
	}
	return count;
}
