"use server";

export interface Tweet {
	id: string;
	text: string;
	author: string;
	images: string[];
	createdAt: Date;
}

export interface QueuedPublication {
	id: string;
	tweetId: string;
	selectedImages: string[];
	scheduledFor: Date;
	createdAt: Date;
	authors: string[];
	status: "waiting" | "published" | "done";
}

// Mock data for demo purposes
const tweets: Tweet[] = [
	{
		id: "1",
		text: "Beautiful sunset at the beach today!",
		author: "photographer_jane",
		images: [
			"/placeholder.svg?id=1",
			"/placeholder.svg?id=2",
			"/placeholder.svg?id=3",
			"/placeholder.svg?id=4",
		],
		createdAt: new Date("2024-01-15T18:30:00Z"),
	},
	{
		id: "2",
		text: "Amazing street art in the city center",
		author: "urban_explorer",
		images: ["/placeholder.svg?id=5", "/placeholder.svg?id=6"],
		createdAt: new Date("2024-01-14T14:20:00Z"),
	},
	{
		id: "3",
		text: "New artwork in my studio",
		author: "artist_mike",
		images: [
			"/placeholder.svg?id=7",
			"/placeholder.svg?id=8",
			"/placeholder.svg?id=9",
		],
		createdAt: new Date("2024-01-13T12:15:00Z"),
	},
];

// In-memory storage for demo purposes
let publicationQueue: QueuedPublication[] = [];

export async function generateRandomPublication() {
	// Select a random tweet
	const randomTweet = tweets[Math.floor(Math.random() * tweets.length)];

	// Randomly select 1-3 images from the tweet
	const numImages = Math.min(
		Math.floor(Math.random() * 3) + 1,
		randomTweet.images.length,
	);

	const shuffledImages = [...randomTweet.images].sort(
		() => Math.random() - 0.5,
	);
	const selectedImages = shuffledImages.slice(0, numImages);

	// Create queued publication
	const queuedPublication: QueuedPublication = {
		id: Date.now().toString(),
		tweetId: randomTweet.id,
		selectedImages,
		scheduledFor: new Date(Date.now() + Math.random() * 24 * 60 * 60 * 1000),
		createdAt: new Date(),
		authors: [randomTweet.author], // Convert single author to array
		status: "waiting",
	};

	publicationQueue.push(queuedPublication);
	return publicationQueue;
}

export async function deletePublication(publicationId: string) {
	publicationQueue = publicationQueue.filter((pub) => pub.id !== publicationId);
	return publicationQueue;
}

export async function deleteImageFromPublication(
	publicationId: string,
	imageIndex: number,
) {
	const publicationIndex = publicationQueue.findIndex(
		(pub) => pub.id === publicationId,
	);
	if (publicationIndex === -1) return publicationQueue;

	const publication = publicationQueue[publicationIndex];

	// Don't allow deleting if only one image remains
	if (publication.selectedImages.length <= 1) {
		return publicationQueue;
	}

	const updatedImages = publication.selectedImages.filter(
		(_, index) => index !== imageIndex,
	);

	publicationQueue[publicationIndex] = {
		...publication,
		selectedImages: updatedImages,
	};

	return publicationQueue;
}

export async function reshuffleImageInPublication(
	publicationId: string,
	imageIndex: number,
) {
	const publicationIndex = publicationQueue.findIndex(
		(pub) => pub.id === publicationId,
	);
	if (publicationIndex === -1) return publicationQueue;

	const publication = publicationQueue[publicationIndex];
	const originalTweet = tweets.find(
		(tweet) => tweet.id === publication.tweetId,
	);

	if (!originalTweet) return publicationQueue;

	// Get available images that aren't currently selected
	const availableImages = originalTweet.images.filter(
		(img) => !publication.selectedImages.includes(img),
	);

	if (availableImages.length === 0) return publicationQueue;

	// Replace the image at the specified index with a random available image
	const randomImage =
		availableImages[Math.floor(Math.random() * availableImages.length)];
	const updatedImages = [...publication.selectedImages];
	updatedImages[imageIndex] = randomImage;

	publicationQueue[publicationIndex] = {
		...publication,
		selectedImages: updatedImages,
	};

	return publicationQueue;
}

export async function addImageToPublication(publicationId: string) {
	const publicationIndex = publicationQueue.findIndex(
		(pub) => pub.id === publicationId,
	);
	if (publicationIndex === -1) return publicationQueue;

	const publication = publicationQueue[publicationIndex];
	const originalTweet = tweets.find(
		(tweet) => tweet.id === publication.tweetId,
	);

	if (!originalTweet) return publicationQueue;

	// Don't allow more than 4 images
	if (publication.selectedImages.length >= 4) return publicationQueue;

	// Get available images that aren't currently selected
	const availableImages = originalTweet.images.filter(
		(img) => !publication.selectedImages.includes(img),
	);

	if (availableImages.length === 0) return publicationQueue;

	// Add a random available image
	const randomImage =
		availableImages[Math.floor(Math.random() * availableImages.length)];
	const updatedImages = [...publication.selectedImages, randomImage];

	publicationQueue[publicationIndex] = {
		...publication,
		selectedImages: updatedImages,
	};

	return publicationQueue;
}

export async function reshufflePublication(publicationId: string) {
	const publicationIndex = publicationQueue.findIndex(
		(pub) => pub.id === publicationId,
	);
	if (publicationIndex === -1) return publicationQueue;

	const publication = publicationQueue[publicationIndex];
	const originalTweet = tweets.find(
		(tweet) => tweet.id === publication.tweetId,
	);

	if (!originalTweet) return publicationQueue;

	// Reshuffle images
	const numImages = Math.min(
		Math.floor(Math.random() * 3) + 1,
		originalTweet.images.length,
	);

	const shuffledImages = [...originalTweet.images].sort(
		() => Math.random() - 0.5,
	);
	const selectedImages = shuffledImages.slice(0, numImages);

	publicationQueue[publicationIndex] = {
		...publication,
		selectedImages,
		scheduledFor: new Date(Date.now() + Math.random() * 24 * 60 * 60 * 1000),
	};

	return publicationQueue;
}

export async function getPublicationQueue() {
	return publicationQueue;
}
